import { useEffect, useCallback } from 'react';
import { useStore } from './store';
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
  const currentSessionId = useStore((s) => s.currentSessionId);

  // 零成本查询当前会话的上下文占用（/context 本地命令，不调 API）：
  // 轮末、会话切换、hydrate 恢复后触发；流式事件里的 usage 恒为零/
  // 多轮累计失真，均不可作为占用值，真实值只能来自这里
  const refreshContextUsage = useCallback(async () => {
    const api = (window as any).api;
    if (typeof api?.claude?.getContext !== 'function') return;
    const { cwd, currentSessionId } = useStore.getState();
    if (!cwd || !currentSessionId) return;
    try {
      const r = await api.claude.getContext(cwd, currentSessionId);
      // 竞态防护：查询期间（约 1~3s）用户可能已切换会话
      if (
        r &&
        typeof r.used === 'number' &&
        typeof r.limit === 'number' &&
        r.limit > 0 &&
        useStore.getState().currentSessionId === currentSessionId
      ) {
        useStore.getState().setContextUsage({
          used: r.used,
          limit: r.limit,
          free: typeof r.free === 'number' ? r.free : undefined,
          autocompactBuffer: typeof r.autocompactBuffer === 'number' ? r.autocompactBuffer : undefined,
        });
      }
    } catch {
      /* 查询失败静默降级：保留旧值 */
    }
  }, []);

  // 会话变化（切换会话 / hydrate 恢复 / 首次 init）时刷新
  useEffect(() => {
    if (!currentSessionId) return;
    void refreshContextUsage();
  }, [currentSessionId, refreshContextUsage]);

  // 启动时恢复持久化状态
  useEffect(() => {
    (window as any).api.store.get('appState').then((saved: unknown) => {
      if (saved && typeof saved === 'object') {
        useStore.getState().hydrate(saved as any);
      }
    });
  }, []);

  // 状态变更时节流持久化（3s 内最多写一次、带 trailing）：
  // - 旧实现是 1s 防抖且被流式事件不断重置，长流式期间永不落盘，崩溃即丢整段对话
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
      // 当前对话也持久化：被中断/未归档的对话重启后不丢失
      messages: state.messages,
      activeSessionIndex: state.activeSessionIndex,
      currentSessionId: state.currentSessionId,
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

  // 监听 claude 流式事件
  useEffect(() => {
    const removeStream = (window as any).api.claude.onStream((data: unknown) => {
      handleStream(data as any);
    });

    const removeStatus = (window as any).api.claude.onStatusChange((status: string) => {
      setStatus(status as any);
      // 任务完成且窗口不在前台时，发系统通知
      if (status === 'completed' && document.visibilityState !== 'visible') {
        const state = useStore.getState();
        if (!state.notifyOnComplete) return;
        const lastUserMsg = [...state.messages].reverse().find((m) => m.role === 'user');
        const snippet = lastUserMsg?.blocks.find((b) => b.kind === 'text')?.text?.slice(0, 60) || '';
        (window as any).api.notify('Claude 任务完成', snippet);
      }
      // 轮末（含中断，部分输出已入上下文）刷新上下文占用
      if (status === 'completed' || status === 'aborted') {
        void refreshContextUsage();
      }
    });

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
            {cwd ? <ChatArea /> : <WelcomeScreen />}
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
