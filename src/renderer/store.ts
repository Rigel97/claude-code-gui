import { create } from 'zustand';
import type { ActivityState, ChatMessage, ContextUsage, Conversation, Session, SessionEvent, RunStatus, StreamMessage, UIBlock, TodoItem, PermissionMode, ConversationRuntime } from './types';
import { deliverPrompt, closeRuntime, generateUserMessageId, registerStopHandler } from './utils/deliver';

interface AppState {
  // 全局：工作目录（新会话的默认 cwd；已开会话各自快照，互不影响）
  cwd: string;
  setCwd: (cwd: string) => void;

  // 归档会话列表（侧栏「会话」tab 的数据源）
  sessions: Session[];

  // 多标签页：每个 tab 一个独立对话
  conversations: Conversation[];
  activeConversationId: string;
  newConversation: (opts?: { fromSession?: Session; cwd?: string; id?: string; title?: string; draft?: string }) => string;
  closeConversation: (id: string) => void;
  setActiveConversation: (id: string) => void;
  /** 侧栏点击归档会话：已开则激活，未开则新 tab 载入 */
  openSessionTab: (sessionId: string) => void;
  setDraft: (text: string, conversationId?: string) => void;
  /** 发送一条消息（写入消息流 + 拉起 CLI），默认作用于活跃标签页 */
  sendPrompt: (prompt: string, conversationId?: string, opts?: { interrupt?: boolean }) => Promise<void>;
  retryLastTurn: (conversationId?: string) => Promise<void>;
  setRuntime: (conversationId: string, runtime: ConversationRuntime | null | undefined) => void;
  setSessionMessages: (conversationId: string, messages: unknown[] | { messages: unknown[]; raw?: unknown }) => void;
  importSession: (session: { sessionId: string; cwd: string; title?: string; messages: unknown[] | { messages: unknown[]; raw?: unknown } }) => string;
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
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  showThinking: boolean;
  setShowThinking: (show: boolean) => void;
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  notifyOnComplete: boolean;
  setNotifyOnComplete: (on: boolean) => void;
maxSessions: number;
setMaxSessions: (n: number) => void;
// 思考深度（--effort）：空 = CLI 默认
effortLevel: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
setEffortLevel: (level: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') => void;
// 上下文自动压缩窗口（--autocompact）：'auto' 或 '100k'~'1M'；空 = CLI 默认
autocompact: '' | 'auto' | '100k' | '200k' | '400k' | '800k' | '1M';
setAutocompact: (v: '' | 'auto' | '100k' | '200k' | '400k' | '800k' | '1M') => void;
// 单次任务预算上限美元（--max-budget-usd），0 = 不限制
maxBudgetUsd: number;
setMaxBudgetUsd: (n: number) => void;
// 动态视频背景：path 为本机绝对路径，经主进程 bgmedia:// 协议流式播放
videoBg: { enabled: boolean; path: string | null };
setVideoBg: (patch: { enabled?: boolean; path?: string | null }) => void;
  clearAllSessions: () => void;
  renameSession: (index: number, title: string) => void;
  /** 置顶/取消置顶（置顶项浮到列表顶部） */
  togglePinSession: (index: number) => void;
  deleteSession: (index: number) => void;

  // 输入框文本注入（文件树点击 @引用 / 粘贴图片路径等）。
  // convId 记录注入时的目标标签页：消费端（InputBar）按其匹配后才消费，
  // 且消费后立即清除——否则 InputBar 每次重挂载（切 tab/新开/关闭标签页）
  // 都会因 effect 随挂载执行而把残留路径重复追加进输入框
  injectedText: { text: string; nonce: number; convId: string } | null;
  injectText: (text: string) => void;
  clearInjectedText: () => void;

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
  setStatus: (status: RunStatus, conversationId?: string, runId?: string) => boolean;
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
    permissionMode?: PermissionMode;
    showThinking?: boolean;
    notifyOnComplete?: boolean;
maxSessions?: number;
sidebarWidth?: number;
effortLevel?: string;
autocompact?: string;
    maxBudgetUsd?: number;
    videoBg?: { enabled?: boolean; path?: string | null };
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
const finite = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const permissionModes = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk'];

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
    activity: null,
    todoList: null,
    commands: [],
    pendingApprovals: [],
    protocolConnected: false,
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
  return text;
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
  block: { tool_use_id: string; content: unknown; is_error?: boolean; structuredResult?: unknown }
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
        resultContent: block.content,
        ...(block.structuredResult !== undefined ? { structuredResult: block.structuredResult } : {}),
        finishedAt: Date.now(),
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

// 归档时同样保持置顶项浮顶（受 maxSessions 截断保护）
function archiveConversationSorted(sessions: Session[], conv: Conversation, maxSessions: number): Session[] {
  return sortSessions(archiveConversation(sessions, conv, maxSessions));
}

/** 回填已存在 tool_use 卡片的 input（stream_event 预创建卡片后，完整事件到达时补全参数）。
 *  不可变：未命中返回原数组 */
function backfillToolInput(blocks: UIBlock[], toolId: string, input: Record<string, unknown>): UIBlock[] {
  let changed = false;
  const next = blocks.map((b) => {
    if (b.kind === 'tool_use') {
      if (b.toolId === toolId) {
        changed = true;
        return { ...b, input };
      }
      if (b.children) {
        const nested = backfillToolInput(b.children, toolId, input);
        if (nested !== b.children) {
          changed = true;
          return { ...b, children: nested };
        }
      }
    }
    return b;
  });
  return changed ? next : blocks;
}

/** 不可变替换指定标签页 */
function replaceConv(conversations: Conversation[], id: string, next: Conversation): Conversation[] {
  return conversations.map((c) => (c.id === id ? next : c));
}

/** 置顶会话浮顶排序（Array.sort 稳定：非置顶项保持原有顺序） */
function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

/** 在一个块列表中找最后一次 TodoWrite 调用的清单（同列表多次调用取最新） */
function findTodoInBlocks(blocks: UIBlock[]): TodoItem[] | null {
  let found: TodoItem[] | null = null;
  const walk = (list: UIBlock[]) => {
    for (const b of list) {
      if (b.kind !== 'tool_use') continue;
      if (b.toolName === 'TodoWrite' && b.input && Array.isArray((b.input as Record<string, unknown>).todos)) {
        const items = ((b.input as Record<string, unknown>).todos as unknown[])
          .filter(
            (t): t is { content: string; status?: string; activeForm?: unknown } =>
              !!t && typeof t === 'object' && typeof (t as { content?: unknown }).content === 'string'
          )
          .map((t): TodoItem => ({
            content: t.content,
            status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
            ...(typeof t.activeForm === 'string' ? { activeForm: t.activeForm } : {}),
          }));
        found = items;
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return found;
}

/** Rebuild only committed tool effects, in transcript order, with agent-local task IDs. */
function latestTodoFrom(conv: Pick<Conversation, 'messages' | 'streamingMessage'>): TodoItem[] | null {
  let items: TodoItem[] = [];
  let found = false;
  const walk = (blocks: UIBlock[], namespace = '') => {
    for (const b of blocks) {
      if (b.kind !== 'tool_use') continue;
      const id = (value: unknown) => `${namespace}${String(value)}`;
      if (b.status === 'done') {
        let response: any = b.structuredResult ?? b.resultContent ?? b.result;
        if (typeof response === 'string' || Array.isArray(response)) {
          try { response = JSON.parse(extractToolResultText(response)); } catch { response = null; }
        }
        const task = response?.task ?? response;
        const normalize = (value: any, previous?: TodoItem): TodoItem | null => {
          if (!value || typeof value !== 'object') return null;
          const rawId = value.id ?? value.taskId;
          const content = value.subject ?? value.content ?? previous?.content;
          if (typeof content !== 'string') return null;
          const status = value.status ?? previous?.status;
          const blocked = value.blockedBy ?? previous?.blockedBy;
          return { ...(previous ?? {}), content,
            status: status === 'completed' || status === 'in_progress' ? status : 'pending',
            ...(rawId != null ? { id: id(rawId) } : {}),
            ...(Array.isArray(blocked) ? { blockedBy: blocked.map((v: unknown) => namespace && String(v).startsWith(namespace) ? String(v) : id(v)) } : {}),
            ...(typeof value.activeForm === 'string' ? { activeForm: value.activeForm } : {}),
          };
        };
        const upsert = (value: any) => {
          const key = value?.id ?? value?.taskId;
          const previous = items.find(t => t.id === id(key));
          if (value?.status === 'deleted') { items = items.filter(t => t.id !== id(key)); found = true; return; }
          const next = normalize(value, previous);
          if (!next) return;
          items = previous ? items.map(t => t === previous ? next : t) : [...items, next]; found = true;
        };
        if (b.toolName === 'TodoWrite' && Array.isArray(b.input.todos)) {
          // TodoWrite replaces its own anonymous list, not tasks belonging to other agents.
          const next = b.input.todos.map(t => normalize(t)).filter((t): t is TodoItem => !!t);
          items = [...items.filter(t => t.id), ...next]; found = true;
        } else if (b.toolName === 'TaskCreate') {
          const match = b.result?.match(/^(?:Task #([\w-]+) created successfully:|Created task #([\w-]+)(?::|\s|$))/i);
          const key = task?.id ?? task?.taskId ?? match?.[1] ?? match?.[2];
          if (key != null) upsert({ ...b.input, ...(task && typeof task === 'object' ? task : {}), id: key });
        } else if (b.toolName === 'TaskUpdate') {
          const key = b.input.taskId ?? task?.id;
          if (key != null) {
            const previous = items.find(t => t.id === id(key));
            const blocked = [...new Set([...(previous?.blockedBy ?? []), ...(Array.isArray(b.input.addBlockedBy) ? b.input.addBlockedBy.map(id) : [])])];
            upsert({ ...b.input, ...(task && typeof task === 'object' ? task : {}), id: key, blockedBy: blocked });
          }
        } else if (b.toolName === 'TaskGet' && task && typeof task === 'object') upsert(task);
        else if (b.toolName === 'TaskList') {
          const tasks = Array.isArray(response) ? response : response?.tasks;
          if (Array.isArray(tasks)) {
            items = items.filter(t => !t.id || (namespace ? !t.id.startsWith(namespace) : t.id.includes(':')));
            for (const task of tasks) upsert(task);
            found = true;
          }
        }
      }
      if (b.children) walk(b.children, `${b.toolId}:`);
    }
  };
  for (const m of conv.messages) walk(m.blocks);
  if (conv.streamingMessage) walk(conv.streamingMessage.blocks);
  return found ? items : null;
}

/** hydrate 防御：只接受形状合法的 todoList */
function sanitizeTodoList(v: unknown): Conversation['todoList'] {
  if (!v || typeof v !== 'object') return null;
  const items = (v as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const ok = items.every(
    (t) => t && typeof t === 'object' && typeof (t as { content?: unknown }).content === 'string'
  );
  return ok ? (v as Conversation['todoList']) : null;
}

function persistentConversation(c: Conversation): Conversation {
  // Allowlist: never spread persisted unknown keys (options/env/approvals).
  return { id: c.id, title: c.title, sessionId: c.sessionId, cwd: c.cwd,
    messages: c.messages, streamingMessage: c.streamingMessage, status: c.status,
    thinkingTokens: c.thinkingTokens, contextUsage: c.contextUsage, queue: c.queue,
    currentModel: c.currentModel, draft: c.draft, activity: null, todoList: c.todoList };
}

/** SDK history pages and raw JSONL rows share this adapter; tool results update preceding cards. */
export function convertSessionMessages(page: unknown[] | { messages: unknown[]; raw?: unknown }): ChatMessage[] {
  const rows = Array.isArray(page) ? page : page.messages;
  let messages: ChatMessage[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, any>;
    if (typeof row.uuid === 'string' && seen.has(row.uuid)) continue;
    if (typeof row.uuid === 'string') seen.add(row.uuid);
    if (Array.isArray(row.blocks) && ['user', 'assistant', 'system'].includes(row.role)) {
      messages.push(row as ChatMessage); continue;
    }
    const content = typeof row.message?.content === 'string' ? [{ type: 'text', text: row.message.content }]
      : Array.isArray(row.message?.content) ? row.message.content : [];
    const blocks: UIBlock[] = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        messages = messages.map(m => {
          const result = applyToolResult(m.blocks, { ...b, structuredResult: row.tool_use_result });
          return result.hit ? { ...m, blocks: result.blocks, endUuid: row.uuid ?? m.endUuid } : m;
        });
      } else if (b.type === 'text' && typeof b.text === 'string') blocks.push({ kind: 'text', text: b.text, msgId: row.message?.id });
      else if (b.type === 'thinking' && typeof b.thinking === 'string') blocks.push({ kind: 'thinking', text: b.thinking, msgId: row.message?.id });
      else if (b.type === 'tool_use') blocks.push({ kind: 'tool_use', toolId: b.id, toolName: b.name, input: b.input ?? {}, status: 'running', metadata: b });
      else blocks.push({ kind: 'notice', text: b.type || 'content', raw: b });
    }
    const role = row.type ?? row.message?.role;
    if (!['user', 'assistant'].includes(role)) {
      messages.push({ id: genId(), role: 'system', timestamp: Date.now(), status: 'completed', cliUuid: row.uuid, endUuid: row.uuid,
        metadata: row, blocks: [{ kind: 'notice', text: row.subtype || row.type || 'system', raw: row }] });
    } else if (blocks.length) {
      const parentId = row.parent_tool_use_id;
      const parentIndex = typeof parentId === 'string' ? messages.findIndex(m => findToolBlock(m.blocks, parentId)) : -1;
      if (parentIndex >= 0) {
        const target = messages[parentIndex];
        const parent = findToolBlock(target.blocks, parentId)!;
        messages[parentIndex] = { ...target, endUuid: row.uuid ?? target.endUuid,
          blocks: replaceToolBlockChildren(target.blocks, parentId, [...(parent.children ?? []), ...blocks]) };
      } else messages.push({ id: genId(), role, blocks, timestamp: Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : Date.now(),
        status: 'completed', cliUuid: row.uuid, endUuid: row.uuid, metadata: row });
    }
  }
  return messages;
}

/** 持久化快照可安全序列化的标签页子集（运行态字段收敛） */
export function snapshotConversations(conversations: Conversation[]): Conversation[] {
  return conversations.slice(0, MAX_PERSIST_CONVERSATIONS).map((c) => ({
    ...persistentConversation(c),
    // 瞬态字段不持久化：activity 是运行时阶段，重启后无意义
    activity: null,
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
  // ── 逐 token 流式（--include-partial-messages）的 delta 基础设施 ──
  // 每个 API 轮次：message_start 带来 msgId → thinking/text 逐 delta 到达（40ms 节流
  // 合并后一次 set，避免高频更新打爆 React）→ 完整 assistant 事件到达时按 msgId
  // 去重（内容已由 delta 构建，仅回填 tool_use 的 input）
  const scopeKey = (convId: string, parentId?: string | null) => JSON.stringify([convId, parentId ?? null]);
  const deltaMsgIds = new Map<string, string | null>();
  const messageKey = (convId: string, parentId?: string | null, msgId?: string | null) => JSON.stringify([convId, parentId ?? null, msgId ?? null]);
  // CLI emits one normalised assistant content[0] BEFORE content_block_stop.
  // Its ordinal is not the API index; retain the cursor and UUID binding per message/parent.
  const streamBlockCursors = new Map<string, { index: number; kind: string }>();
  const assistantBlockIndices = new Map<string, number>();
  const lastAssistantUuids = new Map<string, string | undefined>();
  const toolInputs = new Map<string, { toolId: string; json: string }>();
  const pendingDeltas = new Map<string, { kind: 'text' | 'thinking'; chunk: string; parentId?: string | null; msgId?: string; index: number }[]>();
  const deltaTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const DELAY_FLUSH_MS = 40;
  const backgroundConversations = new Set<string>();
  const pendingBatches = new Set<string>();

  const flushDeltas = (convId: string) => {
    const timer = deltaTimers.get(convId);
    if (timer) {
      clearTimeout(timer);
      deltaTimers.delete(convId);
    }
    const list = pendingDeltas.get(convId);
    if (!list || list.length === 0) return;
    pendingDeltas.set(convId, []);
    const state = get();
    const conv = state.conversations.find((c) => c.id === convId);
    if (!conv) {
      pendingDeltas.delete(convId);
      return; // 标签页已关闭：丢弃缓冲
    }
    let streaming = conv.streamingMessage;
    let messages = conv.messages;
    for (const d of list) {
      const archivedIndex = d.parentId && !findToolBlock(streaming?.blocks ?? [], d.parentId)
        ? messages.findIndex(m => findToolBlock(m.blocks, d.parentId!)) : -1;
      const background = archivedIndex >= 0 || (!streaming && ['completed', 'error', 'aborted'].includes(conv.status));
      const target: ChatMessage = archivedIndex >= 0 ? messages[archivedIndex] : streaming ?? {
        id: genId(), role: 'assistant', timestamp: Date.now(), status: 'streaming', blocks: [],
      };
      const parent = d.parentId ? findToolBlock(target.blocks, d.parentId) : null;
      const container = [...(parent ? parent.children ?? [] : target.blocks)];
      const at = container.findIndex(b => b.kind === d.kind && b.msgId === d.msgId && b.blockIndex === d.index);
      const existing = container[at];
      if (existing?.kind === d.kind) container[at] = { ...existing, text: existing.text + d.chunk };
      else container.push({ kind: d.kind, text: d.chunk, msgId: d.msgId, blockIndex: d.index });
      const updated = { ...target, blocks: parent ? replaceToolBlockChildren(target.blocks, parent.toolId, container) : container };
      if (background) {
        backgroundConversations.add(convId);
        messages = archivedIndex >= 0 ? messages.map((m, i) => i === archivedIndex ? updated : m)
          : [...messages, { ...updated, status: 'completed' }];
      } else streaming = updated;
    }
    set({ conversations: replaceConv(state.conversations, convId, { ...conv, messages, streamingMessage: streaming,
      ...(!streaming ? { activity: null } : {}),
    }) });
  };

  const queueDelta = (convId: string, kind: 'text' | 'thinking', chunk: string, parentId?: string | null, index = 0) => {
    const list = pendingDeltas.get(convId) || [];
    const msgId = deltaMsgIds.get(scopeKey(convId, parentId)) ?? undefined;
    streamBlockCursors.set(messageKey(convId, parentId, msgId), { index, kind });
    list.push({ kind, chunk, parentId, msgId, index });
    pendingDeltas.set(convId, list);
    if (!deltaTimers.has(convId)) {
      deltaTimers.set(
        convId,
        setTimeout(() => {
          deltaTimers.delete(convId);
          flushDeltas(convId);
        }, DELAY_FLUSH_MS)
      );
    }
  };

  /** 更新执行阶段（反馈条）：同阶段不重复 set，避免 delta 高频触发 */
  const setActivity = (convId: string, phase: ActivityState['phase'], toolName?: string) => {
    const state = get();
    const conv = state.conversations.find((c) => c.id === convId);
    if (!conv) return;
    const cur = conv.activity;
    if (cur && cur.phase === phase && (cur.toolName || undefined) === (toolName || undefined)) return;
    set({
      conversations: replaceConv(state.conversations, convId, {
        ...conv,
        activity: { phase, toolName, since: Date.now() },
      }),
    });
  };

  /** 同步 TodoWrite 任务清单到会话状态（assistant 事件后调用，fresh 读取） */
  const syncTodosFromBlocks = (convId: string) => {
    const state = get();
    const conv = state.conversations.find((c) => c.id === convId);
    if (!conv) return;
    const items = latestTodoFrom(conv);
    if (!items) return; // 本轮无 TodoWrite：保留旧清单
    const cur = conv.todoList;
    if (cur && JSON.stringify(cur.items) === JSON.stringify(items)) return; // 无变化不 set
    set({
      conversations: replaceConv(state.conversations, convId, {
        ...conv,
        todoList: { items, updatedAt: Date.now() },
      }),
    });
  };

  /** AI 自动命名（异步）：会话首次归档后触发一次；
   *  仅覆盖 autoTitled 标记的会话（手动改名后标记清除，永不覆盖） */
  const autoTitleSession = async (
    sessionId: string,
    cwd: string,
    fallbackConvTitle: string,
    firstUserText: string
  ) => {
    try {
      const api = (window as any).api;
      if (typeof api?.claude?.generateTitle !== 'function') return;
      const t = await api.claude.generateTitle(cwd, firstUserText.slice(0, 400));
      if (typeof t !== 'string' || !t.trim()) return;
      const state = get();
      const idx = state.sessions.findIndex((s) => s.sessionId === sessionId);
      if (idx < 0) return; // 条目已被删除
      const sess = state.sessions[idx];
      if (sess.autoTitled !== true || sess.title === t) return; // 手动改名/已同名：不覆盖
      set({
        sessions: state.sessions.map((s, i) => (i === idx ? { ...s, title: t, autoTitled: true } : s)),
        conversations: state.conversations.map((c) =>
          c.sessionId === sessionId && c.title === fallbackConvTitle ? { ...c, title: t } : c
        ),
      });
    } catch {
      /* 静默：保留截断标题 */
    }
  };

  const dropDeltaState = (convId: string, forgetMessages = true) => {
    const timer = deltaTimers.get(convId);
    if (timer) {
      clearTimeout(timer);
      deltaTimers.delete(convId);
    }
    pendingDeltas.delete(convId);
    for (const key of deltaMsgIds.keys()) if (JSON.parse(key)[0] === convId) deltaMsgIds.delete(key);
    if (forgetMessages) {
      for (const key of streamBlockCursors.keys()) if (JSON.parse(key)[0] === convId) streamBlockCursors.delete(key);
      for (const key of assistantBlockIndices.keys()) if (JSON.parse(key)[0] === convId) assistantBlockIndices.delete(key);
      for (const key of lastAssistantUuids.keys()) if (JSON.parse(key)[0] === convId) lastAssistantUuids.delete(key);
    }
    for (const key of toolInputs.keys()) if (JSON.parse(key)[0] === convId) toolInputs.delete(key);
  };

  /** 内部：往指定标签页写入用户消息并拉起 CLI */
  const retiredRuns = new Map<string, Set<string>>();
  const pendingSends = new Map<string, Set<string>>();
  const resultIds = new Map<string, Set<string>>();
  const replayIds = new Map<string, Set<string>>();
  const assistantEvents = new Map<string, Set<string>>();
  const dispatchPrompt = async (prompt: string, conversationId: string, opts?: { interrupt?: boolean }): Promise<void> => {
    const state = get();
    const conv = state.conversations.find((c) => c.id === conversationId);
    if (!conv || !conv.cwd) return;

    const nonce = generateUserMessageId();
    const sends = pendingSends.get(conversationId) ?? new Set<string>();
    sends.add(nonce);
    pendingSends.set(conversationId, sends);
    const busy = conv.status === 'streaming' || conv.status === 'starting';
    backgroundConversations.delete(conversationId);
    if (!busy) { dropDeltaState(conversationId, false); lastAssistantMsgIds.delete(scopeKey(conversationId)); }
    const userMsg: ChatMessage = {
      id: nonce,
      cliUuid: nonce,
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
      streamingMessage: busy ? conv.streamingMessage ?? assistantMsg : assistantMsg,
      status: 'streaming',
    };
    set({
      conversations: replaceConv(state.conversations, conversationId, nextConv),
      forceScrollNonce: ++scrollNonceCounter,
    });

    const accepted = await deliverPrompt({
      prompt,
      userMessageId: nonce,
      ...(opts?.interrupt ? { interrupt: true } : {}),
      cwd: conv.cwd,
      sessionId: conv.sessionId || undefined,
      // 已有会话 ID 时必须用 --resume 续接，否则多轮上下文会丢失
      resume: !!conv.sessionId,
      options: {
        ...(state.model ? { model: state.model } : {}),
        permissionMode: conv.permissionMode ?? state.permissionMode,
        ...(state.effortLevel ? { effortLevel: state.effortLevel } : {}),
        ...(state.autocompact ? { autocompact: state.autocompact } : {}),
        ...(state.maxBudgetUsd > 0 ? { maxBudgetUsd: state.maxBudgetUsd } : {}),
      },
      conversationId,
    }, opts?.interrupt ? () => {
      // Only a confirmed interrupt may retire the old shell and start a new turn.
      get().setStatus('aborted', conversationId);
      const now = get();
      const target = now.conversations.find(c => c.id === conversationId);
      if (target) set({ conversations: replaceConv(now.conversations, conversationId, { ...target,
        streamingMessage: { ...assistantMsg, blocks: [] }, status: 'streaming',
      }) });
    } : undefined);
    sends.delete(nonce);
    const fresh = get();
    const current = fresh.conversations.find(c => c.id === conversationId);
    if (!current || !current.messages.some(m => m.id === nonce)) return;
    if (accepted.success) {
      // Bind by local nonce, never by prompt text or last user index.
      const runId = accepted.runId;
      if (runId && retiredRuns.get(conversationId)?.has(runId)) return;
      get().setRuntime(conversationId, { sessionId: accepted.sessionId, runId,
        busy: current.status === 'streaming' || current.status === 'starting',
      });
      const now = get();
      const target = now.conversations.find(c => c.id === conversationId)!;
      set({ conversations: replaceConv(now.conversations, conversationId, {
        ...target,
        messages: target.messages.map(m => m.id === nonce ? { ...m, cliUuid: accepted.userMessageId || nonce } : m),
      }) });
      if (!sends.size) replayIds.delete(conversationId);
    } else if (accepted.error !== 'no-api' || typeof window !== 'undefined') {
      const text = accepted.error || 'Claude send was rejected';
      if (busy) {
        set({ conversations: replaceConv(fresh.conversations, conversationId, { ...current,
          messages: [...current.messages, { id: genId(), role: 'assistant', timestamp: Date.now(), status: 'error', blocks: [{ kind: 'stderr', text }] }],
        }) });
      } else {
        get().handleStream({ type: 'stderr', text, timestamp: Date.now(), conversationId });
        get().setStatus('error', conversationId);
      }
    }
  };

  registerStopHandler((id, result) => {
    const current = get();
    const conv = current.conversations.find(c => c.id === id);
    if (!conv) return;
    if (result.error) set({ conversations: replaceConv(current.conversations, id, { ...conv, queue: [],
      messages: [...conv.messages, { id: genId(), role: 'system', timestamp: Date.now(), status: 'error', blocks: [{ kind: 'stderr', text: result.error }] }],
    }) });
    if (result.closed) get().setRuntime(id, { state: 'closed', busy: false, runId: null, info: null });
    if (result.success || result.closed) get().setStatus('aborted', id);
  });

  return {
    cwd: '',
    setCwd: (cwd) => set({ cwd }),

    sessions: [],

    conversations: [],
    activeConversationId: '',

    newConversation: (opts) => {
      const state = get();
      let conv: Conversation;
      if (opts?.fromSession) {
        // 恢复归档会话时重建任务清单（历史里最后一次 TodoWrite）
        const items = latestTodoFrom({ messages: opts.fromSession.messages, streamingMessage: null });
        conv = makeConversation(opts.fromSession.cwd, {
          title: opts.fromSession.title,
          sessionId: opts.fromSession.sessionId,
          messages: opts.fromSession.messages,
          currentModel: opts.fromSession.model || '',
          todoList: items ? { items, updatedAt: Date.now() } : null,
        });
      } else {
        conv = makeConversation(opts?.cwd ?? state.cwd);
      }
      if (opts?.id) conv.id = opts.id;
      if (opts?.title) conv.title = opts.title;
      if (opts?.draft !== undefined) conv.draft = opts.draft;
      // Explicit ids are used to reopen a known conversation; never create a
      // duplicate tab or overwrite the existing tab's draft.
      const existing = state.conversations.find(item => item.id === conv.id);
      if (existing) { set({ activeConversationId: existing.id }); return existing.id; }
      set({
        conversations: [...state.conversations, conv],
        activeConversationId: conv.id,
      });
      return conv.id;
    },

    closeConversation: (id) => {
      let state = get();
      let conv = state.conversations.find((c) => c.id === id);
      if (!conv) return;
      flushDeltas(id);
      state = get(); conv = state.conversations.find(c => c.id === id)!;
      dropDeltaState(id); // 清理 delta 缓冲/定时器
      closeRuntime(id);
      retiredRuns.delete(id); pendingSends.delete(id); replayIds.delete(id); resultIds.delete(id); assistantEvents.delete(id); backgroundConversations.delete(id); pendingBatches.delete(id);
      // 流式中的部分内容先归档再落库，避免直接丢失（归档为 completed：
      // 中断的历史内容不挂重试按钮，与旧 setStatus 行为一致）
      const settled: Conversation =
        conv.streamingMessage && (conv.status === 'streaming' || conv.status === 'starting')
          ? { ...conv, ...finalizeStreaming(conv, 'completed'), status: 'aborted' }
          : conv;
      const sessions = archiveConversationSorted(state.sessions, settled, state.maxSessions);
      const conversations = state.conversations.filter((c) => c.id !== id);
      if (conversations.length === 0) {
        conversations.push(makeConversation(state.cwd));
      }
      set({
        sessions,
        conversations,
        // 清理指向被关闭标签页的未消费注入，避免其永久滞留 store
        injectedText: state.injectedText?.convId === id ? null : state.injectedText,
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

    setDraft: (text, conversationId) => {
      const state = get();
      const conv = state.conversations.find((c) => c.id === (conversationId || state.activeConversationId));
      if (!conv || conv.draft === text) return;
      set({ conversations: replaceConv(state.conversations, conv.id, { ...conv, draft: text }) });
    },

    sendPrompt: (prompt, conversationId, opts) => dispatchPrompt(prompt, conversationId || get().activeConversationId, opts),
    retryLastTurn: async (conversationId) => {
      const id = conversationId || get().activeConversationId;
      const conv = get().conversations.find(c => c.id === id);
      const user = conv?.messages.filter(m => m.role === 'user').at(-1);
      const text = user?.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n');
      if (text) await dispatchPrompt(text, id);
    },
    setRuntime: (id, runtime) => {
      if (!runtime || typeof runtime !== 'object') return;
      const state = get();
      const conv = state.conversations.find(c => c.id === id);
      if (!conv) return;
      if (runtime.runId && retiredRuns.get(id)?.has(runtime.runId)) return;
      if (runtime.runId && conv.runId && runtime.runId !== conv.runId) {
        const old = retiredRuns.get(id) ?? new Set<string>();
        old.add(conv.runId); retiredRuns.set(id, old); dropDeltaState(id);
      }
      const disconnected = runtime.state === 'closed' || runtime.state === 'closing';
      if (disconnected && conv.runId) {
        const old = retiredRuns.get(id) ?? new Set<string>(); old.add(conv.runId); retiredRuns.set(id, old);
      }
      const info = runtime.info === undefined ? conv.runtime?.info : runtime.info === null ? null : { ...conv.runtime?.info, ...runtime.info };
      const busy = runtime.busy ?? (runtime.state === 'busy' || runtime.state === 'starting' || runtime.state === 'closing' ? true
        : runtime.state === 'ready' || runtime.state === 'closed' ? false : undefined);
      // A `ready` snapshot belongs to the run that just settled. If the GUI
      // already dispatched the next queued turn, that send still owns the
      // transcript boundary until its own receipt arrives.
      const newerGuiTurn = (pendingSends.get(id)?.size ?? 0) > 0;
      const status: RunStatus = runtime.state === 'starting' ? 'starting' : disconnected
        ? (conv.status === 'streaming' || conv.status === 'starting' ? 'aborted' : conv.status)
        : busy === true ? 'streaming'
          : busy === false && !newerGuiTurn && (conv.status === 'streaming' || conv.status === 'starting') ? 'completed'
            : conv.status;
      if (disconnected || busy === false) flushDeltas(id);
      if (disconnected) dropDeltaState(id);
      const fresh = get();
      const current = fresh.conversations.find(c => c.id === id)!;
      set({ conversations: replaceConv(fresh.conversations, id, {
        ...current,
        // Runtime readiness is metadata, not the transcript boundary: the service
        // publishes ready before result, which must still attach stats to this shell.
        ...(disconnected && current.streamingMessage ? finalizeStreaming(current, 'completed') : {}),
        status,
        runtime: { ...conv.runtime, ...runtime, info, ...(busy !== undefined ? { busy,
          state: runtime.state ?? (busy ? 'busy' : 'ready'),
        } : {}),
          ...(disconnected ? { pendingApprovals: [], pendingUserMessageIds: [], commands: [], capabilities: [], runId: null } : {}),
        },
        ...(runtime.runId !== undefined ? { runId: runtime.runId || undefined } : {}),
        ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
        ...(info?.model ? { currentModel: info.model } : {}),
        ...(info?.permissionMode && permissionModes.includes(info.permissionMode) ? { permissionMode: info.permissionMode } : {}),
        ...(runtime.commands ?? info?.commands ? { commands: runtime.commands ?? info?.commands } : {}),
        ...(runtime.capabilities ?? info?.capabilities ? { capabilities: runtime.capabilities ?? info?.capabilities } : {}),
        ...(runtime.pendingApprovals ? { pendingApprovals: runtime.pendingApprovals } : {}),
        ...(disconnected ? { pendingApprovals: [], commands: [], capabilities: [], runId: undefined, queue: [], activity: null } : {}),
        protocolConnected: !disconnected,
      }) });
      if (disconnected) pendingBatches.delete(id);
      else if (busy === false && pendingBatches.has(id)) get().setStatus('completed', id, runtime.runId || conv.runId);
    },
    setSessionMessages: (id, messages) => {
      const state = get();
      const conv = state.conversations.find(c => c.id === id);
      if (!conv) return;
      const converted = convertSessionMessages(messages);
      const next = { ...conv, messages: converted, streamingMessage: null };
      const items = latestTodoFrom(next);
      set({ conversations: replaceConv(state.conversations, id, { ...next, todoList: items ? { items, updatedAt: Date.now() } : null }) });
    },
    importSession: (data) => {
      const messages = convertSessionMessages(data.messages);
      const session: Session = { sessionId: data.sessionId, cwd: data.cwd, title: data.title || 'Session', messages,
        createdAt: Date.now(), cost: 0, inputTokens: 0, outputTokens: 0, origin: 'cli' };
      const state = get();
      const existing = state.sessions.find(s => s.sessionId === data.sessionId);
      set({ sessions: sortSessions(existing ? state.sessions.map(s => s.sessionId === data.sessionId ? { ...s, ...session, cost: s.cost, inputTokens: s.inputTokens, outputTokens: s.outputTokens } : s) : [session, ...state.sessions]) });
      const tab = get().conversations.find(c => c.sessionId === data.sessionId);
      if (tab) { get().setSessionMessages(tab.id, data.messages); get().setActiveConversation(tab.id); return tab.id; }
      return get().newConversation({ fromSession: session });
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
      // Deprecated compatibility accessor: retries must retain the failed transcript.
      return text;
    },

    forceScrollNonce: 0,

    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,

    model: '',
    setModel: (model) => set({ model }),
    permissionMode: 'default',
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
effortLevel: '',
setEffortLevel: (effortLevel) => set({ effortLevel }),
autocompact: '',
setAutocompact: (autocompact) => set({ autocompact }),
maxBudgetUsd: 0,
setMaxBudgetUsd: (maxBudgetUsd) => set({
maxBudgetUsd: !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 ? 0 : Math.round(maxBudgetUsd * 100) / 100,
}),
videoBg: { enabled: false, path: null },
setVideoBg: (patch) => set({ videoBg: { ...get().videoBg, ...patch } }),

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
      const state = get();
      const sessions = state.sessions;
      if (index < 0 || index >= sessions.length) return;
      const t = title.trim();
      if (!t || t === sessions[index].title) return;
      const sessionId = sessions[index].sessionId;
      set({
        // 手动改名：清除自动命名标记，后续不再被 AI 命名覆盖
        sessions: sessions.map((s, i) => (i === index ? { ...s, title: t, autoTitled: false } : s)),
        // 同步已打开的对应标签页标题（按 sessionId 关联），
        // 保持 TabBar 与侧栏一致；否则标签页仍显示旧名
        conversations: state.conversations.map((c) =>
          c.sessionId === sessionId ? { ...c, title: t } : c
        ),
      });
    },

    togglePinSession: (index) => {
      const state = get();
      const sessions = state.sessions;
      if (index < 0 || index >= sessions.length) return;
      const next = sortSessions(
        sessions.map((s, i) => (i === index ? { ...s, pinned: !s.pinned } : s))
      );
      set({ sessions: next });
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
    injectText: (text) =>
      set({ injectedText: { text, nonce: Date.now(), convId: get().activeConversationId } }),
    clearInjectedText: () => {
      if (get().injectedText) set({ injectedText: null });
    },

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
      let state = get();
      const convId = msg.conversationId || state.activeConversationId;
      let conv = state.conversations.find((c) => c.id === convId);
      if (!conv) return; // 标签页已关闭：残余事件直接丢弃
      if (msg.runId && retiredRuns.get(convId)?.has(msg.runId)) return;
      if (msg.runId && conv.runId && msg.runId !== conv.runId && !pendingSends.get(convId)?.size) return;
      if (msg.type !== 'stream_event') flushDeltas(convId);
      state = get(); conv = state.conversations.find(c => c.id === convId)!;
      if (msg.runId && !conv.runId) {
        get().setRuntime(convId, { runId: msg.runId });
        state = get(); conv = state.conversations.find(c => c.id === convId)!;
      }

      // 中断后到达的残留流事件直接丢弃（进程退出前 stdout 缓冲区可能还有数据），
      // 否则会创建出永远无法归档的幽灵 streamingMessage
      if (conv.status === 'aborted' && (msg.type === 'assistant' || msg.type === 'user')) {
        return;
      }

      switch (msg.type) {
        case 'runner_error':
        case 'approval_validation_error': {
          const text = typeof msg.error === 'string' ? msg.error : msg.type;
          const approvals = msg.type === 'approval_validation_error'
            ? (conv.pendingApprovals ?? []).map(p => p.requestId === msg.requestId ? { ...p, validationError: text } : p)
            : undefined;
          const notice: ChatMessage = { id: genId(), role: 'system', timestamp: Date.now(), status: 'error',
            cliUuid: msg.uuid, endUuid: msg.uuid, metadata: msg, blocks: [{ kind: 'stderr', text }] };
          set({ conversations: replaceConv(state.conversations, convId, { ...conv,
            messages: [...conv.messages, notice],
            ...(approvals ? { pendingApprovals: approvals, runtime: { ...conv.runtime, pendingApprovals: approvals } } : {}),
          }) });
          break;
        }
        case 'session_changed':
          get().setRuntime(convId, { sessionId: msg.sessionId }); break;
        case 'command_lifecycle': {
          const notice: ChatMessage = { id: genId(), role: 'system', timestamp: Date.now(), status: 'completed',
            metadata: msg, blocks: [{ kind: 'notice', text: `command ${msg.state}`, raw: msg }] };
          set({ conversations: replaceConv(state.conversations, convId, { ...conv, messages: [...conv.messages, notice] }) });
          break;
        }
        case 'approval_request': {
          const approvals = [...(conv.pendingApprovals || []).filter(p => p.requestId !== msg.requestId), msg];
          get().setRuntime(convId, { pendingApprovals: approvals }); break;
        }
        case 'approval_resolved':
          get().setRuntime(convId, { pendingApprovals: (conv.pendingApprovals || []).filter(p => p.requestId !== msg.requestId) }); break;
        case 'permission_mode_changed':
          get().setRuntime(convId, { info: { ...conv.runtime?.info, permissionMode: msg.permissionMode } }); break;
        case 'system': {
          if (msg.subtype === 'init') {
            set({
              conversations: replaceConv(state.conversations, convId, {
                ...conv,
                sessionId: msg.session_id,
                currentModel: msg.model || '',
                thinkingTokens: 0,
                permissionMode: permissionModes.includes(msg.permissionMode) ? msg.permissionMode : conv.permissionMode,
                commands: msg.commands ?? msg.slash_commands ?? [],
                capabilities: msg.capabilities,
                protocolConnected: true,
              }),
            });
          } else if (msg.subtype === 'thinking_tokens') {
            // 字段防御：畸形事件不写入 undefined
            set({
              conversations: replaceConv(state.conversations, convId, {
                ...conv,
                thinkingTokens: finite(msg.estimated_tokens),
              }),
            });
            setActivity(convId, 'thinking');
          } else if (msg.subtype === 'status' && msg.status === 'requesting') {
            // 每个 API 轮次开始前都会发（含工具结果返回后的下一轮）——反馈条核心信号
            setActivity(convId, 'requesting');
          } else if (msg.subtype === 'runtime') {
            get().setRuntime(convId, (msg.state && typeof msg.state === 'object' ? msg.state : msg.runtime ?? msg) as ConversationRuntime);
          } else if (msg.subtype === 'commands_changed') {
            get().setRuntime(convId, { commands: Array.isArray(msg.commands) ? msg.commands : [] });
          } else {
            const notice: ChatMessage = { id: genId(), role: 'system', timestamp: Date.now(), status: 'completed',
              cliUuid: msg.uuid, endUuid: msg.uuid, metadata: msg,
              blocks: [{ kind: 'notice', text: typeof msg.message === 'string' ? msg.message : msg.subtype, raw: msg }] };
            set({ conversations: replaceConv(state.conversations, convId, { ...conv, messages: [...conv.messages, notice] }) });
          }
          break;
        }

        case 'stream_event': {
          // Partial identities are scoped to the API message, block index and parent.
          const parentId = msg.parent_tool_use_id;
          const scope = scopeKey(convId, parentId);
          const ev = msg.event || {};
          const index = typeof ev.index === 'number' ? ev.index : 0;
          const toolKey = JSON.stringify([convId, parentId ?? null, deltaMsgIds.get(scope), index]);

          if (ev.type === 'message_start') {
            // 记录本轮消息 id：后续完整 assistant 事件据此去重
            flushDeltas(convId);
            deltaMsgIds.set(scope, ev.message?.id ?? null);
            lastAssistantMsgIds.set(scope, ev.message?.id ?? null);
            break;
          }

          if (ev.type === 'content_block_start' && ev.content_block?.type) {
            streamBlockCursors.set(messageKey(convId, parentId, deltaMsgIds.get(scope)), { index, kind: ev.content_block.type });
          }
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            // 工具调用开始即创建 running 卡片（名称立即可见，input 由完整事件回填）
            flushDeltas(convId); // 保序：先把已缓冲文本落盘
            const cur = get().conversations.find((c) => c.id === convId);
            if (!cur) break;
            const streaming: ChatMessage = cur.streamingMessage
              ? { ...cur.streamingMessage }
              : { id: genId(), role: 'assistant', blocks: [], timestamp: Date.now(), status: 'streaming' };
            const parent = parentId ? findToolBlock(streaming.blocks, parentId) : null;
            const toolBlock = {
              kind: 'tool_use' as const,
              toolName: String(ev.content_block.name || 'Tool'),
              toolId: String(ev.content_block.id || ''),
              input: {},
              status: 'running' as const,
              startedAt: Date.now(),
            };
            set({
              conversations: replaceConv(get().conversations, convId, {
                ...cur,
                streamingMessage: { ...streaming, blocks: findToolBlock(streaming.blocks, toolBlock.toolId) ? streaming.blocks
                  : parent ? replaceToolBlockChildren(streaming.blocks, parent.toolId, [...(parent.children ?? []), toolBlock]) : [...streaming.blocks, toolBlock] },
              }),
            });
            toolInputs.set(toolKey, { toolId: toolBlock.toolId, json: '' });
            setActivity(convId, 'tool', String(ev.content_block.name || 'Tool'));
            break;
          }

          if (ev.type === 'content_block_delta') {
            const d = ev.delta || {};
            if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
              queueDelta(convId, 'text', d.text, parentId, index);
              setActivity(convId, 'writing');
            } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
              queueDelta(convId, 'thinking', d.thinking, parentId, index);
              setActivity(convId, 'thinking');
            } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              const tool = toolInputs.get(toolKey);
              if (tool) tool.json += d.partial_json;
            }
            break;
          }
          if (ev.type === 'content_block_stop') {
            flushDeltas(convId);
            const tool = toolInputs.get(toolKey);
            if (tool?.json) {
              try {
                const input = JSON.parse(tool.json);
                const state = get(); const current = state.conversations.find(c => c.id === convId);
                if (current?.streamingMessage && input && typeof input === 'object' && !Array.isArray(input)) {
                  set({ conversations: replaceConv(state.conversations, convId, { ...current, streamingMessage: {
                    ...current.streamingMessage, blocks: backfillToolInput(current.streamingMessage.blocks, tool.toolId, input),
                  } }) });
                }
              } catch { /* A full assistant event remains authoritative for incomplete JSON. */ }
            }
          }
          break;
        }

        case 'assistant': {
          if (msg.uuid) {
            const fingerprints = assistantEvents.get(convId) ?? new Set<string>();
            const fingerprint = JSON.stringify([msg.runId, msg.parent_tool_use_id, msg.uuid, msg.message]);
            if (fingerprints.has(fingerprint)) break;
            fingerprints.add(fingerprint); assistantEvents.set(convId, fingerprints);
          }
          // 字段防御：id/content 缺失时不得抛异常，也不得误判为同消息分片
          const msgId = typeof msg.message?.id === 'string' ? msg.message.id : null;
          const parentId = msg.parent_tool_use_id;
          const shardKey = JSON.stringify([convId, parentId ?? null]);
          const sameMsgShard = msgId !== null && lastAssistantMsgIds.get(shardKey) === msgId
            && (!msg.uuid || lastAssistantUuids.get(shardKey) === msg.uuid);
          const contentBlocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
          const cursor = msgId !== null ? streamBlockCursors.get(messageKey(convId, parentId, msgId)) : undefined;
          const uuidKey = JSON.stringify([convId, parentId ?? null, msgId, msg.uuid]);
          const blockIndices = contentBlocks.map((block, ordinal) => {
            if (contentBlocks.length > 1) return ordinal;
            const bound = msg.uuid ? assistantBlockIndices.get(uuidKey) : undefined;
            const index = bound ?? (cursor?.kind === block.type ? cursor.index : undefined);
            if (msg.uuid && index !== undefined) assistantBlockIndices.set(uuidKey, index);
            return index;
          });
          const isIndexedEcho = (block: typeof contentBlocks[number], ordinal: number, container: UIBlock[]) => {
            const kind = block.type;
            const index = blockIndices[ordinal];
            return msgId !== null && index !== undefined && (kind === 'text' || kind === 'thinking')
              && container.some(b => b.kind === kind && b.msgId === msgId && b.blockIndex === index);
          };
          // A late normalised echo may arrive after result or after the next prompt.
          // Look only at matching indexed identities, never at equal text across blocks.
          const archivedContainer = parentId ? conv.messages.flatMap(m => findToolBlock(m.blocks, parentId)?.children ?? [])
            : conv.messages.filter(m => m.role === 'assistant').flatMap(m => m.blocks);
          if (contentBlocks.length && contentBlocks.every((block, i) => isIndexedEcho(block, i, archivedContainer))) break;
          lastAssistantMsgIds.set(shardKey, msgId);
          lastAssistantUuids.set(shardKey, msg.uuid);

          // 浅拷贝消息壳，后续块更新全部不可变（新数组/新块对象）：
          // 配合渲染层 React.memo，已完成块引用稳定可跳过重渲染
          const archivedParent = parentId ? conv.messages.find(m => findToolBlock(m.blocks, parentId)) : undefined;
          const background = !!parentId && (!conv.streamingMessage || (!!archivedParent && !findToolBlock(conv.streamingMessage.blocks, parentId)));
          if (background) backgroundConversations.add(convId);
          const streaming: ChatMessage = background && archivedParent ? { ...archivedParent }
            : conv.streamingMessage ? { ...conv.streamingMessage }
            : { id: genId(), role: 'assistant', blocks: [], timestamp: Date.now(), status: 'streaming' };
          streaming.cliUuid ??= msg.uuid;
          streaming.endUuid = msg.uuid ?? streaming.endUuid;
          streaming.metadata = msg;

          // 1) tool_result：不可变地更新对应 tool_use 块（含子代理 children 路径）
          let blocks = streaming.blocks;
          for (const block of contentBlocks) {
            if (block.type === 'tool_result') {
              const r = applyToolResult(blocks, block);
              if (r.hit) blocks = r.blocks;
            }
          }

        // 2) text/thinking/tool_use：定位容器（顶层或子代理父块），不可变合并/追加。
        //    重新查找父块：步骤 1 可能已替换其 children 数组（parentId 已在 case 开头声明）
        let parentToolId: string | null = null;
        let container: UIBlock[] = [...blocks];
        if (parentId) {
            const parent = findToolBlock(blocks, parentId);
            if (parent) {
              parentToolId = parent.toolId;
              container = [...(parent.children ?? [])];
            }
          }

        let touched = true; // 子代理容器拷贝后必须写回
        for (const [ordinal, block] of contentBlocks.entries()) {
          const blockIndex = blockIndices[ordinal];
          if (block.type === 'text') {
            if (isIndexedEcho(block, ordinal, container)) continue;
            // 同消息分片续写：仅当容器尾部是同一条消息的 text 块时追加。
              // 不得按 kind 全局查找——CLI 会把同一条消息拆成多个事件发送
              // （[thinking]、[text] 分片），若第 1 轮已有开场文本，后续轮次的
              // 最终答案会被拼进那个旧块，造成“结果在中间、后面跟着思考/工具”的错位
              const last = container[container.length - 1];
              if (sameMsgShard && blockIndex === undefined && last?.kind === 'text' && last.msgId === msgId && last.blockIndex === undefined) {
                container[container.length - 1] = { ...last, text: last.text + block.text };
              } else {
                container.push({ kind: 'text', text: block.text, msgId: msgId ?? undefined, blockIndex });
                touched = true;
              }
          } else if (block.type === 'thinking') {
            if (isIndexedEcho(block, ordinal, container)) continue;
            const last = container[container.length - 1];
              if (sameMsgShard && blockIndex === undefined && last?.kind === 'thinking' && last.msgId === msgId && last.blockIndex === undefined) {
                container[container.length - 1] = { ...last, text: last.text + block.thinking };
              } else {
                container.push({ kind: 'thinking', text: block.thinking, msgId: msgId ?? undefined, blockIndex });
                touched = true;
              }
          } else if (block.type === 'tool_use') {
            if (findToolBlock(blocks, block.id)) {
              // 卡片已由 content_block_start 预创建：回填 input（不可变）
              container = backfillToolInput(container, block.id, block.input);
              continue;
            }
            container.push({
              kind: 'tool_use',
              toolName: block.name,
              toolId: block.id,
              input: block.input,
              status: 'running',
              startedAt: Date.now(),
              metadata: block,
            });
            touched = true;
          }
        }

        if (touched) {
          blocks = parentToolId ? replaceToolBlockChildren(blocks, parentToolId, container) : container;
        }
        streaming.blocks = blocks;

        // 阶段反馈：由本条完整事件的内容类型推导（无 partial 降级时也生效）。
        // 必须并入同一个 set：单独 setActivity 会被本次基于旧快照的 set 覆盖（竞态）
        let activity = conv.activity;
        const samePhase = (phase: ActivityState['phase'], toolName?: string) =>
          activity && activity.phase === phase && (activity.toolName || undefined) === (toolName || undefined);
        if (contentBlocks.some((b) => b.type === 'tool_use')) {
          const tu = contentBlocks.find((b) => b.type === 'tool_use') as { name?: string };
          if (!samePhase('tool', tu?.name)) activity = { phase: 'tool', toolName: tu?.name, since: Date.now() };
        } else if (contentBlocks.some((b) => b.type === 'thinking')) {
          if (!samePhase('thinking')) activity = { phase: 'thinking', since: Date.now() };
        } else if (contentBlocks.some((b) => b.type === 'text')) {
          if (!samePhase('writing')) activity = { phase: 'writing', since: Date.now() };
        }

        set({
          conversations: replaceConv(state.conversations, convId, {
            ...conv,
            ...(background ? { messages: archivedParent
              ? conv.messages.map(m => m === archivedParent ? { ...streaming, status: 'completed' as const } : m)
              : [...conv.messages, { ...streaming, status: 'completed' as const }] }
              : { streamingMessage: streaming, activity }),
          }),
        });
        // TodoWrite 清单同步（fresh 读取；无 TodoWrite 调用时为 no-op）
        syncTodosFromBlocks(convId);
        break;
      }

      case 'user': {
          if (msg.uuid && !conv.messages.some(m => m.cliUuid === msg.uuid) && pendingSends.get(convId)?.size) {
            const replay = replayIds.get(convId) ?? new Set<string>();
            replay.add(msg.uuid); replayIds.set(convId, replay);
          }
          // tool_result 通过 user 消息返回
          const streaming = conv.streamingMessage;
          const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
          let archivedMessages = conv.messages;
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            archivedMessages = archivedMessages.map(m => {
              const updated = applyToolResult(m.blocks, { ...block, structuredResult: msg.tool_use_result });
              return updated.hit ? { ...m, blocks: updated.blocks, endUuid: msg.uuid ?? m.endUuid } : m;
            });
          }
          if (archivedMessages.some((m, i) => m !== conv.messages[i])) {
            set({ conversations: replaceConv(get().conversations, convId, { ...conv, messages: archivedMessages }) });
            syncTodosFromBlocks(convId);
          }
          if (streaming && content.length > 0) {
            let blocks = streaming.blocks;
            let hit = false;
            for (const block of content) {
              if (block.type === 'tool_result') {
                const r = applyToolResult(blocks, { ...block, structuredResult: msg.tool_use_result });
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
                  messages: archivedMessages,
                  streamingMessage: { ...streaming, blocks, endUuid: msg.uuid ?? streaming.endUuid },
                }),
              });
              // 工具结果返回后将发起下一轮请求：阶段切回 requesting
              setActivity(convId, 'requesting');
              syncTodosFromBlocks(convId);
            }
          }
          break;
        }

        case 'result': {
          if (msg.uuid) {
            const ids = resultIds.get(convId) ?? new Set<string>();
            if (ids.has(msg.uuid)) break;
            ids.add(msg.uuid); resultIds.set(convId, ids);
          }
          if (msg.hasPending) pendingBatches.add(convId); else pendingBatches.delete(convId);
          const isError = msg.is_error || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'));
          // 先落盘缓冲中的 delta（最多 40ms 尾巴），避免归档丢失；
          // flush 会更新 store，后续必须用 fresh 读取（不能用 switch 开头的旧快照）
          flushDeltas(convId);
          const convNow = get().conversations.find((c) => c.id === convId);
          if (!convNow) break;

          // stats 块以不可变方式附加（finalizeStreaming 不 mutate 原引用）
          const shell = convNow.streamingMessage ?? { id: genId(), role: 'assistant' as const, timestamp: Date.now(), status: 'streaming' as const, blocks: [] as UIBlock[] };
          let resultBlocks = [...shell.blocks];
          const finalMsgId = lastAssistantMsgIds.get(scopeKey(convId));
          const hasFinalText = resultBlocks.some(b => b.kind === 'text' && b.text && (!finalMsgId || b.msgId === finalMsgId));
          // A tool preamble from an earlier API message is not the final answer.
          // Never compare result text against all history or rewrite its newlines.
          if (!hasFinalText && typeof msg.result === 'string' && msg.result) {
            resultBlocks.push({ kind: 'text', text: msg.result, msgId: finalMsgId ?? undefined });
          }
          if (Array.isArray(msg.errors)) for (const error of msg.errors) {
            if (typeof error === 'string') resultBlocks.push({ kind: 'stderr', text: error });
          }
          const withStats = { ...shell,
            blocks: [...resultBlocks, { kind: 'stats', data: msg } as UIBlock] };

          const archived = finalizeStreaming(
            { ...convNow, streamingMessage: withStats },
            isError ? 'error' : 'completed'
          );

          // 归档会话（标题取第一条用户消息）
          const firstUserMsg = convNow.messages.find((m) => m.role === 'user');
          const title = firstUserMsg?.blocks.find((b) => b.kind === 'text')?.text?.slice(0, 50) || convNow.title || 'Session';

          // 字段防御：CLI 版本间字段可能缺失/畸形，缺省按 0 处理而非 NaN 扩散
          const usage = msg.usage || {};
          const models = msg.modelUsage && typeof msg.modelUsage === 'object' ? Object.values(msg.modelUsage) : [];
          const inputTokens = models.length ? models.reduce((n, u) => n + finite(u?.inputTokens) + finite(u?.cacheReadInputTokens) + finite(u?.cacheCreationInputTokens), 0)
            : finite(usage.input_tokens) + finite(usage.cache_read_input_tokens) + finite(usage.cache_creation_input_tokens);
          const outputTokens = models.length ? models.reduce((n, u) => n + finite(u?.outputTokens), 0) : finite(usage.output_tokens);
          const cost = finite(msg.total_cost_usd);

          // 上下文占用校准：
          // - limit 始终从 modelUsage.contextWindow 校准（真实上限）
          // - used 仅在单轮执行（num_turns <= 1）时可用 result.usage 更新——
          //   多轮工具循环的 result.usage 是整轮所有 API 调用的累计 input，
          //   远超真实上下文（实测可达上限的 10 倍），不能当占用值；
          //   多轮场景由轮末的 /context 查询提供真实占用。
          //   compact 后占用下降是正常现象，不做 Math.max 钉死。
          let contextUsage = convNow.contextUsage;
          const modelUsage = msg.modelUsage ? Object.values(msg.modelUsage)[0] : undefined;
          if (finite(modelUsage?.contextWindow) > 0) {
            const turns = typeof msg.num_turns === 'number' ? msg.num_turns : 1;
            if (turns <= 1) {
              const used =
                finite(usage.input_tokens) + finite(usage.cache_read_input_tokens) + finite(usage.cache_creation_input_tokens) + finite(usage.output_tokens);
              contextUsage = { used, limit: finite(modelUsage?.contextWindow) };
            } else if (contextUsage) {
              contextUsage = { ...contextUsage, limit: finite(modelUsage?.contextWindow) };
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
          // 是否为本会话的首次归档（触发 AI 自动命名用）
          let isNewSessionEntry = false;
          if (hasSessionId) {
            const newSession: Session = {
              sessionId: msg.session_id,
              cwd: convNow.cwd,
              title,
              messages: archived.messages,
              createdAt: Date.now(),
              cost,
              inputTokens,
              outputTokens,
              model: convNow.currentModel || undefined,
              events: [event],
              // 标记为自动标题：AI 命名只覆盖带此标记的条目（手动改名后转为 false）
              autoTitled: true,
            };

            // 同 sessionId 的会话更新而非重复添加（多轮对话）
            const existingIdx = state.sessions.findIndex((s) => s.sessionId === msg.session_id);
            isNewSessionEntry = existingIdx < 0;
            sessions = existingIdx >= 0
              ? state.sessions.map((s, i) => (i === existingIdx ? {
                  ...newSession,
                  // 已有条目保留原标题：它可能是用户手动重命名的结果，
                  // 不得被「首条用户消息前 50 字」的自动标题覆盖
                  // （否则重命名后再发消息，名字会被悄悄改回去）。
                  // 自动命名只在首次归档时生效；旧条目 title 为空时才回退自动值
                  title: s.title || title,
                  createdAt: s.createdAt, // 保留首次创建时间
                  pinned: s.pinned, // 保留置顶标记（newSession 无此字段，展开会丢失）
                  autoTitled: s.autoTitled, // 保留手动改名标记
                  cost: s.cost + cost,
                  inputTokens: s.inputTokens + inputTokens,
                  outputTokens: s.outputTokens + outputTokens,
                  model: convNow.currentModel || s.model,
                  events: [...(s.events || []), event],
                } : s))
              : [newSession, ...state.sessions];

            // 限制会话数量，超出部分丢弃最旧的（置顶项浮顶后受截断保护）
            sessions = sortSessions(sessions).slice(0, state.maxSessions > 0 ? state.maxSessions : DEFAULT_MAX_SESSIONS);
          }

          set({
            conversations: replaceConv(state.conversations, convId, {
              ...convNow,
              messages: archived.messages,
              streamingMessage: null,
              status: msg.hasPending ? 'streaming' : isError ? 'error' : 'completed',
              runtime: { ...convNow.runtime, busy: msg.hasPending === true, state: msg.hasPending ? 'busy' : 'ready' },
              contextUsage,
              activity: null, // 轮次结束：清除反馈条
            }),
            totalCost: state.totalCost + cost,
            totalInputTokens: state.totalInputTokens + inputTokens,
            totalOutputTokens: state.totalOutputTokens + outputTokens,
            sessions,
          });

          // 首次归档的新会话：触发 AI 自动命名（异步，不阻塞队列续发；
          // 仅当首条用户消息非空，失败静默保留截断标题）
          if (isNewSessionEntry && !isError) {
            const firstText = firstUserMsg?.blocks.find((b) => b.kind === 'text')?.text || '';
            if (firstText.trim()) {
              void autoTitleSession(msg.session_id, convNow.cwd, firstText.slice(0, 30), firstText);
            }
          }

          // 队列续发/清空：result 是本轮的确定性终点（比 status 事件先到），
          // 即便该标签页在后台也必须处理
          if (msg.hasPending) break;
          if (isError) {
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

    setStatus: (status, conversationId, runId) => {
      let state = get();
      const convId = conversationId || state.activeConversationId;
      let conv = state.conversations.find((c) => c.id === convId);
      if (!conv) return false; // 标签页已关闭：忽略
      if (runId && (retiredRuns.get(convId)?.has(runId) || (conv.runId && conv.runId !== runId && !pendingSends.get(convId)?.size))) return false;
      // A terminal status for the previous turn must not close a turn that was
      // already dispatched from the GUI queue. The new send keeps a pending
      // nonce until its acceptance receipt arrives, so it is authoritative
      // over a stale completed/ready notification from the previous run.
      if (status === 'completed' && (pendingSends.get(convId)?.size ?? 0) > 0) return false;
      if (!conv.streamingMessage && (backgroundConversations.has(convId) || (pendingDeltas.get(convId)?.length && conv.status === 'completed'))) {
        flushDeltas(convId);
        if ((status === 'error' || status === 'completed') && conv.status === 'completed' && !conv.runtime?.busy && !runId && !pendingBatches.has(convId)) return false;
        state = get(); conv = state.conversations.find(c => c.id === convId)!;
      }

      // 中断或出错：先落盘缓冲的 delta（保留最后 ≤40ms 内容）再归档，避免丢失
      if (status === 'aborted' || status === 'error') {
        flushDeltas(convId);
        state = get(); conv = state.conversations.find(c => c.id === convId)!;
      }

      // 中断或出错时，把未完成的流式消息归档，避免内容丢失
      if ((status === 'aborted' || status === 'error') && conv.streamingMessage) {
        const archived = finalizeStreaming(conv, status === 'aborted' ? 'completed' : 'error');
        set({
          conversations: replaceConv(state.conversations, convId, {
            ...conv,
            ...archived,
            status,
            activity: null,
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
      const latest = get();
      const target = latest.conversations.find(c => c.id === convId)!;
      const busy = status === 'starting' || status === 'streaming';
      set({ conversations: replaceConv(latest.conversations, convId, { ...target,
        runtime: { ...target.runtime, busy, state: target.protocolConnected === false ? 'closed' : busy ? status === 'starting' ? 'starting' : 'busy' : 'ready' },
        ...(!busy ? { activity: null } : {}),
        ...(status === 'aborted' || status === 'error' ? { queue: [] } : {}),
      }) });
      if (!busy && pendingBatches.delete(convId) && status === 'completed' && target.queue.length) {
        const [next, ...rest] = target.queue;
        const now = get();
        const current = now.conversations.find(c => c.id === convId)!;
        set({ conversations: replaceConv(now.conversations, convId, { ...current, queue: rest }) });
        void dispatchPrompt(next, convId);
      }
      if (status === 'aborted' || status === 'error') dropDeltaState(convId);
      return true;
    },

    setContextUsage: (usage, conversationId) => {
      const state = get();
      const convId = conversationId || state.activeConversationId;
      const conv = state.conversations.find((c) => c.id === convId);
      if (!conv || conv.contextUsage === usage) return;
      set({ conversations: replaceConv(state.conversations, convId, { ...conv, contextUsage: usage }) });
    },

    hydrate: (data) => {
      for (const id of deltaTimers.keys()) dropDeltaState(id);
      deltaMsgIds.clear(); streamBlockCursors.clear(); assistantBlockIndices.clear(); lastAssistantUuids.clear(); toolInputs.clear(); pendingDeltas.clear();
      lastAssistantMsgIds.clear(); retiredRuns.clear(); pendingSends.clear(); resultIds.clear(); replayIds.clear(); assistantEvents.clear(); backgroundConversations.clear(); pendingBatches.clear();
      const sessions = data.sessions || [];

      // 标签页恢复：新格式（conversations 数组）或旧格式（单会话字段）迁移
      let conversations: Conversation[] = [];
      if (Array.isArray(data.conversations)) {
        for (const c of data.conversations as Conversation[]) {
          if (!c || typeof c.id !== 'string') continue;
          const restored: Conversation = {
            ...makeConversation(typeof c.cwd === 'string' ? c.cwd : data.cwd || ''),
            ...persistentConversation(c),
            protocolConnected: false,
            commands: [],
            pendingApprovals: [],
            activity: null, // 瞬态：重启后清除
            todoList: sanitizeTodoList(c.todoList), // 形状防御：畸形数据置空
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
        sessions: sortSessions(sessions),
        conversations,
        activeConversationId,
        totalCost: finite(data.totalCost),
        totalInputTokens: finite(data.totalInputTokens),
        totalOutputTokens: finite(data.totalOutputTokens),
        model: data.model || '',
        permissionMode: data.permissionMode && permissionModes.includes(data.permissionMode) ? data.permissionMode : 'default',
        showThinking: data.showThinking !== false,
        notifyOnComplete: data.notifyOnComplete !== false,
        maxSessions: typeof data.maxSessions === 'number' && data.maxSessions > 0
          ? data.maxSessions
          : DEFAULT_MAX_SESSIONS,
sidebarWidth: typeof data.sidebarWidth === 'number' && data.sidebarWidth >= 200 && data.sidebarWidth <= 480
? data.sidebarWidth
: 256,
effortLevel: ['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(data.effortLevel as any)
? (data.effortLevel as any)
: '',
autocompact: ['', 'auto', '100k', '200k', '400k', '800k', '1M'].includes(data.autocompact as any)
? (data.autocompact as any)
: '',
maxBudgetUsd: typeof data.maxBudgetUsd === 'number' && data.maxBudgetUsd > 0
? data.maxBudgetUsd
: 0,
videoBg: {
  enabled: data.videoBg?.enabled === true,
  path: typeof data.videoBg?.path === 'string' && data.videoBg.path ? data.videoBg.path : null,
},
      });
    },
  };
});
