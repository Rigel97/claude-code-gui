import type { ManagedProject, ProjectStatus, ProjectTask, TaskStatus } from './projectTypes';

export const TASK_LABELS: Record<TaskStatus, string> = {
  pending: '未开始', in_progress: '进行中', completed: '已完成',
};
export const PROJECT_LABELS: Record<ProjectStatus, string> = {
  not_started: '未启动', in_progress: '进行中', completed: '已完成',
};
export const TASK_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'completed'];

/** All tracked tasks are necessary. Task completion alone is not goal acceptance. */
export function projectSummary(project: Pick<ManagedProject, 'tasks' | 'goalConfirmed'>) {
  const counts: Record<TaskStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
  project.tasks.forEach(task => counts[task.status]++);
  const total = project.tasks.length;
  const allTasksComplete = total > 0 && counts.completed === total;
  const status: ProjectStatus = allTasksComplete && project.goalConfirmed ? 'completed'
    : counts.in_progress > 0 || counts.completed > 0 ? 'in_progress' : 'not_started';
  return { counts, total, allTasksComplete, status, progress: total ? Math.round(counts.completed / total * 100) : 0 };
}

export function projectCounts(projects: ManagedProject[]) {
  const counts = { all: projects.length, not_started: 0, in_progress: 0, completed: 0 };
  projects.forEach(project => counts[projectSummary(project).status]++);
  return counts;
}

/** Reopening a task/altering the goal invalidates previous project acceptance. */
export function patchProject(project: ManagedProject, changes: Partial<ManagedProject>): ManagedProject {
  const next = { ...project, ...changes };
  if (next.tasks.length === 0 || next.tasks.some(task => task.status !== 'completed') || next.goal !== project.goal) {
    next.goalConfirmed = false;
  }
  return next;
}

/** Only dirty fields are saved; a stale editor cannot roll back changes in another view. */
export function taskEditChanges(baseline: ProjectTask, draft: ProjectTask, current: ProjectTask): Partial<ProjectTask> {
  const changes: Partial<ProjectTask> = {};
  const fields = ['name', 'description', 'status', 'inputs', 'outputs', 'dependsOn', 'dependencyNote'] as const;
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
