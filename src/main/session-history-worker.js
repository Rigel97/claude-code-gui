const { parentPort, workerData, isMainThread } = require('node:worker_threads');
const path = require('node:path');

// One offline task per thread. No generic SDK dispatch and no query/prompt entrypoint.
async function run() {
  if (isMainThread || !parentPort) throw new Error('History worker requires an isolated thread');
  const { method, sessionId, cwd, root, options = {} } = workerData || {};
  if (!['getSessionInfo', 'getSessionMessages', 'forkSession', 'renameSession'].includes(method)) {
    throw new Error('Unsupported history worker method');
  }
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')
    || process.env.CLAUDE_CONFIG_DIR !== root) throw new Error('Invalid isolated history root');
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { SessionHistory } = require('./session-history.js');
  const history = new SessionHistory({ loadSdk: async () => sdk,
    getRuntime: () => ({ env: { ...process.env }, executable: null }),
    // The parent owns the shared lease until this thread exits.
    acquireSession: () => () => {} });
  if (method === 'forkSession') {
    return history.fork({ cwd, sessionId, upToMessageId: options.upToMessageId, title: options.title });
  }
  if (method === 'renameSession') return history.rename({ cwd, sessionId, title: options.title });
  const rows = (await history.readRaw({ cwd, sessionId })).split('\n').filter(line => line.trim()).map(JSON.parse);
  const sessionStore = { load: async key => key.sessionId === sessionId && !key.subpath ? rows : null };
  if (method === 'getSessionInfo') return sdk.getSessionInfo(sessionId, { dir: cwd, sessionStore });
  return sdk.getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true, sessionStore });
}

if (!isMainThread) {
  run().then(value => parentPort.postMessage({ ok: true, value }),
    error => parentPort.postMessage({ ok: false, error: error.message || 'History worker failed' }))
    .finally(() => parentPort.close());
}
