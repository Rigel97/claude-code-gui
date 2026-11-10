import { useStore } from '../store';
import { FolderOpen, Plus, MessageSquare, Settings, Activity, Files, BarChart3, Check, X, Zap, Pin, Search, MoreHorizontal, PanelLeftClose, PanelLeftOpen, TerminalSquare } from 'lucide-react';
import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { SettingsPanel } from './SettingsPanel';
import { FileTree } from './FileTree';
import { SkillList } from './SkillList';
import { CostDashboard } from './CostDashboard';
import { sessionToJson, sessionToMarkdown } from '../utils/exportSession';
import { useTerminalStore } from '../terminalStore';
import { SessionHistoryPanel } from './SessionActions';
import type { Session } from '../types';
import { useProjectsStore } from '../projectStore';
import { FolderKanban } from 'lucide-react';
import { formatTokens } from '../utils/format';
import { ICON_BUTTON, ICON_BUTTON_SM, MENU_ITEM, MENU_ITEM_DANGER, NAV_ITEM, NAV_ITEM_ACTIVE, SEGMENT, SEGMENT_ACTIVE } from './controls';

const modKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function Sidebar() {
  const projectsOpen = useProjectsStore((s) => s.open);
  const projectCount = useProjectsStore((s) => s.projects.reduce((count, project) => count + (!project.archivedAt && !project.deletedAt ? 1 : 0), 0));
  const showProjects = useProjectsStore((s) => s.showProjects);
  const showChat = useProjectsStore((s) => s.showChat);
  const defaultCwd = useStore((s) => s.cwd);
  const cwd = useStore(state => state.conversations.find(conversation => conversation.id === state.activeConversationId)?.cwd || state.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const sessions = useStore((s) => s.sessions);
  const openSessionTab = useStore((s) => s.openSessionTab);
  const deleteSession = useStore((s) => s.deleteSession);
  // 活跃会话高亮：由当前标签页的 sessionId 派生（不再是存储的索引）
  const activeSessionId = useStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId);
    return conv?.sessionId ?? null;
  });
  const newConversation = useStore((s) => s.newConversation);
  const renameSession = useStore((s) => s.renameSession);
  const togglePinSession = useStore((s) => s.togglePinSession);
  const totalInputTokens = useStore((s) => s.totalInputTokens);
  const totalOutputTokens = useStore((s) => s.totalOutputTokens);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed);
  const conversations = useStore((s) => s.conversations);
  const activeConversation = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId));
  const selectedProject = useProjectsStore((s) => s.projects.find((p) => p.id === s.selectedProjectId));
  const linkedProject = useProjectsStore((s) => s.projects.find((p) => !p.deletedAt && p.conversations?.some(link => link.conversationId === activeConversation?.id)));
  const collapsed = sidebarCollapsed;
  const sidebarRef = useRef<HTMLElement>(null);
  /** 删除限制：该会话是否有正在生成的标签页 */
  const isStreamingRow = (sessionId: string) =>
    conversations.some(
      (c) => c.sessionId === sessionId && (c.status === 'streaming' || c.status === 'starting')
    );

  const [showSettings, setShowSettings] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [historyCwd, setHistoryCwd] = useState<string | null>(null);
  const [exportError, setExportError] = useState('');
  const [tab, setTab] = useState<'sessions' | 'files' | 'skills'>('sessions');
  const openTab = (next: typeof tab) => {
    setTab(next);
    if (collapsed) setSidebarCollapsed(false);
    requestAnimationFrame(() => document.getElementById('sidebar-content')?.focus({ preventScroll: true }));
  };
  // 正在确认删除的会话索引（-1 表示无）
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState(-1);
  // 正在重命名的会话索引（-1 表示无）与其编辑框内容
  const [editingIdx, setEditingIdx] = useState(-1);
  const [editTitle, setEditTitle] = useState('');
  // 会话行“更多”菜单（-1 表示无）
  const [menuIdx, setMenuIdx] = useState(-1);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  // 拖拽中状态（用于手柄高亮）
  const [resizing, setResizing] = useState(false);

  // 侧栏宽度拖拽：最小 200px，最大 480px
  const MIN_W = 200;
  const MAX_W = 480;
  const dragState = useRef<{ startX: number; startW: number } | null>(null);

  // 响应式宽度只影响展示，不在配置读取前改写持久化设置，也保留宽屏偏好。
  const [windowWidth, setWindowWidth] = useState(() => typeof window === 'undefined' ? 1400 : window.innerWidth);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const displayWidth = Math.min(sidebarWidth, windowWidth < 1100 ? 240 : MAX_W);

  // 菜单打开后点击外部或 Esc 关闭
  useEffect(() => {
    if (menuIdx < 0) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-session-menu]')) setMenuIdx(-1);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (document.activeElement as HTMLElement | null)?.closest('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      document.querySelector<HTMLElement>('[data-session-menu="open"] button[aria-expanded="true"]')?.focus({ preventScroll: true });
      setMenuIdx(-1);
    };
    const onScroll = (event: Event) => { if (!(event.target as HTMLElement).closest?.('[data-session-menu="panel"]')) setMenuIdx(-1); };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [menuIdx]);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startW: displayWidth };
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
  }, [displayWidth, setSidebarWidth]);

  const handleOpenDir = async () => {
    const dir = await (window as any).api.openDirectory();
    if (dir) {
      // 先更新全局 cwd，再基于新目录新开标签页；
      // 已开标签页各自持有创建时的 cwd 快照，运行中的任务不受影响
      if (!(await showChat())) return;
      setCwd(dir);
      newConversation({ cwd: dir });
    }
  };

  // 导出会话为 Markdown 文件
  const handleExport = async (session: Session) => {
    const md = sessionToMarkdown(session);
    const safeName = session.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'session';
    setExportError('');
    try { await (window as any).api.exportMarkdown(`${safeName}.md`, md); }
    catch (error) { setExportError(error instanceof Error ? error.message : String(error)); }
  };

  return (
    <>
      <aside
        ref={sidebarRef}
        aria-label="侧栏"
        className="relative flex min-h-0 shrink-0 flex-col border-r border-border/50 bg-bg-deep/80 backdrop-blur-sm"
        style={{ width: collapsed ? 64 : displayWidth }}
      >
        {/* 工作目录只占一组；完整路径和作用域仍可查看。 */}
        <div className="shrink-0 border-b border-border/40 p-2">
          <div className={`flex items-center gap-1 ${collapsed ? 'justify-center' : 'justify-between'}`}>
            {!collapsed && <span className="px-2 text-xs font-medium text-text-muted">工作区</span>}
            <button type="button" onClick={() => setSidebarCollapsed(!collapsed)} aria-label={collapsed ? '展开侧栏' : '折叠侧栏'} aria-expanded={!collapsed} title={collapsed ? '展开侧栏' : '折叠为图标栏'} className={ICON_BUTTON}>
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          </div>
          <button type="button" onClick={handleOpenDir} title={`${cwd || '未选择工作目录'}\n选择其他目录会新建对话，不影响正在运行的任务`} aria-label={`工作目录：${cwd || '未选择'}`} className={`${NAV_ITEM} ${collapsed ? 'justify-center px-0' : ''}`}>
            <FolderOpen className="h-4 w-4 shrink-0 text-accent-cyan" />
            {!collapsed && <span className="min-w-0 flex-1 truncate text-left text-sm text-text-primary">{cwd ? cwd.split('/').pop() : '选择工作目录'}</span>}
          </button>
          {!collapsed && <p className="truncate px-3 py-1 text-xs text-text-muted" title={projectsOpen ? selectedProject?.name || '项目总览' : linkedProject?.name || activeConversation?.title || '未命名对话'}>
            {projectsOpen ? `项目 · ${selectedProject?.name || '项目总览'}` : linkedProject ? `项目 · ${linkedProject.name}` : `对话 · ${activeConversation?.title || '未命名对话'}`}
          </p>}
        </div>

        <nav aria-label="主导航" className="shrink-0 space-y-1 p-2">
          <div className={`flex items-center gap-1 ${collapsed ? 'flex-col' : ''}`}>
            <button type="button" aria-label="对话工作区" aria-pressed={!projectsOpen} title="返回当前对话，不新建标签页" onClick={() => void showChat()} className={`${NAV_ITEM} ${!projectsOpen ? NAV_ITEM_ACTIVE : ''} ${collapsed ? 'justify-center px-0' : 'min-w-0 flex-1'}`}>
              <MessageSquare className="h-4 w-4 shrink-0" />{!collapsed && <span>对话</span>}
            </button>
            <button type="button" aria-label="新建对话" disabled={!cwd} title={cwd ? '新建工作目录对话，不影响其他标签页' : '先选择工作目录'} onClick={async () => { if (await showChat()) newConversation({ cwd: cwd || defaultCwd }); }} className={ICON_BUTTON}>
              <Plus className="h-4 w-4 text-accent-cyan" />
            </button>
          </div>
          <button type="button" onClick={showProjects} aria-label="项目管理中心" aria-pressed={projectsOpen} title="项目管理中心：打开项目列表与详情" className={`${NAV_ITEM} ${projectsOpen ? NAV_ITEM_ACTIVE : ''} ${collapsed ? 'justify-center px-0' : ''}`}>
            <FolderKanban className="h-4 w-4 shrink-0" />
            {!collapsed && <><span className="flex-1 text-left">项目</span><span className="text-xs tabular-nums text-text-muted">{projectCount}</span></>}
          </button>
        </nav>
        {exportError && <p role="alert" className="px-3 text-xs text-accent-red">{exportError}</p>}

        {/* 标签页切换：会话 / 文件 / 技能 */}
        <div role="group" aria-label="侧栏内容" className={collapsed ? 'flex shrink-0 flex-col gap-1 border-t border-border/40 px-2 py-2' : 'mx-2 mb-2 flex shrink-0 gap-1 rounded-lg border border-border/50 bg-bg-deepest/40 p-1'}>
          <TabButton
            active={tab === 'sessions'}
            onClick={() => openTab('sessions')}
            icon={<Activity className="w-3 h-3" />}
            label="会话"
            compact={collapsed}
          />
          <TabButton
            active={tab === 'files'}
            onClick={() => openTab('files')}
            icon={<Files className="w-3 h-3" />}
            label="文件"
            compact={collapsed}
            disabled={!cwd}
          />
          <TabButton
            active={tab === 'skills'}
            onClick={() => openTab('skills')}
            icon={<Zap className="w-3 h-3" />}
            label="技能"
            compact={collapsed}
          />
        </div>

        {/* 内容区 */}
        <div id="sidebar-content" tabIndex={-1} aria-label={tab === 'sessions' ? '历史会话列表' : tab === 'files' ? '工作区文件' : '可用技能'} className={`min-h-0 flex-1 overflow-y-auto px-2 outline-none ${collapsed ? 'hidden' : ''}`}>
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
                    const editing = editingIdx === i;
                    const isActive = session.sessionId === activeSessionId;
                    const pinned = !!session.pinned;
                    const streaming = isStreamingRow(session.sessionId);
                    const open = async () => {
                      if (confirming) { setConfirmDeleteIdx(-1); return; }
                      setConfirmDeleteIdx(-1);
                      // 点击归档会话：已开则激活对应标签页，未开则新 tab 载入
                      // （多标签页下切换会话不再受生成中限制，其他标签页照常运行）
                      if (await showChat()) openSessionTab(session.sessionId);
                    };
                    return (
                    <div
                      key={session.sessionId}
                      data-session-menu={menuIdx === i ? 'open' : undefined}
                      className={`group flex w-full items-start gap-1 rounded-lg border px-1.5 py-1.5 transition-colors ${
                        confirming
                          ? 'border-accent-red/40 bg-accent-red/10'
                          : isActive
                            ? 'border-border-light bg-bg-lighter'
                            : pinned
                              ? 'border-accent-yellow/25 bg-bg-light/60'
                              : 'border-transparent hover:bg-bg-light'
                      }`}
                    >
                      {editing ? (
                        <input
                          autoFocus
                          value={editTitle}
                          spellCheck={false}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            // 输入法组合中不提交（中文标题回车确认候选词）
                            if (e.nativeEvent.isComposing) return;
                            if (e.key === 'Enter') {
                              renameSession(i, editTitle);
                              setEditingIdx(-1);
                            }
                            if (e.key === 'Escape') setEditingIdx(-1);
                          }}
                          onBlur={() => {
                            renameSession(i, editTitle);
                            setEditingIdx(-1);
                          }}
                          className="min-w-0 flex-1 rounded-md border border-accent-cyan/40 bg-bg-deepest px-1.5 py-0.5 font-mono text-xs text-text-primary caret-accent-cyan outline-none"
                        />
                      ) : confirming ? (
                        <div className="min-w-0 flex-1 px-1 py-0.5 text-xs font-medium leading-tight text-accent-red">
                          删除此会话？不可恢复
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={open}
                          title={`${session.title}${session.sessionId ? ` · ${session.sessionId.slice(0, 8)}` : ''}`}
                          aria-label={`打开会话 ${session.title}`}
                          className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
                        >
                          <MessageSquare
                            className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                              isActive ? 'text-accent-cyan' : pinned ? 'text-accent-yellow/80' : 'text-text-muted'
                            }`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="line-clamp-2 block text-xs leading-4 text-text-primary">{session.title}</span>
                            <span className="mt-0.5 block font-mono text-2xs text-text-secondary">
                              {formatTokens(session.inputTokens + session.outputTokens)} tok · {new Date(session.createdAt).toLocaleTimeString()}
                            </span>
                          </span>
                        </button>
                      )}
                      {confirming ? (
                        // 删除确认：✓ 确认 / ✗ 取消
                        <div className="mt-0.5 flex shrink-0 items-center gap-1">
                          <button
                            onClick={() => { setConfirmDeleteIdx(-1); deleteSession(i); }}
                            className="text-accent-red transition-colors hover:text-accent-red"
                            title="确认删除"
                            aria-label="确认删除会话"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setConfirmDeleteIdx(-1)}
                            className="text-text-muted transition-colors hover:text-text-primary"
                            title="取消"
                            aria-label="取消删除"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ) : editing ? null : (
                        <div className="flex shrink-0 items-center gap-0.5">
                          {pinned && <Pin className="h-3 w-3 shrink-0 text-accent-yellow/70 fill-accent-yellow/30" aria-label="已置顶" />}
                          <div className="relative">
                            <button
                              type="button"
                              aria-label={`会话操作 ${session.title}`}
                              aria-expanded={menuIdx === i}
                              onClick={event => {
                                const rect = event.currentTarget.getBoundingClientRect();
                                setMenuPosition({ left: Math.max(8, Math.min(window.innerWidth - 184, rect.right - 176)), top: Math.max(8, Math.min(window.innerHeight - 210, rect.bottom + 4)) });
                                setMenuIdx(menuIdx === i ? -1 : i);
                              }}
                              className={`${ICON_BUTTON_SM} opacity-0 focus:opacity-100 group-hover:opacity-100 ${menuIdx === i ? 'opacity-100 bg-bg-lighter' : ''}`}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                            {menuIdx === i && (
                              createPortal(<div data-session-menu="panel" role="menu" className="fixed z-50 w-44 rounded-lg border border-border-light bg-bg-deep p-1.5 shadow-xl" style={menuPosition}>
                                {[
                                  { label: pinned ? '取消置顶' : '置顶会话', run: () => togglePinSession(i) },
                                  { label: '重命名会话', run: () => { setEditingIdx(i); setEditTitle(session.title); } },
                                  { label: '导出 Markdown', run: () => void handleExport(session) },
                                  {
                                    label: '导出 JSON',
                                    run: async () => {
                                      setExportError('');
                                      try {
                                        const name = session.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'session';
                                        await (window as any).api.exportJson(`${name}.json`, sessionToJson(session));
                                      } catch (error) { setExportError(error instanceof Error ? error.message : String(error)); }
                                    },
                                  },
                                  ...(!streaming ? [{ label: '删除会话', run: () => setConfirmDeleteIdx(i), danger: true }] : []),
                                ].map((item) => (
                                  <button
                                    key={item.label}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuIdx(-1); void item.run(); }}
                                    className={'danger' in item && item.danger ? `${MENU_ITEM_DANGER} mt-1 border-t border-border/40` : MENU_ITEM}
                                  >
                                    {item.label}
                                  </button>
                                ))}
                                {streaming && <p className="px-2 py-1 text-2xs text-text-muted">正在生成，暂不能删除</p>}
                              </div>, document.body)
                            )}
                          </div>
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

        {/* 工具统一为同尺寸网格，避免统计、导航和动作各用一套布局。 */}
        <div className="shrink-0 space-y-1 border-t border-border/40 p-2">
          {!collapsed && <div className="px-3 pb-1 text-xs font-medium text-text-muted">工具</div>}
          {/* 可见的搜索入口：不依赖快捷键也能发现能力 */}
          <button
            onClick={() => useStore.getState().setSearchOpen(true)}
            aria-label="搜索会话"
            className={`${NAV_ITEM} ${collapsed ? 'justify-center px-0' : ''}`}
            title="搜索所有会话的消息内容"
          >
            <Search className="h-4 w-4" />
            {!collapsed && <><span className="flex-1 text-left text-sm">搜索会话</span><kbd className="rounded border border-border px-1 font-mono text-2xs text-text-secondary">{modKey}F</kbd></>}
          </button>

          <div className={collapsed ? 'grid gap-1' : 'grid grid-cols-2 gap-1'}>
            <button
              className={`${NAV_ITEM} h-8 gap-2 text-xs ${collapsed ? 'justify-center px-0' : 'px-2'}`}
              aria-label="原生终端"
              title="原生终端"
              onClick={async () => { if (await showChat()) useTerminalStore.getState().show(); }}
            >
              <TerminalSquare className="h-4 w-4 shrink-0" />{!collapsed && '原生终端'}
            </button>
            <button
              className={`${NAV_ITEM} h-8 gap-2 text-xs ${collapsed ? 'justify-center px-0' : 'px-2'}`}
              aria-label="CLI 历史"
              title="CLI 历史"
              disabled={!cwd}
              onClick={() => setHistoryCwd(cwd)}
            >
              <Activity className="h-4 w-4 shrink-0" />{!collapsed && 'CLI 历史'}
            </button>
          <button
            onClick={() => setShowDashboard(true)}
            aria-label="用量统计"
            className={`${NAV_ITEM} h-8 gap-2 text-xs ${collapsed ? 'justify-center px-0' : 'px-2'}`}
            title={`查看用量统计：${formatTokens(totalInputTokens + totalOutputTokens)} tokens`}
          >
            <BarChart3 className="h-4 w-4 shrink-0" />
            {!collapsed && <span>用量统计</span>}
          </button>

          {/* 设置按钮 */}
          <button
            onClick={() => setShowSettings(true)}
            aria-label="设置"
            className={`${NAV_ITEM} ${collapsed ? 'justify-center px-0' : ''}`}
            title="设置"
          >
            <Settings className="h-4 w-4" />
            {!collapsed && <span className="text-xs">设置</span>}
          </button>
          </div>
        </div>

        {/* 拖拽调宽手柄（折叠时不显示） */}
        {!collapsed && <div
          onMouseDown={onDragStart}
          onDoubleClick={() => setSidebarWidth(256)}
          title="拖拽调整宽度 · 双击恢复默认"
          className={`absolute top-0 -right-1 z-20 h-full w-2 cursor-col-resize transition-colors ${
            resizing ? 'bg-accent-cyan/40' : 'hover:bg-accent-cyan/30'
          }`}
        />}
      </aside>

      {historyCwd !== null && <SessionHistoryPanel key={historyCwd} cwd={historyCwd} onClose={() => setHistoryCwd(null)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showDashboard && <CostDashboard onClose={() => setShowDashboard(false)} />}
    </>
  );
}

function TabButton({ active, onClick, icon, label, disabled, compact }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      aria-controls="sidebar-content"
      title={compact ? `${label}：展开侧栏查看` : label}
      className={`${SEGMENT} px-2 ${compact ? 'w-full' : 'min-w-0 flex-1'} ${active ? SEGMENT_ACTIVE : ''}`}
    >
      {icon}
      {!compact && label}
    </button>
  );
}
