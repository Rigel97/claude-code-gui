import { beforeEach, describe, expect, it } from 'vitest';
import type { Conversation, UIBlock } from '../src/renderer/types';
import {
  applyEvent,
  applyEvents,
  createGraph,
  getRootId,
  getStatistics,
  replayGraph,
} from '../src/renderer/agent/model';
import { MAX_GRAPH_EVENTS, MAX_GRAPH_NODES } from '../src/renderer/agent/types';
import type { ExecutionEvent, ExecutionGraph, NodeStatus } from '../src/renderer/agent/types';
import { ClaudeEventAdapter, graphFromConversation } from '../src/renderer/agent/adapter';
import {
  DEMO_CONVERSATION_ID,
  DEMO_DURATION,
  DEMO_EVENTS,
  DEMO_INITIAL_TIME,
  DEMO_ROOT_ID,
  getDemoGraph,
} from '../src/renderer/agent/demo';
import { resetAgentRuntime, useAgentStore } from '../src/renderer/agent/store';

const CID = 'conv-a';
let seq = 0;
const nextId = () => `t-${++seq}`;

function ev(over: Partial<ExecutionEvent> & { timestamp: number }): ExecutionEvent {
  return { id: nextId(), conversationId: CID, source: 'live', kind: 'status', label: 'tick', ...over };
}

function nodeEv(id: string, timestamp: number, node: Record<string, unknown>, extra: Partial<ExecutionEvent> = {}): ExecutionEvent {
  return ev({ timestamp, nodeId: id, status: node.status as NodeStatus, delta: { node: { id, ...node } } as ExecutionEvent['delta'], ...extra });
}

const live = (events: ExecutionEvent[], cid = CID) => applyEvents(createGraph(cid, 'live'), events);

// ─── 基础 reducer ─────────────────────────────────────────

describe('model · 创建与统计', () => {
  it('空图只有根节点，状态未知且指标为空', () => {
    const g = createGraph(CID, 'live', '标题', '/proj');
    const root = g.nodes[getRootId(CID)];
    expect(Object.keys(g.nodes)).toHaveLength(1);
    expect(root.type).toBe('core');
    expect(root.status).toBe('unknown');
    expect(g.status).toBe('unknown');
    expect(g.startedAt).toBeNull();
    expect(g.endedAt).toBeNull();
    expect(g.metrics).toEqual({ inputTokens: null, outputTokens: null, cacheTokens: null, costUsd: null, durationMs: null, turns: null, model: null });
  });

  it('统计按类型与状态归类', () => {
    const g = live([
      nodeEv('agent:1', 10, { type: 'agent', label: 'A', status: 'running' }),
      nodeEv('agent:2', 11, { type: 'agent', label: 'B', status: 'completed' }),
      nodeEv('tool:1', 12, { type: 'tool', label: 'T', status: 'retrying' }),
      nodeEv('file:1', 13, { type: 'file', label: 'F', status: 'completed' }),
      nodeEv('task:1', 14, { type: 'task', label: 'K', status: 'error' }),
    ]);
    expect(getStatistics(g)).toEqual({ nodes: 6, agents: 2, tools: 1, files: 1, tasks: 1, running: 2, completed: 2, errors: 2 });
  });
});

describe('model · 防御', () => {
  it('忽略别的会话、重复事件与空 id', () => {
    const g = createGraph(CID, 'live');
    const other = nodeEv('x', 10, { type: 'tool', status: 'running' }, { conversationId: 'other' });
    expect(applyEvent(g, other)).toBe(g);
    const good = nodeEv('x', 10, { type: 'tool', label: 'X', status: 'running' });
    const once = applyEvent(g, good);
    expect(once).not.toBe(g);
    expect(applyEvent(once, good)).toBe(once);
    expect(applyEvent(g, { ...good, id: '' })).toBe(g);
  });

  it('live 与 demo 事件互斥，history 可接收 live', () => {
    const g = createGraph(CID, 'live');
    expect(applyEvent(g, nodeEv('d', 1, { type: 'tool', status: 'running' }, { source: 'demo' }))).toBe(g);
    const h = createGraph(CID, 'history', '历史', '/p');
    const applied = applyEvent(h, nodeEv('t', 2, { type: 'tool', label: 'T', status: 'running' }));
    expect(applied.nodes.t).toBeTruthy();
    expect(applied.title).toBe('历史');
  });

  it('lastEventAt 单调、终止态不回退、sequence 稳定', () => {
    let g = createGraph(CID, 'live');
    g = applyEvent(g, nodeEv('t', 500, { type: 'tool', label: 'T', status: 'running' }));
    g = applyEvent(g, nodeEv('t', 300, { type: 'tool', status: 'running' }));
    expect(g.nodes.t.lastEventAt).toBeGreaterThanOrEqual(500);
    g = applyEvent(g, nodeEv('t', 600, { type: 'tool', status: 'completed', endedAt: 600 }));
    const sequence = g.nodes.t.sequence;
    g = applyEvent(g, nodeEv('t', 400, { type: 'tool', status: 'running' }));
    expect(g.nodes.t.status).toBe('completed');
    expect(g.nodes.t.sequence).toBe(sequence);
  });

  it('图终态不被迟到的 running 或会话初始化回退', () => {
    let g = createGraph(CID, 'live');
    g = applyEvent(g, ev({ timestamp: 100, status: 'running', delta: { graph: { status: 'running' } } }));
    g = applyEvent(g, ev({ timestamp: 200, status: 'completed', delta: { graph: { status: 'completed', endedAt: 200 } } }));
    g = applyEvent(g, ev({ timestamp: 300, status: 'running', label: 'late requesting' }));
    g = applyEvent(g, ev({ timestamp: 400, kind: 'session', status: 'running', delta: { graph: { status: 'running' } } }));
    expect(g.status).toBe('completed');
    expect(g.endedAt).toBe(200);
    expect(g.nodes[getRootId(CID)].status).toBe('completed');
  });

  it('畸形节点字段被忽略，悬空边不建立', () => {
    let g = createGraph(CID, 'live');
    g = applyEvent(g, ev({ timestamp: 5, delta: { edge: { source: 'ghost', target: 'ghost2', kind: 'call' } } }));
    expect(Object.keys(g.edges)).toHaveLength(0);
    g = applyEvent(g, nodeEv('a', 6, { type: 'unknown-type', label: 'A', status: 'nonsense' }));
    expect(g.nodes.a.type).toBe('tool');
    expect(g.nodes.a.status).toBe('pending');
  });
});

// ─── live 文件节点 ────────────────────────────────────────

describe('adapter · live 文件节点', () => {
  it('Read 观测到 file_path 时创建文件节点与 read 边，状态跟随工具', () => {
    const a = new ClaudeEventAdapter();
    a.ingest({ type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/p', conversationId: CID });
    const events = [
      ...a.ingest({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/p/src/a.ts' } }] },
        parent_tool_use_id: null,
        conversationId: CID,
      }),
    ];
    const running = live(events);
    const rootId = getRootId(CID);
    const toolId = 'tool:conv-a:r1';
    expect(running.nodes[toolId].parentId).toBe(rootId);
    expect(running.edges[`e:${rootId}->${toolId}:call`]).toMatchObject({ kind: 'call', status: 'running' });
    const fileId = 'file:/p/src/a.ts';
    expect(running.nodes[fileId]).toBeTruthy();
    expect(running.nodes[fileId].type).toBe('file');
    expect(running.nodes[fileId].filePath).toBe('/p/src/a.ts');
    expect(running.nodes[fileId].parentId).toBe('tool:conv-a:r1');
    expect(running.nodes[fileId].status).toBe('running');
    expect(running.edges[`e:tool:conv-a:r1->${fileId}:read`]).toMatchObject({ kind: 'read', status: 'running' });

    const done = live([
      ...events,
      ...a.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'ok' }] }, conversationId: CID }),
    ]);
    expect(done.nodes[fileId].status).toBe('completed');
    expect(done.nodes[fileId].endedAt).toBeTruthy();
  });

  it('Edit/Write 创建 write 边；工具失败时文件为 error', () => {
    const a = new ClaudeEventAdapter();
    const events = [
      ...a.ingest({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'w1', name: 'Edit', input: { file_path: '/p/x.ts', old_string: 'a', new_string: 'b' } }] },
        parent_tool_use_id: null,
        conversationId: CID,
      }),
      ...a.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'fail', is_error: true }] }, conversationId: CID }),
    ];
    const g = live(events);
    expect(g.nodes['file:/p/x.ts'].status).toBe('error');
    expect(g.edges['e:tool:conv-a:w1->file:/p/x.ts:write'].status).toBe('error');
  });

  it('同一文件多次操作复用同一节点，并记录操作类型', () => {
    const a = new ClaudeEventAdapter();
    const g = live([
      ...a.ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/p/a.ts' } }] }, parent_tool_use_id: null, conversationId: CID }),
      ...a.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'x' }] }, conversationId: CID }),
      ...a.ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' } }] }, parent_tool_use_id: null, conversationId: CID }),
    ]);
    const files = Object.values(g.nodes).filter((n) => n.type === 'file');
    expect(files).toHaveLength(1);
    expect(files[0].metadata?.operations).toEqual(['Read', 'Edit']);
    expect(Object.values(g.edges).filter((e) => e.target === 'file:/p/a.ts').map((e) => e.kind).sort()).toEqual(['read', 'write']);
  });

  it('out-of-order：result 早到后输入回填，文件节点也进入 completed', () => {
    const a = new ClaudeEventAdapter();
    const resultFirst = a.ingest({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'late', content: 'done' }] },
      conversationId: CID,
    });
    const placeholder = live(resultFirst);
    expect(Object.values(placeholder.nodes).find((n) => n.type === 'file')).toBeUndefined();

    const backfilled = a.ingest({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'late', name: 'Read', input: { file_path: '/p/late.ts' } }] },
      parent_tool_use_id: null,
      conversationId: CID,
    });
    const g = live([...resultFirst, ...backfilled]);
    expect(g.nodes['tool:conv-a:late'].toolName).toBe('Read');
    expect(g.nodes['tool:conv-a:late'].status).toBe('completed');
    expect(g.nodes['file:/p/late.ts'].status).toBe('completed');
    expect(g.edges['e:tool:conv-a:late->file:/p/late.ts:read'].status).toBe('completed');
  });

  it('缺少 result 的工具与文件保持 running，不推断成功', () => {
    const a = new ClaudeEventAdapter();
    const g = live([
      ...a.ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r9', name: 'Read', input: { file_path: '/p/r9.ts' } }] }, parent_tool_use_id: null, conversationId: CID }),
      ...a.ingest({ type: 'result', subtype: 'success', is_error: false, session_id: 's', conversationId: CID }),
    ]);
    expect(g.nodes['tool:conv-a:r9'].status).toBe('running');
    expect(g.nodes['file:/p/r9.ts'].status).toBe('running');
  });
});

// ─── 事件链（指标 / 错误 / 父子 / 任务） ─────────────────────

describe('adapter · 事件链', () => {
  const init = (cid = CID) => ({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-5', cwd: '/p', conversationId: cid });

  it('stderr 普通 warning 仅观测，明确 API 错误才是 error', () => {
    const a = new ClaudeEventAdapter();
    const warn = a.ingest({ type: 'stderr', text: 'warning: unknown option --foo', conversationId: CID });
    expect(warn.every((e) => e.kind === 'status')).toBe(true);
    const err = a.ingest({ type: 'stderr', text: 'API Error: 429 rate limit exceeded', conversationId: CID });
    expect(err.some((e) => e.kind === 'error')).toBe(true);
  });

  it('指标只取本 run 的 result，同一 result 不重复；缺失为 null', () => {
    const a = new ClaudeEventAdapter();
    a.ingest(init());
    const first = a.ingest({
      type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', duration_ms: 900, num_turns: 2,
      total_cost_usd: 0.03, usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 }, conversationId: CID,
    });
    const again = a.ingest({
      type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', duration_ms: 900, num_turns: 2,
      total_cost_usd: 0.03, usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 }, conversationId: CID,
    });
    expect(first.some((e) => e.kind === 'metrics')).toBe(true);
    expect(again.some((e) => e.kind === 'metrics')).toBe(false);
    const g = live(first);
    expect(g.metrics).toMatchObject({ inputTokens: 100, outputTokens: 40, cacheTokens: 15, costUsd: 0.03, turns: 2, model: 'claude-sonnet-4-5' });
    expect('contextTokens' in g.metrics).toBe(false);
  });

  it('父子关系来自 parent_tool_use_id，Agent 节点为 agent 类型', () => {
    const a = new ClaudeEventAdapter();
    const g = live([
      ...a.ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: '调研' } }] }, parent_tool_use_id: null, conversationId: CID }),
      ...a.ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'sub', name: 'Grep', input: { pattern: 'x' } }] }, parent_tool_use_id: 'ag', conversationId: CID }),
    ]);
    expect(g.nodes['tool:conv-a:ag'].type).toBe('agent');
    expect(g.nodes['tool:conv-a:sub'].parentId).toBe('tool:conv-a:ag');
    expect(Object.values(g.edges).some((e) => e.kind === 'delegation')).toBe(true);
  });

  it('TodoWrite 的 input.todos 生成 task 节点', () => {
    const a = new ClaudeEventAdapter();
    const g = live([
      ...a.ingest({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'td', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] } }] },
        parent_tool_use_id: null,
        conversationId: CID,
      }),
      ...a.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'td', content: 'ok' }] }, conversationId: CID }),
    ]);
    const tasks = Object.values(g.nodes).filter((n) => n.type === 'task');
    expect(tasks.map((t) => t.status).sort()).toEqual(['completed', 'running']);
  });

  it('aborted 后的残流被丢弃，直到新一轮 starting', () => {
    const a = new ClaudeEventAdapter();
    a.ingest(init());
    a.ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'run1', name: 'Bash', input: { command: 'sleep 1' } }] }, parent_tool_use_id: null, conversationId: CID });
    const aborted = a.status({ conversationId: CID, status: 'aborted' });
    expect(aborted.some((e) => e.delta?.node?.status === 'cancelled')).toBe(true);
    expect(a.ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ghost', name: 'Read' }] }, parent_tool_use_id: null, conversationId: CID })).toEqual([]);
    expect(a.status({ conversationId: CID, status: 'starting' }).length).toBeGreaterThan(0);
    expect(a.ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fresh', name: 'Read' }] }, parent_tool_use_id: null, conversationId: CID }).length).toBeGreaterThan(0);
  });

  it('没有 conversationId 的消息不产生事件', () => {
    const a = new ClaudeEventAdapter();
    expect(a.ingest({ type: 'assistant', message: { content: [] } })).toEqual([]);
    expect(a.status({ status: 'starting' })).toEqual([]);
  });
});

// ─── 历史回填 ─────────────────────────────────────────────

const toolBlock = (over: Partial<Extract<UIBlock, { kind: 'tool_use' }>> & { toolId: string; toolName: string }): UIBlock =>
  ({ kind: 'tool_use', input: {}, status: 'done', ...over }) as UIBlock;

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'hist-1', title: '历史会话', sessionId: 'sess-hist', cwd: '/proj', messages: [], streamingMessage: null,
  status: 'completed', thinkingTokens: 0, contextUsage: null, queue: [], currentModel: 'claude-sonnet-4-5', draft: '', activity: null, todoList: null,
  ...over,
});

describe('adapter · graphFromConversation', () => {
  it('children 结构还原父子，thinking 不建模，文件节点由工具派生', () => {
    const agent = toolBlock({
      toolId: 'a1', toolName: 'Agent', input: { description: '调研' },
      children: [toolBlock({ toolId: 'c1', toolName: 'Read', input: { file_path: '/p/a.ts' }, result: 'x' })],
    });
    const g = graphFromConversation(conversation({
      messages: [{ id: 'm1', role: 'assistant', timestamp: 1000, status: 'completed', blocks: [{ kind: 'thinking', text: '内心戏' }, agent] }],
    }));
    expect(g.source).toBe('history');
    expect(g.nodes['tool:hist-1:a1'].type).toBe('agent');
    expect(g.nodes['tool:hist-1:c1'].parentId).toBe('tool:hist-1:a1');
    expect(g.nodes['file:/p/a.ts'].status).toBe('completed');
    expect(Object.values(g.nodes).some((n) => n.label.includes('内心戏'))).toBe(false);
  });

  it('缺失 result 的工具保持 running；指标只取最后一条 stats', () => {
    const stats = (input: number) => ({
      kind: 'stats' as const,
      data: { type: 'result' as const, subtype: 'success' as const, is_error: false, duration_ms: 500, duration_api_ms: 400, num_turns: 3, result: 'ok', session_id: 'sess-hist', total_cost_usd: 0.05, usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }, terminal_reason: 'end', ttft_ms: 1 },
    });
    const g = graphFromConversation(conversation({
      messages: [
        { id: 'm1', role: 'assistant', timestamp: 1, status: 'completed', blocks: [toolBlock({ toolId: 'r1', toolName: 'Read', status: 'running', input: { file_path: '/p/r.ts' } }), stats(100)] },
        { id: 'm2', role: 'assistant', timestamp: 2, status: 'completed', blocks: [stats(200)] },
      ],
    }));
    expect(g.nodes['tool:hist-1:r1'].status).toBe('running');
    expect(g.nodes['file:/p/r.ts'].status).toBe('running');
    expect(g.metrics.inputTokens).toBe(200);
  });
});

// ─── 有界与回放 ───────────────────────────────────────────

describe('model · 有界与回放', () => {
  it('节点上限 240（core 不计），优先丢已完成', () => {
    const events: ExecutionEvent[] = [];
    for (let i = 0; i < MAX_GRAPH_NODES + 30; i++) events.push(nodeEv(`d${i}`, 100 + i, { type: 'tool', label: `D${i}`, status: 'completed' }));
    events.push(nodeEv('active', 50, { type: 'tool', label: 'A', status: 'running' }));
    const g = live(events);
    expect(Object.values(g.nodes).filter((n) => n.type !== 'core').length).toBeLessThanOrEqual(MAX_GRAPH_NODES);
    expect(g.nodes.active).toBeTruthy();
    expect(g.droppedNodes).toBeGreaterThan(0);
  });

  it('事件上限触发基线快照；回放早于基线时被钳制并给出 replayStart', () => {
    const events: ExecutionEvent[] = [];
    events.push(nodeEv('early', 100, { type: 'tool', label: 'EARLY', status: 'running', startedAt: 100 }));
    events.push(nodeEv('early', 200, { type: 'tool', status: 'completed', endedAt: 200 }));
    for (let i = 0; i < MAX_GRAPH_EVENTS + 20; i++) events.push(nodeEv('filler', 1000 + i, { type: 'tool', label: 'F', status: 'completed' }));
    const g = live(events);
    expect(g.events.length).toBe(MAX_GRAPH_EVENTS);
    expect(g.droppedEvents).toBeGreaterThan(0);
    const baseline = g.internal!.baseline!;
    expect(g.internal!.baselineNodes).toBeTruthy();
    // 基线快照保留「裁剪时刻」的真实状态：early 已完成
    expect(g.internal!.baselineNodes!.early.status).toBe('completed');

    const replay = replayGraph(g, 0);
    expect(replay.replayStart).toBe(baseline.timestamp);
    expect(replay.replayTime).toBe(baseline.timestamp);
    expect(replay.endedAt).not.toBe(replay.replayTime);
  });

  it('回放不出现 ghost 完成，也不把 endedAt 当成当前时刻', () => {
    const g = live([
      nodeEv('t', 100, { type: 'tool', label: 'T', status: 'running', startedAt: 100 }),
      nodeEv('t', 900, { type: 'tool', status: 'completed', endedAt: 900 }),
    ]);
    const mid = replayGraph(g, 500);
    expect(mid.nodes.t.status).toBe('running');
    expect(mid.nodes.t.endedAt).toBeUndefined();
    expect(mid.endedAt).toBeNull();
    expect(mid.replayTime).toBe(500);
    const end = replayGraph(g, 1000);
    expect(end.nodes.t.status).toBe('completed');
    expect(end.endedAt).toBe(900); // 该节点确实在 900 结束
  });

  it('回放不可变、可重复', () => {
    const g = live([nodeEv('t', 10, { type: 'tool', label: 'T', status: 'running' })]);
    const before = JSON.stringify(g);
    const a = replayGraph(g, 20);
    const b = replayGraph(g, 20);
    expect(JSON.stringify(g)).toBe(before);
    expect(Object.keys(a.nodes).sort()).toEqual(Object.keys(b.nodes).sort());
    expect(Object.values(a.nodes).map((n) => n.sequence)).toEqual(Object.values(b.nodes).map((n) => n.sequence));
  });
});

// ─── store ───────────────────────────────────────────────

describe('store · useAgentStore', () => {
  beforeEach(() => {
    resetAgentRuntime();
    useAgentStore.setState({ open: false, mode: 'live', live: {} });
  });

  const conv = (id: string, over: Partial<Conversation> = {}) => conversation({ id, sessionId: `s-${id}`, title: `会话 ${id}`, ...over });

  it('初始 open=false / mode=live', () => {
    expect(useAgentStore.getState().open).toBe(false);
    expect(useAgentStore.getState().mode).toBe('live');
    useAgentStore.getState().show('demo');
    expect(useAgentStore.getState()).toMatchObject({ open: true, mode: 'demo' });
    useAgentStore.getState().hide();
    expect(useAgentStore.getState().open).toBe(false);
  });

  it('无 conversationId 的消息不落到当前会话', () => {
    useAgentStore.getState().syncConversations([conv(CID)]);
    const before = useAgentStore.getState().live[CID];
    useAgentStore.getState().ingestStream({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read' }] } });
    useAgentStore.getState().ingestStatus({ status: 'starting' });
    expect(useAgentStore.getState().live[CID]).toBe(before);
  });

  it('多会话隔离', () => {
    useAgentStore.getState().syncConversations([conv('conv-a'), conv('conv-b')]);
    useAgentStore.getState().ingestStatus({ conversationId: 'conv-a', status: 'starting' });
    useAgentStore.getState().ingestStatus({ conversationId: 'conv-b', status: 'starting' });
    useAgentStore.getState().ingestStream({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/a.ts' } }] }, parent_tool_use_id: null, conversationId: 'conv-a' });
    const liveAfter = useAgentStore.getState().live;
    expect(liveAfter['conv-a'].nodes['tool:conv-a:a']).toBeTruthy();
    expect(liveAfter['conv-a'].nodes['file:/a.ts']).toBeTruthy();
    expect(liveAfter['conv-b'].nodes['tool:conv-a:a']).toBeUndefined();
  });

  it('starting 沿用已同步的标题 / 项目路径 / sessionId', () => {
    useAgentStore.getState().syncConversations([conv('conv-t', { title: '真实标题', cwd: '/real/project' })]);
    useAgentStore.getState().ingestStatus({ conversationId: 'conv-t', status: 'starting' });
    const graph = useAgentStore.getState().live['conv-t'];
    expect(graph.title).toBe('真实标题');
    expect(graph.projectPath).toBe('/real/project');
    expect(graph.sessionId).toBe('s-conv-t');
    expect(graph.nodes[getRootId('conv-t')].label).toBe('真实标题');
  });

  it('已关闭会话的 starting 不会复活', () => {
    useAgentStore.getState().syncConversations([conv('conv-x')]);
    useAgentStore.getState().ingestStatus({ conversationId: 'conv-x', status: 'starting' });
    expect(useAgentStore.getState().live['conv-x']).toBeTruthy();
    useAgentStore.getState().syncConversations([]);
    expect(useAgentStore.getState().live['conv-x']).toBeUndefined();
    useAgentStore.getState().ingestStatus({ conversationId: 'conv-x', status: 'starting' });
    useAgentStore.getState().ingestStream({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'z', name: 'Read' }] }, parent_tool_use_id: null, conversationId: 'conv-x' });
    expect(useAgentStore.getState().live['conv-x']).toBeUndefined();
  });

  it('history 图接收 live 事件时保留标题与已生成事件', () => {
    const c = conv('conv-h', { title: '历史标题', cwd: '/h' });
    c.messages = [{ id: 'm1', role: 'assistant', timestamp: 10, status: 'completed', blocks: [toolBlock({ toolId: 'h1', toolName: 'Read', input: { file_path: '/p/h.ts' }, result: 'x' })] }];
    useAgentStore.getState().syncConversations([c]);
    const history = useAgentStore.getState().live['conv-h'];
    expect(history.source).toBe('history');
    useAgentStore.getState().ingestStream({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'n1', name: 'Write', input: { file_path: '/p/n.ts' } }] }, parent_tool_use_id: null, conversationId: 'conv-h' });
    const merged = useAgentStore.getState().live['conv-h'];
    expect(merged.title).toBe('历史标题');
    expect(merged.nodes['tool:conv-h:h1']).toBeTruthy();
    expect(merged.nodes['tool:conv-h:n1']).toBeTruthy();
    expect(merged.nodes['file:/p/n.ts']).toBeTruthy();
  });

  it('aborted 后残流丢弃，新 starting 重置', () => {
    useAgentStore.getState().syncConversations([conv('conv-r')]);
    useAgentStore.getState().ingestStatus({ conversationId: 'conv-r', status: 'starting' });
    useAgentStore.getState().ingestStream({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Bash', input: { command: 'x' } }] }, parent_tool_use_id: null, conversationId: 'conv-r' });
    useAgentStore.getState().ingestStatus({ conversationId: 'conv-r', status: 'aborted' });
    useAgentStore.getState().ingestStream({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ghost', name: 'Read' }] }, parent_tool_use_id: null, conversationId: 'conv-r' });
    expect(useAgentStore.getState().live['conv-r'].nodes['tool:conv-r:ghost']).toBeUndefined();
    useAgentStore.getState().ingestStatus({ conversationId: 'conv-r', status: 'starting' });
    expect(useAgentStore.getState().live['conv-r'].nodes['tool:conv-r:r1']).toBeUndefined();
    expect(useAgentStore.getState().live['conv-r'].status).toBe('running');
  });
});

// ─── DEMO ────────────────────────────────────────────────

describe('demo · 时间线', () => {
  it('事件按时间排序、无 future 泄漏、source 恒为 demo', () => {
    const times = DEMO_EVENTS.map((e) => e.timestamp);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(DEMO_EVENTS.every((e) => e.source === 'demo')).toBe(true);
    expect(DEMO_EVENTS.every((e) => e.conversationId === DEMO_CONVERSATION_ID)).toBe(true);
    expect(DEMO_DURATION).toBe(120000);
    expect(DEMO_INITIAL_TIME).toBe(65000);
  });

  it('未完成的节点在开始时不带 output / error / endedAt', () => {
    const finalEnd: Record<string, number> = {};
    for (const e of DEMO_EVENTS) if (e.delta?.node?.endedAt) finalEnd[e.delta.node.id] = e.delta.node.endedAt;
    for (const e of DEMO_EVENTS) {
      const node = e.delta?.node;
      if (!node || !node.startedAt) continue;
      if (node.endedAt !== undefined) continue;
      const future = finalEnd[node.id];
      if (future === undefined) continue;
      if (e.timestamp >= future) continue;
      expect(node.output).toBeUndefined();
      expect(node.error).toBeUndefined();
    }
  });

  it('65 秒：30~42 节点、4 agent（2 个运行中）、6~8 文件、失败与重试、审批阻塞', () => {
    const g = getDemoGraph(DEMO_INITIAL_TIME);
    const nodes = Object.values(g.nodes);
    const nonCore = nodes.filter((n) => n.type !== 'core');
    expect(nonCore.length).toBeGreaterThanOrEqual(30);
    expect(nonCore.length).toBeLessThanOrEqual(42);

    const agents = nodes.filter((n) => n.type === 'agent');
    expect(agents).toHaveLength(4);
    expect(agents.filter((a) => a.status === 'running')).toHaveLength(2);
    expect(agents.every((a) => a.parentId === DEMO_ROOT_ID)).toBe(true);

    const files = nodes.filter((n) => n.type === 'file');
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files.length).toBeLessThanOrEqual(8);
    for (const f of files) {
      expect(f.filePath).toBeTruthy();
      const owner = f.parentId ? g.nodes[f.parentId] : undefined;
      expect(owner?.type).toBe('tool');
      expect(['running', 'completed', 'error']).toContain(f.status);
    }

    expect(nodes.some((n) => n.type === 'tool' && n.status === 'error')).toBe(true);
    expect(g.nodes['tool:retry-test'].status).toBe('retrying');
    expect(g.nodes['task:approval'].status).toBe('blocked');
    expect(Object.values(g.edges).some((e) => e.kind === 'retry')).toBe(true);
    expect(nodes.filter((n) => n.status === 'completed').length).toBeGreaterThanOrEqual(10);
  });

  it('任务按时间推进 pending → running → completed', () => {
    const early = getDemoGraph(2000);
    expect(['pending', 'unknown']).toContain(early.nodes['task:panel'].status); // 未开始的任务不臆断为完成
    const mid = getDemoGraph(64000);
    expect(mid.nodes['task:spec'].status).toBe('completed');
    expect(mid.nodes['task:tests'].status).toBe('running'); // 64s 时测试任务仍在进行
    expect(mid.nodes['task:reducer'].status).toBe('completed');
    const late = getDemoGraph(DEMO_DURATION);
    expect(late.nodes['task:spec'].status).toBe('completed');
  });

  it('所有边端点合法，agent 边为 delegation', () => {
    for (const t of [30000, 65000, 100000, DEMO_DURATION]) {
      const g = getDemoGraph(t);
      for (const edge of Object.values(g.edges)) {
        expect(g.nodes[edge.source]).toBeTruthy();
        expect(g.nodes[edge.target]).toBeTruthy();
        expect(edge.source).not.toBe(edge.target);
      }
      const delegationTargets = Object.values(g.edges).filter((e) => e.kind === 'delegation').map((e) => e.target);
      expect([...delegationTargets].sort()).toEqual(['agent:architect', 'agent:builder', 'agent:scout', 'agent:tester'].sort());
    }
  });

  it('结束时根节点完成，且没有进行中的节点动画', () => {
    const g = getDemoGraph(DEMO_DURATION);
    expect(g.status).toBe('completed');
    expect(g.nodes[DEMO_ROOT_ID].status).toBe('completed');
    const active = Object.values(g.nodes).filter((n) => n.status === 'running' || n.status === 'retrying');
    expect(active).toHaveLength(0);
    expect(g.endedAt).toBeTruthy();
    expect(g.replayTime).toBeUndefined();
  });

  it('回放确定且无 ghost 完成', () => {
    for (const t of [0, 8000, 25000, 65000, 90000, DEMO_DURATION]) {
      const a = getDemoGraph(t);
      const b = getDemoGraph(t);
      expect(Object.keys(a.nodes).sort()).toEqual(Object.keys(b.nodes).sort());
      expect(Object.values(a.nodes).map((n) => `${n.id}:${n.status}`)).toEqual(Object.values(b.nodes).map((n) => `${n.id}:${n.status}`));
    }
    const at0 = getDemoGraph(0);
    expect(Object.values(at0.nodes).every((n) => n.status !== 'completed')).toBe(true);
    const beforeFail = getDemoGraph(20000);
    expect(beforeFail.nodes['tool:test-fail'].status).toBe('running');
    expect(beforeFail.nodes['tool:test-fail'].error).toBeUndefined();
  });
});

// ─── 回归：基线折叠回放 / 序号稳定 / 指标清理 / 文件重开 ──────

describe('model · 基线折叠回放（无未来泄漏）', () => {
  it('1205+ 事件裁剪后，基线快照由事件折叠得到，回放过去无未来指标与输出', () => {
    const events: ExecutionEvent[] = [];
    events.push(nodeEv('early', 100, { type: 'tool', label: 'EARLY', status: 'running', startedAt: 100, input: { cmd: 'early' } }));
    events.push(nodeEv('early', 200, { type: 'tool', status: 'completed', endedAt: 200, output: 'early-out' }));
    for (let i = 0; i < MAX_GRAPH_EVENTS + 10; i++) {
      events.push(nodeEv(`f${i}`, 1000 + i, { type: 'tool', label: `F${i}`, status: 'completed', endedAt: 1000 + i }));
    }
    // 指标只出现在窗口末尾（未来）
    events.push(ev({ timestamp: 50000, kind: 'metrics', delta: { metrics: { inputTokens: 9999, outputTokens: 8888, costUsd: 0.42 } } }));
    const g = live(events);
    expect(g.internal?.baselineSnapshot).toBeTruthy();
    expect(g.droppedEvents).toBeGreaterThan(0);
    expect(g.events.length).toBe(MAX_GRAPH_EVENTS);

    const past = replayGraph(g, 300);
    expect(past.replayStart).toBe(g.internal!.baseline!.timestamp);
    // 回放过去：无未来指标
    expect(past.metrics.inputTokens).toBeNull();
    expect(past.metrics.outputTokens).toBeNull();
    expect(past.metrics.costUsd).toBeNull();
    // 早期工具状态真实：来自事件折叠，带当时的输入输出
    expect(past.nodes.early.status).toBe('completed');
    expect(past.nodes.early.output).toBe('early-out');
    expect(past.nodes.early.input).toEqual({ cmd: 'early' });
    // 未来节点不出现
    expect(past.nodes.f800).toBeUndefined();

    const now = replayGraph(g, 60000);
    expect(now.metrics.inputTokens).toBe(9999);
    // 与 live 图一致：回放结果同样受 240 节点预算约束，早期节点可被裁掉
    expect(Object.values(now.nodes).filter((n) => n.type !== 'core').length).toBeLessThanOrEqual(MAX_GRAPH_NODES);
    expect(now.nodes.f1209?.status).toBe('completed'); // 保留窗口内最新的事件正常重放
  });

  it('同一时刻的回放序号不随全图增长漂移', () => {
    const head: ExecutionEvent[] = [];
    for (let i = 0; i < 40; i++) head.push(nodeEv(`a${i}`, 100 + i, { type: 'tool', label: `A${i}`, status: 'completed' }));
    const tail: ExecutionEvent[] = [];
    for (let i = 0; i < 40; i++) tail.push(nodeEv(`b${i}`, 1000 + i, { type: 'tool', label: `B${i}`, status: 'completed' }));
    const small = replayGraph(live(head), 500);
    const big = replayGraph(live([...head, ...tail]), 500);
    const seqOf = (g: ExecutionGraph) => Object.fromEntries(Object.values(g.nodes).map((n) => [n.id, n.sequence]));
    const sa = seqOf(small);
    const sb = seqOf(big);
    for (const [id, seq] of Object.entries(sa)) expect(sb[id]).toBe(seq);
  });
});

describe('model · 指标增量', () => {
  it('显式 null 清空旧值，负数与非有限值被忽略', () => {
    let g = live([ev({ timestamp: 10, kind: 'metrics', delta: { metrics: { inputTokens: 100, costUsd: 0.1 } } })]);
    expect(g.metrics.inputTokens).toBe(100);
    g = applyEvent(g, ev({ timestamp: 20, kind: 'metrics', delta: { metrics: { inputTokens: -5, costUsd: 0.2 } } }));
    expect(g.metrics.inputTokens).toBe(100); // 负数忽略，不覆盖旧值
    expect(g.metrics.costUsd).toBe(0.2);
    g = applyEvent(g, ev({ timestamp: 30, kind: 'metrics', delta: { metrics: { inputTokens: null } } }));
    expect(g.metrics.inputTokens).toBeNull(); // 显式 null 清空（新一轮 run 回到未知）
    expect(g.metrics.costUsd).toBe(0.2);
  });
});

describe('model · 文件节点重开', () => {
  it('Read completed → Edit running → Edit failed：文件重开、保留序号、记录操作', () => {
    const fileId = 'file:/p/a.ts';
    let g = live([nodeEv('tool:r1', 100, { type: 'tool', toolName: 'Read', filePath: '/p/a.ts', relatedFiles: ['/p/a.ts'], status: 'running', startedAt: 100 })]);
    const seq0 = g.nodes[fileId].sequence;
    g = applyEvent(g, nodeEv('tool:r1', 200, { status: 'completed', endedAt: 200, output: 'ok' }));
    expect(g.nodes[fileId].status).toBe('completed');
    expect(g.nodes[fileId].endedAt).toBe(200);

    g = applyEvent(g, nodeEv('tool:e1', 300, { type: 'tool', toolName: 'Edit', filePath: '/p/a.ts', relatedFiles: ['/p/a.ts'], status: 'running', startedAt: 300 }));
    expect(g.nodes[fileId].status).toBe('running');
    expect(g.nodes[fileId].endedAt).toBeUndefined();
    expect(g.nodes[fileId].startedAt).toBe(300);
    expect(g.nodes[fileId].sequence).toBe(seq0);
    expect(g.nodes[fileId].metadata?.operations).toEqual(['Read', 'Edit']);

    g = applyEvent(g, nodeEv('tool:e1', 400, { status: 'error', endedAt: 400, error: 'boom' }));
    expect(g.nodes[fileId].status).toBe('error');
    expect(g.nodes[fileId].endedAt).toBe(400);
  });

  it('直接文件节点补丁也允许 completed → running 重开', () => {
    let g = live([nodeEv('f', 100, { type: 'file', label: 'a.ts', status: 'completed', startedAt: 100, endedAt: 150 })]);
    expect(g.nodes.f.status).toBe('completed');
    g = applyEvent(g, nodeEv('f', 300, { type: 'file', status: 'running', startedAt: 300 }));
    expect(g.nodes.f.status).toBe('running');
    expect(g.nodes.f.endedAt).toBeUndefined();
    expect(g.nodes.f.startedAt).toBe(300);
  });

  it('普通工具失败后，迟到的旧 start 不覆盖 error', () => {
    let g = live([nodeEv('tool:x', 100, { type: 'tool', label: 'X', status: 'running', startedAt: 100 })]);
    g = applyEvent(g, nodeEv('tool:x', 200, { status: 'error', endedAt: 200, error: 'boom' }));
    g = applyEvent(g, nodeEv('tool:x', 150, { status: 'running' }));
    expect(g.nodes['tool:x'].status).toBe('error');
    expect(g.nodes['tool:x'].startedAt).toBe(100);
  });
});

describe('demo · 时间线合法性', () => {
  it('不引用项目中不存在的脚本或工具', () => {
    const texts = DEMO_EVENTS.map((e) => JSON.stringify(e.delta ?? {})).join('\n');
    expect(texts).not.toContain('replay-sample.mjs');
    expect(texts).not.toContain('eslint');
  });

  it('节点与父子时间合法：子节点不晚于父节点结束，先开始后结束', () => {
    const full = getDemoGraph(DEMO_DURATION);
    for (const n of Object.values(full.nodes)) {
      if (n.startedAt !== undefined && n.endedAt !== undefined) {
        expect(n.endedAt).toBeGreaterThanOrEqual(n.startedAt);
      }
      const parent = n.parentId ? full.nodes[n.parentId] : undefined;
      // 共享文件节点的 parent 只是首个观测工具，可被后续工具重新操作，不作父子时间约束
      if (parent && parent.type !== 'core' && n.type !== 'file' && n.endedAt !== undefined && parent.endedAt !== undefined) {
        expect(n.endedAt).toBeLessThanOrEqual(parent.endedAt);
      }
    }
    // TodoWrite 在 1.6s 只反映当时进度，不泄漏未来
    const todos = (full.nodes['tool:todo'].input as { todos: { content: string; status: string }[] }).todos;
    expect(todos.find((t) => t.content === '梳理数据层接口')?.status).toBe('in_progress');
    expect(todos.find((t) => t.content === '实现 reducer 与文件节点')?.status).toBe('pending');
  });
});
