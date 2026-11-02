import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectsBackend } from '../src/main/projects.js';

let dir, backend;
const task = (id, status = 'pending', optional = false) => ({ id, name: id, description: '', status, optional, inputs: [], outputs: [], dependsOn: [], dependencyNote: '', sourceIds: [], records: [] });
const make = () => new ProjectsBackend({ home: dir, userData: path.join(dir, 'data'), env: {} });
const create = async () => (await backend.create({ name: '项目', goal: '构建客户管理系统', workingDirectory: '/work' })).at(-1);
const patch = (project, changes) => backend.patch({ id: project.id, expectedRevision: project.revision, changes });
beforeEach(async () => { dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'projects-links-')); backend = make(); });
afterEach(async () => { vi.restoreAllMocks(); await fs.promises.rm(dir, { recursive: true, force: true }); });

describe('项目版本和安全更新', () => {
  it('新建 revision 1，串行竞争仅一次成功；旧 snapshot 拒绝，省略版本 legacy 按最新版本递增', async () => {
    const project = await create(); expect(project.revision).toBe(1);
    const results = await Promise.allSettled([patch(project, { name: 'A' }), patch(project, { name: 'B' })]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1].reason.message).toMatch(/revision/);
    await expect(backend.update(project)).rejects.toThrow(/revision/);
    const legacy = { ...(await backend.list())[0], name: 'legacy' }; delete legacy.revision;
    const saved = await backend.update(legacy);
    expect(saved[0].revision).toBe(3); expect((await make().list())).toEqual(saved);
    await expect(backend.patch({ id: project.id, changes: {} })).rejects.toThrow(/Revision/);
  });
  it.each(['id', 'identityKey', 'createdAt', 'sources', 'files', 'audit', 'fieldEvidence', 'recognitionNotes', 'acceptance', 'revision', 'deletedAt', 'archivedAt', 'mergedInto', 'uncertainties', 'fieldProvenance'])(
    'PATCH 拒绝保护字段 %s', async field => {
      const project = await create(); await expect(patch(project, { [field]: project[field] })).rejects.toThrow(/不支持字段/);
      expect(await backend.list()).toEqual([project]);
    });
  it('legacy 更新保留服务端生命周期、审计和链接；任务证据不能由 PATCH 制造', async () => {
    let project = await create();
    project = (await backend.linkConversation(project.id, { conversationId: 'c', cwd: '/work', title: '对话' }))[0];
    const saved = await backend.update({ ...project, archivedAt: 12, deletedAt: 13, mergedInto: 'fake', recognitionNotes: ['伪造'], conversations: [] });
    expect(saved[0].archivedAt).toBeUndefined(); expect(saved[0].deletedAt).toBeUndefined(); expect(saved[0].mergedInto).toBeUndefined();
    expect(saved[0].recognitionNotes).toEqual([]); expect(saved[0].conversations).toEqual(project.conversations);
    await expect(patch(saved[0], { tasks: [{ ...task('new'), records: ['claimed work'] }] })).rejects.toThrow(/records/);
  });
  it('legacy 同 ID 证据保留、新克隆清空；PATCH 仍拒绝更改已有 records/sourceIds', async () => {
    let project = await create();
    const source = { id: 'source', kind: 'gui', sessionId: 'session', title: '', cwd: '/work', excerpt: '真实历史' };
    const old = { ...task('old'), records: ['服务端历史'], sourceIds: [source.id] };
    // Seed an historical disk fixture, not evidence through the client update API.
    await fs.promises.writeFile(backend.filePath, JSON.stringify({ version: 1, projects: [{ ...project, sources: [source], tasks: [old] }] }));
    project = (await backend.reload())[0];
    for (const field of ['records', 'sourceIds']) {
      await expect(patch(project, { tasks: [{ ...old, [field]: [] }] })).rejects.toThrow(new RegExp(field));
    }
    await expect(backend.update({ ...project, tasks: [{ ...old, sourceIds: ['missing'] }] })).rejects.toThrow(/sourceIds/);
    const forged = { ...old, records: ['伪造'], sourceIds: [] };
    project = (await backend.update({ ...project, tasks: [forged, { ...old, id: 'clone' }] }))[0];
    expect(project.tasks[0]).toMatchObject({ records: old.records, sourceIds: old.sourceIds });
    expect(project.tasks[1]).toMatchObject({ records: [], sourceIds: [] });
    expect(project.sources).toEqual([source]);
    const renamed = (await backend.update({ ...project, tasks: [{ ...project.tasks[0], id: 'renamed' }] }))[0];
    expect(renamed.tasks).toHaveLength(1); expect(renamed.tasks[0]).toMatchObject({ id: 'renamed', records: [], sourceIds: [] });
    expect(await make().list()).toEqual([renamed]);
  });
  it('归档/删除重复操作不写盘或改变服务端验收，未知字段和非法验收仍拒绝', async () => {
    let project = await create();
    project = (await patch(project, { tasks: [task('t', 'completed')], goalConfirmed: true }))[0];
    for (const method of ['archive', 'remove']) {
      const saved = await backend[method](project.id, true);
      const rename = vi.spyOn(fs.promises, 'rename');
      expect(await backend[method](project.id, true)).toEqual(saved); expect(rename).not.toHaveBeenCalled(); rename.mockRestore();
      project = (await backend[method](project.id, false))[0];
      expect(project.goalConfirmed).toBe(true); expect(project.acceptance.requiredTaskIds).toEqual(['t']);
    }
    await expect(backend.update({ ...project, unsupported: true })).rejects.toThrow(/不支持/);
    await expect(backend.update({ ...project, goalConfirmed: 'yes' })).rejects.toThrow(/布尔/);
    const unconfirmed = (await patch(project, { goalConfirmed: false }))[0];
    await expect(backend.update({ ...unconfirmed, tasks: [], goalConfirmed: true })).rejects.toThrow(/goalConfirmed/);
  });
  it('取消/删除必要任务、回退完成与手动撤销均清除验收，optional 删除不撤销', async () => {
    let project = await create();
    project = (await patch(project, { tasks: [task('required', 'completed'), task('optional', 'pending', true)], goalConfirmed: true }))[0];
    expect(project.acceptance).toMatchObject({ goal: project.goal, requiredTaskIds: ['required'], confirmedAt: expect.any(Number) });
    project = (await patch(project, { tasks: project.tasks.filter(value => !value.optional) }))[0];
    expect(project.goalConfirmed).toBe(true);
    const cancelled = (await patch(project, { tasks: project.tasks.map(value => ({ ...value, status: 'cancelled' })) }))[0];
    expect(cancelled.goalConfirmed).toBe(false); expect(cancelled.acceptance).toBeUndefined(); expect(cancelled.acceptanceInvalidatedReason).toMatch(/必要任务/);
    project = (await patch(cancelled, { tasks: [task('required', 'completed')], goalConfirmed: true }))[0];
    project = (await patch(project, { goalConfirmed: false }))[0];
    expect(project.acceptance).toBeUndefined(); expect(project.acceptanceInvalidatedReason).toMatch(/手动/);
  });
  it('归档/删除项目只读，合并必须双活跃；恢复来源不会撤销目标合并', async () => {
    const source = await create(), target = await create();
    await backend.archive(target.id, true);
    await expect(backend.merge(source.id, target.id)).rejects.toThrow(/归档/);
    let latest = (await backend.list()).find(project => project.id === target.id);
    await expect(patch(latest, { name: 'bad' })).rejects.toThrow(/只读/);
    await backend.archive(target.id, false);
    await backend.merge(source.id, target.id);
    const mergedTarget = (await backend.list()).find(project => project.id === target.id);
    await backend.remove(source.id, false);
    expect((await backend.list()).find(project => project.id === target.id)).toEqual(mergedTarget);
    expect((await backend.list()).find(project => project.id === source.id).mergedInto).toBeUndefined();
  });
});

describe('会话只关联和真实运行记录', () => {
  it('全库唯一、有效任务、链接幂等并保留 run，任务删除后历史 taskId 仍可读取', async () => {
    let project = await create(); const other = await create();
    project = (await patch(project, { tasks: [task('t')] })).find(value => value.id === project.id);
    const link = { conversationId: 'c', cwd: '/work', title: '对话', taskId: 't' };
    await expect(backend.linkConversation(project.id, { ...link, taskId: 'fake' })).rejects.toThrow(/任务不存在/);
    await backend.linkConversation(project.id, link);
    await expect(backend.linkConversation(other.id, link)).rejects.toThrow(/任务不存在|其他项目/);
    await expect(backend.linkConversation(other.id, { conversationId: 'c', cwd: '/work', title: '其他' })).rejects.toThrow(/其他项目/);
    const run = { status: 'completed', recordedAt: 100, excerpt: '助手声明完成', messageId: 'm', sessionId: 's' };
    await backend.recordConversation('c', run);
    project = (await backend.list()).find(value => value.id === project.id);
    expect(project.tasks[0].status).toBe('pending'); expect(project.goalConfirmed).toBe(false);
    expect(project.conversations[0].lastRun.verified).toBe(false);
    const rename = vi.spyOn(fs.promises, 'rename');
    await backend.recordConversation('c', run); await backend.linkConversation(project.id, link);
    await backend.recordConversation('missing', run); await backend.recordConversation('c', { ...run, recordedAt: 99 });
    expect(rename).not.toHaveBeenCalled(); rename.mockRestore();
    const saved = await patch(project, { tasks: [] });
    expect(saved.find(value => value.id === project.id).conversations[0].taskId).toBe('t');
    expect(await make().list()).toEqual(saved);
  });
  it('同项目 session 恢复重绑定新 GUI 对话，保留任务和运行历史，不同 session 不去重', async () => {
    let project = await create();
    project = (await patch(project, { tasks: [task('t')] }))[0];
    await backend.linkConversation(project.id, { conversationId: 'old', sessionId: 's', cwd: '/work', title: 'old', taskId: 't' });
    project = (await backend.recordConversation('old', { status: 'completed', recordedAt: 20, excerpt: 'run' }))[0];
    const old = project.conversations[0];
    await backend.linkConversation(project.id, { conversationId: 'new', cwd: '/work', title: 'new' });
    project = (await backend.linkConversation(project.id, { conversationId: 'new', sessionId: 's', cwd: '/work', title: 'resumed' }))[0];
    expect(project.conversations).toEqual([{ ...old, conversationId: 'new', title: 'resumed' }]);
    const rename = vi.spyOn(fs.promises, 'rename');
    expect(await backend.linkConversation(project.id, { conversationId: 'new', sessionId: 's', cwd: '/work', title: 'resumed' })).toEqual([project]);
    expect(rename).not.toHaveBeenCalled(); rename.mockRestore();
    project = (await backend.linkConversation(project.id, { conversationId: 'another', sessionId: 'other', cwd: '/work', title: '' }))[0];
    expect(project.conversations).toHaveLength(2); expect(await make().list()).toEqual([project]);
  });
  it('只能核对已有链接；新执行清空 reviewedAt，归档可记录，删除忽略不复活', async () => {
    let project = await create();
    project = (await backend.linkConversation(project.id, { conversationId: 'c', cwd: '/work', title: '' }))[0];
    await expect(patch(project, { conversations: [{ conversationId: 'fake', reviewedAt: 20 }] })).rejects.toThrow(/伪造/);
    await expect(patch(project, { conversations: [{ conversationId: 'c', reviewedAt: 20, lastRun: {} }] })).rejects.toThrow(/不支持/);
    project = (await patch(project, { conversations: [{ conversationId: 'c', reviewedAt: 20 }] }))[0];
    await backend.archive(project.id, true);
    const result = { status: 'failed', recordedAt: 30, excerpt: '执行失败' };
    project = (await backend.recordConversation('c', result))[0];
    expect(project.archivedAt).toBeDefined(); expect(project.conversations[0].reviewedAt).toBeUndefined();
    await expect(backend.linkConversation(project.id, { conversationId: 'new', cwd: '/work', title: '' })).rejects.toThrow(/活跃/);
    const removed = await backend.remove(project.id, true);
    expect(await backend.recordConversation('c', { ...result, recordedAt: 40 })).toEqual(removed);
  });
});

describe('容量和显式存储恢复', () => {
  it('坏盘启动也能查询有效备份，恢复入口不依赖主盘成功加载', async () => {
    const first = await create(); await patch(first, { name: '之后修改' });
    await fs.promises.writeFile(backend.filePath, '{broken');
    const restarted = make();
    await expect(restarted.list()).rejects.toThrow(/存储/);
    expect(await restarted.storageInfo()).toMatchObject({ backupAvailable: true, loadError: expect.stringContaining('损坏'), maxBytes: 32 * 1024 * 1024 });
    expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe('{broken');
  });
  it('备份保存上个有效 snapshot，坏盘重载不改内存，显式恢复保留损坏原盘', async () => {
    const first = await create(); const original = await fs.promises.readFile(backend.filePath, 'utf8');
    const current = await patch(first, { name: 'new' });
    expect(await fs.promises.readFile(`${backend.filePath}.bak`, 'utf8')).toBe(original);
    const info = await backend.storageInfo();
    expect(info).toMatchObject({ projects: 1, deletedProjects: 0, maxProjects: 10000, maxBytes: 32 * 1024 * 1024, backupAvailable: true });
    expect(info.bytes).toBe(Buffer.byteLength(await fs.promises.readFile(backend.filePath, 'utf8')));
    await fs.promises.writeFile(backend.filePath, '{broken');
    await expect(backend.reload()).rejects.toThrow(); expect(await backend.list()).toEqual(current);
    const restored = await backend.restoreBackup(); expect(restored).toEqual([first]);
    const corrupt = (await fs.promises.readdir(path.dirname(backend.filePath))).filter(file => file.endsWith('.corrupt'));
    expect(corrupt).toHaveLength(1);
    expect(await fs.promises.readFile(path.join(path.dirname(backend.filePath), corrupt[0]), 'utf8')).toBe('{broken');
    expect(await make().list()).toEqual(restored);
  });
  it('超过 32MB 坏盘恢复使用独占字节复制，load 仍拒绝超限且保留 corrupt', async () => {
    const first = await create(); await patch(first, { name: 'new' });
    const bytes = Buffer.alloc(32 * 1024 * 1024 + 1, 0xff);
    await fs.promises.writeFile(backend.filePath, bytes);
    const restarted = make(); await expect(restarted.list()).rejects.toThrow(/过大/);
    const read = vi.spyOn(fs.promises, 'readFile'), copy = vi.spyOn(fs.promises, 'copyFile');
    expect(await restarted.restoreBackup()).toEqual([first]);
    expect(read.mock.calls.some(([file]) => file === backend.filePath)).toBe(false);
    expect(copy).toHaveBeenCalledWith(backend.filePath, expect.stringMatching(/\.corrupt$/), fs.constants.COPYFILE_EXCL);
    read.mockRestore(); copy.mockRestore();
    const corrupt = (await fs.promises.readdir(path.dirname(backend.filePath))).find(file => file.endsWith('.corrupt'));
    expect((await fs.promises.readFile(path.join(path.dirname(backend.filePath), corrupt))).equals(bytes)).toBe(true);
    expect(await make().list()).toEqual([first]);
  });
  it.each(['directory', 'symlink'])('恢复拒绝 %s 主盘，明确人工处理且不影响原路径', async kind => {
    const first = await create(); await patch(first, { name: 'new' });
    await fs.promises.unlink(backend.filePath);
    const target = path.join(dir, 'target'); await fs.promises.writeFile(target, 'keep');
    if (kind === 'directory') await fs.promises.mkdir(backend.filePath);
    else await fs.promises.symlink(target, backend.filePath);
    await expect(backend.restoreBackup()).rejects.toThrow(/人工处理/);
    const stat = await fs.promises.lstat(backend.filePath);
    expect(kind === 'directory' ? stat.isDirectory() : stat.isSymbolicLink()).toBe(true);
    expect(await fs.promises.readFile(target, 'utf8')).toBe('keep');
  });
  it('恢复写入失败不移动原盘，复制期间或替换前外部写入不会被覆盖', async () => {
    const first = await create(); const current = await patch(first, { name: 'new' });
    await fs.promises.writeFile(backend.filePath, 'broken');
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('restore failed'));
    await expect(backend.restoreBackup()).rejects.toThrow(/restore failed/);
    expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe('broken'); expect(await backend.list()).toEqual(current); rename.mockRestore();
    const realCopy = fs.promises.copyFile.bind(fs.promises);
    const copy = vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (...args) => {
      await realCopy(...args); await fs.promises.writeFile(backend.filePath, 'concurrent-after-copy');
    });
    await expect(backend.restoreBackup()).rejects.toThrow(/外部修改/); copy.mockRestore();
    expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe('concurrent-after-copy');
    const realOpen = fs.promises.open.bind(fs.promises);
    const open = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      await fs.promises.writeFile(backend.filePath, 'concurrent-before-replace'); return realOpen(...args);
    });
    await expect(backend.restoreBackup()).rejects.toThrow(/外部修改/); open.mockRestore();
    expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe('concurrent-before-replace');
    expect((await fs.promises.readdir(path.dirname(backend.filePath))).filter(file => file.endsWith('.tmp'))).toEqual([]);
  });
  it.each([false, true])('初次 load 延迟%s不能覆盖 reload 最新快照或错误状态', async rejectOld => {
    const first = await create(), latest = await patch(first, { name: 'latest' });
    const restarted = make(); let release;
    vi.spyOn(restarted, 'readSnapshot').mockImplementationOnce(() => new Promise((resolve, reject) => {
      release = () => rejectOld ? reject(new Error('old read failure')) : resolve(JSON.stringify({ version: 1, projects: [first] }));
    }));
    const pending = restarted.list(); await vi.waitFor(() => expect(release).toBeDefined());
    expect(await restarted.reload()).toEqual(latest); release();
    expect(await pending).toEqual(latest); expect(await restarted.list()).toEqual(latest); expect(restarted.loadError).toBeNull();
  });
  it('备份失败不损主盘；清理仅允许回收站，失败原子回滚', async () => {
    const project = await create(); const raw = await fs.promises.readFile(backend.filePath, 'utf8');
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('rename denied'));
    await expect(patch(project, { name: 'bad' })).rejects.toThrow(/rename denied/);
    expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe(raw); expect(await backend.list()).toEqual([project]);
    expect((await fs.promises.readdir(path.dirname(backend.filePath))).filter(file => file.endsWith('.tmp'))).toEqual([]);
    rename.mockRestore(); await expect(backend.purge(project.id)).rejects.toThrow(/已删除/);
    await backend.remove(project.id, true); expect((await backend.storageInfo()).deletedProjects).toBe(1);
    await backend.purge(project.id); expect(await backend.list()).toEqual([]); expect(await make().list()).toEqual([]);
  });
  it('重载有效外部盘，严格拒绝未知字段/版本，旧空必要验收撤销且不覆盖原盘', async () => {
    const project = await create();
    const old = { ...project, goalConfirmed: true, tasks: [task('optional', 'pending', true)] };
    for (const field of ['revision', 'background', 'constraints', 'decisions', 'deliverables', 'recognitionNotes']) delete old[field];
    const raw = JSON.stringify({ version: 1, projects: [old] }); await fs.promises.writeFile(backend.filePath, raw);
    const loaded = await backend.reload(); expect(loaded[0].revision).toBe(0); expect(loaded[0].goalConfirmed).toBe(false);
    expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe(raw);
    for (const value of [{ version: 2, projects: [] }, { version: 1, projects: [], unexpected: true }, { version: 1, projects: [{ ...project, unexpected: true }] }]) {
      await fs.promises.writeFile(backend.filePath, JSON.stringify(value));
      await expect(backend.reload()).rejects.toThrow(); expect(await backend.list()).toEqual(loaded);
    }
  });
  it('写入容量与数量上限在任何文件修改前拒绝', async () => {
    const project = await create(), raw = await fs.promises.readFile(backend.filePath, 'utf8');
    const oversized = { ...project, tags: Array.from({ length: 200 }, () => 'x'.repeat(200000)) };
    await expect(backend.update(oversized)).rejects.toThrow(/过大/);
    await expect(backend.persist(Array.from({ length: 10001 }, (_, i) => ({ ...project, id: `p${i}` })))).rejects.toThrow(/结构/);
    expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe(raw); expect(await backend.list()).toEqual([project]);
  });
});
