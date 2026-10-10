import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareAnalysis, analyzeProjects, PROJECTS_SCHEMA, GROUPS_SCHEMA } from '../src/main/projects-llm.js';
import { collectProjectHistory, DEFAULT_LIMITS } from '../src/main/projects-scan.js';

let dir, root;
const prose = '这些年客户的信息散落各处，我希望未来几个月逐步让同事用一个地方处理。先整理客户列表，再接通客户详情，每周继续完善。';
const message = (id, value, role = 'user', timestamp = 1) => ({ id, role, timestamp, blocks: [{ kind: 'text', text: value }] });
const tool = (toolId, toolName, input, result = 'success', status = 'done') => ({ kind: 'tool_use', toolId, toolName, input, result, status });
const session = (messages = [message('u', prose)], sessionId = 's', cwd = dir) => ({ sessionId, cwd, title: '客户长期工作', messages });
const data = sessions => ({ sessions: sessions || [session()], conversations: [] });
const ref = (sourceId, quote) => ({ sourceId, quote });
function project(payload, edits = {}) {
  const sourceId = payload.evidence.find(item => item.text.includes('先整理客户列表'))?.sourceId || payload.evidence[0].sourceId;
  return { name: '客户中心', goal: '持续统一客户信息', summary: '按周推进的客户工作', evidence: [ref(sourceId, prose)],
    criteria: { longTerm: true, shortQA: false, reasons: ['未来几个月，分周推进两个阶段'], uncertainties: ['验收尚未确认'] },
    tasks: [
      { id: 'a', name: '客户列表', description: '', sourceRefs: [ref(sourceId, '先整理客户列表')] },
      { id: 'b', name: '客户详情', description: '', sourceRefs: [ref(sourceId, '再接通客户详情')] },
    ], ...edits };
}
const analyze = value => vi.fn(async () => ({ value, costUsd: 0.01 }));
const run = (payload, fn, options = {}) => analyzeProjects(payload, { analyze: fn, model: 'mock', maxBudgetUsd: 1, ...options });
const row = (type, content, uuid, sessionId = 's') => ({ type, uuid, sessionId, cwd: dir, timestamp: '2026-01-01T00:00:00Z', message: { role: type, content } });
async function cli(rows) {
  await fs.promises.mkdir(path.join(root, 'work'), { recursive: true });
  const file = path.join(root, 'work', 's.jsonl');
  await fs.promises.writeFile(file, rows.map(value => JSON.stringify(value)).join('\n'));
  return file;
}
beforeEach(async () => { dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'projects-llm-')); root = path.join(dir, 'history'); });
afterEach(async () => { vi.restoreAllMocks(); await fs.promises.rm(dir, { recursive: true, force: true }); });

describe('projects-llm snapshot and semantic contract', () => {
  it('prose goes directly into prompt; snapshot only once, no persistence or raw preview', async () => {
    const input = data();
    const { plan, payload } = await prepareAnalysis(input, root);
    expect(plan).not.toHaveProperty('planId'); expect(plan).not.toHaveProperty('expiresAt');
    expect(plan.messages).toBe(1); expect(plan.maxCalls).toBe(1);
    expect(plan.sampleSources[0]).not.toHaveProperty('tools'); expect(plan.sampleSources[0]).not.toHaveProperty('raw');
    expect(Object.isFrozen(payload)).toBe(true); expect(Object.isFrozen(payload.evidence[0])).toBe(true);
    input.sessions[0].messages[0].blocks[0].text = 'changed';
    const fn = analyze({ projects: [project(payload)] });
    const result = await run(payload, fn);
    expect(fn.mock.calls[0][0].prompt).toContain(prose);
    expect(fn.mock.calls[0][0].schema).toEqual(PROJECTS_SCHEMA);
    expect(result.candidates).toHaveLength(1); expect(result.candidates[0].goalConfirmed).toBe(false);
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });
  it('ignores thinking and arbitrary private tool contents/results/commands', async () => {
    const secret = 'PRIVATE_BLOB_DO_NOT_SEND';
    const s = session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2, blocks: [
      { kind: 'thinking', text: secret }, tool('w', 'Write', { file_path: path.join(dir, 'out'), content: secret }, secret),
      tool('b', 'Bash', { command: secret }, secret),
    ] }]);
    const { payload } = await prepareAnalysis(data([s]), root);
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(payload.batches[0].prompt).toContain('Write');
  });
  it('dedups archive/active/CLI by same-session UUID/content/tools, retaining source provenance', async () => {
    const file = await cli([row('user', prose, 'u'), row('assistant', [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: path.join(dir, 'a'), content: 'private' } }], 'a')]);
    const s = session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2, blocks: [tool('t', 'Write', { file_path: path.join(dir, 'a') })] }]);
    const input = { sessions: [s], conversations: [structuredClone(s)] };
    const collected = await collectProjectHistory(input, root, DEFAULT_LIMITS);
    expect(collected.events).toHaveLength(2); expect(collected.events[0].originals).toHaveLength(3);
    const first = await prepareAnalysis(input, root), second = await prepareAnalysis(input, root);
    expect(first.payload).toEqual(second.payload);
    expect(first.payload.sources.every(source => source.kind === 'claude' && source.path === file)).toBe(true);
    expect(first.payload.evidence[0].origins.some(origin => origin.kind === 'gui')).toBe(true);
  });
  it('identical turns on different days remain temporal evidence while GUI/CLI content mirrors dedup', async () => {
    const later = Date.parse('2026-02-01T00:00:00Z');
    const input = data([session([message('first', prose, 'user', 1), message('later', prose, 'user', later)])]);
    const { payload } = await prepareAnalysis(input, root);
    expect(payload.evidence).toHaveLength(2); expect(payload.evidence[1].timestamp).toBe(later);
    await cli([row('user', 'different content-only mirror', 'cli-u')]);
    const mirrored = await prepareAnalysis(data([session([message('gui-u', 'different content-only mirror')])]), root);
    expect(mirrored.payload.evidence).toHaveLength(1); expect(mirrored.payload.evidence[0].origins).toHaveLength(2);
  });
  it('GUI aggregate citations resolve to their actual CLI event, never a fabricated concatenated quote', async () => {
    await cli([row('user', prose, 'u'), row('assistant', [
      { type: 'text', text: '客户列表原文' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ], 'cli-a1'), row('assistant', [
      { type: 'text', text: '客户详情原文' }, { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
    ], 'cli-a2')]);
    const input = data([session([message('u', prose), { id: 'gui-a', role: 'assistant', timestamp: 2,
      blocks: [tool('t1', 'Bash', {}), tool('t2', 'Bash', {})] }])]);
    const { payload } = await prepareAnalysis(input, root);
    const assistant = payload.evidence.find(event => event.role === 'assistant');
    const raw = project(payload); raw.tasks[0].sourceRefs = [ref(assistant.sourceId, '客户列表原文')]; raw.tasks[1].sourceRefs = [ref(assistant.sourceId, '客户详情原文')];
    const result = await run(payload, analyze({ projects: [raw] }));
    const candidate = result.candidates[0];
    expect(candidate.sources.some(source => source.messageId === 'cli-a1')).toBe(true);
    expect(candidate.sources.some(source => source.messageId === 'cli-a2')).toBe(true);
    expect(candidate.tasks[0].sourceIds).not.toEqual(candidate.tasks[1].sourceIds);
    raw.evidence = [ref(assistant.sourceId, '客户列表原文\n客户详情原文')];
    expect((await run(payload, analyze({ projects: [raw] }))).candidates).toEqual([]);
  });
  it('large structured todo lists split into bounded evidence without sending tool result content', async () => {
    const todos = Array.from({ length: 45 }, (_, i) => ({ content: `todo-${i} ` + 'x'.repeat(100), status: 'pending' }));
    const { payload } = await prepareAnalysis(data([session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2,
      blocks: [tool('todos', 'TodoWrite', { todos }, 'private result')] }])]), root);
    const segments = payload.evidence.filter(event => event.tools.length);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every(event => JSON.stringify(event.tools).length < 3100)).toBe(true);
    expect(segments.flatMap(event => event.tools.flatMap(tool => tool.input.todos))).toEqual(todos);
    expect(payload.toolEvidence[0].incomplete).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('private result');
  });
  it('head-tail truncation keeps context, warnings, bounded batches and total chars', async () => {
    const long = 'HEAD_CONTEXT ' + 'x'.repeat(6000) + ' TAIL_CONTEXT';
    const s = session(Array.from({ length: 15 }, (_, i) => message('u' + i, long + i, 'user', i + 1)));
    const { plan, payload } = await prepareAnalysis(data([s]), root, { maxBatchChars: 4500, maxInputChars: 12000, maxBatches: 3 });
    expect(plan.batches).toBeLessThanOrEqual(3); expect(plan.inputChars).toBeLessThanOrEqual(12000);
    expect(payload.batches.every(batch => batch.prompt.length <= 4500)).toBe(true);
    expect(payload.evidence[0].text).toContain('HEAD_CONTEXT'); expect(payload.evidence[0].text).toContain('TAIL_CONTEXT');
    expect(payload.evidence[0].text.length).toBeLessThanOrEqual(3000);
    expect(plan.coverage.warnings.join('\n')).toMatch(/截断/); expect(plan.coverage.incomplete).toBe(true);
    expect(payload.batches.some(batch => batch.prompt.includes('contextOnly'))).toBe(true);
  });
});

describe('projects-llm local validation', () => {
  it('missing citation quote rejects only candidate with warning', async () => {
    const { payload } = await prepareAnalysis(data(), root); const raw = project(payload);
    raw.tasks[0].sourceRefs = [{ sourceId: payload.sources[0].id }];
    const result = await run(payload, analyze({ projects: [raw] }));
    expect(result.candidates).toEqual([]); expect(result.coverage.warnings.join('\n')).toMatch(/引用无效.*拒绝/);
  });
  it.each(['unknown source', 'invented quote'])('rejects citation-invalid candidate: %s', async kind => {
    const { payload } = await prepareAnalysis(data(), root);
    const raw = project(payload); raw.tasks[0].sourceRefs = [ref(kind === 'unknown source' ? 'fake' : payload.sources[0].id, kind === 'unknown source' ? prose : '不存在的原文')];
    const result = await run(payload, analyze({ projects: [raw] }));
    expect(result.candidates).toEqual([]); expect(result.coverage.warnings.join('\n')).toMatch(/引用无效.*拒绝/);
  });
  it('normalizes whitespace but does not normalize meaning', async () => {
    const { payload } = await prepareAnalysis(data([session([message('u', prose.replace('先整理客户列表', '先整理\n  客户列表'))])]), root);
    const raw = project(payload, { evidence: [ref(payload.sources[0].id, prose.replace('先整理客户列表', '先整理 客户列表'))] });
    raw.tasks[0].sourceRefs = [ref(payload.sources[0].id, '先整理 客户列表')];
    expect((await run(payload, analyze({ projects: [raw] }))).candidates).toHaveLength(1);
  });
  it('short QA and duplicate tasks filtered; null response valid', async () => {
    const { payload } = await prepareAnalysis(data(), root);
    expect((await run(payload, analyze({ projects: null }))).candidates).toEqual([]);
    const raw = project(payload); raw.criteria.shortQA = true;
    expect((await run(payload, analyze({ projects: [raw] }))).candidates).toEqual([]);
    const dup = project(payload); dup.tasks[1].sourceRefs = dup.tasks[0].sourceRefs;
    expect((await run(payload, analyze({ projects: [dup] }))).candidates).toEqual([]);
  });
  it('assistant completed and hallucinated actual path are downgraded/removed, expected IO labeled', async () => {
    const { payload } = await prepareAnalysis(data([session([message('u', prose), message('a', '全部完成', 'assistant', 2)])]), root);
    const raw = project(payload); raw.tasks[0].status = 'completed';
    raw.tasks[0].outputs = [{ value: '/invented/output.txt', kind: 'actual', ...raw.tasks[0].sourceRefs[0] }, { value: '未来报告', kind: 'expected', ...raw.tasks[0].sourceRefs[0] }];
    const result = await run(payload, analyze({ projects: [raw] }));
    expect(result.candidates[0].tasks[0].status).toBe('pending'); expect(result.candidates[0].files).toEqual([]);
    expect(result.candidates[0].tasks[0].outputs).toEqual(['预期输出（待确认）：未来报告']);
    expect(result.coverage.warnings.join('\n')).toMatch(/降为 pending/); expect(result.coverage.warnings.join('\n')).toMatch(/actual IO/);
  });
  it('accepts completed only for corresponding successful structured todo and verifies actual IO locally', async () => {
    const file = path.join(dir, 'out.txt'); await fs.promises.writeFile(file, 'actual');
    const s = session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2, blocks: [
      tool('todo1', 'TodoWrite', { todos: [{ content: '客户列表', status: 'in_progress' }, { content: '客户详情', status: 'pending' }] }),
      tool('w', 'Write', { file_path: file, content: 'secret' }),
      tool('todo2', 'TodoWrite', { todos: [{ content: '客户列表', status: 'completed' }, { content: '客户详情', status: 'pending' }] }),
    ] }]);
    const { payload } = await prepareAnalysis(data([s]), root);
    const toolSource = payload.evidence.find(item => item.tools.length).sourceId;
    const raw = project(payload); raw.tasks[0].sourceRefs = [ref(toolSource, '客户列表')]; raw.tasks[0].status = 'completed';
    raw.tasks[0].outputs = [{ value: file, sourceId: toolSource, quote: file, kind: 'actual' }];
    const result = await run(payload, analyze({ projects: [raw] }));
    expect(result.candidates[0].tasks[0].status).toBe('completed'); expect(result.candidates[0].tasks[0].outputs).toEqual([file]);
    expect(result.candidates[0].sources.map(source => source.id)).toContain(toolSource);
    expect(result.candidates[0].files[0].path).toBe(file);
  });
  it('actual IO requires the unique active structured task at execution time', async () => {
    const none = path.join(dir, 'none.txt'), both = path.join(dir, 'both.txt'), other = path.join(dir, 'other.txt'), failed = path.join(dir, 'failed.txt');
    await Promise.all([none, both, other, failed].map(file => fs.promises.writeFile(file, 'actual')));
    const s = session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2, blocks: [
      tool('todo0', 'TodoWrite', { todos: [{ content: '客户列表', status: 'completed' }, { content: '客户详情', status: 'pending' }] }),
      tool('w0', 'Write', { file_path: none }),
      tool('todo1', 'TodoWrite', { todos: [{ content: '客户列表', status: 'in_progress' }, { content: '客户详情', status: 'in_progress' }] }),
      tool('w1', 'Write', { file_path: both }),
      tool('todo2', 'TodoWrite', { todos: [{ content: '客户列表', status: 'completed' }, { content: '客户详情', status: 'in_progress' }] }),
      tool('w2', 'Write', { file_path: other }),
      tool('w3', 'Write', { file_path: failed }, 'failed', 'error'),
    ] }]);
    const { payload } = await prepareAnalysis(data([s]), root);
    const toolSource = payload.evidence.find(item => item.tools.length).sourceId;
    const raw = project(payload);
    raw.tasks[0].sourceRefs = [ref(toolSource, '客户列表')]; raw.tasks[0].status = 'completed';
    raw.tasks[0].outputs = [none, both, other, failed].map(file => ({ value: file, sourceId: toolSource, quote: file, kind: 'actual' }));
    raw.tasks[1].sourceRefs = [ref(toolSource, '客户详情')];
    raw.tasks[1].outputs = [{ value: other, sourceId: toolSource, quote: other, kind: 'actual' }];
    const result = await run(payload, analyze({ projects: [raw] }));
    const tasks = result.candidates[0].tasks;
    expect(tasks[0].status).toBe('completed'); expect(tasks[0].outputs).toEqual([]);
    expect(tasks[1].outputs).toEqual([other]);
    expect(result.candidates[0].files.map(file => file.path)).toEqual([other]);
    expect(result.coverage.warnings.join('\n')).toMatch(/归属不明确/);
    expect(result.coverage.warnings.join('\n')).toMatch(/执行时 2 个活跃任务/);
  });
  it('status cross-use via another task citation is rejected as pending/unknown', async () => {
    const s = session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2, blocks: [
      tool('todo', 'TodoWrite', { todos: [{ content: '客户列表', status: 'pending' }, { content: '客户详情', status: 'completed' }] }),
    ] }]);
    const { payload } = await prepareAnalysis(data([s]), root);
    const toolSource = payload.evidence.find(item => item.tools.length).sourceId;
    const raw = project(payload);
    raw.tasks[0].sourceRefs = [ref(toolSource, '客户详情')]; raw.tasks[0].status = 'completed';
    const result = await run(payload, analyze({ projects: [raw] }));
    expect(result.candidates[0].tasks[0].status).toBe('pending'); expect(result.candidates[0].tasks[0].name).toBe('客户列表');
    expect(result.candidates[0].uncertainties.join('\n')).toMatch(/名称不对应/);
  });
  it('task name is fixed to the real structured node name while the model rewrite is recorded', async () => {
    const s = session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2, blocks: [
      tool('todo', 'TodoWrite', { todos: [{ content: '客户列表', status: 'completed' }, { content: '客户详情', status: 'pending' }] }),
    ] }]);
    const { payload } = await prepareAnalysis(data([s]), root);
    const toolSource = payload.evidence.find(item => item.tools.length).sourceId;
    const raw = project(payload);
    raw.tasks[0].name = '客户列表整理'; raw.tasks[0].sourceRefs = [ref(toolSource, '客户列表')]; raw.tasks[0].status = 'completed';
    const result = await run(payload, analyze({ projects: [raw] }));
    const task = result.candidates[0].tasks[0];
    expect(task.name).toBe('客户列表'); expect(task.status).toBe('completed');
    expect(task.records.join('\n')).toMatch(/模型命名「客户列表整理」/);
  });
  it('invalid task updates clear active attribution so later writes cannot be claimed', async () => {
    const file = path.join(dir, 'out.txt'); await fs.promises.writeFile(file, 'actual');
    const s = session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2, blocks: [
      tool('todo', 'TodoWrite', { todos: [{ content: '客户列表', status: 'in_progress' }, { content: '客户详情', status: 'pending' }] }),
      tool('bad', 'TaskUpdate', { taskId: '1', status: 'bogus' }),
      tool('w', 'Write', { file_path: file }),
    ] }]);
    const { payload } = await prepareAnalysis(data([s]), root);
    const toolSource = payload.evidence.find(item => item.tools.length).sourceId;
    const raw = project(payload);
    raw.tasks[0].sourceRefs = [ref(toolSource, '客户列表')]; raw.tasks[0].status = 'in_progress';
    raw.tasks[0].outputs = [{ value: file, sourceId: toolSource, quote: file, kind: 'actual' }];
    const result = await run(payload, analyze({ projects: [raw] }));
    expect(result.candidates[0].tasks[0].status).toBe('in_progress');
    expect(result.candidates[0].tasks[0].outputs).toEqual([]);
    expect(result.coverage.warnings.join('\n')).toMatch(/归属不明确/);
  });
  it('plan/spec writes are recorded as context, never claimed deliverables', async () => {
    const file = path.join(dir, 'docs', 'plan.md');
    await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, 'plan');
    const s = session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2, blocks: [
      tool('todo1', 'TodoWrite', { todos: [{ content: '编写客户整理计划', status: 'in_progress' }, { content: '客户详情', status: 'pending' }] }),
      tool('w', 'Write', { file_path: file }),
      tool('todo2', 'TodoWrite', { todos: [{ content: '编写客户整理计划', status: 'completed' }, { content: '客户详情', status: 'pending' }] }),
    ] }]);
    const { payload } = await prepareAnalysis(data([s]), root);
    const toolSource = payload.evidence.find(item => item.tools.length).sourceId;
    const raw = project(payload);
    raw.tasks[0].name = '编写客户整理计划'; raw.tasks[0].sourceRefs = [ref(toolSource, '编写客户整理计划')]; raw.tasks[0].status = 'completed';
    raw.tasks[0].outputs = [{ value: file, sourceId: toolSource, quote: file, kind: 'actual' }];
    const result = await run(payload, analyze({ projects: [raw] }));
    expect(result.candidates[0].tasks[0].status).toBe('completed');
    expect(result.candidates[0].tasks[0].outputs).toEqual([]);
    expect(result.candidates[0].files[0].path).toBe(file);
    expect(result.candidates[0].files[0].purpose).toMatch(/计划\/说明文件/);
  });
  it('failed tools, outside-cwd files and symlinks never support completion/actual IO', async () => {
    const outside = path.join(dir, 'outside'); const cwd = path.join(dir, 'cwd'); await fs.promises.mkdir(cwd); await fs.promises.writeFile(outside, 'exists');
    const link = path.join(cwd, 'link'); await fs.promises.symlink(outside, link);
    const s = session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2, blocks: [
      tool('todo', 'TodoWrite', { todos: [{ content: '客户列表', status: 'completed' }] }, 'failed', 'error'),
      tool('w', 'Write', { file_path: outside }), tool('l', 'Write', { file_path: link }),
    ] }], 's', cwd);
    const { payload } = await prepareAnalysis(data([s]), root);
    expect(payload.verifiedFiles).toEqual([]);
    const raw = project(payload); raw.tasks[0].status = 'completed';
    expect((await run(payload, analyze({ projects: [raw] }))).candidates[0].tasks[0].status).toBe('pending');
  });
  it('distinct tasks in the same source cannot be accidentally deduped solely by shared project evidence', async () => {
    const { payload } = await prepareAnalysis(data(), root); const a = project(payload), b = structuredClone(a);
    b.tasks[0].sourceRefs = [ref(payload.sources[0].id, '这些年客户的信息散落各处')];
    b.tasks[1].sourceRefs = [ref(payload.sources[0].id, '每周继续完善')];
    const result = await run(payload, analyze({ projects: [a, b] }));
    expect(result.candidates).toHaveLength(2); expect(result.candidates[0].id).not.toBe(result.candidates[1].id);
  });
  it('names may change but project/task identity follows same cwd and exact evidence', async () => {
    const { payload } = await prepareAnalysis(data(), root);
    const raw = project(payload); const renamed = structuredClone(raw); renamed.name = '新客户系统'; renamed.goal = '新名称目标'; renamed.tasks.forEach(task => { task.name += '改名'; });
    const first = (await run(payload, analyze({ projects: [raw, renamed] }))).candidates;
    const second = (await run(payload, analyze({ projects: [renamed] }))).candidates;
    expect(first).toHaveLength(1); expect(first[0].id).toBe(second[0].id); expect(first[0].tasks.map(task => task.id)).toEqual(second[0].tasks.map(task => task.id));
  });
  it('existing association requires known id + same cwd + source intersection and reuses stable ids', async () => {
    const { payload } = await prepareAnalysis(data(), root);
    const saved = (await run(payload, analyze({ projects: [project(payload)] }))).candidates[0]; saved.id = 'existing';
    const next = await prepareAnalysis(data(), root, {}, [saved]);
    expect(next.payload.batches[0].prompt).toContain('existingProjects');
    const raw = project(next.payload, { existingProjectId: 'existing' });
    const result = await run(next.payload, analyze({ projects: [raw] }));
    expect(result.candidates[0].existingProjectId).toBe('existing'); expect(result.candidates[0].tasks.map(task => task.id)).toEqual(saved.tasks.map(task => task.id));
    raw.existingProjectId = 'invented';
    const invalid = await run(next.payload, analyze({ projects: [raw] }));
    expect(invalid.candidates[0]).not.toHaveProperty('existingProjectId'); expect(invalid.candidates[0].uncertainties.join('\n')).toMatch(/关联 unknown/);
  });
  it('semantic-only and unknown dependencies remain uncertainties, no edges', async () => {
    const { payload } = await prepareAnalysis(data(), root); const raw = project(payload);
    raw.tasks[1].dependsOn = [{ id: 'a', ...raw.tasks[0].sourceRefs[0] }, { id: 'unknown', ...raw.tasks[0].sourceRefs[0] }];
    const result = await run(payload, analyze({ projects: [raw] }));
    expect(result.candidates[0].tasks[1].dependsOn).toEqual([]); expect(result.coverage.warnings.join('\n')).toMatch(/语义推测/); expect(result.coverage.warnings.join('\n')).toMatch(/未知节点/);
  });
  it('TaskUpdate addBlockedBy/addBlocks resolve to the waiting task depending on the blocker', async () => {
    const create = (id, name) => tool('create' + id, 'TaskCreate', { subject: name }, { task: { id } });
    const s = session([message('u', prose), { id: 'a', role: 'assistant', timestamp: 2, blocks: [
      create('1', '客户列表'), create('2', '客户详情'), create('3', '客户统计'),
      tool('dep', 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'] }),
      tool('blocks', 'TaskUpdate', { taskId: '1', addBlocks: ['3'] }),
    ] }]);
    const { payload } = await prepareAnalysis(data([s]), root);
    const toolSource = payload.evidence.find(item => item.tools.length).sourceId;
    const raw = project(payload);
    raw.tasks = [
      { id: 'list', name: '客户列表', description: '', sourceRefs: [ref(toolSource, '客户列表')] },
      { id: 'detail', name: '客户详情', description: '', sourceRefs: [ref(toolSource, JSON.stringify({ taskId: '2', addBlockedBy: ['1'] }))],
        dependsOn: [{ id: 'list', ...ref(toolSource, '"addBlockedBy":["1"]') }] },
      { id: 'statistics', name: '客户统计', description: '', sourceRefs: [ref(toolSource, '客户统计')],
        dependsOn: [{ id: 'list', ...ref(toolSource, '"addBlocks":["3"]') }] },
    ];
    const result = await run(payload, analyze({ projects: [raw] }));
    const byName = Object.fromEntries(result.candidates[0].tasks.map(task => [task.name, task]));
    expect(byName['客户详情'].dependsOn).toEqual([byName['客户列表'].id]);
    expect(byName['客户统计'].dependsOn).toEqual([byName['客户列表'].id]);
    expect(byName['客户列表'].dependsOn).toEqual([]);
  });
});

describe('projects-llm batching, schema, cancellation and budget', () => {
  async function multiple(cwds = [dir, dir]) {
    const input = data(cwds.map((cwd, i) => session([message('u' + i, prose + 'x'.repeat(800), 'user', i + 1)], 's' + i, cwd)));
    return (await prepareAnalysis(input, root, { maxBatchChars: 2000 })).payload;
  }
  const fromPrompt = request => {
    const parsed = JSON.parse(request.prompt), messages = parsed.messages.filter(item => !item.contextOnly);
    const sourceId = messages[0].sourceId;
    return { name: '客户' + messages[0].sessionId, goal: '长期客户系统', summary: '', evidence: [ref(sourceId, prose)],
      criteria: { longTerm: true, shortQA: false, reasons: ['长期多阶段'] }, tasks: [
        { id: 'a', name: '列表', description: '', sourceRefs: [ref(sourceId, '先整理客户列表')] },
        { id: 'b', name: '详情', description: '', sourceRefs: [ref(sourceId, '再接通客户详情')] },
      ] };
  };
  it('multi-batch groups only validated ids/evidence and shares remaining budget', async () => {
    const payload = await multiple(); expect(payload.batches).toHaveLength(2);
    const fn = vi.fn(async request => {
      if (request.schema.required[0] === 'projects') return { value: { projects: [fromPrompt(request)] }, costUsd: 0.1 };
      const { candidates } = JSON.parse(request.prompt);
      expect(request.schema).toEqual(GROUPS_SCHEMA);
      return { value: { groups: [{ ids: candidates.map(candidate => candidate.id), reason: '同目录跨会话持续同一目标', evidence: candidates.flatMap(candidate => candidate.evidence) }] }, costUsd: 0.1 };
    });
    const result = await run(payload, fn, { maxBudgetUsd: 0.5 });
    expect(result.candidates).toHaveLength(1); expect(result.candidates[0].sources).toHaveLength(2); expect(result.analysis.calls).toBe(3);
    expect(fn.mock.calls.map(([request]) => request.maxBudgetUsd)).toEqual([0.5, 0.4, 0.3]);
  });
  it('one task per batch may form a two-task project only after proven same-project grouping', async () => {
    const payload = await multiple();
    const fn = vi.fn(async request => {
      if (request.schema.required[0] === 'projects') {
        const raw = fromPrompt(request); raw.tasks = [raw.tasks[JSON.parse(request.prompt).messages[0].sessionId === 's0' ? 0 : 1]];
        return { value: { projects: [raw] }, costUsd: 0.01 };
      }
      const { candidates } = JSON.parse(request.prompt);
      return { value: { groups: [{ ids: candidates.map(c => c.id), reason: '同目录相同原始项目延续', evidence: candidates.flatMap(c => c.evidence) }] }, costUsd: 0.01 };
    });
    const result = await run(payload, fn); expect(result.candidates).toHaveLength(1); expect(result.candidates[0].tasks).toHaveLength(2);
  });
  it('cross-cwd or invalid grouping evidence does not merge', async () => {
    const payload = await multiple([dir, path.join(dir, 'other')]);
    const fn = vi.fn(async request => {
      if (request.schema.required[0] === 'projects') return { value: { projects: [fromPrompt(request)] }, costUsd: 0.01 };
      const { candidates } = JSON.parse(request.prompt);
      return { value: { groups: [{ ids: candidates.map(candidate => candidate.id), reason: '名字相同', evidence: candidates.flatMap(candidate => candidate.evidence) }] }, costUsd: 0.01 };
    });
    const result = await run(payload, fn); expect(result.candidates).toHaveLength(2); expect(result.coverage.warnings.join('\n')).toMatch(/跨目录/);
  });
  it('ambiguous grouping reason never auto-merges even with valid ids and quotes', async () => {
    const payload = await multiple();
    const fn = vi.fn(async request => {
      if (request.schema.required[0] === 'projects') return { value: { projects: [fromPrompt(request)] }, costUsd: 0.01 };
      const { candidates } = JSON.parse(request.prompt);
      return { value: { groups: [{ ids: candidates.map(c => c.id), reason: '可能是同一个项目', evidence: candidates.flatMap(c => c.evidence) }] }, costUsd: 0.01 };
    });
    const result = await run(payload, fn);
    expect(result.candidates).toHaveLength(2); expect(result.coverage.warnings.join('\n')).toMatch(/模糊理由/);
  });
  it('cross-batch structured dependencies merge with stable nodes and reject cycles', async () => {
    const create = (id, name) => tool('create' + id, 'TaskCreate', { subject: name }, { task: { id } });
    const s = session([
      message('u1', prose),
      { id: 'a1', role: 'assistant', timestamp: 2, blocks: [create('1', '客户列表'), create('2', '客户详情')] },
      message('padding', 'x'.repeat(1200), 'user', 3),
      message('u2', '改名为客户协作中心，继续分周推进。' + prose, 'user', 4),
      { id: 'a2', role: 'assistant', timestamp: 5, blocks: [
        create('3', '客户统计'),
        tool('dep', 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'] }),
        tool('cycle', 'TaskUpdate', { taskId: '1', addBlockedBy: ['2'] }),
      ] },
    ]);
    const { payload } = await prepareAnalysis(data([s]), root, { maxBatchChars: 2000 });
    expect(payload.batches.length).toBeGreaterThan(1);
    const fn = vi.fn(async request => {
      if (request.schema.required[0] === 'groups') {
        const { candidates } = JSON.parse(request.prompt);
        return { costUsd: 0.01, value: { groups: [{ ids: candidates.map(c => c.id), reason: '改名继续同项目', evidence: candidates.flatMap(c => c.evidence) }] } };
      }
      const { messages } = JSON.parse(request.prompt);
      const creation = messages.find(m => m.tools.some(t => t.name === 'TaskCreate'));
      if (!creation) return { costUsd: 0.01, value: { projects: [] } };
      const sid = creation.sourceId, user = messages.find(m => m.role === 'user' && !m.contextOnly && m.text.includes(prose)) || messages.find(m => m.role === 'user' && m.text.includes(prose));
      if (!user) return { costUsd: 0.01, value: { projects: [] } };
      const second = creation.tools.some(t => t.createdTaskId === '3');
      const tasks = second ? [
        { id: 'detail', name: '详情改名', description: '', sourceRefs: [ref(sid, JSON.stringify({ taskId: '2', addBlockedBy: ['1'] }))], dependsOn: [{ id: 'list', ...ref(sid, '"addBlockedBy":["1"]') }] },
        { id: 'list', name: '列表改名', description: '', sourceRefs: [ref(sid, JSON.stringify({ taskId: '1', addBlockedBy: ['2'] }))], dependsOn: [{ id: 'detail', ...ref(sid, '"addBlockedBy":["2"]') }] },
        { id: 'statistics', name: '统计', description: '', sourceRefs: [ref(sid, '客户统计')] },
      ] : [
        { id: 'list', name: '列表', description: '', sourceRefs: [ref(sid, '客户列表')] },
        { id: 'detail', name: '详情', description: '', sourceRefs: [ref(sid, '客户详情')] },
      ];
      return { costUsd: 0.01, value: { projects: [{ name: second ? '客户协作中心' : '客户中心', goal: '持续客户项目', summary: '',
        evidence: [ref(user.sourceId, prose)], criteria: { longTerm: true, shortQA: false, reasons: ['持续跨阶段'] }, tasks }] } };
    });
    const result = await run(payload, fn);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]; expect(candidate.tasks).toHaveLength(3);
    expect(candidate.tasks.reduce((n, task) => n + task.dependsOn.length, 0)).toBe(1);
    expect(result.coverage.warnings.join('\n')).toMatch(/循环/);
    for (const task of candidate.tasks) {
      expect(task.sourceIds.every(id => candidate.sources.some(s => s.id === id))).toBe(true);
      expect(task.dependsOn.every(id => candidate.tasks.some(t => t.id === id))).toBe(true);
    }
  });
  it('a verified completed fragment survives merging with an unevidenced pending fragment', async () => {
    const s = session([
      message('u1', prose),
      { id: 'a1', role: 'assistant', timestamp: 2, blocks: [tool('todo1', 'TodoWrite', { todos: [{ content: '客户列表', status: 'pending' }, { content: '客户详情', status: 'pending' }] })] },
      message('padding', 'x'.repeat(1300), 'user', 3),
      message('u2', '继续推进客户列表工作。' + prose, 'user', 4),
      { id: 'a2', role: 'assistant', timestamp: 5, blocks: [tool('todo2', 'TodoWrite', { todos: [{ content: '客户列表', status: 'completed' }, { content: '客户详情', status: 'pending' }] })] },
    ]);
    const { payload } = await prepareAnalysis(data([s]), root, { maxBatchChars: 2000 });
    expect(payload.batches.length).toBeGreaterThan(1);
    const fn = vi.fn(async request => {
      if (request.schema.required[0] === 'groups') {
        const { candidates } = JSON.parse(request.prompt);
        return { costUsd: 0.01, value: { groups: [{ ids: candidates.map(c => c.id), reason: '同目录持续客户项目', evidence: candidates.flatMap(c => c.evidence) }] } };
      }
      const { messages } = JSON.parse(request.prompt);
      const creation = messages.find(m => m.tools.some(t => t.name === 'TodoWrite'));
      const user = messages.find(m => m.role === 'user' && !m.contextOnly && m.text.includes(prose)) || messages.find(m => m.role === 'user' && m.text.includes(prose));
      if (!creation || !user) return { costUsd: 0.01, value: { projects: [] } };
      const sid = creation.sourceId;
      const completed = creation.tools.some(t => (t.input.todos || []).some(todo => todo.content === '客户列表' && todo.status === 'completed'));
      return { costUsd: 0.01, value: { projects: [{ name: '客户中心', goal: '持续客户项目', summary: '',
        evidence: [ref(user.sourceId, prose)], criteria: { longTerm: true, shortQA: false, reasons: ['持续'] }, tasks: [
          { id: 'a', name: '客户列表', description: '', sourceRefs: [ref(sid, '客户列表')], ...(completed ? { status: 'completed' } : {}) },
          { id: 'b', name: '客户详情', description: '', sourceRefs: [ref(sid, '客户详情')] },
        ] }] } };
    });
    const result = await run(payload, fn);
    expect(result.candidates).toHaveLength(1);
    const task = result.candidates[0].tasks.find(task => task.name === '客户列表');
    expect(task.status).toBe('completed');
    expect(result.candidates[0].uncertainties.join('\n')).toMatch(/结构化证据/);
  });
  it('conflicting verified statuses across sessions stay pending and unknown', async () => {
    const input = data([
      session([message('u1', prose + 'x'.repeat(800)), { id: 'a1', role: 'assistant', timestamp: 2,
        blocks: [tool('todo1', 'TodoWrite', { todos: [{ content: '客户列表', status: 'completed' }, { content: '客户详情', status: 'pending' }] })] }], 's0'),
      session([message('u2', prose + 'y'.repeat(800)), { id: 'a2', role: 'assistant', timestamp: 3,
        blocks: [tool('todo2', 'TodoWrite', { todos: [{ content: '客户列表', status: 'in_progress' }, { content: '客户详情', status: 'pending' }] })] }], 's1'),
    ]);
    const { payload } = await prepareAnalysis(input, root, { maxBatchChars: 2000 });
    expect(payload.batches.length).toBeGreaterThan(1);
    const fn = vi.fn(async request => {
      if (request.schema.required[0] === 'groups') {
        const { candidates } = JSON.parse(request.prompt);
        return { costUsd: 0.01, value: { groups: [{ ids: candidates.map(c => c.id), reason: '同目录持续客户项目', evidence: candidates.flatMap(c => c.evidence) }] } };
      }
      const { messages } = JSON.parse(request.prompt);
      const creation = messages.find(m => m.tools.some(t => t.name === 'TodoWrite'));
      if (!creation) return { costUsd: 0.01, value: { projects: [] } };
      const sid = creation.sourceId;
      const status = creation.tools.flatMap(t => t.input.todos || []).find(todo => todo.content === '客户列表')?.status;
      return { costUsd: 0.01, value: { projects: [{ name: '客户中心', goal: '持续客户项目', summary: '',
        evidence: [ref(sid, '客户列表')], criteria: { longTerm: true, shortQA: false, reasons: ['持续'] }, tasks: [
          { id: 'a', name: '客户列表', description: '', sourceRefs: [ref(sid, '客户列表')], status },
          { id: 'b', name: '客户详情', description: '', sourceRefs: [ref(sid, '客户详情')] },
        ] }] } };
    });
    const result = await run(payload, fn);
    expect(result.candidates).toHaveLength(1);
    const tasks = result.candidates[0].tasks.filter(task => task.name === '客户列表');
    expect(tasks).toHaveLength(2);
    expect(tasks.map(task => task.status)).toEqual(['pending', 'pending']);
    expect(result.candidates[0].uncertainties.join('\n')).toMatch(/不同会话\/时序的结构化状态证据/);
  });
  it('missing dependency quote is excluded with warning, not a fake edge', async () => {
    const { payload } = await prepareAnalysis(data(), root); const raw = project(payload);
    raw.tasks[1].dependsOn = [{ id: 'a', sourceId: payload.sources[0].id }];
    const result = await run(payload, analyze({ projects: [raw] }));
    expect(result.candidates[0].tasks[1].dependsOn).toEqual([]); expect(result.coverage.warnings.join('\n')).toMatch(/依赖缺少.*quote/);
  });
  it.each([{ projects: 'bad' }, { projects: [{ name: 'missing' }] }, '```json\n{"projects":[]}\n```', { projects: [], sources: [] }])('malformed model output throws with no JSON/Markdown fallback', async value => {
    const { payload } = await prepareAnalysis(data(), root);
    await expect(run(payload, analyze(value))).rejects.toThrow(/Malformed analyzer response/);
  });
  it('unknown zero/negative costs accepted with warnings, no fictional statistics', async () => {
    const { payload } = await prepareAnalysis(data(), root);
    for (const costUsd of [0, -1]) {
      const result = await run(payload, async () => ({ value: { projects: [] }, costUsd }));
      expect(result.analysis.costUsd).toBe(0); expect(result.coverage.warnings.join('\n')).toMatch(/费用未知/);
    }
  });
  it('budget overshoot or exhaustion stops all processing with no partial return/retry', async () => {
    const payload = await multiple();
    const fn = vi.fn(async request => ({ value: { projects: [fromPrompt(request)] }, costUsd: 0.2 }));
    await expect(run(payload, fn, { maxBudgetUsd: 0.1 })).rejects.toThrow(/exceeded budget/); expect(fn).toHaveBeenCalledTimes(1);
    fn.mockClear(); await expect(run(payload, fn, { maxBudgetUsd: 0.2 })).rejects.toThrow(/budget exhausted/); expect(fn).toHaveBeenCalledTimes(1);
  });
  it('abort before and during a hanging analyzer throws, without retry', async () => {
    const { payload } = await prepareAnalysis(data(), root); const controller = new AbortController(); controller.abort();
    const fn = analyze({ projects: [] }); await expect(run(payload, fn, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(fn).not.toHaveBeenCalled();
    const active = new AbortController(); const hanging = vi.fn(() => new Promise(() => {}));
    const pending = run(payload, hanging, { signal: active.signal }); await Promise.resolve(); active.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(hanging.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('empty history makes zero calls and still honors abort', async () => {
    const { payload, plan } = await prepareAnalysis({ sessions: [], conversations: [] }, root);
    expect(plan.maxCalls).toBe(0); const fn = analyze({ projects: [] });
    const result = await run(payload, fn); expect(result.candidates).toEqual([]); expect(result.analysis.calls).toBe(0); expect(fn).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(run(payload, fn, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('exact decimal shared budget and progress report actual costs without floating point false rejection', async () => {
    const payload = await multiple(); const onProgress = vi.fn();
    const fn = vi.fn(async request => request.schema.required[0] === 'projects'
      ? { value: { projects: [fromPrompt(request)] }, costUsd: 0.1 }
      : { value: { groups: [] }, costUsd: 0.1 });
    const result = await run(payload, fn, { maxBudgetUsd: 0.3, onProgress });
    expect(result.analysis.calls).toBe(3); expect(result.analysis.costUsd).toBeCloseTo(0.3);
    expect(onProgress.mock.calls.at(-1)[0]).toMatchObject({ phase: 'validating', completed: 2, total: 2 });
    expect(result.analysis.inputChars).toBe(fn.mock.calls.reduce((sum, [call]) => sum + call.prompt.length, 0));
  });
  it('analyzer timeout/error propagates and progress excludes requestId', async () => {
    const { payload } = await prepareAnalysis(data(), root); const onProgress = vi.fn();
    const fn = vi.fn(async () => { throw new Error('CLI timeout'); }); await expect(run(payload, fn, { onProgress })).rejects.toThrow('CLI timeout'); expect(fn).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0][0]).toMatchObject({ phase: 'analyzing', completed: 0, total: 1, costUsd: 0 }); expect(onProgress.mock.calls[0][0]).not.toHaveProperty('requestId');
  });
});
