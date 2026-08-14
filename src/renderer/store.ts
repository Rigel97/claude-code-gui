import { create } from 'zustand';
import type { ChatMessage, Session, SessionEvent, RunStatus, StreamMessage, UIBlock } from './types';

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

  // 操作
  newSession: () => void;
  switchSession: (index: number) => void;
  addUserMessage: (text: string) => void;
  handleStream: (msg: StreamMessage) => void;
  setStatus: (status: RunStatus) => void;
  clearMessages: () => void;
  hydrate: (data: Partial<Pick<AppState, 'cwd' | 'sessions' | 'messages' | 'activeSessionIndex' | 'currentSessionId' | 'totalCost' | 'totalInputTokens' | 'totalOutputTokens' | 'model' | 'permissionMode' | 'showThinking'>>) => void;
}

let msgCounter = 0;
const genId = () => `msg-${++msgCounter}-${Date.now()}`;

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

/** 将 tool_result 写回流式消息中对应的 tool_use 块 */
function applyToolResult(
  streaming: ChatMessage,
  block: { tool_use_id: string; content: unknown; is_error?: boolean }
): void {
  const toolBlock = streaming.blocks.find(
    (b) => b.kind === 'tool_use' && b.toolId === block.tool_use_id
  );
  if (toolBlock && toolBlock.kind === 'tool_use') {
    toolBlock.status = block.is_error ? 'error' : 'done';
    toolBlock.result = extractToolResultText(block.content);
  }
}

/**
 * 将流式消息归档到消息列表
 */
function finalizeStreaming(state: AppState, finalStatus: 'completed' | 'error'): {
  messages: ChatMessage[];
  streamingMessage: null;
} {
  const streaming = state.streamingMessage;
  if (!streaming) {
    return { messages: state.messages, streamingMessage: null };
  }
  streaming.status = finalStatus;
  return {
    messages: [...state.messages, streaming],
    streamingMessage: null,
  };
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

  newSession: () => {
    // 生成中禁止新建会话，否则后续流事件会写入错误的会话
    const status = get().status;
    if (status === 'streaming' || status === 'starting') return;
    set({
      currentSessionId: null,
      activeSessionIndex: -1,
      status: 'idle',
      streamingMessage: null,
      messages: [],
      thinkingTokens: 0,
    });
  },

  switchSession: (index) => {
    // 生成中禁止切换会话，防止消息归档错乱
    const status = get().status;
    if (status === 'streaming' || status === 'starting') return;
    const session = get().sessions[index];
    if (session) {
      set({
        activeSessionIndex: index,
        currentSessionId: session.sessionId,
        cwd: session.cwd,
        status: 'idle',
        streamingMessage: null,
        messages: session.messages,
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

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          set({
            currentSessionId: msg.session_id,
            currentModel: msg.model || '',
            thinkingTokens: 0,
          });
        } else if (msg.subtype === 'thinking_tokens') {
          set({ thinkingTokens: msg.estimated_tokens });
        }
        break;
      }

      case 'assistant': {
        let streaming = state.streamingMessage;
        if (!streaming) {
          streaming = {
            id: genId(),
            role: 'assistant',
            blocks: [],
            timestamp: Date.now(),
            status: 'streaming',
          };
        }

        const newBlocks: UIBlock[] = [];
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            const existingText = streaming.blocks.find((b) => b.kind === 'text');
            if (existingText && existingText.kind === 'text') {
              existingText.text += block.text;
            } else {
              newBlocks.push({ kind: 'text', text: block.text });
            }
          } else if (block.type === 'thinking') {
            const existingThinking = streaming.blocks.find((b) => b.kind === 'thinking');
            if (existingThinking && existingThinking.kind === 'thinking') {
              existingThinking.text += block.thinking;
            } else {
              newBlocks.push({ kind: 'thinking', text: block.thinking });
            }
          } else if (block.type === 'tool_use') {
            newBlocks.push({
              kind: 'tool_use',
              toolName: block.name,
              toolId: block.id,
              input: block.input,
              status: 'running',
            });
          } else if (block.type === 'tool_result') {
            applyToolResult(streaming, block);
          }
        }

        streaming.blocks = [...streaming.blocks, ...newBlocks];
        set({ streamingMessage: { ...streaming } });
        break;
      }

      case 'user': {
        // tool_result 通过 user 消息返回
        const streaming = state.streamingMessage;
        if (streaming && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_result') {
              applyToolResult(streaming, block);
            }
          }
          set({ streamingMessage: { ...streaming } });
        }
        break;
      }

      case 'result': {
        const streaming = state.streamingMessage;
        if (streaming) {
          streaming.blocks.push({ kind: 'stats', data: msg });
        }

        const archived = finalizeStreaming(state, msg.is_error ? 'error' : 'completed');

        // 归档会话（标题取第一条用户消息）
        const firstUserMsg = state.messages.find((m) => m.role === 'user');
        const title = firstUserMsg?.blocks.find((b) => b.kind === 'text')?.text?.slice(0, 50) || 'Session';

        // 本轮执行的成本事件（仪表盘按时间聚合用）
        const event: SessionEvent = {
          t: Date.now(),
          cost: msg.total_cost_usd,
          input: msg.usage.input_tokens,
          output: msg.usage.output_tokens,
        };

        const newSession: Session = {
          sessionId: msg.session_id,
          cwd: state.cwd,
          title,
          messages: archived.messages,
          createdAt: Date.now(),
          cost: msg.total_cost_usd,
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          model: state.currentModel || undefined,
          events: [event],
        };

        // 同 sessionId 的会话更新而非重复添加（多轮对话）
        const existingIdx = state.sessions.findIndex((s) => s.sessionId === msg.session_id);
        const sessions = existingIdx >= 0
          ? state.sessions.map((s, i) => (i === existingIdx ? {
              ...newSession,
              createdAt: s.createdAt, // 保留首次创建时间
              cost: s.cost + msg.total_cost_usd,
              inputTokens: s.inputTokens + msg.usage.input_tokens,
              outputTokens: s.outputTokens + msg.usage.output_tokens,
              model: state.currentModel || s.model,
              events: [...(s.events || []), event],
            } : s))
          : [newSession, ...state.sessions];

        // 限制会话数量，超出部分丢弃最旧的
        const trimmedSessions = sessions.slice(0, MAX_SESSIONS);

        set({
          ...archived,
          status: msg.is_error ? 'error' : 'completed',
          totalCost: state.totalCost + msg.total_cost_usd,
          totalInputTokens: state.totalInputTokens + msg.usage.input_tokens,
          totalOutputTokens: state.totalOutputTokens + msg.usage.output_tokens,
          sessions: trimmedSessions,
        });
        break;
      }

      case 'stderr': {
        const streaming = state.streamingMessage;
        if (streaming) {
          streaming.blocks.push({ kind: 'stderr', text: msg.text });
          set({ streamingMessage: { ...streaming } });
        }
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
