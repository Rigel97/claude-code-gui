// ─── Claude Code stream-json 消息类型 ───────────────────

export interface SystemInitMessage {
  type: 'system';
  subtype: 'init';
  cwd: string;
  session_id: string;
  tools: string[];
  model: string;
  permissionMode: string;
  claude_code_version: string;
}

export interface ThinkingTokensMessage {
  type: 'system';
  subtype: 'thinking_tokens';
  estimated_tokens: number;
  estimated_tokens_delta: number;
}

export interface AssistantMessage {
  type: 'assistant';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: ContentBlock[];
    stop_reason: string | null;
    usage: Record<string, unknown>;
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
  timestamp: string;
}

export interface UserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: ContentBlock[];
  };
  session_id: string;
  uuid: string;
  timestamp: string;
}

export interface ResultMessage {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
    contextWindow: number;
    maxOutputTokens: number;
  }>;
  terminal_reason: string;
  ttft_ms: number;
}

export type StreamMessage =
  | SystemInitMessage
  | ThinkingTokensMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage
  | { type: 'stderr'; text: string; timestamp: number }
  | { type: 'raw'; text: string; timestamp: number };

// ─── 内容块 ─────────────────────────────────────────────

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// ─── UI 消息模型 ─────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: UIBlock[];
  timestamp: number;
  status?: 'streaming' | 'completed' | 'error';
}

/** 对话标签页：多标签页架构下每个 tab 持有独立的会话状态 */
export interface Conversation {
  /** GUI 侧 tab 标识（创建即有，早于 CLI sessionId） */
  id: string;
  /** tab 标题（首条用户消息前 30 字，初始为「新对话」） */
  title: string;
  /** CLI 会话 id（init 后回填；新对话为 null） */
  sessionId: string | null;
  /** 会话所在项目目录（创建时快照，切换全局 cwd 不影响已开会话） */
  cwd: string;
  messages: ChatMessage[];
  streamingMessage: ChatMessage | null;
  status: RunStatus;
  thinkingTokens: number;
  contextUsage: ContextUsage | null;
  queue: string[];
  /** CLI init 回显的实际模型 */
  currentModel: string;
  /** 输入框草稿（切 tab 保留） */
  draft: string;
}

export type UIBlock =
| { kind: 'text'; text: string; msgId?: string }
| { kind: 'thinking'; text: string; msgId?: string }
  | { kind: 'tool_use'; toolName: string; toolId: string; input: Record<string, unknown>; status: 'running' | 'done' | 'error'; result?: string; children?: UIBlock[] }
  | { kind: 'stderr'; text: string }
  | { kind: 'stats'; data: ResultMessage };

// ─── 上下文窗口占用 ─────────────────────────────────────

export interface ContextUsage {
  /** 已占用的 token 数（最后一次 /context 查询或单轮 result 的真实值） */
  used: number;
  /** 上下文窗口上限 */
  limit: number;
  /** 剩余可用空间（/context 的 Free space，可能缺省） */
  free?: number;
  /** autocompact 缓冲区大小（接近上限时 CLI 自动压缩的预留，可能缺省） */
  autocompactBuffer?: number;
}

// ─── 会话 ───────────────────────────────────────────────

/** 单次执行的成本事件（用于成本仪表盘按时间聚合） */
export interface SessionEvent {
  t: number;
  cost: number;
  input: number;
  output: number;
}

export interface Session {
  sessionId: string;
  cwd: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /** 该会话使用的模型（取自 result 时的 currentModel） */
  model?: string;
  /** 每一轮执行的成本事件流（旧数据可能没有，退化用 createdAt 单点） */
  events?: SessionEvent[];
}

// ─── 运行状态 ───────────────────────────────────────────

export type RunStatus = 'idle' | 'starting' | 'streaming' | 'completed' | 'aborted' | 'error';
