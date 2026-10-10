import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, FileText, GitBranch, ListTodo, Pencil, Plus, Save, Search, X } from 'lucide-react';
import { useProjectsStore } from '../projectStore';
import { PROJECT_LABELS, TASK_LABELS, TASK_STATUSES, projectSummary } from '../projectModel';
import type { ManagedProject, ProjectSource, ProjectTask, TaskStatus } from '../projectTypes';
import { ProjectWorkflow } from './ProjectWorkflow';
import { ProjectTaskDetail } from './ProjectTaskDetail';

const button = 'inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-xs text-text-secondary hover:text-text-primary hover:bg-bg-light disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
const input = 'w-full rounded-lg border border-border bg-bg-deepest px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-cyan/50';
const tabs = [
  { id: 'background', label: '背景与文件', icon: FileText },
  { id: 'tasks', label: '任务列表', icon: ListTodo },
  { id: 'workflow', label: '工作流', icon: GitBranch },
  { id: 'sources', label: '历史来源', icon: Search },
] as const;
type Tab = typeof tabs[number]['id'];
type BackgroundDraft = Pick<ManagedProject, 'name' | 'description' | 'goal' | 'background' | 'constraints' | 'decisions' | 'deliverables'>;
const backgroundDraft = (project: ManagedProject): BackgroundDraft => ({
  name: project.name, description: project.description, goal: project.goal, background: project.background,
  constraints: project.constraints, decisions: project.decisions, deliverables: project.deliverables,
});

export function ProjectDetail({ project, onBack, onSource, onPreview, onReveal }: {
  project: ManagedProject;
  onBack: () => void;
  onSource: (source: ProjectSource) => void;
  onPreview: (path: string) => void;
  onReveal: (path: string) => Promise<void>;
}) {
  const save = useProjectsStore(state => state.save);
  const busy = useProjectsStore(state => state.operation !== null || state.loading);
  const [tab, setTab] = useState<Tab>('background');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => backgroundDraft(project));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskSearch, setTaskSearch] = useState('');
  const [taskFilter, setTaskFilter] = useState<TaskStatus | 'all'>('all');
  const [taskPage, setTaskPage] = useState(0);
  const [filePage, setFilePage] = useState(0);
  const [sourcePage, setSourcePage] = useState(0);
  const [newTask, setNewTask] = useState<string | null>(null);
  const summary = projectSummary(project);
  useEffect(() => { setTaskPage(0); }, [taskSearch, taskFilter]);
  const selectedTask = project.tasks.find(task => task.id === selectedTaskId);
  const tasks = useMemo(() => project.tasks.filter(task => (taskFilter === 'all' || task.status === taskFilter) &&
    `${task.name}\n${task.description}`.toLowerCase().includes(taskSearch.toLowerCase())), [project.tasks, taskSearch, taskFilter]);
  const safeTaskPage = Math.min(taskPage, Math.max(0, Math.ceil(tasks.length / 24) - 1));
  const visibleIds = new Set(tasks.slice(safeTaskPage * 24, (safeTaskPage + 1) * 24).map(task => task.id));
  // Group only the current page; counts and filters always refer to all tasks.
  const groupTasks = (status: TaskStatus) => tasks.filter(task => task.status === status && visibleIds.has(task.id));
  const selectTask = (id: string) => setSelectedTaskId(id);
  const updateStatus = (task: ProjectTask, status: TaskStatus) => void save(project.id, { tasks: project.tasks.map(item => item.id === task.id ? { ...item, status } : item) });
  const addTask = async () => {
    if (!newTask?.trim()) return;
    const task: ProjectTask = {
      id: `manual:${crypto.randomUUID()}`, name: newTask.trim(), description: '', status: 'pending',
      inputs: [], outputs: [], dependsOn: [], dependencyNote: '用户新增任务，依赖尚未确认', sourceIds: [], records: [],
    };
    if (await save(project.id, { tasks: [...project.tasks, task], goalConfirmed: false })) {
      setNewTask(null); setSelectedTaskId(task.id); setTaskFilter('all'); setTaskSearch('');
    }
  };
  const saveBackground = async () => {
    if (await save(project.id, draft)) setEditing(false);
  };

  return <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
    <div className="shrink-0 px-6 py-3 border-b border-border/50 space-y-2">
      <button className="flex items-center gap-1 text-xs text-text-secondary hover:text-accent-cyan" onClick={onBack}><ArrowLeft className="w-3.5 h-3.5" />项目总览</button>
      <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h2 className="text-xl font-semibold text-text-primary break-words">{project.name}</h2>{tab !== 'workflow' && <p className="text-sm text-text-secondary leading-6 mt-2 line-clamp-2 selectable-text">{project.description || project.goal}</p>}</div><span className={`shrink-0 text-xs py-1.5 px-3 rounded-lg ${summary.status === 'completed' ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-cyan/10 text-accent-cyan'}`}>{PROJECT_LABELS[summary.status]}</span></div>
      <div className="flex flex-wrap items-center gap-4"><div className="h-2 rounded-full bg-bg-lighter overflow-hidden flex-1 min-w-[120px]"><div className="h-full bg-accent-cyan rounded-full transition-[width]" style={{ width: `${summary.progress}%` }} /></div><span className="text-xs text-text-secondary font-mono">{summary.progress}% · {summary.counts.completed}/{summary.total} 任务完成</span></div>
      <label className={`flex items-center gap-2 text-xs leading-5 ${summary.allTasksComplete ? 'text-accent-green cursor-pointer' : 'text-text-secondary'}`}><input type="checkbox" checked={project.goalConfirmed} disabled={busy || !summary.allTasksComplete} onChange={event => void save(project.id, { goalConfirmed: event.target.checked })} className="accent-accent-green" /><CheckCircle2 className="w-3.5 h-3.5" />我已核对交付物，确认项目目标达成{!summary.allTasksComplete && '（需先完成所有任务）'}</label>
      <nav className="flex flex-wrap gap-2" aria-label="项目详情导航">{tabs.map(item => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)} className={`${button} ${tab === item.id ? 'border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan' : ''}`}><item.icon className="w-3.5 h-3.5" />{item.label}</button>)}</nav>
    </div>
    <div className="flex flex-1 min-h-0 overflow-hidden relative">
      <div className={`flex flex-col flex-1 min-w-0 min-h-0 ${tab === 'workflow' ? 'overflow-auto p-3' : 'overflow-y-auto p-6'}`}>
        {tab === 'background' && <div className="space-y-5">
          <section className="glass-panel rounded-xl p-5"><div className="flex items-center justify-between gap-3 mb-4"><h3 className="text-sm font-medium text-text-primary">项目背景</h3><button className={button} disabled={busy} onClick={() => { setDraft(backgroundDraft(project)); setEditing(!editing); }}><Pencil className="w-3.5 h-3.5" />{editing ? '取消编辑' : '编辑背景'}</button></div>
            {editing ? <form onSubmit={event => { event.preventDefault(); void saveBackground(); }} className="space-y-4">
              <label className="block text-xs text-text-secondary">项目名称<input className={`${input} mt-1`} value={draft.name} required maxLength={500} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
              {([['description', '简述'], ['goal', '目标'], ['background', '需求背景'], ['constraints', '约束条件'], ['decisions', '关键决策'], ['deliverables', '预期交付物']] as const).map(([key, label]) => <label key={key} className="block text-xs text-text-secondary">{label}<textarea rows={key === 'background' ? 4 : 2} className={`${input} mt-1 resize-y`} value={draft[key]} required={key === 'goal'} maxLength={20000} disabled={busy} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>)}
              <p className="text-xs text-accent-orange">只填写已知信息。变更项目目标后需要重新确认目标达成。</p><button className={`${button} text-accent-cyan border-accent-cyan/30`} type="submit" disabled={busy}><Save className="w-4 h-4" />{busy ? '保存中…' : '保存背景'}</button>
            </form> : <dl className="space-y-4 selectable-text">{([['goal', '项目目标'], ['background', '需求背景'], ['constraints', '约束条件'], ['decisions', '关键决策'], ['deliverables', '预期交付物']] as const).map(([key, label]) => <div key={key}><dt className="text-xs text-text-secondary mb-1.5">{label}</dt><dd className={`text-sm whitespace-pre-wrap break-words leading-6 ${project[key] ? 'text-text-primary' : 'text-text-secondary italic'}`}>{project[key] || '历史未提供，待确认。可在编辑背景中补充。'}</dd></div>)}</dl>}
          </section>
          <section className="glass-panel rounded-xl p-5"><h3 className="text-sm font-medium text-text-primary mb-4">关联文件 <span className="text-text-secondary font-mono">{project.files.length}</span></h3><p className="text-xs text-text-secondary mb-4 leading-5">保留成功文件操作的来源和用途；工具写入不等于产物已验收。预览和定位均需当前系统可访问文件。</p>
            {!project.files.length && <p className="text-sm text-text-secondary">没有可靠的文件操作记录。任务中可手动登记已确认的输入与输出。</p>}
            <div className="space-y-3">{project.files.slice(filePage * 16, (filePage + 1) * 16).map((file, index) => <div className="rounded-lg border border-border bg-bg-deepest/60 p-3" key={`${file.path}:${file.sourceId}:${index}`}><div className="flex items-start gap-2"><FileText className="w-4 h-4 text-accent-cyan shrink-0 mt-0.5" /><div className="min-w-0 flex-1"><div className="text-sm text-text-primary break-words">{file.path.split(/[\\/]/).pop()}</div><p className="text-xs font-mono text-text-secondary mt-1 break-all selectable-text">{file.path}</p><p className="text-xs text-text-secondary mt-2">{file.purpose || '用途未记录，待确认'}</p></div></div><div className="flex gap-2 mt-3"><button className={button} onClick={() => onPreview(file.path)}>预览</button><button className={button} onClick={() => void onReveal(file.path)}>定位文件</button>{project.sources.find(source => source.id === file.sourceId) && <button className={button} onClick={() => onSource(project.sources.find(source => source.id === file.sourceId)!)}>操作来源</button>}</div></div>)}</div><Pager page={filePage} total={project.files.length} size={16} onChange={setFilePage} />
          </section>
          <details className="rounded-xl border border-accent-orange/20 p-4 text-xs text-accent-orange"><summary className="cursor-pointer">历史信息的不确定之处（{project.uncertainties.length}）</summary><div className="space-y-2 mt-3 selectable-text">{project.uncertainties.map((item, index) => <p className="leading-6 break-words" key={index}>{item}</p>)}</div></details>
        </div>}
        {tab === 'tasks' && <div className="space-y-4">
          <div className="flex flex-wrap gap-2 items-center"><div className="relative flex-1 min-w-[160px]"><Search className="absolute left-3 top-2.5 w-4 h-4 text-text-secondary" /><input aria-label="搜索任务" className={`${input} pl-9`} value={taskSearch} onChange={event => setTaskSearch(event.target.value)} placeholder="搜索任务名称或说明" /></div><button className={button} disabled={busy} onClick={() => setNewTask('')}><Plus className="w-4 h-4" />新增任务</button></div>
          {newTask !== null && <form onSubmit={event => { event.preventDefault(); void addTask(); }} className="flex flex-wrap gap-2 rounded-xl p-3 border border-accent-cyan/30 bg-accent-cyan/5"><input className={`${input} flex-1 min-w-[160px]`} autoFocus aria-label="新任务名称" placeholder="填写明确的任务名称" required maxLength={500} value={newTask} disabled={busy} onChange={event => setNewTask(event.target.value)} /><button className={button} type="submit" disabled={busy || !newTask.trim()}>添加</button><button className={button} type="button" disabled={busy} onClick={() => setNewTask(null)}><X className="w-4 h-4" /></button></form>}
          <div className="flex flex-wrap gap-2" aria-label="任务状态筛选">{(['all', ...TASK_STATUSES] as const).map(status => <button className={`${button} ${taskFilter === status ? 'border-accent-cyan/40 text-accent-cyan bg-accent-cyan/10' : ''}`} key={status} aria-pressed={taskFilter === status} onClick={() => setTaskFilter(status)}>{status === 'all' ? `全部 (${project.tasks.length})` : `${TASK_LABELS[status]} (${summary.counts[status]})`}</button>)}</div>
          {!tasks.length && <p className="text-sm text-text-secondary py-6">没有匹配任务。可调整搜索条件或新增任务。</p>}
          {TASK_STATUSES.map(status => {
            const members = groupTasks(status);
            if (!members.length) return null;
            return <section key={status}><h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">{TASK_LABELS[status]}</h3><div className="space-y-2">{members.map(task => <div key={task.id} className={`flex items-start gap-3 rounded-xl p-4 border ${selectedTaskId === task.id ? 'border-accent-cyan/40 bg-accent-cyan/5' : 'border-border bg-bg-light/40'}`}><button className="flex-1 min-w-0 text-left" onClick={() => selectTask(task.id)}><h4 className="text-sm text-text-primary hover:text-accent-cyan break-words">{task.name}</h4><p className="text-xs text-text-secondary leading-5 mt-1 line-clamp-2">{task.description || '说明未记录，点击查看详情或补充信息。'}</p><p className="text-[11px] text-text-secondary mt-2">{task.dependsOn.length ? `${task.dependsOn.length} 个前置依赖` : '依赖待确认'} · {task.sourceIds.length} 条来源</p></button><select aria-label={`任务状态 ${task.name}`} className="rounded-lg bg-bg-deepest border border-border p-1.5 text-xs text-text-secondary shrink-0" value={task.status} disabled={busy} onChange={event => updateStatus(task, event.target.value as TaskStatus)}>{TASK_STATUSES.map(status => <option key={status} value={status}>{TASK_LABELS[status]}</option>)}</select></div>)}</div></section>;
          })}<Pager page={safeTaskPage} total={tasks.length} size={24} onChange={setTaskPage} />
        </div>}
        {tab === 'workflow' && <ProjectWorkflow project={project} selectedTaskId={selectedTaskId} onSelectTask={selectTask} />}
        {tab === 'sources' && <section className="space-y-3"><h3 className="text-sm text-text-primary font-medium">可追溯的历史来源</h3><p className="text-xs text-text-secondary leading-5">GUI 会话可直接定位消息；已从 GUI 清理或仅在 Claude Code 本地保存的会话展示来源摘录与记录路径。整理结果保留在项目中，不依赖原会话仍被保留。</p>{!project.sources.length && <p className="text-sm text-text-secondary py-6">没有历史来源。</p>}{project.sources.slice(sourcePage * 20, (sourcePage + 1) * 20).map(item => <button className="w-full text-left p-4 glass-panel glass-panel-hover rounded-xl" key={item.id} onClick={() => onSource(item)}><p className="text-xs text-accent-cyan mb-2">{item.kind === 'gui' ? 'GUI 会话' : 'Claude Code 本地记录'} · {item.title || item.sessionId}</p><p className="text-xs text-text-secondary leading-6 whitespace-pre-wrap break-words line-clamp-4 selectable-text">{item.excerpt || '工具调用或执行结果来源（无文本摘要）'}</p><p className="mt-2 font-mono text-[11px] text-text-secondary break-all">{item.path || item.cwd || '工作目录未记录'}</p></button>)}<Pager page={sourcePage} total={project.sources.length} size={20} onChange={setSourcePage} /></section>}
      </div>
      {selectedTask && <ProjectTaskDetail key={selectedTask.id} project={project} task={selectedTask} onClose={() => setSelectedTaskId(null)} onSource={onSource} onSelectTask={selectTask} />}
    </div>
  </div>;
}

function Pager({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (page: number) => void }) {
  const pages = Math.ceil(total / size);
  if (pages < 2) return null;
  return <nav aria-label="分页" className="flex items-center justify-center gap-3 py-3"><button className={button} onClick={() => onChange(page - 1)} disabled={!page}>上一页</button><span className="text-xs text-text-secondary font-mono">{page + 1}/{pages}</span><button className={button} onClick={() => onChange(page + 1)} disabled={page + 1 >= pages}>下一页</button></nav>;
}
