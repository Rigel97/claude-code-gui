import { describe, expect, it } from 'vitest';
import { dependencyError, layoutWorkflow, NODE_HEIGHT, NODE_WIDTH, nodeInViewport, patchProject, projectCounts, projectHealth, projectSummary, projectTimeRange, taskEditChanges, unresolvedUncertainties } from '../src/renderer/projectModel';
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

describe('可选与取消任务', () => {
  it('取消和可选任务不计入必要进度，也不阻止目标验收', () => {
    const tasks = [task('required', [], 'completed'), { ...task('optional', [], 'pending'), optional: true }, task('cancelled', [], 'cancelled')];
    const summary = projectSummary(project(tasks));
    expect(summary).toMatchObject({ requiredTotal: 1, requiredCompleted: 1, allTasksComplete: true, progress: 100 });
    expect(summary.counts).toMatchObject({ pending: 1, completed: 1, cancelled: 1 });
    const accepted = patchProject(project(tasks), { goalConfirmed: true });
    expect(accepted.goalConfirmed).toBe(true);
    expect(projectSummary(accepted).status).toBe('completed');
  });
  it('新增可选任务不使已验收项目失效，重新打开必要任务会使验收失效', () => {
    const accepted = project([task('a', [], 'completed')], true);
    expect(patchProject(accepted, { tasks: [...accepted.tasks, { ...task('optional'), optional: true }] }).goalConfirmed).toBe(true);
    expect(patchProject(accepted, { tasks: [{ ...task('a', [], 'in_progress') }] }).goalConfirmed).toBe(false);
  });
  it('全取消或全可选没有必要进度，不能伪装为已经交付', () => {
    for (const tasks of [[task('a', [], 'cancelled')], [{ ...task('a'), optional: true }]]) {
      expect(projectSummary(project(tasks))).toMatchObject({ requiredTotal: 0, progress: 0, allTasksComplete: false });
      expect(patchProject(project(tasks), { goalConfirmed: true }).goalConfirmed).toBe(false);
    }
  });
  it('取消或删除可选任务保留验收，修改交付标准撤销验收', () => {
    const accepted = project([task('a', [], 'completed'), { ...task('optional'), optional: true }], true);
    expect(patchProject(accepted, { tasks: [accepted.tasks[0]] }).goalConfirmed).toBe(true);
    expect(patchProject(accepted, { tasks: [accepted.tasks[0], { ...accepted.tasks[1], status: 'cancelled' }] }).goalConfirmed).toBe(true);
    expect(patchProject(accepted, { deliverables: '新的交付标准' }).goalConfirmed).toBe(false);
  });
  it('手动项目新增任务不会仅因没有历史来源而成为待整理', () => {
    expect(projectHealth(project([task('a')]), 100).issues).toEqual([]);
  });
  it('下一步摘要从真实必要任务与依赖派生，不把取消、可选或未知关系当作完成', async () => {
    const { projectWorkState } = await import('../src/renderer/projectModel');
    const tasks = [task('blocked', ['unfinished']), task('ready', ['finished']), task('unfinished'), task('finished', [], 'completed'), { ...task('optional', [], 'in_progress'), optional: true }];
    expect(projectWorkState(project(tasks))).toMatchObject({ nextTask: { id: 'ready' }, active: [], blocked: [{ id: 'blocked' }] });
    expect(projectWorkState(project([task('running', [], 'in_progress'), task('pending')])).nextTask?.id).toBe('running');
    expect(projectWorkState(project([task('cancelled', [], 'cancelled')]))).toMatchObject({ nextTask: null, label: '添加必要任务' });
    expect(projectWorkState(project([task('finished', [], 'completed')]))).toMatchObject({ nextTask: null, label: '核对交付并验收' });
    expect(projectWorkState(project([task('finished', [], 'completed')], true)).label).toBe('项目已验收');
    expect(projectWorkState(project([task('unknown')])).note).toContain('仅按已记录依赖');
    expect(projectWorkState(project([task('a', ['missing'])])).blocked).toHaveLength(1);
  });
  it('归档和回收站项目不进入活动项目计数', () => {
    const active = project([task('a')]);
    expect(projectCounts([active, { ...active, id: 'archived', archivedAt: 1 }, { ...active, id: 'deleted', deletedAt: 1 }])).toEqual({
      all: 1, not_started: 1, in_progress: 0, completed: 0,
    });
  });
});

describe('档案健康与时间范围', () => {
  it('缺少来源/任务、未解决项和长期未更新会进入待整理', () => {
    const empty = project([]);
    const emptyIssues = projectHealth(empty, 7 * 86400000 + 10).issues.map(issue => issue.code);
    expect(emptyIssues).toContain('no-tasks');
    expect(emptyIssues).not.toContain('no-sources');
    const scanned = { ...project([]), audit: { mode: 'rules' as const, scannedAt: 1, coverage: { guiSessions: 0, claudeSessions: 0, skipped: 0, warnings: [], roots: [] } } };
    expect(projectHealth(scanned, 100).issues.map(issue => issue.code)).toContain('no-sources');
    const populated = { ...project([task('a')]), sources: [{ id: 's1', kind: 'gui' as const, sessionId: 's1', title: '', cwd: '/w', excerpt: '', timestamp: 1000 }], uncertainties: ['待确认 A'] };
    const health = projectHealth(populated, 1000 + 31 * 86400000);
    expect(health.needsAttention).toBe(true);
    expect(health.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['uncertainties', 'stale']));
    expect(unresolvedUncertainties({ ...populated, resolvedUncertainties: ['待确认 A'] })).toEqual([]);
  });
  it('从来源时间戳计算首次/最后工作、活跃天数和会话数', () => {
    const sources = [
      { id: 'a', kind: 'gui' as const, sessionId: 's1', title: '', cwd: '/w', excerpt: '', timestamp: new Date('2026-01-01T10:00:00Z').getTime() },
      { id: 'b', kind: 'claude' as const, sessionId: 's2', title: '', cwd: '/w', excerpt: '', timestamp: new Date('2026-01-01T18:00:00Z').getTime() },
      { id: 'c', kind: 'gui' as const, sessionId: 's1', title: '', cwd: '/w', excerpt: '', timestamp: new Date('2026-01-03T10:00:00Z').getTime() },
    ];
    const range = projectTimeRange({ ...project([task('a')]), sources });
    expect(range.activeDays).toBe(2);
    expect(range.sessions).toBe(2);
    expect(range.first).toBe(sources[0].timestamp);
    expect(range.last).toBe(sources[2].timestamp);
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
