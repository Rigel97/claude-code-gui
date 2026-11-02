import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Ban, CheckCircle2, Circle, CircleDot, ExternalLink, Pencil, X } from 'lucide-react';
import { dependencyError, taskEditChanges, TASK_LABELS, TASK_STATUSES } from '../projectModel';
import { useStore } from '../store';
import { useProjectsStore } from '../projectStore';
import type { ManagedProject, ProjectSource, ProjectTask, TaskStatus } from '../projectTypes';

export interface ProjectTaskDetailProps {
  project: ManagedProject;
  task: ProjectTask;
  onClose: () => void;
  onSource: (source: ProjectSource) => void;
  onSelectTask?: (id: string) => void;
  onStartTask?: (taskId: string) => void;
}

const BUTTON = 'rounded-lg border border-border-light px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan disabled:cursor-not-allowed disabled:opacity-40';
const INPUT = 'mt-1 w-full rounded-lg border border-border-light bg-bg-deepest px-3 py-2 text-xs leading-relaxed text-text-primary outline-none focus:border-accent-cyan disabled:opacity-50';
const STATUS_STYLE: Record<TaskStatus, string> = {
  pending: 'text-accent-orange', in_progress: 'text-accent-cyan', completed: 'text-accent-green', cancelled: 'text-text-secondary',
};
const STATUS_ICON = { pending: Circle, in_progress: CircleDot, completed: CheckCircle2, cancelled: Ban };
const PAGE_SIZE = 10;

interface TaskDraft {
  name: string;
  description: string;
  status: TaskStatus;
  optional: boolean;
  inputs: string;
  outputs: string;
  dependsOn: string[];
  dependencyNote: string;
  dependencyConfirmed: boolean;
}

function draftOf(task: ProjectTask): TaskDraft {
  return { name: task.name, description: task.description, status: task.status, optional: task.optional === true,
    inputs: task.inputs.join('\n'), outputs: task.outputs.join('\n'),
    dependsOn: [...task.dependsOn], dependencyNote: task.dependencyNote, dependencyConfirmed: false };
}

function lines(text: string) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-2 border-t border-border/60 pt-4"><h3 className="text-xs font-medium text-text-primary">{title}</h3>{children}</section>;
}

function Values({ items }: { items: string[] }) {
  const values = items.filter(item => item.trim());
  return values.length ? <ul className="list-inside list-disc space-y-1 text-xs leading-relaxed text-text-secondary">{values.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{item}</li>)}</ul>
    : <p className="text-xs text-accent-orange">待确认（暂无记录，不推定为无）</p>;
}

function PagedList<T>({ items, label, render }: { items: T[]; label: string; render: (item: T, index: number) => ReactNode }) {
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  return <div className="space-y-2">
    {items.length ? <ul className="space-y-2">{items.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((item, index) => <li key={currentPage * PAGE_SIZE + index}>{render(item, currentPage * PAGE_SIZE + index)}</li>)}</ul>
      : <p className="text-xs text-text-secondary">暂无{label}，待确认。</p>}
    {items.length > PAGE_SIZE && <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-secondary">
      <span role="status">{items.length} 项 · {currentPage + 1} / {lastPage + 1} 页</span>
      <div className="flex gap-1"><button type="button" className={BUTTON} aria-label={`${label}上一页`} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button type="button" className={BUTTON} aria-label={`${label}下一页`} disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
    </div>}
  </div>;
}

export function ProjectTaskDetail(props: ProjectTaskDetailProps) {
  return <TaskDetailContent key={`${props.project.id}:${props.task.id}`} {...props} />;
}

function TaskDetailContent({ project, task, onClose, onSource, onSelectTask, onStartTask }: ProjectTaskDetailProps) {
  const save = useProjectsStore(state => state.save);
  const operation = useProjectsStore(state => state.writeOperation);
  const startConversation = useProjectsStore(state => state.startConversation);
  const conversations = useStore(state => state.conversations);
  const sessions = useStore(state => state.sessions);
  const readonly = !!(project.archivedAt || project.deletedAt);
  const taskLinks = (project.conversations || []).filter(link => link.taskId === task.id);
  const loading = useProjectsStore(state => state.loading);
  const storeError = useProjectsStore(state => state.error);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TaskDraft>(() => draftOf(task));
  const [baseline, setBaseline] = useState(task);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [dependencySearch, setDependencySearch] = useState('');
  const [dependencyPage, setDependencyPage] = useState(0);
  useEffect(() => {
    const setDirty = useProjectsStore.getState().setDirty;
    setDirty(editing, 'task');
    return () => setDirty(false, 'task');
  }, [editing]);
  const prefix = useId();
  const titleId = `${prefix}-title`;
  const busy = saving || !!operation || loading;
  const editBusy = busy || readonly;
  const tasksById = useMemo(() => new Map(project.tasks.map(item => [item.id, item])), [project.tasks]);
  const sourcesById = useMemo(() => new Map(project.sources.map(source => [source.id, source])), [project.sources]);
  const unfinishedDependencies = task.dependsOn.map(id => tasksById.get(id)).filter(item => item && item.status !== 'completed');
  const following = useMemo(() => project.tasks.filter(item => item.dependsOn.includes(task.id)), [project.tasks, task.id]);
  const dependencyResults = useMemo(() => {
    const query = dependencySearch.trim().toLocaleLowerCase();
    return project.tasks.filter(item => item.id !== task.id && (!query || `${item.name} ${item.description} ${item.id}`.toLocaleLowerCase().includes(query)));
  }, [project.tasks, task.id, dependencySearch]);
  const lastDependencyPage = Math.max(0, Math.ceil(dependencyResults.length / PAGE_SIZE) - 1);
  const currentDependencyPage = Math.min(dependencyPage, lastDependencyPage);
  const dependencyChanged = draft.dependencyNote !== baseline.dependencyNote || draft.dependsOn.length !== baseline.dependsOn.length || draft.dependsOn.some(id => !baseline.dependsOn.includes(id));
  const draftTask: ProjectTask = { ...task, name: draft.name.trim(), description: draft.description.trim(),
    status: draft.status, optional: draft.optional, inputs: lines(draft.inputs), outputs: lines(draft.outputs),
    dependsOn: draft.dependsOn, dependencyNote: draft.dependencyNote.trim() };
  const invalidDependency = editing ? dependencyError(project.tasks.map(item => item.id === task.id ? draftTask : item)) : null;

  const startEditing = () => {
    if (editBusy) return;
    setDraft(draftOf(task)); setBaseline({ ...task, optional: task.optional === true }); setEditing(true); setLocalError(null);
    setDependencySearch(''); setDependencyPage(0);
  };
  const cancelEditing = () => { if (!busy) { setEditing(false); setLocalError(null); } };
  const requestClose = () => {
    if (busy || !useProjectsStore.getState().confirmDiscard('关闭任务详情', ['task'])) return;
    onClose();
  };
  const setField = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value,
      ...((key === 'dependsOn' || key === 'dependencyNote') ? { dependencyConfirmed: false } : {}) }));
    setLocalError(null);
  };

  const persist = async (changes: Partial<ProjectTask>) => {
    const state = useProjectsStore.getState();
    if (readonly || savingRef.current || state.writeOperation || state.loading) return false;
    const latestProject = state.projects.find(item => item.id === project.id);
    const latestTask = latestProject?.tasks.find(item => item.id === task.id);
    if (latestProject?.archivedAt || latestProject?.deletedAt) { setLocalError('只读，恢复后可编辑。'); return false; }
    if (!latestProject || !latestTask) { setLocalError('项目或任务已不存在，请重新加载。'); return false; }
    const tasks = latestProject.tasks.map(item => item.id === task.id ? { ...latestTask, ...changes } : item);
    const invalid = dependencyError(tasks);
    if (invalid) { setLocalError(invalid); return false; }
    savingRef.current = true; setSaving(true); setLocalError(null);
    try {
      const success = await save(project.id, { tasks });
      if (!success) setLocalError(useProjectsStore.getState().error || '更改未保存，请稍后重试。草稿已保留。');
      return success;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '保存失败，草稿已保留。');
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editBusy) return;
    if (!draftTask.name) { setLocalError('任务名称不能为空。'); return; }
    if (invalidDependency) { setLocalError(invalidDependency); return; }
    if (dependencyChanged && !draft.dependencyConfirmed) { setLocalError('请手动确认依赖关系及说明；未知关系不能自动视为事实。'); return; }
    if (draft.dependencyConfirmed && !draft.dependencyNote.trim()) { setLocalError('请填写已核实的依赖说明，包括明确无依赖的情况。'); return; }
    const latestTask = useProjectsStore.getState().projects.find(item => item.id === project.id)?.tasks.find(item => item.id === task.id);
    if (!latestTask) { setLocalError('任务不存在，请重新加载。'); return; }
    const dependencyNote = draft.dependencyConfirmed
      ? `用户已确认：${draft.dependencyNote.trim().replace(/^用户已确认：/, '')}` : baseline.dependencyNote;
    let changes: Partial<ProjectTask>;
    try { changes = taskEditChanges(baseline, { ...draftTask, dependencyNote }, latestTask); }
    catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); return; }
    if (!Object.keys(changes).length || await persist(changes)) setEditing(false);
  };

  const openConversation = async (conversationId: string) => {
    if (editBusy || savingRef.current) return;
    savingRef.current = true; setSaving(true); setLocalError(null);
    try {
      if (!await startConversation(project.id, task.id, conversationId)) setLocalError(useProjectsStore.getState().error || '关联对话不可用，未创建替代对话。');
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
    finally { savingRef.current = false; setSaving(false); }
  };

  const taskLink = (id: string) => {
    const related = tasksById.get(id);
    if (!related) return <span className="text-xs text-accent-orange">缺失任务：{id}（待修正）</span>;
    return <button type="button" disabled={busy || !onSelectTask} onClick={() => onSelectTask?.(id)} className="flex w-full items-start justify-between gap-2 rounded-lg border border-border-light bg-bg-light px-3 py-2 text-left text-xs hover:border-accent-cyan/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan disabled:cursor-default disabled:opacity-70">
      <span className="min-w-0 break-words text-text-primary">{related.name || '未命名任务'}</span><span className={`shrink-0 text-[10px] ${STATUS_STYLE[related.status]}`}>{TASK_LABELS[related.status]}</span>
    </button>;
  };

  return (
    <aside aria-labelledby={titleId} aria-busy={busy} className="absolute inset-y-0 right-0 z-20 flex w-[340px] max-w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-bg-deep animate-fade-in shadow-2xl xl:static xl:z-auto xl:shadow-none" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); requestClose(); }
    }}>
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0"><p className="mb-1 text-[10px] font-mono text-accent-cyan">任务详情</p><h2 id={titleId} className="break-words text-sm font-medium text-text-primary">{task.name || '未命名任务'}</h2></div>
        <div className="flex shrink-0 gap-1">
          {!editing && <button type="button" className={`${BUTTON} px-2`} aria-label="编辑任务" disabled={editBusy} onClick={startEditing}><Pencil size={14} /></button>}
          <button type="button" className={`${BUTTON} px-2`} aria-label="关闭任务详情" disabled={busy} onClick={requestClose}><X size={15} /></button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {(localError || storeError) && <p role="alert" className="rounded-lg border border-accent-orange/25 bg-accent-orange/5 p-3 text-xs leading-relaxed text-accent-orange">{localError || storeError}</p>}
        {readonly && <p role="status" className="rounded-lg border border-border p-2 text-xs text-text-secondary">只读，恢复后可编辑</p>}
        {onStartTask && <Section title="任务对话"><button type="button" className={`${BUTTON} text-accent-cyan`} disabled={editBusy} onClick={() => onStartTask(task.id)}>为此任务新建对话</button><p className="text-[11px] leading-relaxed text-text-secondary">生成任务草稿，不会自动发送或执行；任务依赖不会自动调度。</p></Section>}
        {!!taskLinks.length && <Section title={`关联对话与运行记录 · ${taskLinks.length}`}><PagedList items={taskLinks} label="关联运行记录" render={link => {
          const available = conversations.some(item => item.id === link.conversationId || (!!link.sessionId && item.sessionId === link.sessionId)) || sessions.some(item => !!link.sessionId && item.sessionId === link.sessionId);
          const source = project.sources.find(item => !!link.sessionId && item.sessionId === link.sessionId && (!link.lastRun?.messageId || item.messageId === link.lastRun.messageId));
          return <div className="rounded-lg border border-border-light bg-bg-light p-3 space-y-2 text-xs text-text-secondary"><p className="text-text-primary break-words">{link.title || '未命名对话'}</p><p className="font-mono break-all">{link.cwd || '目录未记录'}</p><p>{link.lastRun ? ({ completed: '运行结束', failed: '运行失败', aborted: '运行已中止' }[link.lastRun.status]) : '暂无运行记录'}{link.lastRun && !link.reviewedAt && <span className="ml-2 text-accent-orange">待核对进展</span>}</p>{link.lastRun && <><p className="text-accent-orange">运行摘录（未经核验） · {new Date(link.lastRun.recordedAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words selectable-text">{link.lastRun.excerpt || '无摘录'}</p></>}{link.reviewedAt && <p className="text-accent-green">进展已核对（非任务验收）</p>}<button type="button" className={BUTTON} disabled={editBusy || !available} onClick={() => void openConversation(link.conversationId)}>打开关联对话</button>{source && <button type="button" className={`${BUTTON} ml-2`} onClick={() => onSource(source)}>查看真实来源</button>}{!available && <p className="text-accent-orange">对话已不可用，保留运行摘录供回溯。</p>}<p className="text-[11px]">运行记录与进展核对不会自动完成任务或项目。</p></div>;
        }} /></Section>}
        {editing ? (
          <form onSubmit={submit} className="space-y-4">
            <fieldset disabled={editBusy} className="space-y-4">
              <legend className="mb-3 text-xs font-medium text-accent-cyan">编辑任务</legend>
              <label className="block text-xs text-text-secondary" htmlFor={`${prefix}-name`}>名称<input id={`${prefix}-name`} autoFocus required value={draft.name} onChange={event => setField('name', event.target.value)} className={INPUT} /></label>
              <label className="block text-xs text-text-secondary" htmlFor={`${prefix}-description`}>说明<textarea id={`${prefix}-description`} rows={3} value={draft.description} onChange={event => setField('description', event.target.value)} className={INPUT} /></label>
              <label className="block text-xs text-text-secondary" htmlFor={`${prefix}-status`}>任务状态<select id={`${prefix}-status`} value={draft.status} onChange={event => setField('status', event.target.value as TaskStatus)} className={INPUT}>{TASK_STATUSES.map(status => <option key={status} value={status}>{TASK_LABELS[status]}</option>)}</select></label>
              <label className="flex items-start gap-2 rounded-lg border border-border-light p-3 text-xs leading-relaxed text-text-secondary"><input type="checkbox" checked={draft.optional} onChange={event => setField('optional', event.target.checked)} className="mt-1 accent-accent-cyan" /><span>可选任务<span className="block text-[11px] text-text-dim">可选任务不计入项目进度，也不阻止目标验收。</span></span></label>
              <label className="block text-xs text-text-secondary" htmlFor={`${prefix}-inputs`}>输入（每行一项；空白保留待确认）<textarea id={`${prefix}-inputs`} rows={3} value={draft.inputs} onChange={event => setField('inputs', event.target.value)} className={INPUT} /></label>
              <label className="block text-xs text-text-secondary" htmlFor={`${prefix}-outputs`}>输出（每行一项；空白保留待确认）<textarea id={`${prefix}-outputs`} rows={3} value={draft.outputs} onChange={event => setField('outputs', event.target.value)} className={INPUT} /></label>
              <fieldset className="space-y-2 border-t border-border pt-3">
                <legend className="px-1 text-xs text-text-primary">前置依赖多选 · 已选 {draft.dependsOn.length} 项</legend>
                <p className="text-[11px] leading-relaxed text-text-secondary">只选择有依据的前置任务。不能依赖自身，也不能形成循环；未选任务不代表已核实无依赖。</p>
                <label htmlFor={`${prefix}-dependency-search`} className="block text-xs text-text-secondary">搜索可选任务<input id={`${prefix}-dependency-search`} type="search" value={dependencySearch} onChange={event => { setDependencySearch(event.target.value); setDependencyPage(0); }} className={INPUT} placeholder="名称、说明或标识" /></label>
                {draft.dependsOn.length > 0 && <details className="rounded-lg border border-border-light p-2 text-xs text-text-secondary"><summary className="cursor-pointer">已选依赖（可移除）</summary><PagedList items={draft.dependsOn} label="已选依赖" render={id => <label className="flex items-start gap-2 py-1"><input type="checkbox" checked onChange={() => setField('dependsOn', draft.dependsOn.filter(value => value !== id))} className="mt-0.5 accent-accent-cyan" /><span className="break-words">{tasksById.get(id)?.name || `缺失任务：${id}`}</span></label>} /></details>}
                <div className="max-h-60 space-y-1 overflow-auto rounded-lg border border-border-light bg-bg-light p-2">
                  {dependencyResults.slice(currentDependencyPage * PAGE_SIZE, (currentDependencyPage + 1) * PAGE_SIZE).map(item => <label key={item.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-2 text-xs text-text-secondary hover:bg-white/5"><input type="checkbox" checked={draft.dependsOn.includes(item.id)} onChange={event => setField('dependsOn', event.target.checked ? [...draft.dependsOn, item.id] : draft.dependsOn.filter(id => id !== item.id))} className="mt-0.5 accent-accent-cyan" /><span className="break-words">{item.name || '未命名任务'}</span></label>)}
                  {!dependencyResults.length && <p className="p-2 text-xs text-text-secondary">没有匹配的可选任务。</p>}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-secondary"><span role="status">{dependencyResults.length} 项 · {currentDependencyPage + 1} / {lastDependencyPage + 1} 页</span><div className="flex gap-1"><button type="button" className={BUTTON} disabled={busy || currentDependencyPage === 0} onClick={() => setDependencyPage(currentDependencyPage - 1)}>上一页</button><button type="button" className={BUTTON} disabled={busy || currentDependencyPage === lastDependencyPage} onClick={() => setDependencyPage(currentDependencyPage + 1)}>下一页</button></div></div>
                {invalidDependency && <p role="alert" className="text-xs text-accent-orange">{invalidDependency}</p>}
              </fieldset>
              <label htmlFor={`${prefix}-dependency-note`} className="block text-xs text-text-secondary">依赖说明（保留未知信息，或填写核实结果）<textarea id={`${prefix}-dependency-note`} rows={3} value={draft.dependencyNote} onChange={event => setField('dependencyNote', event.target.value)} className={INPUT} placeholder="待确认；核实无依赖时请明确说明" /></label>
              <label className="flex items-start gap-2 text-xs leading-relaxed text-text-secondary"><input type="checkbox" checked={draft.dependencyConfirmed} onChange={event => setField('dependencyConfirmed', event.target.checked)} className="mt-1 accent-accent-cyan" /><span>我已核实所选依赖和说明，将上述说明确认为事实。未核实的未知说明请勿勾选。</span></label>
              <p className="text-[11px] leading-relaxed text-text-secondary">状态改变不会生成执行记录。必要任务未完成或验收范围变化时会撤销目标验收，并显示原因。</p>
            </fieldset>
            <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-bg-deep py-3"><button type="button" className={BUTTON} disabled={busy} onClick={cancelEditing}>取消</button><button type="submit" className={`${BUTTON} border-accent-cyan/40 text-accent-cyan`} disabled={editBusy || !!invalidDependency || !draft.name.trim()}>{saving ? '保存中…' : '保存更改'}</button></div>
          </form>
        ) : (
          <>
            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">{task.description.trim() || '任务说明待确认。'}{task.optional && <span className="ml-2 rounded bg-bg-lighter px-1.5 py-0.5 text-[10px] text-text-secondary">可选任务</span>}</p>
            {task.statusChangedAt && <p className="text-[11px] text-text-dim">状态更新于 {new Date(task.statusChangedAt).toLocaleString()}</p>}
            <Section title="任务状态"><div role="group" aria-label="修改任务状态" className="flex flex-wrap gap-1.5">{TASK_STATUSES.map(status => {
              const Icon = STATUS_ICON[status];
              return <button key={status} type="button" aria-pressed={task.status === status} disabled={editBusy} className={`${BUTTON} flex items-center gap-1.5 px-2 ${task.status === status ? `${STATUS_STYLE[status]} border-current bg-white/5` : ''}`} onClick={() => { if (status !== task.status) void persist({ status }); }}><Icon size={12} aria-hidden="true" />{TASK_LABELS[status]}</button>;
            })}</div><p className="text-[11px] leading-relaxed text-text-secondary">状态为手动记录，不自动证明产出或目标已验收。</p></Section>
            <Section title={task.status === 'completed' ? '已完成任务的输入 / 输出记录' : task.status === 'pending' ? '预期输入 / 输出' : '当前登记的输入 / 预期输出'}>
              <p className="text-[11px] leading-relaxed text-text-secondary">{task.status === 'completed' ? '下列为已登记的输入和产出；实际执行事实请结合执行记录和来源核实，状态本身不是证明。' : '下列为任务预期或当前登记信息，不代表已实际执行或交付。'}</p>
              <h4 className="text-xs text-text-primary">输入</h4><Values items={task.inputs} /><h4 className="pt-1 text-xs text-text-primary">输出</h4><Values items={task.outputs} />
            </Section>
            {!!unfinishedDependencies.length && <p role="status" className="rounded-lg border border-accent-orange/20 p-2 text-xs text-accent-orange">前置任务尚未完成：{unfinishedDependencies.map(item => item!.name).join('、')}。依赖仅作记录，不自动阻止手动状态修改。</p>}
            <Section title="前置依赖"><PagedList items={task.dependsOn} label="前置依赖" render={id => taskLink(id)} /><p className="whitespace-pre-wrap break-words rounded-lg border border-accent-orange/20 bg-accent-orange/5 p-2 text-xs leading-relaxed text-text-secondary">{task.dependencyNote.trim() || '依赖说明待确认；空列表不自动代表已核实无依赖。'}</p></Section>
            <Section title="关联后续任务"><PagedList items={following} label="后续任务" render={item => taskLink(item.id)} />{!onSelectTask && <p className="text-[11px] text-text-secondary">当前视图未提供任务跳转入口。</p>}</Section>
          </>
        )}
        <Section title={`任务证据 · ${task.records.length}`}>
          <p className="text-[11px] leading-relaxed text-text-secondary">包括任务原文、计划、执行及未知说明；条数不是执行次数，状态本身不证明验收。</p>
          <PagedList items={task.records} label="任务证据" render={(record, index) => <details className="rounded-lg border border-border-light bg-bg-light p-3 text-xs text-text-secondary"><summary className="cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan">记录 {index + 1} · {record.trim().slice(0, 60) || '内容待确认'}</summary><p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{record.trim() || '记录内容待确认。'}</p></details>} />
        </Section>
        <Section title={`信息来源 · ${task.sourceIds.length}`}>
          <PagedList items={task.sourceIds} label="信息来源" render={id => {
            const source = sourcesById.get(id);
            if (!source) return <p className="text-xs text-accent-orange">来源 {id} 不存在，待确认。</p>;
            return <div className="rounded-lg border border-border-light bg-bg-light p-3">
              <button type="button" disabled={busy} onClick={() => onSource(source)} className="flex w-full items-start justify-between gap-2 rounded text-left text-xs text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan disabled:opacity-40"><span className="break-words">{source.title || '未命名来源'}</span><ExternalLink size={13} className="shrink-0" aria-hidden="true" /></button>
              <p className="mt-1 text-[10px] font-mono text-text-muted">{source.kind === 'gui' ? 'GUI 会话' : 'Claude 会话'}</p>
              <details className="mt-2 text-xs text-text-secondary"><summary className="cursor-pointer">查看来源摘录与路径</summary><p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{source.excerpt.trim() || '来源摘录待确认。'}</p><p className="mt-2 break-all text-[10px] font-mono">{source.path || source.cwd || '路径待确认'}</p></details>
            </div>;
          }} />
        </Section>
      </div>
    </aside>
  );
}
