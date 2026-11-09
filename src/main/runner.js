const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { SessionOwnership } = require('./session-ownership');

const IS_WIN = process.platform === 'win32';
const ownership = new SessionOwnership();
const importSDK = () => import('@anthropic-ai/claude-agent-sdk');
const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk']);

function escapeWindowsArg(arg) {
  let s = String(arg);
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\+)$/, '$1$1');
  return '"' + s + '"';
}

function broadcast(channel, payload) {
  const { BrowserWindow } = require('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function defaultGetRuntime() {
  const directories = [...new Set([path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', ...(process.env.PATH || '').split(path.delimiter)])];
  const env = { ...process.env, PATH: directories.join(path.delimiter), FORCE_COLOR: '0' };
  for (const dir of directories) {
    for (const name of IS_WIN ? ['claude.exe', 'claude.cmd'] : ['claude']) {
      const executable = path.resolve(dir, name);
      try {
        if (!fs.statSync(executable).isFile()) continue;
        fs.accessSync(executable, IS_WIN ? fs.constants.F_OK : fs.constants.X_OK);
        const stat = fs.statSync(executable);
        return { executable, env, versionFingerprint: `${executable}:${stat.mtimeMs}:${stat.size}` };
      } catch { /* Try the next actual installation. */ }
    }
  }
  throw new Error('Claude executable not found or not executable');
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// One slot, plus acknowledgement when the SDK asks for the next value after its
// awaited transport.write(). No history or unbounded prompt queue is retained.
class InputStream {
  constructor() { this.slot = null; this.reader = null; this.previous = null; this.ended = false; }
  push(value) {
    if (this.ended) return Promise.reject(new Error('Input is closed'));
    if (this.slot) return Promise.reject(new Error('Input backpressure: retry after the previous send'));
    const consumed = deferred();
    const item = { value, consumed };
    if (this.reader) { const reader = this.reader; this.reader = null; this.previous = item; reader.resolve({ value, done: false }); }
    else this.slot = item;
    return consumed.promise;
  }
  next() {
    this.previous?.consumed.resolve();
    this.previous = null;
    if (this.slot) {
      const item = this.slot; this.slot = null; this.previous = item;
      return Promise.resolve({ value: item.value, done: false });
    }
    if (this.ended) return Promise.resolve({ done: true });
    this.reader = deferred();
    return this.reader.promise;
  }
  end() {
    this.ended = true;
    this.slot?.consumed.reject(new Error('Input is closed'));
    this.slot = null;
    this.previous?.consumed.resolve(); this.previous = null;
    this.reader?.resolve({ done: true }); this.reader = null;
  }
  [Symbol.asyncIterator]() { return this; }
}

function fingerprint(value) {
  const stable = item => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
function usageDelta(current, baseline, key = '') {
  if (['contextWindow', 'maxOutputTokens'].includes(key)) return current;
  if (typeof current === 'number') return current < (baseline ?? 0) ? current : current - (typeof baseline === 'number' ? baseline : 0);
  if (Array.isArray(current)) return structuredClone(current);
  if (current && typeof current === 'object') return Object.fromEntries(Object.entries(current).map(([key, value]) => [key, usageDelta(value, baseline?.[key], key)]));
  return current;
}

function projectMcp(servers) {
  return (Array.isArray(servers) ? servers : []).map(server => {
    const metadata = {};
    for (const key of ['name', 'status', 'serverInfo', 'scope', 'tools']) if (server[key] !== undefined) metadata[key] = structuredClone(server[key]);
    if (server.error) metadata.error = 'MCP server connection failed';
    return metadata;
  });
}

function isJsonValue(value, depth = 0) {
  if (depth > 32) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && isJsonValue(item, depth + 1));
}
function isJsonObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value); }
function onlyKeys(object, keys) { return Object.keys(object).every(key => keys.includes(key)); }
function safeSuggestions(suggestions, toolName) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter(s => isJsonObject(s) && onlyKeys(s, ['type', 'behavior', 'destination', 'rules'])
    && s.type === 'addRules' && s.behavior === 'allow' && s.destination === 'session'
    && Array.isArray(s.rules) && s.rules.length > 0 && s.rules.length <= 32
    && s.rules.every(r => isJsonObject(r) && onlyKeys(r, ['toolName', 'ruleContent']) && r.toolName === toolName
      && typeof r.ruleContent === 'string' && r.ruleContent.length > 0 && r.ruleContent.length <= 4000
      && !/[\0\r\n]/.test(r.ruleContent) && r.ruleContent !== '*')).map(s => structuredClone(s));
}

// Untrusted MCP patterns must not block Electron's main thread. AJV runs in
// a memory/time-bounded worker; no remote refs, coercion, defaults or writes.
async function validateSchema(schema, value, signal) {
  if (!isJsonValue(schema) || !isJsonObject(value)
    || Buffer.byteLength(JSON.stringify({ schema, value })) > 65536) return { valid: false, error: 'Invalid elicitation schema or content: JSON limit exceeded' };
  const { Worker } = require('node:worker_threads');
  const dialect = schema?.$schema ?? '';
  const ajvPath = require.resolve(dialect.includes('2020-12') ? 'ajv/dist/2020' : dialect.includes('2019-09') ? 'ajv/dist/2019' : 'ajv');
  return new Promise(resolve => {
    let worker, timer, settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      worker?.terminate().catch(() => {}); resolve(result);
    };
    const abort = () => finish({ valid: false, error: 'Elicitation schema validation cancelled' });
    if (signal?.aborted) return abort();
    try {
      worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        try {
          const Ajv = require(workerData.ajvPath);
          const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: true, addUsedSchema: false });
          require(workerData.formatsPath)(ajv);
          const validate = ajv.compile(workerData.schema);
          parentPort.postMessage({ valid: Boolean(validate(workerData.value)), error: 'Elicitation content does not match requested schema' });
        } catch { parentPort.postMessage({ valid: false, error: 'Invalid elicitation schema: compilation failed or unresolved reference' }); }
      `, { eval: true, workerData: { ajvPath, formatsPath: require.resolve('ajv-formats'), schema, value },
        resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 } });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish({ valid: false, error: 'Elicitation schema validation timed out' }), 1000);
      worker.once('message', finish);
      worker.once('error', () => finish({ valid: false, error: 'Elicitation schema validator failed' }));
      worker.once('exit', () => finish({ valid: false, error: 'Elicitation schema validator exited' }));
    } catch { finish({ valid: false, error: 'Elicitation schema validator could not start' }); }
  });
}

function validateOptions(opts) {
  const keys = new Set(['sessionId', 'permissionMode', 'model', 'effortLevel', 'autocompact', 'maxBudgetUsd', 'additionalDirectories', 'chrome', 'ide', 'worktree', 'supportedDialogKinds']);
  if (!opts || typeof opts !== 'object' || Array.isArray(opts) || Object.keys(opts).some(key => !keys.has(key))) throw new Error('Invalid runner options');
  if (opts.model !== undefined && (typeof opts.model !== 'string' || !opts.model.trim() || opts.model.length > 256 || /[\0\r\n]/.test(opts.model))) throw new Error('Invalid model');
  if (opts.effortLevel !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effortLevel)) throw new Error('Invalid effort level');
  if (opts.autocompact !== undefined) {
    const match = typeof opts.autocompact === 'string' && opts.autocompact.match(/^(\d+)([kKmM])$/);
    const tokens = match ? Number(match[1]) * (/k/i.test(match[2]) ? 1000 : 1000000) : 0;
    if (opts.autocompact !== 'auto' && !(tokens >= 100000 && tokens <= 1000000)) throw new Error('Invalid autocompact window');
  }
  if (opts.maxBudgetUsd !== undefined && (!Number.isFinite(opts.maxBudgetUsd) || opts.maxBudgetUsd <= 0)) throw new Error('Invalid runtime budget');
  if (opts.additionalDirectories !== undefined && (!Array.isArray(opts.additionalDirectories) || opts.additionalDirectories.some(dir => typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')))) throw new Error('Invalid additional directories');
  for (const key of ['chrome', 'ide']) if (opts[key] !== undefined && typeof opts[key] !== 'boolean') throw new Error('Invalid integration option');
  if (opts.worktree !== undefined && typeof opts.worktree !== 'boolean' && (typeof opts.worktree !== 'string' || !opts.worktree || opts.worktree.includes('\0'))) throw new Error('Invalid worktree');
  if (opts.supportedDialogKinds !== undefined && (!Array.isArray(opts.supportedDialogKinds) || opts.supportedDialogKinds.some(kind => kind !== 'refusal_fallback_prompt'))) throw new Error('Unsupported dialog kind');
}

function gLiveConfig(g, payload) {
  if (!g || !payload.options) return payload;
  return { ...payload, options: { ...g.configuration.options, ...payload.options,
    ...(g.modeChanged ? { permissionMode: g.info.permissionMode } : {}) } };
}

class ClaudeRunner {
  #loadSdk; #getRuntime; #acquire; #stream; #status; #owner;
  #generation = null; #boot = null; #bootAbort = null; #closing = null; #configuration = null;
  constructor(conversationId = 'default', { loadSdk = importSDK, getRuntime = defaultGetRuntime,
    acquireSession = (id, owner) => ownership.acquire(id, owner), emitStream, emitStatus, ownerWebContentsId = 1 } = {}) {
    this.conversationId = conversationId;
    this.ownerWebContentsId = ownerWebContentsId;
    this.#owner = { conversationId, ownerWebContentsId };
    this.#loadSdk = loadSdk; this.#getRuntime = getRuntime; this.#acquire = acquireSession;
    this.#stream = emitStream || (event => broadcast('claude:stream', event));
    this.#status = emitStatus || (event => broadcast('claude:status', event));
  }
  #emit(g, data) { if (this.#generation === g) this.#stream({ ...data, conversationId: this.conversationId, runId: g.runId }); }
  #emitStatus(g, status) { if (this.#generation === g) this.#status({ conversationId: this.conversationId, runId: g.runId, status }); }
  isIdle() { return !this.#generation && !this.#boot && !this.#closing; }
  isBusy() { const g = this.#generation; return Boolean(this.#boot || this.#closing || g?.closing || g?.pending.size || g?.approvals.size || g?.interrupting || g?.writing || g?.active || g?.rewinding); }
  getState() {
    const g = this.#generation;
    return { conversationId: this.conversationId, sessionId: g?.sessionId ?? null, runId: g?.runId ?? null,
      state: this.#closing || g?.closing ? 'closing' : this.#boot ? 'starting' : !g ? 'closed' : this.isBusy() ? 'busy' : 'ready',
      busy: this.isBusy(), info: g ? structuredClone(g.info) : null,
      commands: structuredClone(g?.commands ?? []),
      pendingUserMessageIds: g ? [...g.pending] : [],
      pendingApprovals: g ? [...g.approvals.values()].map(p => structuredClone(p.metadata)) : [] };
  }
  async start(config = {}) {
    if (this.#boot) { await this.#boot; return this.start(config); }
    if (this.#closing) await this.#closing;
    const cancellation = deferred();
    cancellation.promise.catch(() => {});
    this.#bootAbort = cancellation;
    const operation = this.#start(config, cancellation.promise);
    this.#boot = operation;
    try { return await operation; } finally { if (this.#boot === operation) { this.#boot = null; this.#bootAbort = null; } }
  }
  async #start({ cwd, sessionId, options } = {}, cancelled) {
    let g;
    try {
      const configuration = { cwd: cwd ?? this.#configuration?.cwd, options: structuredClone(options ?? this.#configuration?.options ?? {}) };
      if (!configuration.cwd || !fs.statSync(configuration.cwd).isDirectory()) throw new Error('工作目录不存在或为空');
      const runtime = await Promise.race([this.#getRuntime(), cancelled]);
      if (!runtime?.executable || !path.isAbsolute(runtime.executable) || !runtime.env || typeof runtime.env !== 'object') throw new Error('Invalid Claude runtime');
      configuration.options = { ...structuredClone(runtime.options ?? {}), ...configuration.options };
      validateOptions(configuration.options);
      const runtimeIdentity = { executable: runtime.executable, env: runtime.env, version: runtime.versionFingerprint ?? runtime.version };
      const key = fingerprint({ ...configuration, ...runtimeIdentity });
      const existing = this.#generation;
      if (existing?.closing) throw new Error('Process shutdown pending; retry close before starting');
      if (existing && existing.key === key && (!sessionId || sessionId === existing.sessionId)) return this.#startResult(existing);
      if (existing) {
        if (existing.pending.size || existing.approvals.size || existing.writing || existing.interrupting || existing.active || existing.rewinding) throw new Error('Runner is busy; configuration changes require an idle session');
        sessionId ??= existing.sessionId;
        await this.#closeGeneration(existing);
      }
      const sdk = await Promise.race([this.#loadSdk(), cancelled]);
      const opts = configuration.options;
      validateOptions(opts);
      const id = sessionId ?? opts.sessionId ?? randomUUID();
      if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new Error('sessionId must be a UUID');
      const permissionMode = opts.permissionMode ?? 'default';
      if (!MODES.has(permissionMode)) throw new Error('Invalid permission mode');
      g = { runId: randomUUID(), sessionId: id, key, runtimeIdentity, configuration, input: new InputStream(), pending: new Set(), commandStates: new Map(), lifecycle: false, active: false, approvals: new Map(),
        leases: [], processes: [], info: { permissionMode, budgetScope: 'process' }, usage: {}, cost: 0, closing: false, writing: false,
        secrets: Object.entries(runtime.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|AUTH|HEADERS/i.test(key) && typeof value === 'string' && value).map(([, value]) => value) };
      g.leases.push(await this.#acquire(id, this.#owner));
      this.#generation = g;
      this.#configuration = configuration;
      this.#emitStatus(g, 'starting');
      const sdkOptions = { cwd: configuration.cwd, env: runtime.env, pathToClaudeCodeExecutable: runtime.executable,
        systemPrompt: { type: 'preset', preset: 'claude_code' }, settingSources: ['user', 'project', 'local'],
        permissionMode, includePartialMessages: true, enableFileCheckpointing: true,
        forwardSubagentText: true, includeHookEvents: true,
        ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        ...(sessionId ? { resume: id } : { sessionId: id }),
        extraArgs: { 'replay-user-messages': null },
        spawnClaudeCodeProcess: spawnOptions => this.#spawn(g, spawnOptions),
        canUseTool: (toolName, input, ctx) => this.#approval(g, toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'tool', { toolName, input }, ctx),
        onElicitation: (request, ctx) => this.#approval(g, 'elicitation', { toolName: request.serverName, input: request, ...request }, ctx),
        supportedDialogKinds: opts.supportedDialogKinds ?? [],
        abortController: new AbortController(),
        onUserDialog: (request, ctx) => request.dialogKind === 'refusal_fallback_prompt' && opts.supportedDialogKinds?.includes(request.dialogKind)
          ? this.#approval(g, 'dialog', { toolName: request.dialogKind, input: request.payload, ...request }, ctx)
          : Promise.resolve({ behavior: 'cancelled' }) };
      for (const key of ['model', 'maxBudgetUsd', 'additionalDirectories']) if (opts[key] !== undefined) sdkOptions[key] = opts[key];
      if (opts.effortLevel) sdkOptions.effort = opts.effortLevel;
      if (opts.autocompact) sdkOptions.extraArgs.autocompact = opts.autocompact;
      if (opts.chrome !== undefined) sdkOptions.extraArgs[opts.chrome ? 'chrome' : 'no-chrome'] = null;
      if (opts.ide) sdkOptions.extraArgs.ide = null;
      if (opts.worktree) sdkOptions.extraArgs.worktree = opts.worktree === true ? null : opts.worktree;
      if (opts.model) g.info.model = opts.model;
      if (runtime.version) g.info.version = runtime.version;
      g.allowBypass = sdkOptions.allowDangerouslySkipPermissions === true;
      g.abortController = sdkOptions.abortController;
      g.q = sdk.query({ prompt: g.input, options: sdkOptions });
      g.info.capabilities = [];
      g.info.supports = { contextUsage: typeof g.q.getContextUsage === 'function', plan: false,
        cancelAsyncMessage: typeof g.q.cancelAsyncMessage === 'function', interruptReceipt: false, cancelQueuedAtomically: false };
      g.pump = this.#pump(g);
      const init = await Promise.race([g.q.initializationResult(), cancelled]);
      g.commands = await Promise.race([g.q.supportedCommands(), cancelled]);
      g.info.mcpServers = projectMcp(await Promise.race([g.q.mcpServerStatus(), cancelled]));
      if (g.closing || this.#generation !== g) throw new Error('Bootstrap cancelled');
      if (init?.session_id && init.session_id !== g.sessionId) await this.#adoptSession(g, init.session_id);
      return this.#startResult(g);
    } catch (error) {
      if (g) {
        this.#emitStatus(g, 'error');
        try { await this.#closeGeneration(g); }
        catch (closeError) { this.#emit(g, { type: 'runner_error', operation: 'close', error: this.#safeError(closeError, g) }); }
      }
      return { success: false, error: this.#safeError(error, g) };
    }
  }
  #safeError(error, g = this.#generation) {
    // Runtime/SDK errors may include authentication headers or spawn env. Do not
    // forward their arbitrary object or message across the renderer boundary.
    const message = error?.message || '';
    const safe = /^(Runner is busy|工作目录|sessionId must|Session is already owned|Invalid |Unsupported dialog|Claude executable|Bootstrap cancelled|Process shutdown|Rewind )/.test(message)
      ? message : error?.code === 'ENOENT' ? 'Claude executable or working directory not found (ENOENT)' : 'Claude SDK operation failed; check runtime stderr for details';
    return this.#redact(safe, g);
  }
  #redact(text, g = this.#generation) {
    for (const secret of g?.secrets ?? []) text = text.split(secret).join('[redacted]');
    return text.replace(/(authorization\s*[:=]\s*|bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
  }
  #startResult(g) { return { success: true, sessionId: g.sessionId, commands: structuredClone(g.commands ?? []), info: structuredClone(g.info), runId: g.runId }; }
  async #adoptSession(g, id) {
    const release = await this.#acquire(id, this.#owner);
    g.leases.push(release);
    // Keep the original reservation until the writer process has exited.
    g.sessionId = id;
    this.#emit(g, { type: 'session_changed', sessionId: id });
  }
  async #pump(g) {
    try {
      for await (const message of g.q) {
        if (g.closing || this.#generation !== g) continue;
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.session_id && message.session_id !== g.sessionId) await this.#adoptSession(g, message.session_id);
          for (const key of ['tools', 'model', 'version']) if (message[key] !== undefined) g.info[key] = structuredClone(message[key]);
          if (message.claude_code_version) g.info.version = message.claude_code_version;
          if (Array.isArray(message.capabilities)) {
            g.info.capabilities = message.capabilities.filter(capability => typeof capability === 'string');
            g.info.supports.interruptReceipt = g.info.capabilities.includes('interrupt_receipt_v1');
          }
          if (MODES.has(message.permissionMode)) this.#updateMode(g, message.permissionMode);
        }
        if (message.type === 'command_lifecycle') {
          const id = message.command_uuid;
          if (g.pending.has(id)) {
            g.lifecycle = true;
            if (['completed', 'cancelled', 'discarded'].includes(message.state)) {
              g.pending.delete(id); g.commandStates.delete(id);
            } else if (['queued', 'started'].includes(message.state)) {
              g.commandStates.set(id, message.state);
              if (message.state === 'started') g.active = true;
            }
          }
        }
        if (message.type === 'system' && message.subtype === 'session_state_changed') {
          g.active = message.state !== 'idle';
          if (g.active) this.#emitStatus(g, 'streaming');
        }
        if (message.type === 'system' && message.subtype === 'status') {
          if (MODES.has(message.permissionMode)) this.#updateMode(g, message.permissionMode);
          if (message.status) { g.active = true; this.#emitStatus(g, 'streaming'); }
        }
        if (['assistant', 'stream_event'].includes(message.type) && !message.parent_tool_use_id) {
          g.active = true;
        }
        if (message.type === 'result') {
          const result = { ...message, cumulativeUsage: structuredClone(message.modelUsage ?? {}), cumulativeCostUsd: message.total_cost_usd,
            modelUsage: usageDelta(message.modelUsage ?? {}, g.usage), total_cost_usd: usageDelta(message.total_cost_usd, g.cost) };
          g.usage = structuredClone(message.modelUsage ?? {}); g.cost = message.total_cost_usd ?? g.cost;
          // A result closes the consumed batch, not the future command queue.
          for (const id of g.pending) {
            if (g.commandStates.get(id) === 'started' || !g.lifecycle) {
              g.pending.delete(id); g.commandStates.delete(id);
            }
          }
          g.active = false;
          result.hasPending = Boolean(g.pending.size || g.writing || g.approvals.size);
          this.#emit(g, result);
          // emitStream may synchronously enqueue the next turn.
          this.#emitStatus(g, this.isBusy() ? 'streaming' : message.is_error || message.subtype !== 'success' ? 'error' : 'completed');
        } else this.#emit(g, message);
      }
      if (!g.closing && (g.pending.size || g.active || g.approvals.size)) {
        this.#emit(g, { type: 'runner_error', operation: 'query', error: 'Claude query ended before a final result' });
        this.#emitStatus(g, 'error');
      }
    } catch (error) {
      if (!g.closing) {
        this.#emit(g, { type: 'runner_error', operation: 'query', error: this.#safeError(error, g) });
        this.#emitStatus(g, 'error');
      }
    } finally {
      // Never await the pump from its own cleanup or let shutdown rejection
      // escape this background task. The caller can retry close after timeout.
      if (!g.closing) {
        try { await this.#closeGeneration(g); }
        catch (error) { this.#emit(g, { type: 'runner_error', operation: 'close', error: this.#safeError(error, g) }); }
      }
    }
  }
  async send(payload = {}) {
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.includes('\0')) return { success: false, error: 'prompt must be a nonempty string' };
    const uuid = payload.userMessageId === undefined ? randomUUID() : payload.userMessageId;
    if (typeof uuid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uuid)) return { success: false, error: 'userMessageId must be a UUID' };
    if (!this.#generation || payload.cwd || payload.options || payload.sessionId) {
      const boot = await this.start(gLiveConfig(this.#generation, payload));
      if (!boot.success) return boot;
    } else if (this.#boot) await this.#boot;
    const g = this.#generation;
    if (!g || g.closing || g.interrupting || g.rewinding) return { success: false, error: 'Runner is not ready' };
    if (g.writing || g.pending.size >= 32) return { success: false, error: 'Input backpressure: retry later' };
    if (g.pending.has(uuid)) return { success: false, error: 'User message UUID is already pending' };
    g.pending.add(uuid); g.commandStates.set(uuid, 'sent'); g.writing = true;
    try {
      await g.input.push({ type: 'user', uuid, session_id: g.sessionId, parent_tool_use_id: null,
        message: { role: 'user', content: payload.prompt } });
      return { success: true, sessionId: g.sessionId, userMessageId: uuid, runId: g.runId };
    } catch { g.pending.delete(uuid); g.commandStates.delete(uuid); return { success: false, error: 'Input is closed' }; }
    finally { g.writing = false; }
  }
  async rewindFiles(messageId, { dryRun = true } = {}) {
    if (typeof messageId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(messageId)
      || typeof dryRun !== 'boolean') return { success: false, canRewind: false, error: 'Rewind requires a user checkpoint UUID and boolean dryRun' };
    const g = this.#generation;
    if (!g || g.closing || this.isBusy()) return { success: false, canRewind: false, error: 'Runner is busy or not ready for rewind' };
    g.rewinding = true;
    try {
      const result = await g.q.rewindFiles(messageId, { dryRun });
      if (!result || typeof result.canRewind !== 'boolean') throw new Error('Rewind returned an invalid result');
      const projected = { success: true, canRewind: result.canRewind };
      if (typeof result.error === 'string') projected.error = this.#redact(result.error, g);
      if (Array.isArray(result.filesChanged) && result.filesChanged.every(file => typeof file === 'string')) projected.filesChanged = structuredClone(result.filesChanged);
      for (const key of ['insertions', 'deletions', 'skippedLinks']) if (Number.isFinite(result[key]) && result[key] >= 0) projected[key] = result[key];
      return projected;
    } catch (error) { return { success: false, canRewind: false, error: this.#safeError(error, g) }; }
    finally { g.rewinding = false; }
  }
  async getPlan() {
    const g = this.#generation;
    if (!g || g.closing) return { success: false, error: 'Runner is not ready' };
    const pending = [...g.approvals.values()].find(p => p.metadata.kind === 'plan' && typeof p.metadata.planContent === 'string');
    if (pending) return { success: true, exists: true, content: pending.metadata.planContent, source: 'approval', requestId: pending.metadata.requestId };
    return { success: false, error: 'Installed SDK has no public getPlan API; no inline plan is available in the pending approval' };
  }
  async getContextUsage() {
    const g = this.#generation;
    if (!g || g.closing || this.#boot) return { success: false, error: 'Runner is not ready' };
    if (typeof g.q.getContextUsage !== 'function') return { success: false, error: 'Context usage is not supported by this SDK' };
    try {
      const usage = await g.q.getContextUsage();
      if (this.#generation !== g || g.closing) return { success: false, error: 'Runner changed while reading context usage' };
      if (!isJsonObject(usage) || !Array.isArray(usage.categories) || !Number.isFinite(usage.totalTokens) || !Number.isFinite(usage.maxTokens)) throw new Error('Invalid context usage response');
      const result = { success: true };
      for (const key of ['categories', 'totalTokens', 'maxTokens', 'rawMaxTokens', 'percentage', 'gridRows', 'model', 'memoryFiles', 'mcpTools', 'deferredBuiltinTools', 'systemTools', 'systemPromptSections', 'agents', 'slashCommands', 'skills', 'autoCompactThreshold', 'isAutoCompactEnabled', 'messageBreakdown', 'apiUsage']) {
        if (usage[key] !== undefined) result[key] = structuredClone(usage[key]);
      }
      return result;
    } catch (error) { return { success: false, error: this.#safeError(error, g) }; }
  }
  async getCommands() {
    const g = this.#generation;
    if (!g || g.closing) return [];
    const commands = await g.q.supportedCommands();
    if (this.#generation === g) g.commands = structuredClone(commands);
    return structuredClone(commands);
  }
  async getMcpStatus() { return this.#generation ? projectMcp(await this.#generation.q.mcpServerStatus()) : []; }
  async setPermissionMode(mode) {
    if (!MODES.has(mode)) return { success: false, error: 'Invalid permission mode' };
    const g = this.#generation;
    if (!g || g.closing) return { success: false, error: 'Runner is not ready' };
    if (mode === 'bypassPermissions' && !g.allowBypass) return { success: false, error: 'Bypass permissions requires explicit bypass bootstrap; restart after confirmation' };
    try {
      await g.q.setPermissionMode(mode);
      this.#updateMode(g, mode);
      this.#emit(g, { type: 'permission_mode_changed', permissionMode: mode });
      return { success: true, permissionMode: mode };
    } catch { return { success: false, error: 'Permission mode change failed' }; }
  }
  #updateMode(g, mode) {
    g.info.permissionMode = mode;
    g.configuration.options.permissionMode = mode;
    g.modeChanged = true;
    g.key = fingerprint({ ...g.configuration, ...g.runtimeIdentity });
  }
  #fallback(kind) { return kind === 'elicitation' ? { action: 'cancel' } : kind === 'dialog' ? { behavior: 'cancelled' } : { behavior: 'deny', message: 'Request cancelled' }; }
  #approval(g, kind, fields, ctx) {
    if (g.closing || g.interrupting || ctx.signal?.aborted) return Promise.resolve(this.#fallback(kind));
    const requestId = ctx.requestId;
    if (typeof requestId !== 'string' || !requestId) return Promise.resolve(this.#fallback(kind));
    const existing = g.approvals.get(requestId);
    if (existing) return existing.promise;
    if (g.approvals.size >= 32) return Promise.resolve(this.#fallback(kind));
    const wait = deferred();
    const suggestions = safeSuggestions(ctx.suggestions, fields.toolName);
    const metadata = { requestId, kind, status: 'waiting', ...structuredClone(fields),
      alwaysAllowAvailable: kind === 'tool' && suggestions.length > 0 };
    if (kind === 'plan' && typeof fields.input?.plan === 'string') metadata.planContent = fields.input.plan;
    for (const key of ['title', 'displayName', 'description', 'blockedPath', 'decisionReason', 'toolUseID']) {
      if (ctx[key] !== undefined) metadata[key] = ctx[key];
    }
    const pending = { ...wait, metadata, suggestions, input: structuredClone(fields.input), signal: ctx.signal, validationAbort: new AbortController() };
    pending.abort = () => this.#resolveApproval(g, requestId, this.#fallback(kind));
    g.approvals.set(requestId, pending);
    ctx.signal?.addEventListener('abort', pending.abort, { once: true });
    this.#emit(g, { type: 'approval_request', ...metadata });
    return wait.promise;
  }
  #resolveApproval(g, requestId, response) {
    const pending = g.approvals.get(requestId);
    if (!pending) return;
    g.approvals.delete(requestId);
    pending.validationAbort.abort();
    pending.signal?.removeEventListener('abort', pending.abort);
    pending.resolve(response);
    this.#emit(g, { type: 'approval_resolved', requestId, kind: pending.metadata.kind, status: 'resolved',
      decision: response.behavior ?? response.action });
  }
  #clearApprovals(g) {
    for (const [id, pending] of g.approvals) this.#resolveApproval(g, id, this.#fallback(pending.metadata.kind));
  }
  async respond(requestId, decision, ownerWebContentsId) {
    if (ownerWebContentsId !== this.#owner.ownerWebContentsId) return { success: false, error: 'Approval owner mismatch' };
    const g = this.#generation;
    const pending = g?.approvals.get(requestId);
    if (!pending || g.closing || g.interrupting) return { success: false, error: 'Approval is no longer pending' };
    try {
      if (!isJsonObject(decision)) throw new Error();
      const { kind } = pending.metadata;
      let response;
      if (kind === 'elicitation') {
        if (!onlyKeys(decision, ['action', 'content']) || !['accept', 'decline', 'cancel'].includes(decision.action)) throw new Error();
        response = { action: decision.action };
        if (decision.action === 'accept') {
          if (pending.validating) return { success: false, error: 'Elicitation schema validation already in progress' };
          pending.validating = true;
          let validation;
          try { validation = await validateSchema(pending.metadata.requestedSchema ?? { type: 'object' }, decision.content, pending.validationAbort.signal); }
          finally { pending.validating = false; }
          if (g.approvals.get(requestId) !== pending || g.closing || g.interrupting) return { success: false, error: 'Approval is no longer pending' };
          if (!validation.valid) {
            pending.metadata.validationError = validation.error;
            this.#emit(g, { type: 'approval_validation_error', requestId, kind, error: validation.error });
            return { success: false, error: validation.error };
          }
          delete pending.metadata.validationError;
          response.content = structuredClone(decision.content);
        } else if (decision.content !== undefined) throw new Error();
      } else if (kind === 'dialog') {
        if (!onlyKeys(decision, ['behavior', 'result']) || !['completed', 'cancelled'].includes(decision.behavior)) throw new Error();
        if (decision.behavior === 'completed' && !['retry_fallback', 'edit_prompt', 'cancelled'].includes(decision.result)) throw new Error();
        response = decision.behavior === 'completed' ? { behavior: 'completed', result: decision.result } : { behavior: 'cancelled' };
      } else {
        const keys = kind === 'question' ? ['behavior', 'answers', 'message'] : kind === 'plan' ? ['behavior', 'mode', 'message'] : ['behavior', 'editedInput', 'alwaysAllow', 'message'];
        if (!onlyKeys(decision, keys) || !['allow', 'deny'].includes(decision.behavior)) throw new Error();
        if (decision.message !== undefined && (typeof decision.message !== 'string' || decision.message.length > 4000)) throw new Error();
        if (decision.behavior === 'deny') response = { behavior: 'deny', message: decision.message ?? 'User denied this request' };
        else if (kind === 'question') {
          const questions = pending.input.questions;
          if (!Array.isArray(questions) || !isJsonObject(decision.answers)
            || Object.keys(decision.answers).length !== questions.length
            || questions.some(q => typeof q.question !== 'string' || typeof decision.answers[q.question] !== 'string' || !decision.answers[q.question].trim() || decision.answers[q.question].length > 4000)
            || Object.keys(decision.answers).some(key => !questions.some(q => q.question === key))) throw new Error();
          response = { behavior: 'allow', updatedInput: { ...pending.input, answers: structuredClone(decision.answers) } };
        } else if (kind === 'plan') {
          const mode = decision.mode ?? 'default';
          if (!['default', 'acceptEdits'].includes(mode)) throw new Error();
          response = { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] };
          this.#updateMode(g, mode);
          this.#emit(g, { type: 'permission_mode_changed', permissionMode: mode });
        } else {
          if (decision.editedInput !== undefined && !isJsonObject(decision.editedInput)) throw new Error();
          if (decision.alwaysAllow !== undefined && typeof decision.alwaysAllow !== 'boolean') throw new Error();
          response = { behavior: 'allow' };
          if (decision.editedInput !== undefined) response.updatedInput = structuredClone(decision.editedInput);
          if (decision.alwaysAllow) {
            if (!pending.suggestions.length || decision.editedInput !== undefined) throw new Error();
            response.updatedPermissions = structuredClone(pending.suggestions);
          }
        }
      }
      this.#resolveApproval(g, requestId, response);
      return { success: true };
    } catch { return { success: false, error: 'Invalid approval decision' }; }
  }
  async interrupt() {
    const g = this.#generation;
    if (!g) return { success: true };
    if (g.interrupting) return g.interrupting;
    const operation = (async () => {
      try {
        this.#clearApprovals(g);
        const ids = new Set(g.pending);
        const confirmed = new Set();
        const cancel = async id => {
          if (typeof g.q.cancelAsyncMessage !== 'function') return false;
          try { return await g.q.cancelAsyncMessage(id) === true; } catch { return false; }
        };
        for (const id of ids) if (await cancel(id)) confirmed.add(id);
        // Use only the official no-argument interrupt. cancel_queued is not
        // exposed by this SDK's public Query API, even on capable CLIs.
        const receipt = await g.q.interrupt();
        const hasReceipt = Array.isArray(receipt?.still_queued);
        const survivors = hasReceipt ? [...new Set(receipt.still_queued.filter(id => ids.has(id)))] : [...ids].filter(id => !confirmed.has(id));
        const unresolved = [];
        for (const id of survivors) {
          if (!hasReceipt || !await cancel(id)) unresolved.push(id);
        }
        for (const id of ids) {
          if (unresolved.includes(id)) { g.pending.add(id); g.commandStates.set(id, 'sent'); }
          else { g.pending.delete(id); g.commandStates.delete(id); }
        }
        g.active = false;
        if (unresolved.length) return { success: false, stillQueued: unresolved, error: 'Queued input cancellation is not guaranteed by this SDK/CLI; close the runner to guarantee stop' };
        this.#emitStatus(g, 'aborted');
        return { success: true, stillQueued: [] };
      } catch { return { success: false, error: 'Interrupt failed' }; }
    })();
    g.interrupting = operation;
    try { return await operation; } finally { g.interrupting = null; }
  }
  abort() { return this.interrupt(); }
  #spawn(g, { command, args, cwd, env, signal }) {
    const proc = IS_WIN && /\.(cmd|bat)$/i.test(command)
      ? spawn('cmd.exe', ['/d', '/s', '/c', [command, ...args].map(escapeWindowsArg).join(' ')], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true });
    const closed = deferred();
    const record = { proc, closed: closed.promise, exited: false };
    g.processes.push(record);
    proc.once('close', () => {
      record.exited = true; signal?.removeEventListener('abort', abort); closed.resolve();
      if (g.closing && !g.closePromise && g.processes.every(p => p.exited)) {
        this.#closeGeneration(g).catch(error => this.#emit(g, { type: 'runner_error', operation: 'close', error: this.#safeError(error, g) }));
      }
    });
    // A spawn error is not process termination: Node follows it with close.
    proc.on('error', () => {});
    const abort = () => this.#kill(record, 'SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const decoder = new StringDecoder('utf8');
    const longest = g.secrets.reduce((max, secret) => Math.max(max, secret.length), 1);
    let buffered = '', suppressed = false;
    const emit = text => {
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + 8192, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        this.#emit(g, { type: 'stderr', text: text.slice(offset, end), timestamp: Date.now() });
        offset = end;
      }
    };
    // A finite-state scanner preserves arbitrary whitespace and suppresses the
    // entire credential, including values split over infinitely long lines.
    // Its only look-behind is a <=13 character header, never a greedy regex.
    const headers = ['authorization', 'bearer', 'api_key', 'api-key', 'apikey', 'token', 'password', 'secret'];
    let candidate = '', mode = 'scan', bearer = false;
    const redactHeaders = (text, final = false) => {
      let out = '';
      for (const char of text) {
        if (mode === 'credential') {
          if (!/[\s,;]/.test(char)) continue;
          mode = 'scan';
        }
        if (mode === 'value') {
          if (/\s/.test(char)) { out += char; continue; }
          if (!/[,;]/.test(char)) { out += '[redacted]'; mode = 'credential'; continue; }
          mode = 'scan';
        }
        if (mode === 'separator') {
          if (/\s/.test(char)) { out += char; if (bearer) mode = 'value'; continue; }
          if (!bearer && /[:=]/.test(char)) { out += char; mode = 'value'; continue; }
          mode = 'scan';
        }
        candidate += char;
        while (candidate && !headers.some(header => header.startsWith(candidate.toLowerCase()))) {
          out += candidate[0]; candidate = candidate.slice(1);
        }
        if (headers.includes(candidate.toLowerCase())) {
          bearer = candidate.toLowerCase() === 'bearer';
          out += candidate; candidate = ''; mode = 'separator';
        }
      }
      if (final) { out += candidate; candidate = ''; }
      emit(out);
    };
    const flush = (final = false) => {
      const boundary = final ? buffered.length : Math.max(0, buffered.length - longest + 1);
      let cursor = 0, text = '';
      // Consume leftmost non-overlapping full matches, even when they extend
      // past the safe cut. Moving the cut backwards could retain an infinite
      // overlapping chain (e.g. secret 'aaaa' and an all-'a' stream).
      while (cursor < boundary) {
        let start = -1, match;
        for (const secret of g.secrets) {
          const found = buffered.indexOf(secret, cursor);
          if (found >= 0 && found < boundary && (start < 0 || found < start || (found === start && secret.length > match.length))) {
            start = found; match = secret;
          }
        }
        if (start < 0) {
          let end = boundary;
          if (!final && end && /[\uD800-\uDBFF]/.test(buffered[end - 1])) end--;
          text += buffered.slice(cursor, end); cursor = end; break;
        }
        text += buffered.slice(cursor, start) + '[redacted]';
        cursor = start + match.length;
      }
      buffered = buffered.slice(cursor);
      redactHeaders(text, final);
    };
    const receive = (text, final = false) => {
      if (longest > 24576) {
        if (!suppressed) {
          suppressed = true;
          emit('[stderr suppressed: runtime secret exceeds safe streaming limit]');
          this.#emit(g, { type: 'runner_error', operation: 'stderr', error: 'Runtime secret exceeds safe streaming limit; stderr suppressed, not full output' });
        }
        return;
      }
      // Slice decoded chunks too: synthetic/large chunks must not grow the
      // persistent rolling buffer. At most 24 Ki + 4 Ki UTF-16 units
      // (56 KiB plus constant scanner state) are held, below the 64 KiB cap.
      for (let offset = 0; offset < text.length; offset += 4096) {
        buffered += text.slice(offset, offset + 4096); flush();
      }
      if (final) flush(true);
    };
    proc.stderr.on('data', chunk => receive(decoder.write(chunk)));
    proc.stderr.once('end', () => receive(decoder.end(), true));
    return proc;
  }
  #kill(record, signal) {
    if (record.exited) return;
    try {
      if (!Number.isSafeInteger(record.proc.pid) || record.proc.pid <= 0) { record.proc.kill(signal); return; }
      if (IS_WIN) {
        const killer = spawn('taskkill', ['/pid', String(record.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {});
      } else process.kill(-record.proc.pid, signal);
    } catch { try { record.proc.kill(signal); } catch { /* Already exited. */ } }
  }
  async #waitProcesses(g) {
    await Promise.all(g.processes.map(async record => {
      if (record.exited) return;
      const term = setTimeout(() => this.#kill(record, 'SIGTERM'), 2000);
      const kill = setTimeout(() => this.#kill(record, 'SIGKILL'), 4000);
      const timeout = deferred();
      const bounded = setTimeout(() => timeout.reject(new Error('Process shutdown timed out; ownership retained')), 7000);
      try { await Promise.race([record.closed, timeout.promise]); }
      finally { clearTimeout(term); clearTimeout(kill); clearTimeout(bounded); }
    }));
  }
  async #closeGeneration(g) {
    if (g.closePromise) return g.closePromise;
    g.closing = true;
    g.closePromise = (async () => {
      this.#clearApprovals(g);
      g.input.end();
      // Query.close() owns its graceful transport shutdown. Do not abort the
      // spawn signal here: that bypasses the SDK grace and kills the writer.
      try { g.q?.close(); } catch (error) {
        this.#emit(g, { type: 'runner_error', operation: 'close', error: this.#safeError(error, g) });
      }
      await this.#waitProcesses(g);
      // Closing input/query fences the pump; awaiting it here can self-deadlock
      // when EOF initiated this very cleanup. Actual process close is the lease boundary.
      for (const release of g.leases.splice(0)) release();
      g.pending.clear();
      if (this.#generation === g) this.#generation = null;
    })().catch(error => {
      g.closePromise = null;
      // Keep g.closing true: no sends or generation reuse after uncertain exit.
      throw error;
    });
    return g.closePromise;
  }
  async close() {
    if (this.#closing) return this.#closing;
    this.#bootAbort?.reject(new Error('Bootstrap cancelled'));
    const operation = (async () => { if (this.#boot) await this.#boot; if (this.#generation) await this.#closeGeneration(this.#generation); })();
    this.#closing = operation;
    try { await operation; return { success: true }; } finally { this.#closing = null; }
  }
}

function parseTokenCount(str, unit) {
  const n = parseFloat(str);
  if (!isFinite(n)) return null;
  if (/^m$/i.test(unit || '')) return Math.round(n * 1e6);
  if (/^k$/i.test(unit || '')) return Math.round(n * 1e3);
  return Math.round(n);
}
function parseContextOutput(text) {
  if (typeof text !== 'string' || !text) return null;
  const tokens = text.match(/\*\*Tokens:\*\*\s*([\d.]+)\s*([kKmM]?)\s*\/\s*([\d.]+)\s*([kKmM]?)/);
  if (!tokens) return null;
  const used = parseTokenCount(tokens[1], tokens[2]), limit = parseTokenCount(tokens[3], tokens[4]);
  if (used === null || limit === null || limit <= 0) return null;
  const out = { used, limit };
  const free = text.match(/\|\s*Free space\s*\|\s*([\d.]+)\s*([kKmM]?)/);
  if (free) out.free = parseTokenCount(free[1], free[2]) ?? undefined;
  const buffer = text.match(/\|\s*Autocompact buffer\s*\|\s*([\d.]+)\s*([kKmM]?)/);
  if (buffer) out.autocompactBuffer = parseTokenCount(buffer[1], buffer[2]) ?? undefined;
  return out;
}

async function runCli(args, cwd, timeoutMs, { getRuntime = defaultGetRuntime, prompt = '', signal, registerProcess, onClosed } = {}) {
  if (typeof cwd !== 'string' || !cwd || !fs.existsSync(cwd) || signal?.aborted) return null;
  return new Promise((resolve, reject) => {
    let stdout = '', bytes = 0, settled = false, stopping = false, exited = false, proc, killTimer, closeTimer;
    const closed = deferred();
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = result => {
      if (settled) return;
      settled = true; cleanup(); resolve(result);
    };
    const terminate = how => {
      if (!proc || exited) return;
      try {
        if (IS_WIN && Number.isSafeInteger(proc.pid) && proc.pid > 0) {
          const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => {});
        } else if (Number.isSafeInteger(proc.pid) && proc.pid > 0) process.kill(-proc.pid, how);
        else proc.kill(how);
      } catch { try { proc.kill(how); } catch { /* Only close confirms exit. */ } }
    };
    const abort = () => {
      if (settled || stopping) return;
      stopping = true; stdout = '';
      if (!proc) { finish(null); return; }
      terminate('SIGTERM');
      killTimer = setTimeout(() => terminate('SIGKILL'), 2000);
      closeTimer = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup();
        // Rejection is deliberately NOT the ordinary null (confirmed closed)
        // cancellation result. Retain the handle and actual-close promise.
        const error = new Error('Process shutdown timed out; ownership retained');
        error.code = 'PROCESS_CLOSE_TIMEOUT'; error.process = proc;
        error.closed = closed.promise; error.terminated = false;
        reject(error);
      }, 7000);
    };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    Promise.resolve().then(getRuntime).then(runtime => {
      if (settled || signal?.aborted) { abort(); return; }
      try {
        const options = { cwd, env: runtime.env, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true };
        proc = IS_WIN && /\.(cmd|bat)$/i.test(runtime.executable)
          ? spawn('cmd.exe', ['/d', '/s', '/c', [runtime.executable, ...args].map(escapeWindowsArg).join(' ')], options)
          : spawn(runtime.executable, args, options);
        proc.once('close', (code, exitSignal) => {
          exited = true; closed.resolve({ code, signal: exitSignal });
          try { Promise.resolve(onClosed?.(proc, { code, signal: exitSignal })).catch(() => {}); } catch { /* Observer only. */ }
          // Even a late close clears timers/listeners, but never resolves twice.
          cleanup();
          if (stopping) { finish(null); return; }
          let resultEvent = null;
          for (const line of stdout.split('\n')) {
            try { const event = JSON.parse(line); if (event.type === 'result') resultEvent = event; } catch { /* Diagnostic line. */ }
          }
          finish({ code, resultEvent });
        });
        proc.once('error', abort); // Spawn error is followed by actual close.
        proc.stdin.on('error', abort);
        const decoder = new StringDecoder('utf8');
        proc.stdout.on('data', chunk => {
          if (stopping || settled) return;
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) { abort(); return; }
          stdout += decoder.write(chunk);
        });
        proc.stdout.once('end', () => { if (!stopping && !settled) stdout += decoder.end(); });
        proc.stderr.on('data', () => {});
        // Register only after all close/error handlers are installed. Observers
        // may synchronously abort or throw; either case still waits for close.
        registerProcess?.(proc, closed.promise);
        if (signal?.aborted) abort();
        if (!stopping) proc.stdin.end(prompt);
      } catch { if (proc) abort(); else finish(null); }
    }, () => finish(null));
  });
}
async function queryContext({ cwd, sessionId, ...boundary }) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const r = await runCli(['-p', '--output-format', 'stream-json', '--verbose', '--resume', sessionId], cwd, 15000, { ...boundary, prompt: '/context' });
  return parseContextOutput(r?.resultEvent?.result);
}
async function generateSessionTitle({ cwd, text, ...boundary }) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const snippet = text.slice(0, 400).replace(/\s+/g, ' ').trim();
  const prompt = ['为下面这个编程助手对话生成一个简短的会话标题。',
    '要求：只输出标题本身；不要引号、序号、代码块或结尾标点；',
    '与对话内容相同语言（中文对话用中文，英文用英文）；不超过 16 个字。', '', '对话主题：' + snippet].join('\n');
  const r = await runCli(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--tools', ''], cwd, 30000, { ...boundary, prompt });
  if (!r || r.resultEvent?.is_error || typeof r.resultEvent?.result !== 'string') return null;
  return r.resultEvent.result.trim().replace(/^["'“”「『《]+/, '').replace(/["'“”」』》.。!！?？\s]+$/, '').replace(/\s+/g, ' ').slice(0, 30).trim() || null;
}
async function compactSession({ cwd, sessionId, ...boundary }) {
  if (typeof sessionId !== 'string' || !sessionId) return { success: false, error: '无有效会话' };
  const r = await runCli(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--resume', sessionId], cwd, 300000, { ...boundary, prompt: '/compact' });
  const context = await queryContext({ cwd, sessionId, ...boundary });
  if (!r) return { success: false, error: '压缩超时或 CLI 启动失败', context };
  const ok = r.code === 0 && r.resultEvent?.subtype === 'success' && !r.resultEvent.is_error;
  return ok ? { success: true, context } : { success: false, error: r.resultEvent?.result || `压缩失败（exit ${r.code}）`, context };
}
module.exports = { ClaudeRunner, queryContext, compactSession, generateSessionTitle, escapeWindowsArg, runCli };
