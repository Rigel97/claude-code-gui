import { create } from 'zustand';
import type { ChatMessage, ContextUsage, Session, SessionEvent, RunStatus, StreamMessage, UIBlock } from './types';

interface AppState {
  // 当前工作目录
  cwd: string;
  setCwd: (cwd: string) => void;

  // 当前会话
  currentSessionId: string | null;
  sessions: Session[];
  activeSessionIndex: number;

  // 当前对话的消息列表（已完成的）
  messages: ChatMessage[];

  // 运行状态
  status: RunStatus;
  thinkingTokens: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;

  // 当前流式消息（正在生成中的 assistant 消息）
  streamingMessage: ChatMessage | null;

  // 设置
  model: string;
  setModel: (model: string) => void;
  // CLI init 消息中返回的真实模型名
  currentModel: string;
  permissionMode: 'bypassPermissions' | 'acceptEdits';
  setPermissionMode: (mode: 'bypassPermissions' | 'acceptEdits') => void;
  showThinking: boolean;
  setShowThinking: (show: boolean) => void;

  // 输入框文本注入（文件树点击 @引用 等场景）
  injectedText: { text: string; nonce: number } | null;
  injectText: (text: string) => void;

  // 上下文窗口占用（水位计）
  contextUsage: ContextUsage | null;

  // 待发消息队列（生成中输入的消息排队，完成后自动续发）
  queue: string[];
  enqueueMessage: (text: string) => void;
  dequeueMessage: () => string | null;
  removeQueuedMessage: (index: number) => void;
  clearQueue: () => void;

  // 搜索面板
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  // 搜索跳转后需要高亮的消息
  highlightMessageId: string | null;
  setHighlightMessage: (id: string | null) => void;

  // 操作
  newSession: () => void;
  switchSession: (index: number) => void;
  deleteSession: (index: number) => void;
  addUserMessage: (text: string) => void;
  handleStream: (msg: StreamMessage) => void;
  setStatus: (status: RunStatus) => void;
  clearMessages: () => void;
  hydrate: (data: Partial<Pick<AppState, 'cwd' | 'sessions' | 'messages' | 'activeSessionIndex' | 'currentSessionId' | 'totalCost' | 'totalInputTokens' | 'totalOutputTokens' | 'model' | 'permissionMode' | 'showThinking'>>) => void;
}

let msgCounter = 0;
const genId = () => `msg-${++msgCounter}-${Date.now()}`;

/**
 * 上一条 assistant 流事件的 CLI message.id。
 * CLI 会把同一条 assistant 消息拆成多个事件（message.id 相同，实测确认），
 * 文本/思考块合并只允许发生在同 id 的分片之间；不同消息绝不合并，
 * 否则下一轮回复会被无分隔符拼进上一轮文本块、且时序错乱（显示在工具调用之前）。
 */
let lastAssistantMsgId: string | null = null;

/** 持久化保留的最大会话数，防止配置文件无限膨胀 */
const MAX_SESSIONS = 50;
/** 单条工具结果的最大保留长度（Bash 输出可能非常大） */
const MAX_TOOL_RESULT = 20000;

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
function finalizeStreaming(state: AppState, finalStatus: 'completed' | 'error'): {
  messages: ChatMessage[];
  streamingMessage: null;
} {
  const streaming = state.streamingMessage;
  if (!streaming) {
    return { messages: state.messages, streamingMessage: null };
  }
  return {
    messages: [...state.messages, { ...streaming, status: finalStatus }],
    streamingMessage: null,
  };
}

/**
 * 把尚未写入 sessions 的当前对话落库（切换/新建前调用）。
 * 背景：会话条目只在收到 result 时创建，被中断/出错的对话仅存在于内存中，
 * 切换会话会被目标会话的 messages 直接覆盖而永久丢失。
 */
function archiveCurrentConversation(state: AppState): Session[] {
  const { messages, sessions, currentSessionId, cwd } = state;
  if (!messages.length) return sessions;

  // 以 sessionId 定位已有条目（活跃索引可能未指向它，如旧版本持久化的数据）
  const idx = currentSessionId
    ? sessions.findIndex((s) => s.sessionId === currentSessionId)
    : -1;
  if (idx >= 0) {
    const existing = sessions[idx];
    if (existing.messages === messages) return sessions; // 无未落库变化
    // 已有条目：仅刷新消息（保留累计成本等，多轮中 result 之间的增量）
    return sessions.map((s, i) => (i === idx ? { ...s, messages } : s));
  }

  // 无条目：本轮还没有 result（被中断/出错）。currentSessionId 存在说明 CLI 侧
  // 已有该会话（--resume 可续接），保留为草稿；从未拿到 init 的纯错误输出不保留
  if (!currentSessionId) return sessions;
  if (!messages.some((m) => m.role === 'user')) return sessions;

  const firstUserMsg = messages.find((m) => m.role === 'user');
  const title = firstUserMsg?.blocks.find((b) => b.kind === 'text')?.text?.slice(0, 50) || 'Session';
  const draft: Session = {
    sessionId: currentSessionId,
    cwd,
    title,
    messages,
    createdAt: Date.now(),
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  return [draft, ...sessions].slice(0, MAX_SESSIONS);
}

export const useStore = create<AppState>((set, get) => ({
  cwd: '',
  setCwd: (cwd) => set({ cwd }),

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

  model: '',
  setModel: (model) => set({ model }),
  currentModel: '',
  permissionMode: 'bypassPermissions',
  setPermissionMode: (permissionMode) => set({ permissionMode }),
  showThinking: true,
  setShowThinking: (showThinking) => set({ showThinking }),

  injectedText: null,
  injectText: (text) => set({ injectedText: { text, nonce: Date.now() } }),

  contextUsage: null,

  queue: [],
  enqueueMessage: (text) => set({ queue: [...get().queue, text] }),
  dequeueMessage: () => {
    const [first, ...rest] = get().queue;
    if (first === undefined) return null;
    set({ queue: rest });
    return first;
  },
  removeQueuedMessage: (index) => set({ queue: get().queue.filter((_, i) => i !== index) }),
  clearQueue: () => set({ queue: [] }),

  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  highlightMessageId: null,
  setHighlightMessage: (highlightMessageId) => set({ highlightMessageId }),

  newSession: () => {
    // 生成中禁止新建会话，否则后续流事件会写入错误的会话
    const status = get().status;
    if (status === 'streaming' || status === 'starting') return;
    const state = get();
    // 先归档未落库的对话（无 result 即中断的对话保留在侧栏，--resume 仍可续接）
    const sessions = archiveCurrentConversation(state);
    set({
      sessions,
      currentSessionId: null,
      activeSessionIndex: -1,
      status: 'idle',
      streamingMessage: null,
      messages: [],
      thinkingTokens: 0,
      contextUsage: null,
      queue: [], // 清空待发队列，防止旧会话的排队消息发到新会话
    });
  },

  switchSession: (index) => {
    // 生成中禁止切换会话，防止消息归档错乱
    const status = get().status;
    if (status === 'streaming' || status === 'starting') return;
    const state = get();
    const target = state.sessions[index];
    if (!target) return;
    // 先归档当前未落库的对话。归档可能 prepend 草稿导致索引位移，故按 sessionId 重定位目标
    const sessions = archiveCurrentConversation(state);
    const newIndex = sessions.findIndex((s) => s.sessionId === target.sessionId);
    if (newIndex < 0) return; // 极端：目标被 MAX_SESSIONS 裁剪
    const archivedTarget = sessions[newIndex];
    set({
      sessions,
      activeSessionIndex: newIndex,
      currentSessionId: archivedTarget.sessionId,
      cwd: archivedTarget.cwd,
      status: 'idle',
      streamingMessage: null,
      messages: archivedTarget.messages,
      queue: [], // 切换会话时清空待发队列
    });
  },

  deleteSession: (index) => {
    // 生成中禁止删除，避免与正在归档的流式状态冲突
    const status = get().status;
    if (status === 'streaming' || status === 'starting') return;

    const sessions = get().sessions;
    if (index < 0 || index >= sessions.length) return;

    const removed = sessions[index];
    const isActive = index === get().activeSessionIndex;
    const newSessions = sessions.filter((_, i) => i !== index);

    // 删除会话时从累计成本中扣除该会话的消耗，保持仪表盘与可见会话一致
    const totalCost = Math.max(0, get().totalCost - (removed.cost || 0));
    const totalInputTokens = Math.max(0, get().totalInputTokens - (removed.inputTokens || 0));
    const totalOutputTokens = Math.max(0, get().totalOutputTokens - (removed.outputTokens || 0));

    if (isActive) {
      // 删除的是当前活跃会话
      if (newSessions.length === 0) {
        // 无剩余会话：回到空白状态
        set({
          sessions: [],
          activeSessionIndex: -1,
          currentSessionId: null,
          messages: [],
          streamingMessage: null,
          status: 'idle',
          thinkingTokens: 0,
          contextUsage: null,
          queue: [],
          totalCost,
          totalInputTokens,
          totalOutputTokens,
        });
      } else {
        // 切换到删除位置上的新会话（越界则取最后一个），行为与 switchSession 对齐
        const newActive = Math.min(index, newSessions.length - 1);
        const session = newSessions[newActive];
        set({
          sessions: newSessions,
          activeSessionIndex: newActive,
          currentSessionId: session.sessionId,
          cwd: session.cwd,
          status: 'idle',
          streamingMessage: null,
          messages: session.messages,
          queue: [],
          totalCost,
          totalInputTokens,
          totalOutputTokens,
        });
      }
    } else {
      // 删除的是非活跃会话：仅从列表移除，并修正活跃索引使其仍指向原会话
      const oldActive = get().activeSessionIndex;
      const newActive = index < oldActive ? oldActive - 1 : oldActive;
      set({
        sessions: newSessions,
        activeSessionIndex: newActive,
        totalCost,
        totalInputTokens,
        totalOutputTokens,
      });
    }
  },

  addUserMessage: (text) => {
    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      blocks: [{ kind: 'text', text }],
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

    set({
      messages: [...get().messages, userMsg],
      streamingMessage: assistantMsg,
      status: 'streaming',
    });
  },

  handleStream: (msg) => {
    const state = get();

    // 中断后到达的残留流事件直接丢弃（进程退出前 stdout 缓冲区可能还有数据），
    // 否则会创建出永远无法归档的幽灵 streamingMessage
    if (state.status === 'aborted' && (msg.type === 'assistant' || msg.type === 'user')) {
      return;
    }

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          set({
            currentSessionId: msg.session_id,
            currentModel: msg.model || '',
            thinkingTokens: 0,
          });
        } else if (msg.subtype === 'thinking_tokens') {
          // 字段防御：畸形事件不写入 undefined
          set({ thinkingTokens: typeof msg.estimated_tokens === 'number' ? msg.estimated_tokens : 0 });
        }
        break;
      }

      case 'assistant': {
        // 字段防御：id/content 缺失时不得抛异常，也不得误判为同消息分片
        const msgId = typeof msg.message?.id === 'string' ? msg.message.id : null;
        const sameMsgShard = msgId !== null && lastAssistantMsgId === msgId;
        lastAssistantMsgId = msgId;

        // 浅拷贝消息壳，后续块更新全部不可变（新数组/新块对象）：
        // 配合渲染层 React.memo，已完成块引用稳定可跳过重渲染
        const streaming: ChatMessage = state.streamingMessage
          ? { ...state.streamingMessage }
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
            const idx = sameMsgShard ? container.findIndex((b) => b.kind === 'text') : -1;
            if (idx >= 0 && container[idx].kind === 'text') {
              container[idx] = { kind: 'text', text: container[idx].text + block.text };
            } else {
              container.push({ kind: 'text', text: block.text });
              touched = true;
            }
          } else if (block.type === 'thinking') {
            const idx = sameMsgShard ? container.findIndex((b) => b.kind === 'thinking') : -1;
            if (idx >= 0 && container[idx].kind === 'thinking') {
              container[idx] = { kind: 'thinking', text: container[idx].text + block.thinking };
            } else {
              container.push({ kind: 'thinking', text: block.thinking });
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

        // 上下文占用采样：assistant 消息的 usage 反映当前上下文体量
        let contextUsage = state.contextUsage;
        const usage = msg.message?.usage as Record<string, number> | undefined;
        if (usage) {
          const used =
            (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0);
          if (used > 0) {
            contextUsage = { used, limit: contextUsage?.limit || 200000 };
          }
        }

        set({ streamingMessage: streaming, contextUsage });
        break;
      }

      case 'user': {
        // tool_result 通过 user 消息返回
        const streaming = state.streamingMessage;
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
          if (hit) set({ streamingMessage: { ...streaming, blocks } });
        }
        break;
      }

      case 'result': {
        // stats 块以不可变方式附加（finalizeStreaming 不 mutate 原引用）
        const withStats = state.streamingMessage
          ? { ...state.streamingMessage, blocks: [...state.streamingMessage.blocks, { kind: 'stats', data: msg } as UIBlock] }
          : null;

        const archived = finalizeStreaming(
          { ...state, streamingMessage: withStats },
          msg.is_error ? 'error' : 'completed'
        );

        // 归档会话（标题取第一条用户消息）
        const firstUserMsg = state.messages.find((m) => m.role === 'user');
        const title = firstUserMsg?.blocks.find((b) => b.kind === 'text')?.text?.slice(0, 50) || 'Session';

        // 字段防御：CLI 版本间字段可能缺失/畸形，缺省按 0 处理而非 NaN 扩散
        const usage = msg.usage || {};
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0;

        // 用 result 中的真实 contextWindow 校准水位上限
        let contextUsage = state.contextUsage;
        const modelUsage = msg.modelUsage ? Object.values(msg.modelUsage)[0] : undefined;
        if (modelUsage?.contextWindow) {
          const used =
            inputTokens +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0);
          contextUsage = { used: Math.max(used, contextUsage?.used || 0), limit: modelUsage.contextWindow };
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
        let activeSessionIndex = state.activeSessionIndex;
        if (hasSessionId) {
          const newSession: Session = {
            sessionId: msg.session_id,
            cwd: state.cwd,
            title,
            messages: archived.messages,
            createdAt: Date.now(),
            cost,
            inputTokens,
            outputTokens,
            model: state.currentModel || undefined,
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
                model: state.currentModel || s.model,
                events: [...(s.events || []), event],
              } : s))
            : [newSession, ...state.sessions];

          // 限制会话数量，超出部分丢弃最旧的
          sessions = sessions.slice(0, MAX_SESSIONS);

          // 活跃索引指向本会话：侧栏高亮与搜索去重都依赖它。
          // 新会话 prepend 在 0（不会被裁剪）；更新已有会话时索引即其原位置
          activeSessionIndex = existingIdx >= 0 ? existingIdx : 0;
        }

        set({
          ...archived,
          status: msg.is_error ? 'error' : 'completed',
          totalCost: state.totalCost + cost,
          totalInputTokens: state.totalInputTokens + inputTokens,
          totalOutputTokens: state.totalOutputTokens + outputTokens,
          sessions,
          activeSessionIndex,
          contextUsage,
        });
        break;
      }

      case 'stderr': {
        // 始终展示 stderr。runner 在 spawn 前（如 cwd 失效）就会发 stderr，
        // 此时可能还没有 streamingMessage；若不兜底，错误会被静默吞掉，
        // 表现为“点了发送没反应”。
        const streaming = state.streamingMessage;
        if (!streaming) {
          // 当前进程已结束（error/aborted）时，直接作为已完成的错误消息入列，
          // 避免创建永远不会再收到结束事件的悬挂 streamingMessage
          const finished = state.status === 'error' || state.status === 'aborted';
          const standalone: ChatMessage = {
            id: genId(),
            role: 'assistant',
            blocks: [{ kind: 'stderr', text: msg.text }],
            timestamp: Date.now(),
            status: finished ? 'error' : 'streaming',
          };
          if (finished) {
            set({ messages: [...state.messages, standalone] });
          } else {
            set({ streamingMessage: standalone });
          }
          break;
        }
        set({ streamingMessage: { ...streaming, blocks: [...streaming.blocks, { kind: 'stderr', text: msg.text }] } });
        break;
      }

      default:
        break;
    }
  },

  setStatus: (status) => {
    const state = get();
    // 中断或出错时，把未完成的流式消息归档，避免内容丢失
    if ((status === 'aborted' || status === 'error') && state.streamingMessage) {
      const archived = finalizeStreaming(state, status === 'aborted' ? 'completed' : 'error');
      set({ ...archived, status });
    } else {
      set({ status });
    }
  },

  clearMessages: () => set({ messages: [], streamingMessage: null, thinkingTokens: 0, status: 'idle' }),

  hydrate: (data) => {
    const sessions = data.sessions || [];
    // 恢复上次活跃的会话索引（越界则回退到最新会话）
    let idx = typeof data.activeSessionIndex === 'number' ? data.activeSessionIndex : 0;
    if (idx < 0 || idx >= sessions.length) idx = sessions.length > 0 ? 0 : -1;
    // 活跃索引优先对齐 currentSessionId 对应的会话（旧版本数据可能持久化了 -1）
    const matchIdx = data.currentSessionId
      ? sessions.findIndex((s) => s.sessionId === data.currentSessionId)
      : -1;
    if (matchIdx >= 0) {
      idx = matchIdx;
    } else if (data.currentSessionId && data.messages && data.messages.length > 0) {
      // currentSessionId 无匹配条目且存在持久化消息：未归档对话，不高亮任何会话
      idx = -1;
    }
    const active = idx >= 0 ? sessions[idx] : null;
    // 优先用持久化的 messages（可能包含未归档的中断对话），否则取活跃会话的消息
    const messages = data.messages && data.messages.length > 0
      ? data.messages
      : active?.messages || [];
    set({
      cwd: data.cwd || '',
      sessions,
      totalCost: data.totalCost || 0,
      totalInputTokens: data.totalInputTokens || 0,
      totalOutputTokens: data.totalOutputTokens || 0,
      model: data.model || '',
      permissionMode: data.permissionMode || 'bypassPermissions',
      showThinking: data.showThinking !== false,
      activeSessionIndex: idx,
      currentSessionId: data.currentSessionId ?? active?.sessionId ?? null,
      messages,
    });
  },
}));
