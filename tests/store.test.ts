import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/renderer/store';
import type { Conversation, StreamMessage, Session } from '../src/renderer/types';

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

/** 活跃标签页 */
const conv = () => s().conversations.find((c) => c.id === s().activeConversationId)!;
/** 按 id 取标签页 */
const getConv = (id: string) => s().conversations.find((c) => c.id === id)!;
/** 直接改活跃标签页（绕过动作，模拟底层状态） */
const setConv = (partial: Partial<Conversation>) =>
  useStore.setState((st) => ({
    conversations: st.conversations.map((c) =>
      c.id === st.activeConversationId ? { ...c, ...partial } : c
    ),
  }));

const reset = () => {
  useStore.setState({
    cwd: '/tmp',
    sessions: [],
    conversations: [],
    activeConversationId: '',
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    searchOpen: false,
    highlightMessageId: null,
    forceScrollNonce: 0,
  });
  s().newConversation();
};

const assistant = (id: string, content: unknown[], parentId: string | null = null, conversationId?: string) =>
  ({
    type: 'assistant',
    message: { id, content },
    parent_tool_use_id: parentId,
    session_id: 'sess-1',
    ...(conversationId ? { conversationId } : {}),
  }) as unknown as StreamMessage;

const result = (over: Record<string, unknown> = {}, conversationId?: string) =>
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
    ...(conversationId ? { conversationId } : {}),
    ...over,
  }) as unknown as StreamMessage;

const init = (sessionId = 'sess-1', conversationId?: string) =>
  ({
    type: 'system',
    subtype: 'init',
    cwd: '/tmp',
    session_id: sessionId,
    tools: [],
    model: 'test-model',
    permissionMode: 'default',
    claude_code_version: '2',
    ...(conversationId ? { conversationId } : {}),
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

    const blocks = conv().messages.filter((m) => m.role === 'assistant')[0].blocks;
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
    const st = conv().streamingMessage!;
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

    const blocks = conv().messages.filter((m) => m.role === 'assistant')[0].blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'tool_use', 'thinking', 'text', 'stats']);
    expect((blocks[0] as { text: string }).text).toBe('我先看看文件。');
    expect((blocks[3] as { text: string }).text).toBe('当前目录共有 3 个文件。');
  });

  it('同消息内 text→tool_use→text 交叉结构保持原顺序', () => {
    s().handleStream(assistant('msg_M1', [{ type: 'text', text: 'before' }]));
    s().handleStream(assistant('msg_M1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    s().handleStream(assistant('msg_M1', [{ type: 'text', text: 'after' }]));
    const blocks = conv().streamingMessage!.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'tool_use', 'text']);
    expect((blocks[0] as { text: string }).text).toBe('before');
    expect((blocks[2] as { text: string }).text).toBe('after');
  });

  it('thinking 块同样受 id 门控', () => {
    s().handleStream(assistant('msg_T1', [{ type: 'thinking', thinking: '想A', signature: 's' }]));
    s().handleStream(assistant('msg_T2', [{ type: 'thinking', thinking: '想B', signature: 's' }]));
    expect(conv().streamingMessage!.blocks.length).toBe(2);
    s().handleStream(assistant('msg_T2', [{ type: 'thinking', thinking: '想C', signature: 's' }]));
    expect(conv().streamingMessage!.blocks.length).toBe(2);
    // 想C 与 想B 同属 msg_T2，必须合并进 T2 的块；T1 的块不受影响
    expect((conv().streamingMessage!.blocks[0] as { text: string }).text).toBe('想A');
    expect((conv().streamingMessage!.blocks[1] as { text: string }).text).toBe('想B想C');
  });
});

describe('result 记账', () => {
  it('多轮成本累加、同 sessionId 更新而非重复建', () => {
    s().handleStream(assistant('msg_R1', [{ type: 'text', text: 'r1' }]));
    s().handleStream(result({ total_cost_usd: 0.02 }));
    expect(s().sessions.length).toBe(1);
    expect(s().totalCost).toBeCloseTo(0.02);

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
    expect(conv().status).toBe('completed');
    expect(conv().messages.length).toBe(1); // 消息仍归档
    expect(Number.isNaN(s().totalCost)).toBe(false); // 成本不产生 NaN
  });

  it('畸形 assistant 事件（无 message / 无 content）不崩溃', () => {
    expect(() => s().handleStream({ type: 'assistant' } as unknown as StreamMessage)).not.toThrow();
    expect(() => s().handleStream({ type: 'assistant', message: {} } as unknown as StreamMessage)).not.toThrow();
    const st = conv().streamingMessage;
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

describe('多标签页：状态隔离与事件路由', () => {
  it('事件按 conversationId 路由，两个标签页互不串扰（并行生成）', () => {
    const a = conv().id;
    const b = s().newConversation(); // 新开并激活 b
    expect(s().conversations.length).toBe(2);
    expect(s().activeConversationId).toBe(b);

    // 两个标签页各自流式（a 在后台也能收到自己的事件）
    s().handleStream(assistant('msg_PA', [{ type: 'text', text: '来自A' }], null, a));
    s().handleStream(assistant('msg_PB', [{ type: 'text', text: '来自B' }], null, b));

    expect((getConv(a).streamingMessage!.blocks[0] as { text: string }).text).toBe('来自A');
    expect((getConv(b).streamingMessage!.blocks[0] as { text: string }).text).toBe('来自B');
    // 每个标签页只有自己的流式消息
    expect(getConv(a).streamingMessage!.blocks).toHaveLength(1);
    expect(getConv(b).streamingMessage!.blocks).toHaveLength(1);
  });

  it('无 conversationId 的事件路由到活跃标签页（兼容缺省）', () => {
    s().handleStream(assistant('msg_D1', [{ type: 'text', text: '默认路由' }]));
    expect(conv().streamingMessage).not.toBeNull();
  });

  it('已关闭标签页的残余事件被丢弃（不幽灵复活）', () => {
    const a = conv().id;
    s().newConversation(); // 活跃切到新标签页
    s().closeConversation(a); // 关掉 a
    expect(s().conversations.some((c) => c.id === a)).toBe(false);
    expect(() =>
      s().handleStream(assistant('msg_G1', [{ type: 'text', text: 'ghost' }], null, a))
    ).not.toThrow();
    expect(s().conversations.some((c) => c.streamingMessage)).toBe(false);
  });

  it('切换标签页不影响其他标签页的运行状态与草稿', () => {
    const a = conv().id;
    s().setDraft('A 的草稿');
    setConv({ status: 'streaming' });
    const b = s().newConversation();
    s().setDraft('B 的草稿');

    // 切回 a：草稿与状态保留
    s().setActiveConversation(a);
    expect(getConv(a).draft).toBe('A 的草稿');
    expect(getConv(a).status).toBe('streaming');
    expect(getConv(b).draft).toBe('B 的草稿');
    expect(s().activeConversationId).toBe(a);
  });

  it('关闭最后一个标签页时自动补一个空标签页（永远有活跃对话）', () => {
    const only = conv().id;
    s().closeConversation(only);
    expect(s().conversations.length).toBe(1);
    expect(s().activeConversationId).not.toBe(only);
    expect(conv().messages).toHaveLength(0);
  });

  it('后台标签页的队列在 result 时自动续发（无需切回该标签页）', () => {
    const a = conv().id;
    s().newConversation(); // 活跃切到 b；a 作为后台标签页
    // 直接构造 a 的运行中状态 + 待发队列
    useStore.setState((st) => ({
      conversations: st.conversations.map((c) =>
        c.id === a ? { ...c, status: 'streaming' as const, queue: ['后台续发消息'] } : c
      ),
    }));

    s().handleStream(result({ session_id: 'sess-A' }, a));

    const convA = getConv(a);
    expect(convA.queue).toEqual([]); // 队列被消费
    expect(convA.status).toBe('streaming'); // 续发消息进入流式
    expect(
      convA.messages.some((m) => m.role === 'user' && (m.blocks[0] as { text: string }).text === '后台续发消息')
    ).toBe(true);
  });

  it('result 出错时清空该标签页的排队消息', () => {
    const a = conv().id;
    useStore.setState((st) => ({
      conversations: st.conversations.map((c) =>
        c.id === a ? { ...c, status: 'streaming' as const, queue: ['不该发出的'] } : c
      ),
    }));
    s().handleStream(result({ is_error: true, session_id: 'sess-A' }, a));
    expect(getConv(a).queue).toEqual([]);
  });
});

describe('关闭标签页的归档保护', () => {
  it('关闭运行中的标签页：流式内容归档为草稿（带真实 sessionId，可 --resume）', () => {
    s().handleStream(init('sess-B'));
    s().sendPrompt('question');
    s().handleStream(assistant('msg_B1', [{ type: 'text', text: 'partial answer' }]));

    s().closeConversation(conv().id);

    expect(s().sessions.length).toBe(1);
    expect(s().sessions[0].sessionId).toBe('sess-B');
    expect(s().sessions[0].cwd).toBe('/tmp');
    // 流式中的部分内容被归档进草稿（用户消息 + 中断回复都在）
    const texts = s().sessions[0].messages.map((m) =>
      (m.blocks[0] as { text?: string } | undefined)?.text || ''
    );
    expect(texts).toContain('question');
    expect(texts).toContain('partial answer');
  });

  it('关闭已有归档条目的标签页：仅刷新消息（保留累计成本）', () => {
    s().handleStream(init('sess-A'));
    s().sendPrompt('q1');
    s().handleStream(result({ session_id: 'sess-A', total_cost_usd: 0.02 }));
    expect(s().sessions.length).toBe(1);

    // 第二轮被中断后关闭
    s().sendPrompt('q2');
    s().handleStream(assistant('msg_A2', [{ type: 'text', text: 'partial' }]));
    setConv({ status: 'aborted' });
    s().closeConversation(conv().id);

    expect(s().sessions.length).toBe(1); // 仍是同一条目
    expect(s().sessions[0].cost).toBeCloseTo(0.02); // 累计成本保留
    expect(s().sessions[0].messages.some((m) => m.blocks.some((b) => b.kind === 'text' && b.text === 'q2'))).toBe(true);
  });

  it('从未拿到 init 的对话（无 sessionId）不生成草稿', () => {
    s().sendPrompt('will fail'); // spawn 失败场景：无 init
    s().closeConversation(conv().id);
    expect(s().sessions.length).toBe(0);
  });

  it('openSessionTab：已打开的会话激活既有标签页，未打开的新建载入', () => {
    // 种子会话没有任何标签页持有 → 走新建路径
    useStore.setState({ sessions: [seedSession('sess-H')] });
    const tabCountBefore = s().conversations.length;

    s().openSessionTab('sess-H'); // 未打开 → 新标签页
    expect(s().conversations.length).toBe(tabCountBefore + 1);
    expect(conv().sessionId).toBe('sess-H');
    expect(conv().messages.length).toBeGreaterThan(0); // 历史消息载入

    const openedId = conv().id;
    s().newConversation(); // 切走
    s().openSessionTab('sess-H'); // 已打开 → 激活既有标签页，不再新开
    expect(s().conversations.length).toBe(tabCountBefore + 2); // 没有重复开
    expect(conv().id).toBe(openedId);
  });

  it('删除归档会话：其运行中的标签页保留（CLI 侧会话仍在），非运行的关闭', () => {
    s().handleStream(init('sess-K'));
    s().sendPrompt('q');
    s().handleStream(result({ session_id: 'sess-K' }));
    // 重新打开该会话为标签页并进入运行中
    s().openSessionTab('sess-K');
    const runningTabId = conv().id;
    setConv({ status: 'streaming' });

    const idx = s().sessions.findIndex((x) => x.sessionId === 'sess-K');
    s().deleteSession(idx);

    expect(s().sessions.length).toBe(0); // 条目已删
    expect(s().conversations.some((c) => c.id === runningTabId)).toBe(true); // 运行中标签页保留
  });
});

describe('不可变更新（React.memo 依赖）', () => {
  it('同 id 分片合并：旧块引用不被 mutate，新块对象承载追加文本', () => {
    s().handleStream(assistant('msg_I1', [{ type: 'text', text: '旧文本。' }]));
    const oldBlocks = conv().streamingMessage!.blocks;
    const oldBlock0 = oldBlocks[0] as { kind: 'text'; text: string };

    s().handleStream(assistant('msg_I1', [{ type: 'text', text: '追加。' }]));
    const newBlocks = conv().streamingMessage!.blocks;

    expect(oldBlock0.text).toBe('旧文本。'); // 旧引用不变 → memo 可安全跳过
    expect(newBlocks[0]).not.toBe(oldBlock0); // 活跃块是新对象 → 正常重渲染
    expect((newBlocks[0] as { text: string }).text).toBe('旧文本。追加。');
  });

  it('tool_result 更新：旧 tool_use 块引用不被 mutate，新对象承载状态与结果', () => {
    s().handleStream(assistant('msg_I2', [{ type: 'text', text: 'go' }]));
    s().handleStream(assistant('msg_I2', [{ type: 'tool_use', id: 'toolI', name: 'Bash', input: {} }]));
    const oldTool = conv().streamingMessage!.blocks[1];

    s().handleStream({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolI', content: 'ok' }] },
    } as unknown as StreamMessage);

    const newTool = conv().streamingMessage!.blocks[1] as { status: string; result?: string };
    expect(oldTool).toMatchObject({ status: 'running' }); // 旧引用不变
    expect(newTool).not.toBe(oldTool);
    expect(newTool.status).toBe('done');
    expect(newTool.result).toBe('ok');
  });

  it('子代理 children 更新走不可变路径：父块新对象承载新 children', () => {
    s().handleStream(assistant('msg_I3', [{ type: 'tool_use', id: 'parentT', name: 'Task', input: {} }]));
    const oldParent = conv().streamingMessage!.blocks[0];

    s().handleStream(assistant('msg_I4', [{ type: 'text', text: '子代理输出' }], 'parentT'));

    const newParent = conv().streamingMessage!.blocks[0] as { children?: unknown[] };
    expect(newParent).not.toBe(oldParent);
    expect((oldParent as { children?: unknown[] }).children).toBeUndefined(); // 旧引用无 children
    expect(newParent.children).toHaveLength(1);
    expect(((newParent.children![0]) as { text: string }).text).toBe('子代理输出');
  });

  it('result 归档：进入 messages 的是新对象，stats 块附加其中', () => {
    s().handleStream(assistant('msg_I5', [{ type: 'text', text: 'done' }]));
    const beforeArchive = conv().streamingMessage!;
    s().handleStream(result());

    expect(conv().streamingMessage).toBeNull();
    const archivedMsg = conv().messages.find((m) => m.role === 'assistant')!;
    expect(archivedMsg).not.toBe(beforeArchive);
    expect(archivedMsg.status).toBe('completed');
    expect(beforeArchive.status).toBe('streaming'); // 旧引用未被改写
    expect(archivedMsg.blocks[archivedMsg.blocks.length - 1].kind).toBe('stats');
  });

  it('归档后的历史消息在后续轮次中引用稳定（不被新事件触碰）', () => {
    s().handleStream(assistant('msg_I6', [{ type: 'text', text: 'r1' }]));
    s().handleStream(result());
    const archived1 = conv().messages.filter((m) => m.role === 'assistant')[0];

    s().sendPrompt('q2');
    s().handleStream(assistant('msg_I7', [{ type: 'text', text: 'r2' }]));
    s().handleStream(result());

    const archived1Again = conv().messages.filter((m) => m.role === 'assistant')[0];
    expect(archived1Again).toBe(archived1); // 引用稳定 → memo 跳过重渲染
  });

  it('后台标签页更新不替换其他标签页对象（数组级隔离）', () => {
    const a = conv().id;
    const b = s().newConversation();
    const convARef = getConv(a);

    s().handleStream(assistant('msg_ISO', [{ type: 'text', text: 'b 的输出' }], null, b));

    expect(getConv(a)).toBe(convARef); // a 的引用完全未变 → memo 全跳过
    expect(getConv(b)).not.toBe(getConv(a));
  });
});

describe('既有守卫不回归', () => {
  it('aborted 后残留 assistant 事件被丢弃', () => {
    s().handleStream(assistant('msg_Z1', [{ type: 'text', text: 'before' }]));
    setConv({ status: 'aborted' });
    s().handleStream(assistant('msg_Z2', [{ type: 'text', text: 'after-abort' }]));
    expect(conv().streamingMessage!.blocks.length).toBe(1);
  });

  it('setStatus 带 conversationId 只影响指定标签页', () => {
    const a = conv().id;
    const b = s().newConversation();
    s().setStatus('streaming', a);
    expect(getConv(a).status).toBe('streaming');
    expect(getConv(b).status).toBe('idle'); // b 不受影响
  });

  it('hydrate：新格式（conversations）恢复且 activeConversationId 对齐', () => {
    const c1: Conversation = {
      id: 'conv-1', title: 'T1', sessionId: 'sess-1', cwd: '/tmp',
      messages: [], streamingMessage: null, status: 'idle', thinkingTokens: 0,
      contextUsage: null, queue: [], currentModel: '', draft: 'd1',
    };
    const c2: Conversation = {
      id: 'conv-2', title: 'T2', sessionId: 'sess-2', cwd: '/tmp',
      messages: [], streamingMessage: null, status: 'completed', thinkingTokens: 0,
      contextUsage: null, queue: [], currentModel: '', draft: '',
    };
    s().hydrate({ cwd: '/tmp', sessions: [], conversations: [c1, c2], activeConversationId: 'conv-2' } as HydrateArg);
    expect(s().conversations.length).toBe(2);
    expect(s().activeConversationId).toBe('conv-2');
    expect(getConv('conv-1').draft).toBe('d1');
  });

  it('hydrate：重启前流式中的标签页被收敛（运行态清空、内容归档保留）', () => {
    const streamingConv: Conversation = {
      id: 'conv-s', title: '中断的', sessionId: 'sess-s', cwd: '/tmp',
      messages: [
        { id: 'm1', role: 'user', blocks: [{ kind: 'text', text: 'q' }], timestamp: 1, status: 'completed' },
      ],
      streamingMessage: { id: 'm2', role: 'assistant', blocks: [{ kind: 'text', text: 'partial' }], timestamp: 2, status: 'streaming' },
      status: 'streaming', thinkingTokens: 0,
      contextUsage: null, queue: ['排队消息'], currentModel: '', draft: '',
    };
    s().hydrate({ cwd: '/tmp', sessions: [], conversations: [streamingConv], activeConversationId: 'conv-s' } as HydrateArg);
    const restored = getConv('conv-s');
    expect(restored.status).toBe('aborted'); // 运行态收敛
    expect(restored.streamingMessage).toBeNull();
    expect(restored.queue).toEqual([]);
    expect(restored.messages.length).toBe(2); // 流式内容归档保留
    expect(restored.messages[1].status).toBe('completed');
  });

  it('hydrate：旧格式（全局单会话）迁移为单标签页', () => {
    const legacyMessages = [
      { id: 'u1', role: 'user' as const, blocks: [{ kind: 'text' as const, text: '旧数据' }], timestamp: 1, status: 'completed' as const },
    ];
    s().hydrate({
      cwd: '/tmp',
      sessions: [seedSession('sess-old')],
      messages: legacyMessages,
      currentSessionId: 'sess-legacy',
    } as HydrateArg);
    expect(s().conversations.length).toBe(1);
    expect(conv().sessionId).toBe('sess-legacy');
    expect(conv().messages).toBe(legacyMessages);
  });
});

describe('removeLastTurn（失败重试）', () => {
  const seedTurns = () =>
    useStore.setState((st) => ({
      conversations: st.conversations.map((c) =>
        c.id === st.activeConversationId
          ? {
              ...c,
              messages: [
                { id: 'u1', role: 'user' as const, blocks: [{ kind: 'text' as const, text: '问题一' }], timestamp: 1, status: 'completed' as const },
                { id: 'a1', role: 'assistant' as const, blocks: [{ kind: 'text' as const, text: '回答一' }], timestamp: 2, status: 'completed' as const },
                { id: 'u2', role: 'user' as const, blocks: [{ kind: 'text' as const, text: '  问题二  ' }], timestamp: 3, status: 'completed' as const },
                { id: 'a2', role: 'assistant' as const, blocks: [{ kind: 'stderr' as const, text: 'API Error' }], timestamp: 4, status: 'error' as const },
              ],
            }
          : c
      ),
    }));

  it('移除最后一条 user 消息及其后全部，返回 trim 后的 user 文本', () => {
    seedTurns();
    const text = s().removeLastTurn();
    expect(text).toBe('问题二');
    expect(conv().messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('无 user 消息时返回 null 且不动 messages', () => {
    useStore.setState((st) => ({
      conversations: st.conversations.map((c) =>
        c.id === st.activeConversationId
          ? { ...c, messages: [{ id: 'a1', role: 'assistant' as const, blocks: [], timestamp: 1, status: 'error' as const }] }
          : c
      ),
    }));
    expect(s().removeLastTurn()).toBeNull();
    expect(conv().messages).toHaveLength(1);
  });

  it('sendPrompt 触发强制滚底 nonce 并更新标签页标题', () => {
    const before = s().forceScrollNonce;
    s().sendPrompt('新话题第一条消息');
    expect(s().forceScrollNonce).toBeGreaterThan(before);
    expect(conv().title).toBe('新话题第一条消息'.slice(0, 30));
    expect(conv().messages.some((m) => m.role === 'user')).toBe(true);
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
