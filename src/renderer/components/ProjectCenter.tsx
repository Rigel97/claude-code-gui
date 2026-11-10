import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Archive, Check, FolderKanban, FolderPlus, Loader2, Pin, ScanSearch, Search, Trash2, X, AlertTriangle, RefreshCw, Pencil, Database, SlidersHorizontal, CheckCircle2, CircleDot } from 'lucide-react';
import { useStore } from '../store';
import { useProjectsStore } from '../projectStore';
import { PROJECT_LABELS, PROJECT_STATUS_STYLE, progressLabel, projectHealth, projectSummary, projectWorkState, TASK_LABELS } from '../projectModel';
import type { ManagedProject, ProjectEvidenceField, ProjectSource, ProjectStatus, RecognitionMode } from '../projectTypes';
import { ProjectDetail } from './ProjectDetail';
import { FilePreview } from './FilePreview';
import { BUTTON as button, BUTTON_PRIMARY, BUTTON_GHOST, BUTTON_SM, BUTTON_GROUP, SEGMENT, SEGMENT_ACTIVE, INPUT as input, SELECT, POPOVER_PANEL, ICON_BUTTON, MENU_ITEM } from './controls';
import { useDialogBehavior, usePopoverBehavior } from './useDialogBehavior';
const PAGE_SIZE = 24;
const REVIEW_FIELDS: Array<[ProjectEvidenceField, string]> = [['background', '背景'], ['constraints', '约束'], ['decisions', '决策'], ['deliverables', '交付物']];
const normalizeReviewText = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

export function ProjectCenter() {
  const { projects, loading, loaded, writeOperation, scanOperation, error, notice, scanResult, reviewOpen, selectedProjectId,
    recognitionMode, scanPlan, scanProgress, cancelling, setRecognitionMode, prepare, cancelScan,
    storageInfo, refreshStorage, reload, restoreBackup, resumeReview, pendingProgress, retryProgress,
    load, scan, clearError, selectProject, showChat } = useProjectsStore();
  const currentCwd = useStore(state => state.conversations.find(conversation => conversation.id === state.activeConversationId)?.cwd || state.cwd);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const [filter, setFilter] = useState<ProjectStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [source, setSource] = useState<ProjectSource | null>(null);
  const sourceDialog = useRef<HTMLElement>(null);
  useDialogBehavior({ open: !!source, dialogRef: sourceDialog, onRequestClose: () => setSource(null) });
  const [localError, setLocalError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lifecycle, setLifecycle] = useState<'active' | 'archived' | 'deleted'>('active');
  const [creating, setCreating] = useState(false);
  const [recognitionOpen, setRecognitionOpen] = useState(false);
  const recognitionDialog = useRef<HTMLElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  usePopoverBehavior(centerRef);
  useDialogBehavior({ open: recognitionOpen, dialogRef: recognitionDialog, onRequestClose: () => setRecognitionOpen(false), initialFocusSelector: '[aria-label="识别范围"]' });
  const [scopeMode, setScopeMode] = useState<'all' | 'cwd' | '7d' | '30d'>('all');
  const [sortBy, setSortBy] = useState<'updated' | 'created' | 'name' | 'attention'>('updated');
  const [tagFilter, setTagFilter] = useState('');
  const [onlyAttention, setOnlyAttention] = useState(false);
  useEffect(() => {
    if (!scanOperation) { setElapsed(0); return; }
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [scanOperation]);
  useEffect(() => { if (!useProjectsStore.getState().loaded) void load(); void refreshStorage(); }, [load, refreshStorage]);
  useEffect(() => { setPage(0); }, [filter, search]);

  const deferredSearch = useDeferredValue(search);
  const scopedProjects = useMemo(() => projects.filter(project => lifecycle === 'deleted' ? !!project.deletedAt
    : lifecycle === 'archived' ? !!project.archivedAt && !project.deletedAt : !project.archivedAt && !project.deletedAt), [projects, lifecycle]);
  const counts = useMemo(() => {
    const result = { all: scopedProjects.length, not_started: 0, in_progress: 0, completed: 0 };
    scopedProjects.forEach(project => result[projectSummary(project).status]++);
    return result;
  }, [scopedProjects]);
  const activeCount = projects.filter(project => !project.archivedAt && !project.deletedAt).length;
  const archivedCount = useMemo(() => projects.filter(project => project.archivedAt && !project.deletedAt).length, [projects]);
  const deletedCount = useMemo(() => projects.filter(project => project.deletedAt).length, [projects]);
  const healthMap = useMemo(() => new Map(scopedProjects.map(project => [project.id, projectHealth(project, now)])), [scopedProjects, now]);
  const attentionCount = useMemo(() => scopedProjects.filter(project => healthMap.get(project.id)?.needsAttention).length, [scopedProjects, healthMap]);
  const allTags = useMemo(() => [...new Set(scopedProjects.flatMap(project => project.tags || []))].sort(), [scopedProjects]);
  const searchCache = useRef(new Map<string, { project: ManagedProject; text: string }>());
  const searchIndex = useMemo(() => {
    const index = new Map<string, string>();
    const ids = new Set(projects.map(project => project.id));
    for (const id of searchCache.current.keys()) if (!ids.has(id)) searchCache.current.delete(id);
    for (const project of projects) {
      const cached = searchCache.current.get(project.id);
      const text = cached?.project === project ? cached.text : [
        project.name, project.goal, project.description, project.background, project.constraints, project.decisions, project.deliverables, project.workingDirectory,
        ...(project.tags || []), project.retrospective?.goal, project.retrospective?.outcome, project.retrospective?.wentWell,
        project.retrospective?.wentPoorly, project.retrospective?.surprises, project.retrospective?.nextSteps,
        ...project.tasks.map(task => `${task.name} ${task.description} ${task.records.join(' ')}`),
        ...project.sources.map(source => `${source.title} ${source.excerpt} ${source.path || ''}`),
        ...project.files.map(file => `${file.path} ${file.purpose}`),
        ...project.uncertainties,
      ].filter(Boolean).join('\n').toLowerCase();
      if (cached?.project !== project) searchCache.current.set(project.id, { project, text });
      index.set(project.id, text);
    }
    return index;
  }, [projects]);
  const filtered = useMemo(() => scopedProjects.filter(project => {
    if (filter !== 'all' && projectSummary(project).status !== filter) return false;
    if (onlyAttention && !healthMap.get(project.id)?.needsAttention) return false;
    if (tagFilter && !(project.tags || []).includes(tagFilter)) return false;
    return (searchIndex.get(project.id) || '').includes(deferredSearch.toLowerCase());
  }).sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return Number(!!b.pinned) - Number(!!a.pinned);
    if (sortBy === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (sortBy === 'created') return b.createdAt - a.createdAt;
    if (sortBy === 'attention') return (healthMap.get(b.id)?.issues.length || 0) - (healthMap.get(a.id)?.issues.length || 0) || b.updatedAt - a.updatedAt;
    return b.updatedAt - a.updatedAt;
  }), [scopedProjects, filter, deferredSearch, onlyAttention, tagFilter, sortBy, healthMap, searchIndex]);
  const safePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const selected = projects.find(project => project.id === selectedProjectId);
  const busy = loading || !!writeOperation;
  const scopeLocked = busy || !!scanOperation || !!scanResult || !!scanPlan;
  // 禁用态必须说明原因和恢复路径，而不是让按钮“随机失效”。
  const lockReason = busy ? '正在保存或加载，请稍候'
    : scanOperation ? '识别进行中，完成或取消后可操作'
      : scanResult ? '请先完成或取消当前识别审核'
        : scanPlan ? '请先确认或取消识别范围' : undefined;
  const changeLifecycle = async (next: typeof lifecycle) => {
    if (!(await selectProject(null))) return;
    setLifecycle(next); setFilter('all'); setSearch(''); setTagFilter(''); setOnlyAttention(false); setPage(0);
  };

  const recognize = () => {
    const state = useStore.getState();
    if (scopeLocked) return;
    if (scopeMode === 'cwd' && !currentCwd?.trim()) { setLocalError('当前工作目录为空，请选择具体目录或切换识别范围；不会改为全量识别。'); return; }
    setLocalError(null);
    setRecognitionOpen(false);
    const scope = scopeMode === 'cwd' ? { cwd: currentCwd }
      : scopeMode === '7d' ? { sinceDays: 7 }
      : scopeMode === '30d' ? { sinceDays: 30 } : undefined;
    if (recognitionMode === 'llm') void prepare(state.sessions, state.conversations, scope);
    else void scan(state.sessions, state.conversations, { mode: 'rules', ...(scope ? { scope } : {}) });
  };
  const reveal = async (path: string) => {
    setLocalError(null);
    try {
      const result = await (window as unknown as { api: { projects: { reveal: (path: string) => Promise<{ ok: boolean; error?: string }> } } }).api.projects.reveal(path);
      if (!result.ok) setLocalError(result.error || '文件不可访问。');
    } catch (failure) { setLocalError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const openSource = async (item: ProjectSource) => {
    setLocalError(null);
    const state = useStore.getState();
    const session = state.sessions.find(session => session.sessionId === item.sessionId);
    const conversation = state.conversations.find(conversation => conversation.sessionId === item.sessionId || `gui:${conversation.id}` === item.sessionId);
    if (session || conversation) {
      if (!(await showChat())) return;
      if (conversation) state.setActiveConversation(conversation.id);
      else state.openSessionTab(item.sessionId);
      // CLI UUIDs are different from GUI message ids; never highlight a non-existent message.
      const active = useStore.getState().conversations.find(conversation => conversation.id === useStore.getState().activeConversationId);
      if (item.messageId && active?.messages.some(message => message.id === item.messageId)) state.setHighlightMessage(item.messageId);
    } else {
      // CLI-only sessions are not fabricated into GUI conversations: inspect retained source evidence.
      setSource(item);
    }
  };

  return (
    <main ref={centerRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-deepest/80" aria-label="项目管理中心">
      {/* 列表级工具栏只在项目列表出现；详情自带一层页头，避免双层工具栏挤压首屏 */}
      {!selected && <header className="relative z-20 flex shrink-0 items-center gap-3 border-b border-border/60 bg-bg-deep/70 px-4 py-3 xl:px-6">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent-cyan/30 bg-accent-cyan/10"><FolderKanban className="h-4 w-4 text-accent-cyan" /></div>
          <div className="min-w-0"><h1 className="text-base font-semibold text-text-primary">项目管理中心</h1><p className="hidden text-2xs text-text-secondary sm:block">审核后创建 · 任务与工作流同步</p></div>
        </div>
        <div role="group" aria-label="项目主操作" className="ml-auto flex shrink-0 items-center gap-2">
          {scanResult && !reviewOpen && <button className={BUTTON_SM} disabled={busy} onClick={resumeReview}>继续审核 {scanResult.candidates.length}</button>}
          <button className={button} title={lockReason || '选择范围和整理方式，再从历史创建项目'} onClick={() => setRecognitionOpen(true)} disabled={scopeLocked || !loaded}><ScanSearch className="h-4 w-4" />识别项目</button>
          <button className={BUTTON_PRIMARY} title={lockReason} onClick={() => { if (useProjectsStore.getState().dirty) { setLocalError('请先保存或取消当前编辑，再新建项目。'); return; } setCreating(true); }} disabled={scopeLocked || !loaded}><FolderPlus className="h-4 w-4" />新建项目</button>
          <details data-popover className="relative text-xs" onToggle={event => { if (event.currentTarget.open) void refreshStorage(); }}>
            <summary aria-label="数据管理" title="项目数据管理" className={`${ICON_BUTTON} list-none cursor-pointer [&::-webkit-details-marker]:hidden`}><Database className="h-4 w-4" /></summary>
            <div className={`${POPOVER_PANEL} absolute right-0 top-full mt-2 w-72 space-y-3 p-3 text-text-secondary`}>
              {storageInfo ? <><p>容量：{(storageInfo.bytes / 1048576).toFixed(2)} / {(storageInfo.maxBytes / 1048576).toFixed(2)} MB</p><p>项目：{storageInfo.projects} / {storageInfo.maxProjects} · 回收站 {storageInfo.deletedProjects}</p><p>备份：{storageInfo.backupAvailable ? '可恢复' : '暂无可用备份'}</p>{storageInfo.loadError && <p className="text-accent-red break-words">主文件加载失败；项目数量暂不可用。可显式恢复有效备份。</p>}{(storageInfo.bytes >= storageInfo.maxBytes * 0.85 || storageInfo.projects >= storageInfo.maxProjects * 0.85) && <p role="alert" className="text-accent-yellow">容量或项目数量已达 85%，请检查数据；不会自动清理回收站。</p>}</> : <p>存储信息尚未获取。</p>}
              <button className={MENU_ITEM} disabled={busy || !!scanOperation} onClick={() => void refreshStorage()}>刷新存储信息</button>
              <button className={MENU_ITEM} disabled={busy || !!scanOperation} onClick={() => void reload()}>从磁盘重新加载</button>
              <button className={MENU_ITEM} disabled={busy || !!scanOperation || !storageInfo?.backupAvailable} onClick={() => void restoreBackup()}>恢复备份</button>
              <p className="leading-5">重新加载与恢复会先检查未保存修改；恢复备份需明确确认，不会自动修复或覆盖文件。</p>
            </div>
          </details>
        </div>
      </header>}
      {(error || localError) && <div role="alert" className="mx-6 mt-3 px-3 py-2 rounded-lg border border-accent-red/30 bg-accent-red/10 text-xs text-accent-red flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0" /><span className="flex-1 break-words selectable-text">{[localError, error].filter(Boolean).join('；')}{scanResult && error && /草稿|持久|存储|磁盘|写入/.test(error) ? ' 审核草稿仍保留在内存中，请勿关闭应用；可继续审核并重试保存。' : ''}</span><button onClick={() => { clearError(); setLocalError(null); }} aria-label="关闭错误"><X className="w-4 h-4" /></button>
      </div>}
      {notice && <div role="status" className="mx-6 mt-3 px-3 py-2 rounded-lg border border-accent-green/20 bg-accent-green/5 text-xs text-accent-green flex gap-2"><Check className="w-4 h-4" />{notice}</div>}
      {pendingProgress > 0 && <div role="status" className="mx-6 mt-3 flex items-center gap-3 rounded-lg border border-accent-orange/30 bg-accent-orange/5 p-3 text-xs text-accent-orange">
        <span className="flex-1">{pendingProgress} 条对话进展尚未保存，当前保留在内存；关闭应用会丢弃这些记录。请重试成功后再离开。</span>
        <button className={button} disabled={busy || !!scanOperation} onClick={() => void retryProgress()}>重试保存进展</button>
      </div>}
      {scanOperation && <div role="status" className="shrink-0 mx-6 mt-3 p-3 rounded-lg border border-accent-cyan/20 bg-accent-cyan/5 flex gap-3 items-center text-xs text-text-secondary">
        <Loader2 className="w-4 h-4 animate-spin text-accent-cyan shrink-0" /><div className="flex-1 min-w-0"><p>{cancelling ? '正在取消，请等待请求结束…' : scanProgress?.message || (scanOperation === 'prepare' ? '只读准备历史范围，尚未发送给模型…' : recognitionMode === 'rules' ? '正在本地规则识别，不上传历史…' : '正在识别历史，等待模型响应…')}</p><p className="mt-1 font-mono">已等待 {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}{scanProgress && (scanProgress.phase === 'reading' || scanProgress.phase === 'finished') ? ` · 已读取 ${scanProgress.completed}/${scanProgress.total}` : scanProgress ? ` · ${recognitionMode === 'rules' ? '本地处理' : '模型处理'} ${scanProgress.completed}/${scanProgress.total}` : ''}{typeof scanProgress?.costUsd === 'number' ? ` · 已报告费用 $${scanProgress.costUsd.toFixed(4)}` : ''}</p></div>
        <button className={button} onClick={() => void cancelScan()} disabled={cancelling}>{scanOperation === 'prepare' ? '取消准备' : '取消识别'}</button>
      </div>}
      {loading ? <div className="flex-1 flex items-center justify-center gap-2 text-sm text-text-secondary"><Loader2 className="w-5 h-5 animate-spin text-accent-cyan" />恢复项目数据…</div>
        : !loaded ? <div className="flex-1 flex flex-col items-center justify-center gap-4 text-sm text-text-secondary"><p>项目数据尚未加载。请检查上方错误并重试，不会覆盖已有文件。</p><div className="flex gap-2"><button className={button} disabled={busy || !!scanOperation} onClick={() => void reload()}><RefreshCw className="w-4 h-4" />从磁盘重新加载</button><button className={button} disabled={busy || !!scanOperation || !storageInfo?.backupAvailable} onClick={() => void restoreBackup()}>恢复备份</button></div></div>
        : selected ? <ProjectDetail key={selected.id} project={selected} onBack={() => void selectProject(null)} onSource={openSource} onPreview={setPreview} onReveal={reveal} />
        : <div className="flex-1 min-h-0 overflow-y-auto p-3 xl:p-6">
          <div className="mx-auto w-full max-w-[1120px] space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className={BUTTON_GROUP} role="group" aria-label="项目生命周期">
              <button className={`${SEGMENT} ${lifecycle === 'active' ? SEGMENT_ACTIVE : ''}`} aria-pressed={lifecycle === 'active'} disabled={busy} onClick={() => void changeLifecycle('active')}><FolderKanban className="h-3.5 w-3.5" />活跃项目 {activeCount}</button>
              <button className={`${SEGMENT} ${lifecycle === 'archived' ? SEGMENT_ACTIVE : ''}`} aria-pressed={lifecycle === 'archived'} disabled={busy} onClick={() => void changeLifecycle('archived')}><Archive className="h-3.5 w-3.5" />归档 {archivedCount}</button>
              <button className={`${SEGMENT} ${lifecycle === 'deleted' ? SEGMENT_ACTIVE : ''}`} aria-pressed={lifecycle === 'deleted'} disabled={busy} onClick={() => void changeLifecycle('deleted')}><Trash2 className="h-3.5 w-3.5" />回收站 {deletedCount}</button>
            </div>
            <button className={BUTTON_GHOST} disabled={busy} onClick={() => void showChat()}><ArrowLeft className="h-3.5 w-3.5" />返回对话</button>
          </div>
          <div className="grid grid-cols-4 divide-x divide-border/40 overflow-hidden rounded-xl border border-border/50 bg-bg-light/30" role="group" aria-label="项目状态筛选">
            {(['all', 'not_started', 'in_progress', 'completed'] as const).map(status => (
              <button key={status} aria-pressed={filter === status} onClick={() => setFilter(status)} className={`min-w-0 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan ${filter === status ? 'bg-bg-lighter' : 'hover:bg-bg-light'}`}>
                <div className="truncate text-xs text-text-secondary">{status === 'all' ? `${lifecycle === 'active' ? '活跃' : lifecycle === 'archived' ? '归档' : '回收站'}全部项目` : PROJECT_LABELS[status]}</div><div className={`mt-0.5 font-mono text-lg ${filter === status ? 'text-text-primary' : 'text-text-secondary'}`}>{counts[status]}</div>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1"><Search className="pointer-events-none absolute left-3 top-2 h-4 w-4 text-text-muted" /><input aria-label="搜索项目" placeholder="搜索项目、任务或来源…" value={search} onChange={event => setSearch(event.target.value)} className={`${input} h-8 pl-9 text-xs leading-none`} /></div>
            <details data-popover className="relative">
              <summary className={`${button} list-none cursor-pointer [&::-webkit-details-marker]:hidden`}><SlidersHorizontal className="h-3.5 w-3.5" />筛选与排序{onlyAttention || tagFilter || sortBy !== 'updated' ? ' · 已启用' : ''}</summary>
              <div className={`${POPOVER_PANEL} absolute right-0 top-full mt-2 w-64 space-y-3 p-3`}>
                <label className="block text-2xs text-text-secondary">排序<select aria-label="项目排序" value={sortBy} onChange={event => setSortBy(event.target.value as typeof sortBy)} className={`${SELECT} mt-1 w-full`}><option value="updated">最近更新</option><option value="created">创建时间</option><option value="name">名称</option><option value="attention">待整理优先</option></select></label>
                <label className="block text-2xs text-text-secondary">标签<select aria-label="标签筛选" value={tagFilter} onChange={event => setTagFilter(event.target.value)} className={`${SELECT} mt-1 w-full`}><option value="">全部标签</option>{allTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select></label>
                <button className={`${button} w-full justify-center ${onlyAttention ? 'border-accent-orange/40 text-accent-orange bg-accent-orange/5' : ''}`} aria-pressed={onlyAttention} onClick={() => setOnlyAttention(value => !value)}>仅看待整理 {attentionCount}</button>
              </div>
            </details>
            {(filter !== 'all' || search || tagFilter || onlyAttention) && <button type="button" className={BUTTON_GHOST} onClick={() => { setFilter('all'); setSearch(''); setTagFilter(''); setOnlyAttention(false); setPage(0); }}>清除筛选</button>}
            <span className="w-full text-xs text-text-muted">当前视图 {counts.all} 个 · 筛选后 {filtered.length} 个项目</span>
          </div>
          {filtered.length === 0 ? <section className="py-16 px-6 rounded-xl border border-dashed border-border text-center">
            <FolderKanban className="w-10 h-10 text-accent-cyan/60 mx-auto mb-4" /><h2 className="text-base text-text-primary mb-2">{projects.length ? '没有匹配的项目' : '把零散工作整理成可追踪的项目'}</h2><p className="text-sm text-text-secondary max-w-xl mx-auto leading-6">{projects.length ? '调整状态筛选或搜索关键词。' : '新建项目记录目标与任务，或从本地历史整理已有工作。识别结果只作为候选，需你审核后创建。'}</p>
            {!projects.length && <button className={`${BUTTON_GHOST} mt-4`} onClick={() => setRecognitionOpen(true)} disabled={scopeLocked}><ScanSearch className="h-4 w-4" />从历史整理项目</button>}
          </section> : <div className="space-y-2.5">
            {filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).map(project => {
              const summary = projectSummary(project);
              const health = healthMap.get(project.id) || projectHealth(project, now);
              const work = projectWorkState(project);
              const lifecycle = project.deletedAt ? '已删除' : project.archivedAt ? '已归档' : null;
              return <button key={project.id} disabled={busy} onClick={() => void selectProject(project.id)} aria-labelledby={`project-name-${project.id}`} className="w-full text-left glass-panel glass-panel-hover rounded-xl p-4 transition-colors group">
                <span id={`project-name-${project.id}`} className="sr-only">{project.name}</span>
                <div className="flex items-start justify-between gap-4"><h2 className="text-base font-medium text-text-primary group-hover:text-accent-cyan break-words">{project.pinned && <Pin className="inline w-3.5 h-3.5 mr-1 text-accent-cyan" aria-label="置顶" />}{project.name}</h2><span className={`shrink-0 text-xs rounded-md px-2 py-1 ${lifecycle === '已删除' ? 'bg-accent-red/10 text-accent-red' : lifecycle === '已归档' ? 'bg-bg-lighter text-text-secondary' : PROJECT_STATUS_STYLE[summary.status]}`}>{lifecycle || PROJECT_LABELS[summary.status]}</span></div>
                <p className="text-sm text-text-secondary mt-2 line-clamp-2 leading-6">{project.description || project.goal}</p>
                {!!project.tags?.length && <div className="flex flex-wrap gap-1.5 mt-2">{project.tags.map(tag => <span key={tag} className="rounded bg-bg-lighter px-1.5 py-0.5 text-2xs text-text-secondary">{tag}</span>)}</div>}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary"><span title={work.note} className="min-w-0 truncate">{work.label}{work.nextTask ? ` · ${work.nextTask.name}` : ''}</span><ArrowRight className="h-4 w-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-1" /></div>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="flex h-1.5 min-w-[100px] flex-1 overflow-hidden rounded-full bg-bg-lighter" role="progressbar" aria-label={`${project.name}必要任务进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.requiredTotal ? summary.progress : undefined} aria-valuetext={progressLabel(summary)}>
                    <div className="h-full bg-accent-green" style={{ width: `${summary.requiredTotal ? summary.requiredCompleted / summary.requiredTotal * 100 : 0}%` }} />
                    <div className="h-full bg-accent-blue" style={{ width: `${summary.requiredTotal ? project.tasks.filter(task => !task.optional && task.status === 'in_progress').length / summary.requiredTotal * 100 : 0}%` }} />
                  </div>
                  <span className="text-xs tabular-nums text-text-secondary">{progressLabel(summary)}</span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-2xs text-text-secondary"><span>{project.sources.length} 条来源 · {project.files.length} 个文件{summary.allTasksComplete && !project.goalConfirmed ? ' · 等待目标验收' : ''}{health.needsAttention ? ` · 待整理 ${health.issues.length}` : ''}</span><span>更新于 {new Date(project.updatedAt).toLocaleDateString()}</span></div>
              </button>;
            })}
            <Pagination page={safePage} total={filtered.length} size={PAGE_SIZE} onChange={setPage} />
          </div>}
          <div className="flex flex-wrap items-center gap-4 text-xs text-text-muted" aria-label="项目进度图例"><span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-accent-green" />已完成必要任务</span><span className="flex items-center gap-1.5"><CircleDot className="h-3.5 w-3.5 text-accent-blue" />进行中</span><span>任务进度与项目验收分开记录</span></div>
          </div>
        </div>}
      {recognitionOpen && <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={event => { if (event.target === event.currentTarget) setRecognitionOpen(false); }}>
        <section ref={recognitionDialog} role="dialog" aria-modal="true" aria-label="从历史识别项目" className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border-light bg-bg-deep shadow-2xl">
          <header className="flex shrink-0 items-center justify-between border-b border-border/50 px-5 py-3"><h2 className="flex items-center gap-2 text-base font-semibold text-text-primary"><ScanSearch className="h-4 w-4 text-accent-cyan" />从历史识别项目</h2><button className={ICON_BUTTON} aria-label="关闭识别设置" onClick={() => setRecognitionOpen(false)}><X className="h-4 w-4" /></button></header>
          <div className="space-y-4 overflow-y-auto p-5">
            <p className="text-sm leading-6 text-text-secondary">将零散对话整理为项目候选。只有审核通过后才创建或关联，不改变当前工作目录。</p>
            <label className="block text-xs text-text-secondary">历史范围<select aria-label="识别范围" value={scopeMode} onChange={event => setScopeMode(event.target.value as typeof scopeMode)} disabled={scopeLocked} className={`${SELECT} mt-2 w-full`}><option value="all">全部历史</option><option value="cwd" disabled={!currentCwd?.trim()}>仅当前目录</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option></select></label>
            <label className="block text-xs text-text-secondary">整理方式<select aria-label="项目识别方式" value={recognitionMode} onChange={event => setRecognitionMode(event.target.value as RecognitionMode)} disabled={scopeLocked} className={`${SELECT} mt-2 w-full`}><option value="llm">LLM 语义识别</option><option value="rules">本地规则（不上传）</option></select></label>
            <p className="rounded-lg border border-border/50 bg-bg-light/30 p-3 text-xs leading-5 text-text-secondary">{recognitionMode === 'llm' ? '下一步仅准备本地历史快照，再单独确认发送范围与总预算；未经同意不发送模型。模型推断仍需核对。' : '本地规则处理，不上传历史，不产生模型费用。缺失的信息和未知依赖保持待确认。'}</p>
            <p className="break-all text-xs text-text-muted">当前工作目录：{currentCwd || '未选择'}</p>
            {lockReason && <p role="status" className="text-xs text-accent-yellow">{lockReason}</p>}
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-border/50 px-5 py-3"><button className={BUTTON_GHOST} onClick={() => setRecognitionOpen(false)}>取消</button><button className={BUTTON_PRIMARY} disabled={scopeLocked || !loaded} onClick={recognize}>{recognitionMode === 'llm' ? '准备历史范围' : '开始本地识别'}<ArrowRight className="h-4 w-4" /></button></footer>
        </section>
      </div>}
      {scanPlan && <LLMConsent />}
      {scanResult && reviewOpen && <CandidateReview onSource={openSource} />}
      {creating && <CreateProjectDialog onClose={() => setCreating(false)} />}
      {preview && <FilePreview path={preview} onClose={() => setPreview(null)} />}
      {source && <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6" onClick={() => setSource(null)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSource(null); } }}><section ref={sourceDialog} role="dialog" aria-modal="true" aria-label="历史来源详情" className="glass-panel rounded-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto p-5" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between mb-4"><h2 className="text-base text-text-primary">历史来源详情</h2><button autoFocus aria-label="关闭来源详情" onClick={() => setSource(null)}><X className="w-5 h-5 text-text-secondary" /></button></div>
        <p className="text-sm text-text-secondary mb-3">{source.title || source.sessionId}</p><pre className="whitespace-pre-wrap break-words text-xs text-text-primary selectable-text bg-bg-deepest p-4 rounded-lg leading-6">{source.excerpt || '该消息没有文本摘要。'}</pre>
        <p className="text-xs text-text-secondary mt-4">此处展示保存的真实来源摘录（最多 1000 字），不伪造可恢复的对话；若记录文件仍存在，可查看完整内容。</p>
        {localError && <p role="alert" className="text-xs text-accent-red mt-3 break-words">{localError}</p>}
        {source.path && <div className="mt-3"><p className="font-mono text-xs text-text-secondary break-all selectable-text">{source.path}</p><div className="flex gap-2 mt-2"><button className={button} onClick={() => { setPreview(source.path!); setSource(null); }}>预览原始记录</button><button className={button} onClick={() => void reveal(source.path!)}>定位记录文件</button></div></div>}
      </section></div>}
    </main>
  );
}

function LLMConsent() {
  const { scanPlan, writeOperation, scanOperation, loading, error, scan, discardPlan } = useProjectsStore();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const configuredModel = useStore(state => state.model);
  const configuredBudget = useStore(state => state.maxBudgetUsd);
  const [model, setModel] = useState(configuredModel);
  const [budget, setBudget] = useState(String(configuredBudget > 0 ? Math.min(configuredBudget, 100) : 2));
  const [consent, setConsent] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  useDialogBehavior({ open: !!scanPlan, dialogRef: dialog, onRequestClose: discardPlan });
  if (!scanPlan) return null;
  const amount = Number(budget);
  const validBudget = Number.isFinite(amount) && amount > 0 && amount <= 100;
  const busy = loading || !!writeOperation || !!scanOperation;
  const expired = now >= scanPlan.expiresAt;
  return <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="llm-consent-title" className="flex flex-col w-full max-w-2xl max-h-[90vh] rounded-xl bg-bg-deep border border-border-light overflow-hidden shadow-2xl">
      <header className="flex items-start justify-between gap-4 p-5 border-b border-border"><div><h2 id="llm-consent-title" className="text-lg text-text-primary">确认 LLM 识别范围与费用</h2><p className="text-xs text-text-secondary mt-2">本次仅准备了本地快照，尚未发送模型。</p></div><button className={button} aria-label="取消模型发送" disabled={busy} onClick={discardPlan}><X className="w-4 h-4" /></button></header>
      <div className="overflow-y-auto p-5 space-y-4">
        {error && <p role="alert" className="text-xs text-accent-red break-words">{error}</p>}
        <div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-bg-light p-3"><span className="text-text-secondary text-xs">会话 / 摘录段</span><p className="font-mono text-accent-cyan mt-1">{scanPlan.sessions} / {scanPlan.messages}</p></div><div className="rounded-lg bg-bg-light p-3"><span className="text-text-secondary text-xs">数据字符 / 最多调用</span><p className="font-mono text-accent-cyan mt-1">{scanPlan.inputChars.toLocaleString()} / {scanPlan.maxCalls}</p></div></div>
        <section className="rounded-lg border border-border p-3 text-xs text-text-secondary space-y-2">
          <p className="break-all selectable-text">快照范围：{scanPlan.scope?.cwd ? `仅目录 ${scanPlan.scope.cwd}` : '全部目录'}{scanPlan.scope?.sinceDays ? ` · 最近 ${scanPlan.scope.sinceDays} 天` : ' · 全部时间'}</p>
          <p>发送的已有项目简表（仅当前范围内活跃项目，数量受限）：{scanPlan.existingProjects?.length || 0} 个</p>
          <div className="max-h-32 overflow-y-auto space-y-1">{scanPlan.existingProjects?.map(project => <p key={project.id} className="break-all selectable-text">{project.name} · {project.cwd || '目录未知'}</p>)}</div>
        </section>
        {expired && <p role="alert" className="text-xs text-accent-orange">快照已过期，不能继续发送。请取消此快照并重新准备历史；上方错误不会因过期被隐藏。</p>}
        <p className="text-xs text-text-secondary leading-6">将发送用户与助手对话摘录、工作目录、时间、任务与文件工具的受限摘要，以及已有项目简述。不会发送思考块、图片二进制、完整工具输出或文件正文；但对话文本本身可能包含敏感信息，请确认有权发送。</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label className="text-xs text-text-secondary">模型（沿用当前配置）<input aria-label="项目识别模型" className={`${input} mt-1`} value={model} maxLength={200} disabled={busy} onChange={event => setModel(event.target.value)} placeholder="留空使用 Claude Code 默认模型" /></label><label className="text-xs text-text-secondary">本次总预算上限（美元）<input aria-label="项目识别总预算" type="number" className={`${input} mt-1`} value={budget} min="0.01" max="100" step="0.01" disabled={busy} onChange={event => setBudget(event.target.value)} /></label></div>
        <p className="text-xs text-accent-orange leading-6">通过 Claude Code 已配置的认证与模型服务调用，不是纯本地计算。预算为本次多批调用共享上限，不是费用报价；取消、超时或调用失败也可能已经产生费用。单次模型调用最长等待 5 分钟，失败不会悄悄改用规则结果。</p>
        <details className="rounded-lg border border-border p-3 text-xs text-text-secondary"><summary className="cursor-pointer">查看发送摘录样例（{scanPlan.sampleSources.length} 条）</summary><div className="mt-3 space-y-3 selectable-text">{scanPlan.sampleSources.map(source => <div className="border-t border-border pt-2" key={source.id}><p className="text-accent-cyan">{source.title || source.sessionId}</p><p className="font-mono text-2xs break-all mt-1">{source.cwd || '目录未知'}</p><pre className="whitespace-pre-wrap break-words text-xs leading-5 mt-2">{source.excerpt || '工具摘要，无正文'}</pre></div>)}</div></details>
        <details className="text-xs text-text-secondary"><summary className="cursor-pointer">覆盖范围与截取说明</summary><div className="space-y-2 mt-2">{scanPlan.coverage.warnings.map((warning, index) => <p className="leading-5 break-words" key={index}>{warning}</p>)}</div></details>
        {!scanPlan.messages && <p className="text-xs text-accent-orange">没有可分析的历史摘录。请取消并检查数据源权限。</p>}
        <label className="flex items-start gap-2 text-xs text-text-primary leading-6"><input className="accent-accent-cyan mt-1.5" type="checkbox" checked={consent} disabled={busy || expired} onChange={event => setConsent(event.target.checked)} />我确认可以将上述历史摘录发送给当前模型服务，并同意本次调用可能产生费用。</label>
      </div>
      <footer className="border-t border-border p-4 flex items-center justify-between gap-3"><span className="text-xs text-text-secondary">快照有效期至 {new Date(scanPlan.expiresAt).toLocaleTimeString()}</span><div className="flex gap-2"><button className={button} disabled={busy} onClick={discardPlan}>取消，不发送</button><button className={`${button} text-accent-cyan border-accent-cyan/40 bg-accent-cyan/10`} disabled={busy || expired || !consent || !validBudget || !scanPlan.messages} onClick={() => { if (Date.now() >= scanPlan.expiresAt) { setNow(Date.now()); return; } void scan([], [], { mode: 'llm', planId: scanPlan.planId, consent: true, model: model.trim(), maxBudgetUsd: amount, scope: scanPlan.scope }); }}>同意并开始 LLM 识别</button></div></footer>
    </section>
  </div>;
}

function CandidateReview({ onSource }: { onSource: (source: ProjectSource) => void }) {
  const { scanResult, reviews, writeOperation, loading, projects, error, clearError, review, associate, pauseReview, cancelReview, confirm } = useProjectsStore();
  const dialog = useRef<HTMLElement>(null);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useDialogBehavior({ open: !!scanResult, dialogRef: dialog, onRequestClose: pauseReview });
  useEffect(() => { setPage(0); setDetail(null); setEditing(null); }, [scanResult?.scanId]);
  if (!scanResult) return null;
  const busy = loading || !!writeOperation;
  const invalidSelected = scanResult.candidates.some(candidate => {
    const current = reviews[candidate.id];
    if (!current?.selected) return false;
    const linked = projects.find(project => project.id === current.existingProjectId);
    return !current.name.trim() || !current.goal.trim()
      || (!!linked && !!(linked.archivedAt || linked.deletedAt) && !current.restoreExisting)
      || REVIEW_FIELDS.some(([field]) => {
        const value = current.fields?.[field] ?? (linked?.[field] || candidate[field]);
        const kind = candidate.fieldEvidence?.[field]?.kind || candidate.fieldProvenance?.[field] || (scanResult.analysis?.mode === 'llm' ? 'unknown' : 'quoted');
        const novel = value !== (linked?.[field] || candidate[field]) && value !== candidate[field];
        return !!value.trim() && (novel || kind === 'model' || kind === 'unknown') && !current.reviewedFields?.includes(field);
      });
  });
  const selected = Object.values(reviews).filter(review => review.selected).length;
  const pageCandidates = scanResult.candidates.slice(page * 10, (page + 1) * 10);
  const pageIds = pageCandidates.map(candidate => candidate.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every(id => reviews[id]?.selected);
  return <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="review-title" className="flex flex-col w-full max-w-4xl max-h-[90vh] rounded-xl bg-bg-deep border border-border-light shadow-2xl overflow-hidden">
      <header className="flex items-center justify-between gap-4 px-5 py-4 border-b border-border">
        <div className="min-w-0">
          <h2 id="review-title" className="text-lg text-text-primary">审核识别结果</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span>{scanResult.candidates.length} 个候选</span>
            {scanResult.analysis?.mode === 'llm'
              ? <span className="inline-flex items-center rounded-md px-1.5 py-0.5 bg-accent-cyan/10 text-accent-cyan">LLM 识别 · {scanResult.analysis.model || '默认模型'} · ${Number(scanResult.analysis.costUsd || 0).toFixed(4)}</span>
              : <span className="inline-flex items-center rounded-md px-1.5 py-0.5 bg-bg-lighter/70 text-text-secondary">本地规则 · 未上传</span>}
          </div>
        </div>
        <button className={button} onClick={pauseReview} disabled={busy} aria-label="稍后审核"><X className="w-4 h-4" /></button>
      </header>
      {error && <div role="alert" className="mx-5 mt-3 p-3 rounded-lg border border-accent-red/30 bg-accent-red/10 text-xs text-accent-red flex gap-2"><span className="flex-1 break-words">{error}{/草稿|持久|存储|磁盘|写入/.test(error) ? ' 审核草稿仍保留在内存中，请勿关闭应用；可稍后审核或重试保存。' : ''}</span><button aria-label="关闭审核错误" onClick={clearError}><X className="w-4 h-4" /></button></div>}
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
        <p className="text-xs text-text-dim leading-5">勾选要保存的项目；点击编辑修改名称与目标，展开详情核对全部字段、来源及任务。关闭或稍后审核会保留草稿；只有明确放弃才会丢弃结果。</p>
        {!scanResult.candidates.length && <div className="py-12 text-center text-sm text-text-secondary leading-6">未发现值得长期跟踪的项目。<br />短问答与小改动不会成为项目；数据范围与限制见底部说明。</div>}
        {scanResult.candidates.slice(page * 10, (page + 1) * 10).map(candidate => {
          const current = reviews[candidate.id];
          if (!current) return null;
          const sessions = new Set(candidate.sources.map(source => source.sessionId)).size;
          const dependencies = candidate.tasks.reduce((total, task) => total + task.dependsOn.length, 0);
          const linked = current.existingProjectId ? projects.find(project => project.id === current.existingProjectId) : undefined;
          const taskNameCounts = new Map<string, number>();
          for (const task of linked?.tasks || []) {
            const key = normalizeReviewText(task.name);
            taskNameCounts.set(key, (taskNameCounts.get(key) || 0) + 1);
          }
          const candidateNameCounts = new Map<string, number>();
          for (const task of candidate.tasks) {
            const key = normalizeReviewText(task.name);
            candidateNameCounts.set(key, (candidateNameCounts.get(key) || 0) + 1);
          }
          const matchedTasks = candidate.tasks.filter(task => linked?.tasks.some(existing => existing.id === task.id)
            || (taskNameCounts.get(normalizeReviewText(task.name)) === 1 && candidateNameCounts.get(normalizeReviewText(task.name)) === 1));
          const newTaskEstimate = candidate.tasks.length - matchedTasks.length;
          const sourceEstimate = candidate.sources.filter(source => !linked?.sources.some(existing => existing.id === source.id)).length;
          const potentialConflicts = matchedTasks.some(task => linked?.tasks.some(existing => (existing.id === task.id || normalizeReviewText(existing.name) === normalizeReviewText(task.name))
            && (existing.status !== task.status || existing.description !== task.description || !!existing.editedFields?.length)));
          const scopeKey = (item: ManagedProject) => normalizeReviewText(item.workingDirectory || [...new Set(item.sources.map(source => source.cwd).filter(Boolean))].sort().join('\n'));
          const duplicateCandidates = scanResult.candidates.filter(other => other.id !== candidate.id && reviews[other.id]?.selected
            && normalizeReviewText(reviews[other.id].goal) === normalizeReviewText(current.goal) && scopeKey(other) === scopeKey(candidate));
          const chip = 'inline-flex items-center rounded-md px-1.5 py-0.5 text-2xs leading-4';
          return <article key={candidate.id} className={`rounded-xl border overflow-hidden transition-colors ${current.selected ? 'border-accent-cyan/40 bg-accent-cyan/[0.04]' : 'border-border bg-bg-light/30'}`}>
            <div className="p-4 flex items-start gap-3">
              <input type="checkbox" className="mt-1 accent-accent-cyan shrink-0" checked={current.selected} disabled={busy} onChange={event => review(candidate.id, { selected: event.target.checked })} aria-label={`选择项目 ${current.name}`} />
              <div className="flex-1 min-w-0">
                {editing === candidate.id ? (
                  <div className="space-y-2">
                    <input aria-label={`项目名称 ${current.name}`} className={input} value={current.name} maxLength={500} disabled={busy} onChange={event => review(candidate.id, { name: event.target.value })} placeholder="项目名称" />
                    <textarea aria-label={`项目目标 ${current.name}`} className={`${input} resize-y`} value={current.goal} rows={2} maxLength={20000} disabled={busy} onChange={event => review(candidate.id, { goal: event.target.value })} placeholder="目标（必填）" />
                    <textarea aria-label={`项目简述 ${current.name}`} className={`${input} resize-y`} value={current.description} rows={2} maxLength={20000} disabled={busy} onChange={event => review(candidate.id, { description: event.target.value })} placeholder="简述（可选，确认后可再补）" />
                    <button className={button} disabled={busy} onClick={() => setEditing(null)}>完成编辑</button>
                  </div>
                ) : (
                  <div className="cursor-pointer group" onClick={() => { if (!busy) review(candidate.id, { selected: !current.selected }); }}>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-medium text-text-primary break-words leading-6 group-hover:text-accent-cyan transition-colors">{current.name}</h3>
                      <button className="text-text-dim hover:text-accent-cyan shrink-0" aria-label={`编辑 ${current.name}`} disabled={busy} onClick={event => { event.stopPropagation(); setEditing(candidate.id); }}><Pencil className="w-3.5 h-3.5" /></button>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary leading-5 line-clamp-2 break-words">{current.goal}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <span className={`${chip} bg-bg-lighter/70 text-text-secondary`}>{candidate.tasks.length} 任务</span>
                      <span className={`${chip} bg-bg-lighter/70 text-text-secondary`}>{sessions} 会话</span>
                      {dependencies > 0 && <span className={`${chip} bg-bg-lighter/70 text-text-secondary`}>{dependencies} 依赖</span>}
                      {linked ? <span className={`${chip} bg-accent-cyan/10 text-accent-cyan`}>关联：{linked.name}</span> : <span className={`${chip} bg-bg-lighter/70 text-text-secondary`}>新项目</span>}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="px-4 pb-3 flex items-center justify-between gap-2 flex-wrap">
              <select aria-label={`创建方式 ${current.name}`} className="rounded-lg bg-bg-deepest border border-border px-2 py-1.5 text-xs text-text-secondary max-w-[220px]" value={current.existingProjectId || ''} disabled={busy} onChange={event => associate(candidate.id, event.target.value)}>
                <option value="">创建为新项目</option>
                {projects.map(project => <option key={project.id} value={project.id}>关联已有：{project.name}（{project.deletedAt ? '回收站' : project.archivedAt ? '已归档' : '活跃'}）</option>)}
              </select>
              <button className="text-xs text-text-secondary hover:text-accent-cyan transition-colors" onClick={() => setDetail(detail === candidate.id ? null : candidate.id)} aria-expanded={detail === candidate.id}>{detail === candidate.id ? '收起详情' : `详情 · ${candidate.tasks.length} 任务`}</button>
            </div>
            {!current.existingProjectId && <label className="px-4 pb-3 flex gap-2 items-start text-2xs text-accent-orange leading-5"><input className="accent-accent-orange mt-1" type="checkbox" checked={!!current.allowDuplicate} disabled={busy} onChange={event => review(candidate.id, { allowDuplicate: event.target.checked })} />另建为独立项目（与相同历史目标重复时需勾选确认）</label>}
            {linked && (linked.archivedAt || linked.deletedAt) && <label className="px-4 pb-3 flex gap-2 items-start text-2xs text-accent-orange leading-5"><input type="checkbox" className="accent-accent-orange mt-1" checked={!!current.restoreExisting} disabled={busy} onChange={event => review(candidate.id, { restoreExisting: event.target.checked })} />恢复并关联此项目（未勾选不能确认）</label>}
            {!!duplicateCandidates.length && current.goal.trim() && <p role="status" className="px-4 pb-3 text-2xs text-accent-orange leading-5">同批次相同范围中存在相同目标：{duplicateCandidates.map(other => reviews[other.id].name).join('、')}。请核对是否应关联同一项目；这是提示，最终去重由保存端检查。</p>}
            {(!current.name.trim() || !current.goal.trim()) && <p role="alert" className="px-4 pb-3 text-2xs text-accent-red">名称和目标不能为空，请编辑后再确认。</p>}
            {detail === candidate.id && <div className="border-t border-border/60 bg-bg-deepest/40 px-4 py-3 space-y-3 text-xs">
              <section className="rounded-lg border border-border p-3 space-y-2 text-text-secondary leading-5">
                <h4 className="text-text-primary font-medium">预计变更（不是精确合并结果）</h4>
                <p>{linked ? `关联「${linked.name}」，审核基准版本 ${current.expectedRevision ?? '尚未初始化，需核对'}，当前版本 ${linked.revision ?? 0}。` : '创建独立项目，不覆盖已有项目。'}</p>
                <p className="whitespace-pre-wrap break-words selectable-text">名称：{current.name}{linked && current.name !== linked.name ? `（原：${linked.name}）` : ''}</p>
                <p className="whitespace-pre-wrap break-words selectable-text">目标：{current.goal}{linked && current.goal !== linked.goal ? `\n原目标：${linked.goal}` : ''}</p>
                <p className="whitespace-pre-wrap break-words selectable-text">简述：{current.description || '未填写'}{linked && current.description !== linked.description ? `\n原简述：${linked.description || '未填写'}` : ''}</p>
                <p>预计新增来源 {sourceEstimate} 条；任务待合并，预计新增 {newTaskEstimate} 个、可能匹配 {matchedTasks.length} 个（按任务标识及唯一名称初步比较）。最终数量与状态需在保存后核对。</p>
                {linked && <p>保留已有用户编辑；{potentialConflicts ? '检测到任务内容、状态或编辑标记的潜在冲突，需逐项核对。' : '未发现明显任务冲突，但依赖与合并结果仍需核对。'}</p>}
                {linked?.goalConfirmed && (candidate.tasks.some(task => !task.optional && task.status !== 'cancelled' && task.status !== 'completed') || current.goal !== linked.goal || (current.fields?.deliverables ?? candidate.deliverables) !== linked.deliverables) && <p className="text-accent-orange">新必要任务、目标或交付物变更可能撤销已有目标验收，请核对最终结果。</p>}
                <p className="break-all selectable-text">工作目录：已有 {linked?.workingDirectory || '未设置'}；候选 {candidate.workingDirectory || '未设置'}；历史目录 {Array.from(new Set(candidate.sources.map(source => source.cwd).filter(Boolean))).join('、') || '未知'}。候选不会改变当前对话或全局目录；合并后的项目目录需核对。</p>
                <p>会话关联：已有 {linked?.conversations?.length || 0} 条，候选 {candidate.conversations?.length || 0} 条；真实来源覆盖 {sessions} 个会话。来源不等于自动新增可运行会话链接，最终关联需核对。</p>
                {!!candidate.conversations?.length && <div className="max-h-28 overflow-y-auto">{candidate.conversations.map(link => <p key={`${link.conversationId}:${link.taskId || ''}`} className="break-all">{link.title || link.conversationId} · {link.cwd || '目录未知'}{link.taskId ? ` · 任务 ${link.taskId}` : ''}</p>)}</div>}
              </section>
              <section className="space-y-3">
                <h4 className="text-text-primary font-medium">字段与来源核对</h4>
                <p className="text-text-secondary leading-5">非空模型解释或未知字段必须逐项核对，也可清空不可靠内容；编辑文本不会自动标记为已核对。</p>
                {REVIEW_FIELDS.map(([field, label]) => {
                  const value = current.fields?.[field] ?? (linked?.[field] || candidate[field]);
                  const evidence = candidate.fieldEvidence?.[field];
                  const kind = evidence?.kind || candidate.fieldProvenance?.[field] || (scanResult.analysis?.mode === 'llm' ? 'unknown' : 'quoted');
                  const userEdited = value !== candidate[field];
                  const novel = value !== (linked?.[field] || candidate[field]) && value !== candidate[field];
                  const required = !!value.trim() && (novel || kind === 'model' || kind === 'unknown');
                  return <div key={field} className="rounded-lg border border-border p-3 space-y-2">
                    <label className="block text-text-secondary">{label}<span className="ml-2 text-2xs">原始来源：{kind === 'quoted' ? '原文引用' : kind === 'model' ? '模型解释' : kind === 'user' ? '用户填写' : '未知'}{userEdited ? ' · 当前：用户编辑或保留已有内容' : ''}</span>
                      <textarea aria-label={`项目${label} ${current.name}`} className={`${input} mt-2 resize-y`} rows={3} maxLength={20000} value={value} disabled={busy} onChange={event => review(candidate.id, { fields: { ...current.fields, [field]: event.target.value }, reviewedFields: (current.reviewedFields || []).filter(item => item !== field) })} />
                    </label>
                    {userEdited && <details className="text-text-secondary"><summary className="cursor-pointer">查看原始候选{label}（未替换为已核实事实）</summary><p className="mt-2 whitespace-pre-wrap break-words selectable-text leading-5">{candidate[field] || '原始候选为空'}</p></details>}
                    <label className="flex gap-2 items-start text-text-secondary leading-5"><input type="checkbox" className="accent-accent-cyan mt-1" checked={!!current.reviewedFields?.includes(field)} disabled={busy} onChange={event => review(candidate.id, { reviewedFields: event.target.checked ? [...new Set([...(current.reviewedFields || []), field])] : (current.reviewedFields || []).filter(item => item !== field) })} />我已核对{label}{required && !current.reviewedFields?.includes(field) ? '（非空模型或未知内容，确认前必须核对）' : ''}</label>
                    {!!evidence?.refs.length && <div className="space-y-2 max-h-48 overflow-y-auto">{evidence.refs.map((ref, index) => {
                      const item = candidate.sources.find(source => source.id === ref.sourceId) || linked?.sources.find(source => source.id === ref.sourceId);
                      return <div key={`${ref.sourceId}:${index}`} className="text-text-secondary"><blockquote className="border-l-2 border-border pl-2 whitespace-pre-wrap break-words selectable-text leading-5">{ref.quote}</blockquote>{item ? <button className={`${button} mt-1`} onClick={() => onSource(item)}>查看真实来源：{item.title || item.sessionId}</button> : <p className="mt-1 text-accent-orange">引用来源 {ref.sourceId} 不在保留的来源中，需核对；不伪造原文。</p>}</div>;
                    })}</div>}
                  </div>;
                })}
              </section>
              <section>
                <h4 className="text-text-primary font-medium mb-1">任务（{candidate.tasks.length}）</h4>
                <div className="max-h-64 overflow-y-auto">{candidate.tasks.map(task => <div key={task.id} className="py-2 border-b border-border/40"><div className="flex items-start justify-between gap-3"><span className="break-words text-text-secondary min-w-0">{task.name}</span><span className="shrink-0 text-text-dim">{TASK_LABELS[task.status]}{task.optional ? ' · 可选' : ' · 必要'}{task.dependsOn.length ? ` · ${task.dependsOn.length} 依赖` : ''}</span></div>{task.description && <p className="mt-1 text-text-secondary whitespace-pre-wrap break-words leading-5">{task.description}</p>}</div>)}</div>
              </section>
              {candidate.evidence.length > 0 && <section><h4 className="text-text-primary font-medium mb-1">识别依据（{candidate.evidence.length}）</h4>{candidate.evidence.map((evidence, index) => <p key={index} className="text-text-secondary leading-5 break-words selectable-text">{evidence}</p>)}</section>}
              {candidate.uncertainties.length > 0 && <section><h4 className="text-accent-orange/90 font-medium mb-1">待确认（{candidate.uncertainties.length}）</h4>{candidate.uncertainties.map((uncertainty, index) => <p key={index} className="text-text-secondary leading-5 break-words">{uncertainty}</p>)}</section>}
              {candidate.sources.length > 0 && <section><h4 className="text-text-primary font-medium mb-1">来源（{candidate.sources.length}）</h4><div className="flex flex-wrap gap-1.5">{candidate.sources.map(item => <button key={item.id} className={`${chip} border border-border hover:border-accent-cyan/40 text-text-secondary transition-colors`} onClick={() => onSource(item)} title={item.excerpt.slice(0, 120)}>{item.kind === 'gui' ? 'GUI' : 'Claude Code'} · {item.title || item.sessionId}</button>)}</div></section>}
            </div>}
          </article>;
        })}
        <Pagination page={page} total={scanResult.candidates.length} size={10} onChange={setPage} />
        {scanResult.coverage.warnings.length > 0 && <details className="text-xs text-text-dim"><summary className="cursor-pointer">覆盖范围与限制（{scanResult.coverage.warnings.length}）</summary><div className="mt-2 space-y-1.5 selectable-text"><p className="break-all">{scanResult.coverage.roots.join('\n')}</p>{scanResult.coverage.warnings.map((warning, index) => <p key={index} className="leading-5 break-words">{warning}</p>)}</div></details>}
      </div>
      <footer className="flex flex-wrap justify-between items-center gap-3 px-5 py-4 border-t border-border bg-bg-deepest/50"><span className="text-xs text-text-secondary">已选 {selected} 个 · 未确认不写入项目{invalidSelected ? ' · 请补全名称目标、恢复确认与字段核对' : ''}</span><div className="flex flex-wrap gap-2"><button className={button} onClick={() => pageIds.forEach(id => review(id, { selected: true }))} disabled={busy || !pageIds.length}>{allPageSelected ? '本页已全选' : '全选本页'}</button><button className={button} onClick={() => pageIds.forEach(id => review(id, { selected: false }))} disabled={busy || !pageIds.length}>取消本页</button><button className={button} onClick={pauseReview} disabled={busy}>稍后审核</button><button className={button} onClick={() => void cancelReview()} disabled={busy}>取消，不创建</button><button className={`${button} bg-accent-cyan/10 border-accent-cyan/40 text-accent-cyan`} onClick={() => void confirm()} disabled={busy || !selected || invalidSelected}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}确认创建 / 关联</button></div></footer>
    </section>
  </div>;
}

export function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const { create, writeOperation, loading, error, clearError } = useProjectsStore();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [description, setDescription] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const directoryPending = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const busy = loading || !!writeOperation || choosingDirectory;
  const chooseDirectory = async () => {
    if (busy || directoryPending.current) return;
    directoryPending.current = true; setChoosingDirectory(true); setDirectoryError(null);
    try {
      const bridge = (window as unknown as { api?: { openDirectory?: () => Promise<string | null> } }).api;
      if (!bridge?.openDirectory) throw new Error('请在更新后的桌面应用中选择目录。');
      const path = await bridge.openDirectory();
      if (path) setWorkingDirectory(path);
    } catch (failure) { setDirectoryError(`选择目录失败：${failure instanceof Error ? failure.message : String(failure)}`); }
    finally { directoryPending.current = false; setChoosingDirectory(false); }
  };
  const requestClose = async () => {
    if (!busy && await useProjectsStore.getState().confirmDiscard('关闭新建项目', ['create-project'])) onClose();
  };
  useDialogBehavior({ open: true, dialogRef: dialog, onRequestClose: requestClose, initialFocusSelector: 'input' });
  useEffect(() => {
    const setDirty = useProjectsStore.getState().setDirty;
    setDirty(!!(name.trim() || goal.trim() || description.trim() || workingDirectory.trim()), 'create-project');
    return () => setDirty(false, 'create-project');
  }, [name, goal, description, workingDirectory]);
  return <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="create-project-title" className="w-full max-w-xl rounded-xl bg-bg-deep border border-border-light shadow-2xl overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border"><div><h2 id="create-project-title" className="text-lg text-text-primary">新建项目</h2><p className="text-xs text-text-secondary mt-1">手动创建不依赖历史识别，所有字段都可之后补充。</p></div><button className={button} aria-label="关闭新建项目" onClick={requestClose} disabled={busy}><X className="w-4 h-4" /></button></header>
      <form onSubmit={event => { event.preventDefault(); if (busy) return; void create({ name, goal, description, workingDirectory: workingDirectory.trim() }).then(ok => { if (ok) { useProjectsStore.getState().setDirty(false, 'create-project'); onClose(); } }); }} className="p-5 space-y-4">
        {error && <div role="alert" className="rounded-lg border border-accent-red/30 bg-accent-red/10 p-3 text-xs text-accent-red flex gap-2"><span className="flex-1 break-words">{error}</span><button type="button" aria-label="关闭创建错误" onClick={clearError}><X className="w-4 h-4" /></button></div>}
        <label className="block text-xs text-text-secondary">项目名称<input autoFocus className={`${input} mt-1`} value={name} maxLength={500} disabled={busy} onChange={event => setName(event.target.value)} required placeholder="例如：会员体系长期改造" /></label>
        <label className="block text-xs text-text-secondary">项目目标<textarea className={`${input} mt-1 resize-y`} value={goal} rows={3} maxLength={20000} disabled={busy} onChange={event => setGoal(event.target.value)} required placeholder="用可验收的结果描述目标" /></label>
        <label className="block text-xs text-text-secondary">简述（可选）<textarea className={`${input} mt-1 resize-y`} value={description} rows={2} maxLength={20000} disabled={busy} onChange={event => setDescription(event.target.value)} placeholder="补充范围、背景或边界" /></label>
        <label className="block text-xs text-text-secondary">工作目录（可选）<div className="flex gap-2 mt-1"><input aria-label="新项目工作目录" className={input} value={workingDirectory} maxLength={4096} disabled={busy} onChange={event => setWorkingDirectory(event.target.value)} placeholder="显式填写项目目录，不默认使用当前目录" /><button type="button" className={`${button} shrink-0`} disabled={busy} onClick={() => void chooseDirectory()}>{choosingDirectory ? '选择中…' : '选择目录'}</button></div></label>
        {directoryError && <p role="alert" className="text-xs text-accent-red break-words">{directoryError}</p>}
        <p className="text-xs text-text-secondary leading-5">工作目录仅保存到此项目，不改变当前对话或全局目录。</p>
        <p className="text-xs text-text-secondary leading-5">创建后可在项目详情补充背景、约束、决策、交付物和任务；不会自动关联历史来源。</p>
        <div className="flex justify-end gap-2 border-t border-border pt-4"><button className={button} type="button" onClick={requestClose} disabled={busy}>取消</button><button className={`${button} border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan`} type="submit" disabled={busy || !name.trim() || !goal.trim()}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}创建项目</button></div>
      </form>
    </section>
  </div>;
}

function Pagination({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (page: number) => void }) {
  const pages = Math.ceil(total / size);
  if (pages <= 1) return null;
  return <nav aria-label="分页" className="flex items-center justify-center gap-3 py-2"><button className={button} onClick={() => onChange(page - 1)} disabled={page <= 0}>上一页</button><span className="text-xs font-mono text-text-secondary">{page + 1} / {pages}</span><button className={button} onClick={() => onChange(page + 1)} disabled={page + 1 >= pages}>下一页</button></nav>;
}
