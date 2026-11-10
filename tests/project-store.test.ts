import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectsStore } from '../src/renderer/projectStore';
import { useStore } from '../src/renderer/store';
import { projectSummary } from '../src/renderer/projectModel';
import type { ManagedProject, ProjectCandidate, ProjectConversationLink, ProjectReviewDraft, ProjectScan, ProjectScanJob, ProjectScanPlan, ProjectScanProgress, ProjectsAPI } from '../src/renderer/projectTypes';

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
// Drain the private draft-write chain and queued run callbacks before changing bridges.
const flushQueues = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); };
const initialChatState = useStore.getState();
let bridge: ProjectsAPI;
beforeEach(() => {
  bridge = { list: vi.fn().mockResolvedValue([]), prepare: vi.fn(), cancelScan: vi.fn().mockResolvedValue(true), scan: vi.fn().mockResolvedValue(scan()),
    confirm: vi.fn().mockResolvedValue([fixture()]), update: vi.fn().mockImplementation(async project => [project]),
    create: vi.fn().mockResolvedValue([fixture()]), archive: vi.fn().mockResolvedValue([fixture()]),
    remove: vi.fn().mockResolvedValue([fixture()]), merge: vi.fn().mockResolvedValue([fixture()]),
    saveReviewDraft: vi.fn().mockResolvedValue(undefined), reveal: vi.fn().mockResolvedValue({ ok: true }) };
  vi.stubGlobal('window', { api: { projects: bridge }, confirm: vi.fn(() => true) });
  let requestCounter = 0;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++requestCounter).padStart(12, '0')}`);
  useStore.setState({ ...initialChatState, conversations: [], sessions: [], activeConversationId: '', cwd: '/global-default' });
  useProjectsStore.setState({ open: false, dirty: false, dirtyReasons: {}, selectedProjectId: null, projects: [], loaded: false, loading: false,
    operation: null, writeOperation: null, scanOperation: null, recognitionMode: 'llm', scanPlan: null, scanProgress: null, requestId: null, cancelling: false,
    scanResult: null, reviewOpen: false, reviewDirty: false, reviews: {}, error: null, notice: null, storageInfo: null });
});
afterEach(async () => {
  try { await flushQueues(); }
  finally {
    vi.useRealTimers();
    useStore.setState(initialChatState);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

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
    await useProjectsStore.getState().cancelReview();
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

describe('项目生命周期操作', () => {
  it('创建、归档、回收站和合并都等后端成功后才替换列表', async () => {
    const saved = fixture();
    useProjectsStore.setState({ projects: [saved], loaded: true });
    const pending = deferred<ManagedProject[]>();
    vi.mocked(bridge.archive).mockReturnValue(pending.promise);
    const archiving = useProjectsStore.getState().archive(saved.id, true);
    expect(useProjectsStore.getState().operation).toBe('mutate');
    pending.resolve([{ ...saved, archivedAt: 1 }]);
    expect(await archiving).toBe(true);
    expect(useProjectsStore.getState().projects[0].archivedAt).toBe(1);
    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
    vi.mocked(bridge.remove).mockResolvedValue([{ ...saved, deletedAt: 2 }]);
    expect(await useProjectsStore.getState().remove(saved.id, true)).toBe(true);
    expect(useProjectsStore.getState().projects[0].deletedAt).toBe(2);
    vi.mocked(bridge.merge).mockResolvedValue([{ ...saved, sources: [] }]);
    expect(await useProjectsStore.getState().merge('other', saved.id)).toBe(true);
    vi.mocked(bridge.create).mockResolvedValue([fixture('manual')]);
    expect(await useProjectsStore.getState().create({ name: ' 手动 ', goal: ' 目标 ', description: ' 说明 ' })).toBe(true);
    expect(bridge.create).toHaveBeenCalledWith({ name: '手动', goal: '目标', description: '说明' });
  });
  it('不同编辑源的未保存状态不会互相清除', () => {
    useProjectsStore.getState().clearDirty();
    useProjectsStore.getState().setDirty(true, 'background');
    useProjectsStore.getState().setDirty(true, 'task');
    useProjectsStore.getState().setDirty(false, 'task');
    expect(useProjectsStore.getState().dirty).toBe(true);
    useProjectsStore.getState().setDirty(false, 'background');
    expect(useProjectsStore.getState().dirty).toBe(false);
  });
  it('有未保存内容时离开项目中心需要确认', async () => {
    useProjectsStore.setState({ open: true, dirty: true, dirtyReasons: { background: true } });
    const confirm = vi.mocked((window as any).confirm);
    confirm.mockReturnValueOnce(false);
    await useProjectsStore.getState().showChat();
    expect(useProjectsStore.getState().open).toBe(true);
    confirm.mockReturnValueOnce(true);
    await useProjectsStore.getState().showChat();
    expect(useProjectsStore.getState().open).toBe(false);
    expect(useProjectsStore.getState().dirty).toBe(false);
    expect(useProjectsStore.getState().dirtyReasons).toEqual({});
  });
  it('重复打开项目中心保留当前详情与草稿，拒绝切换项目时不改变选择', async () => {
    useProjectsStore.setState({ open: true, selectedProjectId: 'p', dirty: true, dirtyReasons: { background: true } });
    useProjectsStore.getState().showProjects();
    expect(useProjectsStore.getState().selectedProjectId).toBe('p');
    expect(useProjectsStore.getState().dirty).toBe(true);
    vi.mocked((window as any).confirm).mockReturnValueOnce(false);
    expect(await useProjectsStore.getState().selectProject('other')).toBe(false);
    expect(useProjectsStore.getState().selectedProjectId).toBe('p');
    vi.mocked((window as any).confirm).mockReturnValueOnce(false);
    expect(await useProjectsStore.getState().showChat()).toBe(false);
  });
  it('统一离开守卫在用户取消后不清除草稿，允许后才清除指定编辑源', async () => {
    useProjectsStore.getState().setDirty(true, 'background');
    useProjectsStore.getState().setDirty(true, 'task');
    vi.mocked((window as any).confirm).mockReturnValueOnce(false);
    expect(await useProjectsStore.getState().confirmDiscard('切换任务', ['task'])).toBe(false);
    expect(useProjectsStore.getState().dirtyReasons.task).toBe(true);
    expect(await useProjectsStore.getState().confirmDiscard('切换任务', ['task'])).toBe(true);
    expect(useProjectsStore.getState().dirtyReasons.task).toBeUndefined();
    expect(useProjectsStore.getState().dirtyReasons.background).toBe(true);
  });
  it('规则扫描也带 requestId，可取消并丢弃晚到结果', async () => {
    const pending = deferred<ProjectScan>();
    vi.mocked(bridge.scan).mockReturnValue(pending.promise);
    const scanning = useProjectsStore.getState().scan([], [], { mode: 'rules' });
    const id = useProjectsStore.getState().requestId!;
    expect(id).toBeTruthy();
    await useProjectsStore.getState().cancelScan();
    pending.reject(new Error('项目识别已取消，未保存候选'));
    await scanning;
    expect(useProjectsStore.getState().scanResult).toBeNull();
    expect(useProjectsStore.getState().notice).toContain('取消');
  });
});

describe('显式重载的缓存一致性', () => {
  it('从磁盘重载同 revision 的外部修改仍更新页面，不能复用旧缓存', async () => {
    const old = { ...fixture(), revision: 2 };
    useProjectsStore.setState({ projects: [old], loaded: true });
    bridge.reload = vi.fn().mockResolvedValue([{ ...old, name: '外部已修改标题' }]);
    expect(await useProjectsStore.getState().reload()).toBe(true);
    expect(useProjectsStore.getState().projects[0].name).toBe('外部已修改标题');
    expect(useProjectsStore.getState().projects[0]).not.toBe(old);
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
  it('扫描与项目保存独立运行，扫描期间允许写入但禁止二次扫描', async () => {
    const pending = deferred<ProjectScan>();
    vi.mocked(bridge.scan).mockReturnValue(pending.promise);
    useProjectsStore.setState({ projects: [fixture()] });
    const scanning = useProjectsStore.getState().scan([], []);
    await useProjectsStore.getState().scan([], []);
    expect(await useProjectsStore.getState().save('p', { name: 'changed' })).toBe(true);
    expect(bridge.scan).toHaveBeenCalledTimes(1);
    expect(bridge.update).toHaveBeenCalledTimes(1);
    expect(useProjectsStore.getState().projects[0].name).toBe('changed');
    expect(useProjectsStore.getState().writeOperation).toBeNull();
    expect(useProjectsStore.getState().scanOperation).toBe('scan');
    expect(useProjectsStore.getState().operation).toBe('scan');
    pending.resolve(scan()); await scanning;
    expect(useProjectsStore.getState().operation).toBeNull();
  });
});

const restoredDraft = (): ProjectReviewDraft => ({
  scanResult: { ...scan(), scanId: 'persisted-scan' },
  reviews: { candidate: { candidateId: 'candidate', selected: true, name: '审核中修改的标题', goal: '已核对目标', description: '未提交的说明' } },
});

describe('独立扫描与持久审核公开行为', () => {
  it('暂停后继续审核保留修改名称，不重新准备或调用模型', async () => {
    useProjectsStore.setState({ open: true });
    await useProjectsStore.getState().scan([], []);
    useProjectsStore.getState().review('candidate', { name: '人工核对名称', selected: true });
    useProjectsStore.getState().pauseReview();
    await flushQueues();
    expect(useProjectsStore.getState().reviewOpen).toBe(false);
    expect(useProjectsStore.getState().reviews.candidate.name).toBe('人工核对名称');
    expect(bridge.saveReviewDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      reviews: expect.objectContaining({ candidate: expect.objectContaining({ name: '人工核对名称', selected: true }) }),
    }));
    useProjectsStore.getState().resumeReview();
    expect(useProjectsStore.getState().reviewOpen).toBe(true);
    expect(useProjectsStore.getState().reviews.candidate.name).toBe('人工核对名称');
    expect(bridge.prepare).not.toHaveBeenCalled();
    expect(bridge.scan).toHaveBeenCalledTimes(1);
    expect(bridge.confirm).not.toHaveBeenCalled();
  });

  it('用户拒绝取消审核时保留名称、选择和持久草稿', async () => {
    useProjectsStore.setState({ open: true });
    await useProjectsStore.getState().scan([], []);
    useProjectsStore.getState().review('candidate', { name: '不能丢失的名称', selected: true });
    await flushQueues();
    const savedCalls = vi.mocked(bridge.saveReviewDraft!).mock.calls.length;
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await useProjectsStore.getState().cancelReview();
    await flushQueues();
    expect(useProjectsStore.getState().scanResult?.scanId).toBe('scan');
    expect(useProjectsStore.getState().reviewOpen).toBe(true);
    expect(useProjectsStore.getState().reviews.candidate).toMatchObject({ name: '不能丢失的名称', selected: true });
    expect(bridge.saveReviewDraft).toHaveBeenCalledTimes(savedCalls);
    expect(bridge.confirm).not.toHaveBeenCalled();
  });

  it('新编辑的原文字段也要明确核对，未核对时前端不调用确认接口', async () => {
    const raw = { ...candidate(), background: '原文背景', fieldEvidence: { background: { kind: 'quoted' as const, refs: [] } } };
    vi.mocked(bridge.scan).mockResolvedValue({ ...scan([raw]), analysis: { mode: 'llm' } });
    await useProjectsStore.getState().scan([], []);
    useProjectsStore.getState().review(raw.id, { selected: true, fields: { background: '新编辑的背景' } });
    expect(await useProjectsStore.getState().confirm()).toBe(false);
    expect(bridge.confirm).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().error).toContain('background');
    useProjectsStore.getState().review(raw.id, { reviewedFields: ['background'] });
    expect(await useProjectsStore.getState().confirm()).toBe(true);
    expect(bridge.confirm).toHaveBeenCalledTimes(1);
  });

  it('严格 patch 只发送修改字段与缓存 revision，不附带来源或生命周期快照', async () => {
    const saved = { ...fixture(), revision: 7, conversations: [{ conversationId: 'linked', cwd: '/project', title: '关联', linkedAt: 1 }] };
    useProjectsStore.setState({ projects: [saved] });
    bridge.patch = vi.fn().mockResolvedValue([{ ...saved, name: '修改标题', revision: 8 }]);
    expect(await useProjectsStore.getState().save('p', { name: '修改标题' })).toBe(true);
    expect(bridge.patch).toHaveBeenCalledExactlyOnceWith({ id: 'p', expectedRevision: 7, changes: { name: '修改标题' } });
    const changes = vi.mocked(bridge.patch).mock.calls[0][0].changes;
    for (const field of ['sources', 'conversations', 'archivedAt', 'deletedAt', 'mergedInto']) expect(changes).not.toHaveProperty(field);
    expect(bridge.update).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().projects[0]).toMatchObject({ name: '修改标题', revision: 8 });
  });

  it('严格 patch 冲突保留数据和 dirty，不退回 legacy update 绕过 revision', async () => {
    const saved = { ...fixture(), revision: 4 };
    useProjectsStore.setState({ projects: [saved], dirty: true, dirtyReasons: { background: true } });
    bridge.patch = vi.fn().mockRejectedValue(new Error('revision conflict'));
    expect(await useProjectsStore.getState().save('p', { background: '待保存背景' })).toBe(false);
    expect(bridge.patch).toHaveBeenCalledExactlyOnceWith({ id: 'p', expectedRevision: 4, changes: { background: '待保存背景' } });
    expect(bridge.update).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().projects[0]).toBe(saved);
    expect(useProjectsStore.getState().dirtyReasons.background).toBe(true);
    expect(useProjectsStore.getState().error).toContain('revision conflict');
    expect(useProjectsStore.getState().writeOperation).toBeNull();
  });

  it('legacy 保存全部取消的任务会撤销验收，不能再次标记目标达成', async () => {
    const saved = { ...fixture(), goalConfirmed: true, tasks: fixture().tasks.map(task => ({ ...task, status: 'completed' as const })) };
    useProjectsStore.setState({ projects: [saved] });
    const tasks = saved.tasks.map(task => ({ ...task, status: 'cancelled' as const }));
    expect(await useProjectsStore.getState().save('p', { tasks })).toBe(true);
    expect(bridge.update).toHaveBeenCalledWith(expect.objectContaining({ tasks, goalConfirmed: false }));
    expect(useProjectsStore.getState().projects[0].goalConfirmed).toBe(false);
    expect(await useProjectsStore.getState().save('p', { goalConfirmed: true })).toBe(false);
    expect(bridge.update).toHaveBeenCalledTimes(1);
    expect(useProjectsStore.getState().error).toContain('必要任务');
  });

  it('准备历史带 requestId 并过滤进度，取消后晚到计划不恢复也不发送模型', async () => {
    const pending = deferred<ProjectScanPlan>();
    let progress!: (value: ProjectScanProgress) => void;
    const unsubscribe = vi.fn();
    bridge.onScanProgress = callback => { progress = callback; return unsubscribe; };
    vi.mocked(bridge.prepare).mockReturnValue(pending.promise);
    const preparing = useProjectsStore.getState().prepare([], [], { cwd: '/scoped' });
    const requestId = useProjectsStore.getState().requestId!;
    expect(bridge.prepare).toHaveBeenCalledExactlyOnceWith({ sessions: [], conversations: [], requestId, scope: { cwd: '/scoped' } });
    expect(useProjectsStore.getState().scanOperation).toBe('prepare');
    progress({ requestId: 'unrelated', phase: 'reading', completed: 1, total: 2, message: '忽略' });
    expect(useProjectsStore.getState().scanProgress).toBeNull();
    progress({ requestId, phase: 'reading', completed: 1, total: 2, message: '读取中' });
    expect(useProjectsStore.getState().scanProgress?.message).toBe('读取中');
    await useProjectsStore.getState().cancelScan();
    expect(bridge.cancelScan).toHaveBeenCalledExactlyOnceWith(requestId);
    pending.resolve({ planId: 'late-plan', sessions: 1, messages: 2, inputChars: 500, batches: 1, maxCalls: 1,
      expiresAt: Date.now() + 60000, sampleSources: [], coverage: scan([]).coverage });
    await preparing;
    expect(useProjectsStore.getState().scanPlan).toBeNull();
    expect(useProjectsStore.getState().requestId).toBeNull();
    expect(useProjectsStore.getState().scanOperation).toBeNull();
    expect(useProjectsStore.getState().notice).toContain('取消');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    progress({ requestId, phase: 'finished', completed: 2, total: 2, message: '已结束的回调' });
    expect(useProjectsStore.getState().scanProgress?.message).toBe('读取中');
    expect(bridge.scan).not.toHaveBeenCalled();
  });

  it('load 跨 renderer 恢复持久草稿与修改名称，继续审核无需重新 scan', async () => {
    let persisted: ProjectReviewDraft | null = null;
    bridge.saveReviewDraft = vi.fn(async draft => { persisted = structuredClone(draft); });
    bridge.reviewDraft = vi.fn(async () => persisted);
    await useProjectsStore.getState().scan([], []);
    useProjectsStore.getState().review('candidate', { selected: true, name: '跨窗口名称' });
    useProjectsStore.getState().pauseReview();
    await flushQueues();
    useProjectsStore.setState({ projects: [], loaded: false, scanResult: null, reviews: {}, reviewOpen: false, reviewDirty: false });
    vi.mocked(bridge.list).mockResolvedValue([fixture()]);
    await useProjectsStore.getState().load();
    expect(useProjectsStore.getState().reviews.candidate).toMatchObject({ name: '跨窗口名称', selected: true });
    expect(useProjectsStore.getState().reviewOpen).toBe(false);
    expect(useProjectsStore.getState().reviewDirty).toBe(false);
    useProjectsStore.getState().resumeReview();
    expect(useProjectsStore.getState().reviewOpen).toBe(true);
    expect(bridge.scan).toHaveBeenCalledTimes(1);
    expect(bridge.prepare).not.toHaveBeenCalled();
    expect(bridge.confirm).not.toHaveBeenCalled();
  });

  it('load 恢复 running activeJob 并轮询到 completed，终态候选无需新扫描', async () => {
    vi.useFakeTimers();
    const job: ProjectScanJob = { requestId: 'recovered-job', operation: 'scan', state: 'running' };
    const unsubscribe = vi.fn();
    bridge.onScanProgress = vi.fn(() => unsubscribe);
    bridge.activeJob = vi.fn().mockResolvedValueOnce(job).mockResolvedValue({ ...job, state: 'completed', result: scan() });
    await useProjectsStore.getState().load();
    expect(useProjectsStore.getState()).toMatchObject({ requestId: 'recovered-job', scanOperation: 'scan', operation: 'scan' });
    await vi.advanceTimersByTimeAsync(1000);
    await flushQueues();
    expect(bridge.activeJob).toHaveBeenCalledTimes(2);
    expect(useProjectsStore.getState()).toMatchObject({ requestId: null, scanOperation: null, operation: null });
    expect(useProjectsStore.getState().scanResult?.scanId).toBe('scan');
    expect(useProjectsStore.getState().reviews.candidate.selected).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(bridge.activeJob).toHaveBeenCalledTimes(2);
    expect(bridge.scan).not.toHaveBeenCalled();
  });

  it('恢复任务的晚到 completed 结果不覆盖正在编辑的审核草稿', async () => {
    vi.useFakeTimers();
    const draft = restoredDraft();
    const job: ProjectScanJob = { requestId: 'late-job', operation: 'scan', state: 'running' };
    bridge.reviewDraft = vi.fn().mockResolvedValue(draft);
    bridge.activeJob = vi.fn().mockResolvedValueOnce(job).mockResolvedValue({ ...job, state: 'completed', result: scan([candidate('replacement')]) });
    await useProjectsStore.getState().load();
    useProjectsStore.getState().resumeReview();
    useProjectsStore.getState().review('candidate', { name: '轮询期间继续编辑' });
    await flushQueues();
    await vi.advanceTimersByTimeAsync(1000);
    expect(useProjectsStore.getState().scanResult?.scanId).toBe('persisted-scan');
    expect(useProjectsStore.getState().reviews.candidate.name).toBe('轮询期间继续编辑');
    expect(useProjectsStore.getState().reviews).not.toHaveProperty('replacement');
    expect(useProjectsStore.getState().reviewOpen).toBe(true);
    expect(useProjectsStore.getState().scanOperation).toBeNull();
    expect(bridge.scan).not.toHaveBeenCalled();
  });
});

const linkedProject = (): ManagedProject => ({ ...fixture(), revision: 3, workingDirectory: '/project-work',
  conversations: [{ conversationId: 'existing-chat', sessionId: 'existing-session', cwd: '/project-work', title: '已有任务对话', taskId: 'a', linkedAt: 1 }] });
const completedRun: NonNullable<ProjectConversationLink['lastRun']> = { status: 'completed', recordedAt: 10, excerpt: '已生成候选实现，尚未验收', verified: false };
const seedChatDraft = () => {
  const id = useStore.getState().newConversation({ id: 'original-chat', cwd: '/original-work', title: '原会话', draft: '不要消费的原草稿' });
  useStore.setState({ model: 'sonnet', permissionMode: 'acceptEdits', effortLevel: 'high' });
  return id;
};

describe('项目对话公开行为与写入队列', () => {
  it('项目列表加载前的运行记录先排队，load 后按真实关联补写而不是丢弃', async () => {
    const saved = linkedProject();
    useProjectsStore.setState({ projects: [], loaded: false });
    bridge.list = vi.fn().mockResolvedValue([saved]);
    bridge.recordConversation = vi.fn().mockResolvedValue([{ ...saved, revision: 4,
      conversations: saved.conversations!.map(link => ({ ...link, lastRun: completedRun })) }]);
    await useProjectsStore.getState().recordConversation('existing-chat', completedRun);
    expect(useProjectsStore.getState().pendingProgress).toBe(1);
    expect(bridge.recordConversation).not.toHaveBeenCalled();
    await useProjectsStore.getState().load();
    await flushQueues();
    expect(bridge.recordConversation).toHaveBeenCalledExactlyOnceWith('existing-chat', completedRun);
    expect(useProjectsStore.getState().pendingProgress).toBe(0);
    expect(useProjectsStore.getState().projects[0].conversations![0].lastRun?.status).toBe('completed');
    expect(useProjectsStore.getState().projects[0].tasks[0].status).toBe('pending');
  });
  it('进展写失败保留待保存计数，显式重试后才清除且不会自动验收', async () => {
    const saved = linkedProject();
    useProjectsStore.setState({ projects: [saved] });
    bridge.recordConversation = vi.fn().mockRejectedValueOnce(new Error('disk denied')).mockResolvedValueOnce([{ ...saved, revision: 4, conversations: saved.conversations!.map(link => ({ ...link, lastRun: completedRun })) }]);
    await useProjectsStore.getState().recordConversation('existing-chat', completedRun);
    expect(useProjectsStore.getState().pendingProgress).toBe(1);
    expect(useProjectsStore.getState().projects[0]).toBe(saved);
    expect(useProjectsStore.getState().error).toContain('保留在内存');
    await useProjectsStore.getState().retryProgress();
    expect(useProjectsStore.getState().pendingProgress).toBe(0);
    expect(bridge.recordConversation).toHaveBeenCalledTimes(2);
    expect(useProjectsStore.getState().projects[0].goalConfirmed).toBe(false);
    expect(useProjectsStore.getState().projects[0].tasks[0].status).toBe('pending');
  });
  it('归档会话重开时复用保存的对话标识，后续运行仍归属原项目', async () => {
    seedChatDraft();
    const saved = linkedProject();
    const archived = { sessionId: 'existing-session', title: '归档任务对话', cwd: '/project-work', messages: [], createdAt: 1, cost: 0, inputTokens: 0, outputTokens: 0 };
    useStore.setState({ sessions: [archived] });
    useProjectsStore.setState({ projects: [saved], open: true });
    bridge.linkConversation = vi.fn();
    expect(await useProjectsStore.getState().startConversation('p', 'a', 'existing-chat')).toBe(true);
    const activeId = useStore.getState().activeConversationId;
    expect(activeId).toBe('existing-chat');
    expect(useStore.getState().conversations.find(item => item.id === activeId)?.sessionId).toBe('existing-session');
    expect(saved.conversations?.some(link => link.conversationId === activeId)).toBe(true);
    expect(bridge.linkConversation).not.toHaveBeenCalled();
  });
  it('显式目录项目的 link 失败不创建对话、不改全局目录、不消费原草稿', async () => {
    const originalId = seedChatDraft();
    const originalConversations = useStore.getState().conversations;
    const saved = linkedProject();
    useProjectsStore.setState({ projects: [saved], open: true });
    bridge.linkConversation = vi.fn().mockRejectedValue(new Error('link disk full'));
    const newConversation = vi.spyOn(useStore.getState(), 'newConversation');
    expect(await useProjectsStore.getState().startConversation('p', 'a')).toBe(false);
    expect(bridge.linkConversation).toHaveBeenCalledWith('p', expect.objectContaining({ cwd: '/project-work', taskId: 'a' }));
    expect(newConversation).not.toHaveBeenCalled();
    expect(useStore.getState().conversations).toBe(originalConversations);
    expect(useStore.getState().activeConversationId).toBe(originalId);
    expect(useStore.getState().conversations[0].draft).toBe('不要消费的原草稿');
    expect(useStore.getState().cwd).toBe('/global-default');
    expect(useProjectsStore.getState().projects[0]).toBe(saved);
    expect(useProjectsStore.getState().open).toBe(true);
    expect(useProjectsStore.getState().error).toContain('link disk full');
  });

  it('关联落盘后才创建会话，简报草稿携带项目、任务及显式目录且不自动发送', async () => {
    const originalId = seedChatDraft();
    const saved = linkedProject();
    useProjectsStore.setState({ projects: [saved], open: true });
    const pending = deferred<ManagedProject[]>();
    bridge.linkConversation = vi.fn().mockReturnValue(pending.promise);
    const newConversation = vi.spyOn(useStore.getState(), 'newConversation');
    const sendPrompt = vi.spyOn(useStore.getState(), 'sendPrompt');
    const starting = useProjectsStore.getState().startConversation('p', 'b');
    try {
      expect(bridge.linkConversation).toHaveBeenCalledTimes(1);
      expect(newConversation).not.toHaveBeenCalled();
      expect(useStore.getState().conversations).toHaveLength(1);
      expect(useStore.getState().activeConversationId).toBe(originalId);
      expect(useProjectsStore.getState().writeOperation).toBe('mutate');
    } finally {
      const link = vi.mocked(bridge.linkConversation).mock.calls[0][1];
      pending.resolve([{ ...saved, revision: 4, conversations: [...saved.conversations!, { ...link, linkedAt: 2 }] }]);
      await starting;
    }
    expect(await starting).toBe(true);
    const link = vi.mocked(bridge.linkConversation).mock.calls[0][1];
    expect(link).toMatchObject({ cwd: '/project-work', taskId: 'b', title: '客户管理系统 · 创建客户详情' });
    expect(newConversation).toHaveBeenCalledExactlyOnceWith({ id: link.conversationId, cwd: '/project-work', title: link.title, draft: expect.any(String) });
    const conversation = useStore.getState().conversations.find(item => item.id === link.conversationId)!;
    expect(conversation.draft).toContain('项目目标：构建客户管理系统');
    expect(conversation.draft).toContain('本次任务：创建客户详情');
    expect(conversation.draft).toContain('工作目录：/project-work');
    expect(conversation.messages).toEqual([]);
    expect(useStore.getState().activeConversationId).toBe(link.conversationId);
    expect(useStore.getState().conversations[0].draft).toBe('不要消费的原草稿');
    expect(useStore.getState()).toMatchObject({ cwd: '/global-default', model: 'sonnet', permissionMode: 'acceptEdits', effortLevel: 'high' });
    expect(useProjectsStore.getState().projects[0].conversations).toContainEqual(expect.objectContaining({ conversationId: conversation.id, taskId: 'b' }));
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().open).toBe(false);
  });

  it('恢复已有 resume 对话只激活原标签，不新建或重新关联、不改模型权限与原草稿', async () => {
    seedChatDraft();
    useStore.getState().newConversation({ id: 'existing-chat', cwd: '/project-work', draft: '已有对话的草稿' });
    useStore.getState().setActiveConversation('original-chat');
    const conversations = useStore.getState().conversations;
    useProjectsStore.setState({ projects: [linkedProject()], open: true });
    bridge.linkConversation = vi.fn();
    const newConversation = vi.spyOn(useStore.getState(), 'newConversation');
    expect(await useProjectsStore.getState().startConversation('p', 'a', 'existing-chat')).toBe(true);
    expect(useStore.getState().activeConversationId).toBe('existing-chat');
    expect(useStore.getState().conversations).toBe(conversations);
    expect(useStore.getState().conversations[1].draft).toBe('已有对话的草稿');
    expect(useStore.getState()).toMatchObject({ cwd: '/global-default', model: 'sonnet', permissionMode: 'acceptEdits', effortLevel: 'high' });
    expect(newConversation).not.toHaveBeenCalled();
    expect(bridge.linkConversation).not.toHaveBeenCalled();
    expect(bridge.update).not.toHaveBeenCalled();
  });

  it('关联 resumeId 可按 sessionId 找到已打开标签，不制造第二个对话', async () => {
    seedChatDraft();
    useStore.getState().newConversation({ id: 'renamed-local-chat', cwd: '/project-work', draft: '恢复草稿' });
    useStore.setState(state => ({ conversations: state.conversations.map(item => item.id === 'renamed-local-chat' ? { ...item, sessionId: 'existing-session' } : item), activeConversationId: 'original-chat' }));
    useProjectsStore.setState({ projects: [linkedProject()] });
    bridge.linkConversation = vi.fn();
    const newConversation = vi.spyOn(useStore.getState(), 'newConversation');
    expect(await useProjectsStore.getState().startConversation('p', undefined, 'existing-chat')).toBe(true);
    expect(useStore.getState().activeConversationId).toBe('renamed-local-chat');
    expect(useStore.getState().conversations).toHaveLength(2);
    expect(useStore.getState().conversations[1].draft).toBe('恢复草稿');
    expect(newConversation).not.toHaveBeenCalled();
    expect(bridge.linkConversation).not.toHaveBeenCalled();
  });

  it('没有目录时取消选择不会关联或创建对话，也不使用全局默认目录', async () => {
    seedChatDraft();
    useProjectsStore.setState({ projects: [fixture()], open: true });
    bridge.linkConversation = vi.fn();
    const openDirectory = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('window', { ...window, api: { ...(window as any).api, openDirectory } });
    const newConversation = vi.spyOn(useStore.getState(), 'newConversation');
    expect(await useProjectsStore.getState().startConversation('p', 'a')).toBe(false);
    expect(openDirectory).toHaveBeenCalledTimes(1);
    expect(bridge.linkConversation).not.toHaveBeenCalled();
    expect(bridge.update).not.toHaveBeenCalled();
    expect(newConversation).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().notice).toContain('未选择工作目录');
    expect(useStore.getState()).toMatchObject({ activeConversationId: 'original-chat', cwd: '/global-default' });
    expect(useStore.getState().conversations[0].draft).toBe('不要消费的原草稿');
  });

  it('缺少对话关联 bridge 时返回明确错误，不创建会话或消费草稿', async () => {
    seedChatDraft();
    useProjectsStore.setState({ projects: [linkedProject()], open: true });
    const newConversation = vi.spyOn(useStore.getState(), 'newConversation');
    expect(await useProjectsStore.getState().startConversation('p', 'a')).toBe(false);
    expect(useProjectsStore.getState().error).toContain('桌面应用');
    expect(newConversation).not.toHaveBeenCalled();
    expect(useStore.getState().conversations[0].draft).toBe('不要消费的原草稿');
    expect(useStore.getState().cwd).toBe('/global-default');
  });

  it('整个项目 bridge 缺失时 startConversation 返回 false 与错误而不是抛出', async () => {
    seedChatDraft();
    useProjectsStore.setState({ projects: [linkedProject()] });
    const newConversation = vi.spyOn(useStore.getState(), 'newConversation');
    vi.stubGlobal('window', { api: {}, confirm: vi.fn(() => true) });
    await expect(useProjectsStore.getState().startConversation('p', 'a')).resolves.toBe(false);
    expect(useProjectsStore.getState().error).toContain('桌面应用');
    expect(newConversation).not.toHaveBeenCalled();
    expect(useStore.getState().conversations[0].draft).toBe('不要消费的原草稿');
  });

  it('recordConversation 记录成功、失败与取消运行都不自动改变任务状态或验收', async () => {
    let saved = linkedProject();
    useProjectsStore.setState({ projects: [saved] });
    bridge.recordConversation = vi.fn(async (_id, result) => {
      saved = { ...saved, revision: saved.revision! + 1, conversations: saved.conversations!.map(link => ({ ...link, lastRun: result })) };
      return [saved];
    });
    for (const status of ['completed', 'failed', 'aborted'] as const) {
      await useProjectsStore.getState().recordConversation('existing-chat', { ...completedRun, status });
      expect(useProjectsStore.getState().projects[0].tasks.map(task => task.status)).toEqual(['pending', 'pending']);
      expect(useProjectsStore.getState().projects[0].goalConfirmed).toBe(false);
      expect(useProjectsStore.getState().projects[0].conversations![0].lastRun?.status).toBe(status);
    }
    expect(bridge.recordConversation).toHaveBeenCalledTimes(3);
    expect(bridge.update).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().notice).toContain('未自动修改任务');
  });

  it('写入期间延迟记录运行，save 后只调用一次且下一次 patch 使用最新缓存 revision', async () => {
    const saved = linkedProject();
    const pending = deferred<ManagedProject[]>();
    const afterSave = { ...saved, name: '保存中的名称', revision: 4 };
    const afterRecord = { ...afterSave, revision: 5, conversations: saved.conversations!.map(link => ({ ...link, lastRun: completedRun })) };
    useProjectsStore.setState({ projects: [saved] });
    bridge.patch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([{ ...afterRecord, description: '下一次编辑', revision: 6 }]);
    bridge.recordConversation = vi.fn().mockResolvedValue([afterRecord]);
    const saving = useProjectsStore.getState().save('p', { name: '保存中的名称' });
    try {
      await useProjectsStore.getState().recordConversation('existing-chat', completedRun);
      expect(bridge.recordConversation).not.toHaveBeenCalled();
      expect(useProjectsStore.getState().projects[0]).toBe(saved);
      expect(useProjectsStore.getState().writeOperation).toBe('save');
    } finally {
      pending.resolve([afterSave]);
      await saving;
      await flushQueues();
    }
    expect(await saving).toBe(true);
    expect(bridge.recordConversation).toHaveBeenCalledExactlyOnceWith('existing-chat', completedRun);
    expect(useProjectsStore.getState().projects[0]).toMatchObject({ name: '保存中的名称', revision: 5 });
    expect(useProjectsStore.getState().projects[0].tasks.map(task => task.status)).toEqual(['pending', 'pending']);
    expect(await useProjectsStore.getState().save('p', { description: '下一次编辑' })).toBe(true);
    expect(vi.mocked(bridge.patch).mock.calls.map(([request]) => request)).toEqual([
      { id: 'p', expectedRevision: 3, changes: { name: '保存中的名称' } },
      { id: 'p', expectedRevision: 5, changes: { description: '下一次编辑' } },
    ]);
    await flushQueues();
    expect(bridge.recordConversation).toHaveBeenCalledTimes(1);
    expect(bridge.update).not.toHaveBeenCalled();
  });

  it('归档、删除与已合并项目只读，save 不写入或复活生命周期', async () => {
    const inactive: ManagedProject[] = [
      { ...fixture('archived'), archivedAt: 1 }, { ...fixture('deleted'), deletedAt: 2 }, { ...fixture('merged'), mergedInto: 'target' },
    ];
    useProjectsStore.setState({ projects: inactive });
    bridge.patch = vi.fn();
    for (const project of inactive) {
      expect(await useProjectsStore.getState().save(project.id, { name: '不得复活' })).toBe(false);
      expect(useProjectsStore.getState().projects.find(item => item.id === project.id)).toBe(project);
      expect(useProjectsStore.getState().error).toContain('只读');
    }
    expect(bridge.patch).not.toHaveBeenCalled();
    expect(bridge.update).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().projects).toBe(inactive);
  });
});
