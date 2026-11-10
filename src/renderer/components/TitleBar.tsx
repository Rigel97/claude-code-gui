import { Minus, Square, X, Zap } from 'lucide-react';
import { useStore } from '../store';
import { useProjectsStore } from '../projectStore';
// 版本号单一数据源：package.json（electron-builder 生成 Info.plist 也读它，
// 此前硬编码 v1.0.0 导致升版后界面不更新）
import { version } from '../../../package.json';

// 渲染层检测 macOS（navigator.userAgent 在 Electron 中包含平台信息）
const isMac = navigator.userAgent.includes('Mac');

export function TitleBar() {
  const projectsOpen = useProjectsStore((state) => state.open);
  const selectedProject = useProjectsStore((state) => state.projects.find((project) => project.id === state.selectedProjectId));
  const activeConversation = useStore((state) => state.conversations.find((conversation) => conversation.id === state.activeConversationId));
  const fallbackCwd = useStore((state) => state.cwd);
  const linkedProject = useProjectsStore((state) => state.projects.find((project) => project.conversations?.some((link) => link.conversationId === activeConversation?.id)));
  const cwd = activeConversation?.cwd || fallbackCwd;
  // 顶部始终展示当前作用域，侧栏折叠后也不会丢失“我在项目还是对话里”的线索。
  // 已关联项目的对话即使离开了项目中心，也继续显示项目作用域，与输入框摘要保持一致。
  const scopeLabel = projectsOpen || linkedProject ? '项目' : '对话';
  const scopeValue = projectsOpen ? (selectedProject?.name || '未选择项目') : (linkedProject?.name || activeConversation?.title || '未命名对话');
  return (
    <div className={`drag-region flex items-center justify-between h-10 bg-bg-deep border-b border-border/50 shrink-0 ${isMac ? 'pl-20 pr-3' : 'px-3'}`}>
      {/* Logo + 标题 */}
      <div className="flex items-center gap-2 no-drag">
        <div className="flex items-center gap-1.5">
          <Zap className="w-4 h-4 text-accent-cyan" fill="currentColor" />
          <span className="text-sm font-semibold gradient-text-cyan tracking-wide">
            CLAUDE GUI
          </span>
        </div>
        <span className="ml-2 font-mono text-2xs text-text-dim">v{version}</span>
        <span className="ml-1 hidden items-center gap-1.5 text-2xs text-text-secondary md:flex">
          <span className="rounded bg-bg-light px-1.5 py-0.5 text-text-muted">{scopeLabel}</span>
          <span className="max-w-[240px] truncate text-text-primary" title={scopeValue}>{scopeValue}</span>
          {cwd && <span className="max-w-[180px] truncate font-mono text-text-dim" title={cwd}>· {cwd.split('/').pop()}</span>}
        </span>
      </div>

      {/* 窗口控制按钮（macOS 有原生红绿灯，此处仅非 mac 平台显示） */}
      {!isMac && (
        <div className="flex items-center gap-1 no-drag">
          <button
            onClick={() => (window as any).api.window.minimize()}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-lighter text-text-muted hover:text-text-primary transition-colors"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => (window as any).api.window.maximize()}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-lighter text-text-muted hover:text-text-primary transition-colors"
          >
            <Square className="w-3 h-3" />
          </button>
          <button
            onClick={() => (window as any).api.window.close()}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent-red/20 text-text-muted hover:text-accent-red transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
