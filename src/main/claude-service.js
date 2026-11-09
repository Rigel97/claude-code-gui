const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { ClaudeRunner, queryContext, compactSession } = require('./runner');
const { buildNativeArgs } = require('./native-terminal');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk']);
class ServiceError extends Error {}
function fail(message) { throw new ServiceError(message); }
const UNSAFE_ERROR = /sk-[a-z0-9_-]{8,}|bearer\s+\S+|api[_-]?key\s*[:=]|authorization\s*[:=]|anthropic_[a-z_]+\s*=/i;
/** Preserve actionable operational errors without echoing secrets or raw provider payloads. */
function publicError(error) {
  if (error instanceof ServiceError) return error.message;
  const message = error instanceof Error ? error.message : '';
  if (!message || message.length > 500 || /[\0]/.test(message) || UNSAFE_ERROR.test(message)) {
    return 'Main process operation failed; no success confirmed';
  }
  return message;
}
function cidOf(input) {
  const id = typeof input === 'string' ? input : input?.conversationId ?? input?.cid;
  if (typeof id !== 'string' || !id.trim() || id.length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(id)) fail('Invalid conversationId (1..128 characters, no controls)');
  return id;
}
function sender(id) { if (!Number.isSafeInteger(id) || id <= 0) fail('Invalid owner sender'); }
function pick(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid payload');
  return Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, structuredClone(input[key])]));
}
function sessionPayload(input) {
  const out = pick(input, ['cwd', 'sessionId']);
  out.sessionId ??= input.sid;
  if (typeof out.cwd !== 'string' || !path.isAbsolute(out.cwd) || /[\0]/.test(out.cwd)) fail('Invalid cwd');
  if (typeof out.sessionId !== 'string' || !UUID.test(out.sessionId)) fail('Invalid sessionId');
  out.sessionId = out.sessionId.toLowerCase();
  return out;
}

class ClaudeService {
  constructor({ runtime, history, terminalManager, ownership, createRunner = (cid, deps) => new ClaudeRunner(cid, deps), sendEvent = () => {}, forceKill = async () => false, queryContext: contextBoundary = queryContext, compactSession: compactBoundary = compactSession }) {
    this.runtime = runtime; this.history = history; this.terminalManager = terminalManager; this.ownership = ownership;
    this.createRunner = createRunner; this.sendEvent = sendEvent;
    this.queryContext = contextBoundary; this.compactSession = compactBoundary;
    this.auxiliary = new Set();
    this.forceKill = forceKill;
    this.records = new Map(); this.lanes = new Map(); this.sidLanes = new Map();
    this.deadOwners = new Set(); this.tokens = new Map(); this.actions = new Set(); this.nativePending = new Map();
    this.disposed = false;
    this.reservations = new Map();
    this.ownerValidationAborts = new Map();
    this.ownerCleanups = new Map(); this.allCleanup = null;
    if (terminalManager.acquireSession) terminalManager.acquireSession = (id, owner) => this._acquire(id.toLowerCase(), owner);
  }
  _acquire(id, owner) {
    const reservation = this.reservations.get(id);
    if (reservation?.release && reservation.owner === owner.ownerWebContentsId && reservation.kind === owner.kind) {
      this.reservations.delete(id);
      reservation.release();
      return this.ownership.acquire(id, owner);
    }
    const release = this.ownership.acquire(id, owner);
    return () => {
      const pending = this.reservations.get(id);
      if (pending && pending.owner === owner.ownerWebContentsId && pending.cid === owner.conversationId) pending.release = release;
      else release();
    };
  }
  _reserve(id, record, owner, kind) {
    if (this.reservations.has(id)) fail('Session handoff already pending');
    const reservation = { cid: record?.cid, owner, kind };
    if (!this.ownership.owner(id)) reservation.release = this.ownership.acquire(id, { kind, ownerWebContentsId: owner });
    this.reservations.set(id, reservation);
    return () => {
      if (this.reservations.get(id) === reservation) {
        this.reservations.delete(id);
        reservation.release?.();
      }
    };
  }
  async _result(fn) {
    try { return await fn(); }
    catch (error) { return { success: false, error: publicError(error) }; }
  }
  async _cleanupDeadline(operation) {
    let timer;
    try {
      return await Promise.race([operation, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new ServiceError('Process cleanup timed out: actual exit not confirmed; ownership retained')), 8000);
      })]);
    } finally { clearTimeout(timer); }
  }
  _active(owner) { sender(owner); if (this.disposed || this.deadOwners.has(owner)) fail('Owner disposed'); }
  _record(input, owner, create = false) {
    this._active(owner);
    const cid = cidOf(input);
    let record = this.records.get(cid);
    if (record && record.owner !== owner) fail('Conversation owner mismatch');
    if (!record && create) {
      record = { cid, owner, engine: null, memo: {}, epoch: 0, closing: null, nonces: new Set(), validationAbort: new AbortController() };
      this.records.set(cid, record);
    }
    return record;
  }
  _queue(map, key, operation) {
    const prev = map.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(operation);
    const tail = next.catch(() => {});
    map.set(key, tail);
    tail.finally(() => { if (map.get(key) === tail) map.delete(key); });
    return next;
  }
  _lane(record, fn) {
    const epoch = record.epoch;
    return this._queue(this.lanes, record.cid, () => {
      this._active(record.owner);
      if (record.epoch !== epoch || record.closing) fail('Conversation closed while operation was queued');
      return fn();
    });
  }
  _sid(id, fn) { return this._queue(this.sidLanes, id, fn); }
  _emit(record, channel, data) {
    if (this.deadOwners.has(record.owner) || this.disposed) return;
    try { Promise.resolve(this.sendEvent(record.owner, channel, structuredClone(data))).catch(() => {}); } catch { /* destroyed owner */ }
  }
  _snapshot(record) {
    if (!record) return null;
    const state = record.engine?.getState() || { conversationId: record.cid, sessionId: record.memo.sessionId ?? null, runId: null, state: 'closed', busy: false, info: null, commands: [], pendingApprovals: [], pendingUserMessageIds: [] };
    if (state.sessionId) record.memo.sessionId = state.sessionId;
    if (MODES.has(state.info?.permissionMode)) record.memo.options = { ...record.memo.options, permissionMode: state.info.permissionMode };
    return structuredClone(state);
  }
  _publish(record) {
    const state = this._snapshot(record);
    const signature = JSON.stringify(state);
    if (signature !== record.stateSignature) {
      record.stateSignature = signature;
      record.publishedRunId = state.runId;
      this._emit(record, 'claude:runtime', state);
    }
    return state;
  }
  _engineEmitStream(record, data) {
    // Registered generations already published their metadata; token deltas are data only.
    if (data.type !== 'stream_event' || !record.publishedRunId || (data.runId && data.runId !== record.publishedRunId)) this._publish(record);
    this._emit(record, 'claude:stream', data);
  }
  _runtimeRoot(runtime) { return path.resolve(runtime.env?.CLAUDE_CONFIG_DIR || path.join(this.runtime.home || require('node:os').homedir(), '.claude')); }
  async _sessionRuntime(record, owner = record?.owner) {
    this._active(owner);
    let controller = this.ownerValidationAborts.get(owner);
    if (!controller) this.ownerValidationAborts.set(owner, controller = new AbortController());
    const signals = [controller.signal, record?.validationAbort.signal].filter(Boolean);
    let abort;
    const cancelled = new Promise((resolve, reject) => {
      abort = () => reject(new ServiceError('Conversation closed or owner disposed during runtime validation'));
      for (const signal of signals) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
    });
    try {
      const runtime = await Promise.race([this.runtime.resolve(), cancelled]);
      const root = this._runtimeRoot(runtime);
      if (record?.sessionRoot && record.sessionRoot !== root) fail('Session configuration root changed; restore its original root before this operation');
      if (record) record.sessionRoot ??= root;
      return runtime;
    } finally { for (const signal of signals) signal.removeEventListener('abort', abort); }
  }
  _engine(record) {
    if (!record.engine) {
      const liveCount = [...this.records.values()].filter(r => r.owner === record.owner && r.engine).length;
      if (liveCount >= 32) fail('Runner limit: 32 retained engines per owner; explicitly close a conversation');
      record.engine = this.createRunner(record.cid, {
        ownerWebContentsId: record.owner,
        getRuntime: async () => {
          const runtime = await this._sessionRuntime(record);
          this._active(record.owner);
          record.sessionRoot = this._runtimeRoot(runtime);
          return { ...runtime, versionFingerprint: this.runtime.get().versionFingerprint };
        },
        acquireSession: (id, owner) => this._acquire(id.toLowerCase(), owner),
        emitStream: data => this._engineEmitStream(record, data),
        emitStatus: data => { this._emit(record, 'claude:status', data); this._publish(record); },
      });
    }
    return record.engine;
  }
  _remember(record, input) {
    if (input.permissionModeExplicit !== undefined && typeof input.permissionModeExplicit !== 'boolean') fail('permissionModeExplicit must be boolean');
    const memo = { ...record.memo };
    let lastRequestedMode = record.lastRequestedMode;
    if (input.cwd !== undefined) {
      if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || input.cwd.includes('\0')) fail('Invalid cwd');
      memo.cwd = input.cwd;
    }
    const sid = input.sessionId ?? input.sid;
    if (sid !== undefined && sid !== null) {
      if (typeof sid !== 'string' || !UUID.test(sid)) fail('Invalid sessionId');
      memo.sessionId = sid.toLowerCase();
    }
    if (input.options !== undefined) {
      if (!input.options || typeof input.options !== 'object' || Array.isArray(input.options)) fail('Invalid options');
      const options = structuredClone(input.options);
      if (options.permissionMode === 'manual') options.permissionMode = 'default';
      // A repeated UI configuration is not a new mode intent after an SDK mode change.
      // Changed values are intent; permissionModeExplicit also permits reselecting the same value.
      const requestedMode = options.permissionMode;
      if (requestedMode !== undefined) {
        if (!MODES.has(requestedMode)) fail('Invalid permission mode');
        if (input.permissionModeExplicit !== true && requestedMode === record.lastRequestedMode && record.memo.options?.permissionMode !== undefined) {
          options.permissionMode = record.memo.options.permissionMode;
        }
        lastRequestedMode = requestedMode;
      }
      memo.options = { ...record.memo.options, ...options };
    }
    record.memo = memo;
    record.lastRequestedMode = lastRequestedMode;
  }
  _config(record) {
    return structuredClone({ ...record.memo, options: { permissionMode: 'default', ...record.memo.options } });
  }
  async runtimeState(input, owner) { return this._snapshot(this._record(input, owner)); }
  async states(owner) { this._active(owner); return [...this.records.values()].filter(r => r.owner === owner).map(r => this._snapshot(r)); }
  start(input, owner) {
    return this._result(() => {
      const record = this._record(input, owner, true);
      const payload = pick(input, ['cwd', 'sessionId', 'options', 'permissionModeExplicit']);
      return this._lane(record, async () => {
        this._remember(record, payload);
        const config = this._config(record);
        const epoch = record.epoch;
        const operation = async () => {
          if (record.closing || record.epoch !== epoch) fail('Conversation closed before bootstrap');
          const engine = this._engine(record);
          try {
            const result = await engine.start(config); return { ...result, runtimeState: this._publish(record), ...this._snapshot(record) };
          } finally { this._publish(record); }
        };
        return config.sessionId ? this._sid(config.sessionId, operation) : operation();
      });
    });
  }
  send(input, owner) {
    return this._result(() => {
      const record = this._record(input, owner, true);
      const payload = pick(input, ['prompt', 'userMessageId', 'cwd', 'sessionId', 'options', 'permissionModeExplicit']);
      if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.includes('\0')) fail('Invalid nonempty prompt');
      payload.userMessageId ??= randomUUID();
      if (typeof payload.userMessageId !== 'string' || !UUID.test(payload.userMessageId)) fail('Invalid userMessageId');
      if (record.nonces.has(payload.userMessageId)) fail('Duplicate userMessageId');
      if (record.nonces.size >= 100000) fail('Conversation nonce limit reached; start a new conversation');
      record.nonces.add(payload.userMessageId);
      return this._lane(record, async () => {
        this._remember(record, payload);
        const config = this._config(record);
        const epoch = record.epoch;
        const operation = async () => {
          if (record.closing || record.epoch !== epoch) fail('Conversation closed before bootstrap');
          const engine = this._engine(record);
          if (!engine.getState().runId) {
            const boot = await engine.start(config);
            this._publish(record);
            if (!boot.success) return { ...boot, runtimeState: this._snapshot(record) };
          }
          if (record.closing || record.epoch !== epoch || this.deadOwners.has(owner)) fail('Conversation closed before send');
          this._publish(record);
          try {
            const actualConfig = this._config(record);
            const accepted = await engine.send({ ...actualConfig, ...payload, sessionId: actualConfig.sessionId, options: actualConfig.options });
            if (record.epoch !== epoch) return { success: false, error: 'Conversation closed during send', runtimeState: this._snapshot(record) };
            return { ...accepted, runtimeState: this._publish(record) };
          } finally { this._publish(record); }
        };
        return config.sessionId ? this._sid(config.sessionId, operation) : operation();
      });
    });
  }
  async _close(record, cancelQueued = true) {
    if (cancelQueued) {
      record.epoch++;
      record.validationAbort.abort();
      record.validationAbort = new AbortController();
    }
    const auxiliary = cancelQueued ? [...this.auxiliary].filter(task => task.cid === record.cid) : [];
    for (const task of auxiliary) task.controller.abort();
    if (record.closing) {
      const closing = record.closing;
      // The auxiliary operation may itself be awaiting this internal idle-close.
      return closing;
    }
    const busy = Boolean(record.engine?.isBusy());
    this._snapshot(record);
    for (const [key, token] of this.tokens) if (token.cid === record.cid) this.tokens.delete(key);
    // Never enqueue behind bootstrap: close() cancels its bootstrap synchronously.
    const engine = record.engine;
    const closing = (async () => {
      const result = engine ? await engine.close() : { success: true };
      await this._waitAuxiliary(auxiliary);
      if (result?.success === false || (engine && !engine.isIdle())) fail('Close has no confirmed actual exit; ownership retained');
      if (record.engine === engine) record.engine = null;
      return { success: true, closed: true, wasBusy: busy, busy: false, runtimeState: this._publish(record) };
    })();
    record.closing = closing;
    try { return await closing; } finally { if (record.closing === closing) record.closing = null; this._publish(record); }
  }
  close(input, owner) { return this._result(async () => { const record = this._record(input, owner, true); return this._close(record); }); }
  interrupt(input, owner) {
    return this._result(async () => {
      const record = this._record(input, owner, true);
      if (!record.engine) return { success: true, runtimeState: this._snapshot(record) };
      if (record.engine.getState().state === 'starting') return this._close(record);
      const result = await record.engine.interrupt();
      if (!result.success || result.stillQueued?.length) {
        const closed = await this._close(record);
        this._emit(record, 'claude:status', { conversationId: record.cid, status: 'aborted', runId: null });
        return { ...closed, interrupted: true };
      }
      return { ...result, closed: false, runtimeState: this._publish(record) };
    });
  }
  mode(input, owner) {
    return this._result(() => {
      const record = this._record(input, owner, true);
      const mode = input.mode === 'manual' ? 'default' : input.mode;
      if (!MODES.has(mode)) fail('Invalid permission mode');
      return this._lane(record, async () => {
        if (!record.engine?.getState().runId) fail('Runner not bootstrapped; change global UI options before next start');
        const result = await record.engine.setPermissionMode(mode);
        if (result.success) record.memo.options = { ...record.memo.options, permissionMode: mode };
        return { ...result, runtimeState: this._publish(record) };
      });
    });
  }
  respond(input, owner) {
    return this._result(async () => {
      const record = this._record(input, owner);
      if (!record?.engine || typeof input.runId !== 'string' || !input.runId || record.engine.getState().runId !== input.runId) fail('Stale approval runId');
      const state = record.engine.getState();
      if (!state.pendingApprovals.some(p => p.requestId === input.requestId)) fail('Approval no longer pending');
      const key = JSON.stringify([record.cid, input.runId, input.requestId]);
      if (this.actions.has(key)) fail('Duplicate approval action in progress');
      this.actions.add(key);
      try { return { ...await record.engine.respond(input.requestId, structuredClone(input.decision), owner), runtimeState: this._publish(record) }; }
      finally { this.actions.delete(key); this._publish(record); }
    });
  }
  control(input, owner, method) {
    return this._result(async () => {
      const record = this._record(input, owner);
      if (!record?.engine?.getState().runId) {
        if (method === 'getPlan') return { success: false, error: 'Runner not ready' };
        if (typeof input !== 'object' || !input.cwd) return [];
        const boot = await this.start(input, owner);
        if (!boot.success) fail(boot.error || 'Bootstrap failed');
      }
      const current = this._record(input, owner);
      if (!current?.engine) fail('Runner closed');
      return current.engine[method]();
    });
  }
  _source(input, owner) {
    const scope = sessionPayload(input);
    this._active(owner);
    // Refresh actual SDK adoption before matching; an old closed memo is not the live writer.
    const matching = [...this.records.values()].filter(r => this._snapshot(r).sessionId === scope.sessionId);
    const held = this.ownership.owner(scope.sessionId);
    let record;
    if (input.conversationId !== undefined || input.cid !== undefined) record = this._record(input, owner, true);
    else record = matching.find(r => r.cid === held?.conversationId && r.owner === held?.ownerWebContentsId)
      || matching.find(r => r.engine?.getState().runId) || matching[0];
    if (matching.some(r => r.owner !== owner)) fail('Session owner mismatch');
    if (record) {
      const state = this._snapshot(record);
      const id = state.sessionId ?? record.memo.sessionId;
      if (id && id !== scope.sessionId) fail('Session does not match caller conversation');
      if (record.memo.cwd && path.resolve(record.memo.cwd) !== path.resolve(scope.cwd)) fail('Session cwd does not match caller conversation');
      this._remember(record, scope);
    }
    if (held && (!record || held.conversationId !== record.cid || held.ownerWebContentsId !== owner)) fail('Session busy or owned by another process');
    return { record, ...scope };
  }
  async _idleClose(record) {
    if (record?.engine?.isBusy()) fail('Session busy: wait for generation, approvals and queued input');
    if (record?.engine) await this._close(record, false);
  }
  _sessionOperation(input, owner, fn) {
    return this._result(() => {
      const source = this._source(input, owner);
      const epoch = source.record?.epoch;
      const work = () => this._sid(source.sessionId, async () => {
        this._active(owner);
        if (source.record && (source.record.epoch !== epoch || source.record.closing)) fail('Conversation closed while session operation waited');
        // Revalidate after waiting on a per-SID lane and before any close/mutation.
        if (this._source(input, owner).record !== source.record) fail('Session writer changed while operation waited');
        await this._sessionRuntime(source.record, owner);
        const assertCurrent = () => {
          this._active(owner);
          if (source.record && (source.record.epoch !== epoch || source.record.closing)) fail('Conversation closed during session operation');
        };
        return fn({ ...source, assertCurrent });
      });
      return source.record ? this._lane(source.record, work) : work();
    });
  }
  async _auxiliary(source, owner, kind, boundary) {
    const { record, cwd, sessionId, assertCurrent } = source;
    const unreserve = this._reserve(sessionId, record, owner, kind);
    let release;
    const task = { cid: record?.cid, owner, controller: new AbortController(), processes: [] };
    let finish;
    task.done = new Promise(resolve => { finish = resolve; });
    task.failure = new Promise((resolve, reject) => { task.failExit = reject; });
    task.failure.catch(() => {});
    const finalize = () => {
      if (!this.auxiliary.has(task)) return;
      release?.(); unreserve();
      this.auxiliary.delete(task); finish();
      if (record) this._publish(record);
    };
    this.auxiliary.add(task);
    try {
      await this._idleClose(record);
      assertCurrent();
      if (task.controller.signal.aborted) fail('Auxiliary operation cancelled');
      release = this._acquire(sessionId, { kind, ownerWebContentsId: owner });
      const result = await boundary({ cwd, sessionId, getRuntime: () => this._sessionRuntime(record, owner), signal: task.controller.signal,
        registerProcess: (process, closedPromise) => {
          if (!closedPromise?.then) fail('Auxiliary registration requires an actual-close promise');
          const child = { process, closed: closedPromise, exited: false };
          task.processes.push(child);
          child.closed.then(exit => { child.exited = true; child.exit = exit; }, () => {});
        },
        onClosed: (process, { code, signal }) => {
          const child = task.processes.find(child => child.process === process);
          if (child) { child.exited = true; child.exit = { code, signal }; }
        },
      });
      await Promise.all(task.processes.map(child => child.closed));
      assertCurrent();
      return result;
    } catch (error) {
      if ((error?.code === 'PROCESS_CLOSE_TIMEOUT' && error.terminated === false) || task.processes.some(child => !child.exited)) {
        task.unconfirmed = true;
        task.controller.abort();
        task.failExit(new ServiceError('Auxiliary cleanup failed: actual process exit not confirmed; ownership retained'));
        // The timeout may carry the only registered handle; retain it for late close and retry.
        if (error.closed?.then && !task.processes.some(child => child.process === error.process && child.closed === error.closed)) {
          const child = { process: error.process, closed: error.closed, exited: false };
          task.processes.push(child);
          child.closed.then(exit => { child.exited = true; child.exit = exit; }, () => {});
        }
        const exits = task.processes.map(child => child.closed);
        if (exits.length) (exits.length === 1 ? exits[0] : Promise.all(exits)).then(() => { task.unconfirmed = false; finalize(); }, () => {});
        fail('Auxiliary process shutdown timed out; actual exit not confirmed; ownership retained');
      }
      throw error;
    } finally { if (!task.unconfirmed) finalize(); }
  }
  async _waitAuxiliary(tasks) {
    await Promise.all(tasks.map(task => {
      if (task.unconfirmed) {
        if (!task.processes.length || !task.processes.every(child => child.exited)) fail('Auxiliary cleanup failed: actual process exit not confirmed; ownership retained');
        return task.done;
      }
      return Promise.race([task.done, task.failure]);
    }));
  }
  getContext(input, owner) {
    return this._sessionOperation(input, owner, async source => {
      const { record, cwd, sessionId, assertCurrent } = source;
      if (record?.engine?.getState().runId) {
        const context = await record.engine.getContextUsage();
        assertCurrent();
        if (context.success) return { ...context, used: context.totalTokens, limit: context.maxTokens };
        if (record.engine.isBusy()) return null;
      }
      return this._auxiliary(source, owner, 'context', this.queryContext);
    });
  }
  compact(input, owner) {
    return this._sessionOperation(input, owner, async source => {
      const result = await this._auxiliary(source, owner, 'compact', this.compactSession);
      return result?.success ? result : { success: false, error: 'Compact failed or timed out; inspect session before retrying', context: result?.context };
    });
  }
  async historyList(input, owner) { this._active(owner); return this.history.list(pick(input, ['cwd', 'offset', 'limit'])); }
  async historyRead(input, owner) { this._active(owner); return this.history.read({ ...sessionPayload(input), ...pick(input, ['offset', 'limit', 'includeSystemMessages']) }); }
  async _all(cwd, sessionId) {
    const messages = []; let offset = 0;
    while (true) {
      const page = await this.history.read({ cwd, sessionId, offset, limit: 500, includeSystemMessages: true });
      if (page.cwd !== cwd || page.sessionId !== sessionId || !Array.isArray(page.messages)) fail('Invalid history page');
      messages.push(...page.messages);
      if (page.nextOffset === null) return messages;
      if (!page.messages.length || !Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) fail('Invalid history pagination');
      offset = page.nextOffset;
    }
  }
  fork(input, owner) {
    return this._sessionOperation(input, owner, async ({ record, cwd, sessionId, assertCurrent }) => {
      if (!record) fail('Caller conversationId required for fork');
      await this._idleClose(record);
      assertCurrent();
      const metadata = await this.history.fork({ cwd, sessionId, ...pick(input, ['upToMessageId', 'title']) });
      return { success: true, ...metadata, messages: await this._all(cwd, metadata.sessionId) };
    });
  }
  async _checkpoint(cwd, sessionId, messageId, textOnly = false) {
    if (typeof messageId !== 'string' || !UUID.test(messageId)) fail('Invalid user checkpoint UUID');
    const raw = await this.history.readRaw({ cwd, sessionId });
    const rows = raw.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const chain = rows.filter(r => !r.isSidechain && ['user', 'assistant', 'system', 'attachment'].includes(r.type) && r.uuid);
    const map = new Map(chain.map(r => [r.uuid, r]));
    if (map.size !== chain.length) fail('Ambiguous history checkpoint');
    const messages = await this._all(cwd, sessionId);
    let id = messages.at(-1)?.uuid;
    if (!map.has(id)) fail('Checkpoint not on known SDK main chain');
    const seen = new Set();
    while (id != null) {
      if (seen.has(id) || !map.has(id)) fail('Invalid checkpoint parent chain');
      seen.add(id); id = map.get(id).parentUuid;
    }
    const target = map.get(messageId);
    if (!seen.has(messageId) || target?.type !== 'user' || target.sessionId !== sessionId || target.message?.role !== 'user' || target.parent_tool_use_id != null) fail('Checkpoint must be a real SDK main-chain user message');
    const content = target.message.content;
    if (Array.isArray(content) && content.some(b => b.type === 'tool_result')) fail('Checkpoint cannot be a tool_result message');
    if (textOnly && !(typeof content === 'string' || (Array.isArray(content) && content.length && content.every(b => b.type === 'text' && typeof b.text === 'string')))) fail('Edit fork requires ordinary user text, not tool_result or attachments');
    return { target, draft: typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '' };
  }
  editFork(input, owner) {
    return this._sessionOperation(input, owner, async ({ record, cwd, sessionId, assertCurrent }) => {
      if (!record) fail('Caller conversationId required for editFork');
      if (record.engine?.isBusy()) fail('Session busy: cannot edit fork');
      const { target, draft } = await this._checkpoint(cwd, sessionId, input.messageId, true);
      await this._idleClose(record);
      assertCurrent();
      if (target.parentUuid == null) return { success: true, newSession: true, cwd, title: 'Edited conversation', draft, messages: [] };
      const metadata = await this.history.fork({ cwd, sessionId, upToMessageId: target.parentUuid });
      return { success: true, ...metadata, draft, messages: await this._all(cwd, metadata.sessionId) };
    });
  }
  rename(input, owner) {
    return this._sessionOperation(input, owner, async ({ record, cwd, sessionId, assertCurrent }) => {
      if (!record) fail('Caller conversationId required for rename');
      await this._idleClose(record);
      assertCurrent();
      return { success: true, ...await this.history.rename({ cwd, sessionId, title: input.title }) };
    });
  }
  async exportTranscript(input, owner) { this._active(owner); return this.history.readRaw(sessionPayload(input)); }
  async _files(cwd, files) {
    if (!Array.isArray(files) || files.some(f => typeof f !== 'string')) fail('Rewind preview omitted filesChanged');
    const root = await fs.promises.realpath(cwd);
    const snapshots = [];
    for (const name of [...new Set(files)].sort()) {
      const relative = path.relative(path.resolve(cwd), path.resolve(cwd, name));
      const file = path.resolve(root, relative);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('Rewind files outside cwd are not allowed');
      const parts = relative.split(path.sep); let parent = root;
      for (const part of parts.slice(0, -1)) {
        parent = path.join(parent, part);
        const stat = await fs.promises.lstat(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Rewind symlink descendant is unsafe');
      }
      let stat;
      try { stat = await fs.promises.lstat(file); }
      catch (error) { if (error.code === 'ENOENT') { snapshots.push([name, 'missing']); continue; } throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('Rewind requires non-linked regular project files');
      const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const initial = await handle.stat();
        const signature = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
        if (!initial.isFile() || signature(stat) !== signature(initial)) fail('Rewind file changed during validation');
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const final = await handle.stat();
        if (signature(initial) !== signature(final)) fail('Rewind file changed during hashing');
        snapshots.push([name, signature(final), hash.digest('hex')]);
      } finally { await handle.close(); }
    }
    return JSON.stringify(snapshots);
  }
  rewind(input, owner) {
    return this._sessionOperation(input, owner, async ({ record, cwd, sessionId, assertCurrent }) => {
      if (!record || typeof input.dryRun !== 'boolean') fail('Rewind requires conversationId and boolean dryRun');
      if (record.engine?.isBusy()) fail('Session busy: cannot rewind');
      await this._checkpoint(cwd, sessionId, input.messageId);
      assertCurrent();
      if (!input.dryRun) {
        const token = this.tokens.get(input.confirmationToken);
        if (!token || token.owner !== owner || token.cid !== record.cid || token.sid !== sessionId || token.messageId !== input.messageId || Date.now() - token.at > 60000 || token.runId !== record.engine?.getState().runId) fail('Invalid or stale rewind confirmation token');
        const engine = record.engine;
        const preview = await engine.rewindFiles(input.messageId, { dryRun: true });
        if (!preview.success || !preview.canRewind || await this._files(cwd, preview.filesChanged) !== token.fingerprint || JSON.stringify(preview) !== token.preview) fail('Rewind preview or files changed; confirm a new preview');
        assertCurrent();
        if (record.closing || record.engine !== engine || engine.isBusy()) fail('Rewind run changed');
        this.tokens.delete(input.confirmationToken);
        const result = await engine.rewindFiles(input.messageId, { dryRun: false });
        return { ...result, ...(result.skippedLinks ? { warning: 'Links skipped; external side effects and transcript were not reverted' } : {}), runtimeState: this._publish(record) };
      }
      if (!record.engine?.getState().runId) {
        const boot = await this._engine(record).start(this._config(record));
        this._publish(record);
        if (!boot.success) return boot;
      }
      const engine = record.engine;
      const preview = await engine.rewindFiles(input.messageId, { dryRun: true });
      if (!preview.success || !preview.canRewind) return preview;
      const fingerprint = await this._files(cwd, preview.filesChanged);
      assertCurrent();
      if (record.closing || record.engine !== engine || engine.isBusy()) fail('Rewind run changed');
      for (const [key, token] of this.tokens) if (Date.now() - token.at > 60000 || token.cid === record.cid) this.tokens.delete(key);
      const confirmationToken = randomUUID();
      this.tokens.set(confirmationToken, { owner, cid: record.cid, sid: sessionId, runId: engine.getState().runId, messageId: input.messageId, at: Date.now(), fingerprint, preview: JSON.stringify(preview) });
      return { ...preview, confirmationToken, runtimeState: this._publish(record) };
    });
  }
  async nativeCreate(input, owner) {
    this._active(owner);
    const spec = structuredClone(input);
    buildNativeArgs(spec); // Validate intent before closing any live SDK writer.
    if (spec.sessionId) spec.sessionId = spec.sessionId.toLowerCase();
    const known = spec.sessionId ? [...this.records.values()].filter(record => this._snapshot(record).sessionId === spec.sessionId) : [];
    for (const record of known) {
      if (record.owner !== owner || path.resolve(record.memo.cwd) !== path.resolve(spec.cwd)) fail('Native session owner or cwd mismatch');
      if (spec.resume !== true) fail('Known SDK session requires explicit resume=true');
    }
    const held = spec.sessionId ? this.ownership.owner(spec.sessionId) : null;
    if (held) {
      const current = this.records.get(held.conversationId);
      if (!current || current.owner !== owner || held.ownerWebContentsId !== owner) fail('Native session busy or owner mismatch');
      if (this._snapshot(current).sessionId !== spec.sessionId) fail('Native sessionId must match the actual adopted SDK session');
      if (spec.resume !== true) fail('Known SDK session requires explicit resume=true');
    }
    const record = held ? this.records.get(held.conversationId) : known[0];
    const epochs = new Map(known.map(record => [record, record.epoch]));
    const assertCurrent = () => {
      this._active(owner);
      for (const [record, epoch] of epochs) if (record.epoch !== epoch || record.closing) fail('Conversation closed during native handoff');
    };
    const operation = async () => {
      assertCurrent();
      await this._sessionRuntime(record, owner);
      assertCurrent();
      if (record && this._snapshot(record).sessionId !== spec.sessionId) fail('Native session changed while waiting');
      const previousOwner = spec.sessionId ? this.ownership.owner(spec.sessionId) : null;
      const unreserve = spec.sessionId ? this._reserve(spec.sessionId, record, owner, 'native-terminal') : () => {};
      try {
        if (previousOwner) {
          if (previousOwner.conversationId !== record?.cid || previousOwner.ownerWebContentsId !== owner) fail('Native session writer changed while waiting');
          if (record.engine?.isBusy()) fail('Session busy: wait for generation, approvals and queued input');
          await this._close(record, false);
        }
        assertCurrent();
        const term = await this.terminalManager.create(spec, owner);
        try { assertCurrent(); }
        catch (error) { await this.terminalManager.close(term.id, owner); throw error; }
        return term;
      } finally {
        for (const record of epochs.keys()) record.epoch++;
        unreserve();
      }
    };
    const work = () => spec.sessionId ? this._sid(spec.sessionId, operation) : operation();
    const task = record ? this._lane(record, work) : work();
    let pending = this.nativePending.get(owner);
    if (!pending) this.nativePending.set(owner, pending = new Set());
    pending.add(task);
    try { return await task; } finally { pending.delete(task); if (!pending.size) this.nativePending.delete(owner); }
  }
  async terminalHealth(owner) {
    this._active(owner);
    try { await this.terminalManager._loadPty(); } catch { /* sanitized manager diagnostic */ }
    const health = this.terminalManager.health;
    return { available: health.ptyAvailable === true, diagnostic: health.diagnostic, sessionBoundary: 'Only explicitly registered session IDs are exclusive; shell commands and external processes may switch sessions outside GUI control' };
  }
  // Public controls for non-IPC consumers use the same ownership validation.
  commands(input, owner) { return this.control(input, owner, 'getCommands'); }
  mcpStatus(input, owner) { return this.control(input, owner, 'getMcpStatus'); }
  plan(input, owner) { return this.control(input, owner, 'getPlan'); }
  abort(input, owner) { return this.interrupt(input, owner); }
  disposeOwner(owner) {
    sender(owner);
    let cleanup = this.ownerCleanups.get(owner);
    if (!cleanup) {
      cleanup = this._disposeOwner(owner);
      this.ownerCleanups.set(owner, cleanup);
      const clear = () => { if (this.ownerCleanups.get(owner) === cleanup) this.ownerCleanups.delete(owner); };
      cleanup.then(clear, clear);
    }
    return this._cleanupDeadline(cleanup);
  }
  async _disposeOwner(owner) {
    sender(owner); this.deadOwners.add(owner);
    this.ownerValidationAborts.get(owner)?.abort();
    const auxiliary = [...this.auxiliary].filter(task => task.owner === owner);
    for (const task of auxiliary) task.controller.abort();
    const records = [...this.records.values()].filter(r => r.owner === owner);
    const closing = records.map(r => this._close(r));
    const auxiliaryExit = this._waitAuxiliary(auxiliary);
    const nativeExit = (async () => {
      await Promise.allSettled([...(this.nativePending.get(owner) || [])]);
      const terminals = await Promise.allSettled(this.terminalManager.list(owner).map(t => this.terminalManager.close(t.id, owner)));
      if (terminals.some(result => result.status === 'rejected')) fail('Native cleanup failed: actual exit not confirmed');
    })();
    const results = await Promise.allSettled([...closing, auxiliaryExit, nativeExit]);
    await Promise.allSettled(records.map(r => this.lanes.get(r.cid)).filter(Boolean));
    if (results.some(result => result.status === 'rejected')) fail('Owner cleanup failed: actual exit not confirmed; ownership retained');
    for (const record of records) this.records.delete(record.cid);
  }
  async forceDisposeAll() {
    this.disposed = true;
    for (const controller of this.ownerValidationAborts.values()) controller.abort();
    for (const task of this.auxiliary) task.controller.abort();
    let timer;
    const cleanup = (async () => {
      try { await this.forceKill(); } catch { /* Explicit exit may still proceed after warning. */ }
      try { await this.disposeAll(); return true; } catch { return false; }
    })();
    try { return await Promise.race([cleanup, new Promise(resolve => { timer = setTimeout(() => resolve(false), 8000); })]); }
    finally { clearTimeout(timer); }
  }
  disposeAll() {
    if (!this.allCleanup) {
      const cleanup = this._disposeAll();
      this.allCleanup = cleanup;
      const clear = () => { if (this.allCleanup === cleanup) this.allCleanup = null; };
      cleanup.then(clear, clear);
    }
    return this._cleanupDeadline(this.allCleanup);
  }
  async _disposeAll() {
    this.disposed = true;
    for (const controller of this.ownerValidationAborts.values()) controller.abort();
    const auxiliary = [...this.auxiliary];
    for (const task of auxiliary) task.controller.abort();
    const nativeDisposal = Promise.resolve().then(() => this.terminalManager.disposeAll());
    const auxiliaryExit = this._waitAuxiliary(auxiliary);
    auxiliaryExit.catch(() => {});
    const results = await Promise.allSettled([...this.records.values()].map(r => this._close(r)));
    const nativeResults = await Promise.allSettled([nativeDisposal, ...[...this.nativePending.values()].flatMap(set => [...set])]);
    await auxiliaryExit;
    await Promise.all([...this.lanes.values(), ...this.sidLanes.values()]);
    if (results.some(r => r.status === 'rejected') || nativeResults[0].status === 'rejected') fail('Process cleanup failed: actual exit not confirmed');
    this.tokens.clear(); this.records.clear();
  }
}
module.exports = { ClaudeService };
