import type { FieldProvenance, ManagedProject, ProjectChanges, ProjectStatus, ProjectTask, TaskStatus } from './projectTypes';

export const TASK_LABELS: Record<TaskStatus, string> = {
  pending: '未开始', in_progress: '进行中', completed: '已完成', cancelled: '已取消',
};
export const PROJECT_LABELS: Record<ProjectStatus, string> = {
  not_started: '未启动', in_progress: '进行中', completed: '已完成',
};
/** 列表、详情和筛选共用同一套状态配色：中性 = 未启动，蓝色 = 进行中，绿色 = 完成。
 *  进行中不再复用主操作青色，避免“当前状态”与“可以点击/主按钮”混淆。 */
export const PROJECT_STATUS_STYLE: Record<ProjectStatus, string> = {
  not_started: 'bg-bg-lighter text-text-secondary',
  in_progress: 'bg-accent-blue/10 text-accent-blue',
  completed: 'bg-accent-green/10 text-accent-green',
};
export const TASK_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];
/** 任务状态文字色在所有视图中共用，颜色只作辅助，标签始终存在。 */
export const TASK_STATUS_STYLE: Record<TaskStatus, string> = {
  pending: 'text-text-secondary',
  in_progress: 'text-accent-blue',
  completed: 'text-accent-green',
  cancelled: 'text-text-secondary',
};
export const PROVENANCE_LABELS: Record<FieldProvenance, string> = {
  quoted: '原文', model: '模型解释', user: '用户编辑', unknown: '未知',
};
export const isRecognitionGuidance = (item: string) => /^(?:助手宣称完成不等于项目完成|目标及项目字段仅保留用户显式原文|LLM 语义识别与项目字段待确认；引用仅证明原文存在)/.test(item);
export const unresolvedUncertainties = (project: Pick<ManagedProject, 'uncertainties' | 'resolvedUncertainties'>) => {
  const resolved = new Set(project.resolvedUncertainties || []);
  return [...new Set(project.uncertainties)].filter(item => !isRecognitionGuidance(item) && !resolved.has(item));
};
export interface ProjectHealthIssue { code: string; label: string }
export function projectHealth(project: ManagedProject, now = Date.now()) {
  const issues: ProjectHealthIssue[] = [];
  // Newly created manual projects are not "unhealthy" just because they start empty.
  if (!project.sources.length && project.audit) issues.push({ code: 'no-sources', label: '无历史来源' });
  if (!project.tasks.length && now - project.createdAt > 7 * 86400000) issues.push({ code: 'no-tasks', label: '没有任务' });
  const unresolved = unresolvedUncertainties(project).length;
  if (unresolved) issues.push({ code: 'uncertainties', label: `${unresolved} 个待确认` });
  if (!project.goalConfirmed && now - project.updatedAt > 30 * 86400000) issues.push({ code: 'stale', label: '超过 30 天未更新' });
  return { issues, needsAttention: issues.length > 0 };
}
export function projectTimeRange(project: ManagedProject) {
  const times = project.sources.map(source => source.timestamp).filter((time): time is number => Number.isFinite(time) && time! > 0);
  return {
    first: times.length ? Math.min(...times) : undefined,
    last: times.length ? Math.max(...times) : undefined,
    activeDays: new Set(times.map(time => new Date(time).toISOString().slice(0, 10))).size,
    sessions: new Set(project.sources.map(source => source.sessionId)).size,
  };
}

/** Optional and cancelled tasks are tracked but do not block goal acceptance. */
export const requiredTasks = (tasks: ProjectTask[]) =>
  tasks.filter(task => task.optional !== true && task.status !== 'cancelled');

/** Required task completion alone is not goal acceptance. */
export function projectSummary(project: Pick<ManagedProject, 'tasks' | 'goalConfirmed'>) {
  const counts: Record<TaskStatus, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  project.tasks.forEach(task => counts[task.status]++);
  const total = project.tasks.length;
  const required = requiredTasks(project.tasks);
  const requiredTotal = required.length;
  const requiredCompleted = required.filter(task => task.status === 'completed').length;
  const allTasksComplete = requiredTotal > 0 && requiredCompleted === requiredTotal;
  const status: ProjectStatus = allTasksComplete && project.goalConfirmed ? 'completed'
    : counts.in_progress > 0 || counts.completed > 0 ? 'in_progress' : 'not_started';
  return { counts, total, requiredTotal, requiredCompleted, allTasksComplete, status,
    optionalTotal: project.tasks.filter(task => task.optional === true && task.status !== 'cancelled').length,
    progress: requiredTotal ? Math.round(requiredCompleted / requiredTotal * 100) : 0 };
}

/** 只提供基于已记录事实的工作提示，不调度任务，也不把未知依赖视为已核实。 */
export function projectWorkState(project: Pick<ManagedProject, 'tasks' | 'goalConfirmed'>) {
  const byId = new Map(project.tasks.map(task => [task.id, task]));
  const required = requiredTasks(project.tasks);
  const active = required.filter(task => task.status === 'in_progress');
  const pending = required.filter(task => task.status === 'pending');
  const blocked = pending.filter(task => task.dependsOn.some(id => byId.get(id)?.status !== 'completed'));
  const blockedIds = new Set(blocked.map(task => task.id));
  const nextTask = active[0] ?? pending.find(task => !blockedIds.has(task.id)) ?? blocked[0] ?? null;
  const allComplete = required.length > 0 && required.every(task => task.status === 'completed');
  const label = allComplete ? (project.goalConfirmed ? '项目已验收' : '核对交付并验收')
    : !required.length ? '添加必要任务' : active.length ? '继续进行中的任务'
      : nextTask && blockedIds.has(nextTask.id) ? '核对前置任务' : '下一项必要任务';
  const note = '仅按已记录依赖提供提示；未知关系仍需核对，不自动执行或阻止状态修改。';
  return { active, pending, blocked, nextTask: allComplete ? null : nextTask, label, note };
}

export function projectCounts(projects: ManagedProject[]) {
  const active = projects.filter(project => !project.archivedAt && !project.deletedAt);
  const counts = { all: active.length, not_started: 0, in_progress: 0, completed: 0 };
  active.forEach(project => counts[projectSummary(project).status]++);
  return counts;
}

/** Acceptance follows the reviewed goal, deliverables and required task scope. */
export function acceptanceInvalidationReason(project: ManagedProject, next: ManagedProject): string | null {
  if (next.goal !== project.goal) return '项目目标已修改';
  if (next.deliverables !== project.deliverables) return '交付标准已修改';
  const required = requiredTasks(next.tasks);
  if (!required.length) return '当前没有必要任务，不能以取消或可选任务代替交付';
  if (required.some(task => task.status !== 'completed')) return '存在未完成的必要任务';
  if (requiredTasks(project.tasks).some(task => !required.some(item => item.id === task.id))) return '必要任务验收范围已缩减';
  if (required.some(task => !requiredTasks(project.tasks).some(item => item.id === task.id))) return '必要任务验收范围已变化';
  return null;
}
export function patchProject(project: ManagedProject, changes: Partial<ManagedProject>): ManagedProject {
  const next = { ...project, ...changes };
  if (acceptanceInvalidationReason(project, next)) next.goalConfirmed = false;
  return next;
}
export function progressLabel(summary: ReturnType<typeof projectSummary>) {
  const progress = summary.requiredTotal ? `${summary.requiredCompleted}/${summary.requiredTotal} 必要任务完成 · ${summary.progress}%` : '无必要任务 · 进度不适用';
  return `${progress}${summary.optionalTotal ? ` · ${summary.optionalTotal} 可选` : ''}${summary.counts.cancelled ? ` · ${summary.counts.cancelled} 已取消` : ''}`;
}
export function projectEditChanges(baseline: ManagedProject, draft: Partial<ManagedProject>, current: ManagedProject): ProjectChanges {
  const changes: ProjectChanges = {};
  for (const field of ['name', 'goal', 'description', 'background', 'constraints', 'decisions', 'deliverables', 'tags', 'workingDirectory'] as const) {
    if (!(field in draft) || JSON.stringify(baseline[field]) === JSON.stringify(draft[field])) continue;
    if (JSON.stringify(current[field]) !== JSON.stringify(baseline[field]) && JSON.stringify(current[field]) !== JSON.stringify(draft[field])) throw new Error(`项目 ${field} 已更新，请重新核对；草稿未保存。`);
    Object.assign(changes, { [field]: draft[field] });
  }
  return changes;
}

/** Only dirty fields are saved; a stale editor cannot roll back changes in another view. */
export function taskEditChanges(baseline: ProjectTask, draft: ProjectTask, current: ProjectTask): Partial<ProjectTask> {
  const changes: Partial<ProjectTask> = {};
  const fields = ['name', 'description', 'status', 'inputs', 'outputs', 'dependsOn', 'dependencyNote', 'optional'] as const;
  for (const field of fields) {
    const original = JSON.stringify(baseline[field]);
    const proposed = JSON.stringify(draft[field]);
    const latest = JSON.stringify(current[field]);
    if (original === proposed) continue;
    if (latest !== original && latest !== proposed) throw new Error(`任务 ${field} 已在其他视图更新，请取消编辑后重新核对。草稿未保存。`);
    Object.assign(changes, { [field]: draft[field] });
  }
  return changes;
}

export function dependencyError(tasks: ProjectTask[]): string | null {
  const ids = new Set(tasks.map(task => task.id));
  if (ids.size !== tasks.length) return '任务标识重复';
  const degrees = new Map<string, number>();
  const outgoing = new Map<string, string[]>(tasks.map(task => [task.id, []]));
  for (const task of tasks) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length) return '前置依赖重复';
    if (task.dependsOn.includes(task.id)) return '任务不能依赖自身';
    if (task.dependsOn.some(id => !ids.has(id))) return '前置依赖引用了不存在的任务';
    degrees.set(task.id, task.dependsOn.length);
    task.dependsOn.forEach(id => outgoing.get(id)!.push(task.id));
  }
  const queue = tasks.filter(task => task.dependsOn.length === 0).map(task => task.id);
  for (let i = 0; i < queue.length; i++) {
    for (const child of outgoing.get(queue[i])!) {
      degrees.set(child, degrees.get(child)! - 1);
      if (degrees.get(child) === 0) queue.push(child);
    }
  }
  return queue.length === tasks.length ? null : '前置依赖形成循环，请移除冲突连线';
}

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 206;
const GAP_X = 80;
const GAP_Y = 36;
const MARGIN = 36;
export interface WorkflowNode { taskId: string; x: number; y: number }
export interface WorkflowEdge { from: string; to: string; path: string; x1: number; x2: number; y1: number; y2: number }
export interface WorkflowLayout {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  width: number;
  height: number;
  error: string | null;
}

/** Layer the evidenced DAG, keeping disconnected components separate (no invented sequence). */
export function layoutWorkflow(tasks: ProjectTask[]): WorkflowLayout {
  const error = dependencyError(tasks);
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const neighbors = new Map<string, string[]>(tasks.map(task => [task.id, []]));
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (!error) {
    tasks.forEach(task => task.dependsOn.forEach(id => {
      neighbors.get(id)!.push(task.id);
      neighbors.get(task.id)!.push(id);
    }));
  }
  const visited = new Set<string>();
  const components: ProjectTask[][] = [];
  const isolated: ProjectTask[] = [];
  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    if (!neighbors.get(task.id)?.length) {
      visited.add(task.id); isolated.push(task); continue;
    }
    const queue = [task.id]; visited.add(task.id);
    for (let i = 0; i < queue.length; i++) {
      for (const id of neighbors.get(queue[i])!) if (!visited.has(id)) { visited.add(id); queue.push(id); }
    }
    const members = new Set(queue);
    components.push(tasks.filter(item => members.has(item.id)));
  }
  let offsetY = MARGIN;
  let width = NODE_WIDTH + MARGIN * 2;
  for (const component of components) {
    const rank = new Map<string, number>();
    const pending = new Map(component.map(task => [task.id, task.dependsOn.length]));
    const outgoing = new Map(component.map(task => [task.id, [] as string[]]));
    component.forEach(task => task.dependsOn.forEach(id => outgoing.get(id)!.push(task.id)));
    const queue = component.filter(task => !task.dependsOn.length).map(task => task.id);
    queue.forEach(id => rank.set(id, 0));
    for (let i = 0; i < queue.length; i++) {
      for (const id of outgoing.get(queue[i])!) {
        rank.set(id, Math.max(rank.get(id) || 0, rank.get(queue[i])! + 1));
        pending.set(id, pending.get(id)! - 1);
        if (pending.get(id) === 0) queue.push(id);
      }
    }
    const layers: ProjectTask[][] = [];
    component.forEach(task => (layers[rank.get(task.id)!] ||= []).push(task));
    // Sort each layer by the average parent position to reduce branch/merge crossings.
    const row = new Map<string, number>();
    layers.forEach(layer => {
      layer.sort((a, b) => {
        const barycenter = (task: ProjectTask) => task.dependsOn.length
          ? task.dependsOn.reduce((sum, id) => sum + (row.get(id) || 0), 0) / task.dependsOn.length : 0;
        return barycenter(a) - barycenter(b);
      });
      layer.forEach((task, index) => row.set(task.id, index));
    });
    const rows = Math.max(...layers.map(layer => layer.length));
    layers.forEach((layer, column) => layer.forEach((task, index) => {
      nodes.push({ taskId: task.id, x: MARGIN + column * (NODE_WIDTH + GAP_X),
        y: offsetY + (index + (rows - layer.length) / 2) * (NODE_HEIGHT + GAP_Y) });
    }));
    width = Math.max(width, MARGIN * 2 + layers.length * (NODE_WIDTH + GAP_X) - GAP_X);
    offsetY += rows * (NODE_HEIGHT + GAP_Y) + 24;
  }
  // Unconnected nodes are a spatial grid, explicitly not sequential workflow stages.
  const columns = Math.min(3, isolated.length);
  isolated.forEach((task, index) => nodes.push({ taskId: task.id,
    x: MARGIN + (index % columns) * (NODE_WIDTH + GAP_X),
    y: offsetY + Math.floor(index / columns) * (NODE_HEIGHT + GAP_Y) }));
  if (isolated.length) {
    width = Math.max(width, MARGIN * 2 + columns * (NODE_WIDTH + GAP_X) - GAP_X);
    offsetY += Math.ceil(isolated.length / columns) * (NODE_HEIGHT + GAP_Y);
  }
  const position = new Map(nodes.map(node => [node.taskId, node]));
  if (!error) tasks.forEach(task => task.dependsOn.forEach(id => {
    const from = position.get(id)!, to = position.get(task.id)!;
    const x1 = from.x + NODE_WIDTH, x2 = to.x;
    const y1 = from.y + NODE_HEIGHT / 2, y2 = to.y + NODE_HEIGHT / 2;
    const middle = (x1 + x2) / 2;
    edges.push({ from: id, to: task.id, x1, x2, y1, y2, path: `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}` });
  }));
  // Keep an empty workflow useful and never generate NaN coordinates.
  return { nodes: nodes.filter(node => byId.has(node.taskId)), edges, width, height: Math.max(300, offsetY + MARGIN), error };
}

export function nodeInViewport(node: WorkflowNode, viewport: { left: number; top: number; width: number; height: number }, margin = 240) {
  return node.x + NODE_WIDTH >= viewport.left - margin && node.x <= viewport.left + viewport.width + margin &&
    node.y + NODE_HEIGHT >= viewport.top - margin && node.y <= viewport.top + viewport.height + margin;
}
