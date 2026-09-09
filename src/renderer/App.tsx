import { useEffect, useCallback } from 'react';
import { useStore, snapshotConversations } from './store';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ParticleField } from './components/ParticleField';
import { SearchPanel } from './components/SearchPanel';

export default function App() {
  const cwd = useStore((s) => s.cwd);
  const handleStream = useStore((s) => s.handleStream);
  const setStatus = useStore((s) => s.setStatus);
  const activeConversationId = useStore((s) => s.activeConversationId);

  // 启动时恢复持久化状态
  useEffect(() => {
    (window as any).api.store.get('appState').then((saved: unknown) => {
      if (saved && typeof saved === 'object') {
        useStore.getState().hydrate(saved as any);
      }
    });
  }, []);

  // 选择项目目录后确保至少有一个对话标签页
  useEffect(() => {
    if (cwd && useStore.getState().conversations.length === 0) {
      useStore.getState().newConversation();
    }
  }, [cwd]);

  // 状态变更时节流持久化（3s 内最多写一次、带 trailing）：
  // - 节流保证流式期间也周期性落盘，最大丢失窗口收敛到 3s；
  //   窗口关闭/退出前另有 beforeunload fire-and-forget 兜底
  useEffect(() => {
    type StateSnapshot = ReturnType<typeof useStore.getState>;
    const PERSIST_INTERVAL = 3000;
    let timer: ReturnType<typeof setTimeout> | null = null;
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
    });

    const flush = () => {
      if (!pending) return;
      (window as any).api.store.set('appState', snapshot(pending));
      pending = null;
      lastWriteAt = Date.now();
    };

    const unsubscribe = useStore.subscribe((state) => {
      pending = state;
      if (timer) return;
      const wait = Math.max(0, lastWriteAt + PERSIST_INTERVAL - Date.now());
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, wait);
    });

    const onBeforeUnload = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) {
        (window as any).api.store.flush(snapshot(pending));
        pending = null;
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
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
    if (!conv || !conv.cwd || !conv.sessionId) return;
    const { cwd, sessionId } = conv;
    try {
      const r = await api.claude.getContext(cwd, sessionId);
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
        cur.sessionId === sessionId
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
    const removeStream = (window as any).api.claude.onStream((data: unknown) => {
      handleStream(data as any);
    });

    const removeStatus = (window as any).api.claude.onStatusChange(
      (payload: { conversationId?: string; status?: string }) => {
        const { conversationId, status } = payload || {};
        if (typeof status !== 'string') return;
        setStatus(status as any, conversationId);

        const store = useStore.getState();
        const conv = store.conversations.find((c) => c.id === (conversationId || store.activeConversationId));

        // 任务完成且窗口不在前台时，发系统通知（附该标签页的最后一条用户消息）
        if (status === 'completed' && document.visibilityState !== 'visible') {
          if (!store.notifyOnComplete) return;
          const lastUserMsg = [...(conv?.messages ?? [])].reverse().find((m) => m.role === 'user');
          const snippet = lastUserMsg?.blocks.find((b) => b.kind === 'text')?.text?.slice(0, 60) || '';
          (window as any).api.notify('Claude 任务完成', snippet);
        }

        // 轮末（含中断，部分输出已入上下文）刷新该标签页的上下文占用
        if (status === 'completed' || status === 'aborted') {
          void refreshContextUsage(conversationId);
        }
      }
    );

    return () => {
      removeStream();
      removeStatus();
    };
  }, [handleStream, setStatus, refreshContextUsage]);

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

        {/* 主体 */}
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* key 按标签页切换重挂载：滚动位置/草稿各自独立 */}
            {cwd ? <ChatArea key={activeConversationId} /> : <WelcomeScreen />}
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
