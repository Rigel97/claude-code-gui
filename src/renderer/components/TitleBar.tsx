import { Minus, Square, X, Zap } from 'lucide-react';

// 渲染层检测 macOS（navigator.userAgent 在 Electron 中包含平台信息）
const isMac = navigator.userAgent.includes('Mac');

export function TitleBar() {
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
        <span className="text-xs text-text-dim ml-2 font-mono">v1.0.0</span>
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
