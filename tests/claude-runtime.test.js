import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from '../src/main/store.js';
import { ClaudeRuntime } from '../src/main/claude-runtime.js';

const dirs = [];
function setup(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runtime-'));
  dirs.push(home);
  const bin = path.join(home, 'terminal-bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'claude');
  fs.writeFileSync(executable, 'not executed by these tests', { mode: 0o700 });
  const store = new Store({ filePath: path.join(home, 'runtime.json') });
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: vi.fn(value => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    }),
    decryptString: vi.fn(value => {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    }),
  };
  const execFile = vi.fn((_file, _args, _options, callback) => {
    callback(null, '2.1.0 (Claude Code)\n', '');
    return { stdin: { end: vi.fn() } };
  });
  const baseEnv = { PATH: bin, HOME: home, BUN_OPTIONS: '--existing-runtime-option' };
  const dependencies = { store, safeStorage, home, platform: 'darwin', baseEnv, execFile, ...options };
  return { ...dependencies, executable, bin, runtime: new ClaudeRuntime(dependencies) };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ClaudeRuntime fail-closed configuration boundary', () => {
  it.each(['NODE_OPTIONS', 'BUN_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'SHELL', 'CLAUDE_CODE_API_KEY_HELPER', 'ANTHROPIC_EVIL', '__proto__'])('rejects explicit %s injection atomically before importing or encrypting', async key => {
    const { runtime, store, executable, execFile, safeStorage } = setup();
    await runtime.set({ executable });
    const before = runtime.get();
    const disk = fs.readFileSync(store.filePath, 'utf8');
    await expect(runtime.set({ importLoginEnvironment: true, environmentUpdates: [
      { key: 'ANTHROPIC_API_KEY', value: 'new-secret' }, { key, value: '--preload=/private/secret' },
    ] })).rejects.toThrow(/allowlisted/);
    expect(runtime.get()).toEqual(before);
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe(disk);
    expect(execFile).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });
  it.each([
    { environmentUpdates: [{ key: 'ANTHROPIC_API_KEY', value: 'bad\0value' }] },
    { environmentUpdates: [{ key: 'PATH' }] },
    { environmentUpdates: [{ key: 'PATH', value: 42 }] },
    { environmentUpdates: [{ key: 'PATH', value: '/bin', remove: true }] },
    { environmentUpdates: [{ key: 'PATH', remove: 'yes' }] },
    { environmentUpdates: [{ key: 'PATH', value: '/bin' }, { key: 'PATH', remove: true }] },
    { environmentUpdates: [{ key: 'PATH', value: '/bin', unexpected: true }] },
    { environmentUpdates: null }, { importLoginEnvironment: 'true' }, { unexpected: true },
  ])('rejects malformed updates with no disk or process side effects: %j', async options => {
    const { runtime, store, execFile } = setup();
    await expect(runtime.set(options)).rejects.toThrow();
    expect(fs.existsSync(store.filePath)).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });
  it('refuses plaintext persistence, permits explicit volatile writes, and leaves fresh instances unchanged', async () => {
    const { runtime, store, safeStorage, home, baseEnv, execFile, executable } = setup();
    safeStorage.isEncryptionAvailable = () => false;
    const options = { executable, environmentUpdates: [{ key: 'ANTHROPIC_API_KEY', value: 'volatile-secret' }] };
    await expect(runtime.set(options)).rejects.toThrow(/encryption unavailable/i);
    expect(fs.existsSync(store.filePath)).toBe(false);
    expect(runtime.get().environmentKeys).toEqual([]);
    const result = await runtime.set(options, { persist: false });
    expect(result).toMatchObject({ persisted: false, encryptionAvailable: false, secretCount: 1 });
    expect((await runtime.resolve()).env.ANTHROPIC_API_KEY).toBe('volatile-secret');
    expect(fs.existsSync(store.filePath)).toBe(false);
    const fresh = new ClaudeRuntime({ store, safeStorage, home, baseEnv, execFile });
    expect(fresh.get().environmentKeys).toEqual([]);
    await expect(runtime.set({})).rejects.toThrow(/encryption unavailable/i);
    expect(runtime.get()).toEqual(result);
    safeStorage.isEncryptionAvailable = () => true;
    const persisted = await runtime.set({});
    expect(persisted.persisted).toBe(true);
    expect(persisted.versionFingerprint).toBe(result.versionFingerprint);
    expect(fs.readFileSync(store.filePath, 'utf8')).not.toContain('volatile-secret');
  });
  it('rejects the Linux basic_text backend even when safeStorage says encryption is available', async () => {
    const { runtime, safeStorage, store } = setup();
    safeStorage.getSelectedStorageBackend = () => 'basic_text';
    await expect(runtime.set({ environmentUpdates: [{ key: 'AWS_SESSION_TOKEN', value: 'secret' }] })).rejects.toThrow(/encryption unavailable/i);
    expect(fs.existsSync(store.filePath)).toBe(false);
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });
  it('never overwrites corrupt encrypted configuration, including an explicit volatile request', async () => {
    const { runtime, safeStorage, store, executable, execFile } = setup();
    await runtime.set({ environmentUpdates: [{ key: 'ANTHROPIC_API_KEY', value: 'original-secret' }] });
    const disk = fs.readFileSync(store.filePath, 'utf8');
    safeStorage.decryptString.mockImplementation(() => { throw new Error('decrypt original-secret'); });
    expect(() => runtime.get()).toThrow(/could not be read or decrypted/);
    await expect(runtime.resolve()).rejects.toThrow(/could not be read or decrypted/);
    await expect(runtime.diagnostics()).rejects.toThrow(/could not be read or decrypted/);
    await expect(runtime.set({ executable })).rejects.toThrow(/could not be read or decrypted/);
    await expect(runtime.set({ executable }, { persist: false })).rejects.toThrow(/could not be read or decrypted/);
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe(disk);
    expect(execFile).not.toHaveBeenCalled();
    try { runtime.get(); } catch (error) { expect(String(error)).not.toContain('original-secret'); }
  });
  it('rolls back encryption and real filesystem write failures without exposing underlying errors', async () => {
    const { runtime, store, safeStorage, executable } = setup();
    await runtime.set({ executable });
    const before = runtime.get();
    const disk = fs.readFileSync(store.filePath, 'utf8');
    const options = { environmentUpdates: [{ key: 'AWS_SECRET_ACCESS_KEY', value: 'new-secret' }] };
    safeStorage.encryptString.mockImplementationOnce(() => { throw new Error('encrypt new-secret'); });
    await expect(runtime.set(options)).rejects.toThrow('Runtime configuration could not be encrypted or saved; existing configuration was not changed');
    expect(runtime.get()).toEqual(before);
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe(disk);
    const blocked = path.join(path.dirname(store.filePath), 'not-a-directory');
    fs.writeFileSync(blocked, 'blocked');
    store.filePath = path.join(blocked, 'runtime.json');
    await expect(runtime.set(options)).rejects.toThrow('Runtime configuration could not be encrypted or saved; existing configuration was not changed');
    expect(runtime.get()).toEqual(before);
  });
  it('suppresses an inherited key when explicitly removed and can set an empty value', async () => {
    const { runtime, baseEnv, executable } = setup({ baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'inherited-secret', NODE_OPTIONS: '--existing', BUN_OPTIONS: '--existing-bun' } });
    await runtime.set({ executable, environmentUpdates: [{ key: 'ANTHROPIC_API_KEY', remove: true }] });
    expect((await runtime.resolve()).env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect((await runtime.resolve()).env.NODE_OPTIONS).toBe('--existing');
    expect(baseEnv.ANTHROPIC_API_KEY).toBe('inherited-secret');
    await runtime.set({ environmentUpdates: [{ key: 'ANTHROPIC_API_KEY', value: '' }] });
    expect((await runtime.resolve()).env.ANTHROPIC_API_KEY).toBe('');
  });
  it('keeps fingerprint, timestamp and ciphertext stable for semantic no-op updates', async () => {
    const { runtime, store, safeStorage } = setup();
    const options = { environmentUpdates: [{ key: 'AWS_REGION', value: 'us-east-1' }, { key: 'ANTHROPIC_MODEL', value: 'model-a' }] };
    const first = await runtime.set(options);
    const disk = fs.readFileSync(store.filePath, 'utf8');
    const second = await runtime.set({ environmentUpdates: [...options.environmentUpdates].reverse() });
    expect(second).toEqual(first);
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe(disk);
    expect(safeStorage.encryptString).toHaveBeenCalledOnce();
  });
});

describe('ClaudeRuntime encrypted configuration boundary', () => {
  it('atomically persists the entire environment encrypted and exposes only safe summary to clients', async () => {
    const { runtime, store, safeStorage, executable, baseEnv, home, execFile } = setup();
    const summary = await runtime.set({ executable, environmentUpdates: [
      { key: 'ANTHROPIC_API_KEY', value: 'runtime-secret-123' },
      { key: 'HTTPS_PROXY', value: 'https://user:proxy-secret@proxy.example:8080/?token=hidden' },
      { key: 'ANTHROPIC_BASE_URL', value: 'https://user:pass@api.example/v1?key=hidden#private' },
      { key: 'CLAUDE_BASH_NO_LOGIN', value: '1' },
    ] });
    expect(summary).toMatchObject({ executable, environmentKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_BASH_NO_LOGIN', 'HTTPS_PROXY'],
      secretCount: 3, encryptionAvailable: true, endpoint: 'https://api.example/v1', persisted: true });
    expect(summary.versionFingerprint).toEqual(expect.any(String));
    expect(runtime.get()).toEqual(summary);
    expect(JSON.stringify(summary)).not.toMatch(/runtime-secret|proxy-secret|hidden|user:pass/);
    const disk = fs.readFileSync(store.filePath, 'utf8');
    expect(disk).not.toMatch(/runtime-secret|proxy-secret|api\.example|CLAUDE_BASH_NO_LOGIN.*"1"/);
    expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
    const restored = new ClaudeRuntime({ store: new Store({ filePath: store.filePath }), safeStorage, home, platform: 'darwin', baseEnv, execFile });
    expect(restored.get()).toEqual(summary);
    expect((await restored.resolve()).env.ANTHROPIC_API_KEY).toBe('runtime-secret-123');
    await runtime.set({ environmentUpdates: [{ key: 'ANTHROPIC_API_KEY', remove: true }] });
    expect((await runtime.resolve()).env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(runtime.get().versionFingerprint).not.toBe(summary.versionFingerprint);
  });
});

describe('ClaudeRuntime submission snapshot boundary', () => {
  it('captures submitted updates so later caller mutations cannot change a queued transaction', async () => {
    const { runtime } = setup();
    const options = { environmentUpdates: [{ key: 'ANTHROPIC_MODEL', value: 'submitted' }] };
    const pending = runtime.set(options);
    options.environmentUpdates[0].value = 'mutated';
    await pending;
    expect((await runtime.resolve()).env.ANTHROPIC_MODEL).toBe('submitted');
  });
  it.each(['invalid-json', 'bad-schema', 'bad-base64', 'bad-decrypted-schema'])('fails closed for %s runtime files without overwriting them', async mode => {
    const { store, safeStorage, home, baseEnv, execFile, executable } = setup();
    const config = { schemaVersion: 1, executable: null, encryptedEnvironment: null, versionFingerprint: 'test', lastChangedAt: null };
    if (mode === 'bad-schema') config.schemaVersion = 99;
    if (mode === 'bad-base64') config.encryptedEnvironment = 'invalid@@';
    if (mode === 'bad-decrypted-schema') {
      config.encryptedEnvironment = safeStorage.encryptString(JSON.stringify({ environment: {}, removedKeys: [], executable: '/private/secret' })).toString('base64');
    }
    const disk = mode === 'invalid-json' ? '{private-secret' : JSON.stringify({ runtimeConfiguration: config });
    fs.writeFileSync(store.filePath, disk);
    const runtime = new ClaudeRuntime({ store: new Store({ filePath: store.filePath }), safeStorage, home, baseEnv, execFile });
    expect(() => runtime.get()).toThrow(/could not be read or decrypted/);
    await expect(runtime.set({ executable })).rejects.toThrow(/could not be read or decrypted/);
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe(disk);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('ClaudeRuntime import failure and concurrency boundary', () => {
  it.each(['exit', 'throw', 'truncated', 'banner', 'duplicate', 'oversized'])('rejects %s login output and applies neither imported nor explicit updates', async mode => {
    const { runtime, execFile, store, executable } = setup();
    await runtime.set({ executable, environmentUpdates: [{ key: 'ANTHROPIC_MODEL', value: 'original' }] });
    const before = runtime.get();
    const disk = fs.readFileSync(store.filePath, 'utf8');
    execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      if (mode === 'throw') throw new Error('private-secret');
      const output = mode === 'truncated' ? 'ANTHROPIC_API_KEY=private-secret'
        : mode === 'banner' ? 'welcome private-secret\nANTHROPIC_API_KEY=private-secret\0'
        : mode === 'duplicate' ? 'ANTHROPIC_MODEL=a\0ANTHROPIC_MODEL=b\0'
        : mode === 'oversized' ? `ANTHROPIC_API_KEY=${'x'.repeat(2 * 1024 * 1024)}\0`
        : 'ANTHROPIC_API_KEY=private-secret\0';
      callback(mode === 'exit' ? new Error('private-secret') : null, output, 'private-secret');
      return { stdin: { end: vi.fn() } };
    });
    await expect(runtime.set({ importLoginEnvironment: true, environmentUpdates: [{ key: 'ANTHROPIC_MODEL', value: 'new' }] }))
      .rejects.toThrow('Login environment import failed; no configuration was applied');
    expect(runtime.get()).toEqual(before);
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe(disk);
  });
  it('serializes concurrent imports and writes without losing updates or exposing partial state', async () => {
    const { runtime, execFile, executable } = setup();
    await runtime.set({ executable });
    let finish;
    execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      finish = callback;
      return { stdin: { end: vi.fn() } };
    });
    const importing = runtime.set({ importLoginEnvironment: true });
    await vi.waitFor(() => expect(finish).toEqual(expect.any(Function)));
    const updating = runtime.set({ environmentUpdates: [{ key: 'AWS_REGION', value: 'eu-west-1' }] });
    expect(runtime.get().environmentKeys).toEqual([]);
    finish(null, 'ANTHROPIC_API_KEY=import-secret\0', '');
    await Promise.all([importing, updating]);
    const result = await runtime.resolve();
    expect(result.env.ANTHROPIC_API_KEY).toBe('import-secret');
    expect(result.env.AWS_REGION).toBe('eu-west-1');
  });
});

describe('ClaudeRuntime explicit login import boundary', () => {
  it('imports only allowlisted NUL-delimited values after consent and lets explicit edits win without returning a dump', async () => {
    const { runtime, execFile, executable } = setup();
    await runtime.set({ executable, importLoginEnvironment: false });
    expect(execFile).not.toHaveBeenCalled();
    execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(null, 'ANTHROPIC_API_KEY=import-secret\0HTTPS_PROXY=https://user:pass@proxy.example/?secret=1\0PATH=/login/bin\0NODE_OPTIONS=--require=/evil\0BUN_OPTIONS=--preload=/evil\0UNLISTED=private\0ANTHROPIC_MODEL=imported\0', '');
      return { stdin: { end: vi.fn() } };
    });
    const summary = await runtime.set({ importLoginEnvironment: true, environmentUpdates: [
      { key: 'ANTHROPIC_MODEL', value: 'explicit' }, { key: 'HTTPS_PROXY', remove: true },
    ] });
    expect(execFile).toHaveBeenCalledWith(process.env.SHELL || '/bin/zsh', ['-ilc', '/usr/bin/env -0'],
      expect.objectContaining({ timeout: 10000, maxBuffer: 2 * 1024 * 1024, shell: false }), expect.any(Function));
    const result = await runtime.resolve();
    expect(result.env.ANTHROPIC_API_KEY).toBe('import-secret');
    expect(result.env.ANTHROPIC_MODEL).toBe('explicit');
    expect(result.env.PATH.startsWith('/login/bin:')).toBe(true);
    expect(result.env).not.toHaveProperty('NODE_OPTIONS');
    expect(result.env.BUN_OPTIONS).toBe('--existing-runtime-option');
    expect(result.env).not.toHaveProperty('HTTPS_PROXY');
    expect(result.env).not.toHaveProperty('UNLISTED');
    expect(JSON.stringify(summary)).not.toMatch(/import-secret|user:pass|private|\/login\/bin|explicit/);
  });
});

describe('ClaudeRuntime executable validation boundary', () => {
  it.each(['claude', 'alias claude=node', 'claude --version', '~/bin/claude', '$(command -v claude)', '/missing/private-secret'])('rejects non-file executable configuration %s without spawning', async executable => {
    const { runtime, store, execFile } = setup();
    await expect(runtime.set({ executable })).rejects.toThrow();
    expect(fs.existsSync(store.filePath)).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });
  it('rejects directories and non-executable files and revalidates a removed executable at resolve time', async () => {
    const { runtime, bin, executable, execFile } = setup();
    await expect(runtime.set({ executable: bin })).rejects.toThrow(/not executable/);
    fs.chmodSync(executable, 0o600);
    await expect(runtime.set({ executable })).rejects.toThrow(/not executable/);
    fs.chmodSync(executable, 0o700);
    await runtime.set({ executable });
    fs.unlinkSync(executable);
    await expect(runtime.resolve()).rejects.toThrow(/not executable/);
    expect(await runtime.diagnostics()).toMatchObject({ version: null, error: 'Claude executable not found or not executable' });
    expect(execFile).not.toHaveBeenCalled();
  });
  it('supports a literal absolute executable containing spaces and clears it back to PATH lookup', async () => {
    const { runtime, home, executable, execFile } = setup();
    const explicit = path.join(home, 'Claude CLI & literal');
    fs.writeFileSync(explicit, '', { mode: 0o700 });
    await runtime.set({ executable: explicit });
    expect((await runtime.resolve()).executable).toBe(explicit);
    await runtime.diagnostics();
    expect(execFile.mock.calls[0][0]).toBe(explicit);
    const before = runtime.get().versionFingerprint;
    await runtime.set({ executable: null });
    expect(runtime.get().executable).toBe(null);
    expect((await runtime.resolve()).executable).toBe(executable);
    expect(runtime.get().versionFingerprint).not.toBe(before);
  });
  it('falls back to home installation when earlier PATH candidates are not executable files', async () => {
    const { runtime, executable, home } = setup();
    fs.unlinkSync(executable);
    fs.mkdirSync(executable);
    const fallback = path.join(home, '.local', 'bin', 'claude');
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.writeFileSync(fallback, '', { mode: 0o700 });
    expect((await runtime.resolve()).executable).toBe(fallback);
  });
});

describe('ClaudeRuntime safe diagnostics boundary', () => {
  it.each(['timeout', 'throw', 'oversized', 'unrecognized'])('sanitizes %s version failures without forwarding stdout, stderr or the native error', async mode => {
    const { runtime, execFile, executable } = setup();
    execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      if (mode === 'throw') throw new Error('native-private-secret');
      callback(mode === 'timeout' ? Object.assign(new Error('native-private-secret'), { killed: true }) : null,
        mode === 'oversized' ? '2.1.0 ' + 's'.repeat(65536) : 'private-secret', 'private-secret');
      return { stdin: { end: vi.fn() } };
    });
    expect(await runtime.diagnostics()).toMatchObject({ executable, version: null, error: 'Claude version check failed or timed out' });
  });
  it('executes a real Node --version process, not Claude or a model request', async () => {
    const { runtime } = setup({ execFile: undefined, baseEnv: { PATH: '/bin' } });
    await runtime.set({ executable: process.execPath });
    expect(await runtime.diagnostics()).toMatchObject({ executable: process.execPath, version: process.versions.node, error: null });
  });
  it('runs only --version with closed stdin and bounded output, reporting a sanitized version and no environment', async () => {
    const { runtime, executable, execFile } = setup();
    await runtime.set({ environmentUpdates: [{ key: 'ANTHROPIC_API_KEY', value: 'sensitive-key' }] });
    const input = { end: vi.fn() };
    execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(null, '2.1.0 (Claude Code) sensitive-key https://user:pass@api.example/?secret=1\n', 'private stderr');
      return { stdin: input };
    });
    const result = await runtime.diagnostics();
    expect(result).toMatchObject({ executable, version: '2.1.0', error: null, secretCount: 1 });
    expect(execFile).toHaveBeenCalledWith(executable, ['--version'], expect.objectContaining({
      timeout: 10000, shell: false, maxBuffer: 65536, env: expect.objectContaining({ ANTHROPIC_API_KEY: 'sensitive-key' }),
    }), expect.any(Function));
    expect(input.end).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty('env');
    expect(JSON.stringify(result)).not.toMatch(/sensitive-key|private stderr|user:pass|secret=1/);
  });
});

describe('ClaudeRuntime public execution boundary', () => {
  it('resolves terminal PATH first, appends installation paths, and returns isolated inherited env without spawning', async () => {
    const { runtime, executable, home, execFile, baseEnv } = setup();
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '', { mode: 0o700 });
    const result = await runtime.resolve();
    expect(Object.keys(result).sort()).toEqual(['env', 'executable']);
    expect(result.executable).toBe(executable);
    expect(result.env.PATH.split(':')).toEqual([baseEnv.PATH, path.join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']);
    expect(result.env.BUN_OPTIONS).toBe('--existing-runtime-option');
    result.env.HOME = 'changed';
    expect((await runtime.resolve()).env.HOME).toBe(home);
    expect(baseEnv.PATH).not.toContain('/usr/local/bin');
    expect(execFile).not.toHaveBeenCalled();
  });
});
