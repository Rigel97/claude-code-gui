import { useEffect } from 'react';
import { useStore } from './store';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ParticleField } from './components/ParticleField';

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
    });

    return () => {
      removeStream();
      removeStatus();
    };
  }, [handleStream, setStatus]);

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
    </div>
  );
}
