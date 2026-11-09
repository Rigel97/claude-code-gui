import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const dirs = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function loadMain({ processBoundary = { execFile: (_file, _args, _options, callback) => callback(null, '') }, ready = true, initialConfig, adoptedSid, runtimeEnvironment = () => ({}) } = {}) {
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-main-ipc-')); dirs.push(directory);
  if (initialConfig !== undefined) fs.writeFileSync(path.join(directory, 'claude-gui-config.json'), initialConfig);
  const forceKill = vi.fn(async () => true);
  const handles = new Map(); const renderer = new EventEmitter(); const windows = []; const queries = [];
  const app = Object.assign(new EventEmitter(), { name: 'test', isPackaged: true, getPath: key => key === 'home' ? directory : directory,
    setPath: vi.fn(), requestSingleInstanceLock: () => true, whenReady: () => ready ? Promise.resolve() : new Promise(() => {}), quit: vi.fn(), exit: vi.fn() });
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = Object.assign(new EventEmitter(), { id: windows.length + 1, isDestroyed: () => this.destroyed === true,
      send: (channel, data) => renderer.emit(channel, {}, data), setWindowOpenHandler: vi.fn() }); windows.push(this); }
    loadFile() {} loadURL() {} isDestroyed() { return this.destroyed === true; }
    static getAllWindows() { return windows; }
    static fromWebContents(sender) { return windows.find(w => w.webContents === sender); }
  }
  const electron = { app, BrowserWindow: Window, ipcMain: { handle: (channel, fn) => { if (handles.has(channel)) throw new Error(`Duplicate ${channel}`); handles.set(channel, fn); }, on: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }, Menu: { buildFromTemplate: x => x, setApplicationMenu: vi.fn() },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })), showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: path.join(directory, 'export.jsonl') })) },
    shell: { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(`encrypted:${text}`), decryptString: buffer => buffer.toString().slice(10) },
    webContents: { fromId: id => windows.find(w => w.webContents.id === id)?.webContents }, clipboard: {}, Notification: {}, webUtils: {} };
  const Module = require('node:module'); const originalLoad = Module._load;
  const system = processBoundary || require('node:child_process');
  const sdk = { query: ({ prompt, options }) => {
    const output = []; let wake; let ended = false;
    const q = { initializationResult: async () => adoptedSid ? { session_id: adoptedSid } : ({}), supportedCommands: async () => [{ name: 'help' }], mcpServerStatus: async () => [],
      close: () => { ended = true; wake?.(); }, cancelAsyncMessage: async () => ({ success: true }), setPermissionMode: vi.fn(async () => {}), interrupt: async () => ({ still_queued: [] }),
      getContextUsage: async () => ({ categories: [], totalTokens: 17, maxTokens: 200000 }),
      async *[Symbol.asyncIterator]() { while (!ended) { if (output.length) yield output.shift(); else await new Promise(r => { wake = r; }); } } };
    const call = { options, inputs: [], q }; queries.push(call);
    (async () => {
      for await (const input of prompt) {
        call.inputs.push(input);
        output.push({ type: 'user', uuid: input.uuid, session_id: input.session_id, message: input.message });
        wake?.();
      }
    })(); return q;
  } };
  const { ClaudeRunner } = require('../src/main/runner');
  const { ClaudeService } = require('../src/main/claude-service');
  const { ClaudeRuntime } = require('../src/main/claude-runtime');
  const history = { list: vi.fn(async () => []), read: vi.fn(async data => ({ ...data, messages: [], nextOffset: null })), readRaw: vi.fn(async () => 'literal original\n'.repeat(4001)) };
  const terminal = { list: vi.fn(() => []), disposeAll: vi.fn(async () => {}), _loadPty: vi.fn(async () => {}), health: { ptyAvailable: true, diagnostic: null } };
  vi.spyOn(Module, '_load').mockImplementation(function (id, ...args) {
    if (id === 'electron') return electron;
    if (id === 'node:child_process') return system;
    if (id === './projects') return { ProjectsBackend: class {} };
    if (id === './claude-runtime') return { ClaudeRuntime: class extends ClaudeRuntime { async resolve() { return { executable: '/mock/claude', env: runtimeEnvironment() }; } } };
    if (id === './claude-service') return { ClaudeService: class extends ClaudeService {
      constructor(deps) { super({ ...deps, forceKill: deps.forceKill ? (...args) => forceKill(...args).then(() => deps.forceKill(...args)) : forceKill, createRunner: (cid, options) => new ClaudeRunner(cid, { ...options, loadSdk: async () => sdk }) }); }
    } };
    if (id === './session-history') return { SessionHistory: class { constructor() { return history; } } };
    if (id === './native-terminal') return { NativeTerminalManager: class { constructor() { return terminal; } } };
    return originalLoad.call(this, id, ...args);
  });
  const mainPath = require.resolve('../src/main/main'); delete require.cache[mainPath]; require(mainPath);
  let bridge; renderer.invoke = (channel, ...args) => Promise.resolve().then(() => handles.get(channel)({ sender: windows[0].webContents }, ...args));
  const preload = fs.readFileSync(require.resolve('../src/main/preload'), 'utf8');
  vm.runInNewContext(preload, { require: () => ({ ...electron, ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } } }) });
  return { directory, handles, bridge, app, windows, queries, electron, history, renderer, terminal, forceKill };
}
describe('actual main.js IPC registration through actual preload bridge', () => {
  it('registers all exposed channels, sends via actual runner, maps runtime to existing App stream and enforces sender', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    const api = f.bridge; const stream = []; const unsubscribe = api.claude.onStream(data => stream.push(data));
    expect(await api.claude.runtimeState('cold')).toBeNull(); expect(f.queries).toHaveLength(0);
    const boot = await api.claude.start({ conversationId: '真实IPC', cwd: f.directory });
    expect(boot.success).toBe(true); expect(f.queries[0].inputs).toEqual([]);
    const accepted = await api.claude.send({ conversationId: '真实IPC', cwd: f.directory, prompt: 'literal input', userMessageId: randomUUID() });
    expect(accepted.success).toBe(true); expect(f.queries).toHaveLength(1);
    expect(f.queries[0].inputs[0].message.content).toBe('literal input');
    expect(stream.some(row => row.type === 'system' && row.subtype === 'runtime' && row.state.runId === boot.runId)).toBe(true);
    await expect(Promise.resolve().then(() => f.handles.get('claude:send')({ sender: { id: 99 } }, { conversationId: '真实IPC', prompt: 'intrusion', ownerWebContentsId: 1 }))).rejects.toThrow(/sender/i);
    expect(await api.claude.commands({ conversationId: '真实IPC' })).toEqual([{ name: 'help' }]);
    expect(await api.claude.mcpStatus({ conversationId: '真实IPC' })).toEqual([]);
    expect((await api.claude.states())[0].conversationId).toBe('真实IPC');
    expect(await api.claude.generateTitle(f.directory, 'no billing')).toBeNull(); expect(f.queries).toHaveLength(1);
    for (const channel of ['claude:mode', 'claude:respond', 'claude:rewind', 'claude:edit-fork', 'claude:history-list', 'claude:history-read', 'terminal:create', 'terminal:write', 'runtime:set']) expect(f.handles.has(channel)).toBe(true);
    unsubscribe(); expect(f.renderer.listenerCount('claude:runtime')).toBe(0);
    await api.claude.close('真实IPC');
  });
  it('actual preload cold send follows SDK initialization adoption and never resumes its original requested SID', async () => {
    const actual = randomUUID(); const requested = randomUUID(); const f = loadMain({ adoptedSid: actual }); await new Promise(resolve => setTimeout(resolve, 0));
    const result = await f.bridge.claude.send({ conversationId: 'actual-adoption', cwd: f.directory, sessionId: requested, prompt: 'only actual SID' });
    expect(result).toMatchObject({ success: true, runtimeState: { sessionId: actual } });
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0].inputs[0]).toMatchObject({ session_id: actual, message: { content: 'only actual SID' } });
    await f.bridge.claude.close('actual-adoption');
  });
  it('rejects forged IPC senders before filesystem, dialog, project and runtime effects', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    const forged = { sender: { id: f.windows[0].webContents.id, isDestroyed: () => false } };
    for (const [channel, args] of [['fs:read-dir', [f.directory]], ['skills:delete', [path.join(f.directory, '.claude/skills/x')]], ['runtime:get', []], ['dialog:open-directory', []], ['claude:start', [{ conversationId: 'forged', cwd: f.directory }]]]) {
      await expect(Promise.resolve().then(() => f.handles.get(channel)(forged, ...args))).rejects.toThrow(/sender/i);
    }
    expect(f.queries).toHaveLength(0);
    expect(f.electron.dialog.showSaveDialog).not.toHaveBeenCalled();
  });
  it('skills only mutate approved global/project roots, never substring or symlink escapes', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    const project = path.join(f.directory, 'project'); const outside = path.join(f.directory, 'outside');
    const known = path.join(project, '.claude/skills/known'); const foreign = path.join(outside, '.claude/skills/foreign');
    for (const dir of [known, foreign]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), 'literal'); }
    expect(await f.bridge.skills.delete(foreign)).toBe(false); expect(fs.existsSync(foreign)).toBe(true);
    expect(await f.bridge.skills.create({ name: 'unauthorized', scope: 'project', cwd: outside })).toMatchObject({ ok: false });
    await f.bridge.store.set('appState', { conversations: [{ cwd: project }] });
    expect(await f.bridge.skills.delete(known)).toBe(true);
    fs.symlinkSync(foreign, path.join(project, '.claude/skills/link'));
    expect(await f.bridge.skills.delete(path.join(project, '.claude/skills/link'))).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(await f.bridge.skills.create({ name: 'legitimate', scope: 'project', cwd: project })).toMatchObject({ ok: true });
    expect(f.queries).toHaveLength(0);
  });
  it('a damaged appState store keeps the real window and recovery IPC alive without accepting roots or overwriting data', async () => {
    const f = loadMain({ initialConfig: '{damaged' }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.windows).toHaveLength(1);
    await expect(f.bridge.store.get('appState')).rejects.toThrow(/Config load failed/);
    await expect(f.bridge.store.set('appState', { cwd: f.directory })).rejects.toThrow(/Config load failed/);
    expect(fs.readFileSync(path.join(f.directory, 'claude-gui-config.json'), 'utf8')).toBe('{damaged');
    expect(await f.bridge.skills.create({ scope: 'project', cwd: f.directory, name: 'forbidden' })).toMatchObject({ ok: false });
    fs.writeFileSync(path.join(f.directory, 'claude-gui-config.json'), JSON.stringify({ appState: { cwd: f.directory } }));
    expect(await f.bridge.store.reload()).toEqual({ cwd: f.directory });
    expect(await f.bridge.skills.create({ scope: 'project', cwd: f.directory, name: 'recovered' })).toMatchObject({ ok: true });
    expect(f.queries).toHaveLength(0);
  });
  it('uses dedicated encrypted runtime store and restricts generic store to appState', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    await f.bridge.runtime.set({ environmentUpdates: [{ key: 'ANTHROPIC_API_KEY', value: 'private-literal' }] }, { persist: true });
    const summary = await f.bridge.runtime.get(); expect(summary.environmentKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(JSON.stringify(summary)).not.toContain('private-literal');
    const runtimeFile = JSON.parse(fs.readFileSync(path.join(f.directory, 'claude-gui-runtime.json'), 'utf8'));
    expect(runtimeFile.runtimeConfiguration.encryptedEnvironment).toBeTypeOf('string');
    await expect(f.bridge.store.get('runtimeConfiguration')).rejects.toThrow('Only appState');
    await expect(f.bridge.store.set('other', { secret: true })).rejects.toThrow('Only appState');
    await f.bridge.store.set('appState', { theme: 'dark' }); expect(await f.bridge.store.reload()).toEqual({ theme: 'dark' });
    expect(fs.readFileSync(path.join(f.directory, 'claude-gui-config.json'), 'utf8')).not.toContain('runtimeConfiguration');
  });
  it('exports complete original transcript with a user dialog and zero SDK query', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    const result = await f.bridge.claude.exportTranscript({ cwd: f.directory, sid: randomUUID(), defaultName: 'original.jsonl' });
    expect(result).toMatchObject({ success: true });
    expect(fs.readFileSync(result.path, 'utf8')).toBe('literal original\n'.repeat(4001));
    expect(f.electron.dialog.showSaveDialog).toHaveBeenCalledTimes(1); expect(f.queries).toHaveLength(0);
  });
  it('raw export cannot overwrite its live source transcript even if selected explicitly', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0)); const sid = randomUUID();
    const source = path.join(f.directory, '.claude/projects/opaque', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'newer source bytes');
    f.electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: source });
    expect(await f.bridge.claude.exportTranscript({ cwd: f.directory, sessionId: sid })).toMatchObject({ success: false });
    expect(fs.readFileSync(source, 'utf8')).toBe('newer source bytes');
    expect(f.queries).toHaveLength(0);
  });
  it('raw export protects the original configuration root even if settings change during the save dialog', async () => {
    let configRoot; const f = loadMain({ runtimeEnvironment: () => ({ CLAUDE_CONFIG_DIR: configRoot }) });
    configRoot = path.join(f.directory, 'initial-root'); await new Promise(resolve => setTimeout(resolve, 0)); const sid = randomUUID();
    const source = path.join(configRoot, 'projects/opaque', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'keep source bytes');
    f.electron.dialog.showSaveDialog.mockImplementationOnce(async () => { configRoot = path.join(f.directory, 'different-root'); return { canceled: false, filePath: source }; });
    expect(await f.bridge.claude.exportTranscript({ cwd: f.directory, sessionId: sid })).toMatchObject({ success: false });
    expect(fs.readFileSync(source, 'utf8')).toBe('keep source bytes');
  });
  it('raw export atomically preserves an existing destination if publication fails and cleans only its temporary file', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    const target = path.join(f.directory, 'export.jsonl'); fs.writeFileSync(target, 'original destination');
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk error'));
    expect(await f.bridge.claude.exportTranscript({ cwd: f.directory, sessionId: randomUUID() })).toMatchObject({ success: false });
    expect(fs.readFileSync(target, 'utf8')).toBe('original destination');
    expect(fs.readdirSync(f.directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
    rename.mockRestore();
  });
  it('uses file-browser pagination, rejects external active/executable paths and unsafe URLs', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    fs.writeFileSync(path.join(f.directory, 'a.txt'), 'abcdef', { mode: 0o600 }); fs.writeFileSync(path.join(f.directory, 'b.html'), '<script/>');
    const page = await f.bridge.fs.readDir(f.directory, { limit: 1 }); expect(page.items).toHaveLength(1); expect(page.nextOffset).toBe(1);
    expect(Array.isArray(await f.bridge.fs.readDir(f.directory))).toBe(true);
    expect(await f.bridge.fs.readFile(path.join(f.directory, 'a.txt'), { offset: 2, limit: 2 })).toMatchObject({ ok: true, content: 'cd', nextOffset: 4 });
    expect(await f.bridge.fs.openExternal(path.join(f.directory, 'b.html'))).toMatchObject({ success: false });
    expect(await f.bridge.openExternal('https://user:secret@example.com')).toMatchObject({ success: false });
    expect(await f.bridge.openExternal('javascript:alert(1)')).toMatchObject({ success: false });
    expect(await f.bridge.openExternal('https://example.com/path')).toEqual({ success: true });
    expect(f.electron.shell.openExternal).toHaveBeenCalledTimes(1);
  });
  it('ignores extra client owner arguments on every native operation and rejects malformed runtime storage policy', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    f.terminal.attach = vi.fn((id, owner) => ({ id, owner }));
    f.terminal.write = vi.fn(); f.terminal.resize = vi.fn(); f.terminal.close = vi.fn();
    expect(await f.handles.get('terminal:attach')({ sender: f.windows[0].webContents }, 'term', 99)).toEqual({ id: 'term', owner: 1 });
    await f.handles.get('terminal:write')({ sender: f.windows[0].webContents }, 'term', 'input', 99);
    await f.handles.get('terminal:resize')({ sender: f.windows[0].webContents }, 'term', 80, 24, 99);
    await f.handles.get('terminal:close')({ sender: f.windows[0].webContents }, 'term', 99);
    expect(f.terminal.write).toHaveBeenCalledWith('term', 'input', 1);
    expect(f.terminal.resize).toHaveBeenCalledWith('term', 80, 24, 1);
    expect(f.terminal.close).toHaveBeenCalledWith('term', 1);
    await expect(f.bridge.runtime.set({}, { persist: false, environment: 'leak' })).rejects.toThrow('Invalid runtime storage policy');
  });
  it('rejects Claude IPC before readiness without creating a runner', async () => {
    const f = loadMain({ ready: false });
    const owned = new f.electron.BrowserWindow();
    await expect(Promise.resolve().then(() => f.handles.get('claude:start')({ sender: owned.webContents }, { conversationId: 'early', cwd: f.directory }))).rejects.toThrow('not ready');
    expect(await f.handles.get('fs:read-dir')({ sender: owned.webContents }, f.directory)).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.queries).toHaveLength(0);
  });
  it('loads PTY health without spawning and uses exact native event names', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(await f.bridge.terminal.health()).toMatchObject({ available: true }); expect(f.terminal._loadPty).toHaveBeenCalledTimes(1);
    const data = []; const exit = []; const offData = f.bridge.terminal.onData(x => data.push(x)); const offExit = f.bridge.terminal.onExit(x => exit.push(x));
    f.renderer.emit('native-terminal:data', {}, { id: 'term', data: 'literal' }); f.renderer.emit('native-terminal:exit', {}, { id: 'term', status: 'exited' });
    expect(data).toEqual([{ id: 'term', data: 'literal' }]); expect(exit).toEqual([{ id: 'term', status: 'exited' }]); offData(); offExit();
    expect(f.queries).toHaveLength(0);
  });
  it('stalled cleanup reaches the warning deadline, concurrent quit does not grow a process pool, and explicit force is bounded', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    let release; const gate = new Promise(resolve => { release = resolve; });
    f.terminal.disposeAll.mockImplementationOnce(() => gate);
    f.electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    f.forceKill.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      f.app.emit('before-quit', { preventDefault: vi.fn() });
      f.app.emit('before-quit', { preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(8000);
      expect(f.electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
      expect(f.terminal.disposeAll).toHaveBeenCalledTimes(1);
      expect(f.app.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(8000);
      expect(f.forceKill).toHaveBeenCalledTimes(1);
      expect(f.app.exit).toHaveBeenCalledWith(1);
      expect(f.app.quit).not.toHaveBeenCalled();
    } finally { release(); vi.useRealTimers(); }
  });
  it('quit cleanup failure offers explicit Retry and Force Quit; retry does not silently exit', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    f.terminal.disposeAll.mockRejectedValueOnce(new Error('unconfirmed exit'));
    f.app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['重试清理', '强制退出'], defaultId: 0, cancelId: 0 }));
    expect(f.terminal.disposeAll).toHaveBeenCalledTimes(2);
    expect(f.app.quit).toHaveBeenCalledTimes(1); expect(f.app.exit).not.toHaveBeenCalled();
  });
  it('Force Quit attempts owned-process cleanup before exit(1), never automatic force', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    let release; const gate = new Promise(resolve => { release = resolve; });
    f.terminal.disposeAll.mockRejectedValueOnce(new Error('unconfirmed exit'));
    f.electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    f.forceKill.mockImplementationOnce(async () => { await gate; return true; });
    f.app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.forceKill).toHaveBeenCalledTimes(1); expect(f.app.exit).not.toHaveBeenCalled();
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.app.exit).toHaveBeenCalledWith(1); expect(f.app.quit).not.toHaveBeenCalled();
  });
  it('Force Quit kills only recorded owned process groups, not unrelated or application PIDs', async () => {
    const owned = 2147483001; const child = owned + 1; const foreign = owned + 2;
    const ps = vi.fn((_file, _args, _options, callback) => callback(null, `${owned} ${process.pid} ${owned}\n${child} ${owned} ${owned}\n${foreign} 1 ${foreign}\n`));
    const f = loadMain({ processBoundary: { execFile: ps } }); await new Promise(resolve => setTimeout(resolve, 0));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    f.terminal.disposeAll.mockRejectedValueOnce(new Error('unconfirmed'));
    f.electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    f.app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(kill).toHaveBeenCalledWith(-owned, 'SIGKILL');
    expect(kill.mock.calls.every(([pid]) => ![process.pid, process.ppid, -process.pid, -process.ppid, foreign, -foreign].includes(pid))).toBe(true);
    expect(f.app.exit).toHaveBeenCalledWith(1);
  });
  it('Force Quit still kills owned groups when their leader exited but a recorded child remains reparented', async () => {
    const leader = 2147483111; const child = leader + 1;
    const ps = vi.fn().mockImplementationOnce((_file, _args, _options, callback) => callback(null, `${leader} ${process.pid} ${leader} Fri Nov 6 09:00:00 2026\n${child} ${leader} ${leader} Fri Nov 6 09:00:01 2026\n`))
      .mockImplementation((_file, _args, _options, callback) => callback(null, `${child} 1 ${leader} Fri Nov 6 09:00:01 2026\n`));
    const f = loadMain({ processBoundary: { execFile: ps } }); await new Promise(resolve => setTimeout(resolve, 0));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    f.terminal.disposeAll.mockRejectedValueOnce(new Error('no exit')); f.electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    f.app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(kill).toHaveBeenCalledWith(-leader, 'SIGKILL'); expect(f.app.exit).toHaveBeenCalledWith(1);
  });
  it('Force Quit never kills a reused PID/group after its originally owned process exited', async () => {
    const pid = 2147483017;
    const ps = vi.fn().mockImplementationOnce((_file, _args, _options, callback) => callback(null, `${pid} ${process.pid} ${pid} Fri Nov 6 09:00:00 2026\n`))
      .mockImplementation((_file, _args, _options, callback) => callback(null, `${pid} 1 ${pid} Fri Nov 6 09:01:00 2026\n`));
    const f = loadMain({ processBoundary: { execFile: ps } }); await new Promise(resolve => setTimeout(resolve, 0));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    f.terminal.disposeAll.mockRejectedValueOnce(new Error('no exit'));
    f.electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    f.app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(kill).not.toHaveBeenCalled(); expect(f.app.exit).toHaveBeenCalledWith(1);
  });
  it('waits for cleanup before retrying quit, and destroyed owner cannot reopen', async () => {
    const f = loadMain(); await new Promise(resolve => setTimeout(resolve, 0));
    await f.bridge.claude.start({ conversationId: 'dispose', cwd: f.directory });
    f.windows[0].destroyed = true; f.windows[0].webContents.emit('destroyed');
    await expect(f.bridge.claude.send({ conversationId: 'dispose', prompt: 'late' })).rejects.toThrow(/sender/i);
    const preventDefault = vi.fn(); f.app.emit('before-quit', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1); expect(f.app.quit).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 10)); expect(f.app.quit).toHaveBeenCalledTimes(1); expect(f.terminal.disposeAll).toHaveBeenCalledTimes(1);
  });
});
