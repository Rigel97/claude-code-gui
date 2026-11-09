import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from '../store';
import { useTerminalStore, type TerminalSpec } from '../terminalStore';
import type { ChatMessage, Conversation, ConversationRuntime } from '../types';

interface HistoryEntry {
  sessionId: string;
  summary?: string;
  customTitle?: string;
  cwd: string;
  lastModified?: number;
}
interface HistoryPage {
  sessionId: string;
  cwd: string;
  messages: unknown[];
  nextOffset: number | null;
}
interface ActionResult {
  success: boolean;
  error?: string;
  sessionId?: string;
  cwd?: string;
  title?: string;
  messages?: unknown[];
  draft?: string;
  newSession?: boolean;
  canRewind?: boolean;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  confirmationToken?: string;
  skippedLinks?: unknown[] | number;
  path?: string;
  canceled?: boolean;
  cancelled?: boolean;
}
interface SessionPayload {
  conversationId: string;
  cwd: string;
  sessionId: string;
}
interface SessionAPI {
  historyList(payload: { cwd: string; offset: number; limit: number }): Promise<HistoryEntry[]>;
  historyRead(payload: { cwd: string; sessionId: string; offset: number; limit: number }): Promise<HistoryPage>;
  fork(payload: SessionPayload & { upToMessageId?: string; title?: string }): Promise<ActionResult>;
  editFork(payload: SessionPayload & { messageId: string }): Promise<ActionResult>;
  rewind(payload: SessionPayload & { messageId: string; dryRun: boolean; confirmationToken?: string }): Promise<ActionResult>;
  close(conversationId: string): Promise<void | ActionResult>;
  runtimeState(conversationId: string): Promise<ConversationRuntime | null>;
  exportTranscript(payload: { cwd: string; sid: string; defaultName: string }): Promise<ActionResult>;
}
function apiMethod<K extends keyof SessionAPI>(name: K): SessionAPI[K] {
  const api = (window as unknown as { api?: { claude?: Partial<SessionAPI> } }).api?.claude;
  const method = api?.[name];
  if (typeof method !== 'function') throw new Error(`会话 API 不可用：${name}，请使用原生终端`);
  return method.bind(api) as SessionAPI[K];
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function successful(result: ActionResult): ActionResult {
  if (!result?.success) throw new Error(result?.error || '会话操作失败');
  return result;
}
function busy(conv: Conversation): boolean {
  return conv.status === 'starting' || conv.status === 'streaming' || !!conv.streamingMessage
    || !!conv.queue?.length || !!conv.pendingApprovals?.length || runtimeBusy(conv.runtime);
}
function runtimeBusy(runtime?: ConversationRuntime | null): boolean {
  return !!runtime && (!!runtime.busy || ['starting', 'busy', 'closing'].includes(runtime.state || '')
    || !!runtime.pendingApprovals?.length || !!runtime.pendingUserMessageIds?.length);
}

// Capture the source, never the active tab after an await. A changed transcript invalidates the result.
function sourceIsCurrent(source: Conversation, allowClosed = false): boolean {
  const current = useStore.getState().conversations.find(c => c.id === source.id);
  return !!current && current.cwd === source.cwd && current.sessionId === source.sessionId
    && current.messages === source.messages && !busy(current)
    && (current.runId === source.runId || (allowClosed && !current.runId && current.runtime?.state === 'closed'));
}
/** A dryRun may bootstrap the persistent engine and legitimately rebuild rows.
 *  Rewind only needs the same tab/session/cwd; stale row identity must not
 *  discard the confirmation token that the preview just authorized. */
function sameConversation(source: Conversation): Conversation | null {
  const current = useStore.getState().conversations.find(c => c.id === source.id);
  return current && current.cwd === source.cwd && current.sessionId === source.sessionId ? current : null;
}
async function requireIdle(source: Conversation, valid: () => boolean) {
  if (!valid() || !sourceIsCurrent(source)) throw new Error('原会话已关闭、变化或正在执行，请重新操作');
  const runtime = await apiMethod('runtimeState')(source.id);
  if (!valid() || !sourceIsCurrent(source)) throw new Error('原会话上下文已变化，未应用结果');
  if (runtime && ((runtime.conversationId !== undefined && runtime.conversationId !== source.id)
    || (runtime.sessionId != null && runtime.sessionId !== source.sessionId))) throw new Error('运行上下文不匹配，未执行会话操作');
  if (runtimeBusy(runtime)) throw new Error('会话正在执行或等待审批，不能分叉、回退或移交终端');
}
async function closeIdle(source: Conversation, valid: () => boolean) {
  await requireIdle(source, valid);
  const result = await apiMethod('close')(source.id);
  if (result && !result.success) throw new Error(result.error || '无法关闭空闲引擎');
  if (!valid() || !sourceIsCurrent(source, true)) throw new Error('原会话上下文已变化，未应用结果');
}
function payload(source: Conversation): SessionPayload {
  if (!source.sessionId) throw new Error('尚无 CLI Session ID');
  return { conversationId: source.id, cwd: source.cwd, sessionId: source.sessionId };
}

async function readAll(cwd: string, sessionId: string, valid: () => boolean): Promise<unknown[]> {
  const messages: unknown[] = [];
  let offset = 0;
  while (true) {
    if (!valid()) throw new Error('操作已取消或上下文已变化');
    const page = await apiMethod('historyRead')({ cwd, sessionId, offset, limit: 200 });
    if (!valid()) throw new Error('操作已取消或上下文已变化');
    if (page?.sessionId !== sessionId || page.cwd !== cwd || !Array.isArray(page.messages)) {
      throw new Error('历史响应的会话或目录不匹配，未导入');
    }
    // No renderer-side truncation: main enforces the safe 128 MiB history context limit.
    for (const message of page.messages) messages.push(message);
    if (page.nextOffset === null) return messages;
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('历史分页无效，未导入不完整记录');
    offset = page.nextOffset;
  }
}
function freshUIIds(messages: unknown[]): unknown[] {
  return messages.map(row => row && typeof row === 'object' && Array.isArray((row as ChatMessage).blocks)
    ? { ...row, id: crypto.randomUUID() } : row);
}
async function importFork(source: Conversation, result: ActionResult, valid: () => boolean, editing = false) {
  successful(result);
  if (result.cwd !== source.cwd) throw new Error('分叉返回的目录不匹配，未导入');
  if (editing && result.newSession) {
    if (result.sessionId || !Array.isArray(result.messages) || result.messages.length) throw new Error('新会话草稿响应无效');
    if (valid() && sourceIsCurrent(source, true)) useStore.getState().newConversation({ cwd: result.cwd, title: result.title, draft: result.draft ?? '' });
    return;
  }
  const sid = result.sessionId;
  if (!sid || sid === source.sessionId || useStore.getState().conversations.some(c => c.sessionId === sid)
    || useStore.getState().sessions.some(s => s.sessionId === sid)) throw new Error('分叉未返回独立的新 Session ID，原会话保持不变');
  const messages = result.messages ?? await readAll(result.cwd, sid, () => valid() && sourceIsCurrent(source, true));
  if (!Array.isArray(messages)) throw new Error('分叉消息格式无效');
  if (!valid() || !sourceIsCurrent(source, true)) return;
  const state = useStore.getState();
  if (state.conversations.some(c => c.sessionId === sid) || state.sessions.some(s => s.sessionId === sid)) {
    throw new Error('分叉会话已在其他标签页打开或导入，未覆盖其内容');
  }
  const id = state.importSession({ sessionId: sid, cwd: result.cwd, title: result.title, messages: freshUIIds(messages) });
  if (editing) useStore.getState().setDraft(result.draft ?? '', id);
}

const operations = new Set<string>();
const operationListeners = new Set<() => void>();
function subscribeOperations(listener: () => void) {
  operationListeners.add(listener);
  return () => { operationListeners.delete(listener); };
}
function notifyOperations() { operationListeners.forEach(listener => listener()); }
function useActionScope(key: string) {
  const locked = useSyncExternalStore(subscribeOperations, useCallback(() => operations.has(key), [key]));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const cancellation = useRef(0);
  useEffect(() => {
    generation.current++;
    setPending(false); setError(''); setNotice('');
    return () => { generation.current++; };
  }, [key]);
  const run = async (action: (valid: () => boolean) => Promise<string | void>) => {
    if (operations.has(key)) return;
    operations.add(key); notifyOperations();
    const token = generation.current;
    const cancellationToken = cancellation.current;
    const valid = () => generation.current === token && cancellation.current === cancellationToken;
    setPending(true); setError(''); setNotice('');
    try {
      const message = await action(valid);
      if (valid() && message) setNotice(message);
    } catch (error) {
      if (valid()) setError(errorText(error));
    } finally {
      operations.delete(key); notifyOperations();
      if (generation.current === token) setPending(false);
    }
  };
  const cancel = () => {
    cancellation.current++;
    setError(''); setNotice('已取消等待；迟到结果不会应用到标签页，已执行的文件或外部操作不会自动撤销。');
  };
  return { pending, locked, error, notice, run, cancel };
}
const buttonClass = 'px-2 py-1 rounded border border-border text-xs text-text-secondary hover:text-accent-cyan hover:bg-bg-light disabled:opacity-40 disabled:cursor-not-allowed';
function Feedback({ error, notice, pending, cancel }: { error: string; notice: string; pending?: boolean; cancel?: () => void }) {
  return <>
    {pending && <button className={buttonClass} title="仅取消等待和应用结果，无法撤销已提交的后端操作" onClick={cancel}>取消等待</button>}
    {error && <p role="alert" className="text-xs text-accent-red whitespace-pre-wrap">{error} · 可使用侧栏「原生终端」，不会自动发送。</p>}
    {notice && <p role="status" className="text-xs text-accent-green whitespace-pre-wrap">{notice}</p>}
  </>;
}

export function SessionMessageActions({ message, conversationId }: { message: ChatMessage; conversationId: string }) {
  const conv = useStore(s => s.conversations.find(c => c.id === conversationId));
  const action = useActionScope(conversationId);
  if (!conv || !conv.messages.includes(message)) return null;
  const disabled = action.locked || busy(conv) || !conv.sessionId;
  const user = message.role === 'user' && !!message.cliUuid;
  const assistant = message.role === 'assistant' && !!message.endUuid && message.status !== 'streaming';
  if (!user && !assistant) return null;
  return <div className="flex flex-wrap gap-2 items-center mt-2">
    {user && <button className={buttonClass} disabled={disabled} title="在此用户消息之前分叉，原文预填为草稿，不自动发送" onClick={() => void action.run(async valid => {
      await closeIdle(conv, valid);
      const result = await apiMethod('editFork')({ ...payload(conv), messageId: message.cliUuid! });
      await importFork(conv, { ...result, draft: result.draft ?? message.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n') }, valid, true);
    })}>编辑并分叉</button>}
    {user && <button className={buttonClass} disabled={disabled} title="仅回退可用文件检查点；不会撤销消息或外部操作" onClick={() => void action.run(async valid => {
      await requireIdle(conv, valid);
      const request = { ...payload(conv), messageId: message.cliUuid! };
      const preview = successful(await apiMethod('rewind')({ ...request, dryRun: true }));
      if (!valid()) return;
      // dryRun bootstraps the persistent engine for a cold session: the backend
      // publishes the real runId and may rebuild the message array. Refresh the
      // captured tab instead of rejecting the token we just received.
      const refreshed = sameConversation(conv);
      if (!refreshed) throw new Error('原会话上下文已变化，未应用结果');
      if (!preview.canRewind || !preview.confirmationToken) throw new Error(preview.error || '此消息没有可用的文件回退检查点');
      const files = preview.filesChanged ?? [];
      const confirmed = window.confirm(`回退以下文件到此用户消息的检查点？\n${files.join('\n') || '没有文件变更'}\n新增 ${preview.insertions ?? 0} 行 / 删除 ${preview.deletions ?? 0} 行\n\n不会撤销外部操作（命令、网络、数据库等），也不会删除对话历史。不会自动重做。`);
      if (!confirmed || !valid()) return;
      await requireIdle(refreshed, valid);
      const result = successful(await apiMethod('rewind')({ ...payload(refreshed), messageId: message.cliUuid!, dryRun: false, confirmationToken: preview.confirmationToken }));
      if (!valid() || !sameConversation(refreshed)) return;
      const skipped = Array.isArray(result.skippedLinks) ? result.skippedLinks.length : result.skippedLinks ?? 0;
      return skipped ? `文件回退已执行；跳过 ${skipped} 个链接，未全部恢复。外部操作未撤销。` : '文件回退已执行；外部操作未撤销，对话历史保留。';
    })}>回退文件</button>}
    {assistant && <button className={buttonClass} disabled={disabled} onClick={() => void action.run(async valid => {
      await closeIdle(conv, valid);
      await importFork(conv, await apiMethod('fork')({ ...payload(conv), upToMessageId: message.endUuid! }), valid);
    })}>从此处分叉</button>}
    <Feedback {...action}/>
  </div>;
}

export function SessionHistoryPanel({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const scope = useRef(0);
  const listing = useRef<number | null>(null);
  const action = useActionScope(`history:${cwd}`);
  const load = async (nextOffset: number, generation = scope.current) => {
    if (listing.current === generation) return;
    listing.current = generation; setLoading(true); setListError('');
    try {
      const rows = await apiMethod('historyList')({ cwd, offset: nextOffset, limit: 50 });
      if (generation !== scope.current) return;
      if (!Array.isArray(rows) || rows.some(row => typeof row?.sessionId !== 'string' || !row.sessionId
        || typeof row.cwd !== 'string' || !row.cwd)) throw new Error('历史列表目录或格式不匹配');
      setEntries(previous => {
        const all = nextOffset === 0 ? rows : [...previous, ...rows];
        return all.filter((row, i) => all.findIndex(other => other.sessionId === row.sessionId) === i);
      });
      setOffset(nextOffset + rows.length); setMore(rows.length === 50);
    } catch (error) { if (generation === scope.current) setListError(errorText(error)); }
    finally {
      if (listing.current === generation) listing.current = null;
      if (generation === scope.current) setLoading(false);
    }
  };
  useEffect(() => {
    const generation = ++scope.current;
    setEntries([]); setOffset(0); setMore(true);
    void load(0, generation);
    return () => { scope.current++; };
  }, [cwd]);
  const cancel = () => { scope.current++; onClose(); };
  const importHistory = (entry: HistoryEntry) => void action.run(async valid => {
    const generation = scope.current;
    const state = useStore.getState();
    const source = state.conversations.find(c => c.id === state.activeConversationId);
    if (!source) throw new Error('没有可用的原会话上下文');
    const current = () => valid() && generation === scope.current && sourceIsCurrent(source);
    if (!current()) throw new Error('请等待当前会话空闲后导入');
    const existing = state.conversations.find(c => c.sessionId === entry.sessionId);
    if (existing) { state.setActiveConversation(existing.id); cancel(); return; }
    const messages = await readAll(entry.cwd, entry.sessionId, current);
    if (!current()) return;
    // Another window action may have opened this session while history was loading.
    if (useStore.getState().conversations.some(c => c.sessionId === entry.sessionId)) throw new Error('会话已在其他标签页打开，未覆盖其内容');
    useStore.getState().importSession({ sessionId: entry.sessionId, cwd: entry.cwd,
      title: entry.customTitle || entry.summary || entry.sessionId, messages: freshUIIds(messages) });
    cancel();
  });
  return <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={event => { if (event.target === event.currentTarget) cancel(); }}>
    <section role="dialog" aria-modal="true" aria-label="CLI 历史" className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-bg-deep p-5 space-y-3">
      <div className="flex justify-between items-center"><h2 className="text-text-primary">CLI 历史</h2><button className={buttonClass} onClick={cancel}>关闭历史</button></div>
      <p className="text-xs text-text-muted break-all">{cwd} · 导入完整历史不会自动分叉或发送消息</p>
      {entries.map(entry => {
        const title = entry.customTitle || entry.summary || entry.sessionId;
        return <div key={entry.sessionId} className="flex items-center gap-2 border-b border-border/30 py-2">
          <div className="flex-1 min-w-0"><div className="text-sm text-text-primary break-words">{title}</div><div className="text-xs text-text-muted font-mono break-all">{entry.sessionId}{entry.lastModified != null && ` · ${new Date(entry.lastModified).toLocaleString()}`}</div></div>
          <button className={buttonClass} aria-label={`导入 ${title}`} disabled={action.locked || loading} onClick={() => importHistory(entry)}>导入历史</button>
        </div>;
      })}
      {!loading && !listError && !entries.length && <p className="text-xs text-text-muted">暂无 CLI 历史</p>}
      {loading && <p role="status">加载中…</p>}
      {listError && <p role="alert" className="text-xs text-accent-red">{listError}</p>}
      <Feedback {...action}/>
      {(more || listError) && <button className={buttonClass} disabled={loading || action.locked} onClick={() => void load(offset)}>{listError ? '重试加载' : '加载更多'}</button>}
    </section>
  </div>;
}

export function SessionActions({ conv }: { conv: Conversation }) {
  const action = useActionScope(conv.id);
  const disabled = action.locked || busy(conv) || !conv.sessionId;
  return <section aria-label="会话操作" className="px-4 py-2 border-b border-border/30 space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-mono text-text-muted selectable-text">Session ID: {conv.sessionId || '尚未创建'}</span>
      <button className={buttonClass} disabled={disabled} onClick={() => void action.run(async valid => {
        await closeIdle(conv, valid);
        await importFork(conv, await apiMethod('fork')(payload(conv)), valid);
      })}>分叉会话</button>
      <button className={buttonClass} disabled={disabled} title="只打开恢复表单；创建终端时由主进程检查并移交空闲会话所有权" onClick={() => void action.run(async valid => {
        await requireIdle(conv, valid);
        if (!valid() || !sourceIsCurrent(conv)) return;
        const spec: Partial<TerminalSpec> & { resume: true } = { mode: 'interactive', cwd: conv.cwd, sessionId: conv.sessionId!, resume: true };
        useTerminalStore.getState().show(spec);
      })}>原生终端恢复</button>
      <button className={buttonClass} disabled={action.locked || !conv.sessionId} onClick={() => void action.run(async valid => {
        const name = conv.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'session';
        const result = await apiMethod('exportTranscript')({ cwd: conv.cwd, sid: conv.sessionId!, defaultName: `${name}.jsonl` });
        if (!valid() || result?.canceled || result?.cancelled) return;
        successful(result);
        return result.path ? `原生 JSONL 已导出：${result.path}` : '原生 JSONL 已导出';
      })}>导出原生 JSONL</button>
    </div>
    <Feedback {...action}/>
  </section>;
}
