import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/main/store.js', import.meta.url), 'utf8');
let dir, filePath, Store, getPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-test-'));
  filePath = path.join(dir, 'claude-gui-config.json');
  getPath = vi.fn(() => dir);
  // Only stub Electron's path lookup: no Electron process or real userData is used.
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, Error, console, process,
    require: (name) => name === 'electron' ? { app: { getPath } } : require(name),
  }, { filename: 'store.js' });
  Store = module.exports.Store;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Store atomic persistence', () => {
  it('creates missing parent directories and persists readable config across instances', () => {
    const nested = path.join(dir, 'new', 'nested', 'config.json');
    const store = new Store({ filePath: nested });
    expect(fs.existsSync(path.dirname(nested))).toBe(false);
    store.set('history', ['first']);
    expect(new Store({ filePath: nested }).get('history')).toEqual(['first']);
    expect(fs.readdirSync(path.dirname(nested))).toEqual(['config.json']);
  });

  it('uses an exclusive 0600 sibling temp file and fsyncs/closes before atomic rename', () => {
    fs.writeFileSync(filePath, '{"key":"old"}');
    const store = new Store({ filePath });
    const open = vi.spyOn(fs, 'openSync');
    const sync = vi.spyOn(fs, 'fsyncSync');
    const close = vi.spyOn(fs, 'closeSync');
    const realRename = fs.renameSync;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((tmp, target) => {
      expect(path.dirname(tmp)).toBe(path.dirname(target));
      expect(tmp).not.toBe(target);
      expect(fs.statSync(tmp).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(target, 'utf8')).toBe('{"key":"old"}');
      expect(fs.readFileSync(tmp, 'utf8')).toBe('{"key":"new"}');
      realRename(tmp, target);
    });
    store.set('key', 'new');
    expect(open.mock.calls[0]).toEqual([expect.stringMatching(/\.tmp$/), 'wx', 0o600]);
    const fd = open.mock.results[0].value;
    expect(sync).toHaveBeenCalledWith(fd);
    expect(close).toHaveBeenCalledWith(fd);
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['claude-gui-config.json']);
  });

  it.each(['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync'])('%s failure propagates and leaves memory/disk unchanged; retry succeeds', (operation) => {
    fs.writeFileSync(filePath, '{"key":"old"}');
    const store = new Store({ filePath });
    const cause = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    vi.spyOn(fs, operation).mockImplementationOnce(() => { throw cause; });
    let error;
    try { store.set('key', 'new'); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/config.*save.*ENOSPC/i);
    expect(error.message).toContain(filePath);
    expect(error.code).toBe('ENOSPC');
    expect(error.cause).toBe(cause);
    expect(store.get('key')).toBe('old');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"key":"old"}');
    expect(fs.readdirSync(dir)).toEqual(['claude-gui-config.json']);
    store.set('key', 'new');
    expect(store.get('key')).toBe('new');
    expect(new Store({ filePath }).get('key')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['claude-gui-config.json']);
  });

  it('never overwrites or removes a temp file it could not exclusively open', () => {
    const store = new Store({ filePath });
    const realOpen = fs.openSync;
    let collision;
    vi.spyOn(fs, 'openSync').mockImplementationOnce((tmp, flags, mode) => {
      collision = tmp;
      const fd = realOpen(tmp, 'wx', mode);
      fs.writeFileSync(fd, 'someone else');
      fs.closeSync(fd);
      return realOpen(tmp, flags, mode);
    });
    expect(() => store.set('key', 'new')).toThrow(/EEXIST/);
    expect(fs.readFileSync(collision, 'utf8')).toBe('someone else');
    expect(store.get('key')).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);
    store.set('key', 'new');
    expect(store.get('key')).toBe('new');
    expect(fs.readFileSync(collision, 'utf8')).toBe('someone else');
  });

  it('serialization failure does not commit memory or prevent a valid retry', () => {
    const store = new Store({ filePath });
    const circular = {};
    circular.self = circular;
    expect(() => store.set('key', circular)).toThrow(/circular/i);
    expect(store.get('key')).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
    store.set('key', 'valid');
    expect(new Store({ filePath }).get('key')).toBe('valid');
  });

  it('skips identical loaded content without any filesystem writes', () => {
    fs.writeFileSync(filePath, '{\n  "key": {"value": 1}\n}');
    const store = new Store({ filePath });
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    const open = vi.spyOn(fs, 'openSync');
    const rename = vi.spyOn(fs, 'renameSync');
    store.set('key', { value: 1 });
    expect(mkdir).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{\n  "key": {"value": 1}\n}');
  });

  it('rename failure preserves memory and disk, and the identical failed snapshot can be retried', () => {
    fs.writeFileSync(filePath, '{"appState":{"sessions":["old"]}}');
    const store = new Store({ filePath });
    const before = fs.readFileSync(filePath, 'utf8');
    const snapshot = { sessions: ['new'] };
    const cause = Object.assign(new Error('disk denied'), { code: 'EACCES' });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw cause; });
    expect(() => store.set('appState', snapshot)).toThrow(/config.*save.*EACCES/i);
    expect(store.get('appState')).toEqual({ sessions: ['old'] });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['claude-gui-config.json']);
    store.set('appState', snapshot);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(store.get('appState')).toEqual(snapshot);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ appState: snapshot });
    expect(fs.readdirSync(dir)).toEqual(['claude-gui-config.json']);
    store.set('appState', { sessions: ['new'] });
    expect(rename).toHaveBeenCalledTimes(2);
  });
});

describe('Store load protection', () => {
  it('uses the original default userData path, but injected filePath never consults Electron', () => {
    const store = new Store();
    expect(getPath).toHaveBeenCalledWith('userData');
    expect(store.get('missing')).toBeUndefined();
    getPath.mockClear();
    const isolated = new Store({ filePath: path.join(dir, 'isolated.json') });
    expect(isolated.get('missing')).toBeUndefined();
    expect(getPath).not.toHaveBeenCalled();
  });

  it.each(['null', '[]', '42', '"text"', ''])('rejects invalid config root/content %s without overwriting it', (content) => {
    fs.writeFileSync(filePath, content);
    const store = new Store({ filePath });
    expect(() => store.load()).toThrow(/config.*load/i);
    expect(() => store.get('key')).toThrow(Error);
    expect(() => store.set('key', true)).toThrow(Error);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
  });

  it('keeps read errors explicit even for a nonexistent file, and recovers with explicit load', () => {
    const cause = Object.assign(new Error('denied'), { code: 'EACCES' });
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw cause; });
    const store = new Store({ filePath });
    read.mockRestore();
    let error;
    try { store.get('key'); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(filePath);
    expect(error.code).toBe('EACCES');
    expect(error.cause).toBe(cause);
    expect(() => store.set('key', true)).toThrow(/EACCES/);
    expect(fs.existsSync(filePath)).toBe(false);
    store.load();
    expect(store.get('key')).toBeUndefined();
  });

  it('preserves an existing file when reading fails and never treats it as empty config', () => {
    fs.writeFileSync(filePath, '{"history":["keep"]}');
    const cause = Object.assign(new Error('read failed'), { code: 'EIO' });
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw cause; });
    const store = new Store({ filePath });
    read.mockRestore();
    expect(() => store.get('history')).toThrow(/EIO/);
    expect(() => store.set('history', [])).toThrow(/EIO/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"history":["keep"]}');
    store.load();
    expect(store.get('history')).toEqual(['keep']);
  });

  it('recovers the same instance after manual repair without losing repaired history', () => {
    fs.writeFileSync(filePath, '{broken');
    const store = new Store({ filePath });
    expect(() => store.load()).toThrow(/config.*load/i);
    fs.writeFileSync(filePath, '{"history":["preserved"]}');
    expect(() => store.get('history')).toThrow(Error);
    store.load();
    expect(store.get('history')).toEqual(['preserved']);
    store.set('theme', 'dark');
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ history: ['preserved'], theme: 'dark' });
  });

  it('blocks stale memory after a subsequent load fails, and can reload repaired data', () => {
    fs.writeFileSync(filePath, '{"key":"old"}');
    const store = new Store({ filePath });
    fs.writeFileSync(filePath, '{broken');
    expect(() => store.load()).toThrow(Error);
    expect(() => store.get('key')).toThrow(Error);
    expect(() => store.set('key', 'new')).toThrow(Error);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{broken');
    fs.writeFileSync(filePath, '{"key":"repaired"}');
    store.load();
    expect(store.get('key')).toBe('repaired');
  });

  it('constructor survives corrupt JSON, reads/writes fail explicitly and preserve the file', () => {
    fs.writeFileSync(filePath, '{broken history');
    let store;
    expect(() => { store = new Store({ filePath }); }).not.toThrow();
    expect(() => store.get('appState')).toThrow(/config.*load/i);
    expect(() => store.set('appState', { sessions: [] })).toThrow(/config.*load/i);
    expect(() => store.save('{}')).toThrow(/config.*load/i);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{broken history');
    expect(fs.readdirSync(dir)).toEqual(['claude-gui-config.json']);
  });
});
