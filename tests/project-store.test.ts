import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectsStore } from '../src/renderer/projectStore';
import { projectSummary } from '../src/renderer/projectModel';
import type { ManagedProject, ProjectCandidate, ProjectScan, ProjectScanPlan, ProjectScanProgress, ProjectsAPI } from '../src/renderer/projectTypes';

const fixture = (id = 'p'): ManagedProject => ({
  id, identityKey: 'goal:key', name: '客户管理系统', description: '用户已编辑的描述', goal: '构建客户管理系统', background: '',
  constraints: '', decisions: '', deliverables: '', goalConfirmed: false, createdAt: 1, updatedAt: 1, files: [], sources: [], uncertainties: [],
  tasks: [{ id: 'a', name: '创建客户列表', description: '', status: 'pending', inputs: [], outputs: [], dependsOn: [], dependencyNote: '', sourceIds: [], records: [] },
    { id: 'b', name: '创建客户详情', description: '', status: 'pending', inputs: [], outputs: [], dependsOn: [], dependencyNote: '', sourceIds: [], records: [] }],
});
const candidate = (id = 'candidate', existingProjectId?: string): ProjectCandidate => ({ ...fixture(id), evidence: ['明确目标与两个任务'], existingProjectId });
const scan = (candidates = [candidate()]): ProjectScan => ({ scanId: 'scan', candidates, coverage: { guiSessions: 1, claudeSessions: 0, skipped: 0, warnings: [], roots: [] } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
};
let bridge: ProjectsAPI;
beforeEach(() => {
  useProjectsStore.setState({ open: false, selectedProjectId: null, projects: [], loaded: false, loading: false,
    operation: null, recognitionMode: 'llm', scanPlan: null, scanProgress: null, requestId: null, cancelling: false,
    scanResult: null, reviews: {}, error: null, notice: null });
  bridge = { list: vi.fn().mockResolvedValue([]), prepare: vi.fn(), cancelScan: vi.fn().mockResolvedValue(true), scan: vi.fn().mockResolvedValue(scan()),
    confirm: vi.fn().mockResolvedValue([fixture()]), update: vi.fn().mockImplementation(async project => [project]),
    reveal: vi.fn().mockResolvedValue({ ok: true }) };
  vi.stubGlobal('window', { api: { projects: bridge } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('LLM 准备与发送确认', () => {
  const plan = (): ProjectScanPlan => ({ planId: 'plan', sessions: 1, messages: 2, inputChars: 500, batches: 1, maxCalls: 1,
    expiresAt: Date.now() + 60000, sampleSources: [], coverage: scan().coverage });
  it('准备和取消只读，未确认范围不能调用 LLM', async () => {
    vi.mocked(bridge.prepare).mockResolvedValue(plan());
    await useProjectsStore.getState().prepare([], []);
    expect(bridge.scan).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().scanPlan?.planId).toBe('plan');
    await useProjectsStore.getState().scan([], [], { mode: 'llm', planId: 'plan', consent: false, maxBudgetUsd: 2 });
    expect(bridge.scan).not.toHaveBeenCalled();
    useProjectsStore.getState().discardPlan();
    expect(useProjectsStore.getState().scanPlan).toBeNull();
    expect(bridge.confirm).not.toHaveBeenCalled();
  });
  it('已确认的快照传递模型预算和请求标识，过滤无关进度并清理监听', async () => {
    let progress!: (value: ProjectScanProgress) => void;
    const unsubscribe = vi.fn();
    bridge.onScanProgress = callback => { progress = callback; return unsubscribe; };
    const pending = deferred<ProjectScan>();
    vi.mocked(bridge.scan).mockReturnValue(pending.promise);
    useProjectsStore.setState({ scanPlan: plan() });
    const promise = useProjectsStore.getState().scan([], [], { mode: 'llm', planId: 'plan', consent: true, model: 'sonnet', maxBudgetUsd: 2 });
    const id = useProjectsStore.getState().requestId!;
    progress({ requestId: 'other', phase: 'analyzing', completed: 0, total: 2, message: 'ignore' });
    expect(useProjectsStore.getState().scanProgress).toBeNull();
    progress({ requestId: id, phase: 'analyzing', completed: 1, total: 2, message: '第 1 批', costUsd: 0.02 });
    expect(useProjectsStore.getState().scanProgress?.message).toBe('第 1 批');
    expect(bridge.scan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'llm', planId: 'plan', model: 'sonnet', consent: true, maxBudgetUsd: 2, requestId: id }));
    expect(useProjectsStore.getState().scanPlan).toBeNull();
    pending.resolve({ ...scan(), analysis: { mode: 'llm', calls: 1, costUsd: 0.02 } }); await promise;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(useProjectsStore.getState().scanResult?.analysis?.mode).toBe('llm');
    expect(useProjectsStore.getState().requestId).toBeNull();
  });
  it('取消丢弃晚到候选；拒绝取消不能被误报为已取消', async () => {
    const pending = deferred<ProjectScan>(); vi.mocked(bridge.scan).mockReturnValue(pending.promise);
    useProjectsStore.setState({ scanPlan: plan() });
    const promise = useProjectsStore.getState().scan([], [], { mode: 'llm', planId: 'plan', consent: true, maxBudgetUsd: 2 });
    await useProjectsStore.getState().cancelScan();
    pending.resolve(scan()); await promise;
    expect(useProjectsStore.getState().scanResult).toBeNull();
    expect(useProjectsStore.getState().notice).toContain('取消');
    const pending2 = deferred<ProjectScan>(); vi.mocked(bridge.scan).mockReturnValue(pending2.promise);
    vi.mocked(bridge.cancelScan).mockResolvedValue(false);
    useProjectsStore.setState({ scanPlan: plan() });
    const promise2 = useProjectsStore.getState().scan([], [], { mode: 'llm', planId: 'plan', consent: true, maxBudgetUsd: 2 });
    await useProjectsStore.getState().cancelScan();
    expect(useProjectsStore.getState().cancelling).toBe(false);
    expect(useProjectsStore.getState().error).toContain('取消尚未生效');
    pending2.resolve(scan()); await promise2;
    expect(useProjectsStore.getState().scanResult).not.toBeNull();
  });
  it('LLM 失败保留已有项目，不自动规则重试，不持久化候选', async () => {
    useProjectsStore.setState({ projects: [fixture()], scanPlan: plan() });
    vi.mocked(bridge.scan).mockRejectedValue(new Error('invalid schema'));
    await useProjectsStore.getState().scan([], [], { mode: 'llm', planId: 'plan', consent: true, maxBudgetUsd: 2 });
    expect(bridge.scan).toHaveBeenCalledTimes(1);
    expect(bridge.confirm).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().projects).toHaveLength(1);
    expect(useProjectsStore.getState().scanResult).toBeNull();
    expect(useProjectsStore.getState().error).toContain('不会自动回退');
  });
});

describe('候选审核门控', () => {
  it('扫描不创建，默认不勾选；取消不发送 confirm 或 update', async () => {
    await useProjectsStore.getState().scan([], []);
    expect(useProjectsStore.getState().projects).toEqual([]);
    expect(useProjectsStore.getState().reviews.candidate.selected).toBe(false);
    expect(bridge.confirm).not.toHaveBeenCalled();
    expect(await useProjectsStore.getState().confirm()).toBe(false);
    expect(bridge.confirm).not.toHaveBeenCalled();
    useProjectsStore.getState().cancelReview();
    expect(useProjectsStore.getState().scanResult).toBeNull();
    expect(bridge.update).not.toHaveBeenCalled();
  });
  it('仅所选且编辑后的候选发送确认，UI selected 不进入持久化 payload', async () => {
    vi.mocked(bridge.scan).mockResolvedValue(scan([candidate('one'), candidate('two')]));
    await useProjectsStore.getState().scan([], []);
    useProjectsStore.getState().review('one', { selected: true, name: ' 新名称 ', goal: ' 新目标 ', description: '说明' });
    expect(await useProjectsStore.getState().confirm()).toBe(true);
    expect(bridge.confirm).toHaveBeenCalledExactlyOnceWith('scan', [{ candidateId: 'one', name: '新名称', goal: '新目标', description: '说明' }]);
    expect(useProjectsStore.getState().projects).toHaveLength(1);
    expect(useProjectsStore.getState().scanResult).toBeNull();
    expect(useProjectsStore.getState().reviews).toEqual({});
  });
  it('默认关联已有匹配项目并保留用户标题描述；另建需明确允许重复', async () => {
    const saved = fixture('existing');
    useProjectsStore.setState({ projects: [saved] });
    vi.mocked(bridge.scan).mockResolvedValue(scan([candidate('candidate', saved.id)]));
    await useProjectsStore.getState().scan([], []);
    expect(useProjectsStore.getState().reviews.candidate).toMatchObject({ existingProjectId: saved.id, name: saved.name, description: saved.description, selected: false });
    useProjectsStore.getState().review('candidate', { selected: true });
    await useProjectsStore.getState().confirm();
    expect(vi.mocked(bridge.confirm).mock.calls[0][1][0].existingProjectId).toBe(saved.id);
    await useProjectsStore.getState().scan([], []);
    useProjectsStore.getState().associate('candidate', '');
    expect(useProjectsStore.getState().reviews.candidate.allowDuplicate).toBe(false);
    expect(useProjectsStore.getState().reviews.candidate.existingProjectId).toBeUndefined();
  });
  it('字段校验、确认错误保持审核草稿并阻止双击并发请求', async () => {
    await useProjectsStore.getState().scan([], []);
    useProjectsStore.getState().review('candidate', { selected: true, name: ' ' });
    expect(await useProjectsStore.getState().confirm()).toBe(false);
    expect(bridge.confirm).not.toHaveBeenCalled();
    useProjectsStore.getState().review('candidate', { name: '真实项目' });
    const pending = deferred<ManagedProject[]>();
    vi.mocked(bridge.confirm).mockReturnValue(pending.promise);
    const confirmation = useProjectsStore.getState().confirm();
    expect(await useProjectsStore.getState().confirm()).toBe(false);
    useProjectsStore.getState().cancelReview();
    expect(useProjectsStore.getState().scanResult).not.toBeNull();
    pending.reject(new Error('Disk full'));
    expect(await confirmation).toBe(false);
    expect(bridge.confirm).toHaveBeenCalledTimes(1);
    expect(useProjectsStore.getState().reviews.candidate.name).toBe('真实项目');
    expect(useProjectsStore.getState().error).toContain('Disk full');
    expect(useProjectsStore.getState().operation).toBeNull();
  });
});

describe('项目存储与状态同步', () => {
  it('成功落盘后才替换状态，任务/分类/进度使用同一项目快照', async () => {
    const saved = fixture();
    useProjectsStore.setState({ projects: [saved], loaded: true });
    const pending = deferred<ManagedProject[]>();
    vi.mocked(bridge.update).mockReturnValue(pending.promise);
    const tasks = saved.tasks.map(task => ({ ...task, status: 'completed' as const }));
    const writing = useProjectsStore.getState().save(saved.id, { tasks });
    expect(useProjectsStore.getState().projects[0]).toBe(saved);
    expect(useProjectsStore.getState().operation).toBe('save');
    const updated = { ...saved, tasks };
    pending.resolve([updated]);
    expect(await writing).toBe(true);
    expect(projectSummary(useProjectsStore.getState().projects[0])).toMatchObject({ progress: 100, status: 'in_progress' });
    vi.mocked(bridge.update).mockImplementation(async project => [project]);
    await useProjectsStore.getState().save(saved.id, { goalConfirmed: true });
    expect(projectSummary(useProjectsStore.getState().projects[0]).status).toBe('completed');
    await useProjectsStore.getState().save(saved.id, { tasks: [{ ...tasks[0], status: 'in_progress' }, tasks[1]] });
    expect(useProjectsStore.getState().projects[0].goalConfirmed).toBe(false);
    expect(projectSummary(useProjectsStore.getState().projects[0]).status).toBe('in_progress');
  });
  it('写失败保留原数据，依赖自环/循环在调用前校验', async () => {
    const saved = fixture();
    useProjectsStore.setState({ projects: [saved] });
    const circular = saved.tasks.map((task, index) => ({ ...task, dependsOn: [saved.tasks[1 - index].id] }));
    expect(await useProjectsStore.getState().save(saved.id, { tasks: circular })).toBe(false);
    expect(bridge.update).not.toHaveBeenCalled();
    vi.mocked(bridge.update).mockRejectedValue(new Error('EACCES'));
    expect(await useProjectsStore.getState().save(saved.id, { name: '修改' })).toBe(false);
    expect(useProjectsStore.getState().projects[0]).toBe(saved);
    expect(useProjectsStore.getState().error).toContain('EACCES');
    expect(useProjectsStore.getState().operation).toBeNull();
  });
  it('恢复持久化结果，加载失败可重试；不存在接口有明确反馈', async () => {
    vi.mocked(bridge.list).mockRejectedValueOnce(new Error('Read denied')).mockResolvedValue([fixture()]);
    await useProjectsStore.getState().load();
    expect(useProjectsStore.getState().loaded).toBe(false);
    expect(useProjectsStore.getState().error).toContain('Read denied');
    await useProjectsStore.getState().load();
    expect(useProjectsStore.getState().loaded).toBe(true);
    expect(useProjectsStore.getState().projects).toHaveLength(1);
    vi.stubGlobal('window', {});
    await useProjectsStore.getState().scan([], []);
    expect(useProjectsStore.getState().error).toContain('桌面应用');
    expect(useProjectsStore.getState().projects).toHaveLength(1);
  });
  it('扫描期间不会并行保存、二次扫描或改动草稿', async () => {
    const pending = deferred<ProjectScan>();
    vi.mocked(bridge.scan).mockReturnValue(pending.promise);
    useProjectsStore.setState({ projects: [fixture()] });
    const scanning = useProjectsStore.getState().scan([], []);
    await useProjectsStore.getState().scan([], []);
    expect(await useProjectsStore.getState().save('p', { name: 'changed' })).toBe(false);
    expect(bridge.scan).toHaveBeenCalledTimes(1);
    expect(bridge.update).not.toHaveBeenCalled();
    pending.resolve(scan()); await scanning;
    expect(useProjectsStore.getState().operation).toBeNull();
  });
});
