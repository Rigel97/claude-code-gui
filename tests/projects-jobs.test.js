import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { ProjectsBackend } from '../src/main/projects.js';

let dir, backend;
const goal = '请开发一个客户管理系统';
const history = () => ({ sessions: [{ sessionId: 's', cwd: '/work', title: goal, messages: [
  { id: 'u', role: 'user', timestamp: 1, blocks: [{ kind: 'text', text: `${goal}\n背景：旧背景` }] },
  { id: 'a', role: 'assistant', timestamp: 2, blocks: [{ kind: 'tool_use', toolId: 'todo', toolName: 'TodoWrite', status: 'done', result: '成功', input: { todos: [{ content: '实现客户列表', status: 'pending' }, { content: '实现客户详情', status: 'pending' }] } }] },
] }], conversations: [] });
const options = () => ({ home: dir, userData: path.join(dir, 'data'), env: {} });
const make = () => new ProjectsBackend(options());
const review = candidate => ({ candidateId: candidate.id, name: candidate.name, goal: candidate.goal, description: candidate.description });
async function injected(llm) {
  const file = path.resolve('src/main/projects.js'), require = createRequire(file), module = { exports: {} };
  const source = await fs.promises.readFile(file, 'utf8');
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { structuredClone, AbortController, Buffer, process, console })(
    name => name === './projects-llm' ? llm : require(name), module, module.exports);
  return new module.exports.ProjectsBackend(options());
}
beforeEach(async () => { dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'projects-jobs-')); backend = make(); });
afterEach(async () => { vi.restoreAllMocks(); await fs.promises.rm(dir, { recursive: true, force: true }); });

describe('后台作业生命周期', () => {
  it('任何 await 前注册 prepare；signal/progress 转发，重载回调失败不中断，终态只暴露计划', async () => {
    let resolve, captured;
    backend = await injected({ prepareAnalysis: async (...args) => {
      captured = args; args[5]({ phase: 'finished', accepted: 1 });
      return await new Promise(done => { resolve = done; });
    } });
    const pending = backend.prepare({ ...history(), requestId: 'prepare-1' }, () => { throw new Error('renderer gone'); });
    expect(backend.activeJob()).toEqual({ requestId: 'prepare-1', operation: 'prepare', state: 'running' });
    await expect(backend.scan(history())).rejects.toThrow(/busy/);
    await vi.waitFor(() => expect(captured).toBeDefined());
    expect(captured[4]).toBeInstanceOf(AbortSignal); expect(captured[4].aborted).toBe(false);
    resolve({ payload: { private: 'history' }, plan: { sources: 1 } });
    const plan = await pending;
    expect(backend.activeJob()).toMatchObject({ state: 'completed', operation: 'prepare', plan, progress: { phase: 'finished', accepted: 1 } });
    expect(JSON.stringify(backend.activeJob())).not.toMatch(/private|payload|controller|report/);
    const copy = backend.activeJob(); copy.plan.sources = 99; expect(backend.activeJob().plan.sources).toBe(1);
    expect(backend.discardPlan('other')).toBe(false); expect(backend.activeJob()).not.toBeNull();
    expect(backend.discardPlan(plan.planId)).toBe(true); expect(backend.activeJob()).toBeNull();
    expect(backend.plans.size).toBe(0); expect(backend.discardPlan(plan.planId)).toBe(false);
    await expect(backend.scan({ ...history(), mode: 'llm', planId: plan.planId, consent: true, maxBudgetUsd: 1, requestId: 'discarded' })).rejects.toThrow(/计划不存在/);
  });
  it('大体量读取的进度按阶段合流，保留首末与单调性而不淹没 IPC', async () => {
    backend = await injected({ prepareAnalysis: async (...args) => {
      for (let i = 0; i < 500; i++) args[5]({ phase: 'reading', completed: i, total: 500 });
      args[5]({ phase: 'finished', completed: 500, total: 500 });
      return { payload: {}, plan: { sources: 1 } };
    } });
    const seen = [];
    await backend.prepare({ ...history(), requestId: 'coalesce' }, progress => seen.push(progress));
    expect(seen.length).toBeLessThan(10);
    expect(seen[0]).toMatchObject({ phase: 'reading', requestId: 'coalesce' });
    expect(seen.at(-1)).toMatchObject({ phase: 'finished', completed: 500, total: 500 });
    expect(seen.map(item => item.completed)).toEqual(seen.map(item => item.completed).sort((a, b) => a - b));
  });
  it('prepare 取消不存计划；失败保存 error，下一作业替换旧终态', async () => {
    let resolve;
    backend = await injected({ prepareAnalysis: async () => await new Promise(done => { resolve = done; }) });
    const pending = backend.prepare({ ...history(), requestId: 'cancel' });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    expect(backend.cancelScan('wrong')).toBe(false); expect(backend.cancelScan('cancel')).toBe(true);
    resolve({ payload: {}, plan: {} });
    await expect(pending).rejects.toThrow(/取消/);
    expect(backend.activeJob()).toMatchObject({ requestId: 'cancel', state: 'cancelled' }); expect(backend.plans.size).toBe(0);
    await expect(backend.scan({ ...history(), requestId: 'fail', mode: 'bad' })).rejects.toThrow(/模式/);
    expect(backend.activeJob()).toMatchObject({ requestId: 'fail', state: 'failed', error: expect.stringMatching(/模式/) });
    const result = await backend.scan({ ...history(), requestId: 'success' }, () => Promise.reject(new Error('gone')));
    expect(backend.activeJob()).toMatchObject({ requestId: 'success', state: 'completed', result });
    expect(backend.cancelScan('success')).toBe(false);
  });
  it('规则 scan 可即时取消且不留下候选，busy 重载拒绝，成功终态可确认后清理', async () => {
    const pending = backend.scan({ ...history(), requestId: 'rules-cancel' });
    await expect(backend.reload()).rejects.toThrow(/busy/);
    expect(backend.cancelScan('rules-cancel')).toBe(true); await expect(pending).rejects.toThrow(/取消|aborted/i);
    expect(backend.activeJob().state).toBe('cancelled'); expect(backend.scans.size).toBe(0);
    const result = await backend.scan({ ...history(), requestId: 'rules-ok' });
    expect(backend.activeJob()).toMatchObject({ state: 'completed', result });
    await backend.confirm(result.scanId, [review(result.candidates[0])]); expect(backend.activeJob()).toBeNull();
  });
});

describe('可信审核草稿', () => {
  it('只信 scanId；篡改 IPC candidate 不落盘；重启恢复并无需再识别即可确认', async () => {
    const scan = await backend.scan(history()), candidate = scan.candidates[0];
    const draft = { scanResult: { ...scan, candidates: [{ ...candidate, goal: '伪造' }] }, reviews: { [candidate.id]: { ...review(candidate), selected: true } } };
    const saved = await backend.saveReviewDraft(draft);
    expect(backend.activeJob()).toBeNull();
    expect(saved.scanResult.candidates[0].goal).toBe(goal); expect(await backend.list()).toEqual([]); expect(fs.existsSync(backend.filePath)).toBe(false);
    expect((await fs.promises.stat(backend.reviewPath)).mode & 0o777).toBe(0o600);
    const restarted = make(); expect(await restarted.reviewDraft()).toEqual(saved);
    const recovered = await restarted.reviewDraft();
    await restarted.confirm(recovered.scanResult.scanId, [review(recovered.scanResult.candidates[0])]);
    expect((await restarted.list())[0].goal).toBe(goal);
    recovered.scanResult.candidates[0].name = 'mutated'; expect((await restarted.reviewDraft()).scanResult.candidates[0].name).not.toBe('mutated');
    await restarted.saveReviewDraft(null); expect(await restarted.reviewDraft()).toBeNull(); expect(fs.existsSync(restarted.reviewPath)).toBe(false);
  });
  it('串行保存不会乱序，null 等待写入；空候选/伪造 reviews 明确拒绝，不覆盖已有草稿', async () => {
    const scan = await backend.scan(history()), candidate = scan.candidates[0];
    const first = { scanResult: scan, reviews: [{ ...review(candidate), name: 'first' }] };
    const second = { scanResult: scan, reviews: [{ ...review(candidate), name: 'second' }] };
    await Promise.all([backend.saveReviewDraft(first), backend.saveReviewDraft(second)]);
    expect((await backend.reviewDraft()).reviews[0].name).toBe('second');
    await expect(backend.saveReviewDraft({ scanResult: scan, reviews: [{ ...review(candidate), candidateId: 'fake' }] })).rejects.toThrow(/候选/);
    const empty = await backend.scan({ sessions: [], conversations: [] });
    await expect(backend.saveReviewDraft({ scanResult: empty, reviews: [] })).rejects.toThrow(/候选为空/);
    expect((await backend.reviewDraft()).reviews[0].name).toBe('second');
    await Promise.all([backend.saveReviewDraft(first), backend.saveReviewDraft(null)]);
    expect(await backend.reviewDraft()).toBeNull();
  });
  it('损坏草稿禁止覆盖，必须显式丢弃；未知字段/引用/版本拒绝恢复', async () => {
    const scan = await backend.scan(history()), candidate = scan.candidates[0];
    await backend.saveReviewDraft({ scanResult: scan, reviews: [review(candidate)] });
    const original = JSON.parse(await fs.promises.readFile(backend.reviewPath, 'utf8'));
    const corruptions = [
      { ...original, version: 99 }, { ...original, unexpected: true },
      { ...original, candidates: [{ ...candidate, unexpected: true }] },
      { ...original, candidates: [{ ...candidate, fieldEvidence: { background: { kind: 'quoted', refs: [{ sourceId: 'fake', quote: '背景' }] } } }] },
      { ...original, reviews: [{ ...review(candidate), fields: { goal: 'bad' } }] },
    ];
    for (const value of corruptions) {
      const raw = JSON.stringify(value); await fs.promises.writeFile(backend.reviewPath, raw);
      const restarted = make(); await expect(restarted.reviewDraft()).rejects.toThrow(/草稿/);
      const fresh = await restarted.scan(history());
      await expect(restarted.saveReviewDraft({ scanResult: fresh, reviews: [] })).rejects.toThrow(/显式丢弃/);
      expect(await fs.promises.readFile(backend.reviewPath, 'utf8')).toBe(raw);
      await restarted.saveReviewDraft(null); expect(await restarted.reviewDraft()).toBeNull();
    }
  });
  it('后续扫描淘汰缓存时保留已持久化草稿，重启后过期版本拒绝确认', async () => {
    const first = await backend.scan(history()); await backend.confirm(first.scanId, [review(first.candidates[0])]);
    const project = (await backend.list())[0], scan = await backend.scan(history());
    const input = { ...review(scan.candidates[0]), existingProjectId: project.id, expectedRevision: project.revision };
    await backend.saveReviewDraft({ scanResult: scan, reviews: [input] });
    for (let i = 0; i < 22; i++) await backend.scan({ sessions: [], conversations: [] });
    expect(backend.scans.has(scan.scanId)).toBe(true); expect(backend.scans.size).toBe(20);
    await backend.patch({ id: project.id, expectedRevision: project.revision, changes: { name: '新名称' } });
    const restarted = make(); await restarted.reviewDraft();
    await expect(restarted.confirm(scan.scanId, [input])).rejects.toThrow(/revision/);
    expect((await restarted.list())[0].name).toBe('新名称');
  });
  it('草稿原子失败保留已有数据并清理临时文件，丢弃失败不会假装成功', async () => {
    const scan = await backend.scan(history()), candidate = scan.candidates[0], draft = { scanResult: scan, reviews: [review(candidate)] };
    const saved = await backend.saveReviewDraft(draft), raw = await fs.promises.readFile(backend.reviewPath, 'utf8');
    const spy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('full'));
    await expect(backend.saveReviewDraft({ ...draft, reviews: [{ ...review(candidate), name: 'new' }] })).rejects.toThrow(/full/);
    expect(await backend.reviewDraft()).toEqual(saved); expect(await fs.promises.readFile(backend.reviewPath, 'utf8')).toBe(raw);
    expect((await fs.promises.readdir(path.dirname(backend.reviewPath))).filter(name => name.endsWith('.tmp'))).toEqual([]); spy.mockRestore();
    vi.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(new Error('denied'));
    await expect(backend.saveReviewDraft(null)).rejects.toThrow(/denied/); expect(await backend.reviewDraft()).toEqual(saved);
  });
});

describe('逐字段审核和生命周期选择', () => {
  async function modelScan() {
    const scan = await backend.scan(history()), trusted = backend.scans.get(scan.scanId);
    trusted.analysis = { mode: 'llm', model: 'test', batches: 1, calls: 1, costUsd: 0, inputChars: 20 };
    const candidate = trusted.candidates[0];
    candidate.background = '模型背景'; candidate.constraints = '引用约束'; candidate.deliverables = '未知交付';
    candidate.fieldEvidence = {
      background: { kind: 'model', refs: [{ sourceId: candidate.sources[0].id, quote: '旧背景' }] },
      constraints: { kind: 'quoted', refs: [{ sourceId: candidate.sources[0].id, quote: '引用约束' }] },
      deliverables: { kind: 'unknown', refs: [] },
    };
    candidate.fieldProvenance = { name: 'model', goal: 'model', description: 'model', background: 'model', constraints: 'quoted', deliverables: 'unknown' };
    candidate.uncertainties.push('字段 background model：待审核', '字段 background model：存在真实冲突', '字段 deliverables unknown：待审核', '任务存在真实冲突');
    return { scanId: scan.scanId, candidate };
  }
  it('model/unknown 非空必须逐项审核；允许删除为空，修改清引用，quoted 保持原文来源', async () => {
    const { scanId, candidate } = await modelScan();
    await expect(backend.confirm(scanId, [review(candidate)])).rejects.toThrow(/background.*reviewedFields/);
    await expect(backend.confirm(scanId, [{ ...review(candidate), reviewedFields: ['background'] }])).rejects.toThrow(/deliverables/);
    await expect(backend.confirm(scanId, [{ ...review(candidate), reviewedFields: ['goal'] }])).rejects.toThrow(/reviewedFields/);
    const saved = await backend.confirm(scanId, [{ ...review(candidate), fields: { background: '用户背景', deliverables: '' }, reviewedFields: ['background', 'constraints', 'deliverables'] }]);
    expect(saved[0]).toMatchObject({ revision: 1, background: '用户背景', deliverables: '', workingDirectory: '/work' });
    expect(saved[0].fieldEvidence.background).toMatchObject({ kind: 'model', refs: [], reviewedAt: expect.any(Number) });
    expect(saved[0].fieldProvenance.background).toBe('user'); expect(saved[0].fieldProvenance.constraints).toBe('quoted');
    expect(saved[0].fieldEvidence.constraints.kind).toBe('quoted');
    expect(saved[0].resolvedUncertainties).toContain('字段 background model：待审核'); expect(saved[0].resolvedUncertainties).not.toContain('任务存在真实冲突');
    expect(saved[0].resolvedUncertainties).not.toContain('字段 background model：存在真实冲突');
    expect(await make().list()).toEqual(saved);
  });
  it('quoted 候选不能为新增非空审核值豁免 gate；失败不消费候选，随后审核通过', async () => {
    const scan = await backend.scan(history()), candidate = scan.candidates[0];
    const trusted = backend.scans.get(scan.scanId).candidates[0];
    trusted.fieldEvidence = { background: { kind: 'quoted', refs: [{ sourceId: trusted.sources[0].id, quote: '旧背景' }] } };
    trusted.fieldProvenance = { ...trusted.fieldProvenance, background: 'quoted' };
    const input = { ...review(candidate), fields: { background: '新增背景' } };
    await expect(backend.confirm(scan.scanId, [input])).rejects.toThrow(/background.*reviewedFields/);
    expect(await backend.list()).toEqual([]); expect(backend.scans.get(scan.scanId).confirmed.size).toBe(0);
    const saved = await backend.confirm(scan.scanId, [{ ...input, reviewedFields: ['background'] }]);
    expect(saved[0].background).toBe('新增背景'); expect(saved[0].fieldProvenance.background).toBe('user');
    expect(saved[0].fieldEvidence.background.refs).toEqual([]);
    const fresh = await backend.scan(history());
    await expect(backend.confirm(fresh.scanId, [{ ...review(fresh.candidates[0]), allowDuplicate: true, fields: { background: '' } }])).resolves.toHaveLength(2);
  });
  it('已有非空默认保护，显式 fields 才覆盖；stale revision 原子拒绝，审核值不同不消除 uncertainty', async () => {
    const first = await backend.scan(history()); await backend.confirm(first.scanId, [review(first.candidates[0])]);
    let existing = (await backend.list())[0];
    const { scanId, candidate } = await modelScan();
    const input = { ...review(candidate), existingProjectId: existing.id, expectedRevision: existing.revision, reviewedFields: ['background', 'deliverables'] };
    existing = (await backend.patch({ id: existing.id, expectedRevision: existing.revision, changes: { background: '用户保留' } }))[0];
    await expect(backend.confirm(scanId, [input])).rejects.toThrow(/revision/); expect((await backend.list())[0].background).toBe('用户保留');
    let saved = await backend.confirm(scanId, [{ ...input, expectedRevision: existing.revision }]);
    expect(saved[0].background).toBe('用户保留'); expect(saved[0].resolvedUncertainties).not.toContain('字段 background model：待审核');
    const next = await modelScan();
    saved = await backend.confirm(next.scanId, [{ ...review(next.candidate), existingProjectId: existing.id, expectedRevision: saved[0].revision,
      fields: { background: '显式覆盖' }, reviewedFields: ['background', 'deliverables'] }]);
    expect(saved[0].background).toBe('显式覆盖'); expect(saved[0].fieldProvenance.background).toBe('user'); expect(saved[0].fieldEvidence.background.refs).toEqual([]);
  });
  it.each(['archive', 'remove'])('默认匹配排除 %s；明确恢复后原子关联且无重复', async method => {
    const first = await backend.scan(history()); await backend.confirm(first.scanId, [review(first.candidates[0])]);
    const project = (await backend.list())[0]; await backend[method](project.id, true);
    const scan = await backend.scan(history()); expect(scan.candidates[0].existingProjectId).toBeUndefined();
    const revision = (await backend.list())[0].revision;
    await expect(backend.confirm(scan.scanId, [{ ...review(scan.candidates[0]), existingProjectId: project.id, expectedRevision: revision }])).rejects.toThrow(/restoreExisting/);
    const restored = await backend.confirm(scan.scanId, [{ ...review(scan.candidates[0]), existingProjectId: project.id, expectedRevision: revision, restoreExisting: true }]);
    expect(restored).toHaveLength(1); expect(restored[0].archivedAt).toBeUndefined(); expect(restored[0].deletedAt).toBeUndefined(); expect(restored[0].revision).toBe(revision + 1);
  });
  it('归档项目不阻止独立创建，无需 allowDuplicate', async () => {
    const first = await backend.scan(history()); await backend.confirm(first.scanId, [review(first.candidates[0])]);
    await backend.archive((await backend.list())[0].id, true);
    const second = await backend.scan(history()); await backend.confirm(second.scanId, [review(second.candidates[0])]);
    expect(await backend.list()).toHaveLength(2);
  });
});
