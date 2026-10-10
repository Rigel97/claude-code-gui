import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { ProjectsBackend } from '../src/main/projects.js';

let dir, backend;
const goal = '请开发一个客户管理系统';
const text = (id, role, value, timestamp = 1) => ({ id, role, timestamp, blocks: [{ kind: 'text', text: value }] });
const tool = (id, name, input, result = '成功', status = 'done') => ({ kind: 'tool_use', toolId: id, toolName: name, input, result, status });
const todos = (status = 'pending') => [{ content: '实现客户列表', status }, { content: '实现客户详情', status }];
const gui = (sessionId = 's1', target = goal, extra = []) => ({ sessionId, cwd: '/work', title: target, messages: [text('u1', 'user', target), { id: 'a1', role: 'assistant', timestamp: 2, blocks: [tool('todo1', 'TodoWrite', { todos: todos() }), ...extra] }] });
const data = (sessions = [gui()], conversations = []) => ({ sessions, conversations });
const review = (candidate, edits = {}) => ({ candidateId: candidate.id, name: candidate.name, goal: candidate.goal, description: candidate.description, ...edits });
async function confirmed() {
  const scan = await backend.scan(data());
  await backend.confirm(scan.scanId, [review(scan.candidates[0])]);
  return (await backend.list())[0];
}
async function cli(name, rows) {
  const root = path.join(dir, '.claude', 'projects', 'work');
  await fs.promises.mkdir(root, { recursive: true });
  const file = path.join(root, name + '.jsonl');
  await fs.promises.writeFile(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n'));
  return file;
}
const row = (type, content, uuid, timestamp = '2026-01-01T00:00:00Z') => ({ type, uuid, sessionId: 's1', cwd: '/work', timestamp, message: { role: type, content } });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, content = '成功', is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'projects-test-'));
  backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {} });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.promises.rm(dir, { recursive: true, force: true }); });

describe('ProjectsBackend 确认与持久化', () => {
  it('scan 只读；拒绝伪造 scan/candidate；confirm 幂等并支持重启', async () => {
    const scan = await backend.scan(data());
    expect(scan.candidates).toHaveLength(1);
    expect(await backend.list()).toEqual([]);
    expect(fs.existsSync(backend.filePath)).toBe(false);
    await expect(backend.confirm('fake', [])).rejects.toThrow(/scan/i);
    await expect(backend.confirm(scan.scanId, [review(scan.candidates[0], { candidateId: 'fake' })])).rejects.toThrow(/候选/);
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { name: '我的客户系统' })]);
    const saved = await backend.list();
    expect(saved[0].name).toBe('我的客户系统');
    await backend.confirm(scan.scanId, [review(scan.candidates[0])]);
    expect(await backend.list()).toEqual(saved);
    const restarted = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {} });
    expect(await restarted.list()).toEqual(saved);
    expect(JSON.parse(await fs.promises.readFile(backend.filePath, 'utf8')).version).toBe(1);
  });
  it('扫描后用户状态更新不会被关联确认覆盖；显式 allowDuplicate 独立创建', async () => {
    const project = await confirmed();
    const scan = await backend.scan(data());
    expect(scan.candidates[0].existingProjectId).toBe(project.id);
    project.tasks[0].status = 'completed';
    project.tasks[1].dependsOn = [project.tasks[0].id];
    project.tasks[1].dependencyNote = '用户设置依赖';
    await backend.update(project);
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { existingProjectId: project.id })]);
    expect((await backend.list())[0].tasks[0].status).toBe('completed');
    expect((await backend.list())[0].tasks[1].dependsOn).toEqual([project.tasks[0].id]);
    expect((await backend.list())[0].tasks[1].dependencyNote).toBe('用户设置依赖');
    const fresh = await backend.scan(data());
    await backend.confirm(fresh.scanId, [review(fresh.candidates[0], { allowDuplicate: true })]);
    expect(await backend.list()).toHaveLength(2);
    await backend.confirm(fresh.scanId, [review(fresh.candidates[0], { allowDuplicate: true })]);
    expect(await backend.list()).toHaveLength(2);
  });
  it('原子写失败不改变内存或原文件；可以重试', async () => {
    const project = await confirmed();
    const before = await fs.promises.readFile(backend.filePath, 'utf8');
    const spy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk denied'), { code: 'EACCES' }));
    await expect(backend.update({ ...project, name: '变化' })).rejects.toThrow(/写入.*EACCES/);
    expect((await backend.list())[0].name).toBe(project.name);
    expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe(before);
    spy.mockRestore();
    await backend.update({ ...project, name: '变化' });
    expect((await backend.list())[0].name).toBe('变化');
    expect((await fs.promises.readdir(path.dirname(backend.filePath))).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
  it('损坏/未知版本文件不可静默覆盖', async () => {
    await fs.promises.mkdir(path.dirname(backend.filePath), { recursive: true });
    for (const content of ['{bad', JSON.stringify({ version: 99, projects: [] }), JSON.stringify({ version: 1, projects: [{}] })]) {
      await fs.promises.writeFile(backend.filePath, content);
      const broken = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {} });
      await expect(broken.list()).rejects.toThrow(/项目存储/);
      await expect(broken.scan(data())).rejects.toThrow(/项目存储/);
      expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe(content);
    }
  });
  it('首次读取权限错误明确返回，不当作空存储', async () => {
    vi.spyOn(fs.promises, 'lstat').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(backend.list()).rejects.toThrow(/EACCES/);
  });
});

describe('ProjectsBackend 补充边界', () => {
  it('加载后文件被外部损坏不能覆盖，confirm 写失败仍可重试', async () => {
    const project = await confirmed();
    await fs.promises.writeFile(backend.filePath, '{external broken');
    await expect(backend.update({ ...project, name: 'new' })).rejects.toThrow(/外部修改/);
    expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe('{external broken');
    expect(await backend.list()).toEqual([project]);
    const second = new ProjectsBackend({ home: dir, userData: path.join(dir, 'second'), env: {} });
    const scan = await second.scan(data());
    const spy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    await expect(second.confirm(scan.scanId, [review(scan.candidates[0])])).rejects.toThrow(/ENOSPC/);
    expect(await second.list()).toEqual([]);
    spy.mockRestore();
    await second.confirm(scan.scanId, [review(scan.candidates[0])]);
    expect(await second.list()).toHaveLength(1);
  });
  it('逐行超限、打开/读取失败有反馈且继续读取其他文件', async () => {
    await cli('oversize', ['x'.repeat(600), row('user', goal, 'u'), row('assistant', [use('t', 'TodoWrite', { todos: todos() })], 'a'), row('user', [result('t')], 'r')]);
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, limits: { maxLineBytes: 500 } });
    const scan = await backend.scan(data([]));
    expect(scan.candidates).toHaveLength(1);
    expect(scan.coverage.warnings.join(' ')).toMatch(/行过大/);
    await cli('good', [row('user', goal, 'u'), row('assistant', [use('t', 'TodoWrite', { todos: todos() })], 'a'), row('user', [result('t')], 'r')]);
    const open = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('oversize.jsonl')) vi.spyOn(handle, 'read').mockRejectedValueOnce(Object.assign(new Error('io failure'), { code: 'EIO' }));
      return handle;
    });
    const failed = await backend.scan(data([]));
    expect(failed.coverage.warnings.join(' ')).toMatch(/EIO/);
    expect(failed.candidates).toHaveLength(1);
    spy.mockRestore();
    const openDenied = vi.spyOn(fs.promises, 'open').mockImplementation((...args) => String(args[0]).endsWith('oversize.jsonl') ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) : open(...args));
    const denied = await backend.scan(data([]));
    expect(denied.coverage.warnings.join(' ')).toMatch(/EACCES/);
    expect(denied.candidates).toHaveLength(1);
    openDenied.mockRestore();
  });
  it('文件 IO 依据执行时任务状态关联，工具结束不等于目标完成', async () => {
    const session = gui();
    session.messages[1].blocks = [tool('t1', 'TodoWrite', { todos: [{ content: '实现客户列表', status: 'in_progress' }, { content: '实现客户详情', status: 'pending' }] })];
    session.messages.push({ id: 'write', role: 'assistant', timestamp: 3, blocks: [tool('w', 'Write', { file_path: '/work/app.js' }), tool('p', 'Write', { file_path: '/work/plan.md' })] });
    session.messages.push({ id: 'done', role: 'assistant', timestamp: 4, blocks: [tool('t2', 'TodoWrite', { todos: todos('completed') })] });
    const p = (await backend.scan(data([session]))).candidates[0];
    expect(p.tasks[0].outputs).toEqual(['/work/app.js']);
    expect(p.tasks[1].outputs).toEqual([]);
    expect(p.tasks.every(t => t.status === 'completed')).toBe(true);
    expect(p.goalConfirmed).toBe(false);
  });
  it('写入临时文件和 fsync 失败均不改变内存/原盘；存储读取失败不视为空', async () => {
    const project = await confirmed();
    const before = await fs.promises.readFile(backend.filePath, 'utf8');
    const open = fs.promises.open.bind(fs.promises);
    for (const method of ['writeFile', 'sync']) {
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith('.tmp')) vi.spyOn(handle, method).mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }));
        return handle;
      });
      await expect(backend.update({ ...project, name: method })).rejects.toThrow(/ENOSPC/);
      spy.mockRestore();
      expect(await backend.list()).toEqual([project]);
      expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe(before);
    }
    const restart = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {} });
    vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(Object.assign(new Error('io'), { code: 'EIO' }));
    await expect(restart.list()).rejects.toThrow(/EIO/);
    expect((await fs.promises.readdir(path.dirname(backend.filePath))).some(file => file.endsWith('.tmp'))).toBe(false);
  });
  it('扫描后用户删除的任务不被关联确认复活', async () => {
    const project = await confirmed();
    const scan = await backend.scan(data());
    project.tasks.pop();
    await backend.update(project);
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { existingProjectId: project.id })]);
    expect((await backend.list())[0].tasks).toHaveLength(1);
  });
  it('GUI 成功结果可补齐尚未落入 CLI 日志的工具结果', async () => {
    await cli('pendingResult', [row('user', goal, 'u'), row('assistant', [use('todo1', 'TodoWrite', { todos: todos() })], 'a')]);
    expect((await backend.scan(data())).candidates).toHaveLength(1);
  });
  it('重复关联 confirm 在用户更新完成状态后不写盘或回退 goalConfirmed', async () => {
    const project = await confirmed();
    const scan = await backend.scan(data());
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { existingProjectId: project.id })]);
    const latest = (await backend.list())[0];
    latest.tasks.forEach(task => { task.status = 'completed'; });
    latest.goalConfirmed = true;
    await backend.update(latest);
    const saved = await backend.list();
    const rename = vi.spyOn(fs.promises, 'rename');
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { existingProjectId: project.id })]);
    expect(await backend.list()).toEqual(saved);
    expect(rename).not.toHaveBeenCalled();
  });
  it('GUI 活跃快照不会丢弃归档的成功工具证据；计划文件仅记录执行', async () => {
    const archive = gui();
    const active = { ...gui(), id: 'tab', messages: [text('u1', 'user', goal)], streamingMessage: { id: 'a1', role: 'assistant', timestamp: 2, blocks: [] } };
    expect((await backend.scan(data([archive], [active]))).candidates).toHaveLength(1);
    const session = gui();
    session.messages[1].blocks = [tool('t', 'TodoWrite', { todos: [{ content: '编写项目实施计划', status: 'in_progress' }, { content: '实现客户详情', status: 'pending' }] })];
    session.messages.push({ id: 'w', role: 'assistant', timestamp: 3, blocks: [tool('w', 'Write', { file_path: '/work/outline.md' })] });
    const p = (await backend.scan(data([session]))).candidates[0];
    expect(p.tasks[0].outputs).toEqual([]);
    expect(p.files[0].purpose).toMatch(/计划/);
  });
  it('不同会话同名工具 id 不互相覆盖，冲突任务状态保留不确定性', async () => {
    const a = gui('first'), b = gui('second');
    b.messages[1].blocks = [tool('todo1', 'TodoWrite', { todos: todos('completed') })];
    const p = (await backend.scan(data([a, b]))).candidates[0];
    expect(p.tasks).toHaveLength(2);
    expect(p.tasks.every(t => t.status === 'pending')).toBe(true);
    expect(p.uncertainties.join(' ')).toMatch(/不一致/);
  });
  it('同一 session 多个明确目标各自独立，扫描返回值无法篡改暂存候选', async () => {
    const session = gui();
    session.messages.push(text('u2', 'user', '请构建一个库存管理系统', 3));
    session.messages.push({ id: 'a2', role: 'assistant', timestamp: 4, blocks: [tool('todo2', 'TodoWrite', { todos: [{ content: '库存列表', status: 'pending' }, { content: '库存盘点', status: 'pending' }] })] });
    const scan = await backend.scan(data([session]));
    expect(scan.candidates).toHaveLength(2);
    const candidate = scan.candidates[0];
    candidate.tasks[0].status = 'completed';
    await backend.confirm(scan.scanId, [review(candidate)]);
    expect((await backend.list())[0].tasks[0].status).toBe('pending');
  });
});

describe.each(['gui', 'cli'])('ProjectsBackend 工具参数复审 %s', source => {
  async function scanCalls(calls, target = goal) {
    if (source === 'gui') {
      const session = gui('s1', target);
      session.messages[1].blocks = calls.map(([id, name, input, output = '成功', failed = false]) => tool(id, name, input, output, failed ? 'error' : 'done'));
      return backend.scan(data([session]));
    }
    const rows = [row('user', target, 'u')];
    calls.forEach(([id, name, input, output = '成功', failed = false], index) => {
      rows.push(row('assistant', [use(id, name, input)], `a${index}`), row('user', [result(id, output, failed)], `r${index}`));
    });
    await cli('inputs', rows);
    return backend.scan(data([]));
  }
  it('成功 TodoWrite JSON 对象字符串更新 completed 为 pending', async () => {
    const scan = await scanCalls([
      ['done', 'TodoWrite', { todos: todos('completed') }],
      ['pending', 'TodoWrite', JSON.stringify({ todos: todos() })],
    ]);
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].tasks.every(t => t.status === 'pending')).toBe(true);
    expect(scan.candidates[0].evidence.join(' ')).toMatch(/成功 TodoWrite.*成功 TodoWrite/);
    expect(scan.coverage.warnings.join(' ')).not.toMatch(/工具参数/);
  });
  it('JSON 字符串支持 TaskCreate、TaskUpdate 和 Read 的结构化证据', async () => {
    const scan = await scanCalls([
      ['c1', 'TaskCreate', JSON.stringify({ subject: '客户列表' }), { task: { id: '1' } }],
      ['c2', 'TaskCreate', JSON.stringify({ subject: '客户详情' }), { task: { id: '2' } }],
      ['start', 'TaskUpdate', JSON.stringify({ taskId: '1', status: 'in_progress' })],
      ['read', 'Read', JSON.stringify({ file_path: '/work/source.js' })],
      ['done', 'TaskUpdate', JSON.stringify({ taskId: '1', status: 'completed', addBlocks: ['2'] })],
    ]);
    const candidate = scan.candidates[0];
    expect(candidate.tasks[0].status).toBe('completed');
    expect(candidate.tasks[0].inputs).toEqual(['/work/source.js']);
    expect(candidate.tasks[1].dependsOn).toEqual([candidate.tasks[0].id]);
  });
  it.each([
    ['TodoWrite', '{bad'], ['TodoWrite', 'null'], ['TodoWrite', '42'],
    ['TodoWrite', '[]'], ['TodoWrite', true], ['TodoWrite', null],
    ['TodoWrite', { todos: todos('done') }], ['TodoWrite', { todos: [{ content: '客户列表' }] }],
    ['TodoWrite', { todos: 'invalid' }], ['TaskCreate', '{bad'],
    ['TaskCreate', { subject: '新增客户任务', status: 'done' }],
    ['TaskCreate', { subject: null }], ['TaskUpdate', '{bad'],
    ['TaskUpdate', { taskId: '1', status: 'done' }],
    ['TaskUpdate', { taskId: { toString: null }, status: 'completed' }],
    ['TaskUpdate', { taskId: '1', addBlockedBy: 'invalid' }],
  ])('成功 %s 无效参数 %j 损坏目标证据，不能保留 completed', async (name, input) => {
    const scan = await scanCalls([
      ['c1', 'TaskCreate', { subject: '客户列表' }, { task: { id: '1' } }],
      ['c2', 'TaskCreate', { subject: '客户详情' }, { task: { id: '2' } }],
      ['done', 'TodoWrite', { todos: todos('completed') }],
      ['d1', 'TaskUpdate', { taskId: '1', status: 'completed' }],
      ['d2', 'TaskUpdate', { taskId: '2', status: 'completed' }],
      ['bad', name, input, { task: { id: '3' } }],
      ['later', 'TodoWrite', { todos: todos('completed') }],
    ]);
    expect(scan.candidates).toHaveLength(1);
    const candidate = scan.candidates[0];
    expect(candidate.tasks.every(t => t.status === 'pending')).toBe(true);
    expect(candidate.uncertainties.join(' ')).toMatch(/damaged.*待确认/);
    expect(candidate.evidence.join(' ')).toMatch(/warning.*工具参数.*bad/);
    expect(scan.coverage.warnings.join(' ')).toMatch(/工具参数.*bad/);
  });
  it('JSON TaskUpdate 在无关问答后仍按已知任务 ID 归属原目标', async () => {
    if (source === 'gui') {
      const session = gui();
      session.messages[1].blocks = [
        tool('c1', 'TaskCreate', { subject: '客户列表' }, { id: '1' }),
        tool('c2', 'TaskCreate', { subject: '客户详情' }, { id: '2' }),
      ];
      session.messages.push(text('question', 'user', 'HTTP 是什么？', 3), {
        id: 'update', role: 'assistant', timestamp: 4,
        blocks: [tool('update', 'TaskUpdate', JSON.stringify({ taskId: '1', status: 'completed' }))],
      });
      const scan = await backend.scan(data([session]));
      expect(scan.candidates[0].tasks.map(t => t.status)).toEqual(['completed', 'pending']);
    } else {
      await cli('route', [
        row('user', goal, 'u'),
        row('assistant', [use('c1', 'TaskCreate', { subject: '客户列表' }), use('c2', 'TaskCreate', { subject: '客户详情' })], 'a'),
        row('user', [result('c1', { id: '1' }), result('c2', { id: '2' })], 'r'),
        row('user', 'HTTP 是什么？', 'question'),
        row('assistant', [use('update', 'TaskUpdate', JSON.stringify({ taskId: '1', status: 'completed' }))], 'update'),
        row('user', [result('update')], 'ur'),
      ]);
      const scan = await backend.scan(data([]));
      expect(scan.candidates[0].tasks.map(t => t.status)).toEqual(['completed', 'pending']);
    }
  });
  it('代码块中的 JSON TodoWrite 计划不能当作执行更新', async () => {
    const plan = '```json\n' + JSON.stringify({ name: 'TodoWrite', input: { todos: todos() } }) + '\n```';
    if (source === 'gui') {
      const session = gui();
      session.messages[1].blocks = [tool('done', 'TodoWrite', { todos: todos('completed') })];
      session.messages.push(text('plan', 'assistant', plan, 3));
      expect((await backend.scan(data([session]))).candidates[0].tasks.every(t => t.status === 'completed')).toBe(true);
    } else {
      await cli('plan', [row('user', goal, 'u'), row('assistant', [use('done', 'TodoWrite', { todos: todos('completed') })], 'a'), row('user', [result('done')], 'r'), row('assistant', plan, 'plan')]);
      expect((await backend.scan(data([]))).candidates[0].tasks.every(t => t.status === 'completed')).toBe(true);
    }
  });
  it('失败结果的坏参数不采信，也不损坏之前成功的状态', async () => {
    const scan = await scanCalls([
      ['done', 'TodoWrite', { todos: todos('completed') }],
      ['failed', 'TodoWrite', '{bad', '失败', true],
    ]);
    expect(scan.candidates[0].tasks.every(t => t.status === 'completed')).toBe(true);
    expect(scan.candidates[0].uncertainties.join(' ')).toMatch(/没有成功结果/);
    expect(scan.coverage.warnings.join(' ')).not.toMatch(/工具参数/);
  });
  it.each(['{bad', { file_path: 42 }])('Read 错误参数 %j 标 unknown 但不降级任务状态', async input => {
    const scan = await scanCalls([
      ['done', 'TodoWrite', { todos: todos('completed') }], ['badread', 'Read', input],
    ]);
    expect(scan.candidates[0].tasks.every(t => t.status === 'completed')).toBe(true);
    expect(scan.candidates[0].files).toEqual([]);
    expect(scan.candidates[0].evidence.join(' ')).toMatch(/warning.*Read.*unknown/);
    expect(scan.candidates[0].uncertainties.join(' ')).not.toMatch(/damaged/);
  });
});

describe('ProjectsBackend 扫描异常和 IO 合并复审', () => {
  it('非法 CLI row IDs/cwd 不崩溃，保留目标并标 unknown/damaged', async () => {
    await cli('invalidMetadata', [
      { ...row('user', goal, 'u'), uuid: { toString: null }, cwd: '/work\0bad', sessionId: { toString: null } },
      { ...row('assistant', [use('done', 'TodoWrite', { todos: todos('completed') })], 'a'), cwd: 42, sessionId: { toString: null } },
      { ...row('user', [result('done')], 'r'), cwd: {}, sessionId: { toString: null } },
    ]);
    const scan = await backend.scan(data([]));
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].tasks.every(t => t.status === 'pending')).toBe(true);
    expect(scan.candidates[0].sources.every(s => typeof s.messageId === 'string' && s.cwd === '')).toBe(true);
    expect(scan.coverage.warnings.join(' ')).toMatch(/元数据.*无效/);
    await backend.confirm(scan.scanId, [review(scan.candidates[0])]);
  });
  it('非法 GUI message id/cwd 不崩溃', async () => {
    const session = gui();
    session.cwd = '/work\0bad';
    session.messages[0].id = { toString: null };
    session.messages[1].blocks = [tool('done', 'TodoWrite', { todos: todos('completed') })];
    const scan = await backend.scan(data([session]));
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].tasks.every(t => t.status === 'pending')).toBe(true);
    expect(scan.coverage.warnings.join(' ')).toMatch(/元数据.*无效/);
  });
  it('未用户编辑的旧 IO 被新扫描成功 IO 补齐，用户编辑 IO 保持不变', async () => {
    const project = await confirmed();
    project.tasks[1].outputs = ['/manual/output.js'];
    await backend.update(project);
    const session = gui();
    session.messages[1].blocks = [
      tool('start', 'TodoWrite', { todos: [{ content: '实现客户列表', status: 'in_progress' }, todos()[1]] }),
      tool('read', 'Read', JSON.stringify({ file_path: '/work/source.js' })),
      tool('write', 'Write', JSON.stringify({ file_path: '/work/app.js' })),
      tool('second', 'TodoWrite', { todos: [todos('completed')[0], { content: '实现客户详情', status: 'in_progress' }] }),
      tool('write2', 'Write', { file_path: '/work/detail.js' }),
    ];
    const scan = await backend.scan(data([session]));
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { existingProjectId: project.id })]);
    const saved = (await backend.list())[0];
    expect(saved.tasks[0].inputs).toEqual(['/work/source.js']);
    expect(saved.tasks[0].outputs).toEqual(['/work/app.js']);
    expect(saved.tasks[1].outputs).toEqual(['/manual/output.js']);
    expect(saved.uncertainties.join(' ')).toMatch(/outputs 用户编辑/);
  });
});

describe('ProjectsBackend 显式项目字段与预期 IO', () => {
  const fields = ['background', 'constraints', 'decisions', 'deliverables'];
  it.each(['gui', 'cli'])('用户显式 heading/冒号/连续段落可靠提取，助手不补充：%s', async source => {
    const prompt = `${goal}\n## 项目背景\n客户资料分散。\n\n销售需要统一检索。\n### 约束条件：只能离线运行\n不得上传客户资料。\n关键决策: 使用 SQLite\n预期交付物：桌面安装包\n验收目标：支持搜索与导出\n## 其他说明\n不属于交付物。`;
    const assistant = '背景：助手臆测背景\n约束：助手臆测约束\n决策：助手臆测决策\n交付物：助手宣称完成';
    let scan;
    if (source === 'gui') {
      const session = gui('s1', prompt);
      session.messages.push(text('assistant', 'assistant', assistant, 3));
      scan = await backend.scan(data([session]));
    } else {
      await cli('labeled', [row('user', prompt, 'u'), row('assistant', [use('todo', 'TodoWrite', { todos: todos() }), { type: 'text', text: assistant }], 'a'), row('user', [result('todo')], 'r')]);
      scan = await backend.scan(data([]));
    }
    expect(scan.candidates).toHaveLength(1);
    const candidate = scan.candidates[0];
    expect(candidate.background).toBe('客户资料分散。\n\n销售需要统一检索。');
    expect(candidate.constraints).toBe('只能离线运行\n不得上传客户资料。');
    expect(candidate.decisions).toBe('使用 SQLite');
    expect(candidate.deliverables).toBe('桌面安装包\n\n支持搜索与导出');
    expect(candidate.evidence.join(' ')).toMatch(/用户显式 background 原文.*source/s);
    expect(fields.map(field => candidate[field]).join(' ')).not.toMatch(/助手|其他说明|不属于/);
    expect(candidate.files).toEqual([]); expect(candidate.goalConfirmed).toBe(false);
  });
  it.each(['背景', '项目背景', '需求背景', '约束', '约束条件', '决策', '关键决策', '预期交付物', '交付物', '验收目标'])('支持标签别名 %s，字段之间不串', async label => {
    const candidate = (await backend.scan(data([gui('label', `${goal}\n${label}：原文值\n## 其他标题\n隔离值`)]))).candidates[0];
    const field = /背景/.test(label) ? 'background' : /约束/.test(label) ? 'constraints' : /决策/.test(label) ? 'decisions' : 'deliverables';
    for (const key of fields) expect(candidate[key]).toBe(key === field ? '原文值' : '');
  });
  it('无标签保持空，源码 fenced/引用/普通叙述不提取', async () => {
    const prompt = `${goal}\n客户资料分散且只能离线。\n代码示例：\n\`\`\`markdown\n背景：伪背景\n约束：伪约束\n决策：伪决策\n交付物：伪产物\n\`\`\`\n~~~text\n## 项目背景\n更多伪背景\n~~~\n> 背景：引用\n说明背景：不是显式背景字段`;
    const candidate = (await backend.scan(data([gui('code', prompt)]))).candidates[0];
    for (const field of fields) expect(candidate[field]).toBe('');
    expect(candidate.evidence.join(' ')).not.toMatch(/用户显式/);
  });
  it('缩进源码、引用不提取，原文字面大小写与标点差异不能去重', async () => {
    const candidate = (await backend.scan(data([gui('literal', `${goal}\n    背景：缩进源码\n\t决策：缩进源码\n> 交付物：引用\n约束：API 大小写敏感。\n约束：api 大小写敏感！`)]))).candidates[0];
    expect(candidate.background).toBe(''); expect(candidate.decisions).toBe(''); expect(candidate.deliverables).toBe('');
    expect(candidate.constraints).toBe('API 大小写敏感。\n\napi 大小写敏感！');
    expect(candidate.uncertainties.join(' ')).toMatch(/需用户确认/);
  });
  it('同目录明确目标多会话融合原文去重，不选择矛盾约束', async () => {
    const scan = await backend.scan(data([
      gui('a', `${goal}\n背景：客户资料分散\n约束：禁止联网`),
      gui('b', `请直接开发一个客户管理系统\n需求背景：客户资料分散\n约束条件：必须联网\n决策：使用本地缓存`),
    ]));
    expect(scan.candidates).toHaveLength(1);
    const candidate = scan.candidates[0];
    expect(candidate.background).toBe('客户资料分散');
    expect(candidate.constraints).toBe('禁止联网\n\n必须联网');
    expect(candidate.evidence.filter(e => e.startsWith('用户显式 background'))).toHaveLength(2);
    expect(candidate.uncertainties.join(' ')).toMatch(/constraints.*矛盾.*需用户确认/);
  });
  it('只在原目标 lane 接受显式字段跟进，新目标与已断开的无关消息不串', async () => {
    const session = gui();
    session.messages.push(text('constraints', 'user', '约束：不能改按钮颜色\n决策：继续用 SQLite', 3));
    session.messages.push(text('new', 'user', '开发库存管理系统\n背景：库存背景', 4), {
      id: 'newtasks', role: 'assistant', timestamp: 5, blocks: [tool('newtodo', 'TodoWrite', { todos: todos() })],
    });
    session.messages.push(text('q', 'user', 'HTTP 是什么？', 6), text('detached', 'user', '背景：不相关背景', 7));
    const candidates = (await backend.scan(data([session]))).candidates;
    expect(candidates).toHaveLength(2);
    expect(candidates.find(c => c.goal === goal).constraints).toBe('不能改按钮颜色');
    expect(candidates.find(c => c.goal === goal).background).toBe('');
    expect(candidates.find(c => c.goal !== goal).background).toBe('库存背景');
  });
  it.each(['gui', 'cli'])('TaskCreate description 的显式预期 IO 隔离于项目及实际执行：%s', async source => {
    const description = '输入：客户 CSV\n第二份配置\n输出: 客户列表页面\n背景：任务局部背景\n约束：任务局部约束\n```text\n输入：代码假输入\n输出：代码假输出\n```';
    const calls = [
      ['c1', { subject: '客户列表', description }, { id: '1' }],
      ['c2', { subject: '客户详情', description: '说明：输入和输出尚未指定' }, { id: '2' }],
      ['failed', { subject: '失败任务', description: '输入：失败输入' }, '错误'],
    ];
    let scan;
    if (source === 'gui') {
      const session = gui('s1', `${goal}\n背景：项目背景\n输入：不是项目字段`);
      session.messages[1].blocks = calls.map(([id, input, output]) => tool(id, 'TaskCreate', input, output, id === 'failed' ? 'error' : 'done'));
      scan = await backend.scan(data([session]));
    } else {
      await cli('io', [row('user', `${goal}\n背景：项目背景\n输入：不是项目字段`, 'u'), row('assistant', calls.map(([id, input]) => use(id, 'TaskCreate', input)), 'a'), row('user', calls.map(([id, , output]) => result(id, output, id === 'failed')), 'r')]);
      scan = await backend.scan(data([]));
    }
    const candidate = scan.candidates[0];
    expect(candidate.tasks).toHaveLength(2);
    expect(candidate.background).toBe('项目背景'); expect(candidate.constraints).toBe('');
    expect(candidate.tasks[0].inputs).toEqual(['预期输入：客户 CSV\n第二份配置']);
    expect(candidate.tasks[0].outputs).toEqual(['预期输出：客户列表页面']);
    expect(candidate.tasks[0].records.join(' ')).toMatch(/预期输入.*非实际执行/);
    expect(candidate.tasks[0].records.join(' ')).toMatch(/输出 unknown/);
    expect(candidate.tasks[1].inputs).toEqual([]); expect(candidate.tasks[1].outputs).toEqual([]);
    expect(candidate.files).toEqual([]); expect(candidate.deliverables).toBe('');
    expect(candidate.tasks.every(t => t.status === 'pending')).toBe(true);
  });
  it('任务 heading 内项目同名标签不提升为项目字段，同级项目 section 正常提取', async () => {
    const prompt = `${goal}\n## 任务列表\n### 客户列表\n背景：任务背景\n输入：任务输入\n### 客户详情\n输出：任务输出\n## 项目背景\n真正项目背景\n## 决策\n真正项目决策`;
    const candidate = (await backend.scan(data([gui('nested', prompt)]))).candidates[0];
    expect(candidate.background).toBe('真正项目背景'); expect(candidate.decisions).toBe('真正项目决策');
    expect(candidate.tasks.every(t => !t.inputs.length && !t.outputs.length)).toBe(true);
  });
  it('超出摘录范围的新增背景完整保存，已扫描确认的非空字段同样不能覆盖', async () => {
    const initial = await backend.scan(data([gui('initial', `${goal}\n背景：旧背景\n约束：旧约束\n决策：旧决策\n交付物：旧交付物`)]));
    await backend.confirm(initial.scanId, [review(initial.candidates[0])]);
    const old = (await backend.list())[0];
    const background = '新背景' + '长段原文'.repeat(800) + '末尾必须保留';
    const scan = await backend.scan(data([gui('long', `${goal}\n${'无标签描述'.repeat(300)}\n背景：${background}\n约束：新约束\n决策：新决策\n交付物：新交付物`)]));
    expect(scan.candidates[0].background).toBe(background);
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { existingProjectId: old.id })]);
    const saved = (await backend.list())[0];
    for (const field of fields) expect(saved[field]).toBe(old[field]);
    expect(saved.sources.find(s => s.sessionId === 'long' && s.excerpt.includes('background')).excerpt).toContain(background);
    expect(saved.uncertainties.join(' ')).toContain(background);
  });
  it('预期 IO 与真实成功 Read/Write 分别标记保留，前者不制造文件记录', async () => {
    const session = gui();
    session.messages[1].blocks = [
      tool('c1', 'TaskCreate', { subject: '实现列表', description: '输入：需求说明\n输出：列表组件' }, { id: '1' }),
      tool('c2', 'TaskCreate', { subject: '实现详情' }, { id: '2' }),
      tool('up', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
      tool('read', 'Read', { file_path: '/work/source.txt' }),
      tool('write', 'Write', { file_path: '/work/list.tsx', content: 'component' }),
    ];
    const candidate = (await backend.scan(data([session]))).candidates[0];
    expect(candidate.tasks[0].inputs).toEqual(['预期输入：需求说明', '/work/source.txt']);
    expect(candidate.tasks[0].outputs).toEqual(['预期输出：列表组件', '/work/list.tsx']);
    expect(candidate.tasks[0].records.join(' ')).toMatch(/预期输出.*非实际执行/);
    expect(candidate.files.map(f => f.path)).toEqual(['/work/source.txt', '/work/list.tsx']);
    expect(candidate.deliverables).toBe(''); expect(candidate.goalConfirmed).toBe(false);
  });
  it('关联确认只补空字段，用户在 scan 后改过的非空字段也保护并保留新增来源', async () => {
    const project = await confirmed();
    const prompt = `${goal}\n背景：新背景\n约束：新约束\n决策：新决策\n交付物：新交付物`;
    const scan = await backend.scan(data([gui('new-source', prompt)]));
    project.background = '用户背景'; project.decisions = '用户决策';
    await backend.update(project);
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { existingProjectId: project.id })]);
    const saved = (await backend.list())[0];
    expect(saved.background).toBe('用户背景'); expect(saved.decisions).toBe('用户决策');
    expect(saved.constraints).toBe('新约束'); expect(saved.deliverables).toBe('新交付物');
    expect(saved.uncertainties.join(' ')).toMatch(/background.*unknown.*新背景/);
    expect(saved.sources.some(s => s.sessionId === 'new-source' && s.excerpt.includes('新背景'))).toBe(true);
    const retry = await backend.scan(data([gui('new-source', prompt)]));
    await backend.confirm(retry.scanId, [review(retry.candidates[0], { existingProjectId: project.id })]);
    expect((await backend.list())[0].background).toBe('用户背景');
    const restarted = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {} });
    expect((await restarted.list())[0].constraints).toBe('新约束');
  });
});

describe('ProjectsBackend 题面适配与证据降级', () => {
  it.each([
    '任务：为现有 GUI 开发项目管理中心',
    '背景：已有桌面软件\n## 任务：开发项目管理中心',
    '帮我为现有网站添加会员功能，包括注册、订阅和权限管理',
    '我希望为模型开发长期评测中心',
    '需求是开发销售数据可视化',
    '项目标题：客户运营管理中心',
    '背景：已有销售数据\n请协助我构建销售分析看板',
  ])('识别明确题面：%s', async target => {
    const scan = await backend.scan(data([gui('adapt', target)]));
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].evidence.join(' ')).toMatch(/明确用户目标.*原文/);
  });
  it.each([
    '任务：解释客户管理系统是什么？',
    '## 任务：临时修改网站按钮颜色',
    '帮我为现有网站添加一个按钮',
    '需求：不要开发客户管理中心',
    '[Previous conversation summary]\n任务：开发客户管理中心',
    '会话摘要\n请构建客户管理中心',
  ])('拒绝短问答/临时修改/摘要：%s', async target => {
    const scan = await backend.scan(data([gui('filtered', target)]));
    expect(scan.candidates).toEqual([]);
    expect(scan.coverage.warnings.join(' ')).toMatch(/识别过滤 evidence/);
  });
  it('略改名但完整目标主体相同保守归并，改换业务或操作目标不能归并', async () => {
    const scan = await backend.scan(data([
      gui('a', '任务：开发客户运营管理中心'),
      gui('b', '## 任务：构建一个客户运营管理中心'),
      gui('c', '任务：迁移客户运营管理中心'),
      gui('d', '任务：开发客户库存管理中心'),
      { ...gui('e', '任务：搭建客户运营管理中心'), cwd: '/elsewhere' },
    ]));
    expect(scan.candidates).toHaveLength(4);
    const merged = scan.candidates.find(c => c.goal === '任务：开发客户运营管理中心');
    expect(new Set(merged.sources.map(s => s.sessionId))).toEqual(new Set(['a', 'b']));
  });
  it('主体仅相似只提示人工关联，已有项目不自动选择', async () => {
    const scan = await backend.scan(data([
      gui('a', '开发客户运营管理中心'), gui('b', '开发客户运营管理中心平台'),
    ]));
    expect(scan.candidates).toHaveLength(2);
    expect(scan.candidates.every(c => c.uncertainties.join(' ').includes('需人工关联'))).toBe(true);
    await backend.confirm(scan.scanId, [review(scan.candidates[0])]);
    const later = await backend.scan(data([gui('b', '开发客户运营管理中心平台')]));
    expect(later.candidates[0].existingProjectId).toBeUndefined();
    expect(later.candidates[0].uncertainties.join(' ')).toMatch(/已有项目.*需人工关联/);
  });
  it('已有匹配默认建议在略改标题重复识别后仍有效，确认不重复且不覆盖用户状态', async () => {
    const first = await backend.scan(data([gui('a', '任务：开发客户运营管理中心')]));
    await backend.confirm(first.scanId, [review(first.candidates[0], { name: '我的中心' })]);
    const project = (await backend.list())[0];
    project.tasks[0].status = 'completed';
    await backend.update(project);
    for (const target of ['## 任务：构建一个客户运营管理中心', '任务：开发客户运营管理中心']) {
      const scan = await backend.scan(data([gui('new-session', target)]));
      expect(scan.candidates[0].existingProjectId).toBe(project.id);
      const edits = { existingProjectId: scan.candidates[0].existingProjectId };
      await backend.confirm(scan.scanId, [review(scan.candidates[0], edits)]);
      await backend.confirm(scan.scanId, [review(scan.candidates[0], edits)]);
      expect(await backend.list()).toHaveLength(1);
      expect((await backend.list())[0].tasks[0].status).toBe('completed');
    }
  });
  it('同 session GUI/CLI summary 改写不合并不同原文目标或借用工具', async () => {
    const different = gui('s1', '请开发一个客户会员管理系统');
    await cli('original', [row('user', goal, 'u'), row('assistant', [use('todo1', 'TodoWrite', { todos: todos() })], 'a'), row('user', [result('todo1')], 'r')]);
    const scan = await backend.scan(data([different]));
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].goal).toBe(goal);
    const summary = gui('summary', '[Previous conversation summary]\n任务：开发客户管理中心');
    expect((await backend.scan(data([summary]))).candidates).toHaveLength(1);
  });
  it('未知依赖与 IO 显式待确认，结构化依赖含调用和成功结果来源', async () => {
    const base = (await backend.scan(data())).candidates[0];
    for (const task of base.tasks) {
      expect(task.dependencyNote).toBe('依赖未记录，待确认（未连线不代表没有依赖）');
      expect(task.records.join(' ')).toMatch(/输入 unknown/);
      expect(task.records.join(' ')).toMatch(/输出 unknown/);
    }
    const session = gui();
    session.messages[1].blocks = [
      tool('c1', 'TaskCreate', { subject: '列表' }, { task: { id: '1' } }),
      tool('c2', 'TaskCreate', { subject: '详情' }, { task: { id: '2' } }),
      tool('dep', 'TaskUpdate', { taskId: '1', addBlocks: ['2'] }),
      tool('baddep', 'TaskUpdate', { taskId: '1', addBlockedBy: ['missing'] }),
    ];
    const p = (await backend.scan(data([session]))).candidates[0];
    expect(p.tasks[0].dependencyNote).toMatch(/^依赖未记录/);
    expect(p.tasks[1].dependsOn).toEqual([p.tasks[0].id]);
    expect(p.tasks[1].dependencyNote).toMatch(/成功 TaskUpdate dep addBlocks.*结构化证据.*result source/);
    expect(p.evidence.join(' ')).toMatch(/成功 TaskUpdate dep/);
    expect(p.uncertainties.join(' ')).toMatch(/未知任务/);
  });
  it('坏行降级所属目标而不回退其他正常完成，GUI 同目标不能掩盖坏行', async () => {
    await cli('bad', [row('user', goal, 'u'), row('assistant', [use('todo1', 'TodoWrite', { todos: todos('completed') })], 'a'), row('user', [result('todo1')], 'r'), '{bad']);
    const damagedGui = gui();
    damagedGui.messages[1].blocks = [tool('todo1', 'TodoWrite', { todos: todos('completed') })];
    const healthy = gui('healthy', '请构建一个库存管理系统');
    healthy.messages[1].blocks = [tool('done', 'TodoWrite', { todos: todos('completed') })];
    const scan = await backend.scan(data([damagedGui, healthy]));
    expect(scan.candidates.find(c => c.goal === goal).tasks.every(t => t.status === 'pending')).toBe(true);
    expect(scan.candidates.find(c => c.goal === goal).uncertainties.join(' ')).toMatch(/待确认/);
    expect(scan.candidates.find(c => c.goal === healthy.title).tasks.every(t => t.status === 'completed')).toBe(true);
  });
  it('无效 GUI 消息只影响所属会话', async () => {
    const bad = gui('bad');
    bad.messages[1].blocks = [tool('todo1', 'TodoWrite', { todos: todos('completed') })];
    bad.messages.push({ role: 'user', blocks: null });
    const healthy = gui('good', '开发财务报告中心');
    healthy.messages[1].blocks = [tool('todo1', 'TodoWrite', { todos: todos('completed') })];
    const scan = await backend.scan(data([bad, healthy]));
    expect(scan.candidates.find(c => c.goal === goal).tasks.every(t => t.status === 'pending')).toBe(true);
    expect(scan.candidates.find(c => c.goal === healthy.title).tasks.every(t => t.status === 'completed')).toBe(true);
  });
  it.each([{ maxMessages: 2 }, { maxGuiSessions: 1 }, { maxTasks: 2 }])('全局或目标上限降级完成状态：%j', async limits => {
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, limits });
    const session = gui();
    session.messages[1].blocks = [tool('todo1', 'TodoWrite', { todos: [...todos('completed'), { content: '验证功能', status: 'completed' }] })];
    session.messages.push(text('tail', 'assistant', '后续状态尚未采集', 3));
    const scan = await backend.scan(data([session, gui('second')]));
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].tasks.every(t => t.status === 'pending')).toBe(true);
    expect(scan.candidates[0].uncertainties.join(' ')).toMatch(/待确认/);
  });
  it('刚好达到 GUI 消息上限也降级，未截断候选不因候选数量上限回退', async () => {
    const session = gui();
    session.messages[1].blocks = [tool('todo1', 'TodoWrite', { todos: todos('completed') })];
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, limits: { maxMessages: 2 } });
    expect((await backend.scan(data([session]))).candidates[0].tasks.every(t => t.status === 'pending')).toBe(true);
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, limits: { maxCandidates: 1 } });
    const limited = await backend.scan(data([session, gui('second', '开发财务报告中心')]));
    expect(limited.candidates[0].tasks.every(t => t.status === 'completed')).toBe(true);
    expect(limited.coverage.warnings.join(' ')).toMatch(/候选数量达到上限/);
  });
  it('CLI 文件数量上限降低 retained 目标完成确信度', async () => {
    const completedRows = [row('user', goal, 'u'), row('assistant', [use('todo1', 'TodoWrite', { todos: todos('completed') })], 'a'), row('user', [result('todo1')], 'r')];
    await cli('first', completedRows);
    await cli('second', completedRows);
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, limits: { maxFiles: 1 } });
    const scan = await backend.scan(data([]));
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].tasks.every(t => t.status === 'pending')).toBe(true);
    expect(scan.coverage.warnings.join(' ')).toMatch(/CLI 文件或消息数量达到上限/);
  });
  it('CLI 总读取量达到上限，已解析的 completed 降 pending', async () => {
    await cli('largeTail', [row('user', goal, 'u'), row('assistant', [use('todo1', 'TodoWrite', { todos: todos('completed') })], 'a'), row('user', [result('todo1')], 'r'), JSON.stringify({ type: 'system', padding: 'x'.repeat(70000) })]);
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, limits: { maxScanBytes: 65536 } });
    const scan = await backend.scan(data([]));
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].tasks.every(t => t.status === 'pending')).toBe(true);
    expect(scan.coverage.warnings.join(' ')).toMatch(/扫描总读取量达到上限/);
  });
  it('略改标题合并保留两段用户原文证据，同 ID 改换目标不匹配已有项目', async () => {
    const first = await backend.scan(data([gui('same', '任务：开发客户运营管理中心'), gui('second', '构建一个客户运营管理中心')]));
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0].evidence.join(' ')).toMatch(/相同完整目标主体保守关联.*构建一个/);
    await backend.confirm(first.scanId, [review(first.candidates[0])]);
    const changed = await backend.scan(data([gui('same', '开发客户库存管理中心')]));
    expect(changed.candidates[0].existingProjectId).toBeUndefined();
  });
  it('分组候选提取过程中让出事件循环', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate');
    await backend.scan(data([gui('a'), gui('b', '开发财务报告中心')]));
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ProjectsBackend 审查问题回归', () => {
  const structured = (extra = []) => {
    const session = gui();
    session.messages[1].blocks = [
      tool('create1', 'TaskCreate', { subject: '列表', description: '初始说明' }, { task: { id: '1' } }),
      tool('create2', 'TaskCreate', { subject: '详情' }, { task: { id: '2' } }), ...extra,
    ];
    return session;
  };
  const save = async session => {
    const scan = await backend.scan(data([session]));
    await backend.confirm(scan.scanId, [review(scan.candidates[0])]);
    return (await backend.list())[0];
  };
  const associate = async (session, project) => {
    const scan = await backend.scan(data([session]));
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { existingProjectId: project.id })]);
    return (await backend.list()).find(p => p.id === project.id);
  };
  it('exact 目标按规范化 cwd 隔离，相同 session/message/tool id 也不互串', async () => {
    const a = { ...gui(), cwd: '/a/./' }, b = { ...gui(), cwd: '/b' };
    b.messages[1].blocks = [tool('todo1', 'TodoWrite', { todos: todos('completed') })];
    const scan = await backend.scan(data([a, b, { ...gui('polite', '请直接开发一个客户管理系统'), cwd: '/a/x/..' }]));
    expect(scan.candidates).toHaveLength(2);
    const left = scan.candidates.find(c => c.sources.some(s => s.cwd === '/a/./'));
    const right = scan.candidates.find(c => c.sources.some(s => s.cwd === '/b'));
    expect(left.identityKey).not.toBe(right.identityKey);
    expect(left.id).not.toBe(right.id);
    expect(left.tasks.every(t => t.status === 'pending')).toBe(true);
    expect(right.tasks.every(t => t.status === 'completed')).toBe(true);
    expect(left.sources.some(s => s.sessionId === 'polite')).toBe(true);
    await backend.confirm(scan.scanId, [review(left)]);
    const later = await backend.scan(data([b]));
    expect(later.candidates[0].existingProjectId).toBeUndefined();
    expect(later.candidates[0].identityKey).toBe(right.identityKey);
    await backend.confirm(later.scanId, [review(later.candidates[0])]);
    expect(await backend.list()).toHaveLength(2);
  });
  it('未知/相对 cwd 不跨会话合并，不强关联已存在项目，identity 稳定', async () => {
    const sessions = [{ ...gui('unknown1'), cwd: '' }, { ...gui('unknown2'), cwd: '' }, { ...gui('relative'), cwd: 'work' }];
    const first = await backend.scan(data(sessions));
    expect(first.candidates).toHaveLength(3);
    expect(new Set(first.candidates.map(c => c.identityKey)).size).toBe(3);
    expect(first.candidates.every(c => c.uncertainties.join(' ').includes('目录 unknown'))).toBe(true);
    await backend.confirm(first.scanId, [review(first.candidates[0])]);
    const second = await backend.scan(data(sessions));
    expect(second.candidates.map(c => c.identityKey)).toEqual(first.candidates.map(c => c.identityKey));
    expect(second.candidates.every(c => !c.existingProjectId)).toBe(true);
  });
  it.each(['列表已经可以了，接着实现详情并测试', '列表已完成，继续推进并验证', '请测试并完成剩余任务'])('跟进反馈保守归属并追踪 Todo 状态：%s', async feedback => {
    const session = gui();
    session.messages.push(text('follow', 'user', feedback, 3), { id: 'done', role: 'assistant', timestamp: 4, blocks: [tool('done', 'TodoWrite', { todos: todos('completed') })] });
    const candidate = (await backend.scan(data([session]))).candidates[0];
    expect(candidate.tasks.every(t => t.status === 'completed')).toBe(true);
    expect(candidate.sources.some(s => s.messageId === 'follow')).toBe(true);
    expect(candidate.uncertainties.join(' ')).toMatch(/关联 unknown/);
    expect(candidate.goalConfirmed).toBe(false);
  });
  it.each(['继续解释 HTTP 是什么？', '接着临时改一下按钮颜色', '好的，另外换个文案'])('短问答及临时变更即使含继续也断开：%s', async feedback => {
    const session = gui();
    session.messages.push(text('follow', 'user', feedback, 3), { id: 'done', role: 'assistant', timestamp: 4, blocks: [tool('done', 'TodoWrite', { todos: todos('completed') })] });
    expect((await backend.scan(data([session]))).candidates[0].tasks.every(t => t.status === 'pending')).toBe(true);
  });
  it('已知 TaskUpdate 跨短问答和新目标回溯原任务，不借用旁边 Todo/文件', async () => {
    const session = structured();
    session.messages.push(text('question', 'user', 'HTTP 是什么？', 3), { id: 'update', role: 'assistant', timestamp: 4, blocks: [tool('up1', 'TaskUpdate', { taskId: '1', status: 'completed' }), tool('stray', 'TodoWrite', { todos: [{ content: '解释协议', status: 'completed' }, { content: '举例', status: 'completed' }] }), tool('strayfile', 'Write', { file_path: '/work/stray.js' })] });
    session.messages.push(text('new', 'user', '请构建一个库存管理系统', 5), { id: 'newtools', role: 'assistant', timestamp: 6, blocks: [tool('newtodo', 'TodoWrite', { todos: [{ content: '库存', status: 'pending' }, { content: '盘点', status: 'pending' }] }), tool('up2', 'TaskUpdate', { taskId: '2', status: 'completed' })] });
    const candidates = (await backend.scan(data([session]))).candidates;
    expect(candidates).toHaveLength(2);
    const original = candidates.find(c => c.goal === goal);
    expect(original.tasks.map(t => t.status)).toEqual(['completed', 'completed']);
    expect(original.tasks.map(t => t.name)).toEqual(['列表', '详情']);
    expect(original.files).toEqual([]);
    expect(original.uncertainties.join(' ')).toMatch(/关联 unknown/);
    expect(candidates.find(c => c.goal !== goal).tasks.map(t => t.name)).toEqual(['库存', '盘点']);
  });
  it('CLI 已知 TaskUpdate 在短问答后凭成功结果追踪原目标', async () => {
    await cli('trace', [row('user', goal, 'u'), row('assistant', [use('c1', 'TaskCreate', { subject: '列表' }), use('c2', 'TaskCreate', { subject: '详情' })], 'a'), row('user', [result('c1', { id: '1' }), result('c2', { id: '2' })], 'r'), row('user', 'HTTP 是什么？', 'q'), row('assistant', [use('up', 'TaskUpdate', { taskId: '1', status: 'completed' })], 'up'), row('user', [result('up')], 'upr')]);
    const p = (await backend.scan(data([]))).candidates[0];
    expect(p.tasks[0].status).toBe('completed');
    expect(p.tasks[1].status).toBe('pending');
  });
  it('legacy 未编辑任务同步 status/name/description/IO/依赖，新增任务保留 forward 依赖', async () => {
    const project = await save(structured());
    expect(project.tasks[0].editedFields).toBeUndefined();
    const session = structured([
      tool('up1', 'TaskUpdate', { taskId: '1', subject: '客户列表', description: '新版说明', status: 'in_progress' }),
      tool('read', 'Read', { file_path: '/work/input.json' }), tool('write', 'Write', { file_path: '/work/list.js' }),
      tool('dep', 'TaskUpdate', { taskId: '2', addBlockedBy: ['3'] }),
      tool('create3', 'TaskCreate', { subject: '数据服务' }, { id: '3' }),
      tool('done', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    ]);
    const updated = await associate(session, project);
    expect(updated.tasks[0]).toMatchObject({ id: project.tasks[0].id, name: '客户列表', description: '新版说明', status: 'completed', inputs: ['/work/input.json'], outputs: ['/work/list.js'] });
    expect(updated.tasks).toHaveLength(3);
    expect(updated.tasks[1].dependsOn).toEqual([updated.tasks[2].id]);
    expect(updated.tasks[1].dependencyNote).toMatch(/成功 TaskUpdate/);
    expect(updated.tasks[2].editedFields).toEqual([]);
  });
  it('只标记用户实际变化的字段，incoming 无法清除或伪造 editedFields，重启保留', async () => {
    const project = await confirmed();
    project.tasks[0].editedFields = ['status'];
    await backend.update(project);
    let latest = (await backend.list())[0];
    expect(latest.tasks[0].editedFields).toEqual([]);
    latest.tasks[0].name = '用户列表'; latest.tasks[0].status = 'completed';
    await backend.update(latest);
    latest = (await backend.list())[0];
    expect(new Set(latest.tasks[0].editedFields)).toEqual(new Set(['name', 'status']));
    latest.tasks[0].editedFields = []; delete latest.tasks[1].editedFields;
    await backend.update(latest);
    const restarted = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {} });
    expect(new Set((await restarted.list())[0].tasks[0].editedFields)).toEqual(new Set(['name', 'status']));
    const updated = await associate(gui(), latest);
    expect(updated.tasks[0].name).toBe('用户列表'); expect(updated.tasks[0].status).toBe('completed');
    expect(updated.uncertainties.join(' ')).toMatch(/用户编辑.*冲突 unknown/);
  });
  it('所有用户可编辑字段均受保护，未修改的另一个任务仍同步', async () => {
    const project = await save(structured());
    Object.assign(project.tasks[1], { name: '用户详情', description: '用户说明', status: 'completed', inputs: ['用户输入'], outputs: ['用户输出'], dependsOn: [project.tasks[0].id], dependencyNote: '用户依赖' });
    await backend.update(project);
    const updated = await associate(structured([tool('up', 'TaskUpdate', { taskId: '1', status: 'completed' })]), project);
    expect(updated.tasks[0].status).toBe('completed');
    for (const field of ['name', 'description', 'status', 'inputs', 'outputs', 'dependsOn', 'dependencyNote']) expect(updated.tasks[1][field]).toEqual(project.tasks[1][field]);
    expect(updated.tasks[1].editedFields).toHaveLength(7);
  });
  it('用户依赖与新扫描依赖成环时保留用户图且显式 unknown', async () => {
    const project = await save(structured());
    project.tasks[0].dependsOn = [project.tasks[1].id]; await backend.update(project);
    const updated = await associate(structured([tool('dep', 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'] })]), project);
    expect(updated.tasks[0].dependsOn).toEqual([project.tasks[1].id]);
    expect(updated.tasks[1].dependsOn).toEqual([]);
    expect(updated.tasks[1].dependencyNote).toMatch(/循环冲突 unknown/);
    expect(updated.uncertainties.join(' ')).toMatch(/循环冲突 unknown/);
  });
  it('扫描后删除的依赖任务不复活，无法映射依赖标 unknown', async () => {
    const project = await save(structured());
    const scan = await backend.scan(data([structured([tool('dep', 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'] })])]));
    project.tasks.shift(); await backend.update(project);
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { existingProjectId: project.id })]);
    const updated = (await backend.list())[0];
    expect(updated.tasks).toHaveLength(1); expect(updated.tasks[0].dependsOn).toEqual([]);
    expect(updated.uncertainties.join(' ')).toMatch(/已删除.*unknown/);
  });
  it('扫描状态回退使 goalConfirmed 失效，不能自动再次确认完成', async () => {
    const session = gui(); session.messages[1].blocks = [tool('todo1', 'TodoWrite', { todos: todos('completed') })];
    const project = await save(session); project.goalConfirmed = true; await backend.update(project);
    expect((await backend.list())[0].tasks.every(t => t.editedFields.length === 0)).toBe(true);
    const updated = await associate(gui(), project);
    expect(updated.goalConfirmed).toBe(false); expect(updated.tasks.every(t => t.status === 'pending')).toBe(true);
  });
  it('同批审核改成同目标原子拒绝，即使 allowDuplicate 也不 silent 合并', async () => {
    const scan = await backend.scan(data([gui(), gui('other', '开发库存管理系统')]));
    const reviews = scan.candidates.map(c => review(c, { goal, allowDuplicate: true }));
    await expect(backend.confirm(scan.scanId, reviews)).rejects.toThrow(/同批次目标重复.*改名.*取消.*关联/);
    expect(await backend.list()).toEqual([]); expect(fs.existsSync(backend.filePath)).toBe(false);
    await backend.confirm(scan.scanId, [reviews[0]]); expect(await backend.list()).toHaveLength(1);
  });
  it('已有 exact 默认拒绝无关联重复，显式 independent 可创建并导致多个匹配不自动选择', async () => {
    const project = await confirmed(); const scan = await backend.scan(data());
    await expect(backend.confirm(scan.scanId, [review(scan.candidates[0])])).rejects.toThrow(/existingProjectId.*allowDuplicate/);
    expect(await backend.list()).toHaveLength(1);
    await backend.confirm(scan.scanId, [review(scan.candidates[0], { allowDuplicate: true })]);
    await backend.confirm(scan.scanId, [review(scan.candidates[0])]); expect(await backend.list()).toHaveLength(2);
    const later = await backend.scan(data()); expect(later.candidates[0].existingProjectId).toBeUndefined();
    expect(later.candidates[0].uncertainties.join(' ')).toMatch(/多个已有项目/);
    await backend.confirm(later.scanId, [review(later.candidates[0], { existingProjectId: project.id })]);
    expect(await backend.list()).toHaveLength(2);
  });
  it('同批不同候选可显式关联同一已有项目，无重复创建', async () => {
    const project = await confirmed(); const scan = await backend.scan(data([gui(), gui('other', '开发库存管理系统')]));
    await backend.confirm(scan.scanId, scan.candidates.map(c => review(c, { goal, existingProjectId: project.id })));
    expect(await backend.list()).toHaveLength(1);
  });
  it.each(['现有网站添加搜索功能', '为已有应用增加导出功能', '为现有系统修改搜索模块', '为现有客户管理系统添加搜索功能'])('过滤局部增改的小项目：%s', async target => {
    expect((await backend.scan(data([gui('mini', target)]))).candidates).toEqual([]);
  });
  it('局部增改至少四项任务可保留，完整管理中心两项也不误杀', async () => {
    const mini = gui('mini', '为现有网站添加搜索功能'); mini.messages[1].blocks = [tool('todo1', 'TodoWrite', { todos: [...todos(), { content: '搜索索引', status: 'pending' }, { content: '验证部署', status: 'pending' }] })];
    expect((await backend.scan(data([mini, gui('center', '为现有应用开发完整客户管理中心')]))).candidates).toHaveLength(2);
  });
  it('非结构化任务名称映射改过的 id，新增结构化任务的依赖保留映射结果', async () => {
    const project = await confirmed();
    const oldId = project.tasks[0].id; project.tasks[0].id = 'user-list-id'; await backend.update(project);
    const session = gui();
    session.messages[1].blocks.push(tool('create1', 'TaskCreate', { subject: 'API' }, { id: '1' }), tool('create2', 'TaskCreate', { subject: '联调' }, { id: '2' }), tool('dep', 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'] }));
    const updated = await associate(session, project);
    expect(updated.tasks).toHaveLength(4);
    expect(updated.tasks.some(t => t.id === oldId)).toBe(false);
    expect(updated.tasks[0].id).toBe('user-list-id');
    const api = updated.tasks.find(t => t.name === 'API'), integration = updated.tasks.find(t => t.name === '联调');
    expect(integration.dependsOn).toEqual([api.id]);
  });
  it('整图替换旧扫描依赖允许反转方向，不因临时循环误拒绝', async () => {
    const project = await save(structured([tool('olddep', 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'] })]));
    const updated = await associate(structured([tool('newdep', 'TaskUpdate', { taskId: '1', addBlockedBy: ['2'] })]), project);
    expect(updated.tasks[0].dependsOn).toEqual([updated.tasks[1].id]); expect(updated.tasks[1].dependsOn).toEqual([]);
    expect(updated.uncertainties.join(' ')).not.toMatch(/循环冲突/);
  });
  it('legacy identity 未带 scope 仍按同目录目标匹配，混合目录证据不强关联', async () => {
    const project = await confirmed();
    const legacy = structuredClone(project); legacy.identityKey = 'goal:legacy';
    await fs.promises.writeFile(backend.filePath, JSON.stringify({ version: 1, projects: [legacy] }));
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {} });
    expect((await backend.scan(data())).candidates[0].existingProjectId).toBe(project.id);
    const mixed = (await backend.list())[0]; mixed.sources.push({ ...mixed.sources[0], id: 'cross-directory', cwd: '/other' });
    await backend.update(mixed);
    expect((await backend.scan(data())).candidates[0].existingProjectId).toBeUndefined();
  });
  it('editedFields 与 allowDuplicate 严格校验，用户新建任务字段全部受保护', async () => {
    const project = await confirmed();
    for (const editedFields of [['unknown'], ['status', 'status'], 'status']) {
      const invalid = structuredClone(project); invalid.tasks[0].editedFields = editedFields;
      await expect(backend.update(invalid)).rejects.toThrow(/editedFields/);
    }
    project.tasks.push({ ...structuredClone(project.tasks[0]), id: 'user-created', name: '用户待办', editedFields: [] }); await backend.update(project);
    expect((await backend.list())[0].tasks[2].editedFields).toHaveLength(7);
    const scan = await backend.scan(data());
    await expect(backend.confirm(scan.scanId, [review(scan.candidates[0], { allowDuplicate: 'true' })])).rejects.toThrow(/allowDuplicate/);
  });
  it('同批跨目录审核成相同目标可各自创建', async () => {
    const scan = await backend.scan(data([{ ...gui(), cwd: '/a' }, { ...gui('other', '开发库存管理系统'), cwd: '/b' }]));
    await backend.confirm(scan.scanId, scan.candidates.map(c => review(c, { goal })));
    expect(await backend.list()).toHaveLength(2);
    expect(new Set((await backend.list()).map(p => p.identityKey)).size).toBe(2);
  });
  it('初次权限/损坏加载失败在同实例可重试，恢复前不允许覆盖', async () => {
    vi.spyOn(fs.promises, 'lstat').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(backend.list()).rejects.toThrow(/EACCES/); expect(await backend.list()).toEqual([]);
    const project = await confirmed(); const raw = await fs.promises.readFile(backend.filePath, 'utf8');
    const broken = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {} });
    await fs.promises.writeFile(backend.filePath, '{broken');
    await expect(broken.list()).rejects.toThrow(/禁止覆盖/); await expect(broken.update(project)).rejects.toThrow(/禁止覆盖/);
    expect(await fs.promises.readFile(backend.filePath, 'utf8')).toBe('{broken');
    await fs.promises.writeFile(backend.filePath, raw);
    expect(await broken.list()).toEqual([project]); await broken.update({ ...project, name: '恢复后' });
    expect((await broken.list())[0].name).toBe('恢复后');
  });
  it('CLI 限额按目录及文件名稳定选择，非创建顺序；GUI 限额按最近会话', async () => {
    const rows = target => [row('user', target, 'u'), row('assistant', [use('todo1', 'TodoWrite', { todos: todos() })], 'a'), row('user', [result('todo1')], 'r')];
    await cli('z-last', rows('开发库存管理系统')); await cli('a-first', rows(goal));
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, limits: { maxFiles: 1 } });
    const first = await backend.scan(data([])), second = await backend.scan(data([]));
    expect(first.candidates[0].goal).toBe(goal); expect(second.candidates[0].identityKey).toBe(first.candidates[0].identityKey);
    expect(first.coverage.warnings.join(' ')).toMatch(/文件或消息数量达到上限/);
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, limits: { maxGuiSessions: 1 } });
    const older = gui('old'), newer = gui('new', '开发最新财务管理中心'); newer.updatedAt = 100;
    expect((await backend.scan(data([older, newer]))).candidates.some(c => c.goal === newer.title)).toBe(true);
  });
});

describe('ProjectsBackend 严格校验', () => {
  it('拒绝非法状态、引用、自环、循环及伪造项目状态', async () => {
    const project = await confirmed();
    for (const mutate of [
      p => { p.tasks[0].status = 'done'; },
      p => { p.tasks[0].dependsOn = ['missing']; },
      p => { p.tasks[0].dependsOn = [p.tasks[0].id]; },
      p => { p.tasks[0].dependsOn = [p.tasks[1].id]; p.tasks[1].dependsOn = [p.tasks[0].id]; },
      p => { p.status = 'completed'; },
      p => { p.tasks[0].sourceIds = ['missing']; },
      p => { p.goalConfirmed = true; },
      p => { p.tasks[1].id = p.tasks[0].id; },
      p => { p.tasks[0].inputs = [42]; },
      p => { p.files = [{ path: 'relative.txt', purpose: '', sourceId: p.sources[0].id }]; },
      p => { p.goalConfirmed = 'true'; },
    ]) {
      const invalid = structuredClone(project); mutate(invalid);
      await expect(backend.update(invalid)).rejects.toThrow();
      expect(await backend.list()).toEqual([project]);
    }
    project.tasks.forEach(t => { t.status = 'completed'; });
    project.goalConfirmed = true;
    await backend.update(project);
    const saved = (await backend.list())[0];
    expect(saved.goalConfirmed).toBe(true);
    saved.tasks[0].status = 'pending';
    await expect(backend.update(saved)).rejects.toThrow(/goalConfirmed/);
  });
  it('确认批次校验失败不会部分写入，也不允许直接更新未确认候选', async () => {
    const scan = await backend.scan(data([gui(), gui('s2', '请构建一个库存管理系统')]));
    await expect(backend.update(scan.candidates[0])).rejects.toThrow();
    await expect(backend.confirm(scan.scanId, [review(scan.candidates[0]), review(scan.candidates[1], { existingProjectId: 'missing' })])).rejects.toThrow();
    expect(await backend.list()).toEqual([]);
  });
  it('reveal 仅定位绝对路径常规文件，拒绝目录/链接/不存在/相对路径', async () => {
    const show = vi.fn();
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, revealFile: show });
    const file = path.join(dir, 'output.txt'); await fs.promises.writeFile(file, 'hello');
    const link = path.join(dir, 'link'); await fs.promises.symlink(file, link);
    for (const value of ['output.txt', dir, link, path.join(dir, 'missing'), null]) expect((await backend.reveal(value)).ok).toBe(false);
    expect(await backend.reveal(file)).toEqual({ ok: true });
    expect(show).toHaveBeenCalledExactlyOnceWith(file);
  });
});

describe('Projects IPC 接入', () => {
  it.each([false, true])('preload 接入一致且打包模式 %s 仅使用内置页面', async (isPackaged) => {
    const mainPath = path.resolve('src/main/main.js');
    const handlers = new Map();
    const methods = Object.fromEntries(['list', 'prepare', 'scan', 'cancelScan', 'confirm', 'update', 'reveal'].map(method => [method, vi.fn().mockResolvedValue(method)]));
    let options;
    let ready;
    const app = { isPackaged, getPath: key => key === 'home' ? dir : path.join(dir, 'userdata'), requestSingleInstanceLock: () => true, whenReady: () => ({ then: callback => { ready = callback; } }), on: vi.fn() };
    const loadURL = vi.fn(), loadFile = vi.fn();
    class WindowMock {
      constructor() { this.webContents = { setWindowOpenHandler() {}, on() {}, openDevTools() {} }; }
      on() {}
      loadURL(url) { loadURL(url); }
      loadFile(file) { loadFile(file); }
      static getAllWindows() { return []; }
    }
    const electron = { app, BrowserWindow: WindowMock, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: vi.fn() }, shell: { showItemInFolder: vi.fn() }, Menu: { buildFromTemplate: () => [], setApplicationMenu: vi.fn() } };
    const nativeRequire = createRequire(mainPath);
    class BackendMock { constructor(value) { options = value; Object.assign(this, methods); } }
    const mainSource = await fs.promises.readFile(mainPath, 'utf8');
    const http = { get: vi.fn((_url, callback) => { callback(); return { on() {}, setTimeout() {} }; }) };
    vm.runInNewContext(mainSource, {
      require: name => name === 'electron' ? electron : name === './projects' ? { ProjectsBackend: BackendMock } : name === './store' ? { Store: class {} } : name === 'http' ? http : ['runner', 'git', 'images'].some(module => name === `./${module}`) ? {} : nativeRequire(name),
      __dirname: path.dirname(mainPath), process: { env: {}, platform: 'test' }, Buffer,
    });
    await expect(handlers.get('projects:list')({})).rejects.toThrow(/未初始化/);
    ready();
    await new Promise(resolve => setImmediate(resolve));
    if (isPackaged) {
      expect(http.get).not.toHaveBeenCalled();
      expect(loadURL).not.toHaveBeenCalled();
      expect(loadFile).toHaveBeenCalledExactlyOnceWith(path.resolve('dist-renderer/index.html'));
    } else {
      expect(http.get).toHaveBeenCalledTimes(1);
      expect(loadURL).toHaveBeenCalledExactlyOnceWith('http://localhost:5170');
      expect(loadFile).not.toHaveBeenCalled();
    }
    expect(options.home).toBe(dir);
    expect(options.userData).toBe(path.join(dir, 'userdata'));
    options.revealFile('/work/file');
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith('/work/file');
    let api;
    const invoke = vi.fn((channel, ...args) => handlers.get(channel)({}, ...args));
    const preloadPath = path.resolve('src/main/preload.js');
    vm.runInNewContext(await fs.promises.readFile(preloadPath, 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke } }),
    });
    expect(await api.projects.list()).toBe('list');
    expect(await api.projects.prepare(data())).toBe('prepare');
    expect(await api.projects.cancelScan('request-id')).toBe('cancelScan');
    expect(await api.projects.scan(data())).toBe('scan');
    expect(await api.projects.confirm('scan-id', [])).toBe('confirm');
    expect(await api.projects.update({ id: 'p' })).toBe('update');
    expect(await api.projects.reveal('/work/file')).toBe('reveal');
    expect(methods.confirm).toHaveBeenCalledExactlyOnceWith('scan-id', []);
    expect(methods.scan).toHaveBeenCalledExactlyOnceWith(data(), expect.any(Function));
    expect(methods.prepare).toHaveBeenCalledExactlyOnceWith(data());
    expect(methods.cancelScan).toHaveBeenCalledExactlyOnceWith('request-id');
  });
});

describe('ProjectsBackend 保守扫描', () => {
  it('过滤短问答、临时小任务；同 cwd 不同目标独立，相同目标多会话去重', async () => {
    const scan = await backend.scan(data([
      gui(), gui('s2'), gui('s3', '请构建一个库存管理系统'),
      gui('s4', '解释一下什么是 HTTP'), gui('s5', '临时帮我改一个按钮颜色'),
      { ...gui('s6', '请开发一个系统'), messages: [text('u', 'user', '请开发一个系统')] },
    ]));
    expect(scan.candidates).toHaveLength(2);
    expect(scan.candidates.find(c => c.goal === goal).sources.map(s => s.sessionId)).toContain('s2');
    expect(scan.candidates.every(c => !c.goalConfirmed && !('status' in c))).toBe(true);
  });
  it('GUI 归档、活跃及相同 CLI session 合并，忽略系统/子代理并返回坏行反馈', async () => {
    const file = await cli('s1', [
      row('user', goal, 'u1'), '{bad',
      row('assistant', [use('todo1', 'TodoWrite', { todos: todos() })], 'a1'),
      row('user', [result('todo1')], 'r1'),
      { ...row('user', '请构建一个子代理系统\n1. 做甲\n2. 做乙', 'sub'), parent_tool_use_id: 'parent' },
      { ...row('user', '请构建一个侧链系统\n1. 做甲\n2. 做乙', 'side'), isSidechain: true },
      { type: 'system', message: { content: '请开发一个假系统\n1. 甲\n2. 乙' } },
    ]);
    const sub = path.join(path.dirname(file), 'subagents'); await fs.promises.mkdir(sub);
    await fs.promises.writeFile(path.join(sub, 'child.jsonl'), JSON.stringify(row('user', goal, 'sub')));
    const archived = gui();
    const active = { ...gui(), id: 'tab1', streamingMessage: text('live', 'assistant', '我完成了任务', 3), messages: [...gui().messages, text('follow', 'user', '请继续', 4)] };
    const scan = await backend.scan(data([archived], [active]));
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].tasks).toHaveLength(2);
    expect(scan.candidates[0].sources.some(s => s.messageId === 'live')).toBe(true);
    expect(scan.candidates[0].sources.some(s => s.path === file)).toBe(true);
    expect(scan.coverage.claudeSessions).toBe(1);
    expect(scan.coverage.warnings.join(' ')).toMatch(/坏行/);
    expect(scan.candidates[0].tasks.every(t => t.status === 'pending')).toBe(true);
  });
  it('编号步骤可作为计划，不捏造状态/背景/依赖/IO', async () => {
    const scan = await backend.scan(data([{ sessionId: 'steps', cwd: '/work', title: 'x', messages: [text('u', 'user', '请构建一个财务管理应用\n1. 实现账单列表\n2. 实现报表导出'), text('a', 'assistant', '全部完成了')] }]));
    const p = scan.candidates[0];
    expect(p.tasks).toHaveLength(2);
    expect(p.background).toBe('');
    expect(p.tasks.every(t => t.status === 'pending' && !t.inputs.length && !t.outputs.length && !t.dependsOn.length)).toBe(true);
    expect(p.goalConfirmed).toBe(false);
    expect(p.uncertainties.length).toBeGreaterThan(0);
  });
  it('工具成功结果才是执行证据，失败和计划文件不当作产物', async () => {
    const extra = [tool('read', 'Read', { file_path: '/work/input.csv' }), tool('write', 'Write', { file_path: '/work/app.js' }), tool('plan', 'Write', { file_path: '/work/plan.md' }), tool('fail', 'Write', { file_path: '/work/fail.js' }, 'denied', 'error')];
    const scan = await backend.scan(data([gui('s1', goal, extra)]));
    const p = scan.candidates[0];
    expect(p.files.map(f => f.path)).toEqual(expect.arrayContaining(['/work/input.csv', '/work/app.js', '/work/plan.md']));
    expect(p.files.some(f => f.path.includes('fail'))).toBe(false);
    expect(p.tasks.flatMap(t => t.outputs)).not.toContain('/work/plan.md');
    expect(p.deliverables).toBe('');
    expect(p.tasks.flatMap(t => t.records).join(' ')).toMatch(/Write/);
  });
  it('可靠 TaskCreate/TaskUpdate 通过成功结果解析 id/状态/依赖', async () => {
    await cli('tasks', [row('user', goal, 'u'), row('assistant', [use('c1', 'TaskCreate', { subject: '实现列表', description: '列表视图' })], 'a'), row('user', [result('c1', 'Task #1 created successfully: 实现列表')], 'r'), row('assistant', [use('c2', 'TaskCreate', { subject: '实现详情' })], 'b'), row('user', [result('c2', { task: { id: '2' } })], 'r2'), row('assistant', [use('up', 'TaskUpdate', { taskId: '2', status: 'in_progress', addBlockedBy: ['1'] })], 'c'), row('user', [result('up')], 'r3')]);
    const p = (await backend.scan(data([]))).candidates[0];
    expect(p.tasks).toHaveLength(2);
    expect(p.tasks[1].status).toBe('in_progress');
    expect(p.tasks[1].dependsOn).toEqual([p.tasks[0].id]);
  });
  it('过滤只有零散词汇、泛化目标、微小修改及与原项目无关的后续任务', async () => {
    const session = gui();
    session.messages.push(text('small', 'user', '临时帮我改一个按钮颜色', 3));
    session.messages.push({ id: 'smallPlan', role: 'assistant', timestamp: 4, blocks: [tool('smallTodo', 'TodoWrite', { todos: [{ content: '按钮变红', status: 'completed' }, { content: '截图', status: 'completed' }] })] });
    const scan = await backend.scan(data([
      session, gui('explain', 'Java 应用开发有什么优点？'), gui('generic', '请开发一个系统'), gui('tiny', '请实现修改按钮颜色'),
      gui('generic2', '请直接开发后端并测试'), gui('negated', '不要开发一个客户管理系统'),
    ]));
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].tasks.map(t => t.name)).toEqual(['实现客户列表', '实现客户详情']);
  });
  it('明确目标的礼貌前缀去重、代码块不构造任务、有意义标点不错误合并', async () => {
    const code = { sessionId: 'code', cwd: '/work', title: 'x', messages: [text('u', 'user', '请构建一个财务管理应用\n```text\n1. 伪造甲\n2. 伪造乙\n```')] };
    const scan = await backend.scan(data([gui(), gui('p2', '请直接开发一个客户管理系统'), gui('cpp', '请开发一个 C++ 客户管理系统'), gui('c', '请开发一个 C 客户管理系统'), code]));
    expect(scan.candidates).toHaveLength(3);
    const p = scan.candidates.find(c => c.goal === goal);
    expect(new Set(p.sources.map(s => s.sessionId))).toEqual(new Set(['s1', 'p2']));
  });
  it('CLI 每行时序与 GUI 聚合时间不同也不重复归属目标或错误回退状态', async () => {
    const secondGoal = '请构建一个库存管理系统';
    const inventory = [{ content: '库存列表', status: 'pending' }, { content: '库存盘点', status: 'pending' }];
    const session = gui();
    session.messages[1].blocks.push(tool('done', 'TodoWrite', { todos: todos('completed') }));
    session.messages.push(text('u2', 'user', secondGoal, 3), { id: 'a2', role: 'assistant', timestamp: 4, blocks: [tool('inv', 'TodoWrite', { todos: inventory })] });
    await cli('mixed', [row('user', goal, 'cu1'), row('assistant', [use('todo1', 'TodoWrite', { todos: todos() })], 'ca1'), row('user', [result('todo1')], 'r1'), row('assistant', [use('done', 'TodoWrite', { todos: todos('completed') })], 'ca2'), row('user', [result('done')], 'r2'), row('user', secondGoal, 'cu2'), row('assistant', [use('inv', 'TodoWrite', { todos: inventory })], 'ca3'), row('user', [result('inv')], 'r3')]);
    const scan = await backend.scan(data([session]));
    expect(scan.candidates).toHaveLength(2);
    const p = scan.candidates.find(c => c.goal === goal);
    expect(p.tasks.every(t => t.status === 'completed')).toBe(true);
    expect(p.tasks).toHaveLength(2);
    expect(scan.candidates.find(c => c.goal === secondGoal).tasks.map(t => t.name)).toEqual(['库存列表', '库存盘点']);
  });
  it('CLI 失败结果覆盖 GUI done，未成功工具不能构造项目', async () => {
    await cli('failed', [row('user', goal, 'u'), row('assistant', [use('todo1', 'TodoWrite', { todos: todos() })], 'a'), row('user', [result('todo1', 'denied', true)], 'r')]);
    const scan = await backend.scan(data());
    expect(scan.candidates).toEqual([]);
  });
  it('同名 TaskCreate 使用真实 id，循环依赖只排除坏边并保留不确定性', async () => {
    await cli('sameName', [row('user', goal, 'u'), row('assistant', [use('c1', 'TaskCreate', { subject: '测试' }), use('c2', 'TaskCreate', { subject: '测试' })], 'a'), row('user', [result('c1', 'Task #1 created successfully: 测试'), result('c2', 'Task #2 created successfully: 测试')], 'r'), row('assistant', [use('up1', 'TaskUpdate', { taskId: '1', status: 'completed', addBlockedBy: ['2'] }), use('up2', 'TaskUpdate', { taskId: '2', status: 'in_progress', addBlockedBy: ['1'] })], 'b'), row('user', [result('up1'), result('up2')], 'r2')]);
    const p = (await backend.scan(data([]))).candidates[0];
    expect(p.tasks).toHaveLength(2);
    expect(p.tasks[0].id).not.toBe(p.tasks[1].id);
    expect(p.tasks.map(t => t.status)).toEqual(['completed', 'in_progress']);
    expect(p.uncertainties.join(' ')).toMatch(/循环/);
    await backend.confirm((await backend.scan(data([]))).scanId, []);
  });
  it('候选/目标消息/扫描字节数限制明确反馈，截断状态不作为完成', async () => {
    const session = gui();
    session.messages[1].blocks = [tool('todo1', 'TodoWrite', { todos: todos('completed') })];
    session.messages.push(text('tail', 'assistant', '继续处理', 3));
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, limits: { maxCandidates: 1, maxCandidateMessages: 2 } });
    const limited = await backend.scan(data([session, gui('other', '请构建一个库存管理系统')]));
    expect(limited.candidates).toHaveLength(1);
    expect(limited.candidates[0].tasks.every(t => t.status === 'pending')).toBe(true);
    expect(limited.coverage.warnings.join(' ')).toMatch(/目标消息数量达到上限/);
    expect(limited.coverage.warnings.join(' ')).toMatch(/候选数量达到上限/);
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: {}, limits: { maxScanBytes: 10 } });
    const bytes = await backend.scan(data());
    expect(bytes.candidates).toEqual([]);
    expect(bytes.coverage.warnings.join(' ')).toMatch(/总读取量达到上限/);
  });
  it('配置目录范围、超大文件、权限反馈和 scan 并发拒绝', async () => {
    const config = path.join(dir, 'custom');
    const root = path.join(config, 'projects', 'work'); await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'large.jsonl'), 'x'.repeat(200));
    backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userdata'), env: { CLAUDE_CONFIG_DIR: config }, limits: { maxFileBytes: 100 } });
    const pending = backend.scan(data([]));
    await expect(backend.scan(data([]))).rejects.toThrow(/busy|扫描中/);
    const scan = await pending;
    expect(scan.coverage.roots).toEqual([path.join(config, 'projects')]);
    expect(scan.coverage.skipped).toBe(1);
    expect(scan.coverage.warnings.join(' ')).toMatch(/过大|大小/);
    vi.spyOn(fs.promises, 'opendir').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const denied = await backend.scan(data([]));
    expect(denied.coverage.warnings.join(' ')).toMatch(/EACCES/);
  });
});
