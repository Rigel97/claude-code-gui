import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProjects, collectProjectHistory, DEFAULT_LIMITS } from '../src/main/projects-scan.js';

let dir, root;
const empty = () => ({ sessions: [], conversations: [] });
const message = (id, text = '普通历史消息') => ({ id, role: 'user', timestamp: 1, blocks: [{ kind: 'text', text }] });
const session = (messages, sessionId = 's') => ({ sessionId, cwd: dir, messages });
const row = (id, text = '普通历史消息', sessionId = id) => ({ type: 'user', uuid: id, sessionId, cwd: dir,
  timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } });
const entries = [['rules', scanProjects], ['semantic', collectProjectHistory]];
const cancelled = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });

async function cli(name, contents) {
  await fs.promises.mkdir(path.join(root, 'work'), { recursive: true });
  const file = path.join(root, 'work', name + '.jsonl');
  await fs.promises.writeFile(file, contents);
  return file;
}
function watchWrites() {
  return ['writeFile', 'appendFile', 'rename', 'mkdir', 'unlink', 'rm'].map(name => vi.spyOn(fs.promises, name));
}
function expectNoWrites(spies) {
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  for (const spy of spies) spy.mockRestore();
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'projects-scan-cancel-'));
  root = path.join(dir, 'history');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe.each(entries)('%s scanner cancellation through public entry point', (_name, scan) => {
  it('rejects pre-aborted signals without opening or writing history', async () => {
    const controller = new AbortController(); controller.abort();
    const open = vi.spyOn(fs.promises, 'open');
    const writes = watchWrites();
    await expect(scan(empty(), root, DEFAULT_LIMITS, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(open).not.toHaveBeenCalled(); expectNoWrites(writes);
  });

  it('checks cancellation immediately after a file chunk and closes its read-only handle', async () => {
    const file = await cli('large', JSON.stringify(row('first')) + '\n' + ' '.repeat(150000));
    const before = await fs.promises.readFile(file);
    const signal = { aborted: false };
    const originalOpen = fs.promises.open.bind(fs.promises);
    let reads = 0;
    const close = vi.fn();
    const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      return {
        stat: () => handle.stat(),
        read: async (...readArgs) => {
          const chunk = await handle.read(...readArgs);
          reads++; signal.aborted = true;
          return chunk;
        },
        close: async () => { close(); await handle.close(); },
      };
    });
    const writes = watchWrites();
    await expect(scan(empty(), root, DEFAULT_LIMITS, signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(1); expect(close).toHaveBeenCalledOnce();
    expect(open.mock.calls[0][1]).toBe(fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    expectNoWrites(writes);
    expect(await fs.promises.readFile(file)).toEqual(before);
  });

  it('does not turn an AbortError from file IO into a warning or a successful result', async () => {
    await cli('broken-read', JSON.stringify(row('first')));
    const close = vi.fn(async () => {});
    vi.spyOn(fs.promises, 'open').mockResolvedValue({
      stat: async () => ({ isFile: () => true, size: 100 }),
      read: async () => { throw cancelled(); }, close,
    });
    const writes = watchWrites();
    await expect(scan(empty(), root, DEFAULT_LIMITS)).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce(); expectNoWrites(writes);
  });

  it('propagates cancellation from chunk progress before reading the rest of a large file', async () => {
    await cli('chunks', Array.from({ length: 2000 }, (_, i) => JSON.stringify(row(String(i)))).join('\n'));
    const controller = new AbortController();
    const progress = [];
    const writes = watchWrites();
    await expect(scan(empty(), root, DEFAULT_LIMITS, controller.signal, update => {
      progress.push(update);
      if (update.message.includes('正在读取 CLI')) controller.abort();
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress.at(-1).completed).toBeGreaterThan(0);
    expect(progress.at(-1).completed).toBeLessThan(2000);
    expect(progress.some(update => update.phase === 'finished')).toBe(false);
    expectNoWrites(writes);
  });

  it('does not swallow an AbortError thrown by GUI serialization', async () => {
    const bad = { ...message('bad'), toJSON() { throw cancelled(); } };
    const writes = watchWrites();
    await expect(scan({ sessions: [session([bad])], conversations: [] }, root, DEFAULT_LIMITS))
      .rejects.toMatchObject({ name: 'AbortError' });
    expectNoWrites(writes);
  });

  it('cancels synchronously inside a GUI message rather than finishing the large loop', async () => {
    const signal = { aborted: false };
    let serialized = 0;
    const messages = Array.from({ length: 1000 }, (_, i) => ({ ...message(String(i)), toJSON() {
      serialized++;
      if (serialized === 37) signal.aborted = true;
      return message(String(i));
    } }));
    const input = { sessions: [session(messages)], conversations: [] };
    const writes = watchWrites();
    const open = vi.spyOn(fs.promises, 'open');
    await expect(scan(input, root, DEFAULT_LIMITS, signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(serialized).toBe(37); expect(open).not.toHaveBeenCalled(); expectNoWrites(writes);
  });

  it('yields within a GUI session so a scheduled cancellation can run', async () => {
    const controller = new AbortController();
    const progress = [];
    let scheduled = false;
    const onProgress = update => {
      progress.push(update);
      if (!scheduled && update.message.includes('正在读取 GUI')) {
        scheduled = true; setImmediate(() => controller.abort());
      }
    };
    const writes = watchWrites();
    await expect(scan({ sessions: [session(Array.from({ length: 1000 }, (_, i) => message(String(i))))], conversations: [] },
      root, DEFAULT_LIMITS, controller.signal, onProgress)).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduled).toBe(true); expect(progress.some(update => update.phase === 'finished')).toBe(false);
    expectNoWrites(writes);
  });

  it('does not swallow cancellation during sorted directory iteration and closes the iterator', async () => {
    await fs.promises.mkdir(root);
    const signal = { aborted: false };
    const closed = vi.fn();
    const opendir = vi.spyOn(fs.promises, 'opendir').mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        try {
          yield { name: 'z', isDirectory: () => true };
          signal.aborted = true;
          yield { name: 'a', isDirectory: () => true };
        } finally { closed(); }
      },
    });
    const writes = watchWrites();
    await expect(scan(empty(), root, DEFAULT_LIMITS, signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(opendir).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce(); expectNoWrites(writes);
  });

  it('reports observed counts and a bounded finish, not an invented whole-history total', async () => {
    await cli('one', JSON.stringify(row('cli')) + '\n');
    const progress = [];
    const writes = watchWrites();
    await scan({ sessions: [session([message('g1'), message('g2'), message('g3')])], conversations: [] },
      root, { ...DEFAULT_LIMITS, maxMessages: 2 }, undefined, update => progress.push(update));
    expect(progress[0]).toMatchObject({ phase: 'reading', completed: 0, total: 0 });
    expect(progress.at(-1)).toMatchObject({ phase: 'finished', completed: 2, total: 2 });
    expect(progress.every(update => update.total === update.completed && update.total <= 2)).toBe(true);
    expect(progress.at(-1).message).toContain('历史总量未知');
    expect(progress.map(update => update.completed)).toEqual(progress.map(update => update.completed).sort((a, b) => a - b));
    expectNoWrites(writes);
  });
});

describe('scanner segment isolation and recognition notes', () => {
  it('multiple malformed files damage only their own retained events and preserve stable file order', async () => {
    await cli('c-broken', JSON.stringify(row('c')) + '\n{broken\n');
    await cli('a-clean', JSON.stringify(row('a')) + '\n');
    await cli('b-broken', '{broken\n' + JSON.stringify(row('b')) + '\n');
    const open = vi.spyOn(fs.promises, 'open');
    const { events, coverage } = await collectProjectHistory(empty(), root);
    expect(open.mock.calls.map(([file]) => path.basename(file))).toEqual(['a-clean.jsonl', 'b-broken.jsonl', 'c-broken.jsonl']);
    expect(events.map(event => event.id)).toEqual(['a', 'b', 'c']);
    expect(events.map(event => Boolean(event.incomplete))).toEqual([false, true, true]);
    expect(coverage.skipped).toBe(2);
  });

  it('a damaged GUI snapshot does not mark earlier entries sharing the same session as damaged', async () => {
    const input = { sessions: [session([message('clean')]), session([message('bad-segment'), { role: 'invalid' }])], conversations: [] };
    const { events } = await collectProjectHistory(input, root);
    expect(events.find(event => event.id === 'clean').incomplete).toBe(false);
    expect(events.find(event => event.id === 'bad-segment').incomplete).toBe(true);
  });

  it('keeps general rules in string recognitionNotes and actual unknowns in uncertainties', async () => {
    const input = { sessions: [session([message('goal', '开发客户信息管理平台\n1. 实现客户列表\n2. 实现客户详情')])], conversations: [] };
    const { candidates } = await scanProjects(input, root);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].recognitionNotes).toHaveLength(2);
    expect(candidates[0].recognitionNotes.every(note => typeof note === 'string')).toBe(true);
    expect(candidates[0].recognitionNotes.join('\n')).toContain('goalConfirmed');
    expect(candidates[0].uncertainties.join('\n')).not.toContain('goalConfirmed');
    expect(candidates[0].uncertainties.join('\n')).toContain('未据此推断执行状态或依赖');
  });
});
