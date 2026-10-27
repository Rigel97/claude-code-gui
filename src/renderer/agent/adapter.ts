// runner stream-json → 执行事件。
// 只认结构化字段：审批 / retry 需要显式结构，error 只来自明确 API 错误或 result.is_error。
// 同一 tool_use_id 对应稳定节点；结果先到的乱序场景以占位节点承载，输入回填时按时间补齐。

import type { Conversation, ResultMessage, RunStatus, UIBlock } from '../types';
import {
  MAX_ADAPTER_BUFFER,
  MAX_EVENT_LABEL,
  MAX_TOOL_INPUT_TEXT,
  type EventDelta,
  type ExecutionEvent,
  type ExecutionGraph,
  type ExecutionMetrics,
  type NodeStatus,
} from './types';
import { applyEvents, createGraph, getRootId } from './model';

type Rec = Record<string, unknown>;

function isObj(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function clip(s: string, max = MAX_EVENT_LABEL): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 工具参数快照：超过上限时保留预览，避免事件体积失控 */
export function summarizeInput(input: unknown): unknown {
  if (input === undefined) return undefined;
  if (!isObj(input)) return input;
  try {
    const text = JSON.stringify(input);
    if (text.length <= MAX_TOOL_INPUT_TEXT) return input;
    return { truncated: true, preview: `${text.slice(0, MAX_TOOL_INPUT_TEXT)}…`, size: text.length };
  } catch {
    return { truncated: true, preview: String(input) };
  }
}

/** tool_result / result 的文本内容 */
export function resultText(content: unknown, max = 600): string | undefined {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join('');
  }
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 明确的 API / 认证 / 配额 / 启动错误；普通 warning 日志不算 */
const API_ERROR_PATTERNS: RegExp[] = [
  /\bAPI Error\b/i,
  /\bapi[_ ]?error\b/i,
  /\b(401|403|429|500|502|503|529)\b[^\n]{0,40}\b(error|unauthori[sz]ed|forbidden|overloaded|rate limit)\b/i,
  /\b(authentication_error|invalid api key|permission denied|credit balance|rate limit(ed)?|overloaded_error|invalid_request_error)\b/i,
  /\bENOTFOUND\b|\bECONNREFUSED\b|\bETIMEDOUT\b/,
  /Failed to start claude/i,
  /工作目录不存在/,
];

export function isApiErrorText(text: string): boolean {
  return API_ERROR_PATTERNS.some((re) => re.test(text));
}

function filePathOf(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  return str(input.file_path) ?? str(input.notebook_path);
}

function commandOf(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  const cmd = str(input.command);
  return cmd ? clip(cmd.replace(/\s+/g, ' '), 80) : undefined;
}

function agentLabelOf(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  return str(input.description) ?? str(input.subagent_type);
}

const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** TaskCreate / TaskUpdate 结果里的任务号（仅在文本能明确解析时使用） */
export function parseTaskNumberFromResult(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/(?:Created|created|Updated|updated|task|Task)\s*(?:task\s*)?#?(\d{1,6})\b/);
  return m ? m[1] : null;
}

/** 工具节点 id：只取决于 conversationId + tool_use_id */
export function toolNodeIdFor(conversationId: string, toolUseId: string): string {
  return `tool:${conversationId}:${toolUseId}`;
}

function toolStatusFromBlock(block: Extract<UIBlock, { kind: 'tool_use' }>): NodeStatus {
  if (block.status === 'done') return 'completed';
  if (block.status === 'error') return 'error';
  if (block.status === 'running') return 'running';
  return 'unknown';
}

interface ToolRecord {
  nodeId: string;
  toolName: string;
  parentId?: string;
  status: NodeStatus;
  hasInput: boolean;
  hasResult: boolean;
  resultIsError: boolean;
  input?: unknown;
  resultText?: string;
  startedAt: number;
  endedAt?: number;
  /** 空占位节点是否已产出事件（避免重复事件） */
  placeholderEmitted: boolean;
  /** 子代理最终文本摘要（仅来自真实 assistant 文本） */
  title?: string;
}

/**
 * 工具记录 → 变更列表：按时间排序后交给 reducer。
 * 结果先到时用占位节点承载，输入回填后按时间顺序补齐名称与终态，
 * 从而保证文件节点也落到正确状态。
 */
interface ToolChange {
  at: number;
  phase: 'create' | 'update';
  event: ExecutionEvent;
}

type Phase = 'start' | 'input' | 'result';

export class ClaudeEventAdapter {
  private tools = new Map<string, Map<string, ToolRecord>>();
  private emitted = new Set<string>();
  private blocks = new Map<string, Set<number>>();
  private aborted = new Map<string, boolean>();
  private sessionIds = new Map<string, string>();
  private models = new Map<string, string>();
  private lastResultFingerprint = new Map<string, string>();
  private counters = new Map<string, number>();
  private lastTimestamp = new Map<string, number>();

  /** 清空某会话的索引；事件计数器保留，避免新事件 id 与旧图去重集合冲突 */
  reset(conversationId?: string): void {
    if (conversationId) {
      this.tools.delete(conversationId);
      this.blocks.delete(conversationId);
      this.aborted.delete(conversationId);
      this.sessionIds.delete(conversationId);
      this.models.delete(conversationId);
      this.lastResultFingerprint.delete(conversationId);
      return;
    }
    this.tools.clear();
    this.blocks.clear();
    this.aborted.clear();
    this.sessionIds.clear();
    this.models.clear();
    this.lastResultFingerprint.clear();
    this.counters.clear();
    this.lastTimestamp.clear();
    this.emitted.clear();
  }

  /** 会话关闭：连同计数器 / 时间戳 / 事件去重缓存一并清理，避免长期运行内存无界增长 */
  forget(conversationId: string): void {
    if (!conversationId) return;
    this.reset(conversationId);
    this.counters.delete(conversationId);
    this.lastTimestamp.delete(conversationId);
    const prefix = `ev:${conversationId}:`;
    for (const id of this.emitted) {
      if (id.startsWith(prefix)) this.emitted.delete(id);
    }
  }

  /** 补充会话元信息（starting 时由 store 用已同步的 Conversation 调用） */
  enrich(
    conversationId: string,
    meta: { sessionId?: string | null; title?: string; projectPath?: string },
    receivedAt = Date.now()
  ): ExecutionEvent | null {
    if (!conversationId) return null;
    if (!meta.sessionId && !meta.title && !meta.projectPath) return null;
    if (meta.sessionId) this.sessionIds.set(conversationId, meta.sessionId);
    const ts = this.ts(conversationId, receivedAt);
    return this.event(conversationId, ts, 'session', '会话信息', {
      sessionId: meta.sessionId ?? undefined,
      delta: {
        graph: {
          ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
          ...(meta.title ? { title: meta.title } : {}),
          ...(meta.projectPath ? { projectPath: meta.projectPath } : {}),
        },
      },
    });
  }

  /** 主入口：一条 runner 消息 → 0..n 个执行事件 */
  ingest(raw: unknown, receivedAt = Date.now()): ExecutionEvent[] {
    if (!isObj(raw)) return [];
    const conversationId = str(raw.conversationId);
    if (!conversationId) return [];
    const type = str(raw.type);
    if (type === 'status') return this.status(raw, receivedAt);
    if (this.aborted.get(conversationId) === true) return [];

    switch (type) {
      case 'system':
        return this.onSystem(conversationId, raw, receivedAt);
      case 'stream_event':
        return this.onStreamEvent(conversationId, raw, receivedAt);
      case 'assistant':
        return this.onAssistant(conversationId, raw, receivedAt);
      case 'user':
        return this.onUser(conversationId, raw, receivedAt);
      case 'result':
        return this.onResult(conversationId, raw, receivedAt);
      case 'stderr':
      case 'raw':
        return this.onLog(conversationId, raw, receivedAt, type);
      default:
        return [];
    }
  }

  /** runner 的 claude:status 通道 */
  status(payload: unknown, receivedAt = Date.now()): ExecutionEvent[] {
    if (!isObj(payload)) return [];
    const conversationId = str(payload.conversationId);
    if (!conversationId) return [];
    const status = str(payload.status) as RunStatus | undefined;
    if (!status) return [];
    const ts = this.ts(conversationId, receivedAt);

    switch (status) {
      case 'starting':
        this.aborted.set(conversationId, false);
        this.tools.set(conversationId, new Map());
        this.blocks.set(conversationId, new Set());
        this.lastResultFingerprint.delete(conversationId);
        return [
          this.event(conversationId, ts, 'status', '新一轮执行开始', {
            status: 'running',
            delta: { graph: { status: 'running' } },
          }),
        ];
      case 'streaming':
        this.aborted.set(conversationId, false);
        return [this.event(conversationId, ts, 'status', '执行中', { status: 'running' })];
      case 'aborted': {
        this.aborted.set(conversationId, true);
        const out: ExecutionEvent[] = [];
        for (const rec of this.tools.get(conversationId)?.values() ?? []) {
          if (rec.status === 'completed' || rec.status === 'error' || rec.status === 'cancelled') continue;
          rec.status = 'cancelled';
          rec.endedAt = ts;
          out.push(
            this.event(conversationId, ts, 'tool', `${rec.toolName} 已取消`, {
              nodeId: rec.nodeId,
              status: 'cancelled',
              delta: { node: { id: rec.nodeId, status: 'cancelled', endedAt: ts } },
            })
          );
        }
        out.push(
          this.event(conversationId, ts, 'status', '执行已中断', {
            status: 'cancelled',
            delta: { graph: { status: 'cancelled', endedAt: ts } },
          })
        );
        return out;
      }
      case 'completed':
        this.aborted.set(conversationId, false);
        return [
          this.event(conversationId, ts, 'status', '执行完成', {
            status: 'completed',
            delta: { graph: { status: 'completed', endedAt: ts } },
          }),
        ];
      case 'error':
        this.aborted.set(conversationId, false);
        return [
          this.event(conversationId, ts, 'status', '执行失败', {
            status: 'error',
            delta: { graph: { status: 'error', endedAt: ts } },
          }),
        ];
      default:
        return [];
    }
  }

  // ── system ────────────────────────────────────────────────

  private onSystem(conversationId: string, raw: Rec, receivedAt: number): ExecutionEvent[] {
    const subtype = str(raw.subtype);
    const ts = this.ts(conversationId, receivedAt);

    if (subtype === 'init') {
      this.aborted.set(conversationId, false);
      const sessionId = str(raw.session_id);
      if (sessionId) this.sessionIds.set(conversationId, sessionId);
      const model = str(raw.model);
      if (model) this.models.set(conversationId, model);
      const cwd = str(raw.cwd);
      return [
        this.event(conversationId, ts, 'session', '会话初始化', {
          sessionId,
          status: 'running',
          delta: {
            node: { id: getRootId(conversationId), type: 'core', status: 'running', startedAt: ts, ...(cwd ? { subtitle: cwd } : {}) },
            ...(model ? { metrics: { model } } : {}),
            graph: { status: 'running', ...(sessionId ? { sessionId } : {}), ...(cwd ? { projectPath: cwd } : {}) },
          },
        }),
      ];
    }

    if (subtype === 'status') {
      return str(raw.status) === 'requesting'
        ? [this.event(conversationId, ts, 'status', '请求模型', { status: 'running' })]
        : [];
    }
    // thinking_tokens 等估计值不进入执行图
    return [];
  }

  // ── stream_event：只收结构 ────────────────────────────────

  private onStreamEvent(conversationId: string, raw: Rec, receivedAt: number): ExecutionEvent[] {
    const ev = isObj(raw.event) ? raw.event : null;
    if (!ev) return [];
    const ts = this.ts(conversationId, receivedAt);
    const parentUseId = typeof raw.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : undefined;

    if (ev.type === 'message_start') {
      this.blocks.set(conversationId, new Set());
      if (isObj(ev.retry)) {
        return [
          this.event(conversationId, ts, 'status', '模型重试', {
            status: 'retrying',
            delta: { graph: { status: 'running' } },
          }),
        ];
      }
      return [];
    }

    if (ev.type === 'content_block_start') {
      const block = isObj(ev.content_block) ? ev.content_block : null;
      const index = num(ev.index);
      if (!block || index === undefined) return [];
      let set = this.blocks.get(conversationId);
      if (!set) {
        set = new Set();
        this.blocks.set(conversationId, set);
      }
      if (set.size >= 256) set.clear();
      set.add(index);
      if (block.type !== 'tool_use') return [];

      const toolUseId = str(block.id);
      if (!toolUseId) return [];
      const toolName = str(block.name) ?? 'Tool';
      const parentNode = parentUseId && parentUseId !== toolUseId ? toolNodeIdFor(conversationId, parentUseId) : getRootId(conversationId);
      const rec = this.ensureTool(conversationId, toolUseId, toolName, parentNode, ts);
      if (rec.hasInput || rec.hasResult) return [];
      rec.status = 'running';
      return [this.toolEvent(conversationId, ts, rec, 'start')];
    }

    // content_block_delta / stop：逐 token 增量不进入执行图
    return [];
  }

  // ── assistant ────────────────────────────────────────────

  private onAssistant(conversationId: string, raw: Rec, receivedAt: number): ExecutionEvent[] {
    const ts = this.ts(conversationId, receivedAt);
    const parentUseId = typeof raw.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : undefined;
    const msg = isObj(raw.message) ? raw.message : null;
    const content = msg && Array.isArray(msg.content) ? (msg.content as unknown[]) : [];
    const out: ExecutionEvent[] = [];

    // 子代理文本作为父 agent 的标题摘要
    if (parentUseId) {
      const parentRec = this.tools.get(conversationId)?.get(parentUseId);
      const text = content
        .filter((b): b is { type: string; text: string } => isObj(b) && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ');
      if (parentRec && text.trim()) parentRec.title = clip(text.replace(/\s+/g, ' ').trim(), 80);
    }

    const changes: ToolChange[] = [];
    for (const block of content) {
      if (!isObj(block) || block.type !== 'tool_use') continue;
      const toolUseId = str(block.id);
      if (!toolUseId) continue;
      const toolName = str(block.name) ?? 'Tool';
      const parentNode = parentUseId && parentUseId !== toolUseId ? toolNodeIdFor(conversationId, parentUseId) : getRootId(conversationId);
      const rec = this.ensureTool(conversationId, toolUseId, toolName, parentNode, ts);
      const firstInput = !rec.hasInput;
      rec.hasInput = true;
      rec.input = summarizeInput(block.input);
      rec.toolName = toolName;
      rec.startedAt = Math.min(rec.startedAt, ts);
      if (!rec.hasResult) rec.status = 'running';

      // 结果先到：占位之后再补一次「回填」，最终态仍以结果为准
      changes.push({
        at: ts,
        phase: rec.hasResult ? 'update' : firstInput ? 'create' : 'update',
        event: this.toolEvent(conversationId, ts, rec, rec.hasResult ? 'input' : firstInput ? 'start' : 'input'),
      });
    }
    out.push(...this.emitOrdered(changes));

    // 仅显式结构化 approval 才生成审批节点
    const approval = isObj(raw.approval) ? raw.approval : null;
    const requestId = approval ? str(approval.requestId) ?? str(approval.request_id) ?? str(approval.id) : undefined;
    if (approval && requestId) {
      const id = `approval:${conversationId}:${requestId}`;
      const toolName = str(approval.toolName);
      out.push(
        this.event(conversationId, ts, 'status', '等待审批', {
          nodeId: id,
          status: 'blocked',
          delta: {
            node: {
              id,
              type: 'task',
              label: toolName ? `等待审批：${toolName}` : '等待审批',
              subtitle: 'approval',
              status: 'blocked',
              parentId: getRootId(conversationId),
              startedAt: ts,
              metadata: { approval: true },
            },
          },
        })
      );
    }
    return out;
  }

  // ── user：tool_result ────────────────────────────────────

  private onUser(conversationId: string, raw: Rec, receivedAt: number): ExecutionEvent[] {
    const ts = this.ts(conversationId, receivedAt);
    const msg = isObj(raw.message) ? raw.message : null;
    const content = msg && Array.isArray(msg.content) ? (msg.content as unknown[]) : [];
    const out: ExecutionEvent[] = [];

    for (const block of content) {
      if (!isObj(block) || block.type !== 'tool_result') continue;
      const toolUseId = str(block.tool_use_id);
      if (!toolUseId) continue;
      const rec = this.ensureTool(conversationId, toolUseId, 'Tool', undefined, ts);
      rec.hasResult = true;
      rec.resultIsError = block.is_error === true;
      rec.resultText = resultText(block.content);
      rec.endedAt = ts;
      rec.status = rec.resultIsError ? 'error' : 'completed';
      // 输入尚未到达：先产出占位节点（unknown → 结果），输入回填时再补齐
      const placeholder = !rec.hasInput && !rec.placeholderEmitted;
      rec.placeholderEmitted = true;
      out.push(this.toolEvent(conversationId, ts, rec, 'result', placeholder));

      if (rec.hasInput && isObj(rec.input)) this.emitTodoTasks(conversationId, ts, rec, out);
    }
    return out;
  }

  private emitTodoTasks(conversationId: string, ts: number, rec: ToolRecord, out: ExecutionEvent[]): void {
    const input = rec.input;
    if (!isObj(input)) return;
    if (rec.toolName === 'TodoWrite' && Array.isArray(input.todos)) {
      input.todos.forEach((item, index) => {
        if (!isObj(item)) return;
        const content = str(item.content);
        if (!content) return;
        const raw = str(item.status);
        const status: NodeStatus =
          raw === 'completed' ? 'completed' : raw === 'in_progress' ? 'running' : raw === 'pending' ? 'pending' : 'unknown';
        const id = `task:${conversationId}:${index}`;
        out.push(
          this.event(conversationId, ts, 'task', `任务：${content}`, {
            nodeId: id,
            status,
            delta: {
              node: {
                id,
                type: 'task',
                label: content,
                ...(str(item.activeForm) ? { subtitle: str(item.activeForm) } : {}),
                status,
                parentId: getRootId(conversationId),
                metadata: { todoIndex: index },
                ...(status === 'running' ? { startedAt: ts } : {}),
                ...(status === 'completed' ? { startedAt: ts, endedAt: ts } : {}),
              },
              edge: { source: rec.nodeId, target: id, kind: 'dependency' },
            },
          })
        );
      });
      return;
    }
    if ((rec.toolName === 'TaskCreate' || rec.toolName === 'TaskUpdate') && rec.resultText) {
      const taskNo = parseTaskNumberFromResult(rec.resultText);
      if (!taskNo) return;
      const id = `task:${conversationId}:cli-${taskNo}`;
      const subject = isObj(input) ? str(input.subject) ?? str(input.description) : undefined;
      out.push(
        this.event(conversationId, ts, 'task', `任务 #${taskNo}`, {
          nodeId: id,
          status: rec.status,
          delta: {
            node: {
              id,
              type: 'task',
              label: subject ?? `任务 #${taskNo}`,
              subtitle: rec.toolName,
              status: rec.status,
              parentId: getRootId(conversationId),
              startedAt: ts,
              ...(rec.status === 'completed' ? { endedAt: ts } : {}),
              metadata: { cliTaskId: taskNo },
            },
          },
        })
      );
    }
  }

  // ── result ───────────────────────────────────────────────

  private onResult(conversationId: string, raw: Rec, receivedAt: number): ExecutionEvent[] {
    const ts = this.ts(conversationId, receivedAt);
    const out: ExecutionEvent[] = [];
    const sessionId = str(raw.session_id);
    if (sessionId) this.sessionIds.set(conversationId, sessionId);
    const isError = raw.is_error === true || raw.subtype === 'error';

    // 本轮结束：仍无结果的工具不推断成功；整体失败时标 error
    for (const rec of this.tools.get(conversationId)?.values() ?? []) {
      if (rec.hasResult || !isError) continue;
      if (rec.status === 'running' || rec.status === 'retrying' || rec.status === 'pending' || rec.status === 'unknown') {
        rec.status = 'error';
        rec.endedAt = ts;
        out.push(
          this.event(conversationId, ts, 'tool', `${rec.toolName} 执行失败`, {
            nodeId: rec.nodeId,
            status: 'error',
            delta: { node: { id: rec.nodeId, status: 'error', endedAt: ts } },
          })
        );
      }
    }

    // 指标只来自本 run 的 result，同一条 result 不重复累计
    const fingerprint = [raw.session_id, raw.duration_ms, raw.num_turns, raw.total_cost_usd, JSON.stringify(raw.usage ?? null), isError].join('|');
    if (this.lastResultFingerprint.get(conversationId) !== fingerprint) {
      this.lastResultFingerprint.set(conversationId, fingerprint);
      const usage = isObj(raw.usage) ? raw.usage : null;
      const cacheRead = usage ? num(usage.cache_read_input_tokens) : undefined;
      const cacheCreate = usage ? num(usage.cache_creation_input_tokens) : undefined;
      const metrics: Partial<ExecutionMetrics> = {
        inputTokens: usage ? num(usage.input_tokens) ?? null : null,
        outputTokens: usage ? num(usage.output_tokens) ?? null : null,
        cacheTokens: cacheRead === undefined && cacheCreate === undefined ? null : (cacheRead ?? 0) + (cacheCreate ?? 0),
        costUsd: num(raw.total_cost_usd) ?? null,
        durationMs: num(raw.duration_ms) ?? null,
        turns: num(raw.num_turns) ?? null,
      };
      const modelUsage = isObj(raw.modelUsage) ? Object.keys(raw.modelUsage)[0] : undefined;
      if (modelUsage) metrics.model = modelUsage;
      else if (this.sessionIds.get(conversationId)) {
        const known = this.models.get(conversationId);
        if (known) metrics.model = known;
      }
      const detail = [
        metrics.inputTokens !== null ? `in ${metrics.inputTokens}` : null,
        metrics.outputTokens !== null ? `out ${metrics.outputTokens}` : null,
        metrics.costUsd !== null && metrics.costUsd !== undefined ? `$${metrics.costUsd.toFixed(4)}` : null,
        metrics.turns !== null && metrics.turns !== undefined ? `${metrics.turns} turns` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      out.push(this.event(conversationId, ts, 'metrics', `本轮用量${detail ? `：${detail}` : ''}`, { delta: { metrics } }));
    }

    if (isError) {
      const text = resultText(raw.result, 400) ?? '执行失败';
      out.push(
        this.event(conversationId, ts, 'error', `执行失败：${text}`, {
          status: 'error',
          delta: {
            node: {
              id: `error:${conversationId}:${this.bump(conversationId)}`,
              type: 'error',
              label: '执行失败',
              subtitle: text.slice(0, 80),
              status: 'error',
              parentId: getRootId(conversationId),
              startedAt: ts,
              endedAt: ts,
              error: text,
            },
            graph: { status: 'error', endedAt: ts },
          },
        })
      );
    } else {
      out.push(
        this.event(conversationId, ts, 'status', '本轮完成', {
          status: 'completed',
          delta: { graph: { status: 'completed', endedAt: ts } },
        })
      );
    }
    return out;
  }

  // ── stderr / raw ─────────────────────────────────────────

  private onLog(conversationId: string, raw: Rec, receivedAt: number, type: 'stderr' | 'raw'): ExecutionEvent[] {
    const text = str(raw.text);
    if (!text) return [];
    const ts = this.ts(conversationId, receivedAt);
    const firstLine = text.split('\n')[0].trim();
    if (isApiErrorText(text)) {
      return [
        this.event(conversationId, ts, 'error', firstLine, {
          status: 'error',
          delta: {
            node: {
              id: `error:${conversationId}:${this.bump(conversationId)}`,
              type: 'error',
              label: 'CLI 错误输出',
              subtitle: firstLine.slice(0, 80),
              status: 'error',
              parentId: getRootId(conversationId),
              startedAt: ts,
              endedAt: ts,
              error: clip(text, 600),
            },
          },
        }),
      ];
    }
    return [this.event(conversationId, ts, 'status', `[${type}] ${firstLine}`)];
  }

  // ── 工具记录与事件 ───────────────────────────────────────

  private ensureTool(
    conversationId: string,
    toolUseId: string,
    toolName: string,
    parentId: string | undefined,
    ts: number
  ): ToolRecord {
    let map = this.tools.get(conversationId);
    if (!map) {
      map = new Map();
      this.tools.set(conversationId, map);
    }
    const existing = map.get(toolUseId);
    if (existing) {
      if (parentId && !existing.parentId) existing.parentId = parentId;
      return existing;
    }
    if (map.size >= MAX_ADAPTER_BUFFER) {
      for (const [id, rec] of map) {
        if (rec.hasResult) {
          map.delete(id);
          break;
        }
      }
      if (map.size >= MAX_ADAPTER_BUFFER) {
        const first = map.keys().next();
        if (!first.done) map.delete(first.value);
      }
    }
    const rec: ToolRecord = {
      nodeId: toolNodeIdFor(conversationId, toolUseId),
      toolName,
      parentId,
      status: 'unknown',
      hasInput: false,
      hasResult: false,
      resultIsError: false,
      startedAt: ts,
      placeholderEmitted: false,
    };
    map.set(toolUseId, rec);
    return rec;
  }

  /** 按发生时间升序输出工具变更（同毫秒按调用顺序） */
  private emitOrdered(changes: ToolChange[]): ExecutionEvent[] {
    return [...changes].sort((a, b) => a.at - b.at).map((c) => c.event);
  }

  private toolEvent(
    conversationId: string,
    ts: number,
    rec: ToolRecord,
    phase: Phase,
    placeholder = false
  ): ExecutionEvent {
    const toolName = rec.toolName;
    const isAgent = AGENT_TOOLS.has(toolName);
    const fp = filePathOf(rec.input);
    let nodeEdge: EventDelta['edge'] | undefined;
    if (rec.parentId && rec.parentId !== rec.nodeId) {
      // 父节点本身就是 agent（子代理容器）时，这条边就是委派关系
      const parentIsAgent = [...(this.tools.get(conversationId)?.values() ?? [])].some(
        (r) => r.nodeId === rec.parentId && AGENT_TOOLS.has(r.toolName),
      );
      nodeEdge = { source: rec.parentId, target: rec.nodeId, kind: parentIsAgent || isAgent ? 'delegation' : 'call' };
    }

    const node: NonNullable<EventDelta['node']> = {
      id: rec.nodeId,
      type: isAgent ? 'agent' : 'tool',
      label: placeholder ? 'Tool' : isAgent ? agentLabelOf(rec.input) ?? toolName : toolName,
      toolName: placeholder ? 'Tool' : toolName,
      status: phase === 'result' ? rec.status : 'running',
      startedAt: rec.startedAt,
      ...(placeholder ? { metadata: { placeholder: true } } : {}),
    };
    if (rec.parentId) node.parentId = rec.parentId;
    if (isAgent && !placeholder) node.subtitle = `${toolName} subagent`;
    else if (fp) {
      node.filePath = fp;
      node.relatedFiles = [fp];
      node.subtitle = fp;
    } else if (toolName === 'Bash') node.subtitle = commandOf(rec.input);
    if (rec.hasInput) node.input = rec.input;

    if (phase === 'result') {
      node.endedAt = rec.endedAt ?? ts;
      if (rec.resultText !== undefined) node.output = rec.resultText;
      if (rec.resultIsError) node.error = rec.resultText ?? '工具执行失败';
    }

    const text = placeholder
      ? `${toolName} 结果到达`
      : phase === 'start'
        ? `${toolName} 开始`
        : phase === 'input'
          ? `${toolName} 参数就绪`
          : `${toolName} ${rec.resultIsError ? '失败' : '完成'}`;
    const kind: ExecutionEvent['kind'] = phase === 'result' && rec.resultIsError ? 'error' : isAgent ? 'agent' : 'tool';
    return this.event(conversationId, ts, kind, text, {
      nodeId: rec.nodeId,
      status: node.status as NodeStatus,
      delta: { node, ...(nodeEdge && !placeholder ? { edge: nodeEdge } : {}) },
    });
  }

  // ── 基础设施 ─────────────────────────────────────────────

  private ts(conversationId: string, receivedAt: number): number {
    const prev = this.lastTimestamp.get(conversationId) ?? 0;
    const v = Math.max(num(receivedAt) ?? 0, prev);
    this.lastTimestamp.set(conversationId, v);
    return v;
  }

  private bump(conversationId: string): number {
    const n = (this.counters.get(conversationId) ?? 0) + 1;
    this.counters.set(conversationId, n);
    return n;
  }

  private event(
    conversationId: string,
    timestamp: number,
    kind: ExecutionEvent['kind'],
    text: string,
    opts: { nodeId?: string; status?: NodeStatus; sessionId?: string; delta?: EventDelta } = {}
  ): ExecutionEvent {
    const seq = this.bump(conversationId);
    const id = `ev:${conversationId}:${seq}`;
    this.emitted.add(id);
    if (this.emitted.size > MAX_ADAPTER_BUFFER * 4) {
      const iter = this.emitted.values();
      for (let i = 0; i < MAX_ADAPTER_BUFFER; i++) {
        const next = iter.next();
        if (next.done) break;
        this.emitted.delete(next.value);
      }
    }
    const sessionId = opts.sessionId ?? this.sessionIds.get(conversationId);
    const delta = opts.delta
      ? { ...opts.delta, ...(opts.delta.node ? { node: { ...opts.delta.node, status: opts.delta.node.status ?? opts.status } } : {}) }
      : undefined;
    return {
      id,
      conversationId,
      timestamp,
      source: 'live',
      kind,
      label: clip(text),
      ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(delta ? { delta } : {}),
    };
  }
}

// ─── 历史回填 ───────────────────────────────────────────────

type ResultLike = Pick<ResultMessage, 'usage' | 'num_turns' | 'total_cost_usd' | 'duration_ms'> & {
  modelUsage?: Record<string, unknown>;
};

/**
 * 从已有 Conversation 回填历史工具树。
 * - 父子只用 children 结构，thinking 文本不建模；
 * - 缺 result 的工具保持 running，不推断成功；
 * - TodoWrite 使用真实 input.todos；TaskCreate/TaskUpdate 仅在能解析任务号时补；
 * - 文件节点由 reducer 依据 file_path 派生，状态跟随工具。
 */
export function graphFromConversation(conv: Conversation): ExecutionGraph {
  const source = 'history' as const;
  const title = conv.title || '会话';
  const projectPath = conv.cwd || '';
  const rootNodeId = getRootId(conv.id);
  const events: ExecutionEvent[] = [];
  let counter = 0;
  let seq = 0;
  const nextSeq = () => ++seq;

  const messages = [...(conv.messages ?? [])];
  if (conv.streamingMessage) messages.push(conv.streamingMessage);
  const baseTs = messages.length ? messages[0].timestamp || 0 : 0;
  const rootStatus: NodeStatus =
    conv.status === 'aborted' ? 'cancelled' : conv.status === 'error' ? 'error' : conv.status === 'completed' ? 'completed' : 'running';

  events.push({
    id: `h:${conv.id}:root`,
    conversationId: conv.id,
    timestamp: baseTs,
    source,
    kind: 'session',
    label: '历史会话',
    nodeId: rootNodeId,
    status: rootStatus,
    ...(conv.sessionId ? { sessionId: conv.sessionId } : {}),
    delta: {
      node: { id: rootNodeId, type: 'core', status: rootStatus, startedAt: baseTs, ...(projectPath ? { subtitle: projectPath } : {}) },
      graph: { title, projectPath, ...(rootStatus === 'running' ? {} : { status: rootStatus }) },
    },
  });

  const pushBlock = (block: UIBlock, parentId: string, msgTs: number) => {
    if (block.kind !== 'tool_use') return;
    const toolUseId = block.toolId || `anonymous-${++counter}`;
    const nodeId = toolNodeIdFor(conv.id, toolUseId);
    const status = toolStatusFromBlock(block);
    const fp = filePathOf(block.input);
    const isAgent = AGENT_TOOLS.has(block.toolName);
    const startedAt = block.startedAt ?? block.finishedAt ?? msgTs;
    const node: NonNullable<EventDelta['node']> = {
      id: nodeId,
      type: isAgent ? 'agent' : 'tool',
      label: isAgent ? agentLabelOf(block.input) ?? block.toolName : block.toolName,
      toolName: block.toolName,
      status,
      sequence: nextSeq(),
      parentId,
      startedAt,
      ...(block.finishedAt !== undefined ? { endedAt: block.finishedAt } : {}),
      ...(Object.keys(block.input ?? {}).length ? { input: summarizeInput(block.input) } : {}),
      ...(block.result !== undefined ? { output: block.result } : {}),
      ...(status === 'error' ? { error: block.result ?? '工具执行失败' } : {}),
      ...(fp ? { filePath: fp, relatedFiles: [fp] } : {}),
      ...(isAgent
        ? { subtitle: `${block.toolName} subagent` }
        : fp
          ? { subtitle: fp }
          : block.toolName === 'Bash'
            ? { subtitle: commandOf(block.input) }
            : {}),
    };
    events.push({
      id: `h:${conv.id}:${++counter}`,
      conversationId: conv.id,
      timestamp: startedAt,
      source,
      kind: isAgent ? 'agent' : 'tool',
      label: `${block.toolName}（历史）`,
      nodeId,
      status,
      delta: { node, edge: { source: parentId, target: nodeId, kind: isAgent || block.children ? 'delegation' : 'call' } },
    });

    if (block.toolName === 'TodoWrite' && isObj(block.input) && Array.isArray(block.input.todos)) {
      (block.input.todos as unknown[]).forEach((item, index) => {
        if (!isObj(item) || typeof item.content !== 'string') return;
        const raw = str(item.status);
        const s: NodeStatus = raw === 'completed' ? 'completed' : raw === 'in_progress' ? 'running' : raw === 'pending' ? 'pending' : 'unknown';
        const id = `task:${conv.id}:${index}`;
        events.push({
          id: `h:${conv.id}:${++counter}`,
          conversationId: conv.id,
          timestamp: block.finishedAt ?? startedAt,
          source,
          kind: 'task',
          label: `任务：${item.content}`,
          nodeId: id,
          status: s,
          delta: {
            node: {
              id,
              type: 'task',
              label: item.content,
              ...(str(item.activeForm) ? { subtitle: str(item.activeForm) } : {}),
              status: s,
              parentId: rootNodeId,
              sequence: nextSeq(),
              metadata: { todoIndex: index },
            },
          },
        });
      });
    }

    if ((block.toolName === 'TaskCreate' || block.toolName === 'TaskUpdate') && block.result) {
      const taskNo = parseTaskNumberFromResult(block.result);
      if (taskNo) {
        const subject = isObj(block.input) ? str(block.input.subject) ?? str(block.input.description) : undefined;
        events.push({
          id: `h:${conv.id}:${++counter}`,
          conversationId: conv.id,
          timestamp: block.finishedAt ?? startedAt,
          source,
          kind: 'task',
          label: `任务 #${taskNo}`,
          nodeId: `task:${conv.id}:cli-${taskNo}`,
          status,
          delta: {
            node: {
              id: `task:${conv.id}:cli-${taskNo}`,
              type: 'task',
              label: subject ?? `任务 #${taskNo}`,
              subtitle: block.toolName,
              status,
              parentId: rootNodeId,
              sequence: nextSeq(),
              metadata: { cliTaskId: taskNo },
            },
          },
        });
      }
    }

    for (const child of block.children ?? []) pushBlock(child, nodeId, msgTs);
  };

  messages.forEach((msg) => {
    for (const block of Array.isArray(msg.blocks) ? msg.blocks : []) pushBlock(block, rootNodeId, msg.timestamp || baseTs);
  });

  const lastTs = messages.length ? messages[messages.length - 1].timestamp || baseTs : baseTs;
  events.push({
    id: `h:${conv.id}:status`,
    conversationId: conv.id,
    timestamp: lastTs,
    source,
    kind: 'status',
    label: '历史状态',
    status: rootStatus,
    delta: {
      graph: {
        status: rootStatus,
        ...(rootStatus === 'completed' || rootStatus === 'error' || rootStatus === 'cancelled' ? { endedAt: lastTs } : {}),
      },
    },
  });

  // 指标取最后一条 stats，不累加
  const stats = [...messages]
    .reverse()
    .flatMap((m) => (Array.isArray(m.blocks) ? m.blocks : []))
    .find((b): b is Extract<UIBlock, { kind: 'stats' }> => b.kind === 'stats');
  if (stats) {
    const r = stats.data as unknown as ResultLike;
    const usage = isObj(r.usage) ? r.usage : null;
    const cacheRead = usage ? num(usage.cache_read_input_tokens) : undefined;
    const cacheCreate = usage ? num(usage.cache_creation_input_tokens) : undefined;
    const model = isObj(r.modelUsage) ? Object.keys(r.modelUsage)[0] : conv.currentModel || undefined;
    events.push({
      id: `h:${conv.id}:metrics`,
      conversationId: conv.id,
      timestamp: lastTs,
      source,
      kind: 'metrics',
      label: '历史累计用量',
      delta: {
        metrics: {
          inputTokens: usage ? num(usage.input_tokens) ?? null : null,
          outputTokens: usage ? num(usage.output_tokens) ?? null : null,
          cacheTokens: cacheRead === undefined && cacheCreate === undefined ? null : (cacheRead ?? 0) + (cacheCreate ?? 0),
          costUsd: num(r.total_cost_usd) ?? null,
          durationMs: num(r.duration_ms) ?? null,
          turns: num(r.num_turns) ?? null,
          ...(model ? { model } : {}),
        },
      },
    });
  } else if (conv.currentModel) {
    events.push({
      id: `h:${conv.id}:model`,
      conversationId: conv.id,
      timestamp: lastTs,
      source,
      kind: 'metrics',
      label: '模型',
      delta: { metrics: { model: conv.currentModel } },
    });
  }

  let graph = createGraph(conv.id, source, title, projectPath);
  graph = applyEvents(graph, events);
  return { ...graph, sessionId: conv.sessionId ?? null };
}
