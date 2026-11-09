const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { TextDecoder } = require('node:util');
const { randomUUID } = require('node:crypto');
const workerThreads = require('node:worker_threads');
const MAX_BYTES = 128 * 1024 * 1024;

async function directory(file) {
  const stat = await fs.lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(file) !== path.resolve(file)) {
    throw new Error('Unsafe history directory: symlink or invalid path');
  }
}
async function readFile(file) {
  await directory(path.dirname(path.dirname(file)));
  await directory(path.dirname(file));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe transcript: regular file required, symlinks rejected');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Unsafe transcript changed during open');
    if (opened.nlink !== 1) throw new Error('Unsafe transcript: hard-linked file rejected');
    if (opened.size > MAX_BYTES) throw new Error('Transcript exceeds 128 MiB export limit');
    const chunks = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_BYTES) throw new Error('Transcript exceeds 128 MiB export limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    await directory(path.dirname(path.dirname(file)));
    await directory(path.dirname(file));
    try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)), stat: opened }; }
    catch { throw new Error('Transcript has invalid UTF-8 encoding'); }
  } finally { await handle.close(); }
}
function parse(text) {
  try {
    return text.split('\n').filter(line => line.trim()).map(line => {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.type !== 'string') throw new Error();
      return row;
    });
  } catch { throw new Error('Malformed JSONL transcript'); }
}
function localInfo(rows, sessionId, stat) {
  const messages = rows.filter(row => ['user', 'assistant'].includes(row.type) && !row.isSidechain);
  const scopes = messages.filter(row => row.cwd !== undefined);
  if (!messages.length || !scopes.length || messages.some(row => row.sessionId !== sessionId)
    || scopes.some(row => typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd))) return null;
  const cwd = scopes.at(-1).cwd;
  const customTitle = rows.filter(row => row.type === 'custom-title' && typeof row.customTitle === 'string').at(-1)?.customTitle;
  const summary = rows.filter(row => row.type === 'summary' && typeof row.summary === 'string').at(-1)?.summary;
  const prompt = messages.find(row => row.type === 'user')?.message?.content;
  const firstPrompt = typeof prompt === 'string' ? prompt : Array.isArray(prompt)
    ? prompt.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
  return { sessionId, cwd, summary: customTitle || summary || firstPrompt, firstPrompt,
    ...(customTitle === undefined ? {} : { customTitle }), lastModified: Math.floor(stat.mtimeMs), fileSize: stat.size };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validate(cwd, sessionId) {
  if (typeof cwd !== 'string' || cwd.includes('\0') || !path.isAbsolute(cwd)) throw new Error('Invalid cwd: absolute project path required');
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !UUID.test(sessionId))) throw new Error('Invalid session UUID');
}
const CHAIN_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);
function validateAnchor(local, messages, anchor) {
  const rows = new Map(local.rows.filter(row => !row.isSidechain && CHAIN_TYPES.has(row.type) && row.uuid).map(row => [row.uuid, row]));
  const tail = messages.at(-1)?.uuid;
  if (!rows.has(tail)) throw new Error('Fork anchor is not on a known SDK main chain');
  // SDK omits attachments from getSessionMessages. Walk native parent links for
  // validation only; copying, truncation and UUID remapping remain SDK-owned.
  let last = tail;
  const extensions = new Set();
  while (true) {
    const next = [...rows.values()].filter(row => row.parentUuid === last && ['system', 'attachment'].includes(row.type));
    if (!next.length) break;
    if (next.length !== 1 || extensions.has(next[0].uuid)) throw new Error('Ambiguous fork anchor chain');
    last = next[0].uuid;
    extensions.add(last);
  }
  const visited = new Set();
  while (last != null) {
    if (visited.has(last) || !rows.has(last)) throw new Error('Invalid fork anchor parent chain');
    visited.add(last);
    last = rows.get(last).parentUuid;
  }
  if (!visited.has(anchor)) throw new Error('Fork anchor must be on the active native main chain');
}
function validateFork(source, output) {
  const originalIds = new Set(source.rows.filter(row => typeof row.uuid === 'string').map(row => row.uuid));
  const chain = output.rows.filter(row => !row.isSidechain && CHAIN_TYPES.has(row.type) && row.uuid);
  const byId = new Map();
  for (const row of chain) {
    if (row.sessionId !== output.sessionId || (row.cwd !== undefined && row.cwd !== output.info.cwd)) {
      throw new Error('Fork output record refers to another or original session');
    }
    if (!UUID.test(row.uuid) || originalIds.has(row.uuid) || byId.has(row.uuid)) throw new Error('Fork output must use fresh UUIDs, not original message UUIDs');
    byId.set(row.uuid, row);
  }
  const checked = new Set();
  for (const row of chain) {
    const visited = new Set();
    let id = row.uuid;
    while (id != null && !checked.has(id)) {
      if (!byId.has(id)) throw new Error('Fork output has an invalid parent UUID chain');
      if (visited.has(id)) throw new Error('Fork output has a cyclic parent UUID chain');
      visited.add(id);
      id = byId.get(id).parentUuid;
    }
    for (const id of visited) checked.add(id);
  }
}
function validateTitle(title) {
  if (typeof title !== 'string' || !title.trim() || /[\x00-\x1f\x7f]/.test(title)) throw new Error('Invalid title: nonempty single-line string required');
}
function page(offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || !Number.isSafeInteger(offset + limit + 1)) throw new Error('Invalid pagination');
}
const METADATA = ['sessionId', 'summary', 'lastModified', 'fileSize', 'customTitle',
  'firstPrompt', 'gitBranch', 'cwd', 'tag', 'createdAt'];
function safeMetadata(info) {
  return Object.fromEntries(METADATA.filter(key => Object.hasOwn(info, key)
    && (['lastModified', 'fileSize', 'createdAt'].includes(key)
      ? typeof info[key] === 'number' && Number.isFinite(info[key]) : typeof info[key] === 'string'))
    .map(key => [key, info[key]]));
}

class SessionHistory {
  #sdk;
  constructor({ loadSdk = () => import('@anthropic-ai/claude-agent-sdk'),
    getRuntime = () => ({ env: { ...process.env }, executable: null }), acquireSession,
    home = os.homedir() } = {}) {
    this.loadSdk = loadSdk;
    this.getRuntime = getRuntime;
    this.acquireSession = acquireSession;
    this.home = home;
  }
  async #load() { return this.#sdk ??= await this.loadSdk(); }
  async #context() {
    const runtime = await this.getRuntime();
    if (!runtime || !runtime.env || typeof runtime.env !== 'object') throw new Error('Invalid runtime environment');
    const configured = runtime.env.CLAUDE_CONFIG_DIR || path.join(this.home, '.claude');
    if (typeof configured !== 'string' || configured.includes('\0') || !path.isAbsolute(configured)) throw new Error('Invalid CLAUDE_CONFIG_DIR');
    // macOS exposes /var and /tmp through symlinks. Canonicalize ancestors so
    // OS aliases work, but never resolve the final component: a configured root
    // that is itself a symlink must still be rejected by directory().
    const canonical = async value => {
      const resolved = path.resolve(value);
      try {
        if ((await fs.lstat(resolved)).isSymbolicLink()) return resolved;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(resolved);
      try { return path.join(await fs.realpath(parent), path.basename(resolved)); }
      catch { return resolved; }
    };
    const root = await canonical(configured);
    const hostRoot = await canonical(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
    return { root, hostRoot, custom: root !== hostRoot, env: { ...runtime.env, CLAUDE_CONFIG_DIR: root } };
  }
  async #files(root, sessionId) {
    const projects = path.join(root, 'projects');
    try { await directory(root); await directory(projects); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const files = [];
    for (const entry of await fs.readdir(projects, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = path.join(projects, entry.name);
      await directory(dir);
      for (const child of await fs.readdir(dir, { withFileTypes: true })) {
        const id = child.name.slice(0, -6);
        if (!child.name.endsWith('.jsonl') || !UUID.test(id) || (sessionId && id !== sessionId)) continue;
        files.push({ file: path.join(dir, child.name), sessionId: id });
      }
    }
    return files;
  }
  async #local(root, cwd, sessionId, metadataOnly = false) {
    const found = [];
    const candidates = await this.#files(root, sessionId);
    if (sessionId && candidates.length > 1) throw new Error('Ambiguous session UUID in configured root');
    for (const candidate of candidates) {
      const { text, stat } = await readFile(candidate.file);
      const rows = parse(text);
      const info = localInfo(rows, candidate.sessionId, stat);
      if (info && path.resolve(info.cwd) === path.resolve(cwd)) {
        found.push(metadataOnly ? { info } : { ...candidate, text, rows, info });
      }
    }
    return found;
  }
  #sessionStore(context, cwd, local, method) {
    const dir = path.dirname(local.file);
    let projectKey;
    let createdId;
    const checkKey = key => {
      if (!key || key.subpath !== undefined || !UUID.test(key.sessionId) || typeof key.projectKey !== 'string') {
        throw new Error('Invalid scoped history store key');
      }
      projectKey ??= key.projectKey;
      if (projectKey !== key.projectKey) throw new Error('History store project key mismatch');
    };
    return {
      load: async key => {
        checkKey(key);
        if (![local.sessionId, createdId].includes(key.sessionId)) return null;
        const [session] = await this.#local(context.root, cwd, key.sessionId);
        if (!session || path.dirname(session.file) !== dir) return null;
        return session.rows;
      },
      append: async (key, entries) => {
        checkKey(key);
        const source = key.sessionId === local.sessionId;
        if ((method === 'renameSession' && !source) || (method === 'forkSession' && source)
          || !['renameSession', 'forkSession'].includes(method)
          || (!source && createdId && createdId !== key.sessionId)) throw new Error('History store write outside mutation scope');
        if (!Array.isArray(entries) || entries.some(row => !row || typeof row.type !== 'string')) throw new Error('Invalid SDK transcript entries');
        await this.#writeDirectories(context.root);
        await directory(dir);
        const file = path.join(dir, `${key.sessionId}.jsonl`);
        const create = !source && !createdId;
        if (create && (await this.#files(context.root, key.sessionId)).length) throw new Error('Fork UUID already exists');
        const current = create ? null : await readFile(file);
        const before = current?.stat;
        if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) throw new Error('Unsafe history store write path');
        const flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          | (create ? constants.O_CREAT | constants.O_EXCL : constants.O_APPEND);
        const handle = await fs.open(file, flags, 0o600);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1 || (before && (stat.ino !== before.ino || stat.dev !== before.dev))) throw new Error('Unsafe history store file changed');
          const separator = current?.text && !current.text.endsWith('\n') ? '\n' : '';
          const text = separator + entries.map(row => JSON.stringify(row)).join('\n') + '\n';
          if (stat.size + Buffer.byteLength(text) > MAX_BYTES) throw new Error('Transcript exceeds 128 MiB limit');
          await handle.writeFile(text, 'utf8');
          if (create) createdId = key.sessionId;
        } finally { await handle.close(); }
      },
    };
  }
  async #offlineSdk(context, cwd, local, method) {
    const sdk = await this.#load();
    if (workerThreads.isMainThread) return sdk;
    // The isolated thread uses SDK's public storage adapter, not cwd encoding
    // guesses. Only the verified native source folder can receive an SDK fork.
    const sessionStore = this.#sessionStore(context, cwd, local, method);
    return {
      getSessionInfo: (id, options) => sdk.getSessionInfo(id, { ...options, sessionStore }),
      getSessionMessages: (id, options) => sdk.getSessionMessages(id, { ...options, sessionStore }),
      forkSession: (id, options) => sdk.forkSession(id, { ...options, sessionStore }),
      renameSession: (id, title, options) => sdk.renameSession(id, title, { ...options, sessionStore }),
    };
  }
  async readRaw({ cwd, sessionId }) {
    validate(cwd, sessionId);
    if (!sessionId) throw new Error('Invalid session UUID');
    const context = await this.#context();
    const [local] = await this.#local(context.root, cwd, sessionId);
    if (!local) throw new Error('Session not found in configured project root');
    if (!context.custom) await this.#info(await this.#offlineSdk(context, cwd, local, 'getSessionInfo'), cwd, sessionId);
    return local.text;
  }
  async full({ cwd, sid }) { return this.readRaw({ cwd, sessionId: sid }); }
  async #writeDirectories(root) {
    await directory(root);
    const projects = path.join(root, 'projects');
    await directory(projects);
    // SDK resolution may prefer a folder different from our metadata match.
    // Reject every symlinked project entry before letting SDK resolve any path.
    for (const entry of await fs.readdir(projects, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Unsafe mutation directory: symlink project folder');
      if (entry.isDirectory()) await directory(path.join(projects, entry.name));
    }
  }
  async #worker(context, method, cwd, sessionId, options) {
    return new Promise((resolve, reject) => {
      const worker = new workerThreads.Worker(path.join(__dirname, 'session-history-worker.js'), {
        env: context.env, execArgv: [], workerData: { root: context.root, method, cwd, sessionId, options },
        resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
      let response;
      let failure;
      const timer = setTimeout(() => {
        failure = new Error('History worker timed out; mutation may have completed, inspect history before retrying');
        worker.terminate().catch(() => {});
      }, 30000);
      worker.on('message', message => { response = message; });
      worker.on('error', error => { failure = error; });
      // Receiving a result is not completion: the shared lease stays held until exit.
      worker.once('exit', code => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0 || !response) reject(new Error('History worker exited without a result'));
        else if (response.ok !== true) reject(new Error(response.error || 'History worker failed'));
        else resolve(response.value);
      });
    });
  }
  async #mutation(cwd, sessionId, operation, workerTask) {
    validate(cwd, sessionId);
    if (!sessionId) throw new Error('Invalid session UUID');
    const context = await this.#context();
    if (typeof this.acquireSession !== 'function') throw new Error('Shared exclusive session lock is required');
    // A unique owner per operation avoids reentrant acquisition across overlapping calls.
    const owner = { kind: 'history', id: randomUUID() };
    let release;
    try { release = await this.acquireSession(sessionId, owner); }
    catch (error) {
      if (/already owned|busy/i.test(error?.message || '')) {
        throw new Error('Session busy: close the engine (including persistent idle engines) before modifying history', { cause: error });
      }
      throw error;
    }
    if (typeof release !== 'function') throw new Error('Session busy: close the engine (including persistent idle engines) before modifying history');
    try {
      await this.#writeDirectories(context.root);
      const [local] = await this.#local(context.root, cwd, sessionId);
      if (!local) throw new Error('Session not found in configured project root');
      const checkRoot = async () => {
        const latest = await this.#context();
        if (latest.root !== context.root || latest.hostRoot !== context.hostRoot) throw new Error('Runtime history root changed during operation');
      };
      await checkRoot();
      if (context.custom) {
        const result = await this.#worker(context, workerTask.method, cwd, sessionId, workerTask.options);
        await checkRoot();
        if (!result || result.cwd !== cwd || typeof result.title !== 'string'
          || (workerTask.method === 'renameSession' && (result.sessionId !== sessionId || result.title !== workerTask.options.title))) {
          throw new Error('Invalid mutation output metadata');
        }
        const targetId = workerTask.method === 'forkSession' ? result.sessionId : sessionId;
        validate(cwd, targetId);
        if (!targetId || (workerTask.method === 'forkSession' && targetId === sessionId)) throw new Error('Invalid fork output UUID');
        const [output] = await this.#local(context.root, cwd, targetId);
        if (!output) throw new Error('Mutation output session not found');
        if (workerTask.method === 'forkSession') {
          const [sourceAfter] = await this.#local(context.root, cwd, sessionId);
          if (!sourceAfter || sourceAfter.text !== local.text) throw new Error('Fork source changed during operation; inspect history before retrying');
          validateFork(local, output);
          if (workerTask.options.title !== undefined && output.info.customTitle !== workerTask.options.title) throw new Error('Fork output title did not persist');
        }
        else if (output.info.customTitle !== workerTask.options.title) throw new Error('Rename output title did not persist');
        return { sessionId: targetId, cwd, title: result.title };
      }
      const sdk = await this.#offlineSdk(context, cwd, local, workerTask.method);
      await this.#info(sdk, cwd, sessionId);
      await checkRoot();
      return await operation(sdk, local, checkRoot, context);
    } finally { await release(); }
  }
  // Offline transcript branch, inclusive through upToMessageId. Never rewinds
  // worktree files or promises that file-history backups are restored.
  async fork({ cwd, sessionId, upToMessageId, title }) {
    if (title !== undefined) validateTitle(title);
    if (upToMessageId !== undefined && (typeof upToMessageId !== 'string' || !UUID.test(upToMessageId))) throw new Error('Invalid fork anchor UUID');
    return this.#mutation(cwd, sessionId, async (sdk, local, checkRoot, context) => {
      if (upToMessageId !== undefined) {
        const messages = await sdk.getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true });
        await checkRoot();
        validateAnchor(local, messages, upToMessageId);
      }
      await checkRoot();
      const result = await sdk.forkSession(sessionId, { dir: cwd,
        ...(upToMessageId === undefined ? {} : { upToMessageId }), ...(title === undefined ? {} : { title }) });
      if (!result || !UUID.test(result.sessionId) || result.sessionId === sessionId) throw new Error('SDK fork did not return a fresh session UUID');
      const info = await this.#info(sdk, cwd, result.sessionId);
      const [output] = await this.#local(context.root, cwd, result.sessionId);
      if (!output) throw new Error('Fork output session not found');
      const [sourceAfter] = await this.#local(context.root, cwd, sessionId);
      if (!sourceAfter || sourceAfter.text !== local.text) throw new Error('Fork source changed during operation; inspect history before retrying');
      validateFork(local, output);
      if (title !== undefined && output.info.customTitle !== title) throw new Error('Fork output title did not persist');
      await checkRoot();
      return { sessionId: result.sessionId, cwd, title: title ?? info.customTitle ?? info.summary };
    }, { method: 'forkSession', options: { upToMessageId, title } });
  }
  async rename({ cwd, sessionId, title }) {
    validateTitle(title);
    return this.#mutation(cwd, sessionId, async (sdk, local, checkRoot, context) => {
      await sdk.renameSession(sessionId, title, { dir: cwd });
      await checkRoot();
      const [output] = await this.#local(context.root, cwd, sessionId);
      if (!output || output.info.customTitle !== title) throw new Error('Rename output title did not persist');
      return { sessionId, cwd, title };
    }, { method: 'renameSession', options: { title } });
  }
  async list({ cwd, offset = 0, limit = 50 }) {
    validate(cwd);
    page(offset, limit);
    const context = await this.#context();
    if (context.custom) {
      return (await this.#local(context.root, cwd, undefined, true)).map(item => safeMetadata(item.info))
        .sort((a, b) => b.lastModified - a.lastModified || a.sessionId.localeCompare(b.sessionId)).slice(offset, offset + limit);
    }
    const sdk = await this.#load();
    return (await sdk.listSessions({ dir: cwd, offset, limit, includeWorktrees: true,
      includeProgrammatic: true })).map(safeMetadata);
  }
  async #info(sdk, cwd, sessionId) {
    const info = await sdk.getSessionInfo(sessionId, { dir: cwd });
    if (!info || info.sessionId !== sessionId) throw new Error('Session not found');
    if (typeof info.cwd !== 'string' || path.resolve(info.cwd) !== path.resolve(cwd)) throw new Error('Session cwd does not match project');
    return info;
  }
  async read({ cwd, sessionId, offset = 0, limit = 200, includeSystemMessages = true }) {
    validate(cwd, sessionId);
    if (!sessionId) throw new Error('Invalid session UUID');
    page(offset, limit);
    if (typeof includeSystemMessages !== 'boolean') throw new Error('Invalid includeSystemMessages');
    const context = await this.#context();
    const sdk = await this.#load();
    let sessionStore;
    if (context.custom) {
      const [local] = await this.#local(context.root, cwd, sessionId);
      if (!local) throw new Error('Session not found in configured project root');
      sessionStore = { load: async key => key.sessionId === sessionId && !key.subpath ? local.rows : null };
    } else await this.#info(sdk, cwd, sessionId);
    const messages = await sdk.getSessionMessages(sessionId, { dir: cwd, offset, limit: limit + 1, includeSystemMessages,
      ...(sessionStore ? { sessionStore } : {}) });
    return { messages: messages.slice(0, limit), sessionId, cwd, nextOffset: messages.length > limit ? offset + limit : null };
  }
}
module.exports = { SessionHistory };
