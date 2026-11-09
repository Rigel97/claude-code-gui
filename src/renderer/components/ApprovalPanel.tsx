import { useRef, useState } from 'react';
import { useStore } from '../store';
import type { Conversation, PendingApproval } from '../types';
import type { UserDialogResult } from '@anthropic-ai/claude-agent-sdk';

type JsonObject = Record<string, unknown>;
type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };
export interface ApprovalResponsePayload {
  conversationId: string;
  requestId: string;
  runId: string;
  decision: JsonObject;
}
export interface ApprovalResponseResult { success: boolean; error?: string }
export interface ApprovalBridge {
  claude?: { respond?: (payload: ApprovalResponsePayload) => Promise<ApprovalResponseResult> };
  openExternal?: (url: string) => Promise<ApprovalResponseResult>;
}
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const json = (value: unknown): string => JSON.stringify(value ?? null, null, 2);
const bridge = (): ApprovalBridge | undefined => (window as unknown as { api?: ApprovalBridge }).api;
// Scope by protocol IDs, and observe retirement before permitting reuse of an ID.
const inFlight = new Map<string, { request: PendingApproval; retired: boolean }>();
const approvalsOf = (conv?: Conversation) => conv?.pendingApprovals ?? conv?.runtime?.pendingApprovals ?? [];
function isSafeJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isSafeJson(item, depth + 1));
  return !!value && typeof value === 'object' && Object.entries(value).every(([key, item]) =>
    !['__proto__', 'constructor', 'prototype'].includes(key) && isSafeJson(item, depth + 1));
}
const controls = 'rounded border border-white/15 bg-black/20 px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan disabled:opacity-40';

/** Non-modal: this panel never aborts the run, owns a session, or grants permissions locally. */
export function NamedApprovalPanel({ conv }: { conv: Conversation }) {
  const approvals = approvalsOf(conv);
  if (!approvals.length) return null;
  return <section role="region" aria-label="Claude审批与追问" className="space-y-3 px-4 py-3">
    {approvals.map(request => <ApprovalCard key={JSON.stringify([conv.id, request.runId ?? conv.runId ?? conv.runtime?.runId, request.requestId])} conv={conv} request={request} />)}
  </section>;
}

export const ApprovalPanel = NamedApprovalPanel;

function ApprovalCard({ conv, request }: { conv: Conversation; request: PendingApproval }) {
  const runId = text(request.runId) || conv.runId || conv.runtime?.runId || '';
  const busy = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(() => json(request.input));
  const [feedback, setFeedback] = useState('');
  const [mode, setMode] = useState<'default' | 'acceptEdits'>('default');
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const rawQuestions = object(request.input).questions;
  const questions: Question[] = Array.isArray(rawQuestions) ? rawQuestions.map(raw => {
    const q = object(raw);
    return { question: text(q.question), header: text(q.header), multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options) ? q.options.map(o => ({ label: text(object(o).label), description: text(object(o).description) })) : [] };
  }) : [];
  const validQuestions = questions.length > 0 && questions.length <= 4 && questions.every(q => q.question.trim()) && new Set(questions.map(q => q.question)).size === questions.length;
  function answerQuestions() {
    const answers = Object.fromEntries(questions.map(q => {
      const values = q.options.filter(o => selected[q.question]?.includes(o.label)).map(o => o.label);
      const free = (custom[q.question] || '').trim();
      return [q.question, q.multiSelect ? [...values, ...(free ? [free] : [])].join(', ') : free || values[0] || ''];
    }));
    if (!validQuestions || Object.values(answers).some(answer => !answer.trim() || answer.length > 4000)) {
      setError('请回答每个问题，答案不能为空且最多 4000 字'); return;
    }
    void respond({ behavior: 'allow', answers });
  }
  const disabled = loading || request.status !== 'waiting';
  async function respond(decision: JsonObject) {
    const key = JSON.stringify([conv.id, runId, request.requestId]);
    if (busy.current || (inFlight.has(key) && !inFlight.get(key)!.retired) || request.status !== 'waiting') return;
    const operation = { request, retired: false };
    let unsubscribe: (() => void) | undefined;
    busy.current = true;
    setLoading(true);
    setError('');
    const payload = { conversationId: conv.id, requestId: request.requestId, runId, decision };
    try {
      if (!runId) throw new Error('缺少运行标识，无法安全回应；请等待会话同步');
      const owner = useStore.getState().conversations.find(c => c.id === conv.id);
      const pending = approvalsOf(owner);
      if (!owner || (owner.runId ?? owner.runtime?.runId) !== runId || !pending.includes(request)) throw new Error('请求已过期，请等待会话同步');
      if (!isSafeJson(decision)) throw new Error('响应包含不安全或无效的 JSON 参数');
      const api = bridge();
      if (!api?.claude?.respond) throw new Error('审批 IPC 不可用，请恢复连接后重试');
      inFlight.set(key, operation);
      unsubscribe = useStore.subscribe(state => {
        const owner = state.conversations.find(c => c.id === conv.id);
        const latest = approvalsOf(owner).find(p => p.requestId === request.requestId);
        if (!owner || (owner.runId ?? owner.runtime?.runId) !== runId || !latest) operation.retired = true;
        else if (!operation.retired && json(latest) === json(operation.request)) operation.request = latest;
      });
      const result = await api.claude.respond(payload);
      if (result?.success !== true) throw new Error(result?.error || '审批提交失败，请重试');
      // Acknowledgement is authoritative. Do not clear other runs/tabs or manufacture success on failure.
      const current = useStore.getState().conversations.find(c => c.id === payload.conversationId);
      const currentRun = current?.runId ?? current?.runtime?.runId;
      const stillPending = approvalsOf(current);
      if (current && currentRun === payload.runId && !operation.retired && stillPending.includes(operation.request)) {
        useStore.getState().handleStream({ type: 'approval_resolved', conversationId: payload.conversationId, runId: payload.runId, requestId: payload.requestId });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '审批提交失败，请重试');
    } finally {
      unsubscribe?.();
      if (inFlight.get(key) === operation) inFlight.delete(key);
      busy.current = false;
      setLoading(false);
    }
  }
  function allowTool(alwaysAllow = false) {
    try {
      const decision: JsonObject = { behavior: 'allow' };
      if (alwaysAllow) {
        if (request.alwaysAllowAvailable !== true || editing) throw new Error('服务端未提供同参数的会话授权');
        decision.alwaysAllow = true;
      } else if (editing) {
        const input: unknown = JSON.parse(edited);
        if (!input || typeof input !== 'object' || Array.isArray(input) || !isSafeJson(input)) throw new Error('编辑后的参数必须是安全的 JSON 对象');
        decision.editedInput = input;
      }
      void respond(decision);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '参数 JSON 无效'); }
  }
  const deny = () => void respond({ behavior: 'deny', ...(feedback.trim() ? { message: feedback.trim() } : {}) });
  return <article aria-label={`${request.toolName || request.kind} ${request.requestId}`} aria-busy={loading} className="rounded-lg border border-accent-cyan/30 bg-bg-secondary p-4 space-y-3 min-w-0">
    <h3 className="font-medium text-text-primary">{request.toolName || request.kind}</h3>
    <p className="text-xs text-text-muted">请求 {request.requestId} · {request.status}</p>
    {['title', 'displayName', 'description', 'blockedPath', 'decisionReason'].map(key => typeof request[key] === 'string' && <p key={key} className="whitespace-pre-wrap break-words text-sm">{text(request[key])}</p>)}
    <pre aria-label="工具参数预览" className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{json(request.input)}</pre>
    {request.kind === 'tool' && <>
      <label className="block text-sm"><input type="checkbox" checked={editing} disabled={disabled} onChange={e => setEditing(e.target.checked)} /> 编辑工具参数 JSON（可选）</label>
      {editing && <label className="block text-sm">编辑后的参数 JSON<textarea className={`${controls} block w-full max-h-64 font-mono`} rows={8} value={edited} disabled={disabled} onChange={e => setEdited(e.target.value)} /></label>}
      <label className="block text-sm">拒绝反馈（可选）<textarea className={`${controls} block w-full`} maxLength={4000} value={feedback} disabled={disabled} onChange={e => setFeedback(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={controls} disabled={disabled} onClick={() => allowTool()}>批准一次</button>
        <button type="button" className={controls} disabled={disabled || request.alwaysAllowAvailable !== true || editing} onClick={() => allowTool(true)}>当前会话始终允许</button>
        <button type="button" className={controls} disabled={disabled} onClick={deny}>拒绝</button>
      </div>
      <p className="text-xs text-text-muted">始终允许仅使用服务端提供的同参数授权；编辑参数只能批准一次。</p>
    </>}
    {request.kind === 'plan' && <>
      {text(object(request.input).plan) || text(request.plan) ? <pre aria-label="计划正文" className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">{text(object(request.input).plan) || text(request.plan)}</pre> : <p>未提供正文，先在聊天检查计划</p>}
      <label className="block text-sm">批准后权限模式<select className={controls} disabled={disabled} value={mode} onChange={e => setMode(e.target.value === 'acceptEdits' ? 'acceptEdits' : 'default')}>
        <option value="default">default（逐次审批）</option><option value="acceptEdits">acceptEdits（允许编辑）</option>
      </select></label>
      <label className="block text-sm">拒绝反馈（可选）<textarea className={`${controls} block w-full`} maxLength={4000} disabled={disabled} value={feedback} onChange={e => setFeedback(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2"><button type="button" className={controls} disabled={disabled} onClick={() => void respond({ behavior: 'allow', mode })}>批准计划</button><button type="button" className={controls} disabled={disabled} onClick={deny}>拒绝计划</button></div>
    </>}
    {request.kind === 'question' && <>
      {!validQuestions && <p role="alert">追问格式不支持：必须提供 1–4 个不同的问题；可取消此请求。</p>}
      {validQuestions && questions.map((q, index) => <fieldset key={q.question} disabled={disabled} className="space-y-2 rounded border border-white/15 p-3">
        <legend className="text-sm font-medium">{q.header && <span>{q.header} · </span>}{q.question}</legend>
        {q.options.map((option, i) => <label key={i} className="block whitespace-pre-wrap break-words text-sm">
          <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${conv.id}-${request.requestId}-${index}`} checked={selected[q.question]?.includes(option.label) || false} onChange={e => {
            setSelected(current => ({ ...current, [q.question]: q.multiSelect ? (e.target.checked ? [...(current[q.question] || []), option.label] : (current[q.question] || []).filter(v => v !== option.label)) : [option.label] }));
            if (!q.multiSelect) setCustom(current => ({ ...current, [q.question]: '' }));
          }} /> {option.label}{option.description && <span className="text-text-muted"> — {option.description}</span>}
        </label>)}
        <label className="block text-sm">其他答案：{q.question}<textarea rows={2} maxLength={4000} className={`${controls} block w-full`} value={custom[q.question] || ''} onChange={e => {
          setCustom(current => ({ ...current, [q.question]: e.target.value }));
          if (!q.multiSelect && e.target.value) setSelected(current => ({ ...current, [q.question]: [] }));
        }} /></label>
      </fieldset>)}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={controls} disabled={disabled || !validQuestions} onClick={answerQuestions}>提交回答</button>
        <button type="button" className={controls} disabled={disabled} onClick={deny}>取消追问</button>
      </div>
    </>}
    {request.kind === 'elicitation' && <ElicitationForm request={request} disabled={disabled} respond={respond} reportError={setError} />}
    {request.kind === 'dialog' && <>
      {request.dialogKind === 'refusal_fallback_prompt' ? <>
        <p>原模型：{text(object(request.payload ?? request.input).originalModel)} · 回退模型：{text(object(request.payload ?? request.input).fallbackModel)}</p>
        <p className="whitespace-pre-wrap break-words">{text(object(request.payload ?? request.input).guidanceText)}</p>
        <div className="flex flex-wrap gap-2">
          {/* CLI 2.1.229 defines this dialog result as a string enum, inside the SDK result object. */}
          {(['retry_fallback', 'edit_prompt'] as const).map(result => <button key={result} type="button" className={controls} disabled={disabled} onClick={() => {
            const response: UserDialogResult = { behavior: 'completed', result };
            void respond(response);
          }}>{result === 'retry_fallback' ? '切换模型重试' : '编辑提示后重试'}</button>)}
        </div>
      </> : <p role="alert">不支持的对话类型：{text(request.dialogKind)}；可以安全取消。</p>}
      <button type="button" className={controls} disabled={disabled} onClick={() => {
        const response: UserDialogResult = { behavior: 'cancelled' };
        void respond(response);
      }}>取消对话请求</button>
    </>}
    {!['tool', 'question', 'plan', 'elicitation', 'dialog'].includes(request.kind) && <>
      <p role="alert">不支持的审批类型；请拒绝此请求，或等待主进程同步。</p>
      <button type="button" className={controls} disabled={disabled} onClick={deny}>拒绝不支持的请求</button>
    </>}
    {typeof request.validationError === 'string' && <p role="alert">{request.validationError}</p>}
    {loading && <p role="status">正在提交…</p>}
    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-accent-orange">{error}；可重新点击操作重试。</p>}
  </article>;
}

function ElicitationForm({ request, disabled, respond, reportError }: {
  request: PendingApproval; disabled: boolean; respond: (decision: JsonObject) => Promise<void>; reportError: (error: string) => void;
}) {
  const input = object(request.input);
  const mode = request.mode ?? input.mode ?? 'form';
  const isUrl = mode === 'url';
  const supported = mode === 'form' || isUrl;
  const url = text(request.url ?? input.url);
  let safeUrl = false;
  try { const parsed = new URL(url); safeUrl = ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { /* Invalid URL remains cancellable. */ }
  const schema = object(request.requestedSchema ?? input.requestedSchema);
  const properties = Object.entries(object(schema.properties));
  const required = Array.isArray(schema.required) ? schema.required : [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [rawContent, setRawContent] = useState('{}');
  const primitive = schema.type === 'object' && properties.every(([, raw]) => {
    const field = object(raw);
    return ['string', 'number', 'integer', 'boolean'].includes(text(field.type)) && !field.$ref && !field.oneOf && !field.anyOf && !field.allOf;
  }) && !schema.$ref && !schema.oneOf && !schema.anyOf && !schema.allOf;
  async function openUrl() {
    if (!safeUrl || disabled) return;
    try {
      const api = bridge();
      const open = api?.openExternal;
      if (!open) throw new Error('外链 IPC 不可用，请恢复连接后重试');
      const result = await open(url);
      if (object(result).success === false) throw new Error(text(object(result).error) || '打开链接失败');
    } catch (reason) { reportError(reason instanceof Error ? reason.message : '打开链接失败'); }
  }
  function accept() {
    if (disabled || !supported || (isUrl && !safeUrl)) return;
    try {
      if (isUrl) { void respond({ action: 'accept', content: {} }); return; }
      if (!primitive) {
        const content: unknown = JSON.parse(rawContent);
        if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('响应内容必须是 JSON 对象');
        void respond({ action: 'accept', content }); return;
      }
      const content = Object.fromEntries(properties.flatMap(([key, raw]) => {
        const field = object(raw);
        const value = values[key] ?? '';
        if (value === '') {
          if (required.includes(key)) throw new Error(`必填字段：${key}`);
          return [];
        }
        let parsed: unknown = value;
        if (Array.isArray(field.enum)) parsed = field.enum[Number(value)];
        else if (field.type === 'boolean') parsed = value === 'true';
        else if (field.type === 'number' || field.type === 'integer') {
          parsed = Number(value);
          if (!value.trim() || !Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed))) throw new Error(`数字格式无效：${key}`);
        }
        return [[key, parsed]];
      }));
      void respond({ action: 'accept', content });
    } catch (reason) { reportError(reason instanceof Error ? reason.message : '输入格式无效'); }
  }
  return <div className="space-y-3">
    <p className="whitespace-pre-wrap break-words">{text(request.message) || text(object(request.input).message)}</p>
    {!supported && <p role="alert">不支持的 elicitation 模式；可以拒绝或取消。</p>}
    {isUrl && <>
      <p className="whitespace-pre-wrap break-all">{url}</p>
      <p className="text-xs text-text-muted">仅在点击时交给系统浏览器。接受不代表认证已完成；完成通知由主进程关联处理。</p>
      {!safeUrl && <p role="alert">验证链接无效或不安全；可以拒绝或取消。</p>}
      <button type="button" className={controls} disabled={disabled || !safeUrl} onClick={() => void openUrl()}>打开验证链接</button>
    </>}
    {supported && !isUrl && <pre aria-label="请求 schema" className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{json(schema)}</pre>}
    {supported && !isUrl && !primitive && <label className="block text-sm">响应内容 JSON<textarea rows={8} className={`${controls} block w-full font-mono`} value={rawContent} disabled={disabled} onChange={e => setRawContent(e.target.value)} /></label>}
    {supported && !isUrl && primitive && properties.map(([key, raw]) => {
      const field = object(raw);
      const enumeration = Array.isArray(field.enum) ? field.enum : undefined;
      return <label key={key} className="block text-sm">{key}
        {enumeration || field.type === 'boolean' ? <select aria-label={key} className={`${controls} block w-full`} disabled={disabled} value={values[key] ?? ''} onChange={e => setValues(current => ({ ...current, [key]: e.target.value }))}>
          <option value="">请选择</option>
          {enumeration ? enumeration.map((value, index) => <option key={index} value={index}>{json(value)}</option>) : <><option value="true">true</option><option value="false">false</option></>}
        </select> : <input className={`${controls} block w-full`} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} step={field.type === 'integer' ? '1' : 'any'} disabled={disabled} value={values[key] ?? ''} onChange={e => setValues(current => ({ ...current, [key]: e.target.value }))} />}
      </label>;
    })}
    <p className="text-xs text-text-muted">完整 schema 由主进程校验；校验失败会保留请求，允许修改后重试。</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={controls} disabled={disabled || !supported || (isUrl && !safeUrl)} onClick={accept}>接受并提交</button>
      <button type="button" className={controls} disabled={disabled} onClick={() => void respond({ action: 'decline' })}>拒绝提供</button>
      <button type="button" className={controls} disabled={disabled} onClick={() => void respond({ action: 'cancel' })}>取消请求</button>
    </div>
  </div>;
}
