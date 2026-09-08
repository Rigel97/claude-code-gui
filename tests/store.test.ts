import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/renderer/store';
import type { StreamMessage, Session } from '../src/renderer/types';

const s = () => useStore.getState();

type StoreState = ReturnType<typeof useStore.getState>;
type HydrateArg = Parameters<StoreState['hydrate']>[0];

const seedSession = (id: string): Session => ({
  sessionId: id,
  cwd: '/other',
  title: `seed-${id}`,
  messages: [
    { id: `seedmsg-${id}`, role: 'user', blocks: [{ kind: 'text', text: `hello ${id}` }], timestamp: 1, status: 'completed' },
  ],
  createdAt: 1,
  cost: 1,
  inputTokens: 10,
  outputTokens: 5,
});

const reset = () =>
  useStore.setState({
    cwd: '/tmp',
    currentSessionId: null,
    sessions: [],
    activeSessionIndex: -1,
    messages: [],
    status: 'idle',
    thinkingTokens: 0,
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    streamingMessage: null,
    contextUsage: null,
    queue: [],
  });

const assistant = (id: string, content: unknown[], parentId: string | null = null) =>
  ({
    type: 'assistant',
    message: { id, content },
    parent_tool_use_id: parentId,
    session_id: 'sess-1',
  }) as unknown as StreamMessage;

const result = (over: Record<string, unknown> = {}) =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 100,
    duration_api_ms: 100,
    num_turns: 1,
    result: 'ok',
    session_id: 'sess-1',
    total_cost_usd: 0.01,
    terminal_reason: 'end',
    ttft_ms: 10,
    usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 },
    ...over,
  }) as unknown as StreamMessage;

const init = (sessionId = 'sess-1') =>
  ({
    type: 'system',
    subtype: 'init',
    cwd: '/tmp',
    session_id: sessionId,
    tools: [],
    model: 'test-model',
    permissionMode: 'default',
    claude_code_version: '2',
  }) as unknown as StreamMessage;

beforeEach(reset);

describe('assistant 文本合并（按 message.id 门控）', () => {
  it('跨消息文本不合并且时序正确（CLI 多轮工具调用场景）', () => {
    s().handleStream(init());
    s().handleStream(assistant('msg_AAA', [{ type: 'text', text: 'CHECKING-NOW' }]));
    s().handleStream(assistant('msg_AAA', [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'echo test123' } }]));
    s().handleStream({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'test123' }] },
    } as unknown as StreamMessage);
    s().handleStream(assistant('msg_BBB', [{ type: 'text', text: 'The command printed `test123`.' }]));
    s().handleStream(result());

    const blocks = s().messages.filter((m) => m.role === 'assistant')[0].blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'tool_use', 'text', 'stats']);
    expect((blocks[0] as { text: string }).text).toBe('CHECKING-NOW');
    expect((blocks[2] as { text: string }).text).toBe('The command printed `test123`.');
    const tool = blocks[1] as { status: string; result?: string };
    expect(tool.status).toBe('done');
    expect(tool.result).toBe('test123');
  });

  it('同 message.id 的分片事件仍合并（CLI 拆分消息行为）', () => {
    s().handleStream(assistant('msg_X1', [{ type: 'text', text: '第一段。' }]));
    s().handleStream(assistant('msg_X1', [{ type: 'text', text: '第二段（同消息分片）' }]));
    const st = s().streamingMessage!;
    expect(st.blocks.length).toBe(1);
    expect((st.blocks[0] as { text: string }).text).toBe('第一段。第二段（同消息分片）');
  });

  it('回归：thinking 分片后的同 id text 分片不得合并进早期轮次文本（真实 CLI 事件序列）', () => {
    s().handleStream(init());
    // 第 1 轮：同一消息拆成 [text] [tool_use] 两个分片（CLI 实际行为）
    s().handleStream(assistant('msg_R1', [{ type: 'text', text: '我先看看文件。' }]));
    s().handleStream(assistant('msg_R1', [{ type: 'tool_use', id: 'tool9', name: 'Bash', input: { command: 'ls' } }]));
    s().handleStream({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool9', content: 'f1.txt f2.txt f3.txt' }] },
    } as unknown as StreamMessage);
    // 第 2 轮：同一消息拆成 [thinking] [text] 两个分片。
    // 旧实现在这里按 kind 全局 findIndex，把最终答案拼进第 1 轮的开场文本，
    // 造成"结果显示在中间、后面跟着思考/工具调用"的错位
    s().handleStream(assistant('msg_R2', [{ type: 'thinking', thinking: '数一下文件数', signature: 's' }]));
    s().handleStream(assistant('msg_R2', [{ type: 'text', text: '当前目录共有 3 个文件。' }]));
    s().handleStream(result());

    const blocks = s().messages.filter((m) => m.role === 'assistant')[0].blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'tool_use', 'thinking', 'text', 'stats']);
    expect((blocks[0] as { text: string }).text).toBe('我先看看文件。');
    expect((blocks[3] as { text: string }).text).toBe('当前目录共有 3 个文件。');
  });

  it('同消息内 text→tool_use→text 交叉结构保持原顺序', () => {
    s().handleStream(assistant('msg_M1', [{ type: 'text', text: 'before' }]));
    s().handleStream(assistant('msg_M1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    s().handleStream(assistant('msg_M1', [{ type: 'text', text: 'after' }]));
    const blocks = s().streamingMessage!.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'tool_use', 'text']);
    expect((blocks[0] as { text: string }).text).toBe('before');
    expect((blocks[2] as { text: string }).text).toBe('after');
  });

  it('thinking 块同样受 id 门控', () => {
    s().handleStream(assistant('msg_T1', [{ type: 'thinking', thinking: '想A', signature: 's' }]));
    s().handleStream(assistant('msg_T2', [{ type: 'thinking', thinking: '想B', signature: 's' }]));
    expect(s().streamingMessage!.blocks.length).toBe(2);
    s().handleStream(assistant('msg_T2', [{ type: 'thinking', thinking: '想C', signature: 's' }]));
    expect(s().streamingMessage!.blocks.length).toBe(2);
    // 想C 与 想B 同属 msg_T2，必须合并进 T2 的块；T1 的块不受影响
    expect((s().streamingMessage!.blocks[0] as { text: string }).text).toBe('想A');
    expect((s().streamingMessage!.blocks[1] as { text: string }).text).toBe('想B想C');
  });
});

describe('result 记账与索引对齐', () => {
  it('多轮成本累加、同 sessionId 更新而非重复建', () => {
    s().handleStream(assistant('msg_R1', [{ type: 'text', text: 'r1' }]));
    s().handleStream(result({ total_cost_usd: 0.02 }));
    expect(s().sessions.length).toBe(1);
    expect(s().totalCost).toBeCloseTo(0.02);
    expect(s().activeSessionIndex).toBe(0); // 新会话归档后活跃索引指向它

    s().handleStream(assistant('msg_R2', [{ type: 'text', text: 'r2' }]));
    s().handleStream(result({ total_cost_usd: 0.03 }));
    expect(s().sessions.length).toBe(1);
    expect(s().sessions[0].cost).toBeCloseTo(0.05);
    expect(s().totalCost).toBeCloseTo(0.05);
  });

  it('字段缺失的 result 不崩溃：无 usage/无 session_id 时跳过会话记账', () => {
    s().handleStream(assistant('msg_M1', [{ type: 'text', text: 'partial' }]));
    expect(() => s().handleStream({ type: 'result', is_error: false } as unknown as StreamMessage)).not.toThrow();
    expect(s().sessions.length).toBe(0); // 无 session_id 不建畸形条目
    expect(s().status).toBe('completed');
    expect(s().messages.length).toBe(1); // 消息仍归档
    expect(Number.isNaN(s().totalCost)).toBe(false); // 成本不产生 NaN
  });

  it('畸形 assistant 事件（无 message / 无 content）不崩溃', () => {
    expect(() => s().handleStream({ type: 'assistant' } as unknown as StreamMessage)).not.toThrow();
    expect(() => s().handleStream({ type: 'assistant', message: {} } as unknown as StreamMessage)).not.toThrow();
    const st = s().streamingMessage;
    expect(st).not.toBeNull();
    expect(st!.blocks.length).toBe(0);
  });

  it('畸形 user 事件（content 非数组）不崩溃', () => {
    s().handleStream(assistant('msg_U1', [{ type: 'text', text: 'x' }]));
    expect(() =>
      s().handleStream({ type: 'user', message: { role: 'user', content: 'not-array' } } as unknown as StreamMessage)
    ).not.toThrow();
  });
});

describe('未归档对话保护（S2）', () => {
  it('切换会话时，未归档对话保存为草稿（带真实 sessionId，可 --resume）', () => {
    useStore.setState({ sessions: [seedSession('sess-old')] });
    // 当前对话：init 已到、有用户消息、但还没有 result
    s().handleStream(init('sess-B'));
    s().addUserMessage('question');
    s().handleStream(assistant('msg_B1', [{ type: 'text', text: 'partial answer' }]));
    useStore.setState({ status: 'aborted' }); // 模拟中断归档
    const messagesBefore = s().messages;

    s().switchSession(0); // 切到 sess-old

    // 草稿被保留且排在最前，目标会话索引重定位正确
    expect(s().sessions.length).toBe(2);
    expect(s().sessions[0].sessionId).toBe('sess-B');
    expect(s().sessions[0].messages).toBe(messagesBefore);
    expect(s().sessions[0].cwd).toBe('/tmp');
    expect(s().activeSessionIndex).toBe(1);
    expect(s().currentSessionId).toBe('sess-old');
  });

  it('切换后，已有会话条目的消息被刷新（中断轮次不丢）', () => {
    s().handleStream(init('sess-A'));
    s().addUserMessage('q1');
    s().handleStream(result({ session_id: 'sess-A' })); // 首轮完成 → 建条目
    expect(s().activeSessionIndex).toBe(0);

    // 第二轮被中断：messages 比 sessions[0].messages 多
    s().addUserMessage('q2');
    s().handleStream(assistant('msg_A2', [{ type: 'text', text: 'partial' }]));
    useStore.setState({ status: 'aborted' });

    s().switchSession(0); // 切回自身
    expect(s().sessions[0].messages.length).toBe(s().messages.length);
    expect(s().messages.some((m) => m.blocks.some((b) => b.kind === 'text' && b.text === 'q2'))).toBe(true);
  });

  it('从未拿到 init 的对话（无 sessionId）不生成草稿', () => {
    useStore.setState({ sessions: [seedSession('sess-old')] });
    s().addUserMessage('will fail'); // spawn 失败场景：无 init
    s().switchSession(0);
    expect(s().sessions.length).toBe(1);
  });

  it('newSession 也归档未落库对话', () => {
    s().handleStream(init('sess-C'));
    s().addUserMessage('draft me');
    useStore.setState({ status: 'aborted' });
    const before = s().messages;
    s().newSession();
    expect(s().sessions.length).toBe(1);
    expect(s().sessions[0].sessionId).toBe('sess-C');
    expect(s().sessions[0].messages).toBe(before);
    expect(s().messages.length).toBe(0); // 视图已清空
    expect(s().currentSessionId).toBeNull();
  });
});

describe('不可变更新（React.memo 依赖）', () => {
  it('同 id 分片合并：旧块引用不被 mutate，新块对象承载追加文本', () => {
    s().handleStream(assistant('msg_I1', [{ type: 'text', text: '旧文本。' }]));
    const oldBlocks = s().streamingMessage!.blocks;
    const oldBlock0 = oldBlocks[0] as { kind: 'text'; text: string };

    s().handleStream(assistant('msg_I1', [{ type: 'text', text: '追加。' }]));
    const newBlocks = s().streamingMessage!.blocks;

    expect(oldBlock0.text).toBe('旧文本。'); // 旧引用不变 → memo 可安全跳过
    expect(newBlocks[0]).not.toBe(oldBlock0); // 活跃块是新对象 → 正常重渲染
    expect((newBlocks[0] as { text: string }).text).toBe('旧文本。追加。');
  });

  it('tool_result 更新：旧 tool_use 块引用不被 mutate，新对象承载状态与结果', () => {
    s().handleStream(assistant('msg_I2', [{ type: 'text', text: 'go' }]));
    s().handleStream(assistant('msg_I2', [{ type: 'tool_use', id: 'toolI', name: 'Bash', input: {} }]));
    const oldTool = s().streamingMessage!.blocks[1];

    s().handleStream({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolI', content: 'ok' }] },
    } as unknown as StreamMessage);

    const newTool = s().streamingMessage!.blocks[1] as { status: string; result?: string };
    expect(oldTool).toMatchObject({ status: 'running' }); // 旧引用不变
    expect(newTool).not.toBe(oldTool);
    expect(newTool.status).toBe('done');
    expect(newTool.result).toBe('ok');
  });

  it('子代理 children 更新走不可变路径：父块新对象承载新 children', () => {
    s().handleStream(assistant('msg_I3', [{ type: 'tool_use', id: 'parentT', name: 'Task', input: {} }]));
    const oldParent = s().streamingMessage!.blocks[0];

    s().handleStream(assistant('msg_I4', [{ type: 'text', text: '子代理输出' }], 'parentT'));

    const newParent = s().streamingMessage!.blocks[0] as { children?: unknown[] };
    expect(newParent).not.toBe(oldParent);
    expect((oldParent as { children?: unknown[] }).children).toBeUndefined(); // 旧引用无 children
    expect(newParent.children).toHaveLength(1);
    expect(((newParent.children![0]) as { text: string }).text).toBe('子代理输出');
  });

  it('result 归档：进入 messages 的是新对象，stats 块附加其中', () => {
    s().handleStream(assistant('msg_I5', [{ type: 'text', text: 'done' }]));
    const beforeArchive = s().streamingMessage!;
    s().handleStream(result());

    expect(s().streamingMessage).toBeNull();
    const archivedMsg = s().messages.find((m) => m.role === 'assistant')!;
    expect(archivedMsg).not.toBe(beforeArchive);
    expect(archivedMsg.status).toBe('completed');
    expect(beforeArchive.status).toBe('streaming'); // 旧引用未被改写
    expect(archivedMsg.blocks[archivedMsg.blocks.length - 1].kind).toBe('stats');
  });

  it('归档后的历史消息在后续轮次中引用稳定（不被新事件触碰）', () => {
    s().handleStream(assistant('msg_I6', [{ type: 'text', text: 'r1' }]));
    s().handleStream(result());
    const archived1 = s().messages.filter((m) => m.role === 'assistant')[0];

    s().addUserMessage('q2');
    s().handleStream(assistant('msg_I7', [{ type: 'text', text: 'r2' }]));
    s().handleStream(result());

    const archived1Again = s().messages.filter((m) => m.role === 'assistant')[0];
    expect(archived1Again).toBe(archived1); // 引用稳定 → memo 跳过重渲染
  });
});

describe('既有守卫不回归', () => {
  it('aborted 后残留 assistant 事件被丢弃', () => {
    s().handleStream(assistant('msg_Z1', [{ type: 'text', text: 'before' }]));
    useStore.setState({ status: 'aborted' });
    s().handleStream(assistant('msg_Z2', [{ type: 'text', text: 'after-abort' }]));
    expect(s().streamingMessage!.blocks.length).toBe(1);
  });

  it('streaming 中 newSession/switchSession 被拒绝', () => {
    useStore.setState({ status: 'streaming', currentSessionId: 'sess-x' });
    s().newSession();
    expect(s().currentSessionId).toBe('sess-x');
    expect(s().status).toBe('streaming');
  });

  it('hydrate：活跃索引优先对齐 currentSessionId', () => {
    const sessions = [seedSession('sess-1'), seedSession('sess-2')];
    s().hydrate({
      cwd: '/tmp',
      sessions,
      activeSessionIndex: 0,
      currentSessionId: 'sess-2',
    } as HydrateArg);
    expect(s().activeSessionIndex).toBe(1);
    expect(s().currentSessionId).toBe('sess-2');
  });

  it('hydrate：未归档对话（sessionId 无匹配条目）不高亮任何会话', () => {
    const sessions = [seedSession('sess-1')];
    const unarchived = [
      { id: 'u1', role: 'user' as const, blocks: [{ kind: 'text' as const, text: 'hi' }], timestamp: 1, status: 'completed' as const },
    ];
    s().hydrate({
      cwd: '/tmp',
      sessions,
      activeSessionIndex: -1,
      currentSessionId: 'sess-unarchived',
      messages: unarchived,
    } as HydrateArg);
    expect(s().activeSessionIndex).toBe(-1);
    expect(s().messages).toBe(unarchived);
  });
});

describe('removeLastTurn（失败重试）', () => {
  const seedTurns = () =>
    useStore.setState({
      messages: [
        { id: 'u1', role: 'user' as const, blocks: [{ kind: 'text' as const, text: '问题一' }], timestamp: 1, status: 'completed' as const },
        { id: 'a1', role: 'assistant' as const, blocks: [{ kind: 'text' as const, text: '回答一' }], timestamp: 2, status: 'completed' as const },
        { id: 'u2', role: 'user' as const, blocks: [{ kind: 'text' as const, text: '  问题二  ' }], timestamp: 3, status: 'completed' as const },
        { id: 'a2', role: 'assistant' as const, blocks: [{ kind: 'stderr' as const, text: 'API Error' }], timestamp: 4, status: 'error' as const },
      ],
    });

  it('移除最后一条 user 消息及其后全部，返回 trim 后的 user 文本', () => {
    seedTurns();
    const text = s().removeLastTurn();
    expect(text).toBe('问题二');
    expect(s().messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('无 user 消息时返回 null 且不动 messages', () => {
    useStore.setState({
      messages: [
        { id: 'a1', role: 'assistant' as const, blocks: [], timestamp: 1, status: 'error' as const },
      ],
    });
    expect(s().removeLastTurn()).toBeNull();
    expect(s().messages).toHaveLength(1);
  });

  it('user 消息无文本块时返回 null（不产生空重发）', () => {
    useStore.setState({
      messages: [
        { id: 'u1', role: 'user' as const, blocks: [{ kind: 'tool_use' as const, toolName: 'x', toolId: 't', input: {}, status: 'done' }], timestamp: 1, status: 'completed' as const },
      ],
    });
    expect(s().removeLastTurn()).toBeNull();
    expect(s().messages).toHaveLength(1);
  });

  it('addUserMessage 触发强制滚底 nonce（外部发送路径的滚底信号）', () => {
    const before = s().forceScrollNonce;
    s().addUserMessage('hello');
    expect(s().forceScrollNonce).toBeGreaterThan(before);
  });
});

describe('renameSession（会话重命名）', () => {
  it('重命名指定会话（trim 空白），其余会话不受影响', () => {
    useStore.setState({ sessions: [seedSession('s1'), seedSession('s2')] });
    s().renameSession(1, '  新名字  ');
    const ss = s().sessions;
    expect(ss[1].title).toBe('新名字');
    expect(ss[0].title).toBe('seed-s1');
  });

  it('空标题/同名不生效；越界索引不抛错', () => {
    useStore.setState({ sessions: [seedSession('s1')] });
    s().renameSession(0, '   ');
    expect(s().sessions[0].title).toBe('seed-s1');
    s().renameSession(0, 'seed-s1');
    expect(s().sessions[0].title).toBe('seed-s1');
    expect(() => s().renameSession(99, 'x')).not.toThrow();
    expect(() => s().renameSession(-1, 'x')).not.toThrow();
  });
});
