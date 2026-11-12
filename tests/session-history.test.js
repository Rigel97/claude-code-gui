import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionHistory } from '../src/main/session-history.js';

const SID = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const dirs = [];
function setup({ custom = false, ...options } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-history-')));
  dirs.push(home);
  const cwd = path.join(home, 'workspace');
  const root = path.join(home, custom ? 'custom-config' : 'host-config');
  if (!custom) vi.stubEnv('CLAUDE_CONFIG_DIR', root);
  writeTranscript(root, cwd);
  const sdk = {
    listSessions: vi.fn(async () => [{ sessionId: SID, cwd, summary: 'Hello', lastModified: 123,
      account: { email: 'private' }, accountDetails: 'private', apiKey: 'private' }]),
    getSessionInfo: vi.fn(async () => ({ sessionId: SID, cwd, summary: 'Hello', lastModified: 123 })),
    getSessionMessages: vi.fn(async () => []),
    forkSession: vi.fn(async (_id, options = {}) => {
      const text = transcript(cwd, CHILD).replace('Named conversation', options.title || 'Named conversation')
        .replaceAll('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
        .replaceAll('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      writeTranscript(root, cwd, { sessionId: CHILD, text });
      return { sessionId: CHILD };
    }),
    renameSession: vi.fn(async (id, title) => {
      fs.appendFileSync(path.join(root, 'projects', 'opaque-folder-no-path-guess', `${id}.jsonl`),
        JSON.stringify({ type: 'custom-title', sessionId: id, customTitle: title }) + '\n');
    }),
    query: vi.fn(() => { throw new Error('Model must never start'); }),
  };
  const release = vi.fn();
  const acquireSession = vi.fn(() => release);
  const loadSdk = vi.fn(async () => sdk);
  const getRuntime = vi.fn(() => ({ env: { CLAUDE_CONFIG_DIR: root }, executable: '/never/execute' }));
  const history = new SessionHistory({ home, loadSdk, getRuntime, acquireSession, ...options });
  return { home, cwd, root, sdk, release, acquireSession, loadSdk, getRuntime, history };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function transcript(cwd, sessionId = SID) {
  return [
    { type: 'user', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', parentUuid: null, sessionId, cwd,
      timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Hello' } },
    { type: 'assistant', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', parentUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId, cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'World' }] } },
    { type: 'custom-title', sessionId, customTitle: 'Named conversation' },
    { type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'test.txt': { backupFileName: 'backup' } } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
}
function writeTranscript(root, cwd, { folder = 'opaque-folder-no-path-guess', sessionId = SID, text = transcript(cwd, sessionId) } = {}) {
  const dir = path.join(root, 'projects', folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}

describe('SessionHistory offline public boundary', () => {
  it('runs concurrent SDK forks in different custom roots without cross-root env or transcript writes', async () => {
    setup();
    const first = setup({ custom: true });
    const second = setup({ custom: true });
    fs.rmSync(path.join(second.root, 'projects'), { recursive: true });
    writeTranscript(second.root, second.cwd, { sessionId: CHILD });
    const { SessionOwnership } = await import('../src/main/session-ownership.js');
    const ownership = new SessionOwnership();
    const firstHistory = new SessionHistory({ getRuntime: first.getRuntime, acquireSession: ownership.acquire.bind(ownership) });
    const secondHistory = new SessionHistory({ getRuntime: second.getRuntime, acquireSession: ownership.acquire.bind(ownership) });
    const before = { ...process.env };
    const [a, b] = await Promise.all([
      firstHistory.fork({ cwd: first.cwd, sessionId: SID, title: 'First isolated' }),
      secondHistory.fork({ cwd: second.cwd, sessionId: CHILD, title: 'Second isolated' }),
    ]);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(process.env).toEqual(before);
    const aRaw = await firstHistory.readRaw({ cwd: first.cwd, sessionId: a.sessionId });
    const bRaw = await secondHistory.readRaw({ cwd: second.cwd, sessionId: b.sessionId });
    expect(aRaw).toContain('First isolated');
    expect(aRaw).not.toContain('Second isolated');
    expect(bRaw).toContain('Second isolated');
    expect(bRaw).not.toContain('First isolated');
    await expect(firstHistory.readRaw({ cwd: first.cwd, sessionId: b.sessionId })).rejects.toThrow(/not found/i);
    expect(ownership.owner(SID)).toBeUndefined();
    expect(ownership.owner(CHILD)).toBeUndefined();
  });
  it('rejects SDK fork success when the requested title was not persisted', async () => {
    const { history, cwd, root, sdk, release } = setup();
    const fork = sdk.forkSession.getMockImplementation();
    sdk.forkSession.mockImplementation(async () => fork(SID, { title: 'Wrong title' }));
    sdk.getSessionInfo.mockImplementation(async id => ({ sessionId: id, cwd, summary: 'Wrong title' }));
    await expect(history.fork({ cwd, sessionId: SID, title: 'Requested title' })).rejects.toThrow(/title.*persist/i);
    expect(fs.readFileSync(path.join(root, 'projects', 'opaque-folder-no-path-guess', `${SID}.jsonl`), 'utf8')).toBe(transcript(cwd));
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('preserves a persistent idle engine owner and requires it to close before a custom-root mutation', async () => {
    const { SessionOwnership } = await import('../src/main/session-ownership.js');
    const ownership = new SessionOwnership();
    const engine = { kind: 'engine', state: 'idle' };
    const unlock = ownership.acquire(SID, engine);
    const { history, cwd } = setup({ custom: true, acquireSession: ownership.acquire.bind(ownership) });
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/close.*engine/i);
    expect(ownership.owner(SID)).toBe(engine);
    unlock();
    expect((await history.fork({ cwd, sessionId: SID })).sessionId).not.toBe(SID);
    expect(ownership.owner(SID)).toBeUndefined();
  });
  it('renames a valid custom-root JSONL lacking a trailing newline without merging records', async () => {
    const { history, cwd, root } = setup({ custom: true });
    writeTranscript(root, cwd, { text: transcript(cwd).trimEnd() });
    expect(await history.rename({ cwd, sessionId: SID, title: 'No trailing newline' })).toEqual({
      sessionId: SID, cwd, title: 'No trailing newline',
    });
    expect((await history.list({ cwd }))[0].customTitle).toBe('No trailing newline');
  });
  it('uses SDK public sessionStore for custom-root mutations even with opaque native project folder encodings', async () => {
    const { history, root, cwd, release } = setup({ custom: true });
    const sourceDir = path.join(root, 'projects', 'opaque-folder-no-path-guess');
    const before = fs.readFileSync(path.join(sourceDir, `${SID}.jsonl`), 'utf8');
    const branch = await history.fork({ cwd, sessionId: SID, title: 'Opaque branch' });
    expect(branch).toEqual({ sessionId: expect.any(String), cwd, title: 'Opaque branch' });
    expect(fs.readdirSync(sourceDir).sort()).toEqual([`${SID}.jsonl`, `${branch.sessionId}.jsonl`].sort());
    await history.rename({ cwd, sessionId: branch.sessionId, title: 'Opaque renamed' });
    expect((await history.list({ cwd })).find(info => info.sessionId === branch.sessionId).customTitle).toBe('Opaque renamed');
    expect(fs.readFileSync(path.join(sourceDir, `${SID}.jsonl`), 'utf8')).toBe(before);
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('exposes only offline worker methods, validates scoped history and exits after every task', async () => {
    const { Worker } = await import('node:worker_threads');
    const { cwd, root } = setup({ custom: true });
    for (const method of ['query', 'getSessionInfo', 'getSessionMessages']) {
      const worker = new Worker(path.resolve('src/main/session-history-worker.js'), {
        env: { CLAUDE_CONFIG_DIR: root }, execArgv: [], workerData: { root, cwd, sessionId: SID, method },
      });
      let response;
      try {
        await new Promise((resolve, reject) => {
          worker.on('message', value => { response = value; });
          worker.once('error', reject);
          worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exit ${code}`)));
        });
        expect(worker.threadId).toBe(-1);
        if (method === 'query') expect(response).toEqual({ ok: false, error: 'Unsupported history worker method' });
        if (method === 'getSessionInfo') expect(response.value).toMatchObject({ sessionId: SID, cwd });
        if (method === 'getSessionMessages') expect(response.value.map(row => row.type)).toEqual(['user', 'assistant']);
      } finally { await worker.terminate(); }
    }
  });
  it('refuses invalid native-chain anchors and preserves full structured assistant carriers when forked at their final UUID', async () => {
    const { history, root, cwd, release } = setup({ custom: true });
    const folder = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    fs.rmSync(path.join(root, 'projects', 'opaque-folder-no-path-guess'), { recursive: true });
    const rows = transcript(cwd).trim().split('\n').map(JSON.parse);
    rows[1].message.content.push({ type: 'tool_use', id: 'tool-original', name: 'Read', input: { file_path: 'file.txt' } });
    rows.splice(2, 0, { type: 'assistant', uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      parentUuid: rows[1].uuid, sessionId: SID, cwd,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Structured final response' }] } });
    rows.push({ type: 'assistant', uuid: CHILD, parentUuid: rows[0].uuid, sessionId: SID, cwd,
      isSidechain: true, message: { role: 'assistant', content: 'SIDE BRANCH' } });
    const source = writeTranscript(root, cwd, { folder, text: rows.map(JSON.stringify).join('\n') + '\n' });
    const before = fs.readFileSync(source, 'utf8');
    await expect(history.fork({ cwd, sessionId: SID, upToMessageId: CHILD })).rejects.toThrow(/anchor/i);
    const branch = await history.fork({ cwd, sessionId: SID, upToMessageId: rows[2].uuid });
    const raw = await history.readRaw({ cwd, sessionId: branch.sessionId });
    expect(raw).toContain('Structured final response');
    expect(raw).toContain('tool-original');
    expect(raw).not.toContain('file-history-snapshot');
    expect(raw).not.toContain('SIDE BRANCH');
    expect(fs.readFileSync(source, 'utf8')).toBe(before);
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('rejects hard-linked mutation sources rather than appending outside the configured root', async () => {
    const { history, root, cwd, home, release } = setup({ custom: true });
    const source = writeTranscript(root, cwd);
    const outside = path.join(home, 'outside-transcript.jsonl');
    fs.linkSync(source, outside);
    const before = fs.readFileSync(outside, 'utf8');
    await expect(history.rename({ cwd, sessionId: SID, title: 'Forbidden' })).rejects.toThrow(/hard.link|unsafe/i);
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/hard.link|unsafe/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe(before);
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('rejects child system records still referring to the original session', async () => {
    const { history, root, cwd, sdk, release } = setup();
    sdk.getSessionInfo.mockImplementation(async id => ({ sessionId: id, cwd, summary: 'Branch' }));
    const fork = sdk.forkSession.getMockImplementation();
    sdk.forkSession.mockImplementation(async () => {
      const result = await fork();
      fs.appendFileSync(path.join(root, 'projects', 'opaque-folder-no-path-guess', `${CHILD}.jsonl`), JSON.stringify({
        type: 'system', subtype: 'compact_boundary', uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        parentUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sessionId: SID, cwd, content: 'Foreign session',
      }) + '\n');
      return result;
    });
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/output.*session|original.*session/i);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('postvalidates the source after SDK fork and verifies SDK rename was persisted', async () => {
    const { history, cwd, root, sdk, release } = setup();
    sdk.getSessionInfo.mockImplementation(async id => ({ sessionId: id, cwd, summary: 'Branch' }));
    const original = transcript(cwd);
    const fork = sdk.forkSession.getMockImplementation();
    sdk.forkSession.mockImplementation(async () => {
      const result = await fork();
      writeTranscript(root, cwd, { text: original + JSON.stringify({ type: 'custom-title', sessionId: SID, customTitle: 'Concurrent writer' }) + '\n' });
      return result;
    });
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/source.*changed/i);
    writeTranscript(root, cwd, { text: original });
    sdk.renameSession.mockResolvedValue(undefined);
    await expect(history.rename({ cwd, sessionId: SID, title: 'Not persisted' })).rejects.toThrow(/title.*persist/i);
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('times out a stuck worker, terminates it and keeps the lease until actual exit', async () => {
    const workerThreads = (await import('node:worker_threads')).default;
    const { EventEmitter } = await import('node:events');
    const thread = new EventEmitter();
    thread.terminate = vi.fn(async () => 1);
    const create = vi.spyOn(workerThreads, 'Worker').mockImplementation(function () { return thread; });
    const { history, cwd, release } = setup({ custom: true });
    vi.useFakeTimers();
    const pending = history.rename({ cwd, sessionId: SID, title: 'Timeout' });
    pending.catch(() => {});
    try {
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(30000);
      expect(thread.terminate).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      thread.emit('exit', 1);
      await expect(pending).rejects.toThrow(/timed out.*inspect history/i);
      expect(release).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it.each(['error', 'missing-result', 'failed-result', 'construction'])('releases worker leases after %s without silently retrying', async failure => {
    const workerThreads = (await import('node:worker_threads')).default;
    const { EventEmitter } = await import('node:events');
    const thread = new EventEmitter();
    const create = vi.spyOn(workerThreads, 'Worker').mockImplementation(function () {
      if (failure === 'construction') throw new Error('worker construction failed');
      return thread;
    });
    const { history, cwd, release } = setup({ custom: true });
    const pending = history.rename({ cwd, sessionId: SID, title: 'Failed' });
    pending.catch(() => {});
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    if (failure !== 'construction') {
      if (failure === 'error') thread.emit('error', new Error('worker runtime failed'));
      if (failure === 'failed-result') thread.emit('message', { ok: false, error: 'SDK write failed' });
      expect(release).not.toHaveBeenCalled();
      thread.emit('exit', failure === 'error' ? 1 : 0);
    }
    await expect(pending).rejects.toThrow(/worker|SDK write failed/i);
    expect(release).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('rejects worker success metadata identifying a different session or cwd', async () => {
    const workerThreads = (await import('node:worker_threads')).default;
    const { EventEmitter } = await import('node:events');
    const thread = new EventEmitter();
    const create = vi.spyOn(workerThreads, 'Worker').mockImplementation(function () { return thread; });
    const { history, cwd, release } = setup({ custom: true });
    const pending = history.rename({ cwd, sessionId: SID, title: 'Name' });
    pending.catch(() => {});
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    thread.emit('message', { ok: true, value: { sessionId: CHILD, cwd: '/different-project', title: 'Name' } });
    thread.emit('exit', 0);
    await expect(pending).rejects.toThrow(/mutation.*output|metadata/i);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('keeps the parent lease until worker exit, bounds resources and isolates env without inheriting execArgv', async () => {
    const workerThreads = (await import('node:worker_threads')).default;
    const { EventEmitter } = await import('node:events');
    const thread = new EventEmitter();
    thread.terminate = vi.fn(async () => 1);
    const create = vi.spyOn(workerThreads, 'Worker').mockImplementation(function () { return thread; });
    const { history, cwd, root, release } = setup({ custom: true });
    const pending = history.rename({ cwd, sessionId: SID, title: 'Thread renamed' });
    pending.catch(() => {});
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [file, options] = create.mock.calls[0];
    expect(file).toBe(path.resolve('src/main/session-history-worker.js'));
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(root);
    expect(options.execArgv).toEqual([]);
    expect(options.resourceLimits.maxOldGenerationSizeMb).toBeLessThanOrEqual(512);
    writeTranscript(root, cwd, { text: transcript(cwd).replace('Named conversation', 'Thread renamed') });
    thread.emit('message', { ok: true, value: { sessionId: SID, cwd, title: 'Thread renamed' } });
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    thread.emit('exit', 0);
    expect(await pending).toEqual({ sessionId: SID, cwd, title: 'Thread renamed' });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('forks inclusively at lawful system or attachment anchors on the raw main chain in a custom root', async () => {
    const { history, cwd, root } = setup({ custom: true });
    const folder = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    fs.rmSync(path.join(root, 'projects', 'opaque-folder-no-path-guess'), { recursive: true });
    const rows = transcript(cwd).trim().split('\n').map(JSON.parse).slice(0, 2);
    const system = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const attachment = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    rows.push({ type: 'system', subtype: 'compact_boundary', uuid: system, parentUuid: rows[1].uuid,
      sessionId: SID, cwd, content: 'Boundary' });
    rows.push({ type: 'attachment', uuid: attachment, parentUuid: system, sessionId: SID, cwd,
      attachment: { type: 'file', filename: 'context.txt', content: 'LOCAL' } });
    rows.push({ type: 'user', uuid: CHILD, parentUuid: attachment, sessionId: SID, cwd,
      message: { role: 'user', content: 'AFTER ANCHOR' } });
    writeTranscript(root, cwd, { folder, text: rows.map(JSON.stringify).join('\n') + '\n' });
    for (const anchor of [system, attachment]) {
      const branch = await history.fork({ cwd, sessionId: SID, upToMessageId: anchor });
      const raw = await history.readRaw({ cwd, sessionId: branch.sessionId });
      expect(raw).not.toContain('AFTER ANCHOR');
      const types = raw.trim().split('\n').map(JSON.parse).map(row => row.type);
      expect(types).toContain('system');
      if (anchor === attachment) expect(types).toContain('attachment');
    }
  });
  it('rejects fork outputs with missing files, original UUIDs or broken parent chains and still releases', async () => {
    const { history, cwd, root, sdk, release } = setup();
    sdk.getSessionInfo.mockImplementation(async id => ({ sessionId: id, cwd, summary: 'Branch' }));
    sdk.forkSession.mockResolvedValue({ sessionId: CHILD });
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/fork.*output|not found/i);
    writeTranscript(root, cwd, { sessionId: CHILD });
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/original.*UUID|fresh.*UUID/i);
    const rows = transcript(cwd, CHILD).trim().split('\n').map(JSON.parse);
    rows[0].uuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    rows[1].uuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    rows[1].parentUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    writeTranscript(root, cwd, { sessionId: CHILD, text: rows.map(JSON.stringify).join('\n') + '\n' });
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/parent.*chain/i);
    expect(release).toHaveBeenCalledTimes(3);
  });
  it('rejects SDK shadow paths through symlinked project folders before any custom-root writes', async () => {
    const { history, root, cwd, home, release } = setup({ custom: true });
    const outside = path.join(home, 'outside');
    const outsideFile = writeTranscript(outside, cwd);
    const before = fs.readFileSync(outsideFile, 'utf8');
    fs.symlinkSync(path.dirname(outsideFile), path.join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')));
    await expect(history.rename({ cwd, sessionId: SID, title: 'Forbidden' })).rejects.toThrow(/symlink|unsafe/i);
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/symlink|unsafe/i);
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(outsideFile))).toEqual([`${SID}.jsonl`]);
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('rejects a duplicated source UUID across different cwd metadata and sidechain-only sources', async () => {
    const { history, root, cwd, release } = setup({ custom: true });
    const extra = writeTranscript(root, '/another-project', { folder: 'duplicate' });
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/Ambiguous|duplicate/i);
    fs.rmSync(path.dirname(extra), { recursive: true });
    const text = transcript(cwd).trim().split('\n').map(JSON.parse).map(row => ({ ...row, isSidechain: true })).map(JSON.stringify).join('\n');
    writeTranscript(root, cwd, { text });
    await expect(history.rename({ cwd, sessionId: SID, title: 'No main chain' })).rejects.toThrow(/not found/i);
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('forks and renames real SDK custom-root history in an isolated worker without changing host env or host history', async () => {
    const host = setup();
    const custom = setup({ custom: true });
    const { SessionOwnership } = await import('../src/main/session-ownership.js');
    const ownership = new SessionOwnership();
    const { root, cwd, home } = custom;
    const source = writeTranscript(root, cwd, { folder: cwd.replace(/[^a-zA-Z0-9]/g, '-') });
    fs.rmSync(path.join(root, 'projects', 'opaque-folder-no-path-guess'), { recursive: true });
    const original = fs.readFileSync(source, 'utf8');
    const hostFile = path.join(host.root, 'projects', 'opaque-folder-no-path-guess', `${SID}.jsonl`);
    const hostText = fs.readFileSync(hostFile, 'utf8');
    const envBefore = { ...process.env };
    const release = vi.fn();
    const history = new SessionHistory({ home, getRuntime: custom.getRuntime,
      acquireSession: (id, owner) => {
        const unlock = ownership.acquire(id, owner);
        return () => { unlock(); release(); };
      } });
    const branch = await history.fork({ cwd, sessionId: SID, title: 'Custom branch',
      upToMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(branch).toEqual({ sessionId: expect.any(String), cwd, title: 'Custom branch' });
    expect(branch.sessionId).not.toBe(SID);
    const rows = (await history.readRaw({ cwd, sessionId: branch.sessionId })).trim().split('\n').map(JSON.parse);
    const messages = rows.filter(row => ['user', 'assistant'].includes(row.type));
    expect(messages).toHaveLength(2);
    expect(messages[0].uuid).not.toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(messages[1].uuid).not.toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(messages[1].parentUuid).toBe(messages[0].uuid);
    expect(messages.every(row => row.sessionId === branch.sessionId)).toBe(true);
    expect(await history.rename({ cwd, sessionId: branch.sessionId, title: 'Custom renamed' })).toEqual({
      sessionId: branch.sessionId, cwd, title: 'Custom renamed',
    });
    expect((await history.list({ cwd })).find(info => info.sessionId === branch.sessionId).customTitle).toBe('Custom renamed');
    expect(process.env).toEqual(envBefore);
    expect(fs.readFileSync(hostFile, 'utf8')).toBe(hostText);
    expect(fs.readFileSync(source, 'utf8')).toBe(original);
    expect(ownership.owner(SID)).toBeUndefined();
    expect(ownership.owner(branch.sessionId)).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('uses object owners compatible with shared ownership and caps list/read pages at 500', async () => {
    const owners = [];
    const { history, cwd, sdk, acquireSession } = setup();
    acquireSession.mockImplementation((_id, owner) => {
      if (!owner || typeof owner !== 'object') throw new Error('Object owner required');
      owners.push(owner);
      return () => {};
    });
    await history.rename({ cwd, sessionId: SID, title: 'First' });
    await history.rename({ cwd, sessionId: SID, title: 'Second' });
    expect(owners[0]).toEqual({ kind: 'history', id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(owners[1]).not.toBe(owners[0]);
    expect(owners[1].id).not.toBe(owners[0].id);
    await expect(history.list({ cwd, limit: 501 })).rejects.toThrow(/pagination/i);
    await expect(history.read({ cwd, sessionId: SID, limit: 501 })).rejects.toThrow(/pagination/i);
    await history.list({ cwd, limit: 500 });
    await history.read({ cwd, sessionId: SID, limit: 500 });
    expect(sdk.getSessionMessages).toHaveBeenCalledWith(SID, expect.objectContaining({ limit: 501 }));
  });
  it('requires SDK-known matching project metadata for host-root raw export and never returns partial JSONL', async () => {
    const { history, cwd, sdk, root } = setup();
    const text = transcript(cwd);
    expect(await history.readRaw({ cwd, sessionId: SID })).toBe(text);
    sdk.getSessionInfo.mockResolvedValue(undefined);
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/not found/i);
    sdk.getSessionInfo.mockResolvedValue({ sessionId: SID, cwd: '/wrong-project' });
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/cwd/i);
    sdk.getSessionInfo.mockResolvedValue({ sessionId: SID, cwd });
    writeTranscript(root, cwd, { text: text + '{"type":"user"' });
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/Malformed JSONL/i);
  });
  it('rejects special files without blocking, and returns an empty list only for an absent configuration root', async () => {
    const { history, cwd, root } = setup({ custom: true });
    const file = writeTranscript(root, cwd);
    fs.unlinkSync(file);
    const { execFileSync } = await import('node:child_process');
    execFileSync('/usr/bin/mkfifo', [file]);
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/regular file/i);
    fs.rmSync(root, { recursive: true });
    expect(await history.list({ cwd })).toEqual([]);
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/not found/i);
  });
  it('parses the active chain, excludes sidechains and honors system-message filtering in a custom root', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { history, cwd, root } = setup({ custom: true, loadSdk: async () => sdk });
    const rows = transcript(cwd).trim().split('\n').map(JSON.parse).slice(0, 2);
    rows.push({ type: 'assistant', uuid: CHILD, parentUuid: rows[0].uuid, sessionId: SID, cwd,
      isSidechain: true, message: { role: 'assistant', content: 'SIDECHAIN' } });
    rows.push({ type: 'system', subtype: 'compact_boundary', uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      parentUuid: rows[1].uuid, sessionId: SID, cwd, content: 'Compacted', isSidechain: false });
    rows.push({ type: 'user', uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', parentUuid: rows.at(-1).uuid,
      sessionId: SID, cwd, message: { role: 'user', content: 'Continue' } });
    writeTranscript(root, cwd, { text: rows.map(JSON.stringify).join('\n') + '\n' });
    const included = await history.read({ cwd, sessionId: SID });
    expect(included.messages.map(message => message.type)).toEqual(['user', 'assistant', 'system', 'user']);
    const excluded = await history.read({ cwd, sessionId: SID, includeSystemMessages: false });
    expect(excluded.messages.map(message => message.type)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(included)).not.toContain('SIDECHAIN');
  });
  it('lists custom-root sessions in modification order with paging and safely handles non-text prompts', async () => {
    const { history, cwd, root } = setup({ custom: true });
    const first = writeTranscript(root, cwd);
    const second = writeTranscript(root, cwd, { sessionId: CHILD });
    fs.utimesSync(first, 1, 1);
    fs.utimesSync(second, 2, 2);
    expect((await history.list({ cwd, offset: 1, limit: 1 })).map(info => info.sessionId)).toEqual([SID]);
    fs.writeFileSync(first, JSON.stringify({ type: 'user', sessionId: SID, cwd, uuid: SID,
      message: { content: [null, { type: 'image', source: {} }, { type: 'text', text: 'Known text' }] } }) + '\n');
    expect((await history.list({ cwd })).find(info => info.sessionId === SID).firstPrompt).toBe('Known text');
  });
  it('rechecks runtime roots after asynchronous anchor reads and releases without writing to a changed root', async () => {
    const { history, sdk, cwd, root, getRuntime, release } = setup();
    sdk.getSessionMessages.mockImplementation(async () => {
      getRuntime.mockReturnValue({ env: { CLAUDE_CONFIG_DIR: path.join(root, 'other') }, executable: null });
      return [{ type: 'user', uuid: CHILD }];
    });
    await expect(history.fork({ cwd, sessionId: SID, upToMessageId: CHILD })).rejects.toThrow(/root changed/i);
    expect(sdk.forkSession).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('prevents concurrent same-source mutations using distinct owners, and releases if SDK loading fails', async () => {
    const leases = new Map();
    const owners = [];
    const acquireSession = vi.fn((id, owner) => {
      owners.push(owner);
      if (leases.has(id)) return null;
      leases.set(id, owner);
      return () => leases.delete(id);
    });
    const { history, cwd, sdk } = setup({ acquireSession });
    let resolveRename;
    const rename = sdk.renameSession.getMockImplementation();
    sdk.renameSession.mockImplementation((id, title) => new Promise(resolve => {
      resolveRename = async () => { await rename(id, title); resolve(); };
    }));
    const pending = history.rename({ cwd, sessionId: SID, title: 'First' });
    await vi.waitFor(() => expect(resolveRename).toBeTypeOf('function'));
    await expect(history.rename({ cwd, sessionId: SID, title: 'Second' })).rejects.toThrow(/busy/i);
    expect(owners[0]).not.toBe(owners[1]);
    await resolveRename();
    await pending;
    expect(leases.size).toBe(0);
    const broken = setup({ loadSdk: async () => { throw new Error('SDK unavailable'); } });
    await expect(broken.history.rename({ cwd: broken.cwd, sessionId: SID, title: 'Name' })).rejects.toThrow(/SDK unavailable/i);
    expect(broken.release).toHaveBeenCalledTimes(1);
  });
  it('uses SDK 0.3.322 offline to fork fresh UUID chains and rename without altering the source', async () => {
    const { root, cwd, home, acquireSession } = setup();
    const file = writeTranscript(root, cwd, { folder: cwd.replace(/[^a-zA-Z0-9]/g, '-') });
    fs.rmSync(path.join(root, 'projects', 'opaque-folder-no-path-guess'), { recursive: true });
    const history = new SessionHistory({ home, acquireSession,
      getRuntime: () => ({ env: { CLAUDE_CONFIG_DIR: root }, executable: '/never/execute' }) });
    const original = fs.readFileSync(file, 'utf8');
    const branch = await history.fork({ cwd, sessionId: SID, title: 'Actual branch',
      upToMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(branch).toEqual({ sessionId: expect.any(String), cwd, title: 'Actual branch' });
    expect(branch.sessionId).not.toBe(SID);
    const rows = (await history.readRaw({ cwd, sessionId: branch.sessionId })).trim().split('\n').map(JSON.parse);
    const messages = rows.filter(row => ['user', 'assistant'].includes(row.type));
    expect(messages).toHaveLength(2);
    expect(messages[0].uuid).not.toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(messages[1].uuid).not.toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(messages[1].parentUuid).toBe(messages[0].uuid);
    expect(messages.every(row => row.sessionId === branch.sessionId)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    await history.rename({ cwd, sessionId: branch.sessionId, title: 'Renamed branch' });
    expect((await history.list({ cwd })).find(info => info.sessionId === branch.sessionId).customTitle).toBe('Renamed branch');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
  it('forks via SDK only while holding an exclusive source lease and releases on SDK error', async () => {
    const { history, sdk, cwd, acquireSession, release } = setup();
    const anchor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    sdk.getSessionMessages.mockResolvedValue([{ type: 'user', uuid: anchor }]);
    sdk.getSessionInfo.mockImplementation(async id => ({ sessionId: id, cwd, summary: id === SID ? 'Original' : 'Branch' }));
    expect(await history.fork({ cwd, sessionId: SID, upToMessageId: anchor, title: 'Branch' })).toEqual({
      sessionId: CHILD, cwd, title: 'Branch',
    });
    expect(acquireSession).toHaveBeenCalledWith(SID, expect.anything());
    expect(sdk.getSessionMessages).toHaveBeenCalledWith(SID, { dir: cwd, includeSystemMessages: true });
    expect(sdk.forkSession).toHaveBeenCalledWith(SID, { dir: cwd, upToMessageId: anchor, title: 'Branch' });
    expect(release).toHaveBeenCalledTimes(1);
    sdk.forkSession.mockRejectedValueOnce(new Error('disk failed'));
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/disk failed/i);
    expect(release).toHaveBeenCalledTimes(2);
    expect(sdk.query).not.toHaveBeenCalled();
  });
  it('refuses busy (including idle persistent engines), absent locks and invalid anchors', async () => {
    const { history, sdk, cwd, acquireSession, release } = setup();
    acquireSession.mockReturnValueOnce(null);
    await expect(history.fork({ cwd, sessionId: SID })).rejects.toThrow(/busy|close/i);
    expect(sdk.forkSession).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    sdk.getSessionMessages.mockResolvedValue([{ type: 'system', uuid: CHILD }]);
    await expect(history.fork({ cwd, sessionId: SID, upToMessageId: CHILD })).rejects.toThrow(/anchor/i);
    expect(release).toHaveBeenCalledTimes(1);
    const noLock = setup({ acquireSession: undefined });
    await expect(noLock.history.rename({ cwd: noLock.cwd, sessionId: SID, title: 'Rename' })).rejects.toThrow(/lock/i);
  });
  it('renames only explicitly under a lease and always releases after unknown-session or SDK failure', async () => {
    const { history, sdk, cwd, release, acquireSession } = setup();
    expect(await history.rename({ cwd, sessionId: SID, title: 'Chosen name' })).toEqual({ sessionId: SID, cwd, title: 'Chosen name' });
    expect(sdk.renameSession).toHaveBeenCalledWith(SID, 'Chosen name', { dir: cwd });
    sdk.renameSession.mockRejectedValueOnce(new Error('read only'));
    await expect(history.rename({ cwd, sessionId: SID, title: 'Other' })).rejects.toThrow(/read only/i);
    sdk.getSessionInfo.mockResolvedValue(undefined);
    await expect(history.rename({ cwd, sessionId: SID, title: 'Other' })).rejects.toThrow(/not found/i);
    expect(release).toHaveBeenCalledTimes(3);
    for (const title of ['', '  ', 'bad\nname', 'bad\0name', 42]) {
      await expect(history.rename({ cwd, sessionId: SID, title })).rejects.toThrow(/title/i);
    }
    expect(acquireSession).toHaveBeenCalledTimes(3);
    expect(sdk.query).not.toHaveBeenCalled();
  });
  it('rejects malformed JSONL, wrong identity, symlink/folder files, duplicates and oversized exports explicitly', async () => {
    const { history, root, cwd } = setup({ custom: true });
    const file = writeTranscript(root, cwd);
    fs.writeFileSync(file, transcript(cwd) + '{broken');
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/Malformed JSONL/i);
    fs.writeFileSync(file, transcript(cwd, CHILD));
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/not found/i);
    fs.unlinkSync(file);
    const outside = path.join(path.dirname(root), 'outside.jsonl');
    fs.writeFileSync(outside, transcript(cwd));
    fs.symlinkSync(outside, file);
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/symlink|regular/i);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/regular/i);
    fs.rmdirSync(file);
    fs.writeFileSync(file, transcript(cwd));
    const fd = fs.openSync(file, 'r+');
    fs.ftruncateSync(fd, 128 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/128 MiB/i);
    fs.writeFileSync(file, transcript(cwd));
    writeTranscript(root, cwd, { folder: 'another-opaque-folder' });
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/Ambiguous/i);
  });
  it('does not descend into symlinked roots/projects/project folders or nested subagent transcripts', async () => {
    const { history, root, cwd, home } = setup({ custom: true });
    const outside = path.join(home, 'outside');
    writeTranscript(outside, cwd);
    fs.rmSync(root, { recursive: true });
    fs.symlinkSync(outside, root);
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/symlink/i);
    fs.unlinkSync(root);
    fs.mkdirSync(root);
    fs.symlinkSync(path.join(outside, 'projects'), path.join(root, 'projects'));
    await expect(history.list({ cwd })).rejects.toThrow(/symlink/i);
    fs.unlinkSync(path.join(root, 'projects'));
    fs.mkdirSync(path.join(root, 'projects'));
    fs.symlinkSync(path.join(outside, 'projects', 'opaque-folder-no-path-guess'), path.join(root, 'projects', 'linked'));
    writeTranscript(root, cwd, { folder: 'normal/subagents' });
    expect(await history.list({ cwd })).toEqual([]);
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/not found/i);
  });
  it('omits untrusted object-valued metadata and rejects mixed-session or invalid UTF-8 transcripts', async () => {
    const { history, root, cwd, sdk } = setup({ custom: true });
    const file = writeTranscript(root, cwd, { text: transcript(cwd) + JSON.stringify({
      type: 'assistant', sessionId: CHILD, uuid: CHILD, cwd, message: { content: 'foreign' },
    }) + '\n' });
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/not found/i);
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
    await expect(history.readRaw({ cwd, sessionId: SID })).rejects.toThrow(/UTF-8/i);
    const host = setup();
    host.sdk.listSessions.mockResolvedValue([{ sessionId: SID, summary: { accountDetails: 'secret' }, cwd: host.cwd,
      lastModified: 1, customTitle: ['private'] }]);
    expect(await host.history.list({ cwd: host.cwd })).toEqual([{ sessionId: SID, cwd: host.cwd, lastModified: 1 }]);
    expect(sdk.query).not.toHaveBeenCalled();
  });
  it('exports exact full native JSONL from a custom root and lists local metadata without touching host SDK history', async () => {
    const { history, root, cwd, sdk } = setup({ custom: true });
    const text = transcript(cwd);
    writeTranscript(root, cwd);
    const before = { ...process.env };
    expect(await history.readRaw({ cwd, sessionId: SID })).toBe(text);
    expect(await history.full({ cwd, sid: SID })).toBe(text);
    expect(await history.list({ cwd })).toEqual([expect.objectContaining({
      sessionId: SID, cwd, customTitle: 'Named conversation', summary: 'Named conversation', firstPrompt: 'Hello',
    })]);
    expect(sdk.listSessions).not.toHaveBeenCalled();
    expect(sdk.getSessionInfo).not.toHaveBeenCalled();
    expect(process.env).toEqual(before);
    await expect(history.readRaw({ cwd: '/different', sessionId: SID })).rejects.toThrow(/not found|cwd/i);
    await expect(history.readRaw({ cwd, sessionId: CHILD })).rejects.toThrow(/not found/i);
  });
  it('uses official SDK chain parsing through an isolated in-memory store for custom-root pagination', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { history, root, cwd } = setup({ custom: true, loadSdk: async () => sdk });
    writeTranscript(root, cwd);
    const first = await history.read({ cwd, sessionId: SID, limit: 1 });
    expect(first.messages).toEqual([expect.objectContaining({ type: 'user', message: { role: 'user', content: 'Hello' } })]);
    expect(first.nextOffset).toBe(1);
    const second = await history.read({ cwd, sessionId: SID, offset: 1, limit: 1 });
    expect(second.messages).toEqual([expect.objectContaining({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'World' }] } })]);
    expect(second.nextOffset).toBe(null);
  });
  it('reads one SDK page with a lookahead and checks session cwd before reading', async () => {
    const { history, sdk, cwd } = setup();
    const messages = [1, 2, 3].map(n => ({ type: 'user', uuid: `message-${n}`, message: { content: `${n}` } }));
    sdk.getSessionMessages.mockResolvedValue(messages);
    expect(await history.read({ cwd, sessionId: SID, offset: 4, limit: 2 })).toEqual({
      messages: messages.slice(0, 2), sessionId: SID, cwd, nextOffset: 6,
    });
    expect(sdk.getSessionInfo).toHaveBeenCalledWith(SID, { dir: cwd });
    expect(sdk.getSessionMessages).toHaveBeenCalledWith(SID, { dir: cwd, offset: 4, limit: 3, includeSystemMessages: true });
    sdk.getSessionMessages.mockResolvedValue([]);
    expect((await history.read({ cwd, sessionId: SID })).nextOffset).toBe(null);
    sdk.getSessionInfo.mockResolvedValue({ sessionId: SID, cwd: '/other/project' });
    await expect(history.read({ cwd, sessionId: SID })).rejects.toThrow(/cwd|project/i);
    sdk.getSessionInfo.mockResolvedValue(undefined);
    await expect(history.read({ cwd, sessionId: SID })).rejects.toThrow(/not found/i);
    expect(sdk.query).not.toHaveBeenCalled();
  });
  it('rejects invalid paging, paths and IDs before calling SDK', async () => {
    const { history, cwd, loadSdk } = setup();
    for (const options of [{ offset: -1 }, { limit: 0 }, { limit: 1.5 }, { offset: NaN }, { limit: Infinity }]) {
      await expect(history.list({ cwd, ...options })).rejects.toThrow(/pagination/i);
      await expect(history.read({ cwd, sessionId: SID, ...options })).rejects.toThrow(/pagination/i);
    }
    await expect(history.list({ cwd: 'relative' })).rejects.toThrow(/cwd/i);
    await expect(history.read({ cwd, sessionId: '../escape' })).rejects.toThrow(/UUID/i);
    expect(loadSdk).not.toHaveBeenCalled();
  });
  it('lists via SDK with worktrees/programmatic sessions and only safe metadata', async () => {
    const { history, sdk, cwd, loadSdk } = setup();
    expect(loadSdk).not.toHaveBeenCalled();
    expect(await history.list({ cwd, offset: 2, limit: 3 })).toEqual([
      { sessionId: SID, cwd, summary: 'Hello', lastModified: 123 },
    ]);
    expect(sdk.listSessions).toHaveBeenCalledWith({ dir: cwd, offset: 2, limit: 3,
      includeWorktrees: true, includeProgrammatic: true });
    expect(sdk.query).not.toHaveBeenCalled();
  });
});
