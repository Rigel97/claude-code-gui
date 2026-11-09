const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const childProcess = require('node:child_process');

function ptyDiagnostic(error) {
  // Never return native loader messages: they can contain paths or environment secrets.
  if (/posix_spawnp|spawn-helper/i.test(String(error?.message))) return 'Native PTY spawn-helper failed; check helper executable permissions and native installation';
  return /NODE_MODULE_VERSION|ABI|dlopen|compiled against|architecture|\.node/i.test(String(error?.message))
    ? 'Native PTY ABI mismatch; rebuild node-pty for the current Electron/Node runtime'
    : 'Native PTY unavailable; check node-pty installation and native runtime';
}

function isolatedGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return false;
  try {
    // forkpty/posix_spawn creates a new session. Verify it before ever using a negative PID.
    const fields = childProcess.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,sess='],
      { encoding: 'utf8', timeout: 200, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).map(Number);
    // On macOS sess is a kernel session pointer, not a SID. PGID==PID proves a
    // dedicated group; this PID cannot be our own/parent group leader above.
    return fields.length === 3 && fields[0] === pid && fields[1] === pid;
  } catch { return false; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(['interactive', 'teams', 'remote', 'cloud', 'mcp', 'plugins', 'agents', 'auth', 'doctor', 'shell']);
const SHELL_MODES = new Set(['shell', 'mcp', 'plugins', 'agents']);
const SUGGESTED_COMMANDS = { mcp: 'claude mcp --help', plugins: 'claude plugin --help', agents: 'claude agents --help' };
const TITLES = { shell: 'Terminal', mcp: 'MCP management', plugins: 'Plugin management', agents: 'Agent management', auth: 'Claude authentication', doctor: 'Claude doctor' };
const SESSION_MODES = new Set(['interactive', 'teams', 'remote']);
const PERMISSIONS = new Set(['default', 'manual', 'auto', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']);
const SLASH = new Set(['/mcp', '/plugin', '/hooks', '/config', '/resume']);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`Invalid ${label}`);
}
function keys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported ${label} field`);
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('-')) throw new Error(`Invalid ${label}`);
}
function owner(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid terminal owner');
}
function dimensions(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) throw new Error('Invalid terminal dimensions (1..1000)');
}
function cloudSession(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid cloudSession');
  if (UUID.test(value)) return;
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid cloudSession: UUID or claude.ai/code URL required'); }
  if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.port || url.username || url.password || url.search || url.hash || !/^\/code\/(?:session_)?[a-zA-Z0-9_-]+$/.test(url.pathname)) throw new Error('Invalid cloudSession URL');
}
function validateSpec(spec) {
  object(spec, 'terminal spec');
  keys(spec, ['mode', 'cwd', 'sessionId', 'resume', 'options', 'initialCommand', 'title', 'cols', 'rows'], 'spec');
  if (!MODES.has(spec.mode)) throw new Error('Invalid terminal mode');
  text(spec.cwd, 32768, 'cwd');
  // create additionally checks the host filesystem; buildNativeArgs is pure.
  if (!path.isAbsolute(spec.cwd) && !path.win32.isAbsolute(spec.cwd)) throw new Error('cwd must be an absolute directory');
  if (spec.sessionId !== undefined && (!SESSION_MODES.has(spec.mode) || typeof spec.sessionId !== 'string' || !UUID.test(spec.sessionId))) throw new Error('Invalid sessionId');
  if (spec.resume !== undefined && typeof spec.resume !== 'boolean') throw new Error('Invalid resume: boolean required');
  if (spec.resume === true && (!SESSION_MODES.has(spec.mode) || !spec.sessionId)) throw new Error('resume requires an explicit sessionId in a session mode');
  if (spec.initialCommand !== undefined && (spec.mode !== 'interactive' || !SLASH.has(spec.initialCommand))) throw new Error('Invalid initialCommand');
  if (spec.title !== undefined) text(spec.title, 120, 'title');
  dimensions(spec.cols === undefined ? 80 : spec.cols, spec.rows === undefined ? 24 : spec.rows);
  const options = spec.options === undefined ? {} : spec.options;
  object(options, 'options');
  keys(options, ['model', 'permissionMode', 'chrome', 'ide', 'worktree', 'cloudSession'], 'options');
  if (!SESSION_MODES.has(spec.mode) && spec.mode !== 'cloud' && Object.keys(options).length) throw new Error('Options unavailable for subcommands');
  if (options.model !== undefined) text(options.model, 200, 'model');
  if (options.permissionMode !== undefined && !PERMISSIONS.has(options.permissionMode)) throw new Error('Invalid permissionMode');
  for (const key of ['chrome', 'ide']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  if (options.worktree !== undefined) text(options.worktree, 200, 'worktree');
  if (options.cloudSession !== undefined) {
    if (spec.mode !== 'cloud') throw new Error('cloudSession requires cloud mode');
    cloudSession(options.cloudSession);
  }
  if (spec.mode === 'cloud' && options.cloudSession === undefined) throw new Error('cloud mode requires an existing cloudSession; task descriptions are not accepted');
  return { ...spec, options: { ...options } };
}

function buildNativeArgs(input, platform = process.platform) {
  const spec = validateSpec(input);
  if (SHELL_MODES.has(spec.mode)) return platform === 'win32' ? ['/d', '/q'] : ['-l'];
  if (spec.mode === 'auth') return ['auth', 'login'];
  if (spec.mode === 'doctor') return ['doctor'];
  const args = [];
  if (spec.sessionId) args.push(spec.resume === true ? '--resume' : '--session-id', spec.sessionId);
  if (spec.mode === 'remote') args.push('--remote-control');
  if (spec.mode === 'cloud') args.push('--cloud', spec.options.cloudSession);
  const options = spec.options;
  if (options.model !== undefined) args.push('--model', options.model);
  if (options.permissionMode !== undefined && options.permissionMode !== 'default') args.push('--permission-mode', options.permissionMode);
  if (options.chrome !== undefined) args.push(options.chrome ? '--chrome' : '--no-chrome');
  // This CLI has no --no-ide flag: false means do not request automatic attachment.
  if (options.ide === true) args.push('--ide');
  if (options.worktree !== undefined) args.push('--worktree', options.worktree);
  // initialCommand is intent only. The UI must initiate write after TUI readiness.
  return args;
}

class NativeTerminalManager {
  constructor({ ptyFactory, getRuntime, acquireSession, sendEvent = () => {}, platform = process.platform } = {}) {
    this.ptyFactory = ptyFactory;
    this.getRuntime = getRuntime;
    this.acquireSession = acquireSession;
    this.sendEvent = sendEvent;
    this.platform = platform;
    this.terminals = new Map();
    this.sessions = new Set();
    this.events = [];
    this.publishing = false;
    this.pending = new Set();
    this.disposed = false;
    this._health = { ptyAvailable: null, diagnostic: 'PTY not loaded' };
    this.creationAbort = new AbortController();
  }

  get health() { return { ...this._health }; }

  async _awaitCreation(promise) {
    const signal = this.creationAbort.signal;
    let cancel;
    const cancelled = new Promise((resolve, reject) => {
      cancel = () => reject(new Error('Terminal manager disposed; creation cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try {
      const value = await Promise.race([promise, cancelled]);
      if (this.disposed) throw new Error('Terminal manager disposed');
      return value;
    } finally { signal.removeEventListener('abort', cancel); }
  }

  async _loadPty() {
    try {
      const factory = typeof this.ptyFactory === 'function' ? await this.ptyFactory()
        : this.ptyFactory || require('node-pty');
      const pty = factory?.default || factory;
      if (typeof pty?.spawn !== 'function') throw new Error('PTY factory must expose spawn');
      this._health = { ptyAvailable: true, diagnostic: null };
      return pty;
    } catch (error) {
      this._health = { ptyAvailable: false, diagnostic: ptyDiagnostic(error) };
      throw new Error(this._health.diagnostic);
    }
  }

  async create(input, ownerWebContentsId) {
    owner(ownerWebContentsId);
    const spec = validateSpec(input);
    if (this.disposed) throw new Error('Terminal manager disposed');
    if (this.terminals.size + this.pending.size >= 32) throw new Error('Terminal limit: 32 retained terminals');
    const live = [...this.terminals.values()].filter(record => record.term.status !== 'exited').length;
    if (live + this.pending.size >= 8) throw new Error('Terminal limit: 8 running terminals');
    const sessionId = SESSION_MODES.has(spec.mode) ? (spec.sessionId || randomUUID()).toLowerCase() : undefined;
    const term = { id: randomUUID(), title: spec.title || TITLES[spec.mode] || 'Claude Code', mode: spec.mode, cwd: spec.cwd,
      ...(SUGGESTED_COMMANDS[spec.mode] ? { suggestedCommand: SUGGESTED_COMMANDS[spec.mode] } : {}),
      ...(spec.initialCommand !== undefined ? { initialCommand: spec.initialCommand } : {}), ...(sessionId ? { sessionId, resume: spec.resume === true } : {}), status: 'running', seq: 0 };
    const record = { term, owner: ownerWebContentsId, ring: null, start: 0, bytes: 0, truncated: false, subscriptions: [] };
    let finish;
    record.finished = new Promise(resolve => { finish = resolve; });
    this.pending.add(record);
    try {
      if (!path.isAbsolute(spec.cwd) || !(await this._awaitCreation(fs.promises.stat(spec.cwd))).isDirectory()) throw new Error('cwd must be an existing absolute directory');
      if (sessionId) {
        if (this.sessions.has(sessionId)) throw new Error('Terminal session busy');
        this.sessions.add(sessionId);
        record.locked = true;
      }
      if (sessionId) {
        if (typeof this.acquireSession !== 'function') throw new Error('acquireSession boundary is required');
        record.release = this.acquireSession(sessionId, { kind: 'native-terminal', id: term.id, ownerWebContentsId });
        if (typeof record.release !== 'function') throw new Error('acquireSession must return a release function');
      }
      if (typeof this.getRuntime !== 'function') throw new Error('getRuntime boundary is required');
      let runtime;
      try { runtime = await this._awaitCreation(this.getRuntime()); }
      catch (error) { if (this.disposed) throw error; throw new Error('Claude runtime resolution failed'); }
      object(runtime, 'runtime');
      let executable = runtime.executable;
      if (SHELL_MODES.has(spec.mode)) {
        executable = runtime.shellExecutable !== undefined ? runtime.shellExecutable
          : this.platform === 'win32' ? process.env.COMSPEC : process.env.SHELL;
        text(executable, 32768, 'shell executable');
        if (!path.isAbsolute(executable)) throw new Error('shell executable must be an existing absolute file');
        let stat;
        try { stat = await this._awaitCreation(fs.promises.stat(executable)); }
        catch { throw new Error(this.disposed ? 'Terminal manager disposed' : 'shell executable must be an existing absolute file'); }
        if (!stat.isFile()) throw new Error('shell executable must be an existing absolute file');
      } else text(executable, 32768, 'runtime executable');
      object(runtime.env, 'runtime env');
      for (const [key, value] of Object.entries(runtime.env)) {
        if (!key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid runtime env');
      }
      const factory = await this._awaitCreation(this._loadPty());
      const env = { ...runtime.env };
      delete env.FORCE_COLOR;
      if (spec.mode === 'teams') env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      try {
        record.pty = factory.spawn(executable, buildNativeArgs({ ...spec, ...(sessionId ? { sessionId } : {}) }, this.platform), {
          cwd: spec.cwd, env, name: 'xterm-256color', cols: spec.cols ?? 80, rows: spec.rows ?? 24,
        });
      } catch (error) {
        const diagnostic = ptyDiagnostic(error);
        const nativeFailure = /ABI|spawn-helper/.test(diagnostic);
        if (nativeFailure) this._health = { ptyAvailable: false, diagnostic };
        throw new Error(nativeFailure ? diagnostic : 'Native terminal spawn failed; check executable and cwd');
      }
      this.terminals.set(term.id, record);
      this._subscribe(record, () => record.pty.onExit(event => this._exit(record, event)));
      if (term.status !== 'exited') this._subscribe(record, () => record.pty.onData(data => this._data(record, data)));
      return { ...term };
    } catch (error) {
      if (!record.pty) this._release(record);
      else if (record.term.status !== 'exited') {
        // A listener/setup failure must not unlock a process that may still be alive.
        this._closeRecord(record).catch(() => {});
      }
      throw error;
    } finally { this.pending.delete(record); finish(); }
  }

  _subscribe(record, subscribe) {
    const subscription = subscribe();
    if (record.term.status === 'exited') subscription?.dispose();
    else record.subscriptions.push(subscription);
  }

  _release(record) {
    if (record.locked) { this.sessions.delete(record.term.sessionId); record.locked = false; }
    const release = record.release;
    record.release = undefined;
    if (release) {
      try { release(); } catch { record.term.releaseFailed = true; }
    }
  }

  _publish(channel, record, payload) {
    this.events.push({ channel, payload: { id: record.term.id, ownerWebContentsId: record.owner, ...payload } });
    if (this.publishing) return;
    this.publishing = true;
    try {
      while (this.events.length) {
        const event = this.events.shift();
        try { Promise.resolve(this.sendEvent(event.channel, event.payload)).catch(() => {}); } catch { /* detached renderer */ }
      }
    } finally { this.publishing = false; }
  }

  _data(record, data) {
    if (record.term.status === 'exited' || typeof data !== 'string') return;
    const chunk = Buffer.from(data, 'utf8');
    const limit = 4 * 1024 * 1024;
    // A fixed byte ring also bounds allocation for millions of one-byte/empty chunks.
    if (chunk.length) {
      if (!record.ring) record.ring = Buffer.allocUnsafe(limit);
      if (chunk.length >= limit) {
        let offset = chunk.length - limit;
        while (offset < chunk.length && (chunk[offset] & 0xc0) === 0x80) offset++;
        if (record.bytes + chunk.length > limit) record.truncated = true;
        record.start = 0;
        record.bytes = chunk.length - offset;
        chunk.copy(record.ring, 0, offset);
      } else {
        const overflow = Math.max(0, record.bytes + chunk.length - limit);
        if (overflow) {
          record.truncated = true;
          record.start = (record.start + overflow) % limit;
          record.bytes -= overflow;
          while (record.bytes && (record.ring[record.start] & 0xc0) === 0x80) {
            record.start = (record.start + 1) % limit;
            record.bytes--;
          }
        }
        const end = (record.start + record.bytes) % limit;
        const first = Math.min(chunk.length, limit - end);
        chunk.copy(record.ring, end, 0, first);
        if (first < chunk.length) chunk.copy(record.ring, 0, first);
        record.bytes += chunk.length;
      }
    }
    record.term.seq++;
    this._publish('native-terminal:data', record, { data, seq: record.term.seq, truncated: record.truncated });
  }

  _exit(record, { exitCode, signal } = {}) {
    if (record.term.status === 'exited') return;
    record.term.status = 'exited';
    record.term.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    if (Number.isInteger(signal)) record.term.signal = signal;
    clearTimeout(record.killTimer);
    clearTimeout(record.closeTimer);
    for (const subscription of record.subscriptions) { try { subscription?.dispose(); } catch { /* adapter cleanup */ } }
    this._release(record);
    record.resolveClose?.({ ...record.term });
    this._publish('native-terminal:exit', record, { ...record.term, truncated: record.truncated });
    if (record.removeOnExit) this._forget(record);
  }

  _forget(record) {
    if (record.term.status !== 'exited') return;
    if (this.terminals.get(record.term.id) === record) this.terminals.delete(record.term.id);
    // Explicit close ends in-memory history as well as releasing the retained slot.
    record.ring = null;
    record.bytes = 0;
    record.subscriptions.length = 0;
  }

  _owned(id, ownerId, running = false) {
    owner(ownerId);
    const record = this.terminals.get(id);
    if (!record || record.owner !== ownerId) throw new Error('Terminal owner mismatch or unknown terminal');
    if (running && record.term.status !== 'running') throw new Error('Terminal is not running');
    return record;
  }

  list(ownerId) {
    owner(ownerId);
    return [...this.terminals.values()].filter(record => record.owner === ownerId).map(record => ({ ...record.term }));
  }

  attach(id, ownerId) {
    const record = this._owned(id, ownerId);
    // No await: buffer and sequence are one synchronous cut. UI ignores events <= lastSeq.
    let snapshot = '';
    if (record.bytes) {
      const end = Math.min(record.ring.length, record.start + record.bytes);
      const first = record.ring.subarray(record.start, end);
      snapshot = (first.length === record.bytes ? first : Buffer.concat([first, record.ring.subarray(0, record.bytes - first.length)])).toString('utf8');
    }
    return { snapshot, lastSeq: record.term.seq,
      status: record.term.status, ...(record.term.exitCode !== undefined ? { exitCode: record.term.exitCode } : {}),
      ...(record.term.signal !== undefined ? { signal: record.term.signal } : {}), truncated: record.truncated };
  }

  write(id, data, ownerId) {
    const record = this._owned(id, ownerId, true);
    if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 * 1024) throw new Error('Invalid terminal input (maximum 1 MiB)');
    record.pty.write(data);
  }

  resize(id, cols, rows, ownerId) {
    const record = this._owned(id, ownerId, true);
    dimensions(cols, rows);
    record.pty.resize(cols, rows);
  }

  _signal(record, signal) {
    if (record.term.status === 'exited') return;
    if (this.platform === 'win32') {
      // node-pty's Windows kill closes ConPTY and its process tree; POSIX signals do not apply.
      try { record.pty.kill(); } catch { record.term.killFailed = true; }
      return;
    }
    const pid = record.pty.pid;
    if (isolatedGroup(pid)) {
      try { process.kill(-pid, signal); return; } catch { /* group already gone; use PTY adapter */ }
    }
    // Do not even invoke a broken adapter if it advertises the application's own PID.
    if (pid === process.pid || pid === process.ppid || !Number.isSafeInteger(pid) || pid <= 1) {
      record.term.killFailed = true; return;
    }
    try { record.pty.kill(signal); } catch { record.term.killFailed = true; }
  }

  _closeRecord(record) {
    if (record.term.status === 'exited') return Promise.resolve({ ...record.term });
    if (record.closePromise) return record.closePromise;
    record.term.status = 'closing';
    record.closePromise = new Promise((resolve, reject) => {
      record.resolveClose = resolve;
      record.killTimer = setTimeout(() => this._signal(record, 'SIGKILL'), 2000);
      record.closeTimer = setTimeout(() => {
        record.closePromise = undefined;
        record.resolveClose = undefined;
        reject(new Error('Terminal close timeout: no actual exit after 5 seconds; session remains locked'));
      }, 5000);
    });
    // Install timers and resolver first: kill may synchronously cause an exit callback.
    const closing = record.closePromise;
    this._signal(record, 'SIGTERM');
    return closing;
  }

  async close(id, ownerId) {
    const record = this._owned(id, ownerId);
    record.removeOnExit = true;
    const result = await this._closeRecord(record);
    this._forget(record);
    return result;
  }

  async disposeAll() {
    this.disposed = true;
    this.creationAbort.abort();
    await Promise.all([...this.pending].map(record => record.finished));
    const results = await Promise.allSettled([...this.terminals.values()].map(record => this._closeRecord(record)));
    if (results.some(result => result.status === 'rejected')) throw new Error('Terminal dispose timeout: one or more processes have no actual exit; locks retained');
    this.terminals.clear();
    this.events.length = 0;
  }
}

module.exports = { NativeTerminalManager, buildNativeArgs };
