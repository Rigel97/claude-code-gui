import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Archive, ArchiveRestore, CheckCircle2, CircleDot, Download, FileText, GitBranch, GitMerge, ListTodo, MessageSquare, MessageSquarePlus, MoreHorizontal, NotebookPen, Pencil, Pin, PinOff, Plus, Save, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useStore } from '../store';
import { useProjectsStore } from '../projectStore';
import { PROVENANCE_LABELS, PROJECT_LABELS, PROJECT_STATUS_STYLE, TASK_LABELS, TASK_STATUSES, isRecognitionGuidance, progressLabel, projectEditChanges, projectHealth, projectSummary, projectTimeRange, projectWorkState, unresolvedUncertainties } from '../projectModel';
import type { ManagedProject, ProjectChanges, ProjectEvidenceField, ProjectSource, ProjectTask, TaskStatus } from '../projectTypes';
import { ProjectWorkflow } from './ProjectWorkflow';
import { ProjectTaskDetail } from './ProjectTaskDetail';
import { BUTTON as button, BUTTON_PRIMARY, BUTTON_GHOST, BUTTON_SM, INPUT as input, SELECT, ICON_BUTTON, MENU_ITEM, MENU_ITEM_DANGER, MENU_LABEL, POPOVER_PANEL, PAGE_TAB, PAGE_TAB_ACTIVE, PAGE_TAB_IDLE, SEGMENT, SEGMENT_ACTIVE } from './controls';
import { useDialogBehavior, usePopoverBehavior } from './useDialogBehavior';
import { confirmAction } from './ConfirmDialog';
const tabs = [
  { id: 'background', label: '背景与文件', icon: FileText },
  { id: 'tasks', label: '任务列表', icon: ListTodo },
  { id: 'workflow', label: '工作流', icon: GitBranch },
  { id: 'sources', label: '历史来源', icon: Search },
  { id: 'audit', label: '识别审计', icon: ShieldCheck },
  { id: 'retrospective', label: '复盘', icon: NotebookPen },
] as const;
type Tab = typeof tabs[number]['id'];
type ProjectDesktopAPI = {
  openDirectory: () => Promise<string | null>;
  exportMarkdown?: (name: string, content: string) => Promise<string | null>;
  exportJson?: (name: string, content: string) => Promise<string | null>;
};
const desktopAPI = () => (window as unknown as { api?: ProjectDesktopAPI }).api;
type BackgroundDraft = Pick<ManagedProject, 'name' | 'description' | 'goal' | 'background' | 'constraints' | 'decisions' | 'deliverables'> & { tags: string; workingDirectory: string };
const backgroundDraft = (project: ManagedProject): BackgroundDraft => ({
  name: project.name, description: project.description, goal: project.goal, background: project.background,
  constraints: project.constraints, decisions: project.decisions, deliverables: project.deliverables,
  tags: (project.tags || []).join(', '), workingDirectory: project.workingDirectory || '',
});

export function ProjectDetail({ project, onBack, onSource, onPreview, onReveal }: {
  project: ManagedProject;
  onBack: () => void;
  onSource: (source: ProjectSource) => void;
  onPreview: (path: string) => void;
  onReveal: (path: string) => Promise<void>;
}) {
  const save = useProjectsStore(state => state.save);
  const archive = useProjectsStore(state => state.archive);
  const remove = useProjectsStore(state => state.remove);
  const merge = useProjectsStore(state => state.merge);
  const projects = useProjectsStore(state => state.projects);
  const writeBusy = useProjectsStore(state => !!state.writeOperation || state.loading);
  const storeError = useProjectsStore(state => state.error);
  const startConversation = useProjectsStore(state => state.startConversation);
  const showChat = useProjectsStore(state => state.showChat);
  const linkConversation = useProjectsStore(state => state.linkConversation);
  const reviewConversation = useProjectsStore(state => state.reviewConversation);
  const purge = useProjectsStore(state => state.purge);
  const conversations = useStore(state => state.conversations);
  const sessions = useStore(state => state.sessions);
  const activeConversationId = useStore(state => state.activeConversationId);
  const currentConversation = conversations.find(item => item.id === activeConversationId);
  const readonly = !!(project.archivedAt || project.deletedAt);
  const [acting, setActing] = useState(false);
  const actingRef = useRef(false);
  const busy = writeBusy || acting;
  const editBusy = busy || readonly;
  const mergeDialog = useRef<HTMLElement>(null);
  const moreMenu = useRef<HTMLDetailsElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  usePopoverBehavior(detailRef);
  const directoryPending = useRef(false);
  const links = project.conversations || [];
  const linkAvailable = (link: typeof links[number]) => conversations.some(item => item.id === link.conversationId || (!!link.sessionId && item.sessionId === link.sessionId)) || sessions.some(item => !!link.sessionId && item.sessionId === link.sessionId);
  const recentLink = [...links].sort((a, b) => (b.lastRun?.recordedAt || b.linkedAt) - (a.lastRun?.recordedAt || a.linkedAt)).find(linkAvailable);
  const historyDirectories = [...new Set(project.sources.map(source => source.cwd).filter(Boolean))];
  const [tab, setTab] = useState<Tab>('background');
  const [editing, setEditing] = useState(false);
  const busyReason = busy ? (writeBusy ? '正在保存或加载项目数据，请稍候' : '正在执行操作，请稍候') : undefined;
  const editDisabledReason = readonly ? '只读，恢复后可编辑' : busyReason ?? (editing ? '请先保存或取消当前编辑' : undefined);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState('');
  useDialogBehavior({ open: mergeOpen, dialogRef: mergeDialog, onRequestClose: () => { if (!busy) setMergeOpen(false); } });
  const [draft, setDraft] = useState(() => backgroundDraft(project));
  const [baseline, setBaseline] = useState(project);
  const [localError, setLocalError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskSearch, setTaskSearch] = useState('');
  const [taskFilter, setTaskFilter] = useState<TaskStatus | 'all'>('all');
  const [taskPage, setTaskPage] = useState(0);
  const [filePage, setFilePage] = useState(0);
  const [sourcePage, setSourcePage] = useState(0);
  const [newTask, setNewTask] = useState<string | null>(null);
  const summary = projectSummary(project);
  const work = projectWorkState(project);
  const health = projectHealth(project);
  const timeRange = projectTimeRange(project);
  const requiredTasks = project.tasks.filter(task => !task.optional && task.status !== 'cancelled');
  const incompleteRequired = requiredTasks.filter(task => task.status !== 'completed');
  const completedRequired = requiredTasks.length - incompleteRequired.length;
  const canStartProjectChat = !!project.workingDirectory?.trim();
  const requestBack = () => onBack();
  const changeTab = async (next: Tab) => {
    if (next === tab) return;
    if (!(await useProjectsStore.getState().confirmDiscard('切换页面'))) return;
    setEditing(false);
    setDraft(backgroundDraft(project));
    setNewTask(null);
    setSelectedTaskId(null);
    setTab(next);
  };
  const runAction = async (action: () => Promise<boolean>, fallback: string) => {
    if (actingRef.current || useProjectsStore.getState().writeOperation || useProjectsStore.getState().loading) return false;
    actingRef.current = true; setActing(true); setLocalError(null);
    try {
      if (await action()) return true;
      setLocalError(useProjectsStore.getState().error || fallback); return false;
    }
    catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); return false; }
    finally { actingRef.current = false; setActing(false); }
  };
  // A failed lifecycle write must not discard drafts that are still on screen.
  const lifecycleAction = async (action: () => Promise<boolean>, confirmText: string | null, fallback: string) => {
    if (busy) return;
    if (confirmText && !(await confirmAction({ title: '项目生命周期操作', message: confirmText, confirmLabel: '确认', tone: 'danger' }))) return;
    const previous = useProjectsStore.getState().dirtyReasons;
    if (!(await useProjectsStore.getState().confirmDiscard('执行此操作'))) return;
    void runAction(async () => {
      const ok = await action();
      if (ok) { setEditing(false); setNewTask(null); setSelectedTaskId(null); }
      else useProjectsStore.setState({ dirtyReasons: previous, dirty: Object.values(previous).some(Boolean) });
      return ok;
    }, fallback);
  };
  const requestDelete = () => void lifecycleAction(() => remove(project.id, true),
    `确定将「${project.name}」移入回收站吗？之后可以恢复。`, '删除失败，原有数据未改变。');
  const requestArchive = () => void lifecycleAction(() => archive(project.id, true),
    `确定归档「${project.name}」吗？归档后可从“归档”视图恢复。`, '归档失败，原有数据未改变。');
  const startProjectChat = (taskId?: string, resumeId?: string) => {
    if (readonly) return;
    const existingTaskId = taskId && project.tasks.some(task => task.id === taskId) ? taskId : undefined;
    void runAction(() => startConversation(project.id, existingTaskId, resumeId), '无法打开对话，请核对项目工作目录及对话是否仍存在。');
  };
  const restoreProject = async () => {
    if (project.mergedInto && !(await confirmAction({ title: '恢复源项目', message: '恢复源项目不会撤销目标项目已合并的内容，可能造成重复。确定恢复吗？', confirmLabel: '恢复', tone: 'danger' }))) return;
    void runAction(() => remove(project.id, false), '恢复失败，原有数据未改变。');
  };
  const chooseDirectory = async () => {
    if (editBusy || directoryPending.current) return;
    directoryPending.current = true;
    try {
      const bridge = desktopAPI();
      if (!bridge) throw new Error('请选择更新后的桌面应用打开此项目。');
      const directory = await bridge.openDirectory();
      if (directory) setDraft(current => ({ ...current, workingDirectory: directory }));
    } catch (error) { setLocalError(`选择目录失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { directoryPending.current = false; }
  };
  const exportProject = async (format: 'md' | 'json') => {
    const safe = project.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'project';
    setLocalError(null);
    try {
      const bridge = desktopAPI();
      const exporter = format === 'md' ? bridge?.exportMarkdown : bridge?.exportJson;
      if (!exporter) throw new Error('当前应用不支持导出，请重新启动更新后的桌面应用。');
      await exporter(`${safe}.${format}`, format === 'md' ? projectArchiveMarkdown(project) : JSON.stringify(project, null, 2));
      // 系统对话框返回 null 表示取消，不是失败。
    } catch (error) { setLocalError(`导出失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  useEffect(() => { setTaskPage(0); }, [taskSearch, taskFilter]);
  const selectedTask = project.tasks.find(task => task.id === selectedTaskId);
  const statusOrder: TaskStatus[] = ['in_progress', 'pending', 'completed', 'cancelled'];
  const searchTasks = useMemo(() => project.tasks.filter(task => `${task.name}\n${task.description}`.toLowerCase().includes(taskSearch.toLowerCase())), [project.tasks, taskSearch]);
  const tasks = searchTasks.filter(task => taskFilter === 'all' || task.status === taskFilter).sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  const safeTaskPage = Math.min(taskPage, Math.max(0, Math.ceil(tasks.length / 24) - 1));
  const visibleIds = new Set(tasks.slice(safeTaskPage * 24, (safeTaskPage + 1) * 24).map(task => task.id));
  // Group only the current page; counts and filters always refer to all tasks.
  const groupTasks = (status: TaskStatus) => tasks.filter(task => task.status === status && visibleIds.has(task.id));
  const selectTask = async (id: string) => {
    if (id === selectedTaskId) return;
    if (!(await useProjectsStore.getState().confirmDiscard('切换任务', tab === 'tasks' || tab === 'workflow' ? ['task'] : undefined))) return;
    // 从背景/来源页定位任务时，先切到任务页，避免详情浮层出现在无关正文上。
    if (tab !== 'tasks' && tab !== 'workflow') {
      setEditing(false);
      setDraft(backgroundDraft(project));
      setNewTask(null);
      setTab('tasks');
    }
    setSelectedTaskId(id);
  };
  const deleteTask = async (task: ProjectTask) => {
    if (editBusy) return;
    const state = useProjectsStore.getState();
    const latest = state.projects.find(item => item.id === project.id);
    if (!latest || latest.archivedAt || latest.deletedAt) return;
    const following = latest.tasks.filter(item => item.dependsOn.includes(task.id));
    const warning = following.length ? `\n以下任务依赖它：\n${following.map(item => `• ${item.name}`).join('\n')}\n删除并解除这些前置依赖？` : '';
    if (!(await confirmAction({ title: '删除任务', message: `确定删除任务「${task.name}」吗？${warning}`, confirmLabel: '删除', tone: 'danger' }))) return;
    if (!(await useProjectsStore.getState().confirmDiscard('删除任务', ['task']))) return;
    const current = useProjectsStore.getState().projects.find(item => item.id === project.id);
    if (!current || current.archivedAt || current.deletedAt) return;
    void runAction(() => save(project.id, { tasks: current.tasks.filter(item => item.id !== task.id).map(item => item.dependsOn.includes(task.id) ? { ...item, dependsOn: item.dependsOn.filter(id => id !== task.id) } : item) }), '删除未保存，原有任务和依赖未改变。');
    setSelectedTaskId(null);
  };
  const updateStatus = (task: ProjectTask, status: TaskStatus) => {
    if (editBusy) return;
    // The same task editor merges only its dirty fields, preserving this saved status.
    // Updating the list must not discard an unrelated editor or its draft.
    const latest = useProjectsStore.getState().projects.find(item => item.id === project.id);
    const latestTask = latest?.tasks.find(item => item.id === task.id);
    if (!latest || !latestTask || latest.archivedAt || latest.deletedAt) return;
    void runAction(() => save(project.id, { tasks: latest.tasks.map(item => item.id === task.id ? { ...latestTask, status } : item) }), '任务状态未保存，原有数据未改变。');
  };
  const addTask = async () => {
    if (editBusy || !newTask?.trim() || !(await useProjectsStore.getState().confirmDiscard('新增并切换任务', ['task']))) return;
    setSelectedTaskId(null);
    const latest = useProjectsStore.getState().projects.find(item => item.id === project.id);
    if (!latest || latest.archivedAt || latest.deletedAt) return;
    const task: ProjectTask = {
      id: `manual:${crypto.randomUUID()}`, name: newTask.trim(), description: '', status: 'pending',
      inputs: [], outputs: [], dependsOn: [], dependencyNote: '用户新增任务，依赖尚未确认', sourceIds: [], records: [],
    };
    await runAction(async () => {
      const ok = await save(project.id, { tasks: [...latest.tasks, task], goalConfirmed: false });
      if (ok) { setNewTask(null); setSelectedTaskId(task.id); setTaskFilter('all'); setTaskSearch(''); }
      return ok;
    }, '新增任务未保存，请重试。任务名称已保留。');
  };
  const saveBackground = async () => {
    if (editBusy) return;
    const { tags, workingDirectory, ...fields } = draft;
    const parsedTags = tags.split(',').map(tag => tag.trim()).filter(Boolean);
    const latest = useProjectsStore.getState().projects.find(item => item.id === project.id);
    if (!latest) return;
    try {
      const changes = projectEditChanges(baseline, { ...fields, tags: [...new Set(parsedTags)], ...(workingDirectory || baseline.workingDirectory !== undefined ? { workingDirectory: workingDirectory.trim() } : {}) }, latest);
      await runAction(async () => {
        const ok = await save(project.id, changes);
        if (ok) { setEditing(false); setLocalError(null); }
        return ok;
      }, '背景未保存，草稿已保留。');
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => {
    const setDirty = useProjectsStore.getState().setDirty;
    setDirty(editing, 'background');
    return () => setDirty(false, 'background');
  }, [editing]);
  useEffect(() => {
    const setDirty = useProjectsStore.getState().setDirty;
    setDirty(!!newTask?.trim(), 'new-task');
    return () => setDirty(false, 'new-task');
  }, [newTask]);

  // “更多”菜单：点击外部或 Esc 关闭，避免菜单长期遮挡内容。
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const menu = moreMenu.current;
      if (!menu?.open) return;
      if (!menu.contains(event.target as Node)) menu.removeAttribute('open');
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const menu = moreMenu.current;
      if (menu?.open) { event.stopPropagation(); menu.removeAttribute('open'); }
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const focusIssue = (code: string) => {
    if (code === 'no-sources') changeTab('sources');
    else if (code === 'no-tasks') changeTab('tasks');
    else if (code === 'uncertainties') changeTab('audit');
    else changeTab('background');
  };
  const pendingHeaderCount = incompleteRequired.length + health.issues.length;
  const moreReason = busyReason ?? (readonly ? '当前项目只读，恢复后可执行更多操作' : editing ? '请先保存或取消当前编辑，再执行更多操作' : undefined);
  return <div ref={detailRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <div className="shrink-0 border-b border-border/50">
      {/* 页头只保留：返回、名称、状态、主操作和页签；说明与验收细节下移或折叠 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button className={BUTTON_GHOST} onClick={requestBack}><ArrowLeft className="h-3.5 w-3.5" />项目总览</button>
        <div className="flex min-w-0 flex-1 items-center gap-2"><h1 className="min-w-0 truncate text-base font-semibold text-text-primary" title={project.name}>{project.name}</h1>
          <span className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-xs ${project.deletedAt ? 'bg-accent-red/10 text-accent-red' : project.archivedAt ? 'bg-bg-lighter text-text-secondary' : PROJECT_STATUS_STYLE[summary.status]}`}>{project.deletedAt ? '已删除' : project.archivedAt ? '已归档' : PROJECT_LABELS[summary.status]}</span>
        </div>
        <div role="group" aria-label="项目工作操作" className="ml-auto flex shrink-0 items-center gap-2">
          {recentLink && !readonly && <button className={BUTTON_PRIMARY} disabled={editBusy} title={editDisabledReason ?? '打开已关联的最近对话，不新建草稿'} onClick={() => startProjectChat(recentLink.taskId, recentLink.conversationId)}><MessageSquare className="h-4 w-4" />打开最近对话</button>}
          {!project.deletedAt && <button aria-label="新建项目对话" className={recentLink ? ICON_BUTTON : BUTTON_PRIMARY} disabled={editBusy || !canStartProjectChat} title={!canStartProjectChat ? '先设置项目工作目录' : editDisabledReason ?? '新建项目对话并生成草稿，不会自动发送'} onClick={() => startProjectChat()}><MessageSquarePlus className="h-4 w-4" />{!recentLink && '新建项目对话'}</button>}
          <details data-popover ref={moreMenu} className="relative">
            <summary aria-label="更多" title="项目更多操作" className={`${ICON_BUTTON} list-none cursor-pointer [&::-webkit-details-marker]:hidden`}><MoreHorizontal className="h-4 w-4" /></summary>
            <div className={`${POPOVER_PANEL} absolute right-0 top-full mt-2 w-56 space-y-0.5`} onClick={event => { if ((event.target as HTMLElement).closest('button')) moreMenu.current?.removeAttribute('open'); }}>
              <p className={MENU_LABEL}>工作与导航</p>
              <button className={MENU_ITEM} title="离开项目管理中心；有未保存草稿时会先确认" onClick={async () => { if (await showChat()) setEditing(false); }}><MessageSquare className="h-3.5 w-3.5" />返回对话</button>
              {moreReason && <p role="status" className="px-2 py-1 text-2xs leading-4 text-text-muted">{moreReason}</p>}
              <p className={`${MENU_LABEL} border-t border-border/50`}>项目档案</p>
              {project.deletedAt ? <button className={MENU_ITEM} disabled={busy} title={busyReason} onClick={restoreProject}><ArchiveRestore className="h-3.5 w-3.5" />恢复</button> : project.archivedAt ? <button className={MENU_ITEM} disabled={busy} title={busyReason} onClick={() => void runAction(() => archive(project.id, false), '恢复归档失败，原有数据未改变。')}><ArchiveRestore className="h-3.5 w-3.5" />恢复归档</button> : <button className={MENU_ITEM} disabled={busy} title={busyReason} onClick={requestArchive}><Archive className="h-3.5 w-3.5" />归档</button>}
              {!project.deletedAt && <button className={MENU_ITEM_DANGER} disabled={busy} title={busyReason} onClick={requestDelete}><Trash2 className="h-3.5 w-3.5" />移入回收站</button>}
              {!project.deletedAt && !project.archivedAt && <button className={MENU_ITEM} disabled={editBusy} title={editDisabledReason ?? '合并前会确认目标项目与不可撤销范围'} onClick={() => { setMergeTarget(''); setMergeOpen(true); }}><GitMerge className="h-3.5 w-3.5" />合并到…</button>}
              {!project.deletedAt && <button className={MENU_ITEM} disabled={editBusy} title={editDisabledReason ?? '切换项目置顶状态'} onClick={() => void runAction(() => save(project.id, { pinned: !project.pinned }), '置顶更改未保存。')}>{project.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}{project.pinned ? '取消置顶' : '置顶'}</button>}
              <button className={MENU_ITEM} disabled={busy} title={busyReason ?? '导出当前项目档案为 Markdown'} onClick={() => void exportProject('md')}><Download className="h-3.5 w-3.5" />导出 Markdown</button>
              <button className={MENU_ITEM} disabled={busy} title={busyReason ?? '导出当前项目档案为 JSON'} onClick={() => void exportProject('json')}><Download className="h-3.5 w-3.5" />导出 JSON</button>
              {!!project.deletedAt && <div className="mt-1 border-t border-border/60 pt-1"><button className={MENU_ITEM_DANGER} disabled={busy} title={busyReason ?? '彻底删除项目档案，不可恢复'} onClick={async () => { if (await confirmAction({ title: '彻底删除项目', message: `彻底删除「${project.name}」及其项目档案？此操作不可恢复，不会删除原始对话或文件。`, confirmLabel: '彻底删除', tone: 'danger' })) void runAction(() => purge(project.id), '彻底删除失败，原有数据未改变。'); }}><Trash2 className="h-3.5 w-3.5" />彻底删除</button></div>}
            </div>
          </details>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2 text-xs text-text-secondary">
        <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-bg-lighter" role="progressbar" aria-label="必要任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.requiredTotal ? summary.progress : undefined} aria-valuetext={progressLabel(summary)}><div className="h-full bg-accent-green transition-[width]" style={{ width: `${summary.requiredTotal ? summary.requiredCompleted / summary.requiredTotal * 100 : 0}%` }} /><div className="h-full bg-accent-blue transition-[width]" style={{ width: `${summary.requiredTotal ? work.active.length / summary.requiredTotal * 100 : 0}%` }} /></div>
        <span className="tabular-nums">{progressLabel(summary)}</span>
        <label className={`ml-auto flex h-7 items-center gap-2 rounded-md border px-2.5 ${summary.allTasksComplete ? 'cursor-pointer border-accent-green/35 bg-accent-green/5 text-accent-green' : 'border-border/60 text-text-muted'}`} title={!summary.allTasksComplete ? `先完成必要任务；还差 ${incompleteRequired.length} 项。确认后记录验收时间与任务范围。` : '我已核对交付物，确认项目目标达成；确认后记录验收时间与当前必要任务范围'}>
          <input type="checkbox" aria-label="我已核对交付物，确认项目目标达成" checked={project.goalConfirmed} disabled={editBusy || (!summary.allTasksComplete && !project.goalConfirmed)} onChange={event => { const goalConfirmed = event.target.checked; void runAction(() => save(project.id, { goalConfirmed }), '目标验收更改未保存。'); }} className="accent-accent-green" /><CheckCircle2 className="h-3.5 w-3.5" />{project.goalConfirmed ? '交付已验收' : '确认交付验收'}
        </label>
        {pendingHeaderCount > 0 && <details data-popover className="relative text-accent-yellow"><summary className={`${BUTTON_SM} list-none cursor-pointer text-accent-yellow [&::-webkit-details-marker]:hidden`}>待处理 {pendingHeaderCount}</summary><div className={`${POPOVER_PANEL} absolute right-0 top-full mt-2 max-h-56 w-72 space-y-1 overflow-y-auto p-3 leading-5`}>{incompleteRequired.length > 0 && <div><p className="mb-1 text-text-secondary">未完成必要任务</p>{incompleteRequired.map(task => <button key={task.id} type="button" className={MENU_ITEM} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void selectTask(task.id); }}>{task.name}</button>)}</div>}{health.issues.map(issue => <button key={issue.code} type="button" className={MENU_ITEM} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); focusIssue(issue.code); }}>{issue.label} · 去处理</button>)}</div></details>}
      </div>
      {readonly && <p role="status" className="mx-4 mb-1.5 rounded-md border border-border bg-bg-light px-2 py-1 text-2xs text-text-secondary">{project.deletedAt && project.mergedInto ? `已合并到 ${projects.find(item => item.id === project.mergedInto)?.name || project.mergedInto} · ` : ''}只读，恢复后可编辑</p>}
      {(localError || storeError) && <p role="alert" className="mx-4 mb-1.5 rounded-md border border-accent-red/25 px-2 py-1 text-xs text-accent-red">{localError || storeError}</p>}
      <nav className="flex gap-1 overflow-x-auto border-t border-border/40 px-4" aria-label="项目详情导航">{tabs.map(item => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => changeTab(item.id)} className={`${PAGE_TAB} ${tab === item.id ? PAGE_TAB_ACTIVE : PAGE_TAB_IDLE}`}><item.icon className="h-3.5 w-3.5" />{item.label}</button>)}</nav>
    </div>
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${tab === 'workflow' ? 'overflow-hidden p-2' : 'overflow-y-auto p-4 md:p-6'}`}>
        <div className={tab === 'workflow' ? 'flex min-h-0 flex-1 flex-col' : 'mx-auto w-full max-w-[1040px]'}>
        {tab === 'background' && <div className="flex flex-col gap-4">
          <section aria-label="下一步工作" className="order-none rounded-xl border border-border/60 bg-bg-light/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0"><h3 className="text-xs font-medium text-text-muted">{work.label}</h3><p className="mt-1 text-sm font-medium text-text-primary">{work.nextTask?.name || (summary.allTasksComplete ? project.goalConfirmed ? '全部必要任务完成，交付已验收' : '必要任务完成，等待你核对交付物' : '把项目拆成明确、可追踪的任务')}</p></div>
              <div className="flex shrink-0 items-center gap-2"><button className={BUTTON_GHOST} onClick={() => work.nextTask ? void selectTask(work.nextTask.id) : void changeTab('tasks')}><ListTodo className="h-3.5 w-3.5" />{work.nextTask ? '查看任务' : '管理任务'}</button>{work.nextTask && <button className={button} disabled={editBusy || !canStartProjectChat} title={!canStartProjectChat ? '先设置项目工作目录' : editDisabledReason ?? '仅生成任务对话草稿，核对后由你发送'} onClick={() => startProjectChat(work.nextTask!.id)}><MessageSquarePlus className="h-3.5 w-3.5" />准备任务对话<ArrowRight className="h-3.5 w-3.5" /></button>}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary"><span className="flex items-center gap-1.5"><CircleDot className="h-3.5 w-3.5 text-accent-blue" />进行中 {work.active.length}</span><span>未开始 {work.pending.length}</span>{work.blocked.length > 0 && <span className="text-accent-yellow">前置未完成 {work.blocked.length}</span>}<span>已完成 {completedRequired}/{requiredTasks.length}</span></div>
            {work.nextTask && work.blocked.some(task => task.id === work.nextTask!.id) && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-accent-yellow"><span>需核对前置：</span>{work.nextTask.dependsOn.filter(id => project.tasks.find(task => task.id === id)?.status !== 'completed').map(id => <button key={id} className="underline underline-offset-2" onClick={() => void selectTask(id)}>{project.tasks.find(task => task.id === id)?.name || `缺失任务 ${id}`}</button>)}</div>}
            <p className="mt-2 text-xs leading-5 text-text-muted">{work.note}</p>
          </section>
          <section className="order-2 glass-panel rounded-xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4"><h3 className="text-sm font-medium text-text-primary">档案概览</h3><span className="text-xs text-text-secondary">档案导出与生命周期操作在右上角「更多」中</span></div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">首次工作</div><div className="mt-1 text-text-primary">{timeRange.first ? new Date(timeRange.first).toLocaleDateString() : '未知'}</div></div>
              <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">最后工作</div><div className="mt-1 text-text-primary">{timeRange.last ? new Date(timeRange.last).toLocaleDateString() : '未知'}</div></div>
              <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">活跃天数 / 会话</div><div className="mt-1 font-mono text-text-primary">{timeRange.activeDays} / {timeRange.sessions}</div></div>
              <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">置顶 / 标签</div><div className="mt-1 text-text-primary">{project.pinned ? '已置顶' : '未置顶'} · {(project.tags || []).length} 个标签</div></div>
            </div>
            {!!project.tags?.length && <div className="flex flex-wrap gap-1.5 mt-3">{project.tags.map(tag => <span key={tag} className="rounded bg-bg-lighter px-1.5 py-0.5 text-2xs text-text-secondary">{tag}</span>)}</div>}
          </section>
          <section className="order-3 glass-panel rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-medium text-text-primary">关联对话与进展</h3>
            <p className="text-xs text-text-secondary break-words">项目目标：{project.goal || '待确认'}</p>
            <p className="text-xs text-text-secondary leading-5">运行摘录未经核验，不代表任务或项目已完成。标记进展已核对不会自动完成任务或项目。</p>
            {currentConversation && <div className="rounded-lg border border-border p-3 space-y-2"><p className="text-xs text-text-secondary break-words">当前对话：{currentConversation.title || '新对话'}<span className="block font-mono break-all mt-1">目录：{currentConversation.cwd || '未设置'}</span></p><button className={button} disabled={editBusy} onClick={() => void runAction(() => linkConversation(project.id, currentConversation.id), '关联失败，请核对当前对话是否仍存在。')}>关联当前对话</button><p className="text-2xs text-text-secondary">仅关联此对话，不修改全局工作目录。</p></div>}
            {!links.length && <p className="text-xs text-text-secondary">暂无关联对话。</p>}
            {links.map(link => <div key={link.conversationId} className="rounded-lg border border-border bg-bg-light/40 p-3 space-y-2">
              <p className="text-sm text-text-primary break-words">{link.title || '未命名对话'}</p>
              <p className="text-xs text-text-secondary">{link.taskId ? project.tasks.find(task => task.id === link.taskId)?.name || '已删除任务' : '项目对话'} · {link.lastRun ? ({ completed: '运行结束', failed: '运行失败', aborted: '运行已中止' }[link.lastRun.status]) : '暂无运行记录'}{link.lastRun && !link.reviewedAt && <span className="ml-2 text-accent-orange">待核对进展</span>}</p>
              <p className="font-mono text-2xs text-text-secondary break-all selectable-text">{link.cwd || '目录未记录'}</p>
              {link.lastRun && <div className="text-xs text-text-secondary"><p className="text-accent-orange">运行摘录（未经核验） · {new Date(link.lastRun.recordedAt).toLocaleString()}</p><p className="mt-1 whitespace-pre-wrap break-words selectable-text">{link.lastRun.excerpt || '无摘录'}</p></div>}
              {link.reviewedAt && <p className="text-2xs text-accent-green">进展已核对 · {new Date(link.reviewedAt).toLocaleString()}（非任务验收）</p>}
              <div className="flex flex-wrap gap-2"><button className={button} disabled={editBusy || !linkAvailable(link)} title="打开这个已关联的对话，不新建草稿" onClick={() => startProjectChat(link.taskId, link.conversationId)}>打开此对话</button>{link.taskId && project.tasks.some(task => task.id === link.taskId) && <button className={button} onClick={() => selectTask(link.taskId!)}>定位任务</button>}<button className={button} disabled={editBusy || !link.lastRun || !!link.reviewedAt} onClick={() => void runAction(() => reviewConversation(project.id, link.conversationId), '进展核对未保存。')}>标记进展已核对</button></div>
              {!linkAvailable(link) && <p className="text-2xs text-text-secondary">关联对话已不可用；保留摘录供回溯，不会新建替代对话。</p>}
            </div>)}
          </section>
          <section className="order-1 glass-panel rounded-xl p-5"><div className="flex items-center justify-between gap-3 mb-4"><h3 className="text-sm font-medium text-text-primary">项目背景</h3><button className={button} disabled={editBusy} onClick={() => { setDraft(backgroundDraft(project)); setBaseline(project); setLocalError(null); setEditing(!editing); }}><Pencil className="w-3.5 h-3.5" />{editing ? '取消编辑' : '编辑背景'}</button></div>
            {editing ? <form onSubmit={event => { event.preventDefault(); void saveBackground(); }} className="space-y-4">
              <label className="block text-xs text-text-secondary">项目名称<input className={`${input} mt-1`} value={draft.name} required maxLength={500} disabled={editBusy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
              <label className="block text-xs text-text-secondary">项目工作目录<div className="flex gap-2 mt-1"><input className={input} value={draft.workingDirectory} disabled={editBusy} onChange={event => setDraft({ ...draft, workingDirectory: event.target.value })} placeholder="显式填写项目目录，不使用全局默认目录" /><button type="button" className={`${button} shrink-0`} disabled={editBusy} onClick={() => void chooseDirectory()}>选择目录</button></div></label>
              <p className="text-2xs text-text-secondary">工作目录仅在保存背景后生效；不会改变当前对话目录或生成历史来源。</p>
              {historyDirectories.length === 1 && <button type="button" className={button} disabled={editBusy} onClick={() => setDraft({ ...draft, workingDirectory: historyDirectories[0] })}>使用唯一历史目录：{historyDirectories[0]}</button>}
              {historyDirectories.length > 1 && <p className="text-xs text-accent-yellow">历史来源包含多个目录，请明确选择工作目录，不会自动继承。</p>}
              <label className="block text-xs text-text-secondary">标签（逗号分隔）<input className={`${input} mt-1`} value={draft.tags} maxLength={500} disabled={editBusy} onChange={event => setDraft({ ...draft, tags: event.target.value })} placeholder="例如：会员体系, 后端, 2026" /></label>
              {([['description', '简述'], ['goal', '目标'], ['background', '需求背景'], ['constraints', '约束条件'], ['decisions', '关键决策'], ['deliverables', '预期交付物']] as const).map(([key, label]) => <label key={key} className="block text-xs text-text-secondary">{label}<textarea rows={key === 'background' ? 4 : 2} className={`${input} mt-1 resize-y`} value={draft[key]} required={key === 'goal'} maxLength={20000} disabled={editBusy} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>)}
              <p className="text-xs text-accent-orange">只填写已知信息。变更项目目标或交付标准后需要重新验收。可选任务的取消或删除不会撤销验收。</p><button className={`${button} text-accent-cyan border-accent-cyan/30`} type="submit" disabled={editBusy}><Save className="w-4 h-4" />{busy ? '保存中…' : '保存背景'}</button>
            </form> : <dl className="space-y-4 selectable-text">{([['goal', '项目目标'], ['background', '需求背景'], ['constraints', '约束条件'], ['decisions', '关键决策'], ['deliverables', '预期交付物']] as const).map(([key, label]) => <div key={key}><dt className="text-xs text-text-secondary mb-1.5">{label}{project.fieldProvenance?.[key] && <span className="ml-2 rounded bg-bg-lighter px-1.5 py-0.5 text-2xs text-text-dim">{PROVENANCE_LABELS[project.fieldProvenance[key]!]}</span>}</dt><dd className={`text-sm whitespace-pre-wrap break-words leading-6 ${project[key] ? 'text-text-primary' : 'text-text-secondary italic'}`}>{project[key] || '历史未提供，待确认。可在编辑背景中补充。'}</dd>{key !== 'goal' && <FieldEvidence project={project} field={key} onSource={onSource} />}</div>)}</dl>}
              {!editing && <div className="mt-4 text-xs text-text-secondary">项目工作目录：<span className="font-mono break-all selectable-text">{project.workingDirectory || '未设置，请编辑背景显式指定后再新建对话。'}</span></div>}
            {/* 交付验收：把后果、当前范围和撤销条件集中展示 */}
            <div className="mt-4 rounded-lg border border-border/60 bg-bg-light/30 p-3 text-xs">
              <h4 className="font-medium text-text-primary">交付验收</h4>
              <p className="mt-1 leading-5 text-text-secondary">必要任务 {completedRequired}/{requiredTasks.length} 已完成。确认后会记录验收时间与当时的必要任务范围，不会自动完成任务或产生执行记录。</p>
              {project.acceptance && <p className="mt-1 text-accent-green">已验收：{new Date(project.acceptance.confirmedAt).toLocaleString()} · {project.acceptance.requiredTaskIds.length} 项必要任务</p>}
              {!project.goalConfirmed && project.acceptanceInvalidatedReason && <p role="status" className="mt-1 text-accent-orange">上次验收已撤销：{project.acceptanceInvalidatedReason}</p>}
              <p className="mt-1 leading-5 text-text-secondary">修改目标、交付物或新增必要任务会撤销验收；取消或删除可选任务不会撤销。</p>
              {incompleteRequired.length > 0 && <p className="mt-1 leading-5 text-accent-yellow">未完成必要任务：{incompleteRequired.map(task => task.name).join('、')}</p>}
            </div>
          </section>
          <section className="order-4 glass-panel rounded-xl p-5"><h3 className="text-sm font-medium text-text-primary mb-4">关联文件 <span className="text-text-secondary font-mono">{project.files.length}</span></h3><p className="text-xs text-text-secondary mb-4 leading-5">保留成功文件操作的来源和用途；工具写入不等于产物已验收。预览和定位均需当前系统可访问文件。</p>
            {!project.files.length && <p className="text-sm text-text-secondary">没有可靠的文件操作记录。任务中可手动登记已确认的输入与输出。</p>}
            <div className="space-y-3">{project.files.slice(filePage * 16, (filePage + 1) * 16).map((file, index) => <div className="rounded-lg border border-border bg-bg-deepest/60 p-3" key={`${file.path}:${file.sourceId}:${index}`}><div className="flex items-start gap-2"><FileText className="w-4 h-4 text-accent-cyan shrink-0 mt-0.5" /><div className="min-w-0 flex-1"><div className="text-sm text-text-primary break-words">{file.path.split(/[\\/]/).pop()}</div><p className="text-xs font-mono text-text-secondary mt-1 break-all selectable-text">{file.path}</p><p className="text-xs text-text-secondary mt-2">{file.purpose || '用途未记录，待确认'}</p></div></div><div className="flex gap-2 mt-3"><button className={button} onClick={() => onPreview(file.path)}>预览</button><button className={button} onClick={() => void onReveal(file.path)}>定位文件</button>{project.sources.find(source => source.id === file.sourceId) && <button className={button} onClick={() => onSource(project.sources.find(source => source.id === file.sourceId)!)}>操作来源</button>}</div></div>)}</div><Pager page={filePage} total={project.files.length} size={16} onChange={setFilePage} />
          </section>
          <div className="order-5"><UncertaintyList project={project} save={save} busy={editBusy} /></div>
        </div>}
        {tab === 'tasks' && <div className="space-y-4">
          <div className="flex flex-wrap gap-2 items-center"><div className="relative flex-1 min-w-[160px]"><Search className="absolute left-3 top-2 h-4 w-4 text-text-secondary" /><input aria-label="搜索任务" className={`${input} h-8 pl-9 text-xs leading-none`} value={taskSearch} onChange={event => setTaskSearch(event.target.value)} placeholder="搜索任务名称或说明" /></div><button className={button} disabled={editBusy} onClick={() => setNewTask('')}><Plus className="w-4 h-4" />新增任务</button></div>
          {newTask !== null && <form onSubmit={event => { event.preventDefault(); void addTask(); }} className="flex flex-wrap gap-2 rounded-xl p-3 border border-accent-cyan/30 bg-accent-cyan/5"><input className={`${input} flex-1 min-w-[160px]`} autoFocus aria-label="新任务名称" placeholder="填写明确的任务名称" required maxLength={500} value={newTask} disabled={editBusy} onChange={event => setNewTask(event.target.value)} /><button className={button} type="submit" disabled={editBusy || !newTask.trim()}>添加</button><button className={button} type="button" disabled={busy} onClick={() => setNewTask(null)}><X className="w-4 h-4" /></button></form>}
          <div className="flex flex-wrap gap-1 border-b border-border/40 pb-2" role="group" aria-label="任务状态筛选">{(['all', ...TASK_STATUSES] as const).map(status => <button className={`${SEGMENT} ${taskFilter === status ? SEGMENT_ACTIVE : ''}`} key={status} aria-pressed={taskFilter === status} onClick={() => setTaskFilter(status)}>{status === 'all' ? `全部 (${searchTasks.length})` : `${TASK_LABELS[status]} (${searchTasks.filter(task => task.status === status).length})`}</button>)}</div>
          {!tasks.length && <p className="text-sm text-text-secondary py-6">没有匹配任务。可调整搜索条件或新增任务。</p>}
          <p role="status" className="text-xs text-text-secondary">匹配 {tasks.length} 项任务 · 状态数量包含可选任务，验收进度仅计算必要任务。</p>
          {statusOrder.map(status => {
            if (taskFilter !== 'all' && taskFilter !== status) return null;
            const members = groupTasks(status);
            const total = tasks.filter(task => task.status === status).length;
            if (!total) return null;
            return <section key={status} role="group" aria-label={TASK_LABELS[status]}><p className="mb-3 text-2xs font-medium uppercase tracking-wide text-text-secondary">{TASK_LABELS[status]} · 本页 {members.length} / 全部匹配 {total}</p>{!members.length && <p className="text-xs text-text-secondary mb-3">此页无{TASK_LABELS[status]}任务。<button className="ml-2 text-accent-cyan hover:underline" onClick={() => { setTaskFilter(status); setTaskPage(0); }}>筛选此状态</button></p>}<div className="space-y-2">{members.map(task => <div key={task.id} className={`flex items-start gap-3 rounded-xl p-4 border ${selectedTaskId === task.id ? 'border-border-light bg-bg-lighter' : 'border-border bg-bg-light/40'}`}><button className="flex-1 min-w-0 text-left" onClick={() => selectTask(task.id)}><h4 className="text-sm text-text-primary hover:text-accent-cyan break-words">{task.name}{task.optional && <span className="ml-2 rounded bg-bg-lighter px-1.5 py-0.5 text-2xs text-text-secondary">可选</span>}</h4><p className="text-xs text-text-secondary leading-5 mt-1 line-clamp-2">{task.description || '说明未记录，点击查看详情或补充信息。'}</p><p className="text-2xs text-text-secondary mt-2">{task.dependsOn.length ? `${task.dependsOn.length} 个前置依赖` : '依赖待确认'} · {task.sourceIds.length} 条来源</p></button><select aria-label={`任务状态 ${task.name}`} className={`${SELECT} w-24 shrink-0`} value={task.status} disabled={editBusy} onChange={event => updateStatus(task, event.target.value as TaskStatus)}>{TASK_STATUSES.map(status => <option key={status} value={status}>{TASK_LABELS[status]}</option>)}</select><details data-popover className="relative shrink-0"><summary aria-label={`任务操作 ${task.name}`} title="任务更多操作" className={`${ICON_BUTTON} list-none cursor-pointer [&::-webkit-details-marker]:hidden`}><MoreHorizontal className="h-4 w-4" /></summary><div className={`${POPOVER_PANEL} absolute right-0 top-full mt-1 w-44`}><button type="button" className={MENU_ITEM} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void selectTask(task.id); }}>查看任务详情</button><button type="button" className={`${MENU_ITEM_DANGER} mt-1 border-t border-border/50`} aria-label={`删除任务 ${task.name}`} disabled={editBusy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void deleteTask(task); }}><Trash2 className="h-3.5 w-3.5" />删除任务</button></div></details></div>)}</div></section>;
          })}<Pager page={safeTaskPage} total={tasks.length} size={24} onChange={setTaskPage} />
        </div>}
        {tab === 'workflow' && <ProjectWorkflow project={project} selectedTaskId={selectedTaskId} onSelectTask={selectTask} />}
        {tab === 'audit' && <AuditView project={project} />}
        {tab === 'retrospective' && <RetrospectiveView project={project} save={save} busy={editBusy} />}
        {tab === 'sources' && <section className="space-y-3"><h3 className="text-sm text-text-primary font-medium">可追溯的历史来源</h3><p className="text-xs text-text-secondary leading-5">GUI 会话可直接定位消息；已从 GUI 清理或仅在 Claude Code 本地保存的会话展示来源摘录与记录路径。整理结果保留在项目中，不依赖原会话仍被保留。</p>{!project.sources.length && <p className="text-sm text-text-secondary py-6">没有历史来源。</p>}{project.sources.slice(sourcePage * 20, (sourcePage + 1) * 20).map(item => <button className="w-full text-left p-4 glass-panel glass-panel-hover rounded-xl" key={item.id} onClick={() => onSource(item)}><p className="text-xs text-accent-cyan mb-2">{item.kind === 'gui' ? 'GUI 会话' : 'Claude Code 本地记录'} · {item.title || item.sessionId}</p><p className="text-xs text-text-secondary leading-6 whitespace-pre-wrap break-words line-clamp-4 selectable-text">{item.excerpt || '工具调用或执行结果来源（无文本摘要）'}</p><p className="mt-2 font-mono text-2xs text-text-secondary break-all">{item.path || item.cwd || '工作目录未记录'}</p></button>)}<Pager page={sourcePage} total={project.sources.length} size={20} onChange={setSourcePage} /></section>}
        </div>
      </div>
      {/* 任务详情只在任务/工作流语境出现，避免在背景页误导为页面切换 */}
      {selectedTask && (tab === 'tasks' || tab === 'workflow') && <ProjectTaskDetail key={selectedTask.id} project={project} task={selectedTask} onClose={() => setSelectedTaskId(null)} onSource={onSource} onSelectTask={selectTask} onStartTask={taskId => startProjectChat(taskId)} canStartChat={canStartProjectChat} />}
      {mergeOpen && <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => { if (!busy) setMergeOpen(false); }}><section ref={mergeDialog} role="dialog" aria-modal="true" aria-label="合并项目" aria-busy={busy} tabIndex={-1} className="w-full max-w-lg rounded-xl bg-bg-deep border border-border-light p-5" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 mb-4"><h2 className="text-base text-text-primary">将「{project.name}」合并到</h2><button aria-label="关闭合并对话框" disabled={busy} onClick={() => setMergeOpen(false)}><X className="w-5 h-5 text-text-secondary" /></button></div>
        {localError && <p role="alert" className="mb-3 text-xs text-accent-red">{localError}</p>}
        <p className="text-xs text-text-secondary leading-5 mb-4">来源、文件、任务和待确认信息会合并到活跃目标项目，目标项目的验收可能撤销。来源项目保留在回收站；恢复来源不会撤销已合并内容，可能产生重复，这不是撤销操作。</p>
        <select aria-label="合并目标项目" className={`${input} bg-bg-deepest`} value={mergeTarget} disabled={editBusy} onChange={event => setMergeTarget(event.target.value)}>
          <option value="">选择目标项目</option>
          {projects.filter(item => item.id !== project.id && !item.deletedAt && !item.archivedAt).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <div className="flex justify-end gap-2 mt-4"><button className={button} disabled={busy} onClick={() => setMergeOpen(false)}>取消</button><button className={`${button} border-accent-cyan/40 text-accent-cyan`} disabled={editBusy || !mergeTarget} onClick={() => { void runAction(async () => { const target = useProjectsStore.getState().projects.find(item => item.id === mergeTarget);
          if (!target || target.archivedAt || target.deletedAt) throw new Error('合并目标已不再活跃，请重新选择。');
           const ok = await merge(project.id, mergeTarget);
           if (ok) { setMergeOpen(false); useProjectsStore.getState().clearDirty(); setEditing(false); setNewTask(null); setSelectedTaskId(null); }
           return ok; }, '合并失败，原有数据未改变。'); }}><GitMerge className="w-3.5 h-3.5" />确认合并</button></div>
      </section></div>}
    </div>
  </div>;
}

function FieldEvidence({ project, field, onSource }: { project: ManagedProject; field: ProjectEvidenceField; onSource: (source: ProjectSource) => void }) {
  const evidence = project.fieldEvidence?.[field];
  if (!evidence) return null;
  return <details className="mt-2 text-xs text-text-secondary"><summary className="cursor-pointer">字段证据 · {evidence.kind === 'quoted' ? '历史引用' : evidence.kind === 'model' ? '模型推断' : '未知'} · {evidence.reviewedAt ? '已核对' : '未核对'}</summary>
    {evidence.reviewedAt && <p className="mt-2 text-accent-green">核对于 {new Date(evidence.reviewedAt).toLocaleString()}</p>}
    {!evidence.refs.length && <p className="mt-2">无可追溯引用，不推定为事实。</p>}
    {evidence.refs.map((ref, index) => { const source = project.sources.find(item => item.id === ref.sourceId); return <div key={`${ref.sourceId}:${index}`} className="mt-2 rounded-lg border border-border p-2"><p className="whitespace-pre-wrap break-words selectable-text">{ref.quote || '无引用摘录'}</p>{source ? <button className="mt-2 text-accent-cyan hover:underline" onClick={() => onSource(source)}>查看来源：{source.title || source.sessionId}</button> : <p className="mt-2 text-accent-orange">来源 {ref.sourceId} 已不可用</p>}</div>; })}
  </details>;
}

function UncertaintyList({ project, save, busy }: { project: ManagedProject; save: (id: string, changes: ProjectChanges) => Promise<boolean>; busy: boolean }) {
  const unresolved = unresolvedUncertainties(project);
  const guidance = [...new Set([...(project.recognitionNotes || []), ...project.uncertainties.filter(isRecognitionGuidance)])];
  const resolved = [...new Set(project.uncertainties)].filter(item => !isRecognitionGuidance(item) && !unresolved.includes(item));
  const toggle = (item: string) => {
    if (busy || project.archivedAt || project.deletedAt) return;
    const next = new Set(project.resolvedUncertainties || []);
    if (next.has(item)) next.delete(item); else next.add(item);
    void save(project.id, { resolvedUncertainties: [...next] });
  };
  return <details className="rounded-xl border border-accent-orange/20 p-4 text-xs text-accent-orange">
    <summary className="cursor-pointer">需核对事项（未解决 {unresolved.length} / 共 {unresolved.length + resolved.length}）</summary>
    <div className="space-y-2 mt-3 selectable-text">
      {!unresolved.length && <p className="text-text-secondary">没有未解决的核对事项。</p>}
      {!!guidance.length && <details className="text-text-secondary"><summary className="cursor-pointer">识别原则与通用说明（不计入待整理）</summary>{guidance.map(item => <p key={item} className="mt-2 leading-6">{item}</p>)}</details>}
      {unresolved.map((item, index) => <div className="flex items-start justify-between gap-3 rounded-lg border border-accent-orange/15 bg-accent-orange/5 p-2" key={index}><p className="leading-6 break-words flex-1">{item}</p><button className="shrink-0 text-2xs text-accent-green hover:underline disabled:opacity-40" disabled={busy} onClick={() => toggle(item)}>标记已解决</button></div>)}
      {!!resolved.length && <details className="pt-2 text-text-secondary"><summary className="cursor-pointer">已解决（{resolved.length}）</summary><div className="space-y-2 mt-2">{resolved.map((item, index) => <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-2" key={index}><p className="leading-6 break-words flex-1 line-through opacity-70">{item}</p><button className="shrink-0 text-2xs text-accent-cyan hover:underline disabled:opacity-40" disabled={busy} onClick={() => toggle(item)}>恢复</button></div>)}</div></details>}
    </div>
  </details>;
}

function retrospectiveDraft(project: ManagedProject) {
  return {
    goal: project.retrospective?.goal || '', outcome: project.retrospective?.outcome || '',
    wentWell: project.retrospective?.wentWell || '', wentPoorly: project.retrospective?.wentPoorly || '',
    surprises: project.retrospective?.surprises || '', nextSteps: project.retrospective?.nextSteps || '',
  };
}

function RetrospectiveView({ project, save, busy }: { project: ManagedProject; save: (id: string, changes: ProjectChanges) => Promise<boolean>; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => retrospectiveDraft(project));
  const [localError, setLocalError] = useState<string | null>(null);
  const persist = async () => {
    if (busy || project.archivedAt || project.deletedAt) return;
    setLocalError(null);
    try {
      if (await save(project.id, { retrospective: { ...draft, updatedAt: Date.now() } })) setEditing(false);
      else setLocalError(useProjectsStore.getState().error || '复盘未保存，草稿已保留。');
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { const setDirty = useProjectsStore.getState().setDirty; setDirty(editing, 'retrospective'); return () => setDirty(false, 'retrospective'); }, [editing]);
  useEffect(() => { setDraft(retrospectiveDraft(project)); setEditing(false); }, [project.id, project.retrospective?.updatedAt]);
  const fields = [['goal', '最初目标'], ['outcome', '实际结果'], ['wentWell', '做得好的'], ['wentPoorly', '做得不好的'], ['surprises', '意外与风险'], ['nextSteps', '下次怎么做']] as const;
  return <section className="space-y-4">
    <div className="glass-panel rounded-xl p-5">
      <div className="flex items-center justify-between gap-3 mb-4"><div><h3 className="text-sm font-medium text-text-primary">项目复盘</h3><p className="text-xs text-text-secondary mt-1">{project.retrospective ? `上次更新于 ${new Date(project.retrospective.updatedAt).toLocaleString()}` : '还没有复盘记录。'}</p></div><button className={button} disabled={busy} onClick={() => { setDraft(retrospectiveDraft(project)); setEditing(value => !value); }}><Pencil className="w-3.5 h-3.5" />{editing ? '取消编辑' : '编辑复盘'}</button></div>
      {localError && <p role="alert" className="text-xs text-accent-red">{localError}</p>}
      {editing ? <form onSubmit={event => { event.preventDefault(); void persist(); }} className="space-y-4">
        {fields.map(([key, label]) => <label key={key} className="block text-xs text-text-secondary">{label}<textarea rows={key === 'outcome' || key === 'wentWell' || key === 'wentPoorly' ? 3 : 2} className={`${input} mt-1 resize-y`} value={draft[key]} maxLength={20000} disabled={busy} onChange={event => setDraft({ ...draft, [key]: event.target.value })} placeholder={label} /></label>)}
        <button className={`${button} border-accent-cyan/30 text-accent-cyan`} type="submit" disabled={busy}><Save className="w-4 h-4" />保存复盘</button>
      </form> : <dl className="space-y-4 selectable-text">{fields.map(([key, label]) => <div key={key}><dt className="text-xs text-text-secondary mb-1.5">{label}</dt><dd className={`text-sm whitespace-pre-wrap break-words leading-6 ${project.retrospective?.[key] ? 'text-text-primary' : 'text-text-secondary italic'}`}>{project.retrospective?.[key] || '尚未填写。'}</dd></div>)}</dl>}
    </div>
  </section>;
}

function projectArchiveMarkdown(project: ManagedProject) {
  const lines = [
    `# ${project.name}`,
    `- 目标：${project.goal}`,
    `- 项目工作目录：${project.workingDirectory || '未设置'}`,
    `- 状态：${PROJECT_LABELS[projectSummary(project).status]}`,
    `- 生命周期：${project.deletedAt ? '回收站' : project.archivedAt ? '已归档' : '活跃'}`,
    `- 进度：${progressLabel(projectSummary(project))}`,
    `- 标签：${(project.tags || []).join(', ') || '无'}`,
    `- 创建：${new Date(project.createdAt).toLocaleString()}`,
    `- 更新：${new Date(project.updatedAt).toLocaleString()}`,
    '',
    '## 背景',
    project.description && `简述：${project.description}`,
    project.background && `需求背景：${project.background}`,
    project.constraints && `约束条件：${project.constraints}`,
    project.decisions && `关键决策：${project.decisions}`,
    project.deliverables && `预期交付物：${project.deliverables}`,
    '',
    '## 任务',
    ...project.tasks.map(task => `- [${TASK_LABELS[task.status]}] ${task.name}${task.optional ? '（可选）' : ''}${task.description ? `：${task.description}` : ''}`),
    '',
    '## 复盘',
    project.retrospective ? [project.retrospective.goal && `最初目标：${project.retrospective.goal}`, project.retrospective.outcome && `实际结果：${project.retrospective.outcome}`, project.retrospective.wentWell && `做得好：${project.retrospective.wentWell}`, project.retrospective.wentPoorly && `做得不好：${project.retrospective.wentPoorly}`, project.retrospective.surprises && `意外与风险：${project.retrospective.surprises}`, project.retrospective.nextSteps && `下次怎么做：${project.retrospective.nextSteps}`].filter(Boolean).join('\n') : '尚未填写。',
    '',
    '## 历史来源',
    ...project.sources.map(source => `- [${source.kind === 'gui' ? 'GUI' : 'Claude Code'}] ${source.title || source.sessionId}${source.timestamp ? ` · ${new Date(source.timestamp).toLocaleString()}` : ''}\n  ${source.excerpt || '无摘录'}`),
    '',
    '## 待确认',
    ...(unresolvedUncertainties(project).length ? unresolvedUncertainties(project).map(item => `- ${item}`) : ['- 无']),
    '',
    '## 识别审计',
    project.audit ? `- 模式：${project.audit.mode === 'llm' ? 'LLM 语义识别' : '本地规则'}\n- 扫描时间：${new Date(project.audit.scannedAt).toLocaleString()}\n- 成本：${typeof project.audit.costUsd === 'number' ? `$${project.audit.costUsd.toFixed(4)}` : '未报告'}` : '- 无',
  ];
  return lines.filter(line => line !== undefined).join('\n');
}

function AuditView({ project }: { project: ManagedProject }) {
  const audit = project.audit;
  if (!audit) return <section className="glass-panel rounded-xl p-6 space-y-3"><h3 className="text-sm font-medium text-text-primary">识别审计</h3><p className="text-sm text-text-secondary leading-6">该项目为手动创建，或来自旧版本扫描，没有保存识别审计记录。</p></section>;
  const coverage = audit.coverage;
  return <section className="space-y-4">
    <div className="glass-panel rounded-xl p-5">
      <div className="flex items-center justify-between gap-3 mb-4"><div><h3 className="text-sm font-medium text-text-primary">最近一次识别</h3><p className="text-xs text-text-secondary mt-1">审计记录随项目保存，用于回看识别依据和覆盖范围。</p></div><span className="rounded-md bg-accent-cyan/10 px-2 py-1 text-xs text-accent-cyan">{audit.mode === 'llm' ? 'LLM 语义识别' : '本地规则识别'}</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">扫描时间</div><div className="mt-1 text-text-primary">{new Date(audit.scannedAt).toLocaleString()}</div></div>
        <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">模型</div><div className="mt-1 text-text-primary break-all">{audit.model || '规则/默认'}</div></div>
        <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">调用 / 批次</div><div className="mt-1 font-mono text-text-primary">{audit.calls ?? '—'} / {audit.batches ?? '—'}</div></div>
        <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">费用</div><div className="mt-1 font-mono text-text-primary">{typeof audit.costUsd === 'number' ? `$${audit.costUsd.toFixed(4)}` : '未报告'}</div></div>
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">GUI / CLI 会话</div><div className="mt-1 font-mono text-text-primary">{coverage.guiSessions} / {coverage.claudeSessions}</div></div>
        <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">跳过项</div><div className="mt-1 font-mono text-text-primary">{coverage.skipped}</div></div>
        <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">输入字符</div><div className="mt-1 font-mono text-text-primary">{audit.inputChars?.toLocaleString() ?? '—'}</div></div>
        <div className="rounded-lg bg-bg-light p-3"><div className="text-text-secondary">完整性</div><div className={`mt-1 ${coverage.incomplete ? 'text-accent-orange' : 'text-accent-green'}`}>{coverage.incomplete ? '不完整' : '已记录'}</div></div>
      </div>
    </div>
    {!!coverage.warnings.length && <details className="rounded-xl border border-accent-orange/20 p-4 text-xs text-accent-orange"><summary className="cursor-pointer">覆盖范围与限制（{coverage.warnings.length}）</summary><div className="mt-3 space-y-2 selectable-text">{coverage.warnings.map((warning, index) => <p className="leading-5 break-words" key={index}>{warning}</p>)}</div></details>}
    {!!audit.evidence?.length && <details className="rounded-xl border border-border p-4 text-xs text-text-secondary"><summary className="cursor-pointer">识别依据（{audit.evidence.length}）</summary><div className="mt-3 space-y-2 selectable-text">{audit.evidence.map((evidence, index) => <p className="leading-5 break-words" key={index}>{evidence}</p>)}</div></details>}
    {!!project.auditHistory?.length && <details className="rounded-xl border border-border p-4 text-xs text-text-secondary"><summary className="cursor-pointer">历史识别记录（{project.auditHistory.length}）</summary><div className="mt-3 space-y-2">{[...project.auditHistory].reverse().map((item, index) => <div className="rounded-lg border border-border p-2" key={index}><p className="text-text-primary">{new Date(item.scannedAt).toLocaleString()} · {item.mode === 'llm' ? 'LLM' : '规则'} · {typeof item.costUsd === 'number' ? `$${item.costUsd.toFixed(4)}` : '费用未报告'}</p><p className="mt-1 text-text-secondary">覆盖：GUI {item.coverage.guiSessions} / CLI {item.coverage.claudeSessions} · 跳过 {item.coverage.skipped}{item.coverage.incomplete ? ' · 不完整' : ''}</p></div>)}</div></details>}
  </section>;
}

function Pager({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (page: number) => void }) {
  const pages = Math.ceil(total / size);
  if (pages < 2) return null;
  return <nav aria-label="分页" className="flex items-center justify-center gap-3 py-3"><button className={button} onClick={() => onChange(page - 1)} disabled={!page}>上一页</button><span className="text-xs text-text-secondary font-mono">{page + 1}/{pages}</span><button className={button} onClick={() => onChange(page + 1)} disabled={page + 1 >= pages}>下一页</button></nav>;
}
