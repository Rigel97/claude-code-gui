import { useStore } from '../store';
import { FolderOpen, Plus, MessageSquare, Settings, Activity, Files, BarChart3, Download, Trash2, Check, X, Zap } from 'lucide-react';
import { useState, useCallback, useRef } from 'react';
import { SettingsPanel } from './SettingsPanel';
import { FileTree } from './FileTree';
import { SkillList } from './SkillList';
import { CostDashboard } from './CostDashboard';
import { sessionToMarkdown } from '../utils/exportSession';
import type { Session } from '../types';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function Sidebar() {
  const cwd = useStore((s) => s.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const sessions = useStore((s) => s.sessions);
  const switchSession = useStore((s) => s.switchSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const activeSessionIndex = useStore((s) => s.activeSessionIndex);
  const newSession = useStore((s) => s.newSession);
  const totalInputTokens = useStore((s) => s.totalInputTokens);
  const totalOutputTokens = useStore((s) => s.totalOutputTokens);
  const status = useStore((s) => s.status);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const isStreaming = status === 'streaming' || status === 'starting';

  const [showSettings, setShowSettings] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [tab, setTab] = useState<'sessions' | 'files' | 'skills'>('sessions');
  // 正在确认删除的会话索引（-1 表示无）
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState(-1);
  // 拖拽中状态（用于手柄高亮）
  const [resizing, setResizing] = useState(false);

  // 侧栏宽度拖拽：最小 200px，最大 480px
  const MIN_W = 200;
  const MAX_W = 480;
  const dragState = useRef<{ startX: number; startW: number } | null>(null);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startW: sidebarWidth };
    setResizing(true);

    const onMove = (ev: MouseEvent) => {
      // 鼠标已松开但未收到 mouseup（拖出窗口等异常）时终止拖拽
      if (ev.buttons === 0) {
        window.removeEventListener('mousemove', onMove);
        setResizing(false);
        dragState.current = null;
        return;
      }
      const d = dragState.current;
      if (!d) return;
      const w = d.startW + ev.clientX - d.startX;
      setSidebarWidth(Math.min(MAX_W, Math.max(MIN_W, w)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setResizing(false);
      dragState.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth, setSidebarWidth]);

  const handleOpenDir = async () => {
    // 生成中禁止切换项目：newSession 会被状态机静默跳过，否则会落下
    // 「新目录 + 旧会话 --resume」的跨项目串台组合
    if (isStreaming) return;
    const dir = await (window as any).api.openDirectory();
    if (dir) {
      // 先归档旧对话（携带旧 cwd），再切到新目录；顺序颠倒会把旧对话归到新目录名下
      newSession();
      setCwd(dir);
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
      <aside
        className="relative bg-bg-deep/80 border-r border-border/50 flex flex-col shrink-0 backdrop-blur-sm"
        style={{ width: sidebarWidth }}
      >
        {/* 当前项目 */}
        <div className="p-3 border-b border-border/30">
          <button
            onClick={handleOpenDir}
            disabled={isStreaming}
            title={isStreaming ? '生成中，请先停止或等待完成' : undefined}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-light hover:bg-bg-lighter border border-border hover:border-accent-cyan/40 transition-all group disabled:opacity-40 disabled:cursor-not-allowed"
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

        {/* 标签页切换：会话 / 文件 / 技能 */}
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
          <TabButton
            active={tab === 'skills'}
            onClick={() => setTab('skills')}
            icon={<Zap className="w-3 h-3" />}
            label="技能"
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
                  {sessions.map((session, i) => {
                    const confirming = confirmDeleteIdx === i;
                    return (
                    <div
                      key={session.sessionId}
                      onClick={() => {
                        if (isStreaming) return;
                        // 若该行正处于删除确认态，点击行体视为取消
                        if (confirming) { setConfirmDeleteIdx(-1); return; }
                        setConfirmDeleteIdx(-1);
                        switchSession(i);
                      }}
                      className={`w-full flex items-start gap-2 px-2.5 py-2 rounded-lg transition-all text-left group ${
                        isStreaming ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                      } ${
                        confirming
                          ? 'bg-red-500/10 border border-red-500/40'
                          : i === activeSessionIndex
                            ? 'bg-accent-cyan/10 border border-accent-cyan/30'
                            : 'hover:bg-bg-light border border-transparent'
                      }`}
                    >
                      <MessageSquare
                        className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                          confirming ? 'text-red-400' : i === activeSessionIndex ? 'text-accent-cyan' : 'text-text-muted'
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        {confirming ? (
                          <div className="text-xs text-red-300 font-medium leading-tight pt-0.5">
                            删除此会话？不可恢复
                          </div>
                        ) : (
                          <>
                            <div className="text-xs text-text-primary truncate">
                              {session.title}
                            </div>
                            <div className="text-[10px] text-text-dim font-mono mt-0.5">
                              {formatTokens(session.inputTokens + session.outputTokens)} tok · {new Date(session.createdAt).toLocaleTimeString()}
                            </div>
                          </>
                        )}
                      </div>
                      {confirming ? (
                        // 删除确认：✓ 确认 / ✗ 取消
                        <div className="flex items-center gap-1 shrink-0 mt-0.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteIdx(-1);
                              deleteSession(i);
                            }}
                            className="text-red-400 hover:text-red-300 transition-colors"
                            title="确认删除"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteIdx(-1);
                            }}
                            className="text-text-dim hover:text-text-primary transition-colors"
                            title="取消"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        // 导出 + 删除（hover 显示）
                        <div className="flex items-center gap-1 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleExport(session);
                            }}
                            className="text-text-dim hover:text-accent-cyan transition-colors"
                            title="导出为 Markdown"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!isStreaming) setConfirmDeleteIdx(i);
                            }}
                            disabled={isStreaming}
                            title={isStreaming ? '生成中无法删除' : '删除会话'}
                            className="text-text-dim hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : tab === 'skills' ? (
            <SkillList />
          ) : (
            cwd && <FileTree root={cwd} />
          )}
        </div>

        {/* 底部 */}
        <div className="p-3 border-t border-border/30 space-y-2">          {/* 总 Token 用量（点击打开用量统计） */}
          <button
            onClick={() => setShowDashboard(true)}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg bg-bg-light/50 hover:bg-bg-light hover:border-accent-green/30 border border-transparent transition-all group"
            title="查看用量统计"
          >
            <span className="flex items-center gap-1.5 text-[10px] text-text-muted font-mono uppercase group-hover:text-text-secondary">
              <BarChart3 className="w-3 h-3 text-accent-green/70" />
              Tokens
            </span>
            <span className="text-xs text-accent-green font-mono font-semibold">
              {formatTokens(totalInputTokens + totalOutputTokens)}
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

        {/* 拖拽调宽手柄 */}
        <div
          onMouseDown={onDragStart}
          onDoubleClick={() => setSidebarWidth(256)}
          title="拖拽调整宽度 · 双击恢复默认"
          className={`absolute top-0 -right-1 w-2 h-full cursor-col-resize z-20 transition-colors ${
            resizing ? 'bg-accent-cyan/40' : 'hover:bg-accent-cyan/30'
          }`}
        />
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
