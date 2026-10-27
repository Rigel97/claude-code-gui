// 执行可视化的 UI 状态：当前会话的执行图（live）与面板开关，不持久化。
// 图按真实 conversationId 隔离；事件只路由到已知会话。

import { create } from 'zustand';
import type { Conversation } from '../types';
import { ClaudeEventAdapter, graphFromConversation } from './adapter';
import { applyEvent, createGraph } from './model';
import type { AgentViewMode, ExecutionEvent, ExecutionGraph } from './types';
import { MAX_LIVE_GRAPHS } from './types';

const adapter = new ClaudeEventAdapter();

/** 模块内的已知会话索引与 LRU 顺序（不参与渲染） */
const runtime = {
  order: [] as string[],
  known: new Map<string, { title: string; projectPath: string; sessionId: string | null }>(),
};

/** 测试或重置时清空会话索引与执行图（不影响面板开关） */
export function resetAgentRuntime(): void {
  adapter.reset();
  runtime.order = [];
  runtime.known.clear();
  useAgentStore.setState({ live: {} });
}

function reduceAll(graph: ExecutionGraph, events: readonly ExecutionEvent[]): ExecutionGraph {
  let acc = graph;
  for (const ev of events) acc = applyEvent(acc, ev);
  return acc;
}

function capLive(live: Record<string, ExecutionGraph>): Record<string, ExecutionGraph> {
  const ids = Object.keys(live);
  if (ids.length <= MAX_LIVE_GRAPHS) return live;
  const keep = runtime.order.filter((id) => live[id]).slice(-MAX_LIVE_GRAPHS);
  const next: Record<string, ExecutionGraph> = {};
  for (const id of keep) next[id] = live[id];
  return next;
}

/** 新一轮执行图：沿用已同步的标题 / 项目路径 / sessionId */
function createRunGraph(conversationId: string, meta: { title?: string; projectPath?: string; sessionId?: string | null }): ExecutionGraph {
  const graph = createGraph(conversationId, 'live', meta.title || '执行中', meta.projectPath || '');
  return meta.sessionId ? { ...graph, sessionId: meta.sessionId } : graph;
}

export interface AgentState {
  open: boolean;
  mode: AgentViewMode;
  live: Record<string, ExecutionGraph>;
  show: (mode?: AgentViewMode) => void;
  hide: () => void;
  setMode: (mode: AgentViewMode) => void;
  ingestStream: (raw: unknown) => void;
  ingestStatus: (payload: unknown) => void;
  syncConversations: (conversations: Conversation[]) => void;
}

export const useAgentStore = create<AgentState>((set, get) => {
  const conversationIdOf = (v: unknown): string => {
    if (!v || typeof v !== 'object') return '';
    const id = (v as { conversationId?: unknown }).conversationId;
    return typeof id === 'string' && id ? id : '';
  };

  /** 把 live 事件合入指定会话的图；history 图继续沿用原元信息 */
  const applyLive = (conversationId: string, events: ExecutionEvent[]) => {
    const usable = events.filter((ev) => ev.conversationId === conversationId && ev.source === 'live');
    if (!usable.length) return;
    const state = get();
    const existing = state.live[conversationId];
    // 未同步且未开始的会话不建图，避免幽灵会话
    if (!existing && !runtime.known.has(conversationId)) return;
    const meta = runtime.known.get(conversationId);
    const base = existing ?? createRunGraph(conversationId, meta ?? {});
    const next = reduceAll(base, usable);
    if (next === existing) return;
    runtime.order = [...runtime.order.filter((id) => id !== conversationId), conversationId];
    set({ live: capLive({ ...state.live, [conversationId]: next }) });
  };

  const handleStatus = (payload: unknown) => {
    const conversationId = conversationIdOf(payload);
    if (!conversationId) return;
    const status = (payload as { status?: unknown }).status;
    const meta = runtime.known.get(conversationId);
    const existing = get().live[conversationId];
    // 已关闭 / 未知的会话不再接收任何状态，避免 resurrect
    if (!meta && !existing) return;

    if (status === 'starting') {
      // 新一轮：重置索引与图；标题等元信息来自已同步会话
      adapter.reset(conversationId);
      const events = adapter.status(payload, Date.now());
      const enriched = adapter.enrich(conversationId, meta ?? {}, Date.now());
      let graph = createRunGraph(conversationId, meta ?? {});
      graph = reduceAll(graph, enriched ? [...events, enriched] : events);
      runtime.order = [...runtime.order.filter((id) => id !== conversationId), conversationId];
      set({ live: capLive({ ...get().live, [conversationId]: graph }) });
      return;
    }

    applyLive(conversationId, adapter.status(payload, Date.now()));
  };

  return {
    open: false,
    mode: 'live',
    live: {},

    show: (mode) => set(mode ? { open: true, mode } : { open: true }),
    hide: () => set({ open: false }),
    setMode: (mode) => set({ mode }),

    ingestStream: (raw) => {
      const conversationId = conversationIdOf(raw);
      if (!conversationId) return;
      // 未知会话的流一律丢弃，不落到当前标签页
      if (!runtime.known.has(conversationId) && !get().live[conversationId]) return;
      applyLive(conversationId, adapter.ingest(raw));
    },

    ingestStatus: (payload) => handleStatus(payload),

    syncConversations: (conversations) => {
      const list = Array.isArray(conversations) ? conversations : [];
      const ids = new Set<string>();
      const current = get().live;
      const next: Record<string, ExecutionGraph> = {};
      let changed = false;

      for (const conv of list) {
        if (!conv || typeof conv.id !== 'string' || !conv.id) continue;
        ids.add(conv.id);
        const prev = runtime.known.get(conv.id);
        const meta = { title: conv.title || '会话', projectPath: conv.cwd || '', sessionId: conv.sessionId ?? null };
        if (!prev || prev.title !== meta.title || prev.projectPath !== meta.projectPath || prev.sessionId !== meta.sessionId) {
          runtime.known.set(conv.id, meta);
          changed = true;
        }
        const existing = current[conv.id];
        if (existing) {
          // history 图在会话元信息变化时同步标题（保留已生成的事件）
          if (existing.source === 'history' && (existing.title !== meta.title || existing.projectPath !== meta.projectPath)) {
            next[conv.id] = { ...existing, title: meta.title, projectPath: meta.projectPath, sessionId: meta.sessionId };
            changed = true;
          } else {
            next[conv.id] = existing;
          }
          continue;
        }
        try {
          // 新建历史图前清空该会话索引，避免上一轮残留状态影响
          adapter.reset(conv.id);
          next[conv.id] = graphFromConversation(conv);
          runtime.order = [...runtime.order.filter((id) => id !== conv.id), conv.id];
          changed = true;
        } catch {
          // 单条回填失败不影响其它会话
        }
      }

      // 已关闭会话：彻底清理图与索引（含 adapter 计数器 / 时间戳 / 去重缓存），之后不再接收事件
      for (const id of Object.keys(current)) {
        if (ids.has(id)) continue;
        adapter.forget(id);
        runtime.order = runtime.order.filter((x) => x !== id);
        changed = true;
      }
      for (const id of [...runtime.known.keys()]) {
        if (!ids.has(id)) {
          runtime.known.delete(id);
          changed = true;
        }
      }
      runtime.order = runtime.order.filter((id) => ids.has(id));

      if (!changed) return;
      set({ live: capLive(next) });
    },
  };
});
