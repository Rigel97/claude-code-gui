import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import { NativeTerminalManager, buildNativeArgs } from '../src/main/native-terminal.js';

const SID = '12345678-1234-4234-8234-123456789abc';
const dirs = [];
const managers = [];
const allPtys = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-'));
  dirs.push(dir);
  return dir;
}
class FakePty extends EventEmitter {
  constructor() { super(); allPtys.push(this); this.pid = 912345; this.write = vi.fn(); this.resize = vi.fn(); this.kill = vi.fn(); }
  onData(fn) { this.on('data', fn); return { dispose: () => this.off('data', fn) }; }
  onExit(fn) { this.on('exit', fn); return { dispose: () => this.off('exit', fn) }; }
  output(data) { this.emit('data', data); }
  exit(exitCode = 0, signal = 0) { this.emit('exit', { exitCode, signal }); }
}
function setup(overrides = {}) {
  const ptys = [];
  const spawn = vi.fn(() => { const pty = new FakePty(); ptys.push(pty); return pty; });
  const events = [];
  const release = vi.fn();
  const acquireSession = vi.fn(() => release);
  const getRuntime = vi.fn(async () => ({ executable: '/opt/claude', env: { PRIVATE_TOKEN: 'secret', PATH: '/bin' } }));
  const manager = new NativeTerminalManager({ ptyFactory: { spawn }, getRuntime, acquireSession,
    sendEvent: (channel, payload) => events.push({ channel, payload }), ...overrides });
  managers.push(manager);
  return { manager, ptys, spawn, events, release, acquireSession, getRuntime };
}
afterEach(async () => {
  for (const pty of allPtys.splice(0)) pty.exit();
  for (const manager of managers.splice(0)) if (manager.disposeAll) await manager.disposeAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('lifecycle and health boundary', () => {
  it('natural exit preserves history until explicit close then removes it without another kill', async () => {
    const { manager, ptys, release } = setup(); const cwd = directory();
    const term = await manager.create({ mode: 'interactive', cwd }, 7);
    ptys[0].output('history'); ptys[0].exit(12);
    expect(manager.attach(term.id, 7)).toMatchObject({ snapshot: 'history', lastSeq: 1, status: 'exited', exitCode: 12 });
    await expect(manager.close(term.id, 8)).rejects.toThrow(/owner/); expect(manager.list(7)).toHaveLength(1);
    await expect(manager.close(term.id, 7)).resolves.toMatchObject({ id: term.id, status: 'exited', exitCode: 12 });
    expect(manager.list(7)).toEqual([]); expect(() => manager.attach(term.id, 7)).toThrow(/unknown terminal/);
    expect(ptys[0].kill).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
  });
  it('explicit close keeps record and lock until actual exit then frees a full retained capacity', async () => {
    const { manager, ptys, release } = setup(); const cwd = directory();
    for (let i = 0; i < 31; i++) { await manager.create({ mode: 'auth', cwd }, 7); ptys.at(-1).exit(); }
    const term = await manager.create({ mode: 'interactive', cwd, sessionId: SID }, 7);
    const closing = manager.close(term.id, 7);
    expect(manager.list(7)).toHaveLength(32); expect(release).not.toHaveBeenCalled();
    await expect(manager.create({ mode: 'auth', cwd }, 7)).rejects.toThrow(/32/);
    ptys.at(-1).exit(); await closing;
    expect(manager.list(7)).toHaveLength(31); expect(manager.list(7).some(item => item.id === term.id)).toBe(false);
    const next = await manager.create({ mode: 'interactive', cwd, sessionId: SID, resume: true }, 7);
    expect(next.id).not.toBe(term.id); expect(manager.list(7)).toHaveLength(32);
  });
  it('late actual exit after close timeout removes the explicitly closed record, not a replacement', async () => {
    const { manager, ptys, release } = setup(); const cwd = directory();
    const term = await manager.create({ mode: 'interactive', cwd, sessionId: SID }, 7);
    vi.useFakeTimers(); const closing = manager.close(term.id, 7);
    const failed = expect(closing).rejects.toThrow(/timeout/); await vi.advanceTimersByTimeAsync(5000); await failed;
    expect(manager.list(7)[0].status).toBe('closing'); expect(release).not.toHaveBeenCalled();
    ptys[0].exit(); expect(manager.list(7)).toEqual([]); vi.useRealTimers();
    const next = await manager.create({ mode: 'interactive', cwd, sessionId: SID, resume: true }, 7);
    ptys[0].exit(99); expect(manager.list(7)).toEqual([next]); expect(release).toHaveBeenCalledTimes(1);
  });
  it('reports native spawn-helper failures as unavailable without leaking paths', async () => {
    const { manager, spawn } = setup();
    spawn.mockImplementationOnce(() => { throw new Error('posix_spawnp failed. /private/secret'); });
    await expect(manager.create({ mode: 'auth', cwd: directory() }, 7)).rejects.toThrow(/spawn-helper/);
    expect(manager.health).toMatchObject({ ptyAvailable: false, diagnostic: expect.stringMatching(/spawn-helper/) });
  });
  it('duplicate failed creates never unlock an already-running session', async () => {
    const { manager, spawn } = setup(); const spec = { mode: 'interactive', cwd: directory(), sessionId: SID };
    await manager.create(spec, 7);
    await expect(manager.create(spec, 8)).rejects.toThrow(/busy/);
    await expect(manager.create(spec, 8)).rejects.toThrow(/busy/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('continues output despite throwing or rejected sendEvent and preserves closing output', async () => {
    const { manager, ptys } = setup({ sendEvent: vi.fn().mockImplementationOnce(() => { throw new Error('gone'); }).mockRejectedValue(new Error('gone')) });
    const term = await manager.create({ mode: 'auth', cwd: directory() }, 7);
    ptys[0].output('a'); ptys[0].output('b');
    const closing = manager.close(term.id, 7); ptys[0].output('c');
    expect(manager.attach(term.id, 7)).toMatchObject({ snapshot: 'abc', lastSeq: 3, status: 'closing' });
    ptys[0].exit(); await closing; expect(manager.list(7)).toEqual([]);
  });
  it('signals only a verified isolated PTY group and never the application or parent shell', async () => {
    const { manager, ptys } = setup(); const cwd = directory();
    const term = await manager.create({ mode: 'auth', cwd }, 7);
    const ps = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('912345 912345 123456');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const closing = manager.close(term.id, 7);
    expect(ps).toHaveBeenCalledWith('/bin/ps', ['-p', '912345', '-o', 'pid=,pgid=,sess='], expect.objectContaining({ timeout: 200 }));
    expect(kill).toHaveBeenCalledWith(-912345, 'SIGTERM'); expect(ptys[0].kill).not.toHaveBeenCalled();
    ptys[0].exit(); await closing;
    for (const pid of [process.pid, process.ppid, 0, -1]) {
      const next = await manager.create({ mode: 'auth', cwd }, 7); const pty = ptys.at(-1); pty.pid = pid;
      const close = manager.close(next.id, 7); expect(pty.kill).not.toHaveBeenCalled(); pty.exit(); await close;
    }
    expect(kill).toHaveBeenCalledTimes(1);
  });
  it('shared groups fall back to PTY-only kill and concurrent close has one termination', async () => {
    const { manager, ptys } = setup(); const term = await manager.create({ mode: 'auth', cwd: directory() }, 7);
    vi.spyOn(childProcess, 'execFileSync').mockReturnValue(`912345 ${process.ppid} 123`);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const a = manager.close(term.id, 7), b = manager.close(term.id, 7);
    expect(ptys[0].kill).toHaveBeenCalledTimes(1); expect(kill).not.toHaveBeenCalled();
    ptys[0].exit(); await Promise.all([a, b]);
  });
  it('spawn failures roll back session locks and do not expose native error secrets', async () => {
    const { manager, spawn, release } = setup(); const spec = { mode: 'interactive', cwd: directory(), sessionId: SID };
    spawn.mockImplementationOnce(() => { throw new Error('spawn PRIVATE_TOKEN=secret'); });
    await expect(manager.create(spec, 7)).rejects.toThrow('Native terminal spawn failed; check executable and cwd');
    expect(release).toHaveBeenCalledTimes(1); expect(manager.list(7)).toEqual([]);
    await manager.create(spec, 7);
  });
  it.runIf(process.env.NATIVE_TERMINAL_INTEGRATION === '1')('real node-pty can deliver terminal output and actual exit without any helper or model task', async () => {
    const require = createRequire(import.meta.url);
    const ptyFactory = require('node-pty');
    const { manager } = setup({ ptyFactory, getRuntime: async () => ({ shellExecutable: process.platform === 'win32' ? process.env.COMSPEC : process.env.SHELL, env: { ...process.env } }) });
    const term = await manager.create({ mode: 'shell', cwd: directory() }, 7);
    // Only the test's explicit user write executes a command; startup itself is prompt-free.
    manager.write(term.id, process.platform === 'win32' ? 'echo NATIVE_SHELL_READY\r\nexit 0\r\n' : "printf 'NATIVE_SHELL_READY\\n'; exit 0\r", 7);
    await vi.waitFor(() => expect(manager.attach(term.id, 7).status).toBe('exited'), { timeout: 4000 });
    expect(manager.attach(term.id, 7).lastSeq).toBeGreaterThan(0);
    expect(manager.attach(term.id, 7).snapshot).toContain('NATIVE_SHELL_READY');
    expect(manager.attach(term.id, 7).exitCode).toBe(0);
  });
  it.runIf(process.env.NATIVE_TERMINAL_INTEGRATION === '1')('real isolated PTY process is terminated and close receives actual exit', async () => {
    const require = createRequire(import.meta.url); const native = require('node-pty');
    let pty;
    const { manager, release } = setup({ ptyFactory: { spawn: () => {
      pty = native.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), env: { ...process.env }, name: 'xterm-256color', cols: 80, rows: 24 });
      return pty;
    } } });
    const term = await manager.create({ mode: 'interactive', cwd: directory() }, 7);
    expect(pty.pid).not.toBe(process.pid); expect(pty.pid).not.toBe(process.ppid);
    await expect(manager.close(term.id, 7)).resolves.toMatchObject({ status: 'exited' });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('close waits for actual exit, keeps lock during grace and cancels escalation after exit', async () => {
    const { manager, ptys, release } = setup();
    const term = await manager.create({ mode: 'interactive', cwd: directory() }, 7);
    vi.useFakeTimers();
    const killed = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let completed = false;
    const closing = manager.close(term.id, 7).then(result => { completed = true; return result; });
    expect(manager.attach(term.id, 7).status).toBe('closing');
    expect(ptys[0].kill).toHaveBeenCalledWith('SIGTERM'); expect(killed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999); expect(completed).toBe(false); expect(release).not.toHaveBeenCalled();
    ptys[0].output('last'); ptys[0].exit(0, 15);
    await expect(closing).resolves.toMatchObject({ status: 'exited', exitCode: 0, seq: 1 });
    await vi.advanceTimersByTimeAsync(4000); expect(ptys[0].kill).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
    expect(manager.list(7)).toEqual([]);
    await expect(manager.close(term.id, 7)).rejects.toThrow(/unknown terminal/);
  });
  it('escalates at 2 seconds, rejects at 5 seconds without inventing exit or releasing lock', async () => {
    const { manager, ptys, release } = setup();
    const term = await manager.create({ mode: 'teams', cwd: directory() }, 7);
    vi.useFakeTimers();
    const closing = manager.close(term.id, 7);
    const rejected = expect(closing).rejects.toThrow(/timeout.*actual exit/i);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ptys[0].kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    await vi.advanceTimersByTimeAsync(3000); await rejected;
    expect(manager.attach(term.id, 7).status).toBe('closing'); expect(release).not.toHaveBeenCalled();
    ptys[0].exit(137, 9); expect(release).toHaveBeenCalledTimes(1);
  });
  it('Windows forwards raw key input and uses ConPTY kill without POSIX process groups', async () => {
    const { manager, ptys } = setup({ platform: 'win32' });
    const term = await manager.create({ mode: 'interactive', cwd: directory(), options: { worktree: 'branch & name' } }, 7);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('must not kill group'); });
    manager.write(term.id, '\u001b[200~a & b\r\n\u001b[201~', 7);
    expect(ptys[0].write).toHaveBeenCalledWith('\u001b[200~a & b\r\n\u001b[201~');
    const closing = manager.close(term.id, 7);
    expect(ptys[0].kill).toHaveBeenCalledWith(); ptys[0].exit(); await closing;
    expect(kill).not.toHaveBeenCalled();
  });
  it('reserves concurrent create capacity (8 live, 32 retained) and frees slots after actual exit', async () => {
    const { manager, ptys, spawn } = setup(); const cwd = directory();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => manager.create({ mode: 'auth', cwd }, 7)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(8);
    expect(spawn).toHaveBeenCalledTimes(8);
    for (const pty of ptys) pty.exit();
    for (let i = 8; i < 32; i++) { await manager.create({ mode: 'auth', cwd }, 7); ptys.at(-1).exit(); }
    expect(manager.list(7)).toHaveLength(32);
    await expect(manager.create({ mode: 'auth', cwd }, 8)).rejects.toThrow(/32/);
    await manager.disposeAll(); expect(manager.list(7)).toEqual([]);
    await expect(manager.create({ mode: 'auth', cwd }, 7)).rejects.toThrow(/disposed/);
  });
  it('loads PTY lazily, reports sanitized ABI failure and permits a successful retry', async () => {
    const spawn = vi.fn(() => new FakePty());
    const loader = vi.fn().mockRejectedValueOnce(new Error('NODE_MODULE_VERSION mismatch; PRIVATE_TOKEN=secret /Users/private'))
      .mockResolvedValue({ spawn });
    const { manager, release } = setup({ ptyFactory: loader });
    expect(loader).not.toHaveBeenCalled(); expect(manager.health).toEqual({ ptyAvailable: null, diagnostic: 'PTY not loaded' });
    const spec = { mode: 'interactive', cwd: directory() };
    await expect(manager.create(spec, 7)).rejects.toThrow(/ABI/);
    expect(manager.health.ptyAvailable).toBe(false); expect(manager.health.diagnostic).toMatch(/ABI/);
    expect(JSON.stringify(manager.health)).not.toMatch(/secret|PRIVATE_TOKEN|Users/);
    expect(release).toHaveBeenCalledTimes(1); expect(manager.list(7)).toEqual([]);
    await manager.create(spec, 7); expect(manager.health).toEqual({ ptyAvailable: true, diagnostic: null });
    manager.health.ptyAvailable = false; expect(manager.health.ptyAvailable).toBe(true);
  });
  it('dispose cancels pending runtime creation, waits for all exits and has an explicit finite failure', async () => {
    let runtimeReady;
    const { manager, acquireSession, release, spawn } = setup({ getRuntime: () => new Promise(resolve => { runtimeReady = resolve; }) });
    const creating = manager.create({ mode: 'interactive', cwd: directory() }, 7);
    const cancelled = expect(creating).rejects.toThrow(/disposed|cancel/i);
    await vi.waitFor(() => expect(acquireSession).toHaveBeenCalled());
    await manager.disposeAll(); await cancelled; expect(release).toHaveBeenCalledTimes(1);
    runtimeReady({ executable: '/late', env: {} }); await Promise.resolve(); expect(spawn).not.toHaveBeenCalled();
    const second = setup();
    await second.manager.create({ mode: 'interactive', cwd: directory() }, 7);
    vi.useFakeTimers();
    const disposal = second.manager.disposeAll(); const failed = expect(disposal).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(5000); await failed; expect(second.release).not.toHaveBeenCalled();
    second.ptys[0].exit(); await second.manager.disposeAll(); expect(second.release).toHaveBeenCalledTimes(1);
  });
});

describe('ownership and output boundary', () => {
  it('synchronous startup data/exit retains the last cut and does not leave PTY listeners', async () => {
    const pty = new FakePty();
    pty.onData = fn => { const disposable = FakePty.prototype.onData.call(pty, fn); fn('startup'); pty.exit(0); return disposable; };
    const { manager } = setup({ ptyFactory: { spawn: () => pty } });
    const term = await manager.create({ mode: 'auth', cwd: directory() }, 7);
    expect(manager.attach(term.id, 7)).toMatchObject({ snapshot: 'startup', lastSeq: 1, status: 'exited', exitCode: 0 });
    expect(pty.listenerCount('data')).toBe(0); expect(pty.listenerCount('exit')).toBe(0);
  });
  it('ring wraparound preserves exact order and trims UTF-8 only at a character boundary', async () => {
    const { manager, ptys } = setup({ sendEvent: () => {} });
    const term = await manager.create({ mode: 'auth', cwd: directory() }, 7);
    ptys[0].output('😀' + 'a'.repeat(4 * 1024 * 1024 - 4));
    ptys[0].output('Z');
    expect(manager.attach(term.id, 7).snapshot).toBe('a'.repeat(4 * 1024 * 1024 - 4) + 'Z');
    ptys[0].output('b'.repeat(100));
    const cut = manager.attach(term.id, 7);
    expect(cut.snapshot).toBe('a'.repeat(4 * 1024 * 1024 - 101) + 'Z' + 'b'.repeat(100));
    expect(cut).toMatchObject({ lastSeq: 3, truncated: true });
  });
  it('many tiny and empty chunks keep the byte tail and count each public chunk', async () => {
    const { manager, ptys } = setup({ sendEvent: () => {} });
    const term = await manager.create({ mode: 'auth', cwd: directory() }, 7);
    for (let i = 0; i < 10000; i++) { ptys[0].output('x'); ptys[0].output(''); }
    expect(manager.attach(term.id, 7)).toMatchObject({ snapshot: 'x'.repeat(10000), lastSeq: 20000, truncated: false });
  });
  it('rejects every cross-window operation and returns detached metadata', async () => {
    const { manager, ptys } = setup();
    const term = await manager.create({ mode: 'interactive', cwd: directory() }, 7);
    expect(manager.list(8)).toEqual([]);
    for (const action of [() => manager.attach(term.id, 8), () => manager.write(term.id, 'x', 8), () => manager.resize(term.id, 80, 24, 8)]) expect(action).toThrow(/owner/i);
    await expect(manager.close(term.id, 8)).rejects.toThrow(/owner/i);
    for (const owner of [0, '7', undefined]) {
      expect(() => manager.list(owner)).toThrow(/owner/i);
      expect(() => manager.write(term.id, 'x', owner)).toThrow(/owner/i);
    }
    term.status = 'exited'; manager.list(7)[0].title = 'mutated';
    expect(manager.list(7)[0]).toMatchObject({ status: 'running', title: 'Claude Code' });
    manager.write(term.id, '\u001b[A\r\u0003', 7); manager.resize(term.id, 132, 40, 7);
    expect(ptys[0].write).toHaveBeenCalledWith('\u001b[A\r\u0003'); expect(ptys[0].resize).toHaveBeenCalledWith(132, 40);
    for (const data of [null, {}, Buffer.from('x'), 'x'.repeat(1024 * 1024 + 1)]) expect(() => manager.write(term.id, data, 7)).toThrow();
    for (const pair of [[0, 24], [80, -1], [1001, 24], [80, NaN], [80.5, 24]]) expect(() => manager.resize(term.id, ...pair, 7)).toThrow();
  });
  it('acquires preassigned UUIDs before spawn, rejects busy sessions and releases once only on actual exit', async () => {
    const { manager, ptys, release, acquireSession, spawn } = setup();
    const cwd = directory();
    const term = await manager.create({ mode: 'interactive', cwd, sessionId: SID }, 7);
    expect(acquireSession).toHaveBeenCalledWith(SID, expect.objectContaining({ kind: 'native-terminal', id: term.id, ownerWebContentsId: 7 }));
    await expect(manager.create({ mode: 'teams', cwd, sessionId: SID.toUpperCase() }, 8)).rejects.toThrow(/session.*busy/i);
    expect(spawn).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled();
    ptys[0].exit(42, 15); ptys[0].exit(99);
    expect(release).toHaveBeenCalledTimes(1);
    expect(manager.attach(term.id, 7)).toMatchObject({ status: 'exited', exitCode: 42, signal: 15 });
    expect(() => manager.write(term.id, 'x', 7)).toThrow(/running/i);
    acquireSession.mockImplementationOnce(() => { throw new Error('chat session busy'); });
    await expect(manager.create({ mode: 'remote', cwd }, 7)).rejects.toThrow(/busy/);
    expect(spawn).toHaveBeenCalledTimes(1);
    await manager.create({ mode: 'teams', cwd, sessionId: SID }, 7);
  });
  it('updates snapshot before publishing each chunk, including reentrant events and synchronous attach cuts', async () => {
    const observed = []; let manager, pty;
    const fixture = setup({ sendEvent: (channel, payload) => {
      observed.push({ channel, payload, cut: manager.attach(payload.id, 7) });
      if (payload.data === 'A') pty.output('B');
    } });
    manager = fixture.manager;
    const term = await manager.create({ mode: 'interactive', cwd: directory() }, 7); pty = fixture.ptys[0];
    pty.output('A');
    const cut = manager.attach(term.id, 7);
    pty.output('C');
    expect(cut).toMatchObject({ snapshot: 'AB', lastSeq: 2, status: 'running', truncated: false });
    expect(observed.map(item => [item.payload.seq, item.payload.data, item.cut.snapshot, item.cut.lastSeq]))
      .toEqual([[1, 'A', 'A', 1], [2, 'B', 'AB', 2], [3, 'C', 'ABC', 3]]);
    expect(observed.map(item => item.channel)).toEqual(Array(3).fill('native-terminal:data'));
    expect(observed[0].payload).toMatchObject({ id: term.id, ownerWebContentsId: 7 });
    expect(cut.snapshot + observed.filter(item => item.payload.seq > cut.lastSeq).map(item => item.payload.data).join('')).toBe('ABC');
  });
  it('retains a 4 MiB UTF-8 tail and reports truncation while continuing monotonic sequences', async () => {
    const { manager, ptys, events } = setup();
    const term = await manager.create({ mode: 'interactive', cwd: directory() }, 7);
    ptys[0].output('old'); ptys[0].output('😀'.repeat(1024 * 1024 + 1)); ptys[0].output('END');
    const cut = manager.attach(term.id, 7);
    expect(Buffer.byteLength(cut.snapshot)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(cut.snapshot).not.toMatch(/old|\ufffd/); expect(cut.snapshot.endsWith('END')).toBe(true);
    expect(cut).toMatchObject({ lastSeq: 3, truncated: true }); expect(events.at(-1).payload.truncated).toBe(true);
    expect(manager.list(7)[0].seq).toBe(3);
    ptys[0].exit(); ptys[0].output('late'); expect(manager.attach(term.id, 7).lastSeq).toBe(3);
  });
});

describe('shell management boundary', () => {
  it('management modes open a real login shell and only suggest fixed commands without auto-write', async () => {
    const runtime = { shellExecutable: process.execPath, env: { PATH: '/bin', FORCE_COLOR: '0', PRIVATE_TOKEN: 'secret' } };
    const { manager, spawn, ptys, acquireSession } = setup({ getRuntime: async () => runtime });
    const cwd = directory();
    for (const [mode, suggestedCommand] of [['shell', undefined], ['mcp', 'claude mcp --help'], ['plugins', 'claude plugin --help'], ['agents', 'claude agents --help']]) {
      const term = await manager.create({ mode, cwd }, 7);
      expect(spawn.mock.calls.at(-1)).toEqual([process.execPath, ['-l'], { cwd, env: { PATH: '/bin', PRIVATE_TOKEN: 'secret' }, name: 'xterm-256color', cols: 80, rows: 24 }]);
      expect(term).toMatchObject({ mode, status: 'running', title: mode === 'shell' ? 'Terminal' : expect.any(String) });
      expect(term.suggestedCommand).toBe(suggestedCommand); expect(term.sessionId).toBeUndefined();
      expect(ptys.at(-1).write).not.toHaveBeenCalled();
      manager.write(term.id, 'claude mcp list\r', 7); expect(ptys.at(-1).write).toHaveBeenCalledWith('claude mcp list\r');
      expect(manager.list(7).at(-1).mode).toBe(mode); ptys.at(-1).exit();
    }
    expect(acquireSession).not.toHaveBeenCalled(); expect(runtime.env.FORCE_COLOR).toBe('0');
  });
  it('uses validated SHELL/COMSPEC fallback and rejects invalid shell paths without spawning', async () => {
    const cwd = directory(); vi.stubEnv('SHELL', process.execPath);
    const { manager, spawn } = setup({ getRuntime: async () => ({ env: {} }) });
    await manager.create({ mode: 'shell', cwd }, 7); expect(spawn.mock.calls[0][0]).toBe(process.execPath);
    const cmd = path.join(cwd, 'cmd.exe'); fs.writeFileSync(cmd, ''); vi.stubEnv('COMSPEC', cmd);
    const windows = setup({ platform: 'win32', getRuntime: async () => ({ env: {} }) });
    await windows.manager.create({ mode: 'shell', cwd }, 7);
    expect(windows.spawn.mock.calls[0]).toEqual([cmd, ['/d', '/q'], expect.objectContaining({ cwd })]);
    expect(buildNativeArgs({ mode: 'shell', cwd }, 'win32')).toEqual(['/d', '/q']);
    for (const shellExecutable of ['relative-shell', cwd, path.join(cwd, 'missing'), 'x\u0000y', '']) {
      const bad = setup({ getRuntime: async () => ({ shellExecutable, env: {} }) });
      await expect(bad.manager.create({ mode: 'shell', cwd }, 7)).rejects.toThrow(/shell/i);
      expect(bad.spawn).not.toHaveBeenCalled();
    }
    for (const spec of [{ mode: 'shell', cwd, sessionId: SID }, { mode: 'shell', cwd, resume: true },
      { mode: 'shell', cwd, options: { permissionMode: 'bypassPermissions' } }, { mode: 'mcp', cwd, initialCommand: '/mcp' },
      { mode: 'shell', cwd, options: { model: 'x' } }]) await expect(manager.create(spec, 7)).rejects.toThrow();
  });
  it('auth starts login, doctor stays direct and preset slash is metadata only; native color is not forced', async () => {
    const { manager, spawn, ptys } = setup({ getRuntime: async () => ({ executable: '/opt/claude', env: { FORCE_COLOR: '0', PATH: '/bin' } }) });
    const cwd = directory();
    for (const [mode, args] of [['auth', ['auth', 'login']], ['doctor', ['doctor']]]) {
      const term = await manager.create({ mode, cwd }, 7);
      expect(spawn.mock.calls.at(-1)).toEqual(['/opt/claude', args, expect.objectContaining({ env: { PATH: '/bin' } })]);
      expect(term.mode).toBe(mode); expect(ptys.at(-1).write).not.toHaveBeenCalled(); ptys.at(-1).exit();
    }
    const term = await manager.create({ mode: 'interactive', cwd, initialCommand: '/resume' }, 7);
    expect(term.initialCommand).toBe('/resume'); expect(ptys.at(-1).write).not.toHaveBeenCalled();
    expect(JSON.stringify(term)).not.toMatch(/env|FORCE_COLOR|permissionMode/);
  });
});

describe('native argument boundary', () => {
  it('explicit resume requires an existing UUID and never substitutes a new-session flag', async () => {
    const cwd = directory(); const { manager, spawn, ptys, acquireSession } = setup();
    for (const mode of ['interactive', 'teams', 'remote']) {
      const term = await manager.create({ mode, cwd, sessionId: SID, resume: true }, 7);
      expect(spawn.mock.calls.at(-1)[1]).toEqual(['--resume', SID, ...(mode === 'remote' ? ['--remote-control'] : [])]);
      expect(term).toMatchObject({ sessionId: SID, resume: true });
      expect(acquireSession.mock.calls.at(-1)[0]).toBe(SID); ptys.at(-1).exit();
    }
    const fresh = await manager.create({ mode: 'interactive', cwd, resume: false }, 7);
    expect(spawn.mock.calls.at(-1)[1]).toEqual(['--session-id', fresh.sessionId]);
    expect(fresh.resume).toBe(false); ptys.at(-1).exit();
    expect(buildNativeArgs({ mode: 'interactive', cwd, sessionId: SID, resume: false })).toEqual(['--session-id', SID]);
    for (const spec of [{ mode: 'interactive', cwd, resume: true }, { mode: 'interactive', cwd, sessionId: SID, resume: 'true' },
      { mode: 'auth', cwd, resume: true }, { mode: 'interactive', cwd, resume: true, sessionId: 'bad' }]) {
      await expect(manager.create(spec, 7)).rejects.toThrow(/resume|sessionId/);
    }
  });
  it('rejects invalid public specs before runtime, session locks or spawn', async () => {
    const cwd = directory();
    const { manager, getRuntime, acquireSession, spawn } = setup();
    const invalid = [
      { mode: 'task', cwd }, { mode: 'interactive', cwd: '.' }, { mode: 'interactive', cwd: path.join(cwd, 'missing') },
      { mode: 'interactive', cwd, description: 'build a website' }, { mode: 'interactive', cwd, args: ['-p', 'task'] },
      { mode: 'interactive', cwd, sessionId: 'bad' }, { mode: 'interactive', cwd, initialCommand: '/evil' },
      { mode: 'teams', cwd, initialCommand: '/mcp' }, { mode: 'cloud', cwd, options: { cloudSession: 'build a website' } },
      { mode: 'interactive', cwd, options: { model: '--print' } }, { mode: 'interactive', cwd, options: { model: 'x\u0000y' } },
      { mode: 'interactive', cwd, options: { model: 'a'.repeat(201) } }, { mode: 'interactive', cwd, options: { ide: 'yes' } },
      { mode: 'interactive', cwd, options: { permissionMode: 'anything' } }, { mode: 'interactive', cwd, options: { prompt: 'task' } },
      { mode: 'auth', cwd, sessionId: SID }, { mode: 'interactive', cwd, cols: 0 },
    ];
    const file = path.join(cwd, 'file'); fs.writeFileSync(file, ''); invalid.push({ mode: 'interactive', cwd: file });
    for (const spec of invalid) await expect(manager.create(spec, 7)).rejects.toThrow();
    for (const owner of [undefined, null, 0, -1, 1.5, '7']) await expect(manager.create({ mode: 'interactive', cwd }, owner)).rejects.toThrow(/owner/i);
    expect(getRuntime).not.toHaveBeenCalled(); expect(acquireSession).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });
  it('uses verified subcommands and allowlisted values without shell quoting', async () => {
    const cwd = directory();
    for (const [mode, args] of [['shell', ['-l']], ['mcp', ['-l']], ['plugins', ['-l']], ['agents', ['-l']],
      ['auth', ['auth', 'login']], ['doctor', ['doctor']], ['remote', ['--remote-control']], ['cloud', ['--cloud', SID]]]) {
      expect(buildNativeArgs({ mode, cwd, ...(mode === 'cloud' ? { options: { cloudSession: SID } } : {}) })).toEqual(args);
    }
    expect(buildNativeArgs({ mode: 'interactive', cwd, options: { model: 'model;$(touch x)', permissionMode: 'manual', chrome: false, ide: true, worktree: 'topic name' } }))
      .toEqual(['--model', 'model;$(touch x)', '--permission-mode', 'manual', '--no-chrome', '--ide', '--worktree', 'topic name']);
    expect(buildNativeArgs({ mode: 'interactive', cwd, options: { permissionMode: 'default', ide: false } })).toEqual([]);
    const { manager, ptys, spawn } = setup();
    await manager.create({ mode: 'teams', cwd }, 7);
    expect(spawn.mock.calls[0][2].env).toEqual({ PRIVATE_TOKEN: 'secret', PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' });
    ptys[0].exit();
  });
  it('builds literal argv, preserves default settings, never sends a startup prompt', async () => {
    const cwd = directory();
    expect(buildNativeArgs({ mode: 'interactive', cwd, sessionId: SID })).toEqual(['--session-id', SID]);
    const { manager, spawn, ptys } = setup();
    const term = await manager.create({ mode: 'interactive', cwd, initialCommand: '/mcp' }, 7);
    expect(term).toMatchObject({ title: 'Claude Code', cwd, status: 'running', seq: 0, sessionId: expect.any(String) });
    expect(spawn).toHaveBeenCalledWith('/opt/claude', ['--session-id', term.sessionId], {
      cwd, env: { PRIVATE_TOKEN: 'secret', PATH: '/bin' }, name: 'xterm-256color', cols: 80, rows: 24,
    });
    expect(ptys[0].write).not.toHaveBeenCalled();
    expect(JSON.stringify(term)).not.toMatch(/secret|PRIVATE_TOKEN|env/);
    ptys[0].exit();
  });
});
