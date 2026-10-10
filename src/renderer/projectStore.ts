import { create } from 'zustand';
import type { Conversation, Session } from './types';
import type { ManagedProject, ProjectReview, ProjectScan, ProjectScanOptions, ProjectScanPlan, ProjectScanProgress, ProjectsAPI, RecognitionMode } from './projectTypes';
import { dependencyError, patchProject } from './projectModel';

export type CandidateReview = ProjectReview & { selected: boolean };
interface ProjectsState {
  open: boolean;
  selectedProjectId: string | null;
  projects: ManagedProject[];
  loaded: boolean;
  loading: boolean;
  operation: 'prepare' | 'scan' | 'confirm' | 'save' | null;
  recognitionMode: RecognitionMode;
  scanPlan: ProjectScanPlan | null;
  scanProgress: ProjectScanProgress | null;
  requestId: string | null;
  cancelling: boolean;
  scanResult: ProjectScan | null;
  reviews: Record<string, CandidateReview>;
  error: string | null;
  notice: string | null;
  showProjects: () => void;
  showChat: () => void;
  selectProject: (id: string | null) => void;
  clearError: () => void;
  load: () => Promise<void>;
  setRecognitionMode: (mode: RecognitionMode) => void;
  prepare: (sessions: Session[], conversations: Conversation[]) => Promise<void>;
  discardPlan: () => void;
  cancelScan: () => Promise<void>;
  scan: (sessions: Session[], conversations: Conversation[], options?: ProjectScanOptions) => Promise<void>;
  review: (id: string, changes: Partial<CandidateReview>) => void;
  associate: (id: string, projectId: string) => void;
  cancelReview: () => void;
  confirm: () => Promise<boolean>;
  save: (id: string, changes: Partial<ManagedProject>) => Promise<boolean>;
}

function api(): ProjectsAPI {
  const bridge = typeof window === 'undefined' ? undefined : (window as unknown as { api?: { projects?: ProjectsAPI } }).api?.projects;
  if (!bridge) throw new Error('项目管理需要桌面应用的本地接口，请重新启动更新后的 Electron 应用。');
  return bridge;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Backend is the only persistence owner. UI changes commit only after a successful write. */
export const useProjectsStore = create<ProjectsState>((set, get) => ({
  open: false, selectedProjectId: null, projects: [], loaded: false, loading: false,
  operation: null, recognitionMode: 'llm', scanPlan: null, scanProgress: null, requestId: null, cancelling: false,
  scanResult: null, reviews: {}, error: null, notice: null,
  showProjects: () => set({ open: true, selectedProjectId: null }),
  showChat: () => set({ open: false }),
  selectProject: selectedProjectId => set({ selectedProjectId }),
  clearError: () => set({ error: null }),
  load: async () => {
    if (get().loading || get().operation) return;
    set({ loading: true, error: null });
    try {
      const projects = await api().list();
      set({ projects, loaded: true });
    } catch (error) { set({ error: message(error) }); }
    finally { set({ loading: false }); }
  },
  setRecognitionMode: recognitionMode => {
    if (!get().operation && !get().scanResult && !get().scanPlan) set({ recognitionMode });
  },
  prepare: async (sessions, conversations) => {
    if (get().operation || get().loading) return;
    set({ operation: 'prepare', error: null, notice: null, scanPlan: null, scanProgress: null });
    try {
      const bridge = api();
      if (typeof bridge.prepare !== 'function') throw new Error('请重新启动更新后的桌面应用以启用 LLM 识别。');
      const scanPlan = await bridge.prepare({ sessions, conversations });
      set({ scanPlan, open: true });
    } catch (error) { set({ error: `历史准备失败（未发送模型）：${message(error)}` }); }
    finally { set({ operation: null }); }
  },
  discardPlan: () => { if (!get().operation) set({ scanPlan: null, error: null }); },
  cancelScan: async () => {
    const { operation, requestId, cancelling } = get();
    if (operation !== 'scan' || !requestId || cancelling) return;
    set({ cancelling: true });
    try {
      const stopped = await api().cancelScan(requestId);
      if (!stopped && get().requestId === requestId) set({ error: '取消尚未生效或识别已结束，请核对结果；未将请求标记为已取消。', cancelling: false });
    } catch (error) { set({ error: `取消请求失败：${message(error)}`, cancelling: false }); }
  },
  scan: async (sessions, conversations, options) => {
    if (get().operation || get().loading) return;
    if (options?.mode === 'llm' && (!get().scanPlan || options.planId !== get().scanPlan?.planId || options.consent !== true)) {
      set({ error: '请先准备历史并确认发送范围和费用，再进行 LLM 识别。' }); return;
    }
    const requestId = options?.mode === 'llm' ? crypto.randomUUID() : null;
    let unsubscribe: (() => void) | undefined;
    set({ operation: 'scan', requestId, cancelling: false, error: null, notice: null, scanResult: null, reviews: {}, scanProgress: null, scanPlan: null });
    try {
      const bridge = api();
      if (requestId && bridge.onScanProgress) unsubscribe = bridge.onScanProgress(progress => {
        if (progress.requestId === get().requestId && get().operation === 'scan') set({ scanProgress: progress });
      });
      const scanResult = await bridge.scan({ sessions, conversations, ...options, ...(requestId ? { requestId } : {}) });
      const reviews: Record<string, CandidateReview> = {};
      for (const candidate of scanResult.candidates) {
        const existing = get().projects.find(project => project.id === candidate.existingProjectId);
        reviews[candidate.id] = {
          candidateId: candidate.id, selected: false,
          name: existing?.name ?? candidate.name, goal: existing?.goal ?? candidate.goal,
          description: existing?.description ?? candidate.description,
          ...(existing ? { existingProjectId: existing.id } : {}),
        };
      }
      if (!get().cancelling) set({ scanResult, reviews, scanPlan: null, open: true });
      else set({ notice: '识别已取消，未保存任何候选；已发出的请求可能产生费用。' });
    } catch (error) {
      if (get().cancelling || /abort|取消/i.test(message(error))) set({ notice: '识别已取消，未保存任何候选；已发出的请求可能产生费用。' });
      else set({ error: `识别失败（不会自动回退到规则）：${message(error)}` });
    }
    finally { unsubscribe?.(); set({ operation: null, requestId: null, cancelling: false, scanPlan: null }); }
  },
  review: (id, changes) => {
    if (get().operation || !get().reviews[id]) return;
    set(state => ({ reviews: { ...state.reviews, [id]: { ...state.reviews[id], ...changes, candidateId: id } } }));
  },
  associate: (id, projectId) => {
    const candidate = get().scanResult?.candidates.find(item => item.id === id);
    if (!candidate || get().operation) return;
    const existing = get().projects.find(project => project.id === projectId);
    get().review(id, {
      existingProjectId: existing?.id, allowDuplicate: false,
      name: existing?.name ?? candidate.name, goal: existing?.goal ?? candidate.goal,
      description: existing?.description ?? candidate.description,
    });
  },
  cancelReview: () => {
    if (get().operation) return;
    set({ scanResult: null, reviews: {}, error: null });
  },
  confirm: async () => {
    const { scanResult, reviews, operation } = get();
    if (!scanResult || operation) return false;
    const selected = scanResult.candidates.map(candidate => reviews[candidate.id]).filter(review => review?.selected);
    if (!selected.length) { set({ error: '请先选择至少一个候选项目；未选择的候选不会创建或关联。' }); return false; }
    if (selected.some(review => !review.name.trim() || !review.goal.trim())) {
      set({ error: '所选项目的名称和目标不能为空。' }); return false;
    }
    // Selection flags are UI-only; never send unchecked candidates or arbitrary project objects.
    const payload: ProjectReview[] = selected.map(({ selected: _selected, ...review }) => ({
      ...review, name: review.name.trim(), goal: review.goal.trim(), description: review.description.trim(),
    }));
    set({ operation: 'confirm', error: null });
    try {
      const projects = await api().confirm(scanResult.scanId, payload);
      set({ projects, scanResult: null, reviews: {}, loaded: true, selectedProjectId: null,
        notice: `已确认 ${selected.length} 个候选，整理结果已保存。` });
      return true;
    } catch (error) { set({ error: `确认失败，未放弃审核内容：${message(error)}` }); return false; }
    finally { set({ operation: null }); }
  },
  save: async (id, changes) => {
    if (get().operation || get().loading) return false;
    const current = get().projects.find(project => project.id === id);
    if (!current) { set({ error: '项目不存在，请重新加载。' }); return false; }
    const project = patchProject(current, changes);
    const invalid = dependencyError(project.tasks);
    if (invalid || !project.name.trim() || !project.goal.trim()) {
      set({ error: invalid || '项目名称和目标不能为空。' }); return false;
    }
    set({ operation: 'save', error: null, notice: null });
    try {
      const projects = await api().update(project);
      set({ projects, notice: '更改已保存，进度与工作流已同步。' });
      return true;
    } catch (error) { set({ error: `保存失败，原有数据未改变：${message(error)}` }); return false; }
    finally { set({ operation: null }); }
  },
}));
