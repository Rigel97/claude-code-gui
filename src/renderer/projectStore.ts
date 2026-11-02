import { create } from 'zustand';
import { useStore } from './store';
import type { Conversation, Session } from './types';
import type { ManagedProject, ProjectChanges, ProjectConversationLink, ProjectCreateInput, ProjectReview, ProjectReviewDraft, ProjectScan, ProjectScanJob, ProjectScanOptions, ProjectScanPlan, ProjectScanProgress, ProjectScanScope, ProjectStorageInfo, ProjectsAPI, RecognitionMode } from './projectTypes';
import { acceptanceInvalidationReason, dependencyError, patchProject, projectSummary, unresolvedUncertainties } from './projectModel';

export type CandidateReview = ProjectReview & { selected: boolean };
type WriteOperation = 'confirm' | 'save' | 'mutate';
type ScanOperation = 'prepare' | 'scan';
interface ProjectsState {
  open: boolean;
  dirty: boolean;
  dirtyReasons: Record<string, boolean>;
  selectedProjectId: string | null;
  projects: ManagedProject[];
  loaded: boolean;
  loading: boolean;
  operation: WriteOperation | ScanOperation | null;
  writeOperation: WriteOperation | null;
  scanOperation: ScanOperation | null;
  recognitionMode: RecognitionMode;
  scanPlan: ProjectScanPlan | null;
  scanProgress: ProjectScanProgress | null;
  requestId: string | null;
  cancelling: boolean;
  scanResult: ProjectScan | null;
  reviews: Record<string, CandidateReview>;
  reviewOpen: boolean;
  reviewDirty: boolean;
  storageInfo: ProjectStorageInfo | null;
  pendingProgress: number;
  retryProgress: () => Promise<void>;
  error: string | null;
  notice: string | null;
  showProjects: () => void;
  showChat: () => boolean;
  confirmDiscard: (action: string, keys?: string[]) => boolean;
  setDirty: (dirty: boolean, key?: string) => void;
  clearDirty: () => void;
  selectProject: (id: string | null) => boolean;
  clearError: () => void;
  load: () => Promise<void>;
  setRecognitionMode: (mode: RecognitionMode) => void;
  prepare: (sessions: Session[], conversations: Conversation[], scope?: ProjectScanScope) => Promise<void>;
  discardPlan: () => void;
  cancelScan: () => Promise<void>;
  scan: (sessions: Session[], conversations: Conversation[], options?: ProjectScanOptions) => Promise<void>;
  review: (id: string, changes: Partial<CandidateReview>) => void;
  associate: (id: string, projectId: string) => void;
  pauseReview: () => void;
  resumeReview: () => void;
  cancelReview: () => void;
  confirm: () => Promise<boolean>;
  save: (id: string, changes: ProjectChanges) => Promise<boolean>;
  create: (input: ProjectCreateInput) => Promise<boolean>;
  archive: (id: string, archived: boolean) => Promise<boolean>;
  remove: (id: string, deleted: boolean) => Promise<boolean>;
  merge: (sourceId: string, targetId: string) => Promise<boolean>;
  startConversation: (projectId: string, taskId?: string, resumeConversationId?: string) => Promise<boolean>;
  linkConversation: (projectId: string, conversationId: string, taskId?: string) => Promise<boolean>;
  reviewConversation: (projectId: string, conversationId: string) => Promise<boolean>;
  recordConversation: (conversationId: string, result: NonNullable<ProjectConversationLink['lastRun']> & { sessionId?: string }) => Promise<void>;
  refreshStorage: () => Promise<void>;
  reload: () => Promise<boolean>;
  restoreBackup: () => Promise<boolean>;
  purge: (id: string) => Promise<boolean>;
}

function api(): ProjectsAPI {
  const bridge = typeof window === 'undefined' ? undefined : (window as unknown as { api?: { projects?: ProjectsAPI } }).api?.projects;
  if (!bridge) throw new Error('项目管理需要桌面应用的本地接口，请重新启动更新后的 Electron 应用。');
  return bridge;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const isActive = (project: ManagedProject) => project.archivedAt === undefined && project.deletedAt === undefined && project.mergedInto === undefined;
const evidenceFields = ['background', 'constraints', 'decisions', 'deliverables'] as const;
function initialReviews(scan: ProjectScan, projects: ManagedProject[]) {
  return Object.fromEntries(scan.candidates.map(candidate => {
    const existing = projects.find(project => project.id === candidate.existingProjectId && isActive(project));
    const fields = Object.fromEntries(evidenceFields.map(field => [field, existing?.[field] || candidate[field]]));
    return [candidate.id, {
      candidateId: candidate.id, selected: false,
      name: existing?.name ?? candidate.name, goal: existing?.goal ?? candidate.goal,
      description: existing?.description ?? candidate.description, fields, reviewedFields: [],
      ...(existing ? { existingProjectId: existing.id, expectedRevision: existing.revision ?? 0 } : {}),
    } satisfies CandidateReview];
  }));
}
function projectBrief(project: ManagedProject, taskId?: string) {
  const task = project.tasks.find(item => item.id === taskId);
  const pending = unresolvedUncertainties(project);
  return [
    `# 继续项目：${project.name}`, `项目目标：${project.goal}`, `工作目录：${project.workingDirectory}`,
    project.background && `需求背景：${project.background}`, project.constraints && `约束：${project.constraints}`,
    project.decisions && `关键决策：${project.decisions}`, project.deliverables && `交付标准：${project.deliverables}`,
    task ? `本次任务：${task.name}\n${task.description}\n输入：${task.inputs.join('、') || '待确认'}\n输出：${task.outputs.join('、') || '待确认'}`
      : `未完成任务：\n${project.tasks.filter(item => item.status !== 'completed' && item.status !== 'cancelled').map(item => `- ${item.name}${item.optional ? '（可选）' : ''}`).join('\n') || '暂无'}`,
    task?.dependsOn.length ? `前置任务：${task.dependsOn.map(id => project.tasks.find(item => item.id === id)?.name || id).join('、')}` : '',
    project.retrospective?.nextSteps && `复盘下一步：${project.retrospective.nextSteps}`,
    pending.length ? `需核对：\n${pending.map(item => `- ${item}`).join('\n')}` : '',
    '请先核对背景与状态，再继续工作。未验证的信息保持待确认；对话结束不等于任务完成或项目已验收。',
  ].filter(Boolean).join('\n\n');
}

/** Project writes and read-only analysis have independent lifecycles. */
export const useProjectsStore = create<ProjectsState>((set, get) => {
  let progressUnsubscribe: (() => void) | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let draftSequence = 0;
  let draftWrites: Promise<void> = Promise.resolve();
  const pendingRuns = new Map<string, Parameters<ProjectsState['recordConversation']>[1]>();
  const failedRuns = new Set<string>();
  const writeBusy = () => !!get().writeOperation || get().loading;
  const beginWrite = (writeOperation: WriteOperation) => set({ writeOperation, operation: writeOperation, error: null, notice: null });
  const finishWrite = () => {
    set({ writeOperation: null, operation: get().scanOperation });
    set({ pendingProgress: pendingRuns.size });
    if (pendingRuns.size) queueMicrotask(() => {
      if (writeBusy()) return;
      const pending = [...pendingRuns].find(([id]) => !failedRuns.has(id));
      if (!pending) return;
      const [id, result] = pending;
      pendingRuns.delete(id);
      void get().recordConversation(id, result);
    });
  };
  const commit = (projects: ManagedProject[], force = false) => {
    const previous = new Map(get().projects.map(project => [project.id, project]));
    set({ projects: projects.map(project => {
      const old = previous.get(project.id);
      return !force && old && old.revision !== undefined && old.revision === project.revision ? old : project;
    }), loaded: true });
    void get().refreshStorage();
  };
  const linkedProject = (conversationId: string) => get().projects.find(project =>
    project.deletedAt === undefined && project.conversations?.some(link => link.conversationId === conversationId));
  const queueRun = (conversationId: string, result: Parameters<ProjectsState['recordConversation']>[1]) => {
    const previous = pendingRuns.get(conversationId);
    if (!previous || previous.recordedAt <= result.recordedAt) pendingRuns.set(conversationId, result);
    set({ pendingProgress: pendingRuns.size });
  };
  // Runs can finish before the project list is loaded; flush them once links are known.
  const flushLoadedRuns = () => {
    if (!get().loaded || writeBusy()) return;
    for (const id of [...pendingRuns.keys()]) if (!linkedProject(id)) { pendingRuns.delete(id); failedRuns.delete(id); }
    set({ pendingProgress: pendingRuns.size });
    const next = [...pendingRuns].find(([id]) => !failedRuns.has(id));
    if (!next) return;
    pendingRuns.delete(next[0]);
    void get().recordConversation(next[0], next[1]);
  };
  const stopProgress = () => { progressUnsubscribe?.(); progressUnsubscribe = undefined; clearTimeout(recoveryTimer); };
  const watchProgress = () => {
    stopProgress();
    progressUnsubscribe = api().onScanProgress?.(progress => {
      if (progress.requestId === get().requestId && get().scanOperation) set({ scanProgress: progress });
    });
  };
  const persistDraft = () => {
    const state = get();
    if (!state.scanResult?.candidates.length) return;
    const draft: ProjectReviewDraft = structuredClone({ scanResult: state.scanResult, reviews: state.reviews });
    const sequence = ++draftSequence;
    set({ reviewDirty: true });
    draftWrites = draftWrites.catch(() => {}).then(async () => {
      const bridge = api();
      if (!bridge.saveReviewDraft) return;
      await bridge.saveReviewDraft(draft);
      if (draftSequence === sequence) set({ reviewDirty: false });
    }).catch(error => {
      if (draftSequence === sequence) set({ error: `审核草稿保存失败，内存内容已保留：${message(error)}`, reviewDirty: true });
    });
  };
  const acceptScan = (scanResult: ProjectScan) => {
    set({ scanResult, reviews: initialReviews(scanResult, get().projects), reviewOpen: get().open, scanPlan: null });
    persistDraft();
  };
  const finishScan = () => {
    stopProgress();
    set({ scanOperation: null, operation: get().writeOperation, requestId: null, cancelling: false });
  };
  const applyJob = (job: ProjectScanJob) => {
    if (job.state === 'running') {
      set({ requestId: job.requestId, scanOperation: job.operation, operation: get().writeOperation || job.operation, scanProgress: job.progress || null });
      return;
    }
    finishScan();
    if (job.state === 'completed') {
      if (job.result && !get().scanResult) acceptScan(job.result);
      if (job.plan && job.plan.expiresAt > Date.now()) set({ scanPlan: job.plan });
    } else if (job.state === 'cancelled') set({ notice: '识别已取消；已发出的模型请求可能产生费用，未保存候选。' });
    else set({ error: job.error || '识别失败，未自动回退规则。' });
  };
  const recoverJob = async () => {
    const job = await api().activeJob?.();
    if (!job) return;
    applyJob(job);
    if (job.state === 'running') {
      watchProgress();
      const poll = async () => {
        if (get().requestId !== job.requestId) return;
        try {
          const current = await api().activeJob?.();
          if (!current || current.requestId !== job.requestId) { finishScan(); return; }
          applyJob(current);
          if (current.state === 'running') recoveryTimer = setTimeout(() => { void poll(); }, 1000);
        } catch (error) { finishScan(); set({ error: `恢复识别连接失败：${message(error)}` }); }
      };
      recoveryTimer = setTimeout(() => { void poll(); }, 1000);
    }
  };
  const mutate = async (action: () => Promise<ManagedProject[]>, notice: string, force = false): Promise<boolean> => {
    if (writeBusy()) return false;
    beginWrite('mutate');
    try { commit(await action(), force); set({ notice }); return true; }
    catch (error) { set({ error: `操作失败，原有数据未改变：${message(error)}` }); return false; }
    finally { finishWrite(); }
  };

  return {
    open: false, dirty: false, dirtyReasons: {}, selectedProjectId: null, projects: [], loaded: false, loading: false,
    operation: null, writeOperation: null, scanOperation: null, recognitionMode: 'llm', scanPlan: null, scanProgress: null,
    requestId: null, cancelling: false, scanResult: null, reviews: {}, reviewOpen: false, reviewDirty: false,
    storageInfo: null, pendingProgress: 0, error: null, notice: null,
    showProjects: () => set({ open: true }),
    setDirty: (dirty, key = 'default') => {
      const dirtyReasons = { ...get().dirtyReasons, [key]: dirty };
      set({ dirtyReasons, dirty: Object.values(dirtyReasons).some(Boolean) });
    },
    clearDirty: () => set({ dirty: false, dirtyReasons: {} }),
    confirmDiscard: (action, keys) => {
      const state = get();
      if (state.writeOperation) { set({ error: '正在保存，请等待完成后再离开。' }); return false; }
      const affected = keys || Object.keys(state.dirtyReasons);
      const dirty = keys ? affected.some(key => state.dirtyReasons[key]) : state.dirty;
      if (dirty && !window.confirm(`有未保存的修改。确定放弃修改并${action}吗？选择取消可继续编辑。`)) return false;
      const dirtyReasons = { ...state.dirtyReasons };
      affected.forEach(key => { delete dirtyReasons[key]; });
      set({ dirtyReasons, dirty: Object.values(dirtyReasons).some(Boolean) });
      return true;
    },
    showChat: () => {
      if (!get().confirmDiscard('离开项目管理中心')) return false;
      if (get().scanResult) get().pauseReview();
      set({ open: false, dirty: false, dirtyReasons: {} });
      return true;
    },
    selectProject: selectedProjectId => {
      if (selectedProjectId === get().selectedProjectId) return true;
      if (!get().confirmDiscard(selectedProjectId ? '切换项目' : '返回项目总览')) return false;
      set({ selectedProjectId }); return true;
    },
    clearError: () => set({ error: null }),
    load: async () => {
      if (get().loading || get().writeOperation || get().scanOperation) return;
      set({ loading: true, error: null });
      try {
        const bridge = api();
        commit(await bridge.list(), true);
        try {
          const draft = await bridge.reviewDraft?.();
          if (draft) set({ scanResult: draft.scanResult, reviews: { ...initialReviews(draft.scanResult, get().projects), ...draft.reviews }, reviewOpen: false, reviewDirty: false, notice: '已恢复待审核结果，无需重新识别。' });
          await recoverJob();
        } catch (error) { set({ error: `审核或识别恢复失败，项目数据已保留：${message(error)}` }); }
      } catch (error) { set({ error: message(error) }); void get().refreshStorage(); }
      finally { set({ loading: false }); if (!get().error) flushLoadedRuns(); }
    },
    setRecognitionMode: recognitionMode => {
      if (!get().writeOperation && !get().scanOperation && !get().scanResult && !get().scanPlan) set({ recognitionMode });
    },
    prepare: async (sessions, conversations, scope) => {
      if (writeBusy() || get().scanOperation || get().scanResult) return;
      if (get().dirty) { set({ error: '请先保存或取消当前编辑，再准备识别历史。' }); return; }
      const requestId = crypto.randomUUID();
      set({ scanOperation: 'prepare', operation: 'prepare', requestId, cancelling: false, error: null, notice: null, scanPlan: null, scanProgress: null });
      try {
        watchProgress();
        const plan = await api().prepare({ sessions, conversations, requestId, ...(scope ? { scope } : {}) });
        if (!get().cancelling) set({ scanPlan: plan });
        else set({ notice: '历史准备已取消，未发送模型。' });
      } catch (error) { set(get().cancelling || /abort|取消/i.test(message(error)) ? { notice: '历史准备已取消，未发送模型。' } : { error: `历史准备失败（未发送模型）：${message(error)}` }); }
      finally { finishScan(); }
    },
    discardPlan: () => {
      if (get().scanOperation || get().writeOperation) return;
      const planId = get().scanPlan?.planId;
      set({ scanPlan: null, error: null });
      if (planId) {
        try { void api().discardPlan?.(planId).catch(error => set({ error: `发送计划清理失败，未发送模型：${message(error)}` })); }
        catch (error) { set({ error: message(error) }); }
      }
    },
    cancelScan: async () => {
      const { scanOperation, requestId, cancelling } = get();
      if (!scanOperation || !requestId || cancelling) return;
      set({ cancelling: true });
      try {
        const stopped = await api().cancelScan(requestId);
        if (!stopped && get().requestId === requestId) set({ error: '取消尚未生效或识别已结束，请核对结果；未将请求标记为已取消。', cancelling: false });
      } catch (error) { set({ error: `取消请求失败：${message(error)}`, cancelling: false }); }
    },
    scan: async (sessions, conversations, options) => {
      if (writeBusy() || get().scanOperation || get().scanResult) return;
      if (get().dirty) { set({ error: '请先保存或取消当前编辑，再开始识别。' }); return; }
      if (options?.mode === 'llm' && (!get().scanPlan || options.planId !== get().scanPlan?.planId || options.consent !== true)) {
        set({ error: '请先准备历史并确认发送范围和费用，再进行 LLM 识别。' }); return;
      }
      const requestId = crypto.randomUUID();
      set({ scanOperation: 'scan', operation: 'scan', requestId, cancelling: false, error: null, notice: null, scanProgress: null, scanPlan: null });
      try {
        watchProgress();
        const scanResult = await api().scan({ sessions, conversations, ...options, requestId });
        if (!get().cancelling) acceptScan(scanResult);
        else set({ notice: '识别已取消，未保存任何候选；已发出的请求可能产生费用。' });
      } catch (error) {
        set(get().cancelling || /abort|取消/i.test(message(error)) ? { notice: '识别已取消，未保存任何候选；已发出的请求可能产生费用。' } : { error: `识别失败（不会自动回退到规则）：${message(error)}` });
      } finally { finishScan(); }
    },
    review: (id, changes) => {
      if (get().writeOperation || !get().reviews[id]) return;
      set(state => ({ reviews: { ...state.reviews, [id]: { ...state.reviews[id], ...changes, candidateId: id } } }));
      persistDraft();
    },
    associate: (id, projectId) => {
      const candidate = get().scanResult?.candidates.find(item => item.id === id);
      if (!candidate || get().writeOperation) return;
      const existing = get().projects.find(project => project.id === projectId);
      get().review(id, {
        existingProjectId: existing?.id, allowDuplicate: false, restoreExisting: false,
        name: existing?.name ?? candidate.name, goal: existing?.goal ?? candidate.goal,
        description: existing?.description ?? candidate.description,
        fields: Object.fromEntries(evidenceFields.map(field => [field, existing?.[field] || candidate[field]])), reviewedFields: [],
        expectedRevision: existing ? existing.revision ?? 0 : undefined,
      });
    },
    pauseReview: () => { if (!get().writeOperation) { set({ reviewOpen: false }); persistDraft(); } },
    resumeReview: () => {
      // Review overlays the current view; opening it must not clear unrelated
      // unsaved project edits or their beforeunload protection.
      if (!get().writeOperation && get().scanResult) set({ reviewOpen: true });
    },
    cancelReview: () => {
      if (get().writeOperation) return;
      if (get().scanResult && !window.confirm('确定放弃本次识别结果和审核草稿吗？模型费用不会退回，之后可能需要重新识别。')) return;
      const sequence = ++draftSequence;
      set({ scanResult: null, reviews: {}, reviewOpen: false, reviewDirty: false, error: null });
      draftWrites = draftWrites.catch(() => {}).then(async () => { await api().saveReviewDraft?.(null); }).catch(error => {
        if (sequence === draftSequence) set({ error: `草稿清理失败，请重试：${message(error)}`, reviewDirty: true });
      });
    },
    confirm: async () => {
      const { scanResult, reviews } = get();
      if (!scanResult || writeBusy()) return false;
      if (get().dirty) { set({ error: '请先保存或取消项目编辑，再确认识别结果。' }); return false; }
      const selected = scanResult.candidates.map(candidate => reviews[candidate.id]).filter(review => review?.selected);
      if (!selected.length) { set({ error: '请先选择至少一个候选项目；未选择的候选不会创建或关联。' }); return false; }
      if (selected.some(review => !review.name.trim() || !review.goal.trim())) { set({ error: '所选项目的名称和目标不能为空。' }); return false; }
      for (const review of selected) {
        const candidate = scanResult.candidates.find(item => item.id === review.candidateId)!;
        const existing = get().projects.find(project => project.id === review.existingProjectId);
        if (existing && !isActive(existing) && !review.restoreExisting) { set({ error: '归档或回收站项目需要明确勾选恢复并关联。' }); return false; }
        for (const field of evidenceFields) {
          const value = review.fields?.[field] ?? candidate[field];
          const kind = candidate.fieldEvidence?.[field]?.kind || candidate.fieldProvenance?.[field] || (scanResult.analysis?.mode === 'llm' ? 'unknown' : 'quoted');
          const novel = value !== (existing?.[field] || candidate[field]) && value !== candidate[field];
          if (value.trim() && (novel || kind === 'model' || kind === 'unknown') && !review.reviewedFields?.includes(field)) {
            set({ error: `请先核对 ${field} 的模型解释或清空不可靠内容。` }); return false;
          }
        }
      }
      const payload: ProjectReview[] = selected.map(({ selected: _selected, ...review }) => {
        const candidate = scanResult.candidates.find(item => item.id === review.candidateId)!;
        const existing = get().projects.find(project => project.id === review.existingProjectId);
        const fields = Object.fromEntries(Object.entries(review.fields || {}).filter(([field, value]) => value !== (existing?.[field as typeof evidenceFields[number]] || candidate[field as typeof evidenceFields[number]])));
        return { ...review, fields: Object.keys(fields).length ? fields : undefined,
          reviewedFields: review.reviewedFields?.length ? review.reviewedFields : undefined,
          name: review.name.trim(), goal: review.goal.trim(), description: review.description.trim() };
      });
      beginWrite('confirm');
      try {
        await draftWrites;
        commit(await api().confirm(scanResult.scanId, payload));
        ++draftSequence;
        try {
          await api().saveReviewDraft?.(null);
          set({ scanResult: null, reviews: {}, reviewOpen: false, reviewDirty: false, selectedProjectId: null,
            notice: `已确认 ${selected.length} 个候选，整理结果已保存。` });
        } catch (error) { set({ notice: '项目已保存。', error: `审核草稿清理失败，项目无需重新创建：${message(error)}`, reviewDirty: true }); }
        return true;
      } catch (error) { set({ error: `确认失败，未放弃审核内容：${message(error)}` }); return false; }
      finally { finishWrite(); }
    },
    save: async (id, changes) => {
      if (writeBusy()) return false;
      const current = get().projects.find(project => project.id === id);
      if (!current) { set({ error: '项目不存在，请重新加载。' }); return false; }
      if (!isActive(current)) { set({ error: '归档和回收站项目只读，请先恢复。' }); return false; }
      const project = patchProject(current, { ...changes, conversations: current.conversations });
      const invalid = dependencyError(project.tasks);
      if (invalid || !project.name.trim() || !project.goal.trim()) { set({ error: invalid || '项目名称和目标不能为空。' }); return false; }
      if (changes.goalConfirmed === true && !projectSummary(project).allTasksComplete) { set({ error: '至少有一项必要任务且全部完成后，才能确认目标达成。' }); return false; }
      beginWrite('save');
      try {
        const bridge = api();
        const projects = bridge.patch ? await bridge.patch({ id, expectedRevision: current.revision ?? 0, changes }) : await bridge.update(project);
        commit(projects);
        const saved = projects.find(item => item.id === id);
        const reason = current.goalConfirmed && !saved?.goalConfirmed ? saved?.acceptanceInvalidatedReason || acceptanceInvalidationReason(current, saved || project) : null;
        set({ notice: reason ? `更改已保存；目标验收已撤销：${reason}。` : '更改已保存，进度与工作流已同步。' });
        return true;
      } catch (error) { set({ error: `保存失败，原有数据未改变：${message(error)}` }); return false; }
      finally { finishWrite(); }
    },
    create: async input => {
      if (writeBusy()) return false;
      if (Object.entries(get().dirtyReasons).some(([key, dirty]) => key !== 'create-project' && dirty)) { set({ error: '请先保存或取消项目详情编辑，再创建项目。' }); return false; }
      if (!input.name.trim() || !input.goal.trim()) { set({ error: '项目名称和目标不能为空。' }); return false; }
      return mutate(async () => {
        const projects = await api().create({ ...input, name: input.name.trim(), goal: input.goal.trim(), description: input.description?.trim() || '' });
        set({ selectedProjectId: projects.at(-1)?.id || null }); return projects;
      }, '项目已创建。可设置目录并关联工作对话。');
    },
    archive: async (id, archived) => mutate(async () => {
      const projects = await api().archive(id, archived);
      if (archived && get().selectedProjectId === id) set({ selectedProjectId: null });
      return projects;
    }, archived ? '项目已归档，可在“归档”视图恢复。' : '项目已恢复为活跃。'),
    remove: async (id, deleted) => mutate(async () => {
      const projects = await api().remove(id, deleted);
      if (deleted && get().selectedProjectId === id) set({ selectedProjectId: null });
      return projects;
    }, deleted ? '项目已移入回收站，可恢复。' : '项目已恢复；恢复合并来源不会撤销目标中已有内容。'),
    merge: async (sourceId, targetId) => {
      if (sourceId === targetId) { set({ error: '不能将项目合并到自身。' }); return false; }
      return mutate(async () => {
        const projects = await api().merge(sourceId, targetId);
        if (get().selectedProjectId === sourceId) set({ selectedProjectId: targetId });
        return projects;
      }, '项目已合并，来源保留在回收站；目标验收变化请核对，恢复来源不等于撤销合并。');
    },
    startConversation: async (projectId, taskId, resumeConversationId) => {
      if (writeBusy()) return false;
      let project = get().projects.find(item => item.id === projectId);
      if (!project || !isActive(project)) { set({ error: '只能继续活跃项目，请先恢复。' }); return false; }
      if (get().dirty) { set({ error: '请先保存或取消编辑，再打开项目对话；草稿未丢弃。' }); return false; }
      const chat = useStore.getState();
      if (resumeConversationId) {
        const link = project.conversations?.find(item => item.conversationId === resumeConversationId);
        const conversation = chat.conversations.find(item => item.id === resumeConversationId || (!!link?.sessionId && item.sessionId === link.sessionId));
        const session = chat.sessions.find(item => !!link?.sessionId && item.sessionId === link.sessionId);
        if (!link || (!conversation && !session)) { set({ error: '关联对话已不在本地会话中，请查看保留摘要或新建项目对话。' }); return false; }
        if (!get().showChat()) return false;
        if (conversation) chat.setActiveConversation(conversation.id);
        else chat.newConversation({ fromSession: session!, id: link.conversationId });
        return true;
      }
      if (taskId && !project.tasks.some(task => task.id === taskId)) { set({ error: '任务已不存在，请重新核对。' }); return false; }
      if (!project.workingDirectory) {
        try {
          const choose = (window as unknown as { api?: { openDirectory?: () => Promise<string | null> } }).api?.openDirectory;
          if (!choose) throw new Error('请在项目背景中设置工作目录。');
          const cwd = await choose();
          if (!cwd) { set({ notice: '未选择工作目录，没有新建对话。' }); return false; }
          if (!await get().save(projectId, { workingDirectory: cwd })) return false;
          project = get().projects.find(item => item.id === projectId)!;
        } catch (error) { set({ error: `无法确定项目工作目录：${message(error)}` }); return false; }
      }
      const conversationId = crypto.randomUUID(), cwd = project.workingDirectory!;
      const title = taskId ? `${project.name} · ${project.tasks.find(task => task.id === taskId)!.name}` : project.name;
      let bridge: ProjectsAPI;
      try { bridge = api(); }
      catch (error) { set({ error: message(error) }); return false; }
      if (!bridge.linkConversation) { set({ error: '请重新启动更新后的桌面应用以保存项目对话关联。' }); return false; }
      const linked = await mutate(() => bridge.linkConversation!(projectId, { conversationId, cwd, title, ...(taskId ? { taskId } : {}) }), '项目对话关联已保存，简报为草稿，尚未发送。');
      if (!linked) return false;
      if (!get().showChat()) return false;
      chat.newConversation({ id: conversationId, cwd, title, draft: projectBrief(project, taskId) });
      return true;
    },
    linkConversation: async (projectId, conversationId, taskId) => {
      const conv = useStore.getState().conversations.find(item => item.id === conversationId);
      if (!conv?.cwd) { set({ error: '当前对话没有工作目录，无法关联。' }); return false; }
      const bridge = api();
      if (!bridge.linkConversation) { set({ error: '当前桌面接口不支持对话关联，请重启。' }); return false; }
      return mutate(() => bridge.linkConversation!(projectId, { conversationId, cwd: conv.cwd, title: conv.title,
        ...(conv.sessionId ? { sessionId: conv.sessionId } : {}), ...(taskId ? { taskId } : {}) }), '当前对话已关联，任务与目标验收仍需人工核对。');
    },
    reviewConversation: async (projectId, conversationId) => get().save(projectId, { conversations: [{ conversationId, reviewedAt: Date.now() }] }),
    recordConversation: async (conversationId, result) => {
      failedRuns.delete(conversationId);
      // Before any project data is known, retain the run for the load-time flush
      // instead of guessing that the conversation is unlinked.
      if (!get().loaded && !get().projects.length) { queueRun(conversationId, result); return; }
      if (!linkedProject(conversationId)) {
        pendingRuns.delete(conversationId); failedRuns.delete(conversationId); set({ pendingProgress: pendingRuns.size }); return;
      }
      if (writeBusy()) { queueRun(conversationId, result); return; }
      beginWrite('save');
      try {
        const bridge = api();
        if (!bridge.recordConversation) throw new Error('桌面接口不支持进展保存，请更新后重试。');
        commit(await bridge.recordConversation(conversationId, result));
        if ((pendingRuns.get(conversationId)?.recordedAt || 0) <= result.recordedAt) pendingRuns.delete(conversationId);
        set({ notice: '关联对话有新进展待核对；未自动修改任务完成或目标验收。' });
      } catch (error) {
        const previous = pendingRuns.get(conversationId);
        if (!previous || previous.recordedAt <= result.recordedAt) pendingRuns.set(conversationId, result);
        failedRuns.add(conversationId);
        set({ error: `对话进展保存失败，记录仍保留在内存，可重试：${message(error)}` });
      } finally { finishWrite(); }
    },
    retryProgress: async () => {
      if (writeBusy()) return;
      // Claim the whole queue first so finishWrite cannot schedule a duplicate
      // retry for entries this explicit retry is about to write.
      const queued = [...pendingRuns];
      pendingRuns.clear(); failedRuns.clear(); set({ pendingProgress: 0 });
      for (const [id, result] of queued) await get().recordConversation(id, result);
      set({ pendingProgress: pendingRuns.size });
    },
    refreshStorage: async () => {
      try { const info = await api().storageInfo?.(); if (info) set({ storageInfo: info }); }
      catch { /* The operation that failed retains its actionable error. */ }
    },
    reload: async () => {
      if (get().scanOperation || !get().confirmDiscard('从磁盘重新加载')) return false;
      return mutate(async () => { const reload = api().reload; if (!reload) throw new Error('请重启桌面应用启用重载。'); const projects = await reload(); set({ selectedProjectId: null }); return projects; }, '已从磁盘重新加载，现有文件未被覆盖。', true);
    },
    restoreBackup: async () => {
      if (get().scanOperation || !window.confirm('确定从最近的有效备份恢复项目吗？当前文件将另存保留，尚未备份的变化可能回退。') || !get().confirmDiscard('恢复项目备份')) return false;
      return mutate(async () => { const restore = api().restoreBackup; if (!restore) throw new Error('请重启桌面应用启用恢复。'); const projects = await restore(); set({ selectedProjectId: null }); return projects; }, '有效备份已恢复，恢复前文件已另存保留。', true);
    },
    purge: async id => {
      if (get().scanOperation) { set({ error: '请等待识别结束后再彻底清理项目。' }); return false; }
      return mutate(async () => { const purge = api().purge; if (!purge) throw new Error('请重启桌面应用启用彻底清理。'); const projects = await purge(id); if (get().selectedProjectId === id) set({ selectedProjectId: null }); return projects; }, '项目已彻底清理，回收站容量已释放。');
    },
  };
});
