import { useStore } from '../store';
import { FolderOpen, Plus, MessageSquare, Settings, Activity, Files, BarChart3, Download } from 'lucide-react';
import { useState } from 'react';
import { SettingsPanel } from './SettingsPanel';
import { FileTree } from './FileTree';
import { CostDashboard } from './CostDashboard';
import { sessionToMarkdown } from '../utils/exportSession';
import type { Session } from '../types';

export function Sidebar() {
  const cwd = useStore((s) => s.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const sessions = useStore((s) => s.sessions);
  const switchSession = useStore((s) => s.switchSession);
  const activeSessionIndex = useStore((s) => s.activeSessionIndex);
  const newSession = useStore((s) => s.newSession);
  const totalCost = useStore((s) => s.totalCost);
  const status = useStore((s) => s.status);
  const isStreaming = status === 'streaming' || status === 'starting';

  const [showSettings, setShowSettings] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [tab, setTab] = useState<'sessions' | 'files'>('sessions');

  const handleOpenDir = async () => {
    const dir = await (window as any).api.openDirectory();
    if (dir) {
      setCwd(dir);
      newSession();
    }
  };

  // 导出会话为 Markdown 文件
  const handleExport = async (session: Session) => {
    const md = sessionToMarkdown(session);
    const safeName = session.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'session';
    await (window as any).api.exportMarkdown(`${safeName}.md`, md);
  };

  return (
    <>
      <aside className="w-64 bg-bg-deep/80 border-r border-border/50 flex flex-col shrink-0 backdrop-blur-sm">
        {/* 当前项目 */}
        <div className="p-3 border-b border-border/30">
          <button
            onClick={handleOpenDir}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-light hover:bg-bg-lighter border border-border hover:border-accent-cyan/40 transition-all group"
          >
            <FolderOpen className="w-4 h-4 text-accent-cyan shrink-0" />
            <div className="flex-1 text-left min-w-0">
              <div className="text-xs text-text-muted font-mono">PROJECT</div>
              <div className="text-xs text-text-primary truncate font-mono">
                {cwd ? cwd.split('/').pop() : '未选择'}
              </div>
            </div>
          </button>
          {cwd && (
            <div className="text-[10px] text-text-dim font-mono mt-1 px-3 truncate">
              {cwd}
            </div>
          )}
        </div>

        {/* 新建会话 */}
        <div className="p-3 pb-2">
          <button
            onClick={newSession}
            disabled={!cwd || isStreaming}
            title={isStreaming ? '生成中，请先停止或等待完成' : undefined}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-accent-cyan/10 to-accent-blue/10 hover:from-accent-cyan/20 hover:to-accent-blue/20 border border-accent-cyan/30 hover:border-accent-cyan/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed group"
          >
            <Plus className="w-4 h-4 text-accent-cyan group-hover:rotate-90 transition-transform" />
            <span className="text-sm text-accent-cyan font-medium">新建对话</span>
          </button>
        </div>

        {/* 标签页切换：会话 / 文件 */}
        <div className="flex gap-1 px-3 pb-2">
          <TabButton
            active={tab === 'sessions'}
            onClick={() => setTab('sessions')}
            icon={<Activity className="w-3 h-3" />}
            label="会话"
          />
          <TabButton
            active={tab === 'files'}
            onClick={() => setTab('files')}
            icon={<Files className="w-3 h-3" />}
            label="文件"
            disabled={!cwd}
          />
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-2">
          {tab === 'sessions' ? (
            <>
              {sessions.length === 0 ? (
                <div className="text-xs text-text-dim px-3 py-4 text-center">
                  暂无历史会话
                </div>
              ) : (
                <div className="space-y-1">
                  {sessions.map((session, i) => (
                    <div
                      key={session.sessionId}
                      onClick={() => !isStreaming && switchSession(i)}
                      className={`w-full flex items-start gap-2 px-2.5 py-2 rounded-lg transition-all text-left group ${
                        isStreaming ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                      } ${
                        i === activeSessionIndex
                          ? 'bg-accent-cyan/10 border border-accent-cyan/30'
                          : 'hover:bg-bg-light border border-transparent'
                      }`}
                    >
                      <MessageSquare
                        className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                          i === activeSessionIndex ? 'text-accent-cyan' : 'text-text-muted'
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-text-primary truncate">
                          {session.title}
                        </div>
                        <div className="text-[10px] text-text-dim font-mono mt-0.5">
                          ${session.cost.toFixed(4)} · {new Date(session.createdAt).toLocaleTimeString()}
                        </div>
                      </div>
                      {/* 导出按钮（hover 显示） */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleExport(session);
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-text-dim hover:text-accent-cyan shrink-0 mt-0.5"
                        title="导出为 Markdown"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            cwd && <FileTree root={cwd} />
          )}
        </div>

        {/* 底部 */}
        <div className="p-3 border-t border-border/30 space-y-2">
          {/* 总成本（点击打开仪表盘） */}
          <button
            onClick={() => setShowDashboard(true)}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg bg-bg-light/50 hover:bg-bg-light hover:border-accent-green/30 border border-transparent transition-all group"
            title="查看成本仪表盘"
          >
            <span className="flex items-center gap-1.5 text-[10px] text-text-muted font-mono uppercase group-hover:text-text-secondary">
              <BarChart3 className="w-3 h-3 text-accent-green/70" />
              Total Cost
            </span>
            <span className="text-xs text-accent-green font-mono font-semibold">
              ${totalCost.toFixed(4)}
            </span>
          </button>

          {/* 设置按钮 */}
          <button
            onClick={() => setShowSettings(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-bg-light text-text-muted hover:text-text-primary transition-colors"
          >
            <Settings className="w-4 h-4" />
            <span className="text-sm">设置</span>
          </button>
        </div>
      </aside>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showDashboard && <CostDashboard onClose={() => setShowDashboard(false)} />}
    </>
  );
}

function TabButton({ active, onClick, icon, label, disabled }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-mono transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? 'bg-accent-cyan/10 border border-accent-cyan/30 text-accent-cyan'
          : 'border border-transparent text-text-muted hover:text-text-primary hover:bg-bg-light'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
