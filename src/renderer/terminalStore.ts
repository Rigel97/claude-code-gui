import { create } from 'zustand';

export type TerminalMode = 'interactive' | 'teams' | 'remote' | 'cloud' | 'mcp' | 'plugins' | 'agents' | 'auth' | 'doctor' | 'shell';
export type TerminalInitialCommand = '/mcp' | '/plugin' | '/hooks' | '/config' | '/resume';
export interface TerminalSpec {
  mode: TerminalMode;
  cwd: string;
  sessionId?: string;
  resume?: boolean;
  initialCommand?: TerminalInitialCommand;
  options?: { chrome?: boolean; ide?: boolean; worktree?: string; cloudSession?: string; model?: string; permissionMode?: string };
  title?: string;
  cols?: number;
  rows?: number;
}
export interface TerminalMeta {
  id: string;
  title: string;
  mode: TerminalMode;
  suggestedCommand?: string;
  initialCommand?: TerminalInitialCommand;
  resume?: boolean;
  ownerWebContentsId?: number;
  cwd: string;
  sessionId?: string;
  status: 'running' | 'closing' | 'exited';
  seq: number;
  exitCode?: number | null;
}
export interface TerminalDataEvent {
  id: string;
  data: string;
  seq: number;
  truncated?: boolean;
  ownerWebContentsId?: number;
}
export interface TerminalExitEvent {
  id: string;
  status: 'exited';
  seq?: number;
  exitCode?: number | null;
  truncated?: boolean;
  ownerWebContentsId?: number;
}
export interface TerminalAttachment {
  snapshot: string;
  lastSeq: number;
  status: TerminalMeta['status'];
  exitCode?: number | null;
  truncated: boolean;
}
export interface TerminalAPI {
  create(spec: TerminalSpec): Promise<TerminalMeta>;
  list(): Promise<TerminalMeta[]>;
  attach(id: string): Promise<TerminalAttachment>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
  onData(callback: (event: TerminalDataEvent) => void): () => void;
  onExit(callback: (event: TerminalExitEvent) => void): () => void;
  health(): Promise<{ available: boolean; diagnostic?: string | null; error?: string }>;
}

/** Local protocol typing: no preload/global declaration changes required. */
export function getTerminalAPI(): TerminalAPI | undefined {
  return (globalThis as { window?: { api?: { terminal?: TerminalAPI } } }).window?.api?.terminal;
}
export function terminalError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function requireAPI(): TerminalAPI {
  const api = getTerminalAPI();
  if (!api) throw new Error('原生终端不可用：当前窗口没有 terminal IPC');
  return api;
}

export interface TerminalState {
  open: boolean;
  activeTerminalId: string | null;
  terminals: TerminalMeta[];
  loading: boolean;
  error: string | null;
  available: boolean;
  formSpec: Partial<TerminalSpec> | undefined;
  formVersion: number;
  show(spec?: Partial<TerminalSpec>): void;
  hide(): void;
  create(spec: TerminalSpec): Promise<TerminalMeta>;
  list(): Promise<void>;
  refresh(): Promise<void>;
  select(id: string): void;
  close(id: string): Promise<void>;
}
let creating: Promise<TerminalMeta> | undefined;
let refreshing: Promise<void> | undefined;
const closing = new Map<string, Promise<void>>();
let revision = 0;
let pending = 0;
function busy(delta: number) {
  pending += delta;
  useTerminalStore.setState({ loading: pending > 0 });
}
export function updateTerminal(id: string, patch: Partial<TerminalMeta>) {
  if (!useTerminalStore.getState().terminals.some(term => term.id === id)) return;
  revision++;
  useTerminalStore.setState(state => ({
    terminals: state.terminals.map(term => term.id !== id ? term : {
      ...term, ...patch,
      // An exit event must win over a stale attach/list response.
      ...(term.status === 'exited' ? { status: term.status, exitCode: term.exitCode } : {}),
      ...(closing.has(id) && term.status === 'closing' && patch.status === 'running' ? { status: 'closing' as const } : {}),
    }),
  }));
}
export const useTerminalStore = create<TerminalState>((set, get) => ({
  open: false, activeTerminalId: null, terminals: [], loading: false, error: null,
  available: !!getTerminalAPI(), formSpec: undefined, formVersion: 0,
  show(spec) {
    set(state => ({ open: true, formSpec: spec, formVersion: state.formVersion + 1 }));
    void get().refresh();
  },
  hide() { set({ open: false, formSpec: undefined }); },
  select(id) { if (get().terminals.some(term => term.id === id)) set({ activeTerminalId: id }); },
  create(spec) {
    if (creating) return creating;
    busy(1); set({ error: null });
    creating = Promise.resolve().then(() => requireAPI().create(spec)).then(meta => {
      revision++;
      set(state => ({ terminals: [...state.terminals.filter(t => t.id !== meta.id), meta], activeTerminalId: meta.id }));
      return meta;
    }).catch(error => { set({ error: terminalError(error) }); throw error; }).finally(() => { creating = undefined; busy(-1); });
    return creating;
  },
  list() { return get().refresh(); },
  refresh() {
    if (refreshing) return refreshing;
    const start = revision;
    busy(1); set({ error: null });
    refreshing = Promise.resolve().then(async () => {
      const api = requireAPI();
      // Health controls creation, not access to retained/exited PTY records.
      const [health, listing] = await Promise.allSettled([
        Promise.resolve().then(() => api.health()),
        Promise.resolve().then(() => api.list()),
      ]);
      const healthError = health.status === 'rejected' ? terminalError(health.reason)
        : !health.value.available ? health.value.diagnostic || health.value.error || '原生 PTY 不可用' : null;
      set({ available: health.status === 'fulfilled' && health.value.available, error: healthError });
      if (listing.status === 'rejected') throw listing.reason;
      const terminals = listing.value;
      if (start === revision) {
        set(state => ({ terminals: terminals.map(term => {
          const previous = state.terminals.find(t => t.id === term.id);
          if (previous?.status === 'exited') return { ...term, status: previous.status, exitCode: previous.exitCode };
          if (closing.has(term.id) && previous?.status === 'closing' && term.status === 'running') return { ...term, status: 'closing' as const };
          return term;
        }), activeTerminalId: terminals.some(t => t.id === state.activeTerminalId) ? state.activeTerminalId : terminals[0]?.id ?? null }));
      }
    }).catch(error => {
      set({ error: terminalError(error), ...(!getTerminalAPI() ? { available: false } : {}) });
    }).finally(() => { refreshing = undefined; busy(-1); });
    return refreshing;
  },
  close(id) {
    const existing = closing.get(id);
    if (existing) return existing;
    busy(1); set({ error: null });
    // User intent starts closing; only actual IPC completion permits removal.
    updateTerminal(id, { status: 'closing' });
    const task = Promise.resolve().then(() => requireAPI().close(id)).then((result: unknown) => {
      if (result && typeof result === 'object' && 'success' in result && result.success === false) {
        const message = 'error' in result && typeof result.error === 'string' ? result.error : '终端关闭失败；进程可能仍存活，请重试或刷新';
        throw new Error(message);
      }
      revision++;
      set(state => {
        const terminals = state.terminals.filter(t => t.id !== id);
        return { terminals, activeTerminalId: state.activeTerminalId === id ? terminals[0]?.id ?? null : state.activeTerminalId };
      });
    }).catch(error => { set({ error: terminalError(error) }); throw error; }).finally(() => { closing.delete(id); busy(-1); });
    closing.set(id, task);
    return task;
  },
}));
