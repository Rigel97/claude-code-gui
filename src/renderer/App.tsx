import { useEffect, useCallback, useState, useRef } from 'react';
import { useStore, snapshotConversations } from './store';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ParticleField } from './components/ParticleField';
import { VideoBackground } from './components/VideoBackground';
import { SearchPanel } from './components/SearchPanel';
import { ProjectCenter } from './components/ProjectCenter';
import { useProjectsStore } from './projectStore';
import { NativeTerminalHost } from './components/NativeTerminal';
import { useTerminalStore } from './terminalStore';
import type { ConversationRuntime, RunStatus } from './types';

export default function App() {
  const cwd = useStore((s) => s.cwd);
  const activeCwd = useStore(state => state.conversations.find(conversation => conversation.id === state.activeConversationId)?.cwd || state.cwd);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [configReady, setConfigReady] = useState(false);
  const configReadyRef = useRef(false);
  const flushPendingRef = useRef<(() => void) | null>(null);
  const persistRecoveredRef = useRef(false);
  const initialStateRef = useRef(useStore.getState());
  const [recovering, setRecovering] = useState(false);

  const restoreConfig = useCallback((saved: unknown, retry: boolean) => {
    const current = useStore.getState();
    const initial = initialStateRef.current;
    const memoryChanged = JSON.stringify(current) !== JSON.stringify(initial);
    const keepMemory = current.conversations.length > 0 || memoryChanged;
    if (keepMemory && !window.confirm('将从磁盘重新读取配置，并合并当前内存中尚未保存的会话与草稿；同名会话以内存版本为准，内存设置保持不变，合并后将恢复自动保存。取消则保留内存并继续禁止覆盖配置。是否继续？')) {
      setPersistenceError('已取消恢复读取；内存会话与草稿已保留，配置仍禁止覆盖。修复文件后可再次读取并确认合并。');
      return;
    }
    if (saved && typeof saved === 'object') {
      current.hydrate(saved as Parameters<typeof current.hydrate>[0]);
      if (keepMemory) {
        const restored = useStore.getState();
        useStore.setState({
          ...current,
          conversations: [...restored.conversations.filter(item => !current.conversations.some(live => live.id === item.id)), ...current.conversations],
          sessions: [...restored.sessions.filter(item => !current.sessions.some(live => live.sessionId === item.sessionId)), ...current.sessions],
          activeConversationId: current.activeConversationId || restored.activeConversationId,
        });
      }
    }
    persistRecoveredRef.current = retry || keepMemory;
    configReadyRef.current = true;
    setConfigReady(true);
    setPersistenceError(null);
  }, []);
  const projectsOpen = useProjectsStore((s) => s.open);
  useEffect(() => { void useProjectsStore.getState().load(); }, []);
  const handleStream = useStore((s) => s.handleStream);
  const setStatus = useStore((s) => s.setStatus);
  const activeConversationId = useStore((s) => s.activeConversationId);

  // 启动时恢复持久化状态
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const saved: unknown = await (window as any).api?.store?.get('appState');
        if (!disposed) restoreConfig(saved, false);
      } catch (error) {
        if (!disposed) setPersistenceError(`会话配置读取失败，原文件已保留且禁止覆盖：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    void load();
    return () => { disposed = true; };
  }, [restoreConfig]);

  // 选择项目目录后确保至少有一个对话标签页
  useEffect(() => {
    if (configReady && cwd && useStore.getState().conversations.length === 0) {
      useStore.getState().newConversation();
    }
  }, [cwd, configReady]);

  // 状态变更时节流持久化（3s 内最多写一次、带 trailing）：
  // - 节流保证流式期间也周期性落盘，最大丢失窗口收敛到 3s；
  //   窗口关闭/退出前另有 beforeunload fire-and-forget 兜底
  useEffect(() => {
    if (!configReady) return;
    type StateSnapshot = ReturnType<typeof useStore.getState>;
    const PERSIST_INTERVAL = 3000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let lastWriteAt = 0;
    let pending: StateSnapshot | null = null;

    const snapshot = (state: StateSnapshot) => ({
      cwd: state.cwd,
      sessions: state.sessions,
      // 全部标签页（含草稿/流式中断收敛），重启后原样恢复
      conversations: snapshotConversations(state.conversations),
      activeConversationId: state.activeConversationId,
      totalCost: state.totalCost,
      totalInputTokens: state.totalInputTokens,
      totalOutputTokens: state.totalOutputTokens,
      model: state.model,
      permissionMode: state.permissionMode,
      showThinking: state.showThinking,
      notifyOnComplete: state.notifyOnComplete,
      maxSessions: state.maxSessions,
      sidebarWidth: state.sidebarWidth,
      effortLevel: state.effortLevel,
      autocompact: state.autocompact,
      maxBudgetUsd: state.maxBudgetUsd,
      videoBg: state.videoBg,
    });

    let writing = false;
    const flush = async () => {
      if (disposed || !pending || writing) return;
      const captured = pending;
      writing = true;
      try {
        await (window as any).api?.store?.set('appState', snapshot(captured));
        if (pending === captured) pending = null;
        lastWriteAt = Date.now();
        if (!disposed) setPersistenceError(null);
      } catch (error) {
        if (!disposed) setPersistenceError(`会话配置保存失败，内存内容未丢弃并将重试：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        writing = false;
        if (!disposed && pending && !timer) timer = setTimeout(() => { timer = null; void flush(); }, PERSIST_INTERVAL);
      }
    };

    const unsubscribe = useStore.subscribe((state) => {
      pending = state;
      if (timer) return;
      const wait = Math.max(0, lastWriteAt + PERSIST_INTERVAL - Date.now());
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, wait);
    });

    const flushPending = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) {
        try {
          const request = (window as any).api?.store?.flush(snapshot(pending));
          void Promise.resolve(request).catch((error: unknown) => {
            if (!disposed) setPersistenceError(`关闭前保存失败，内存内容已保留：${error instanceof Error ? error.message : String(error)}`);
          });
        } catch (error) {
          setPersistenceError(`关闭前保存失败，内存内容已保留：${error instanceof Error ? error.message : String(error)}`);
        }
        // flush 的 IPC 没有写入确认；保留 pending 供取消关闭后的正常写入重试。
        if (!disposed && !timer) timer = setTimeout(() => { timer = null; void flush(); }, PERSIST_INTERVAL);
      }
    };
    flushPendingRef.current = flushPending;
    // 仅恢复读取成功后补存内存合并结果；初次挂载不抢写空历史。
    if (persistRecoveredRef.current) {
      persistRecoveredRef.current = false;
      pending = useStore.getState();
      void flush();
    }

    return () => {
      disposed = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      if (flushPendingRef.current === flushPending) flushPendingRef.current = null;
    };
  }, [configReady]);

  // 关闭守卫不依赖配置读取成功，坏文件期间也保护项目草稿。
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (configReadyRef.current) flushPendingRef.current?.();
      const projects = useProjectsStore.getState();
      const pendingProgress = projects.pendingProgress;
      const conversations = useStore.getState().conversations;
      const chatBusy = conversations.some(conv => conv.status === 'starting' || conv.status === 'streaming'
        || conv.runtime?.busy || conv.pendingApprovals?.length || conv.queue.length);
      const terminalBusy = useTerminalStore.getState().terminals.some(term => term.status !== 'exited');
      if (projects.dirty || projects.reviewDirty || projects.writeOperation || pendingProgress > 0 || projects.scanOperation || chatBusy || terminalBusy) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // 零成本查询指定标签页的上下文占用（/context 本地命令，不调 API）：
  // 轮末、切换标签页时触发；流式事件里的 usage 恒为零/多轮累计失真，
  // 均不可作为占用值，真实值只能来自这里
  const refreshContextUsage = useCallback(async (conversationId?: string) => {
    const api = (window as any).api;
    if (typeof api?.claude?.getContext !== 'function') return;
    const store = useStore.getState();
    const convId = conversationId || store.activeConversationId;
    const conv = store.conversations.find((c) => c.id === convId);
    // Passive refresh must not bootstrap another CLI or race a running turn.
    if (!conv || !conv.cwd || !conv.sessionId || !conv.protocolConnected || conv.runtime?.busy
      || conv.status === 'starting' || conv.status === 'streaming') return;
    const { cwd, sessionId, runId } = conv;
    try {
      const r = await api.claude.getContext(cwd, sessionId, convId);
      // 竞态防护：查询期间（约 1~3s）标签页可能被关闭或已换会话
      const cur = useStore
        .getState()
        .conversations.find((c) => c.id === convId);
      if (
        r &&
        typeof r.used === 'number' &&
        typeof r.limit === 'number' &&
        r.limit > 0 &&
        cur &&
        cur.sessionId === sessionId && cur.runId === runId && !cur.runtime?.busy
      ) {
        useStore.getState().setContextUsage(
          {
            used: r.used,
            limit: r.limit,
            free: typeof r.free === 'number' ? r.free : undefined,
            autocompactBuffer: typeof r.autocompactBuffer === 'number' ? r.autocompactBuffer : undefined,
          },
          convId
        );
      }
    } catch {
      /* 查询失败静默降级：保留旧值 */
    }
  }, []);

  // 活跃标签页变化（切 tab / 新建 / 打开会话 / hydrate）时刷新其占用
  useEffect(() => {
    if (!activeConversationId) return;
    void refreshContextUsage(activeConversationId);
  }, [activeConversationId, refreshContextUsage]);

  // 监听 claude 流式事件（事件携带 conversationId，路由到对应标签页）
  useEffect(() => {
    const api = (window as any).api;
    if (!api?.claude) return;
    const removeStream = api.claude.onStream((data: unknown) => {
      handleStream(data as any);
    });

    const removeStatus = api.claude.onStatusChange(
      (payload: { conversationId?: string; status?: string; runId?: string }) => {
        const { conversationId, status, runId } = payload || {};
        const valid: RunStatus[] = ['idle', 'starting', 'streaming', 'completed', 'aborted', 'error'];
        if (!valid.includes(status as RunStatus)) return;
        const target = useStore.getState().conversations.find(conv => conv.id === (conversationId || useStore.getState().activeConversationId));
        if (!target || (runId && target.runId && runId !== target.runId)) return;
        setStatus(status as RunStatus, conversationId, runId);

        const store = useStore.getState();
        const conv = store.conversations.find((c) => c.id === (conversationId || store.activeConversationId));
        if (conv && (status === 'completed' || status === 'error' || status === 'aborted')) {
          const last = [...conv.messages].reverse().find(item => item.role === 'assistant');
          void useProjectsStore.getState().recordConversation(conv.id, {
            status: status === 'error' ? 'failed' : status, recordedAt: Date.now(), ...(last ? { messageId: last.id } : {}),
            excerpt: last?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n').slice(0, 2000) || '',
            ...(conv.sessionId ? { sessionId: conv.sessionId } : {}),
          });
        }

        // 任务完成且窗口不在前台时，发系统通知（附该标签页的最后一条用户消息）
        if (status === 'completed' && document.visibilityState !== 'visible') {
          if (store.notifyOnComplete) {
            const lastUserMsg = [...(conv?.messages ?? [])].reverse().find((m) => m.role === 'user');
            const snippet = lastUserMsg?.blocks.find((b) => b.kind === 'text')?.text?.slice(0, 60) || '';
            void Promise.resolve((window as any).api.notify?.('Claude 任务完成', snippet)).catch(() => {});
          }
        }

        // 轮末（含中断，部分输出已入上下文）刷新该标签页的上下文占用
        if (status === 'completed' || status === 'aborted' || status === 'error') {
          void refreshContextUsage(conversationId);
        }
      }
    );

    return () => {
      removeStream();
      removeStatus();
    };
  }, [handleStream, setStatus, refreshContextUsage]);

  // Reattach metadata after a renderer reload without starting a CLI or sending a prompt.
  useEffect(() => {
    if (!configReady) return;
    const api = (window as any).api?.claude;
    if (typeof api?.states !== 'function') return;
    let disposed = false;
    void Promise.resolve(api.states()).then((states: ConversationRuntime[]) => {
      if (disposed || !Array.isArray(states)) return;
      for (const runtime of states) {
        if (!runtime?.conversationId) continue;
        const current = useStore.getState().conversations.find(conv => conv.id === runtime.conversationId);
        if (!current || (runtime.sessionId && current.sessionId && runtime.sessionId !== current.sessionId)) continue;
        useStore.getState().setRuntime(current.id, runtime);
      }
    }).catch(() => {});
    return () => { disposed = true; };
  }, [configReady]);

  // Cmd/Ctrl+F 打开搜索面板
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        useStore.getState().setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex flex-col h-screen tech-grid-bg bg-bg-deepest">
      {/* 动态视频背景（最底层，可选；失败时静默回落深色背景） */}
      <VideoBackground />

      {/* 粒子网络背景 */}
      <ParticleField />

      {/* 噪点纹理 */}
      <div className="noise-overlay" />

      {/* 扫描线特效 */}
      <div className="scan-overlay" />

      {/* 主内容（位于粒子层之上） */}
      <div className="relative z-10 flex flex-col flex-1 overflow-hidden">
        {/* 标题栏 */}
        <TitleBar />

        {persistenceError && <div role="alert" className="flex items-center gap-3 px-4 py-2 border-b border-accent-red/30 bg-bg-deep text-xs text-accent-red"><span className="flex-1 break-words">{persistenceError}</span><button disabled={recovering} className="shrink-0 border border-border rounded px-2 py-1" onClick={async () => {
          const bridge = (window as any).api?.store;
          if (!bridge?.reload || recovering) return;
          setRecovering(true);
          try {
            const saved: unknown = await bridge.reload();
            if (!configReadyRef.current) restoreConfig(saved, true);
            // 已读过配置时只解除磁盘安全 hold；失败的 pending 仍由原订阅重试。
            else setPersistenceError('已从磁盘重新读取配置；内存未保存内容保持不变，正在重试保存。');
          } catch (error) {
            setPersistenceError(`恢复读取失败，内存内容已保留：${error instanceof Error ? error.message : String(error)}`);
          } finally { setRecovering(false); }
        }}>{configReady ? '重新读磁盘并重试保存（保留内存）' : '修复后重新读磁盘（确认合并内存）'}</button></div>}
        {/* 主体 */}
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* key 按标签页切换重挂载：滚动位置/草稿各自独立 */}
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              {projectsOpen ? <ProjectCenter /> : activeCwd ? <ChatArea key={activeConversationId} /> : <WelcomeScreen />}
            </div>
            {/* Stable sibling: switching chat/project views never destroys a PTY or xterm. */}
            <div className="shrink-0">
              <NativeTerminalHost />
            </div>
          </div>
        </div>

        {/* 底部状态栏 */}
        <StatusBar />
      </div>

      {/* 消息搜索面板 */}
      <SearchPanel />
    </div>
  );
}
