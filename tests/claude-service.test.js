import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const services = [];
const directories = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.disposeAll())); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(boundaries = {}) {
  const engines = [];
  const events = [];
  const { SessionOwnership } = require('../src/main/session-ownership');
  const { ClaudeService } = require('../src/main/claude-service');
  const ownership = new SessionOwnership();
  const service = new ClaudeService({ runtime: { resolve: async () => ({ executable: '/mock/claude', env: {} }), get: () => ({ versionFingerprint: 'v1' }) },
    ownership, history: {}, terminalManager: { list: () => [], disposeAll: async () => {}, acquireSession: (id, owner) => ownership.acquire(id, owner) },
    sendEvent: (owner, channel, data) => events.push({ owner, channel, data }),
    createRunner: (cid, deps) => {
      let state = { conversationId: cid, state: 'closed', busy: false, sessionId: null, runId: null, pendingApprovals: [], pendingUserMessageIds: [] };
      let release;
      const engine = {
        getState: () => structuredClone(state), isBusy: () => state.busy, isIdle: () => state.state === 'closed',
        start: vi.fn(async config => { await deps.getRuntime(); const sid = config.sessionId || state.sessionId || randomUUID(); if (!release) release = deps.acquireSession(sid, { conversationId: cid, ownerWebContentsId: deps.ownerWebContentsId });
          state = { ...state, state: 'ready', sessionId: sid, runId: randomUUID() }; return { success: true, sessionId: state.sessionId, runId: state.runId }; }),
        send: vi.fn(async payload => { state.busy = true; state.state = 'busy'; deps.emitStream({ type: 'user', conversationId: cid, runId: state.runId }); return { success: true, userMessageId: payload.userMessageId }; }),
        close: vi.fn(async () => { release?.(); release = null; state = { ...state, state: 'closed', busy: false, runId: null, sessionId: null }; return { success: true }; }),
        interrupt: vi.fn(async () => ({ success: true })),
        setPermissionMode: vi.fn(async mode => ({ success: true, permissionMode: mode })),
        respond: vi.fn(async () => ({ success: true })),
        setState: patch => Object.assign(state, patch),
        emitStream: deps.emitStream, emitStatus: deps.emitStatus,
      };
      engines.push(engine); return engine;
    }, ...boundaries });
  services.push(service);
  return { service, engines, events, ownership };
}
describe('ClaudeService owner and persistent lifecycle public boundary', () => {
  it.each(['compact', 'getContext'])('%s tracks exact runner callbacks and retains every lease through late actual close', async method => {
    const first = deferred(); const second = deferred(); const began = deferred(); const failed = deferred();
    const proc1 = { pid: 101 }; const proc2 = { pid: 102 }; let callbacks;
    const boundary = async options => {
      callbacks = options;
      options.registerProcess(proc1, first.promise);
      options.registerProcess(proc2, second.promise);
      began.resolve(); await failed.promise;
      const error = new Error('shutdown timeout');
      Object.assign(error, { code: 'PROCESS_CLOSE_TIMEOUT', process: proc2, closed: second.promise, terminated: false });
      throw error;
    };
    const f = fixture({ compactSession: boundary, queryContext: boundary }); const sid = randomUUID();
    const operation = f.service[method]({ conversationId: 'exact-callbacks', cwd: tmpdir(), sessionId: sid }, 7);
    await began.promise;
    try {
      expect(callbacks.onClosed).toBeTypeOf('function');
      callbacks.onClosed(proc1, { code: 0, signal: null }); first.resolve({ code: 0, signal: null });
      failed.resolve(); expect(await operation).toMatchObject({ success: false });
      expect(f.ownership.owner(sid)).toBeTruthy();
      await expect(f.service.disposeOwner(7)).rejects.toThrow(/cleanup|exit/i);
      expect(callbacks.signal.aborted).toBe(true);
      expect(f.events.some(event => event.data.status === 'error')).toBe(false);
      callbacks.onClosed(proc2, { code: null, signal: 'SIGKILL' });
    } finally { failed.resolve(); first.resolve(); second.resolve({ code: null, signal: 'SIGKILL' }); await operation; }
    await f.service.disposeOwner(7); expect(f.ownership.owner(sid)).toBeUndefined();
  });
  it('actual runner runCli cancellation reports both precise close observers before releasing the service lease', async () => {
    const { runCli } = require('../src/main/runner'); const began = deferred(); const observed = []; let signal;
    const f = fixture({ compactSession: async boundary => {
      signal = boundary.signal;
      const result = await runCli(['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),40)); process.stdout.write('ready'); setInterval(()=>{},1000)"], tmpdir(), 30000, {
        ...boundary, getRuntime: async () => ({ executable: process.execPath, env: process.env }),
        registerProcess: (proc, closedPromise) => {
          boundary.registerProcess(proc, closedPromise);
          proc.stdout.once('data', () => began.resolve());
          closedPromise.then(exit => observed.push({ proc, exit }));
        },
        onClosed: (proc, exit) => { observed.push({ proc, exit }); boundary.onClosed(proc, exit); },
      });
      expect(result).toBeNull(); return { success: false };
    } });
    const sid = randomUUID(); const operation = f.service.compact({ conversationId: 'real-runcli', cwd: tmpdir(), sessionId: sid }, 7);
    await began.promise; const disposal = f.service.disposeOwner(7);
    expect(signal.aborted).toBe(true); expect(f.ownership.owner(sid)).toBeTruthy();
    await disposal; await operation;
    expect(observed).toHaveLength(2);
    expect(observed[0].proc).toBe(observed[1].proc);
    expect(observed[0].exit).toEqual({ code: 0, signal: null });
    expect(observed[1].exit).toEqual(observed[0].exit);
    expect(f.ownership.owner(sid)).toBeUndefined();
  });
  it('null auxiliary result cannot bypass all registered close fences or grow a cleanup pool on retry', async () => {
    const began = deferred(); const closes = [deferred(), deferred()]; let signal;
    const compactSession = vi.fn(async boundary => {
      signal = boundary.signal;
      closes.forEach((close, index) => boundary.registerProcess({ pid: 201 + index }, close.promise));
      began.resolve(); return null;
    });
    const f = fixture({ compactSession }); const sid = randomUUID();
    const operation = f.service.compact({ conversationId: 'null-fences', cwd: tmpdir(), sessionId: sid }, 7);
    await began.promise; vi.useFakeTimers();
    try {
      const cleanup = f.service.disposeOwner(7).catch(() => 'failed');
      await vi.advanceTimersByTimeAsync(8000); expect(await cleanup).toBe('failed');
      expect(signal.aborted).toBe(true); expect(f.ownership.owner(sid)).toBeTruthy();
      const retry = f.service.disposeOwner(7).catch(() => 'failed');
      closes[0].resolve({ code: 0, signal: null });
      await vi.advanceTimersByTimeAsync(8000); expect(await retry).toBe('failed');
      expect(f.ownership.owner(sid)).toBeTruthy(); expect(compactSession).toHaveBeenCalledTimes(1);
    } finally { closes.forEach(close => close.resolve({ code: 0, signal: null })); vi.useRealTimers(); }
    await f.service.disposeOwner(7); expect(await operation).toMatchObject({ success: false });
    expect(f.ownership.owner(sid)).toBeUndefined();
  });
  it.each(['disposeOwner', 'disposeAll'])('%s has a finite default cleanup deadline and can retry after actual SDK close', async method => {
    const f = fixture(); const request = { conversationId: 'bounded-close', cwd: tmpdir() };
    await f.service.start(request, 7); const sid = f.engines[0].getState().sessionId;
    const gate = deferred(); const close = f.engines[0].close;
    f.engines[0].close = vi.fn(async () => { await gate.promise; return close(); });
    vi.useFakeTimers();
    try {
      const cleanup = method === 'disposeOwner' ? f.service.disposeOwner(7) : f.service.disposeAll();
      const result = cleanup.then(() => 'success', () => 'failed');
      await vi.advanceTimersByTimeAsync(10000);
      expect(await Promise.race([result, Promise.resolve('hung')])).toBe('failed');
      expect(f.ownership.owner(sid)).toBeTruthy();
    } finally { gate.resolve(); vi.useRealTimers(); }
    if (method === 'disposeOwner') await f.service.disposeOwner(7); else await f.service.disposeAll();
    expect(f.ownership.owner(sid)).toBeUndefined();
  });
  it('CID-less context selects the actual live SID writer instead of an older closed memo record', async () => {
    const f = fixture(); const sid = randomUUID(); const request = { cwd: tmpdir(), sessionId: sid };
    await f.service.start({ ...request, conversationId: 'old-source' }, 7); await f.service.close('old-source', 7);
    await f.service.start({ ...request, conversationId: 'live-source' }, 7);
    f.engines[1].getContextUsage = vi.fn(async () => ({ success: true, totalTokens: 71, maxTokens: 200000 }));
    expect(await f.service.getContext(request, 7)).toMatchObject({ used: 71 });
    expect(f.engines[1].close).not.toHaveBeenCalled();
    const actual = randomUUID(); f.engines[1].setState({ sessionId: actual });
    expect(await f.service.getContext({ cwd: tmpdir(), sessionId: actual }, 8)).toMatchObject({ success: false, error: expect.stringMatching(/owner/i) });
  });
  it('transfers an SDK lease to the actual native manager and releases it only on the PTY exit event', async () => {
    const { SessionOwnership } = require('../src/main/session-ownership'); const { NativeTerminalManager } = require('../src/main/native-terminal');
    const ownership = new SessionOwnership(); let exited;
    const pty = { pid: 2147483057, onExit: callback => { exited = callback; return { dispose() {} }; }, onData: () => ({ dispose() {} }), kill: () => exited({ exitCode: 0 }), write() {}, resize() {} };
    const manager = new NativeTerminalManager({ acquireSession: (id, owner) => ownership.acquire(id, owner), getRuntime: async () => ({ executable: process.execPath, env: {} }), ptyFactory: { spawn: () => pty } });
    const f = fixture({ ownership, terminalManager: manager }); const sid = randomUUID();
    await f.service.start({ conversationId: 'native-real-manager', cwd: tmpdir(), sessionId: sid }, 7);
    const term = await f.service.nativeCreate({ mode: 'interactive', cwd: tmpdir(), sessionId: sid, resume: true }, 7);
    expect(ownership.owner(sid)).toMatchObject({ kind: 'native-terminal', id: term.id, ownerWebContentsId: 7 });
    expect(f.engines[0].close).toHaveBeenCalledTimes(1);
    exited({ exitCode: 0 });
    expect(ownership.owner(sid)).toBeUndefined();
    expect(manager.list(7)[0].status).toBe('exited');
  });
  it('owner disposal cancels a bootstrap with stalled runtime without waiting globally or reopening late', async () => {
    const { ClaudeRunner } = require('../src/main/runner'); const gate = deferred(); const began = deferred();
    const runtime = { resolve: async () => { began.resolve(); await gate.promise; return { executable: process.execPath, env: {} }; }, get: () => ({ versionFingerprint: 'v1' }) };
    const f = fixture({ runtime, createRunner: (cid, deps) => new ClaudeRunner(cid, { ...deps, loadSdk: async () => { throw new Error('SDK must never load after cancelled bootstrap'); } }) });
    const boot = f.service.start({ conversationId: 'runtime-stall', cwd: tmpdir() }, 7); await began.promise;
    const disposal = f.service.disposeOwner(7); const result = disposal.then(() => 'disposed', () => 'failed');
    try { expect(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('hung'), 80))])).toBe('disposed'); }
    finally { gate.resolve(); await disposal.catch(() => {}); }
    expect(await boot).toMatchObject({ success: false });
    expect(await f.service.start({ conversationId: 'runtime-stall', cwd: tmpdir() }, 7)).toMatchObject({ success: false, error: 'Owner disposed' });
  });
  it('owner disposal cancels a session operation stalled at runtime-root validation before any CLI starts', async () => {
    const began = deferred(); const gate = deferred(); let stall = false;
    const runtime = { resolve: async () => { if (stall) { began.resolve(); await gate.promise; } return { executable: process.execPath, env: {} }; }, get: () => ({ versionFingerprint: 'v1' }) };
    const compactSession = vi.fn(async () => ({ success: true })); const f = fixture({ runtime, compactSession }); const sid = randomUUID();
    const request = { conversationId: 'root-validation-stall', cwd: tmpdir(), sessionId: sid }; await f.service.start(request, 7);
    stall = true; const operation = f.service.compact(request, 7); await began.promise;
    const disposal = f.service.disposeOwner(7);
    try { expect(await Promise.race([disposal.then(() => 'disposed'), new Promise(resolve => setTimeout(() => resolve('hung'), 80))])).toBe('disposed'); }
    finally { gate.resolve(); await disposal.catch(() => {}); }
    expect(await operation).toMatchObject({ success: false }); expect(compactSession).not.toHaveBeenCalled();
  });
  it('cold send uses the SID adopted during bootstrap, not the pre-bootstrap config', async () => {
    const f = fixture();
    const result = await f.service.send({ conversationId: 'adopted', cwd: tmpdir(), prompt: 'first' }, 7);
    expect(result.success).toBe(true);
    expect(f.engines[0].send.mock.calls[0][0].sessionId).toBe(result.runtimeState.sessionId);
    expect(result.runtimeState.sessionId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('persists SDK mode changes across reused UI config while honoring changed or explicit intent', async () => {
    const f = fixture(); const request = { conversationId: 'mode-sync', cwd: tmpdir(), options: { permissionMode: 'plan', model: 'original' } };
    await f.service.start(request, 7);
    f.engines[0].setState({ info: { permissionMode: 'default' } });
    await f.service.runtimeState('mode-sync', 7);
    await f.service.start(request, 7);
    expect(f.engines[0].start.mock.calls.at(-1)[0].options.permissionMode).toBe('default');
    await f.service.start({ ...request, options: { permissionMode: 'acceptEdits' } }, 7);
    expect(f.engines[0].start.mock.calls.at(-1)[0].options.permissionMode).toBe('acceptEdits');
    await f.service.start({ ...request, permissionModeExplicit: true }, 7);
    expect(f.engines[0].start.mock.calls.at(-1)[0].options.permissionMode).toBe('plan');
    f.engines[0].setState({ info: { permissionMode: 'dontAsk' } });
    await f.service.close('mode-sync', 7);
    await f.service.send({ conversationId: 'mode-sync', prompt: 'resume' }, 7);
    expect(f.engines.at(-1).start.mock.calls[0][0].options.permissionMode).toBe('dontAsk');
  });
  it('status metadata remembers actual SID and mode before safe close; explicit next intent still wins', async () => {
    const f = fixture(); const request = { conversationId: 'status-adoption', cwd: tmpdir(), options: { permissionMode: 'plan' } };
    await f.service.start(request, 7); const actual = randomUUID(); const engine = f.engines[0];
    engine.setState({ sessionId: actual, info: { permissionMode: 'dontAsk' } });
    engine.emitStatus({ status: 'ready' });
    expect(f.events.at(-1).data).toMatchObject({ state: 'ready', sessionId: actual, info: { permissionMode: 'dontAsk' } });
    const began = deferred(); const gate = deferred(); const close = engine.close;
    engine.close = vi.fn(async () => { began.resolve(); await gate.promise; return close(); });
    const closing = f.service.close(request.conversationId, 7); await began.promise;
    try { expect(await f.service.runtimeState(request.conversationId, 7)).toMatchObject({ state: 'ready', sessionId: actual }); }
    finally { gate.resolve(); await closing; }
    await f.service.start(request, 7);
    expect(f.engines[1].start.mock.calls[0][0]).toMatchObject({ sessionId: actual, options: { permissionMode: 'dontAsk' } });
    await f.service.close(request.conversationId, 7);
    await f.service.start({ ...request, permissionModeExplicit: true }, 7);
    expect(f.engines[2].start.mock.calls[0][0]).toMatchObject({ sessionId: actual, options: { permissionMode: 'plan' } });
  });
  it('invalid start intent never mutates remembered config and explicit mode intent must be boolean', async () => {
    const f = fixture(); const request = { conversationId: 'valid-config', cwd: tmpdir(), options: { model: 'original' } };
    await f.service.start(request, 7);
    expect(await f.service.start({ conversationId: request.conversationId, cwd: '/must-not-be-adopted', options: null }, 7)).toMatchObject({ success: false });
    expect(await f.service.start({ conversationId: request.conversationId, options: { permissionMode: 'plan' }, permissionModeExplicit: 'yes' }, 7)).toMatchObject({ success: false });
    await f.service.close(request.conversationId, 7);
    await f.service.send({ conversationId: request.conversationId, prompt: 'resume original' }, 7);
    expect(f.engines.at(-1).start.mock.calls[0][0]).toMatchObject({ cwd: tmpdir(), options: { model: 'original', permissionMode: 'default' } });
  });
  it('publishes changed runtime once before metadata stream, never copies state per token', async () => {
    const f = fixture(); await f.service.start({ conversationId: 'stream', cwd: tmpdir() }, 7);
    const engine = f.engines[0]; f.events.length = 0;
    const getState = vi.spyOn(engine, 'getState');
    for (let i = 0; i < 100; i++) engine.emitStream({ type: 'stream_event', conversationId: 'stream', event: { type: 'content_block_delta' } });
    expect(getState).not.toHaveBeenCalled();
    expect(f.events.filter(e => e.channel === 'claude:runtime')).toHaveLength(0);
    engine.setState({ info: { permissionMode: 'plan' }, commands: [{ name: 'new', description: 'metadata' }] });
    engine.emitStream({ type: 'system', subtype: 'init' });
    expect(f.events.slice(-2).map(e => e.channel)).toEqual(['claude:runtime', 'claude:stream']);
    engine.emitStatus({ status: 'ready' });
    expect(f.events.filter(e => e.channel === 'claude:runtime')).toHaveLength(1);
    const nextRun = randomUUID(); engine.setState({ runId: nextRun });
    engine.emitStream({ type: 'stream_event', runId: nextRun });
    expect(f.events.slice(-2).map(e => e.channel)).toEqual(['claude:runtime', 'claude:stream']);
    engine.setState({ busy: true, pendingUserMessageIds: [randomUUID()] });
    engine.emitStream({ type: 'user' });
    engine.setState({ busy: false, pendingUserMessageIds: [] });
    engine.emitStream({ type: 'result' });
    expect(f.events.at(-2).data).toMatchObject({ busy: false, pendingUserMessageIds: [] });
  });
  it('rewind validates real user checkpoint, one-time token and literal disk hashes, never writes stale user data', async () => {
    const f = fixture(); const cwd = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'rewind-service-'))); directories.push(cwd);
    const sid = randomUUID(); const messageId = randomUUID(); const file = path.join(cwd, 'project.txt');
    fs.writeFileSync(file, 'user changes');
    const request = { conversationId: 'rewind', cwd, sessionId: sid, messageId };
    await f.service.start(request, 7);
    const engine = f.engines[0];
    f.service.history.readRaw = async () => JSON.stringify({ type: 'user', uuid: messageId, sessionId: sid, parentUuid: null, message: { role: 'user', content: 'checkpoint' } });
    f.service.history.read = async () => ({ cwd, sessionId: sid, messages: [{ uuid: messageId }], nextOffset: null });
    engine.rewindFiles = vi.fn(async (_id, { dryRun }) => {
      if (!dryRun) fs.writeFileSync(file, 'checkpoint restored');
      return { success: true, canRewind: true, filesChanged: ['project.txt'], insertions: 1, deletions: 2, skippedLinks: 1 };
    });
    expect(await f.service.rewind({ ...request, messageId: randomUUID(), dryRun: true }, 7)).toMatchObject({ success: false });
    expect(engine.rewindFiles).not.toHaveBeenCalled();
    const preview = await f.service.rewind({ ...request, dryRun: true }, 7);
    expect(preview).toMatchObject({ success: true, confirmationToken: expect.any(String) });
    expect(fs.readFileSync(file, 'utf8')).toBe('user changes');
    fs.writeFileSync(file, 'external edit');
    expect(await f.service.rewind({ ...request, dryRun: false, confirmationToken: preview.confirmationToken }, 7)).toMatchObject({ success: false, error: expect.stringContaining('files changed') });
    expect(fs.readFileSync(file, 'utf8')).toBe('external edit');
    const fresh = await f.service.rewind({ ...request, dryRun: true }, 7);
    const applied = await f.service.rewind({ ...request, dryRun: false, confirmationToken: fresh.confirmationToken }, 7);
    expect(applied).toMatchObject({ success: true, warning: expect.stringContaining('Links skipped') });
    expect(fs.readFileSync(file, 'utf8')).toBe('checkpoint restored');
    expect(await f.service.rewind({ ...request, dryRun: false, confirmationToken: fresh.confirmationToken }, 7)).toMatchObject({ success: false, error: expect.stringContaining('token') });
    expect(engine.rewindFiles.mock.calls.filter(([, opts]) => !opts.dryRun)).toHaveLength(1);
  });
  it('rewind refuses outside paths, symlinks, missing file list, expired and cross-run tokens', async () => {
    const f = fixture(); const cwd = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'rewind-safe-'))); directories.push(cwd);
    const sid = randomUUID(); const messageId = randomUUID(); const request = { conversationId: 'safe', cwd, sessionId: sid, messageId };
    await f.service.start(request, 7); const engine = f.engines[0];
    f.service.history.readRaw = async () => JSON.stringify({ type: 'user', uuid: messageId, sessionId: sid, parentUuid: null, message: { role: 'user', content: 'text' } });
    f.service.history.read = async () => ({ cwd, sessionId: sid, messages: [{ uuid: messageId }], nextOffset: null });
    engine.rewindFiles = vi.fn(async () => ({ success: true, canRewind: true, filesChanged: ['../outside.txt'] }));
    expect(await f.service.rewind({ ...request, dryRun: true }, 7)).toMatchObject({ success: false, error: expect.stringContaining('outside') });
    fs.writeFileSync(path.join(cwd, 'real.txt'), 'literal'); fs.symlinkSync('real.txt', path.join(cwd, 'link.txt'));
    engine.rewindFiles.mockResolvedValue({ success: true, canRewind: true, filesChanged: ['link.txt'] });
    expect(await f.service.rewind({ ...request, dryRun: true }, 7)).toMatchObject({ success: false });
    engine.rewindFiles.mockResolvedValue({ success: true, canRewind: true });
    expect(await f.service.rewind({ ...request, dryRun: true }, 7)).toMatchObject({ success: false, error: expect.stringContaining('filesChanged') });
    engine.rewindFiles.mockResolvedValue({ success: true, canRewind: true, filesChanged: ['real.txt'] });
    const preview = await f.service.rewind({ ...request, dryRun: true }, 7);
    engine.setState({ runId: randomUUID() });
    expect(await f.service.rewind({ ...request, dryRun: false, confirmationToken: preview.confirmationToken }, 7)).toMatchObject({ success: false, error: expect.stringContaining('stale') });
    const fresh = await f.service.rewind({ ...request, dryRun: true }, 7);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
    expect(await f.service.rewind({ ...request, dryRun: false, confirmationToken: fresh.confirmationToken }, 7)).toMatchObject({ success: false, error: expect.stringContaining('stale') });
    clock.mockRestore();
    expect(fs.readFileSync(path.join(cwd, 'real.txt'), 'utf8')).toBe('literal');
    expect(engine.rewindFiles.mock.calls.every(([, opts]) => opts.dryRun)).toBe(true);
  });
  it('binds Unicode CID to sender, returns snapshots without bootstrap, rejects foreign sender', async () => {
    const f = fixture();
    expect(await f.service.runtimeState('中文标签', 7)).toBeNull();
    expect(f.engines).toHaveLength(0);
    const boot = await f.service.start({ conversationId: '中文标签', cwd: tmpdir() }, 7);
    expect(boot).toMatchObject({ success: true, runtimeState: { state: 'ready', busy: false } });
    expect(await f.service.send({ conversationId: '中文标签', ownerWebContentsId: 7, prompt: 'foreign' }, 8)).toMatchObject({ success: false, error: expect.stringMatching(/owner/i) });
    expect(f.engines[0].send).not.toHaveBeenCalled();
    expect(await f.service.start({ conversationId: 'bad\n', cwd: tmpdir() }, 7)).toMatchObject({ success: false });
  });
  it.each(['disposeOwner', 'disposeAll', 'close'])('%s aborts an auxiliary CLI and retains ownership until its actual close', async method => {
    const began = deferred(); const exited = deferred(); let receivedSignal; let aborted = false;
    const compactSession = vi.fn(({ signal }) => {
      receivedSignal = signal;
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),80)); process.stdout.write('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
      const abort = () => { aborted = true; child.kill('SIGTERM'); };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.once('data', () => began.resolve());
      return new Promise(resolve => child.once('close', () => { signal?.removeEventListener('abort', abort); exited.resolve(); resolve({ success: false }); }));
    });
    const f = fixture({ compactSession }); const sid = randomUUID(); const request = { conversationId: 'aux', cwd: tmpdir(), sessionId: sid };
    const operation = f.service.compact(request, 7);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(compactSession).toHaveBeenCalledTimes(1);
    await began.promise;
    const disposal = method === 'close' ? f.service.close('aux', 7) : method === 'disposeOwner' ? f.service.disposeOwner(7) : f.service.disposeAll();
    expect(receivedSignal.aborted).toBe(true); expect(aborted).toBe(true);
    expect(f.ownership.owner(sid)).toMatchObject({ kind: 'compact', ownerWebContentsId: 7 });
    let done = false; disposal.then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 15)); expect(done).toBe(false);
    await exited.promise; await disposal; expect(f.ownership.owner(sid)).toBeUndefined();
    expect(await operation).toMatchObject({ success: false });
  });
  it('auxiliary completion cannot release a registered process lease before its actual exit', async () => {
    const began = deferred(); let child;
    const compactSession = vi.fn(async ({ registerProcess }) => {
      child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const closed = new Promise(resolve => child.once('close', resolve));
      registerProcess?.(child, closed);
      await new Promise(resolve => child.stdout.once('data', resolve)); began.resolve();
      return { success: true };
    });
    const f = fixture({ compactSession }); const sid = randomUUID();
    let completed = false; const operation = f.service.compact({ conversationId: 'registered-child', cwd: tmpdir(), sessionId: sid }, 7).then(result => { completed = true; return result; });
    await began.promise;
    try {
      await new Promise(resolve => setTimeout(resolve, 15));
      expect(completed).toBe(false); expect(f.ownership.owner(sid)).toMatchObject({ kind: 'compact' });
    } finally { child.kill('SIGTERM'); await operation; }
    expect(f.ownership.owner(sid)).toBeUndefined();
  });
  it('an unconfirmed auxiliary timeout keeps its lease and reports failed cleanup until real exit', async () => {
    const actualClose = deferred(); const began = deferred(); const sid = randomUUID();
    const compactSession = vi.fn(async () => {
      began.resolve();
      const error = new Error('unconfirmed exit'); error.code = 'PROCESS_CLOSE_TIMEOUT'; error.closed = actualClose.promise; error.terminated = false;
      throw error;
    });
    const f = fixture({ compactSession });
    const request = { conversationId: 'aux-timeout', cwd: tmpdir(), sessionId: sid };
    const operation = f.service.compact(request, 7);
    await began.promise;
    try {
      expect(await operation).toMatchObject({ success: false });
      expect(f.ownership.owner(sid)).toMatchObject({ kind: 'compact' });
      await expect(f.service.disposeOwner(7)).rejects.toThrow(/exit|cleanup|shutdown/i);
      expect(f.ownership.owner(sid)).toMatchObject({ kind: 'compact' });
    } finally { actualClose.resolve(); }
    await actualClose.promise;
    await f.service.disposeOwner(7);
    expect(f.ownership.owner(sid)).toBeUndefined();
  });
  it('cleanup already waiting on auxiliary work fails promptly if shutdown becomes unconfirmed', async () => {
    const began = deferred(); const failed = deferred(); const actualClose = deferred(); const sid = randomUUID();
    const compactSession = vi.fn(async () => {
      began.resolve(); await failed.promise;
      const error = new Error('no exit'); error.code = 'PROCESS_CLOSE_TIMEOUT'; error.terminated = false; error.closed = actualClose.promise; throw error;
    });
    const f = fixture({ compactSession });
    const operation = f.service.compact({ conversationId: 'late-timeout', cwd: tmpdir(), sessionId: sid }, 7);
    await began.promise;
    const disposal = f.service.disposeAll(); const outcome = disposal.then(() => 'success', () => 'failed');
    failed.resolve();
    try {
      expect(await operation).toMatchObject({ success: false });
      expect(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('hung'), 80))])).toBe('failed');
      expect(f.ownership.owner(sid)).toMatchObject({ kind: 'compact' });
    } finally { actualClose.resolve(); await actualClose.promise; await disposal.catch(() => {}); }
  });
  it('explicit close during idle SDK shutdown cancels auxiliary startup instead of waiting on itself', async () => {
    const compactSession = vi.fn(async () => ({ success: true })); const f = fixture({ compactSession }); const sid = randomUUID();
    const request = { conversationId: 'aux-bootstrap-cancel', cwd: tmpdir(), sessionId: sid };
    await f.service.start(request, 7);
    const began = deferred(); const gate = deferred(); const engine = f.engines[0]; const originalClose = engine.close;
    engine.close = vi.fn(async () => { began.resolve(); await gate.promise; return originalClose(); });
    const operation = f.service.compact(request, 7);
    await began.promise;
    const closed = f.service.close('aux-bootstrap-cancel', 7);
    gate.resolve();
    expect(await closed).toMatchObject({ success: true });
    expect(await operation).toMatchObject({ success: false, error: expect.stringMatching(/closed|cancel/i) });
    expect(compactSession).not.toHaveBeenCalled();
    expect(f.ownership.owner(sid)).toBeUndefined();
  });
  it('context auxiliary uses the injected external boundary and guards a closed owner while awaiting live usage', async () => {
    const queryContext = vi.fn(async () => ({ used: 23, limit: 200000 })); const f = fixture({ queryContext }); const sid = randomUUID();
    const request = { conversationId: 'context-close', cwd: tmpdir(), sessionId: sid };
    await f.service.start(request, 7);
    const began = deferred(); const gate = deferred(); const engine = f.engines[0];
    engine.getContextUsage = vi.fn(async () => { began.resolve(); await gate.promise; return { success: true, totalTokens: 999, maxTokens: 200000 }; });
    const pending = f.service.getContext(request, 7); await began.promise;
    await f.service.close(request.conversationId, 7); gate.resolve();
    expect(await pending).toMatchObject({ success: false }); expect(queryContext).not.toHaveBeenCalled();
    expect(await f.service.getContext(request, 7)).toEqual({ used: 23, limit: 200000 });
    expect(queryContext.mock.calls[0][0]).toMatchObject({ cwd: tmpdir(), sessionId: sid, signal: expect.any(AbortSignal) });
  });
  it('owner cleanup closes its native terminals even when an auxiliary process has unconfirmed exit', async () => {
    const actualClose = deferred(); const sid = randomUUID();
    const compactSession = vi.fn(async () => { const error = new Error('no exit'); error.code = 'PROCESS_CLOSE_TIMEOUT'; error.closed = actualClose.promise; error.terminated = false; throw error; });
    const f = fixture({ compactSession });
    await f.service.compact({ conversationId: 'partial-cleanup', cwd: tmpdir(), sessionId: sid }, 7);
    const close = vi.fn(async () => ({})); f.service.terminalManager.list = () => [{ id: 'owned-term' }]; f.service.terminalManager.close = close;
    try {
      await expect(f.service.disposeOwner(7)).rejects.toThrow(/cleanup|exit/i);
      expect(close).toHaveBeenCalledWith('owned-term', 7);
      expect(f.ownership.owner(sid)).toBeTruthy();
    } finally { actualClose.resolve(); await actualClose.promise; }
  });
  it('session mutations refuse a changed configuration root before closing the known SDK session', async () => {
    let configRoot = path.join(tmpdir(), 'root-one');
    const runtime = { home: tmpdir(), resolve: async () => ({ executable: '/mock/claude', env: { CLAUDE_CONFIG_DIR: configRoot } }), get: () => ({ versionFingerprint: configRoot }) };
    const compactSession = vi.fn(async () => ({ success: true })); const f = fixture({ runtime, compactSession }); const sid = randomUUID();
    const request = { conversationId: 'root-boundary', cwd: tmpdir(), sessionId: sid };
    await f.service.start(request, 7);
    f.service.history.fork = vi.fn(async () => ({}));
    configRoot = path.join(tmpdir(), 'root-two');
    expect(await f.service.compact(request, 7)).toMatchObject({ success: false, error: expect.stringMatching(/root|configuration/i) });
    expect(await f.service.fork(request, 7)).toMatchObject({ success: false });
    await expect(f.service.nativeCreate({ mode: 'interactive', cwd: tmpdir(), sessionId: sid, resume: true }, 7)).rejects.toThrow(/root|configuration/i);
    expect(await f.service.start(request, 7)).toMatchObject({ success: false });
    expect(await f.service.compact(request, 7)).toMatchObject({ success: false });
    expect(f.engines[0].close).not.toHaveBeenCalled(); expect(compactSession).not.toHaveBeenCalled(); expect(f.service.history.fork).not.toHaveBeenCalled();
  });
  it('compact holds only its session lane through context and cold send waits to resume the same SID', async () => {
    const began = deferred(); const gate = deferred();
    const compact = vi.fn(async () => { began.resolve(); await gate.promise; return { success: true, context: { used: 17, limit: 200000 } }; });
    const f = fixture({ compactSession: compact });
    const sid = randomUUID(); await f.service.start({ conversationId: 'compact-a', cwd: tmpdir(), sessionId: sid }, 7);
    const operation = f.service.compact({ conversationId: 'compact-a', cwd: tmpdir(), sessionId: sid }, 7);
    await began.promise;
    let acknowledged = false;
    const waiting = f.service.send({ conversationId: 'compact-a', prompt: 'resume' }, 7).then(result => { acknowledged = true; return result; });
    expect((await f.service.send({ conversationId: 'compact-b', cwd: tmpdir(), prompt: 'parallel' }, 7)).success).toBe(true);
    expect(acknowledged).toBe(false);
    expect(f.ownership.owner(sid).kind).toBe('compact');
    gate.resolve(); expect(await operation).toEqual({ success: true, context: { used: 17, limit: 200000 } });
    expect((await waiting).success).toBe(true);
    expect(f.engines.at(-1).start).toHaveBeenCalledWith({ cwd: tmpdir(), sessionId: sid, options: { permissionMode: 'default' } });
    expect(compact.mock.calls[0][0]).toMatchObject({ cwd: tmpdir(), sessionId: sid, getRuntime: expect.any(Function) });
  });
  it('confirmed interrupt keeps persistent context; failed close never releases a writer slot', async () => {
    const f = fixture(); await f.service.start({ conversationId: 'stop', cwd: tmpdir() }, 7);
    expect(await f.service.interrupt('stop', 7)).toMatchObject({ success: true, closed: false });
    expect(f.engines[0].close).not.toHaveBeenCalled();
    const sid = (await f.service.runtimeState('stop', 7)).sessionId;
    const original = f.engines[0].close;
    f.engines[0].close = vi.fn(async () => ({ success: false }));
    expect(await f.service.close('stop', 7)).toMatchObject({ success: false, error: expect.stringContaining('confirmed actual exit') });
    expect(f.ownership.owner(sid)).toMatchObject({ conversationId: 'stop', ownerWebContentsId: 7 });
    f.engines[0].close = original;
  });
  it('acknowledges send without a full-turn lock, emits runtime before stream and rejects duplicate nonce', async () => {
    const f = fixture(); const cid = 'send-a'; const nonce = randomUUID();
    const result = await f.service.send({ conversationId: cid, cwd: tmpdir(), prompt: 'hello', userMessageId: nonce }, 7);
    expect(result).toMatchObject({ success: true, userMessageId: nonce, runtimeState: { busy: true } });
    const streamIndex = f.events.findIndex(e => e.channel === 'claude:stream');
    expect(f.events[streamIndex - 1]).toMatchObject({ owner: 7, channel: 'claude:runtime' });
    expect(await f.service.mode({ conversationId: cid, mode: 'manual' }, 7)).toMatchObject({ success: true, permissionMode: 'default' });
    expect(await f.service.send({ conversationId: cid, prompt: 'again', userMessageId: nonce }, 7)).toMatchObject({ success: false, error: 'Duplicate userMessageId' });
    expect(f.engines[0].send).toHaveBeenCalledTimes(1);
  });
  it('cancels bootstrap immediately and rejects starts queued before close without reopening', async () => {
    const f = fixture();
    await f.service.start({ conversationId: 'boot', cwd: tmpdir() }, 7);
    const gate = deferred(); const began = deferred(); const engine = f.engines[0];
    engine.start = vi.fn(async () => { engine.setState({ state: 'starting', busy: true }); began.resolve(); await gate.promise; return { success: false, error: 'cancelled' }; });
    engine.close = vi.fn(async () => { engine.setState({ state: 'closed', busy: false, runId: null }); gate.resolve(); return { success: true }; });
    const boot = f.service.start({ conversationId: 'boot' }, 7);
    await began.promise;
    const queued = f.service.start({ conversationId: 'boot' }, 7);
    const close = await f.service.close('boot', 7);
    expect(close).toMatchObject({ success: true, closed: true, wasBusy: true });
    expect(await boot).toMatchObject({ success: false });
    expect(await queued).toMatchObject({ success: false, error: expect.stringMatching(/closed/i) });
    expect(engine.start).toHaveBeenCalledTimes(1);
  });
  it('closes on unconfirmed queued interruption, preserving SID/options for next send resume', async () => {
    const f = fixture(); const sid = randomUUID(); const options = { model: 'original', additionalDirectories: [tmpdir()] };
    await f.service.start({ conversationId: 'resume', cwd: tmpdir(), sessionId: sid, options }, 7);
    options.additionalDirectories[0] = '/changed';
    f.engines[0].interrupt.mockResolvedValue({ success: false, stillQueued: [randomUUID()] });
    expect(await f.service.interrupt('resume', 7)).toMatchObject({ success: true, closed: true });
    const next = await f.service.send({ conversationId: 'resume', prompt: 'continue' }, 7);
    expect(next.success).toBe(true);
    expect(f.engines[1].start).toHaveBeenCalledWith({ cwd: tmpdir(), sessionId: sid, options: { model: 'original', additionalDirectories: [tmpdir()], permissionMode: 'default' } });
    expect(f.events.some(e => e.channel === 'claude:status' && e.data.status === 'aborted')).toBe(true);
  });
  it('rejects stale approval, foreign owner, and concurrent double validation', async () => {
    const f = fixture(); await f.service.start({ conversationId: 'approval', cwd: tmpdir() }, 7);
    const engine = f.engines[0]; const runId = engine.getState().runId;
    engine.setState({ pendingApprovals: [{ requestId: 'ask' }] });
    const payload = { conversationId: 'approval', runId, requestId: 'ask', decision: { action: 'accept', content: {} } };
    expect(await f.service.respond({ ...payload, runId: randomUUID() }, 7)).toMatchObject({ success: false, error: 'Stale approval runId' });
    expect(await f.service.respond(payload, 8)).toMatchObject({ success: false, error: 'Conversation owner mismatch' });
    const gate = deferred(); engine.respond.mockImplementation(async () => { await gate.promise; return { success: true }; });
    const first = f.service.respond(payload, 7);
    expect(await f.service.respond(payload, 7)).toMatchObject({ success: false, error: 'Duplicate approval action in progress' });
    gate.resolve(); expect((await first).success).toBe(true);
    expect(engine.respond).toHaveBeenCalledTimes(1);
  });
  it('retains 32 idle persistent contexts rather than evicting another tab, explicitly closed slot resumes', async () => {
    const f = fixture();
    for (let i = 0; i < 32; i++) expect((await f.service.start({ conversationId: `tab-${i}`, cwd: tmpdir() }, 7)).success).toBe(true);
    expect(await f.service.start({ conversationId: 'extra', cwd: tmpdir() }, 7)).toMatchObject({ success: false, error: expect.stringContaining('32') });
    expect(f.engines.every(e => e.close.mock.calls.length === 0)).toBe(true);
    await f.service.close('tab-0', 7);
    expect((await f.service.start({ conversationId: 'extra', cwd: tmpdir() }, 7)).success).toBe(true);
  });
  it('rejects non-resume native intent for known SID before closing even an idle or closed SDK record', async () => {
    const f = fixture(); const sid = randomUUID();
    await f.service.start({ conversationId: 'known-native', cwd: tmpdir(), sessionId: sid }, 7);
    const create = vi.fn(async () => ({ id: 'pty' })); f.service.terminalManager.create = create;
    const spec = { mode: 'interactive', cwd: tmpdir(), sessionId: sid };
    await expect(f.service.nativeCreate(spec, 7)).rejects.toThrow(/resume/i);
    expect(f.engines[0].close).not.toHaveBeenCalled();
    await f.service.close('known-native', 7);
    await expect(f.service.nativeCreate(spec, 7)).rejects.toThrow(/resume/i);
    await expect(f.service.nativeCreate({ ...spec, resume: true }, 8)).rejects.toThrow(/owner/i);
    expect(create).not.toHaveBeenCalled();
  });
  it('native handoff rejects the originally reserved SID after SDK adoption without closing the actual session', async () => {
    const f = fixture(); const original = randomUUID(); const actual = randomUUID();
    await f.service.start({ conversationId: 'adopt-native', cwd: tmpdir(), sessionId: original }, 7);
    f.engines[0].setState({ sessionId: actual });
    const release = f.ownership.acquire(actual, { conversationId: 'adopt-native', ownerWebContentsId: 7 });
    f.service.terminalManager.create = vi.fn(async () => ({ id: 'pty' }));
    try {
      await expect(f.service.nativeCreate({ mode: 'interactive', cwd: tmpdir(), sessionId: original, resume: true }, 7)).rejects.toThrow(/session|match/i);
      expect(f.engines[0].close).not.toHaveBeenCalled();
      expect(f.service.terminalManager.create).not.toHaveBeenCalled();
    } finally { release(); }
  });
  it('handoff waits behind a conversation control lane before closing its SDK writer', async () => {
    const f = fixture(); const sid = randomUUID(); const request = { conversationId: 'handoff-control', cwd: tmpdir(), sessionId: sid };
    await f.service.start(request, 7);
    const began = deferred(); const gate = deferred(); const engine = f.engines[0];
    engine.setPermissionMode.mockImplementation(async () => { began.resolve(); await gate.promise; return { success: true }; });
    f.service.terminalManager.create = vi.fn(async () => ({ id: 'pty' }));
    const control = f.service.mode({ conversationId: request.conversationId, mode: 'plan' }, 7);
    await began.promise;
    const handoff = f.service.nativeCreate({ mode: 'interactive', cwd: tmpdir(), sessionId: sid, resume: true }, 7);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(engine.close).not.toHaveBeenCalled();
    gate.resolve(); expect((await control).success).toBe(true); await handoff;
    expect(engine.close).toHaveBeenCalledTimes(1);
  });
  it('handoff uses the current SID writer lane rather than an older closed record with the same SID', async () => {
    const f = fixture(); const sid = randomUUID();
    await f.service.start({ conversationId: 'older-native', cwd: tmpdir(), sessionId: sid }, 7); await f.service.close('older-native', 7);
    await f.service.start({ conversationId: 'current-native', cwd: tmpdir(), sessionId: sid }, 7);
    const engine = f.engines[1]; const began = deferred(); const gate = deferred();
    engine.setPermissionMode.mockImplementation(async () => { began.resolve(); await gate.promise; return { success: true }; });
    f.service.terminalManager.create = vi.fn(async () => ({ id: 'pty' }));
    const control = f.service.mode({ conversationId: 'current-native', mode: 'plan' }, 7); await began.promise;
    const handoff = f.service.nativeCreate({ mode: 'interactive', cwd: tmpdir(), sessionId: sid, resume: true }, 7);
    try { await new Promise(resolve => setTimeout(resolve, 10)); expect(engine.close).not.toHaveBeenCalled(); }
    finally { gate.resolve(); await control; await handoff; }
  });
  it('handoff waiting on a SID lane honors explicit close and never creates a late terminal', async () => {
    const f = fixture(); const sid = randomUUID(); const began = deferred(); const gate = deferred();
    await f.service.start({ conversationId: 'sid-wait-native', cwd: tmpdir(), sessionId: sid }, 7); await f.service.close('sid-wait-native', 7);
    f.service.history.fork = async () => { began.resolve(); await gate.promise; return { cwd: tmpdir(), sessionId: randomUUID() }; };
    f.service.history.read = async ({ cwd, sessionId }) => ({ cwd, sessionId, messages: [], nextOffset: null });
    const fork = f.service.fork({ conversationId: 'sid-blocker', cwd: tmpdir(), sessionId: sid }, 7); await began.promise;
    f.service.terminalManager.create = vi.fn(async () => ({ id: 'pty' }));
    const handoff = f.service.nativeCreate({ mode: 'interactive', cwd: tmpdir(), sessionId: sid, resume: true }, 7); const outcome = handoff.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 10)); await f.service.close('sid-wait-native', 7);
    gate.resolve(); await fork;
    expect(await outcome).toBeInstanceOf(Error); expect(f.service.terminalManager.create).not.toHaveBeenCalled();
  });
  it('native handoff cancels queued sends and keeps a lease until terminal acquisition', async () => {
    const f = fixture(); const sid = randomUUID(); const cid = 'handoff-queue';
    await f.service.start({ conversationId: cid, cwd: tmpdir(), sessionId: sid }, 7);
    const began = deferred(); const gate = deferred(); const engine = f.engines[0];
    const close = engine.close;
    engine.close = vi.fn(async () => { began.resolve(); await gate.promise; return close(); });
    f.service.terminalManager.create = vi.fn(async () => {
      expect(f.ownership.owner(sid)).toMatchObject({ ownerWebContentsId: 7 });
      return { id: 'pty', sessionId: sid };
    });
    const handoff = f.service.nativeCreate({ mode: 'interactive', cwd: tmpdir(), sessionId: sid, resume: true }, 7);
    await began.promise;
    const waiting = f.service.send({ conversationId: cid, prompt: 'must not reopen' }, 7);
    gate.resolve(); await handoff;
    expect(await waiting).toMatchObject({ success: false, error: expect.stringMatching(/closed/i) });
    expect(f.engines).toHaveLength(1);
  });
  it('handoffs idle SDK ownership to native only after confirmed close and refuses busy/foreign sessions', async () => {
    const f = fixture(); const sid = randomUUID();
    await f.service.start({ conversationId: 'native', cwd: tmpdir(), sessionId: sid }, 7);
    const create = vi.fn(async spec => { const release = f.service.terminalManager.acquireSession(spec.sessionId, { kind: 'native-terminal', ownerWebContentsId: 7 }); release(); return { id: 'pty', sessionId: sid }; });
    f.service.terminalManager.create = create;
    const spec = { mode: 'interactive', cwd: tmpdir(), sessionId: sid, resume: true };
    f.engines[0].setState({ busy: true });
    await expect(f.service.nativeCreate(spec, 7)).rejects.toThrow(/busy/);
    await expect(f.service.nativeCreate(spec, 8)).rejects.toThrow(/owner/);
    expect(create).not.toHaveBeenCalled();
    f.engines[0].setState({ busy: false });
    expect(await f.service.nativeCreate(spec, 7)).toEqual({ id: 'pty', sessionId: sid });
    expect(f.engines[0].close).toHaveBeenCalledTimes(1);
  });
  it('queries live structured context without auxiliary CLI, unsupported busy returns null', async () => {
    const f = fixture(); const sid = randomUUID();
    await f.service.start({ conversationId: 'context', cwd: tmpdir(), sessionId: sid }, 7);
    const engine = f.engines[0];
    engine.getContextUsage = vi.fn(async () => ({ success: true, totalTokens: 42, maxTokens: 200000, categories: [] }));
    expect(await f.service.getContext({ cwd: tmpdir(), sessionId: sid }, 7)).toMatchObject({ used: 42, limit: 200000 });
    engine.setState({ busy: true }); engine.getContextUsage.mockResolvedValue({ success: false });
    expect(await f.service.getContext({ cwd: tmpdir(), sessionId: sid }, 7)).toBeNull();
    expect(engine.close).not.toHaveBeenCalled();
  });
  it('fork reads all pages, serializes only its SID and does not delete or send source', async () => {
    const f = fixture(); const sid = randomUUID(); const forkSid = randomUUID();
    await f.service.start({ conversationId: 'fork', cwd: tmpdir(), sessionId: sid }, 7);
    const gate = deferred(); const began = deferred();
    f.service.history.fork = vi.fn(async () => { began.resolve(); await gate.promise; return { sessionId: forkSid, cwd: tmpdir(), title: 'Branch' }; });
    f.service.history.read = vi.fn(async ({ offset, sessionId }) => ({ cwd: tmpdir(), sessionId, messages: offset ? [{ uuid: 'last' }] : Array.from({ length: 500 }, (_, i) => ({ uuid: String(i) })), nextOffset: offset ? null : 500 }));
    const fork = f.service.fork({ conversationId: 'fork', cwd: tmpdir(), sessionId: sid }, 7);
    await began.promise;
    expect((await f.service.send({ conversationId: 'independent', cwd: tmpdir(), prompt: 'works' }, 7)).success).toBe(true);
    gate.resolve(); const result = await fork;
    expect(result).toMatchObject({ success: true, sessionId: forkSid }); expect(result.messages).toHaveLength(501);
    expect(f.engines[0].send).not.toHaveBeenCalled();
    expect((await f.service.runtimeState('fork', 7)).sessionId).toBe(sid);
  });
  it('editFork first user returns draft with no model; parent branch cuts to raw attachment parent', async () => {
    const f = fixture(); const sid = randomUUID(); const user = randomUUID(); const parent = randomUUID(); const newSid = randomUUID();
    const source = { conversationId: 'edit', cwd: tmpdir(), sessionId: sid, messageId: user };
    const row = { type: 'user', uuid: user, sessionId: sid, parentUuid: null, message: { role: 'user', content: 'literal draft' } };
    f.service.history.readRaw = vi.fn(async () => JSON.stringify(row));
    f.service.history.read = vi.fn(async ({ sessionId }) => ({ cwd: tmpdir(), sessionId, messages: [{ uuid: user }], nextOffset: null }));
    expect(await f.service.editFork(source, 7)).toEqual({ success: true, newSession: true, cwd: tmpdir(), title: 'Edited conversation', draft: 'literal draft', messages: [] });
    expect(f.engines).toHaveLength(0);
    row.parentUuid = parent;
    f.service.history.readRaw.mockResolvedValue([JSON.stringify({ type: 'attachment', uuid: parent, sessionId: sid, parentUuid: null }), JSON.stringify(row)].join('\n'));
    f.service.history.fork = vi.fn(async payload => ({ sessionId: newSid, cwd: payload.cwd, title: 'new' }));
    const result = await f.service.editFork(source, 7);
    expect(result).toMatchObject({ success: true, sessionId: newSid, draft: 'literal draft' });
    expect(f.service.history.fork).toHaveBeenCalledWith({ cwd: tmpdir(), sessionId: sid, upToMessageId: parent });
    row.message.content = [{ type: 'tool_result', content: 'not editable' }];
    f.service.history.readRaw.mockResolvedValue(JSON.stringify({ ...row, parentUuid: null }));
    expect(await f.service.editFork(source, 7)).toMatchObject({ success: false, error: expect.stringContaining('tool_result') });
  });
  it('raw export and history are allowlisted, never instantiate a runner', async () => {
    const f = fixture(); const sid = randomUUID(); const raw = 'original\n'.repeat(4001);
    f.service.history.readRaw = vi.fn(async () => raw); f.service.history.list = vi.fn(async () => [{ sessionId: sid }]);
    expect(await f.service.exportTranscript({ cwd: tmpdir(), sid, secret: 'no' }, 7)).toBe(raw);
    expect(await f.service.historyList({ cwd: tmpdir(), offset: 0, limit: 50, unsafe: true }, 7)).toEqual([{ sessionId: sid }]);
    expect(f.service.history.list).toHaveBeenCalledWith({ cwd: tmpdir(), offset: 0, limit: 50 });
    expect(f.service.history.readRaw).toHaveBeenCalledWith({ cwd: tmpdir(), sessionId: sid });
    expect(f.engines).toHaveLength(0);
  });
  it('disposing an owner blocks later writes/starts and suppresses late events without touching another owner', async () => {
    const f = fixture(); await f.service.start({ conversationId: 'owned', cwd: tmpdir() }, 7);
    await f.service.start({ conversationId: 'other', cwd: tmpdir() }, 8);
    await f.service.disposeOwner(7);
    expect(await f.service.send({ conversationId: 'owned', prompt: 'late' }, 7)).toMatchObject({ success: false, error: 'Owner disposed' });
    expect((await f.service.runtimeState('other', 8)).state).toBe('ready');
    expect(f.engines[1].close).not.toHaveBeenCalled();
  });
});
