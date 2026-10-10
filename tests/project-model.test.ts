import { describe, expect, it } from 'vitest';
import { dependencyError, layoutWorkflow, NODE_HEIGHT, NODE_WIDTH, nodeInViewport, patchProject, projectCounts, projectSummary, taskEditChanges } from '../src/renderer/projectModel';
import type { ManagedProject, ProjectTask, TaskStatus } from '../src/renderer/projectTypes';

const task = (id: string, dependsOn: string[] = [], status: TaskStatus = 'pending'): ProjectTask => ({
  id, name: id, description: '', status, dependsOn, dependencyNote: '待确认', inputs: [], outputs: [], sourceIds: [], records: [],
});
function project(tasks: ProjectTask[], goalConfirmed = false): ManagedProject {
  return { id: 'project', identityKey: 'identity', name: 'Project', goal: 'Build a project', description: '',
    background: '', constraints: '', decisions: '', deliverables: '', goalConfirmed, tasks, files: [], sources: [],
    uncertainties: [], createdAt: 1, updatedAt: 1 };
}

describe('项目状态与任务状态分离', () => {
  it('尚无执行的任务为未启动，空项目不会自动完成', () => {
    expect(projectSummary(project([]))).toMatchObject({ status: 'not_started', progress: 0, total: 0 });
    expect(projectSummary(project([task('a'), task('b')]))).toMatchObject({ status: 'not_started', progress: 0 });
  });
  it('部分任务已完成/执行中始终为进行中；进度只按任务计数', () => {
    expect(projectSummary(project([task('a', [], 'completed'), task('b'), task('c', [], 'in_progress')]))).toMatchObject({
      status: 'in_progress', progress: 33, counts: { pending: 1, in_progress: 1, completed: 1 },
    });
  });
  it('全部任务完成仍需目标验收；三个视图共用同一派生状态', () => {
    const completed = project([task('a', [], 'completed'), task('b', ['a'], 'completed')]);
    expect(projectSummary(completed)).toMatchObject({ status: 'in_progress', progress: 100, allTasksComplete: true });
    expect(projectSummary(patchProject(completed, { goalConfirmed: true })).status).toBe('completed');
    expect(projectCounts([project([task('x')]), completed, { ...completed, id: 'done', goalConfirmed: true }])).toEqual({
      all: 3, not_started: 1, in_progress: 1, completed: 1,
    });
  });
  it('重新打开任务、改变目标、新增任务都会使旧验收失效，不修改原对象', () => {
    const accepted = project([task('a', [], 'completed')], true);
    const reopened = patchProject(accepted, { tasks: [task('a', [], 'in_progress')] });
    expect(reopened.goalConfirmed).toBe(false);
    expect(projectSummary(reopened).status).toBe('in_progress');
    expect(patchProject(accepted, { goal: 'A different objective' }).goalConfirmed).toBe(false);
    expect(patchProject(accepted, { tasks: [...accepted.tasks, task('new')] }).goalConfirmed).toBe(false);
    expect(patchProject(accepted, { description: 'Updated context' }).goalConfirmed).toBe(true);
    expect(accepted.goalConfirmed).toBe(true);
    expect(accepted.tasks[0].status).toBe('completed');
  });
});

describe('任务编辑草稿防止状态回退', () => {
  it('只编辑说明不会覆盖其他视图已保存的完成状态', () => {
    const baseline = task('a');
    const draft = { ...baseline, description: '新的说明' };
    const latest = { ...baseline, status: 'completed' as const };
    expect(taskEditChanges(baseline, draft, latest)).toEqual({ description: '新的说明' });
  });
  it('相同字段冲突拒绝保存，一致修改可继续，未改字段不会发送', () => {
    const baseline = task('a');
    expect(() => taskEditChanges(baseline, { ...baseline, description: '甲' }, { ...baseline, description: '乙' })).toThrow(/其他视图/);
    expect(taskEditChanges(baseline, { ...baseline, name: '新名称' }, { ...baseline, name: '新名称' })).toEqual({ name: '新名称' });
    expect(taskEditChanges(baseline, { ...baseline }, { ...baseline, status: 'completed' })).toEqual({});
  });
});

describe('依赖图校验与工作流布局', () => {
  it('分支汇合保持全部真实边，层级方向正确且节点不重叠', () => {
    const tasks = [task('start'), task('left', ['start']), task('right', ['start']), task('join', ['left', 'right']), task('independent')];
    const graph = layoutWorkflow(tasks);
    expect(graph.error).toBeNull();
    expect(graph.edges.map(edge => `${edge.from}->${edge.to}`)).toEqual(['start->left', 'start->right', 'left->join', 'right->join']);
    const nodes = new Map(graph.nodes.map(node => [node.taskId, node]));
    expect(nodes.get('left')!.x).toBe(nodes.get('right')!.x);
    expect(nodes.get('start')!.x).toBeLessThan(nodes.get('left')!.x);
    expect(nodes.get('join')!.x).toBeGreaterThan(nodes.get('left')!.x);
    for (let i = 0; i < graph.nodes.length; i++) for (let j = i + 1; j < graph.nodes.length; j++) {
      const a = graph.nodes[i], b = graph.nodes[j];
      expect(Math.abs(a.x - b.x) >= NODE_WIDTH || Math.abs(a.y - b.y) >= NODE_HEIGHT).toBe(true);
    }
    expect(graph.edges.some(edge => edge.from === 'independent' || edge.to === 'independent')).toBe(false);
  });
  it('未知依赖不按清单顺序伪造连线，修改状态不改变布局', () => {
    const tasks = [task('a'), task('b'), task('c')];
    expect(layoutWorkflow(tasks).edges).toEqual([]);
    expect(layoutWorkflow(tasks).nodes).toEqual(layoutWorkflow(tasks.map(task => ({ ...task, status: 'completed' }))).nodes);
  });
  it('拒绝缺失引用、自环、重复依赖、重复任务和循环', () => {
    for (const tasks of [
      [task('a', ['missing'])], [task('a', ['a'])], [task('a'), task('b', ['a', 'a'])],
      [task('a'), task('a')], [task('a', ['b']), task('b', ['a'])],
    ]) {
      expect(dependencyError(tasks)).not.toBeNull();
      const layout = layoutWorkflow(tasks);
      expect(layout.error).not.toBeNull();
      expect(layout.edges).toEqual([]);
      expect(layout.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    }
  });
  it('支持空图、长链及多个独立组件，视口裁剪可保留选中区域', () => {
    const empty = layoutWorkflow([]);
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty.height).toBeGreaterThan(0);
    const tasks = Array.from({ length: 500 }, (_, index) => task(String(index), index % 10 ? [String(index - 1)] : []));
    const graph = layoutWorkflow(tasks);
    expect(graph.nodes).toHaveLength(500);
    expect(graph.edges).toHaveLength(450);
    const viewport = { left: graph.nodes[0].x, top: graph.nodes[0].y, width: 800, height: 400 };
    expect(nodeInViewport(graph.nodes[0], viewport)).toBe(true);
    expect(graph.nodes.filter(node => nodeInViewport(node, viewport)).length).toBeLessThan(20);
    expect(nodeInViewport(graph.nodes[499], viewport)).toBe(false);
    expect(graph.nodes.every(node => node.x >= 0 && node.y >= 0 && node.x + NODE_WIDTH <= graph.width && node.y + NODE_HEIGHT <= graph.height)).toBe(true);
  });
});
