import { useEffect } from 'react';
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

  // 启动时恢复持久化状态
  useEffect(() => {
    (window as any).api.store.get('appState').then((saved: unknown) => {
      if (saved && typeof saved === 'object') {
        useStore.getState().hydrate(saved as any);
      }
    });
  }, []);

  // 状态变更时防抖持久化（会话、成本、设置、工作目录）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useStore.subscribe((state) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        (window as any).api.store.set('appState', {
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
        });
      }, 1000);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
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
        const lastUserMsg = [...state.messages].reverse().find((m) => m.role === 'user');
        const snippet = lastUserMsg?.blocks.find((b) => b.kind === 'text')?.text?.slice(0, 60) || '';
        (window as any).api.notify('Claude 任务完成', snippet);
      }
    });

    return () => {
      removeStream();
      removeStatus();
    };
  }, [handleStream, setStatus]);

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
