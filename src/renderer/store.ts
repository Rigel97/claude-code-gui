import { create } from 'zustand';
import type { ChatMessage, ContextUsage, Conversation, Session, SessionEvent, RunStatus, StreamMessage, UIBlock } from './types';
import { deliverPrompt, abortConversation } from './utils/deliver';

interface AppState {
  // 全局：工作目录（新会话的默认 cwd；已开会话各自快照，互不影响）
  cwd: string;
  setCwd: (cwd: string) => void;

  // 归档会话列表（侧栏「会话」tab 的数据源）
  sessions: Session[];

  // 多标签页：每个 tab 一个独立对话
  conversations: Conversation[];
  activeConversationId: string;
  newConversation: (opts?: { fromSession?: Session }) => string;
  closeConversation: (id: string) => void;
  setActiveConversation: (id: string) => void;
  /** 侧栏点击归档会话：已开则激活，未开则新 tab 载入 */
  openSessionTab: (sessionId: string) => void;
  setDraft: (text: string) => void;
  /** 发送一条消息（写入消息流 + 拉起 CLI），默认作用于活跃标签页 */
  sendPrompt: (prompt: string, conversationId?: string) => void;
  removeLastTurn: () => string | null;
  // 用户发送新消息时的强制滚底信号（nonce）
  forceScrollNonce: number;

  // 全局累计用量
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;

  // 设置
  model: string;
  setModel: (model: string) => void;
  permissionMode: 'bypassPermissions' | 'acceptEdits';
  setPermissionMode: (mode: 'bypassPermissions' | 'acceptEdits') => void;
  showThinking: boolean;
  setShowThinking: (show: boolean) => void;
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  notifyOnComplete: boolean;
  setNotifyOnComplete: (on: boolean) => void;
  maxSessions: number;
  setMaxSessions: (n: number) => void;
  clearAllSessions: () => void;
  renameSession: (index: number, title: string) => void;
  deleteSession: (index: number) => void;

  // 输入框文本注入（文件树点击 @引用 / 粘贴图片路径等）
  injectedText: { text: string; nonce: number } | null;
  injectText: (text: string) => void;

  // 待发消息队列（作用于活跃标签页；后台标签页的队列在 result 时自动续发）
  enqueueMessage: (text: string) => void;
  removeQueuedMessage: (index: number) => void;

  // 搜索面板
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  highlightMessageId: string | null;
  setHighlightMessage: (id: string | null) => void;

  // 流事件路由（按事件携带的 conversationId 分发到对应标签页）
  handleStream: (msg: StreamMessage & { conversationId?: string }) => void;
  setStatus: (status: RunStatus, conversationId?: string) => void;
  setContextUsage: (usage: ContextUsage | null, conversationId?: string) => void;

  hydrate: (data: {
    cwd?: string;
    sessions?: Session[];
    conversations?: unknown;
    activeConversationId?: string;
    totalCost?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    model?: string;
    permissionMode?: 'bypassPermissions' | 'acceptEdits';
    showThinking?: boolean;
    notifyOnComplete?: boolean;
    maxSessions?: number;
    sidebarWidth?: number;
    // 旧版单会话格式（迁移用）
    messages?: ChatMessage[];
    currentSessionId?: string | null;
  }) => void;
}

let msgCounter = 0;
const genId = () => `msg-${++msgCounter}-${Date.now()}`;
let convCounter = 0;
const genConvId = () => `conv-${++convCounter}-${Date.now()}`;

/** 强制滚底信号的自增序号：Date.now() 同毫秒会碰撞，导致连续发送时
 *  第二次不触发 ChatArea 的 effect，改用单调递增计数器 */
let scrollNonceCounter = 0;

/**
 * 上一条 assistant 流事件的 CLI message.id（按标签页隔离）。
 * CLI 会把同一条 assistant 消息拆成多个事件（message.id 相同，实测确认），
 * 文本/思考块合并只允许发生在同 id 的分片之间；不同消息绝不合并，
 * 否则下一轮回复会被无分隔符拼进上一轮文本块、且时序错乱（显示在工具调用之前）。
 */
const lastAssistantMsgIds = new Map<string, string | null>();

/** 持久化保留会话数的默认上限（可在设置中调整），防止配置文件无限膨胀 */
const DEFAULT_MAX_SESSIONS = 50;
/** 持久化保留标签页数上限（超出丢弃最旧的，其归档条目仍在侧栏可重新打开） */
const MAX_PERSIST_CONVERSATIONS = 10;
/** 单条工具结果的最大保留长度（Bash 输出可能非常大） */
const MAX_TOOL_RESULT = 20000;

function makeConversation(cwd: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id: genConvId(),
    title: '新对话',
    sessionId: null,
    cwd,
    messages: [],
    streamingMessage: null,
    status: 'idle',
    thinkingTokens: 0,
    contextUsage: null,
    queue: [],
    currentModel: '',
    draft: '',
    ...over,
  };
}

/** 提取并截断工具结果文本 */
function extractToolResultText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map((c: { text?: string }) => c?.text || '').join('');
  }
  return text.length > MAX_TOOL_RESULT
    ? text.slice(0, MAX_TOOL_RESULT) + '\n… (输出过长，已截断)'
    : text;
}

/** 递归查找 tool_use 块（含子代理 children） */
function findToolBlock(blocks: UIBlock[], toolId: string): Extract<UIBlock, { kind: 'tool_use' }> | null {
  for (const b of blocks) {
    if (b.kind === 'tool_use') {
      if (b.toolId === toolId) return b;
      if (b.children) {
        const hit = findToolBlock(b.children, toolId);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** 将 tool_result 写回对应 tool_use 块（含子代理 children 路径）。
 *  不可变更新：命中才返回新数组/新块，配合渲染层 React.memo 跳过已完成块的重渲染 */
function applyToolResult(
  blocks: UIBlock[],
  block: { tool_use_id: string; content: unknown; is_error?: boolean }
): { blocks: UIBlock[]; hit: boolean } {
  let changed = false;
  const next = blocks.map((b) => {
    if (b.kind !== 'tool_use') return b;
    if (b.toolId === block.tool_use_id) {
      changed = true;
      return {
        ...b,
        status: block.is_error ? ('error' as const) : ('done' as const),
        result: extractToolResultText(block.content),
      };
    }
    if (b.children) {
      const nested = applyToolResult(b.children, block);
      if (nested.hit) {
        changed = true;
        return { ...b, children: nested.blocks };
      }
    }
    return b;
  });
  return { blocks: changed ? next : blocks, hit: changed };
}

/** 把子代理容器写回对应 tool_use 块的 children（不可变，命中才返回新数组） */
function replaceToolBlockChildren(blocks: UIBlock[], toolId: string, children: UIBlock[]): UIBlock[] {
  let changed = false;
  const next = blocks.map((b) => {
    if (b.kind !== 'tool_use') return b;
    if (b.toolId === toolId) {
      changed = true;
      return { ...b, children };
    }
    if (b.children) {
      const nested = replaceToolBlockChildren(b.children, toolId, children);
      if (nested !== b.children) {
        changed = true;
        return { ...b, children: nested };
      }
    }
    return b;
  });
  return changed ? next : blocks;
}

/**
 * 将流式消息归档到消息列表（不可变：返回新对象，不 mutate 原引用）
 */
function finalizeStreaming(conv: Conversation, finalStatus: 'completed' | 'error'): {
  messages: ChatMessage[];
  streamingMessage: null;
} {
  const streaming = conv.streamingMessage;
  if (!streaming) {
    return { messages: conv.messages, streamingMessage: null };
  }
  return {
    messages: [...conv.messages, { ...streaming, status: finalStatus }],
    streamingMessage: null,
  };
}

/**
 * 把尚未写入 sessions 的对话落库（关闭标签页前调用）。
 * 背景：会话条目只在收到 result 时创建，被中断/出错的对话仅存在于内存中，
 * 关闭标签页会永久丢失——此处保证有 sessionId（--resume 可续接）的对话保留草稿条目。
 */
function archiveConversation(sessions: Session[], conv: Conversation, maxSessions: number): Session[] {
  if (!conv.messages.length) return sessions;

  const idx = conv.sessionId
    ? sessions.findIndex((s) => s.sessionId === conv.sessionId)
    : -1;
  if (idx >= 0) {
    const existing = sessions[idx];
    if (existing.messages === conv.messages) return sessions; // 无未落库变化
    // 已有条目：仅刷新消息（保留累计成本等，多轮中 result 之间的增量）
    return sessions.map((s, i) => (i === idx ? { ...s, messages: conv.messages } : s));
  }

  // 无条目：本轮还没有 result（被中断/出错）。sessionId 存在说明 CLI 侧
  // 已有该会话（--resume 可续接），保留为草稿；从未拿到 init 的纯错误输出不保留
  if (!conv.sessionId) return sessions;
  if (!conv.messages.some((m) => m.role === 'user')) return sessions;

  const firstUserMsg = conv.messages.find((m) => m.role === 'user');
  const title = firstUserMsg?.blocks.find((b) => b.kind === 'text')?.text?.slice(0, 50) || 'Session';
  const draft: Session = {
    sessionId: conv.sessionId,
    cwd: conv.cwd,
    title,
    messages: conv.messages,
    createdAt: Date.now(),
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    model: conv.currentModel || undefined,
  };
  return [draft, ...sessions].slice(0, maxSessions > 0 ? maxSessions : DEFAULT_MAX_SESSIONS);
}

/** 不可变替换指定标签页 */
function replaceConv(conversations: Conversation[], id: string, next: Conversation): Conversation[] {
  return conversations.map((c) => (c.id === id ? next : c));
}

/** 持久化快照可安全序列化的标签页子集（运行态字段收敛） */
export function snapshotConversations(conversations: Conversation[]): Conversation[] {
  return conversations.slice(0, MAX_PERSIST_CONVERSATIONS).map((c) => ({
    ...c,
    // 应用重启后进程已消失：运行态收敛（会话 status 标 aborted，消息归档为 completed），流式内容归档防丢
    status: c.status === 'streaming' || c.status === 'starting' ? 'aborted' : c.status,
    streamingMessage: null,
    queue: [],
    messages:
      c.streamingMessage && (c.status === 'streaming' || c.status === 'starting')
        ? [...c.messages, { ...c.streamingMessage, status: 'completed' as const }]
        : c.messages,
  }));
}

export const useStore = create<AppState>((set, get) => {
  /** 内部：往指定标签页写入用户消息并拉起 CLI */
  const dispatchPrompt = (prompt: string, conversationId: string) => {
    const state = get();
    const conv = state.conversations.find((c) => c.id === conversationId);
    if (!conv || !conv.cwd) return;

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      blocks: [{ kind: 'text', text: prompt }],
      timestamp: Date.now(),
      status: 'completed',
    };
    const assistantMsg: ChatMessage = {
      id: genId(),
      role: 'assistant',
      blocks: [],
      timestamp: Date.now(),
      status: 'streaming',
    };

    const nextConv: Conversation = {
      ...conv,
      title: conv.title === '新对话' ? prompt.slice(0, 30) : conv.title,
      messages: [...conv.messages, userMsg],
      streamingMessage: assistantMsg,
      status: 'streaming',
    };
    set({
      conversations: replaceConv(state.conversations, conversationId, nextConv),
      forceScrollNonce: ++scrollNonceCounter,
    });

    void deliverPrompt({
      prompt,
      cwd: conv.cwd,
      sessionId: conv.sessionId || undefined,
      // 已有会话 ID 时必须用 --resume 续接，否则多轮上下文会丢失
      resume: !!conv.sessionId,
      options: { ...(state.model ? { model: state.model } : {}), permissionMode: state.permissionMode },
      conversationId,
    });
  };

  return {
    cwd: '',
    setCwd: (cwd) => set({ cwd }),

    sessions: [],

    conversations: [],
    activeConversationId: '',

    newConversation: (opts) => {
      const state = get();
      const conv = opts?.fromSession
        ? makeConversation(opts.fromSession.cwd, {
            title: opts.fromSession.title,
            sessionId: opts.fromSession.sessionId,
            messages: opts.fromSession.messages,
            currentModel: opts.fromSession.model || '',
          })
        : makeConversation(state.cwd);
      set({
        conversations: [...state.conversations, conv],
        activeConversationId: conv.id,
      });
      return conv.id;
    },

    closeConversation: (id) => {
      const state = get();
      const conv = state.conversations.find((c) => c.id === id);
      if (!conv) return;
      // 运行中：先终止其进程（事件稍后到达时标签页已移除，handleStream 会忽略）
      if (conv.status === 'streaming' || conv.status === 'starting') {
        abortConversation(id);
      }
      // 流式中的部分内容先归档再落库，避免直接丢失（归档为 completed：
      // 中断的历史内容不挂重试按钮，与旧 setStatus 行为一致）
      const settled: Conversation =
        conv.streamingMessage && (conv.status === 'streaming' || conv.status === 'starting')
          ? { ...conv, ...finalizeStreaming(conv, 'completed'), status: 'aborted' }
          : conv;
      const sessions = archiveConversation(state.sessions, settled, state.maxSessions);
      const conversations = state.conversations.filter((c) => c.id !== id);
      if (conversations.length === 0) {
        conversations.push(makeConversation(state.cwd));
      }
      set({
        sessions,
        conversations,
        activeConversationId:
          state.activeConversationId === id ? conversations[0].id : state.activeConversationId,
      });
    },

    setActiveConversation: (id) => {
      if (get().conversations.some((c) => c.id === id)) set({ activeConversationId: id });
    },

    openSessionTab: (sessionId) => {
      const state = get();
      const existing = state.conversations.find((c) => c.sessionId === sessionId);
      if (existing) {
        set({ activeConversationId: existing.id });
        return;
      }
      const sess = state.sessions.find((s) => s.sessionId === sessionId);
      if (!sess) return;
      get().newConversation({ fromSession: sess });
    },

    setDraft: (text) => {
      const state = get();
      const conv = state.conversations.find((c) => c.id === state.activeConversationId);
      if (!conv || conv.draft === text) return;
      set({ conversations: replaceConv(state.conversations, conv.id, { ...conv, draft: text }) });
    },

    sendPrompt: (prompt, conversationId) => {
      dispatchPrompt(prompt, conversationId || get().activeConversationId);
    },

    removeLastTurn: () => {
      const state = get();
      const conv = state.conversations.find((c) => c.id === state.activeConversationId);
      if (!conv) return null;
      const msgs = conv.messages;
      let userIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) return null;
      const text = msgs[userIdx].blocks.find((b) => b.kind === 'text')?.text?.trim();
      if (!text) return null;
      // 移除该 user 消息及其后全部（失败的 assistant 消息/stderr 等）
      set({
        conversations: replaceConv(state.conversations, conv.id, {
          ...conv,
          messages: msgs.slice(0, userIdx),
        }),
      });
      return text;
    },

    forceScrollNonce: 0,

    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,

    model: '',
    setModel: (model) => set({ model }),
    permissionMode: 'bypassPermissions',
    setPermissionMode: (permissionMode) => set({ permissionMode }),
    showThinking: true,
    setShowThinking: (showThinking) => set({ showThinking }),
    sidebarWidth: 256,
    setSidebarWidth: (sidebarWidth) => set({ sidebarWidth: Math.round(sidebarWidth) }),
    notifyOnComplete: true,
    setNotifyOnComplete: (notifyOnComplete) => set({ notifyOnComplete }),
    maxSessions: DEFAULT_MAX_SESSIONS,
    setMaxSessions: (maxSessions) =>
      set({ maxSessions: Math.max(1, Math.min(500, Math.floor(maxSessions) || DEFAULT_MAX_SESSIONS)) }),

    clearAllSessions: () => {
      const state = get();
      // 只清空归档列表；打开中的标签页不动（对话仍在，关闭时会按需重新归档）
      let totalCost = state.totalCost;
      let totalInputTokens = state.totalInputTokens;
      let totalOutputTokens = state.totalOutputTokens;
      for (const s of state.sessions) {
        totalCost -= s.cost || 0;
        totalInputTokens -= s.inputTokens || 0;
        totalOutputTokens -= s.outputTokens || 0;
      }
      set({
        sessions: [],
        totalCost: Math.max(0, totalCost),
        totalInputTokens: Math.max(0, totalInputTokens),
        totalOutputTokens: Math.max(0, totalOutputTokens),
      });
    },

    renameSession: (index, title) => {
      const sessions = get().sessions;
      if (index < 0 || index >= sessions.length) return;
      const t = title.trim();
      if (!t || t === sessions[index].title) return;
      set({ sessions: sessions.map((s, i) => (i === index ? { ...s, title: t } : s)) });
    },

    deleteSession: (index) => {
      const state = get();
      const sessions = state.sessions;
      if (index < 0 || index >= sessions.length) return;
      const removed = sessions[index];
      const newSessions = sessions.filter((_, i) => i !== index);

      // 从累计用量中扣除该会话的消耗，保持仪表盘与可见会话一致
      const totalCost = Math.max(0, state.totalCost - (removed.cost || 0));
      const totalInputTokens = Math.max(0, state.totalInputTokens - (removed.inputTokens || 0));
      const totalOutputTokens = Math.max(0, state.totalOutputTokens - (removed.outputTokens || 0));

      // 关闭该会话的非运行中标签页（内容已随条目删除）；运行中的保留，
      // 其关闭时会重新归档（CLI 侧会话仍在）
      let conversations = state.conversations.filter((c) => {
        if (c.sessionId !== removed.sessionId) return true;
        return c.status === 'streaming' || c.status === 'starting';
      });
      if (conversations.length === 0) {
        conversations = [makeConversation(state.cwd)];
      }
      const activeConversationId = conversations.some((c) => c.id === state.activeConversationId)
        ? state.activeConversationId
        : conversations[0].id;

      set({ sessions: newSessions, conversations, activeConversationId, totalCost, totalInputTokens, totalOutputTokens });
    },

    injectedText: null,
    injectText: (text) => set({ injectedText: { text, nonce: Date.now() } }),

    enqueueMessage: (text) => {
      const state = get();
      const conv = state.conversations.find((c) => c.id === state.activeConversationId);
      if (!conv) return;
      set({
        conversations: replaceConv(state.conversations, conv.id, { ...conv, queue: [...conv.queue, text] }),
      });
    },

    removeQueuedMessage: (index) => {
      const state = get();
      const conv = state.conversations.find((c) => c.id === state.activeConversationId);
      if (!conv) return;
      set({
        conversations: replaceConv(state.conversations, conv.id, {
          ...conv,
          queue: conv.queue.filter((_, i) => i !== index),
        }),
      });
    },

    searchOpen: false,
    setSearchOpen: (searchOpen) => set({ searchOpen }),
    highlightMessageId: null,
    setHighlightMessage: (highlightMessageId) => set({ highlightMessageId }),

    handleStream: (msg) => {
      const state = get();
      const convId = msg.conversationId || state.activeConversationId;
      const conv = state.conversations.find((c) => c.id === convId);
      if (!conv) return; // 标签页已关闭：残余事件直接丢弃

      // 中断后到达的残留流事件直接丢弃（进程退出前 stdout 缓冲区可能还有数据），
      // 否则会创建出永远无法归档的幽灵 streamingMessage
      if (conv.status === 'aborted' && (msg.type === 'assistant' || msg.type === 'user')) {
        return;
      }

      switch (msg.type) {
        case 'system': {
          if (msg.subtype === 'init') {
            set({
              conversations: replaceConv(state.conversations, convId, {
                ...conv,
                sessionId: msg.session_id,
                currentModel: msg.model || '',
                thinkingTokens: 0,
              }),
            });
          } else if (msg.subtype === 'thinking_tokens') {
            // 字段防御：畸形事件不写入 undefined
            set({
              conversations: replaceConv(state.conversations, convId, {
                ...conv,
                thinkingTokens: typeof msg.estimated_tokens === 'number' ? msg.estimated_tokens : 0,
              }),
            });
          }
          break;
        }

        case 'assistant': {
          // 字段防御：id/content 缺失时不得抛异常，也不得误判为同消息分片
          const msgId = typeof msg.message?.id === 'string' ? msg.message.id : null;
          const sameMsgShard = msgId !== null && lastAssistantMsgIds.get(convId) === msgId;
          lastAssistantMsgIds.set(convId, msgId);

          // 浅拷贝消息壳，后续块更新全部不可变（新数组/新块对象）：
          // 配合渲染层 React.memo，已完成块引用稳定可跳过重渲染
          const streaming: ChatMessage = conv.streamingMessage
            ? { ...conv.streamingMessage }
            : { id: genId(), role: 'assistant', blocks: [], timestamp: Date.now(), status: 'streaming' };

          const contentBlocks = Array.isArray(msg.message?.content) ? msg.message.content : [];

          // 1) tool_result：不可变地更新对应 tool_use 块（含子代理 children 路径）
          let blocks = streaming.blocks;
          for (const block of contentBlocks) {
            if (block.type === 'tool_result') {
              const r = applyToolResult(blocks, block);
              if (r.hit) blocks = r.blocks;
            }
          }

          // 2) text/thinking/tool_use：定位容器（顶层或子代理父块），不可变合并/追加。
          //    重新查找父块：步骤 1 可能已替换其 children 数组
          const parentId = msg.parent_tool_use_id;
          let parentToolId: string | null = null;
          let container: UIBlock[] = blocks;
          if (parentId) {
            const parent = findToolBlock(blocks, parentId);
            if (parent) {
              parentToolId = parent.toolId;
              container = [...(parent.children ?? [])];
            }
          }

          let touched = parentToolId !== null; // 子代理容器拷贝后必须写回
          for (const block of contentBlocks) {
            if (block.type === 'text') {
              // 同消息分片续写：仅当容器尾部是同一条消息的 text 块时追加。
              // 不得按 kind 全局查找——CLI 会把同一条消息拆成多个事件发送
              // （[thinking]、[text] 分片），若第 1 轮已有开场文本，后续轮次的
              // 最终答案会被拼进那个旧块，造成“结果在中间、后面跟着思考/工具”的错位
              const last = container[container.length - 1];
              if (sameMsgShard && last?.kind === 'text' && last.msgId === msgId) {
                container[container.length - 1] = { kind: 'text', text: last.text + block.text, msgId: msgId ?? undefined };
              } else {
                container.push({ kind: 'text', text: block.text, msgId: msgId ?? undefined });
                touched = true;
              }
            } else if (block.type === 'thinking') {
              const last = container[container.length - 1];
              if (sameMsgShard && last?.kind === 'thinking' && last.msgId === msgId) {
                container[container.length - 1] = { kind: 'thinking', text: last.text + block.thinking, msgId: msgId ?? undefined };
              } else {
                container.push({ kind: 'thinking', text: block.thinking, msgId: msgId ?? undefined });
                touched = true;
              }
            } else if (block.type === 'tool_use') {
              container.push({
                kind: 'tool_use',
                toolName: block.name,
                toolId: block.id,
                input: block.input,
                status: 'running',
              });
              touched = true;
            }
          }

          if (touched) {
            blocks = parentToolId ? replaceToolBlockChildren(blocks, parentToolId, container) : container;
          }
          streaming.blocks = blocks;

          set({
            conversations: replaceConv(state.conversations, convId, {
              ...conv,
              streamingMessage: streaming,
            }),
          });
          break;
        }

        case 'user': {
          // tool_result 通过 user 消息返回
          const streaming = conv.streamingMessage;
          const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
          if (streaming && content.length > 0) {
            let blocks = streaming.blocks;
            let hit = false;
            for (const block of content) {
              if (block.type === 'tool_result') {
                const r = applyToolResult(blocks, block);
                if (r.hit) {
                  blocks = r.blocks;
                  hit = true;
                }
              }
            }
            // 无命中时不发布新状态，避免无意义的重渲染
            if (hit) {
              set({
                conversations: replaceConv(state.conversations, convId, {
                  ...conv,
                  streamingMessage: { ...streaming, blocks },
                }),
              });
            }
          }
          break;
        }

        case 'result': {
          // stats 块以不可变方式附加（finalizeStreaming 不 mutate 原引用）
          const withStats = conv.streamingMessage
            ? { ...conv.streamingMessage, blocks: [...conv.streamingMessage.blocks, { kind: 'stats', data: msg } as UIBlock] }
            : null;

          const archived = finalizeStreaming(
            { ...conv, streamingMessage: withStats },
            msg.is_error ? 'error' : 'completed'
          );

          // 归档会话（标题取第一条用户消息）
          const firstUserMsg = conv.messages.find((m) => m.role === 'user');
          const title = firstUserMsg?.blocks.find((b) => b.kind === 'text')?.text?.slice(0, 50) || conv.title || 'Session';

          // 字段防御：CLI 版本间字段可能缺失/畸形，缺省按 0 处理而非 NaN 扩散
          const usage = msg.usage || {};
          const inputTokens = usage.input_tokens || 0;
          const outputTokens = usage.output_tokens || 0;
          const cost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0;

          // 上下文占用校准：
          // - limit 始终从 modelUsage.contextWindow 校准（真实上限）
          // - used 仅在单轮执行（num_turns <= 1）时可用 result.usage 更新——
          //   多轮工具循环的 result.usage 是整轮所有 API 调用的累计 input，
          //   远超真实上下文（实测可达上限的 10 倍），不能当占用值；
          //   多轮场景由轮末的 /context 查询提供真实占用。
          //   compact 后占用下降是正常现象，不做 Math.max 钉死。
          let contextUsage = conv.contextUsage;
          const modelUsage = msg.modelUsage ? Object.values(msg.modelUsage)[0] : undefined;
          if (modelUsage?.contextWindow) {
            const turns = typeof msg.num_turns === 'number' ? msg.num_turns : 1;
            if (turns <= 1) {
              const used =
                inputTokens +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                outputTokens;
              contextUsage = { used, limit: modelUsage.contextWindow };
            } else if (contextUsage) {
              contextUsage = { ...contextUsage, limit: modelUsage.contextWindow };
            }
          }

          // 本轮执行的成本事件（仪表盘按时间聚合用）
          const event: SessionEvent = {
            t: Date.now(),
            cost,
            input: inputTokens,
            output: outputTokens,
          };

          // session_id 缺失时跳过会话记账（否则会生成无法 --resume 的畸形条目），
          // 消息归档与成本累计照常进行
          const hasSessionId = typeof msg.session_id === 'string' && msg.session_id.length > 0;
          let sessions = state.sessions;
          if (hasSessionId) {
            const newSession: Session = {
              sessionId: msg.session_id,
              cwd: conv.cwd,
              title,
              messages: archived.messages,
              createdAt: Date.now(),
              cost,
              inputTokens,
              outputTokens,
              model: conv.currentModel || undefined,
              events: [event],
            };

            // 同 sessionId 的会话更新而非重复添加（多轮对话）
            const existingIdx = state.sessions.findIndex((s) => s.sessionId === msg.session_id);
            sessions = existingIdx >= 0
              ? state.sessions.map((s, i) => (i === existingIdx ? {
                  ...newSession,
                  createdAt: s.createdAt, // 保留首次创建时间
                  cost: s.cost + cost,
                  inputTokens: s.inputTokens + inputTokens,
                  outputTokens: s.outputTokens + outputTokens,
                  model: conv.currentModel || s.model,
                  events: [...(s.events || []), event],
                } : s))
              : [newSession, ...state.sessions];

            // 限制会话数量，超出部分丢弃最旧的
            sessions = sessions.slice(0, state.maxSessions > 0 ? state.maxSessions : DEFAULT_MAX_SESSIONS);
          }

          set({
            conversations: replaceConv(state.conversations, convId, {
              ...conv,
              messages: archived.messages,
              streamingMessage: null,
              status: msg.is_error ? 'error' : 'completed',
              contextUsage,
            }),
            totalCost: state.totalCost + cost,
            totalInputTokens: state.totalInputTokens + inputTokens,
            totalOutputTokens: state.totalOutputTokens + outputTokens,
            sessions,
          });

          // 队列续发/清空：result 是本轮的确定性终点（比 status 事件先到），
          // 即便该标签页在后台也必须处理
          if (msg.is_error) {
            const cur = get().conversations.find((c) => c.id === convId);
            if (cur && cur.queue.length > 0) {
              set({ conversations: replaceConv(get().conversations, convId, { ...cur, queue: [] }) });
            }
          } else {
            const cur = get().conversations.find((c) => c.id === convId);
            if (cur && cur.queue.length > 0) {
              const [next, ...rest] = cur.queue;
              set({ conversations: replaceConv(get().conversations, convId, { ...cur, queue: rest }) });
              dispatchPrompt(next, convId);
            }
          }
          break;
        }

        case 'stderr': {
          // 始终展示 stderr。runner 在 spawn 前（如 cwd 失效）就会发 stderr，
          // 此时可能还没有 streamingMessage；若不兜底，错误会被静默吞掉，
          // 表现为“点了发送没反应”。
          const streaming = conv.streamingMessage;
          if (!streaming) {
            // 当前进程已结束（error/aborted）时，直接作为已完成的错误消息入列，
            // 避免创建永远不会再收到结束事件的悬挂 streamingMessage
            const finished = conv.status === 'error' || conv.status === 'aborted';
            const standalone: ChatMessage = {
              id: genId(),
              role: 'assistant',
              blocks: [{ kind: 'stderr', text: msg.text }],
              timestamp: Date.now(),
              status: finished ? 'error' : 'streaming',
            };
            set({
              conversations: replaceConv(state.conversations, convId, {
                ...conv,
                ...(finished
                  ? { messages: [...conv.messages, standalone] }
                  : { streamingMessage: standalone }),
              }),
            });
            break;
          }
          set({
            conversations: replaceConv(state.conversations, convId, {
              ...conv,
              streamingMessage: { ...streaming, blocks: [...streaming.blocks, { kind: 'stderr', text: msg.text }] },
            }),
          });
          break;
        }

        default:
          break;
      }
    },

    setStatus: (status, conversationId) => {
      const state = get();
      const convId = conversationId || state.activeConversationId;
      const conv = state.conversations.find((c) => c.id === convId);
      if (!conv) return; // 标签页已关闭：忽略

      // 中断或出错时，把未完成的流式消息归档，避免内容丢失
      if ((status === 'aborted' || status === 'error') && conv.streamingMessage) {
        const archived = finalizeStreaming(conv, status === 'aborted' ? 'completed' : 'error');
        set({
          conversations: replaceConv(state.conversations, convId, {
            ...conv,
            ...archived,
            status,
            // 中断/出错丢弃排队消息：它们针对已失败的上下文，保留会在
            // 下一轮完成后突然发出，与用户随后的新指令串台
            queue: status === 'aborted' || status === 'error' ? [] : conv.queue,
          }),
        });
      } else if (conv.status !== status) {
        set({
          conversations: replaceConv(state.conversations, convId, { ...conv, status }),
        });
      }
    },

    setContextUsage: (usage, conversationId) => {
      const state = get();
      const convId = conversationId || state.activeConversationId;
      const conv = state.conversations.find((c) => c.id === convId);
      if (!conv || conv.contextUsage === usage) return;
      set({ conversations: replaceConv(state.conversations, convId, { ...conv, contextUsage: usage }) });
    },

    hydrate: (data) => {
      const sessions = data.sessions || [];

      // 标签页恢复：新格式（conversations 数组）或旧格式（单会话字段）迁移
      let conversations: Conversation[] = [];
      if (Array.isArray(data.conversations)) {
        for (const c of data.conversations as Conversation[]) {
          if (!c || typeof c.id !== 'string') continue;
          const restored: Conversation = {
            ...makeConversation(typeof c.cwd === 'string' ? c.cwd : data.cwd || ''),
            ...c,
            // 应用重启后进程已消失：运行态收敛
            status: c.status === 'streaming' || c.status === 'starting' ? 'aborted' : c.status || 'idle',
            streamingMessage: null,
            queue: [],
            messages: Array.isArray(c.messages) ? c.messages : [],
            sessionId: typeof c.sessionId === 'string' ? c.sessionId : null,
          };
          // 重启前仍在流式的消息：归档保留，避免整段内容丢失
//（归档为 completed：中断的历史内容不该挂重试按钮，与旧 setStatus 行为一致）
if (c.streamingMessage && Array.isArray(c.streamingMessage.blocks)) {
restored.messages = [...restored.messages, { ...c.streamingMessage, status: 'completed' as const }];
}
          conversations.push(restored);
        }
      } else if ((data.messages && data.messages.length > 0) || data.currentSessionId) {
        // 旧格式：全局单会话 → 单标签页
        conversations.push(
          makeConversation(data.cwd || '', {
            sessionId: data.currentSessionId ?? null,
            messages: data.messages || [],
          })
        );
      }
      if (conversations.length === 0) {
        conversations.push(makeConversation(data.cwd || ''));
      }

      const activeConversationId =
        typeof data.activeConversationId === 'string' &&
        conversations.some((c) => c.id === data.activeConversationId)
          ? data.activeConversationId
          : conversations[0].id;

      set({
        cwd: data.cwd || '',
        sessions,
        conversations,
        activeConversationId,
        totalCost: data.totalCost || 0,
        totalInputTokens: data.totalInputTokens || 0,
        totalOutputTokens: data.totalOutputTokens || 0,
        model: data.model || '',
        permissionMode: data.permissionMode || 'bypassPermissions',
        showThinking: data.showThinking !== false,
        notifyOnComplete: data.notifyOnComplete !== false,
        maxSessions: typeof data.maxSessions === 'number' && data.maxSessions > 0
          ? data.maxSessions
          : DEFAULT_MAX_SESSIONS,
        sidebarWidth: typeof data.sidebarWidth === 'number' && data.sidebarWidth >= 200 && data.sidebarWidth <= 480
          ? data.sidebarWidth
          : 256,
      });
    },
  };
});
