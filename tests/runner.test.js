import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const runners = [];
afterEach(async () => { await Promise.all(runners.splice(0).map(r => r.close?.())); });

function channel() {
  const values = [];
  let wake;
  let ended = false;
  return {
    push(value) { values.push(value); wake?.(); wake = undefined; },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended || values.length) {
        if (values.length) yield values.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

function fixture(overrides = {}) {
  let outputs = channel();
  const inputs = [];
  const calls = [];
  let options;
  let q;
  const makeQuery = events => Object.assign(events[Symbol.asyncIterator](), {
    initializationResult: async () => ({ commands: [{ name: 'help', description: 'Help' }], account: { apiKey: 'secret' } }),
    supportedCommands: async () => [{ name: 'help', description: 'Help' }],
    mcpServerStatus: async () => [],
    setPermissionMode: async mode => calls.push(['mode', mode]),
    cancelAsyncMessage: async id => { calls.push(['cancel', id]); return true; },
    interrupt: async () => { calls.push(['interrupt']); return { still_queued: inputs.map(m => m.uuid) }; },
    close: () => { calls.push(['close']); events.end(); },
  });
  q = makeQuery(outputs);
  const sdk = { query: ({ prompt, options: opts }) => {
    if (calls.some(c => c[0] === 'query')) { outputs = channel(); q = makeQuery(outputs); }
    options = opts;
    calls.push(['query']);
    (async () => { for await (const message of prompt) inputs.push(message); })();
    return q;
  } };
  const stream = [];
  const status = [];
  const { ClaudeRunner } = require('../src/main/runner.js');
  const runner = new ClaudeRunner('conversation', {
    loadSdk: async () => sdk,
    getRuntime: async () => ({ executable: '/fake/claude', env: { ANTHROPIC_API_KEY: 'private' }, versionFingerprint: 'v1' }),
    emitStream: ev => stream.push(ev), emitStatus: ev => status.push(ev), ...overrides,
  });
  runners.push(runner);
  return { runner, inputs, calls, stream, status, get outputs() { return outputs; }, get q() { return q; }, get options() { return options; } };
}

describe('auxiliary CLI actual-close boundary', () => {
  const { runCli } = require('../src/main/runner.js');
  const getRuntime = async () => ({ executable: process.execPath, env: process.env });

  it('cancels while runtime resolution is stalled without ever spawning', async () => {
    const controller = new AbortController();
    const registerProcess = vi.fn();
    const result = runCli([], tmpdir(), 1000, { signal: controller.signal, getRuntime: () => new Promise(() => {}), registerProcess });
    controller.abort();
    expect(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('stalled'), 80))])).toBeNull();
    expect(registerProcess).not.toHaveBeenCalled();
  });

  it('waits for real close on abort and escalates an ignoring process group', async () => {
    const controller = new AbortController();
    const onClosed = vi.fn();
    let child;
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    let settled = false;
    const operation = runCli(['-e', 'process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1000)'], tmpdir(), 10000, {
        getRuntime, signal: controller.signal, onClosed,
        registerProcess(proc) { child = proc; proc.stdout.once('data', readyResolve); },
      }).then(result => { settled = true; return result; });
    await ready;
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(child.signalCode).toBeNull();
    expect(settled).toBe(false);
    expect(onClosed).not.toHaveBeenCalled();
    await once(child, 'close');
    expect(child.signalCode).toBe('SIGKILL');
    expect(await operation).toBeNull();
    expect(onClosed).toHaveBeenCalledTimes(1);
  }, 5000);

  it('decodes split UTF-8 and returns the old result shape only after close', async () => {
    const onClosed = vi.fn();
    const result = await runCli(['-e', 'const b=Buffer.from(JSON.stringify({type:"result",result:"中文"})+"\\n"); for(const x of b) process.stdout.write(Buffer.from([x]));'], tmpdir(), 2000, { getRuntime, onClosed });
    expect(result).toEqual({ code: 0, resultEvent: { type: 'result', result: '中文' } });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown exit with retained handle and observes late close exactly once', async () => {
    const controller = new AbortController();
    const onClosed = vi.fn();
    let child, registeredClose, readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const operation = runCli(['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], tmpdir(), 10000, {
      getRuntime, signal: controller.signal, onClosed,
      registerProcess(proc, actualClose) { child = proc; registeredClose = actualClose; proc.stdout.once('data', readyResolve); },
    });
    await ready;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      const failure = operation.catch(error => error);
      controller.abort();
      await vi.advanceTimersByTimeAsync(7001);
      const error = await failure;
      expect(error).toMatchObject({ code: 'PROCESS_CLOSE_TIMEOUT', process: child, closed: registeredClose, terminated: false });
      expect(onClosed).not.toHaveBeenCalled();
      kill.mockRestore(); vi.useRealTimers();
      child.kill('SIGKILL');
      expect(await error.closed).toEqual({ code: null, signal: 'SIGKILL' });
      expect(onClosed).toHaveBeenCalledTimes(1);
    } finally { kill.mockRestore(); vi.useRealTimers(); child.kill('SIGKILL'); }
  });

  it('stops oversized auxiliary output at 8 MiB and waits for close', async () => {
    const onClosed = vi.fn();
    expect(await runCli(['-e', 'process.stdout.write("x".repeat(9*1024*1024)); setInterval(()=>{},1000)'], tmpdir(), 5000, { getRuntime, onClosed })).toBeNull();
    expect(onClosed).toHaveBeenCalledTimes(1);
  }, 5000);
});

describe('ClaudeRunner persistent SDK boundary', () => {
  it('reads structured context on the persistent public query without a prompt or another process', async () => {
    const f = fixture();
    const usage = { categories: [{ name: 'Messages', tokens: 42, color: 'blue' }], totalTokens: 42, maxTokens: 200000, rawMaxTokens: 200000, percentage: 0.021, model: 'sonnet' };
    f.q.getContextUsage = vi.fn(async () => usage);
    await f.runner.start({ cwd: tmpdir() });
    const result = await f.runner.getContextUsage();
    expect(result).toEqual({ success: true, ...usage });
    result.categories[0].tokens = 999;
    expect(usage.categories[0].tokens).toBe(42);
    expect(f.inputs).toEqual([]);
    expect(f.calls).toEqual([['query']]);
    expect(f.runner.isBusy()).toBe(false);
    expect(f.runner.getState().info.supports.contextUsage).toBe(true);
  });

  it('publishes init capabilities and CLI metadata without exposing account secrets', async () => {
    const f = fixture();
    f.q.initializationResult = async () => {
      f.outputs.push({ type: 'system', subtype: 'init', claude_code_version: '2.1.229', model: 'opus', tools: ['Read'], capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'future_cap'], permissionMode: 'default' });
      await new Promise(resolve => setTimeout(resolve, 0));
      return { account: { apiKey: 'secret' } };
    };
    const boot = await f.runner.start({ cwd: tmpdir() });
    expect(boot.info).toMatchObject({ version: '2.1.229', tools: ['Read'], capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'future_cap'],
      supports: { interruptReceipt: true, cancelQueuedAtomically: false } });
    expect(JSON.stringify(boot)).not.toContain('secret');
    boot.info.capabilities.push('mutated');
    expect(f.runner.getState().info.capabilities).not.toContain('mutated');
  });

  it('reads inline pending plan text and explicitly reports missing public plan support', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    f.q.request = vi.fn(() => { throw new Error('private request must not be used'); });
    expect(await f.runner.getPlan()).toMatchObject({ success: false, error: expect.stringContaining('public') });
    const pending = f.options.canUseTool('ExitPlanMode', { plan: '# Plan\n原始正文' }, { requestId: 'inline-plan', signal: new AbortController().signal });
    expect(await f.runner.getPlan()).toEqual({ success: true, exists: true, content: '# Plan\n原始正文', source: 'approval', requestId: 'inline-plan' });
    expect(f.runner.getState().pendingApprovals[0].planContent).toBe('# Plan\n原始正文');
    expect(f.q.request).not.toHaveBeenCalled();
    await f.runner.respond('inline-plan', { behavior: 'deny' }, 1);
    await pending;
  });

  it('does not claim stopped when a known receipt survivor cannot be cancelled', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const accepted = await f.runner.send({ prompt: 'queued' });
    f.q.cancelAsyncMessage = vi.fn(async () => false);
    f.q.interrupt = vi.fn(async () => ({ still_queued: [accepted.userMessageId, 'foreign'] }));
    expect(await f.runner.interrupt()).toMatchObject({ success: false, stillQueued: [accepted.userMessageId], error: expect.stringContaining('not guaranteed') });
    expect(f.runner.getState().pendingUserMessageIds).toEqual([accepted.userMessageId]);
    expect(f.runner.isBusy()).toBe(true);
    expect(f.q.cancelAsyncMessage.mock.calls).toEqual([[accepted.userMessageId], [accepted.userMessageId]]);
    expect(f.q.interrupt).toHaveBeenCalledTimes(1);
    expect(f.status.at(-1).status).not.toBe('aborted');
  });

  it('always invokes official interrupt when queue cancellation is unavailable or throws', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const accepted = await f.runner.send({ prompt: 'queued' });
    f.q.cancelAsyncMessage = undefined;
    f.q.interrupt = vi.fn(async () => undefined);
    expect(await f.runner.interrupt()).toMatchObject({ success: false, stillQueued: [accepted.userMessageId] });
    expect(f.q.interrupt).toHaveBeenCalledTimes(1);
    f.q.cancelAsyncMessage = async () => { throw new Error('private'); };
    expect(await f.runner.interrupt()).toMatchObject({ success: false, stillQueued: [accepted.userMessageId] });
    expect(f.q.interrupt).toHaveBeenCalledTimes(2);
  });

  it('keeps privacy and rejects stale or malformed context responses', async () => {
    const f = fixture();
    expect(await f.runner.getContextUsage()).toMatchObject({ success: false });
    await f.runner.start({ cwd: tmpdir() });
    expect(await f.runner.getContextUsage()).toMatchObject({ success: false });
    f.q.getContextUsage = async () => ({ categories: [], totalTokens: NaN, maxTokens: 1, account: 'private' });
    expect(await f.runner.getContextUsage()).toMatchObject({ success: false, error: expect.stringContaining('Invalid') });
    f.q.getContextUsage = async () => { throw new Error('Authorization: private'); };
    expect(JSON.stringify(await f.runner.getContextUsage())).not.toContain('private');
    let resolve;
    f.q.getContextUsage = () => new Promise(done => { resolve = done; });
    const reading = f.runner.getContextUsage();
    await f.runner.close();
    resolve({ categories: [], totalTokens: 0, maxTokens: 200000 });
    expect(await reading).toMatchObject({ success: false });
  });

  it('does not let foreign lifecycle events strand locally sent inputs at result', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    await f.runner.send({ prompt: 'one' });
    f.outputs.push({ type: 'command_lifecycle', command_uuid: randomUUID(), state: 'started' });
    f.outputs.push({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} });
    await vi.waitFor(() => expect(f.stream.some(e => e.type === 'result')).toBe(true));
    expect(f.runner.getState().pendingUserMessageIds).toEqual([]);
    expect(f.runner.isBusy()).toBe(false);
  });

  it('preserves SDK context message breakdown and last API usage fields', async () => {
    const f = fixture();
    const messageBreakdown = { toolCallTokens: 10, toolResultTokens: 20, attachmentTokens: 0, assistantMessageTokens: 5, userMessageTokens: 7, redirectedContextTokens: 0, unattributedTokens: 0, toolCallsByType: [], attachmentsByType: [] };
    const apiUsage = { input_tokens: 42, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 12 };
    f.q.getContextUsage = async () => ({ categories: [], totalTokens: 42, maxTokens: 200000, messageBreakdown, apiUsage, account: { token: 'private' } });
    await f.runner.start({ cwd: tmpdir() });
    expect(await f.runner.getContextUsage()).toEqual({ success: true, categories: [], totalTokens: 42, maxTokens: 200000, messageBreakdown, apiUsage });
  });

  it('redacts bootstrap errors even after the failed generation releases its lease', async () => {
    const f = fixture();
    f.q.initializationResult = async () => { throw new Error('Invalid runtime private'); };
    expect(await f.runner.start({ cwd: tmpdir() })).toEqual({ success: false, error: 'Invalid runtime [redacted]' });
    expect(f.runner.isIdle()).toBe(true);
  });

  it('preserves a supplied user UUID through accepted input and replay', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const userMessageId = randomUUID();
    expect(await f.runner.send({ prompt: '  原样\n', userMessageId })).toMatchObject({ success: true, userMessageId });
    expect(f.inputs[0]).toMatchObject({ uuid: userMessageId, message: { content: '  原样\n' } });
  });
  it('clears coalesced started UUIDs but retains a queued future turn at result', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const a = await f.runner.send({ prompt: 'one' });
    const b = await f.runner.send({ prompt: 'fold' });
    const c = await f.runner.send({ prompt: 'future' });
    for (const id of [a.userMessageId, b.userMessageId]) f.outputs.push({ type: 'command_lifecycle', command_uuid: id, state: 'started' });
    f.outputs.push({ type: 'command_lifecycle', command_uuid: c.userMessageId, state: 'queued' });
    f.outputs.push({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} });
    await vi.waitFor(() => expect(f.stream.find(e => e.type === 'result')).toMatchObject({ hasPending: true }));
    expect(f.runner.getState().pendingUserMessageIds).toEqual([c.userMessageId]);
    expect(f.status.at(-1).status).toBe('streaming');
    f.outputs.push({ type: 'command_lifecycle', command_uuid: c.userMessageId, state: 'cancelled' });
    await vi.waitFor(() => expect(f.runner.isBusy()).toBe(false));
  });

  it('keeps live mode on stale send options and merges boot options with runtime defaults', async () => {
    const f = fixture({ getRuntime: async () => ({ executable: '/fake/claude', env: {}, options: { model: 'sonnet', effortLevel: 'low' } }) });
    const boot = await f.runner.start({ cwd: tmpdir(), options: { permissionMode: 'default' } });
    expect(f.options).toMatchObject({ model: 'sonnet', effort: 'low' });
    await f.runner.setPermissionMode('plan');
    expect(await f.runner.send({ prompt: 'next', options: { permissionMode: 'default' } })).toMatchObject({ success: true, runId: boot.runId });
    expect(f.runner.getState().info.permissionMode).toBe('plan');
  });

  it('opts into dangerous skipping only for explicit bypass and forwards hook/subagent events', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    expect(f.options).toMatchObject({ forwardSubagentText: true, includeHookEvents: true });
    expect(f.options.allowDangerouslySkipPermissions).not.toBe(true);
    expect(await f.runner.setPermissionMode('bypassPermissions')).toMatchObject({ success: false });
    await f.runner.close();
    await f.runner.start({ cwd: tmpdir(), options: { permissionMode: 'bypassPermissions' } });
    expect(f.options.allowDangerouslySkipPermissions).toBe(true);
    expect(await f.runner.setPermissionMode('default')).toMatchObject({ success: true });
  });

  it('copies commands and maps actual CLI version and model from system init', async () => {
    const f = fixture();
    const commands = [{ name: 'help', description: 'Help' }];
    f.q.supportedCommands = async () => commands;
    await f.runner.start({ cwd: tmpdir() });
    f.outputs.push({ type: 'system', subtype: 'init', model: 'actual-model', claude_code_version: '2.1.229', tools: ['Read'], permissionMode: 'default' });
    await vi.waitFor(() => expect(f.runner.getState().info.version).toBe('2.1.229'));
    const copy = await f.runner.getCommands();
    copy[0].name = 'mutated';
    expect(commands[0].name).toBe('help');
    expect(f.runner.getState()).toMatchObject({ commands, info: { model: 'actual-model' } });
  });

  it.each([' ', '\n\t', 'bad\0prompt'])('rejects invalid prompt %j without sending input', async prompt => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    expect(await f.runner.send({ prompt })).toMatchObject({ success: false });
    expect(f.inputs).toEqual([]);
    expect(f.runner.isBusy()).toBe(false);
  });

  it.each(['bad\nmodel', 'bad\0model', 'x'.repeat(257)])('rejects unsafe model text before starting a query', async model => {
    const f = fixture();
    expect(await f.runner.start({ cwd: tmpdir(), options: { model } })).toMatchObject({ success: false, error: expect.stringContaining('model') });
    expect(f.calls).toEqual([]);
  });

  it('lets SDK close finish a real process gracefully without aborting its signal', async () => {
    const events = channel();
    let child, aborted = false;
    const f = fixture({ loadSdk: async () => ({ query: ({ options }) => {
      options.abortController.signal.addEventListener('abort', () => { aborted = true; });
      child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("ready"); process.stdin.resume(); process.stdin.on("end",()=>setTimeout(()=>process.exit(0),80));'], cwd: tmpdir(), env: process.env, signal: options.abortController.signal });
      return Object.assign(events[Symbol.asyncIterator](), { initializationResult: async () => { await once(child.stdout, 'data'); return {}; },
        supportedCommands: async () => [], mcpServerStatus: async () => [], close: () => { child.stdin.end(); events.end(); } });
    } }) });
    await f.runner.start({ cwd: tmpdir() });
    await f.runner.close();
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(aborted).toBe(false);
  });

  it('settles close even if a processless query throws from close', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    f.q.close = () => { f.outputs.end(); throw new Error('close exploded'); };
    expect(await f.runner.close()).toEqual({ success: true });
    expect(f.runner.isIdle()).toBe(true);
  });

  it('preserves split UTF-8 stderr, redacts split secrets, and keeps lines after forty', async () => {
    const events = channel();
    let child;
    const f = fixture({ loadSdk: async () => ({ query: ({ options }) => {
      child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], cwd: tmpdir(), env: process.env });
      return Object.assign(events[Symbol.asyncIterator](), { initializationResult: async () => { await once(child.stdout, 'data'); return {}; }, supportedCommands: async () => [], mcpServerStatus: async () => [], close: () => { child.kill(); events.end(); } });
    } }) });
    await f.runner.start({ cwd: tmpdir() });
    const text = Buffer.from('中文 private\n' + 'line\n'.repeat(45));
    for (let i = 0; i < text.length; i++) child.stderr.emit('data', text.subarray(i, i + 1));
    child.stderr.emit('end');
    expect(f.stream.filter(e => e.type === 'stderr').map(e => e.text).join('')).toBe('中文 [redacted]\n' + 'line\n'.repeat(45));
  });

  it.each([false, true])('streams long newline-free stderr safely (oversized secret: %s)', async oversized => {
    const events = channel();
    let child;
    const secret = oversized ? 'z'.repeat(65537) : 'private\nmultiline-secret';
    const f = fixture({ getRuntime: async () => ({ executable: '/fake/claude', env: { API_KEY: secret } }), loadSdk: async () => ({ query: ({ options }) => {
      child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], cwd: tmpdir(), env: process.env });
      return Object.assign(events[Symbol.asyncIterator](), { initializationResult: async () => { await once(child.stdout, 'data'); return {}; }, supportedCommands: async () => [], mcpServerStatus: async () => [], close: () => { child.kill(); events.end(); } });
    } }) });
    await f.runner.start({ cwd: tmpdir() });
    const prefix = '合法中文'.repeat(40000);
    child.stderr.emit('data', Buffer.from(prefix));
    expect(f.stream.some(e => e.type === 'stderr')).toBe(true);
    for (const text of [secret.slice(0, 7), secret.slice(7), ' tail token=', 'unknown-', 'credential', ' done']) child.stderr.emit('data', Buffer.from(text));
    child.stderr.emit('end');
    const text = f.stream.filter(e => e.type === 'stderr').map(e => e.text).join('');
    if (oversized) {
      expect(text).toContain('suppressed');
      expect(text).not.toContain('zzzz');
      expect(f.stream.some(e => e.type === 'runner_error' && e.operation === 'stderr')).toBe(true);
    } else {
      expect(text).toBe(prefix + '[redacted] tail token=[redacted] done');
      expect(f.stream.filter(e => e.type === 'stderr').every(e => e.text.length <= 65536)).toBe(true);
    }
  });

  it('does not retain an unbounded chain of overlapping known secrets', async () => {
    const events = channel();
    let child;
    const f = fixture({ getRuntime: async () => ({ executable: '/fake/claude', env: { API_KEY: 'aaaa' } }), loadSdk: async () => ({ query: ({ options }) => {
      child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], cwd: tmpdir(), env: process.env });
      return Object.assign(events[Symbol.asyncIterator](), { initializationResult: async () => { await once(child.stdout, 'data'); return {}; }, supportedCommands: async () => [], mcpServerStatus: async () => [], close: () => { child.kill(); events.end(); } });
    } }) });
    await f.runner.start({ cwd: tmpdir() });
    child.stderr.emit('data', Buffer.from('a'.repeat(100000)));
    expect(f.stream.some(e => e.type === 'stderr')).toBe(true);
    child.stderr.emit('end');
    expect(f.stream.filter(e => e.type === 'stderr').map(e => e.text).join('')).toBe('[redacted]'.repeat(25000));
  });

  it('previews rewind without writes, forwards canRewind false, and only executes explicit confirmation', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const id = randomUUID();
    const rewind = vi.fn(async (_, opts) => opts.dryRun ? { canRewind: false, error: 'Checkpoint not available' } : { canRewind: true, filesChanged: ['a'], skippedLinks: 1 });
    f.q.rewindFiles = rewind;
    expect(await f.runner.rewindFiles(id)).toMatchObject({ success: true, canRewind: false, error: 'Checkpoint not available' });
    expect(rewind.mock.calls).toEqual([[id, { dryRun: true }]]);
    expect(await f.runner.rewindFiles(id, { dryRun: false })).toMatchObject({ success: true, canRewind: true, skippedLinks: 1 });
    expect(rewind.mock.calls).toEqual([[id, { dryRun: true }], [id, { dryRun: false }]]);
  });

  it('rejects invalid/busy rewind and never retries a failed nonrecoverable write', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const rewind = vi.fn(async () => { throw new Error('write failed'); });
    f.q.rewindFiles = rewind;
    expect(await f.runner.rewindFiles('bad')).toMatchObject({ success: false });
    const id = randomUUID();
    expect(await f.runner.rewindFiles(id, { dryRun: false })).toMatchObject({ success: false, canRewind: false });
    expect(rewind).toHaveBeenCalledTimes(1);
    expect(f.runner.isBusy()).toBe(false);
    await f.runner.send({ prompt: 'busy' });
    expect(await f.runner.rewindFiles(id)).toMatchObject({ success: false });
    expect(rewind).toHaveBeenCalledTimes(1);
  });

  it('accepts standard pattern/ref/format schemas and keeps invalid forms pending with a clear error', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const schema = { type: 'object', required: ['code', 'email'], properties: {
      code: { $ref: '#/$defs/code' }, email: { type: 'string', format: 'email' } }, $defs: { code: { type: 'string', pattern: '^[A-Z]{2}$' } } };
    const pending = f.options.onElicitation({ serverName: 'server', requestedSchema: schema }, { requestId: 'standard', signal: new AbortController().signal });
    expect(await f.runner.respond('standard', { action: 'accept', content: { code: 'bad', email: 'no' } }, 1)).toMatchObject({ success: false, error: expect.stringContaining('schema') });
    expect(f.runner.getState().pendingApprovals).toHaveLength(1);
    expect(await f.runner.respond('standard', { action: 'accept', content: { code: 'AB', email: 'a@example.com' } }, 1)).toEqual({ success: true });
    expect(await pending).toMatchObject({ action: 'accept', content: { code: 'AB' } });
  });

  it('keeps an uncompileable schema pending and allows explicit decline', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const pending = f.options.onElicitation({ serverName: 'server', requestedSchema: { type: 'object', properties: { code: { type: 'string', pattern: '[' } } } }, { requestId: 'compile', signal: new AbortController().signal });
    expect(await f.runner.respond('compile', { action: 'accept', content: { code: 'a' } }, 1)).toMatchObject({ success: false, error: expect.stringContaining('schema') });
    expect(f.runner.getState().pendingApprovals).toHaveLength(1);
    await f.runner.respond('compile', { action: 'decline' }, 1);
    expect(await pending).toEqual({ action: 'decline' });
  });

  it.each(['bad', null, 17])('rejects invalid supplied user UUID %j before bootstrap', async userMessageId => {
    const f = fixture();
    expect(await f.runner.send({ cwd: tmpdir(), prompt: 'hello', userMessageId })).toMatchObject({ success: false });
    expect(f.calls).toEqual([]);
  });

  it('does not erase next-turn input sent synchronously by the result consumer', async () => {
    let runner, next;
    const statuses = [];
    const f = fixture({ emitStream: e => { if (e.type === 'result') next = runner.send({ prompt: 'next' }); }, emitStatus: e => statuses.push(e.status) });
    runner = f.runner;
    await runner.start({ cwd: tmpdir() });
    await runner.send({ prompt: 'first' });
    f.outputs.push({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} });
    await vi.waitFor(() => expect(next).toBeTruthy());
    const accepted = await next;
    expect(runner.getState().pendingUserMessageIds).toEqual([accepted.userMessageId]);
    expect(statuses.at(-1)).toBe('streaming');
  });

  it('tracks requesting and idle status without making empty bootstrap permanently busy', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    expect(f.runner.getState().state).toBe('ready');
    f.outputs.push({ type: 'system', subtype: 'status', status: 'requesting', permissionMode: 'plan' });
    await vi.waitFor(() => expect(f.runner.isBusy()).toBe(true));
    expect(f.runner.getState().info.permissionMode).toBe('plan');
    f.outputs.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    await vi.waitFor(() => expect(f.runner.isBusy()).toBe(false));
  });

  it('rejects duplicate pending UUID without duplicating the input', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const userMessageId = randomUUID();
    await f.runner.send({ prompt: 'one', userMessageId });
    expect(await f.runner.send({ prompt: 'two', userMessageId })).toMatchObject({ success: false });
    expect(f.inputs).toHaveLength(1);
  });

  it('keeps pending messages on interrupt failure and reports a safe descriptive error', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const accepted = await f.runner.send({ prompt: 'one' });
    f.q.interrupt = async () => { throw new Error('Authorization: private'); };
    expect(await f.runner.interrupt()).toMatchObject({ success: false });
    expect(f.runner.getState().pendingUserMessageIds).toEqual([accepted.userMessageId]);
    expect(f.runner.isBusy()).toBe(true);
  });

  it('does not publish a permission change when the SDK rejects it', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    f.q.setPermissionMode = async () => { throw new Error('private'); };
    expect(await f.runner.setPermissionMode('plan')).toMatchObject({ success: false });
    expect(f.runner.getState().info.permissionMode).toBe('default');
    expect(f.stream.filter(e => e.type === 'permission_mode_changed')).toEqual([]);
  });

  it('bounds malicious pattern validation off-thread and keeps cancellation available', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const pending = f.options.onElicitation({ serverName: 'server', requestedSchema: { type: 'object', properties: { text: { type: 'string', pattern: '^(a+)+$' } } } }, { requestId: 'regex', signal: new AbortController().signal });
    const response = f.runner.respond('regex', { action: 'accept', content: { text: 'a'.repeat(100) + '!' } }, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await f.runner.respond('regex', { action: 'cancel' }, 1)).toEqual({ success: true });
    expect(await pending).toEqual({ action: 'cancel' });
    expect(await response).toMatchObject({ success: false });
  });

  it('rejects oversized elicitation JSON while keeping the form pending', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const pending = f.options.onElicitation({ serverName: 'server', requestedSchema: { type: 'object' } }, { requestId: 'large', signal: new AbortController().signal });
    expect(await f.runner.respond('large', { action: 'accept', content: { text: 'x'.repeat(65537) } }, 1)).toMatchObject({ success: false });
    expect(f.runner.getState().pendingApprovals).toHaveLength(1);
    await f.runner.respond('large', { action: 'decline' }, 1);
    await pending;
  });

  it('retries shutdown after a timeout and releases only its own lease once on late close', async () => {
    const { SessionOwnership } = require('../src/main/session-ownership.js');
    const registry = new SessionOwnership();
    const release = vi.fn();
    const foreign = randomUUID();
    const foreignOwner = {};
    registry.acquire(foreign, foreignOwner);
    let child;
    const events = channel();
    const f = fixture({ acquireSession: (id, owner) => {
      const unlock = registry.acquire(id, owner);
      return () => { release(); unlock(); };
    }, loadSdk: async () => ({ query: ({ options }) => {
      child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], cwd: tmpdir(), env: process.env });
      return Object.assign(events[Symbol.asyncIterator](), {
        initializationResult: async () => { await once(child.stdout, 'data'); return {}; },
        supportedCommands: async () => [], mcpServerStatus: async () => [], close: () => events.end(),
      });
    } }) });
    const boot = await f.runner.start({ cwd: tmpdir() });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      const first = f.runner.close();
      const rejected = expect(first).rejects.toThrow('ownership retained');
      await vi.advanceTimersByTimeAsync(7001);
      await rejected;
      expect(registry.owner(boot.sessionId)).toBeTruthy();
      expect(await f.runner.send({ prompt: 'unsafe' })).toMatchObject({ success: false });
      kill.mockRestore();
      vi.useRealTimers();
      const exited = once(child, 'close');
      child.kill('SIGKILL');
      await exited;
      expect(await f.runner.close()).toEqual({ success: true });
      expect(await f.runner.close()).toEqual({ success: true });
      expect(release).toHaveBeenCalledTimes(1);
      expect(registry.owner(boot.sessionId)).toBeUndefined();
      expect(registry.owner(foreign)).toBe(foreignOwner);
    } finally {
      kill.mockRestore(); vi.useRealTimers(); child.kill('SIGKILL');
    }
  });

  it('emits a terminal safe error when pending input reaches EOF without result', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    await f.runner.send({ prompt: 'unfinished' });
    f.outputs.end();
    await vi.waitFor(() => expect(f.runner.isIdle()).toBe(true));
    expect(f.stream).toContainEqual(expect.objectContaining({ type: 'runner_error', operation: 'query', error: expect.stringContaining('result') }));
    expect(f.status.at(-1).status).toBe('error');
    expect(f.runner.getState().pendingUserMessageIds).toEqual([]);
  });

  it('does not deadlock on a processless query iterator failure', async () => {
    const f = fixture({ loadSdk: async () => ({ query: () => ({
      async *[Symbol.asyncIterator]() { await new Promise(resolve => setTimeout(resolve, 10)); throw new Error('private'); },
      initializationResult: async () => ({}), supportedCommands: async () => [], mcpServerStatus: async () => [], close() {},
    }) }) });
    await f.runner.start({ cwd: tmpdir() });
    await vi.waitFor(() => expect(f.runner.isIdle()).toBe(true));
    expect(await f.runner.close()).toEqual({ success: true });
  });

  it('bootstraps without a synthetic prompt and keeps reading after multiple results', async () => {
    const f = fixture();
    const boot = await f.runner.start({ cwd: tmpdir() });
    expect(boot).toMatchObject({ success: true, commands: [{ name: 'help' }], info: { permissionMode: 'default' } });
    expect(boot.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.inputs).toEqual([]);
    expect(f.options).toMatchObject({ systemPrompt: { type: 'preset', preset: 'claude_code' }, settingSources: ['user', 'project', 'local'], sessionId: boot.sessionId, pathToClaudeCodeExecutable: '/fake/claude' });
    expect(f.runner.isIdle()).toBe(false);
    expect(f.runner.isBusy()).toBe(false);
    const first = await f.runner.send({ prompt: '  first\n', cwd: tmpdir() });
    expect(first).toMatchObject({ success: true, sessionId: boot.sessionId, runId: boot.runId });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect(f.inputs[0]).toMatchObject({ uuid: first.userMessageId, message: { role: 'user', content: '  first\n' } });
    f.outputs.push({ type: 'user', uuid: first.userMessageId, isReplay: true, session_id: boot.sessionId, message: f.inputs[0].message });
    f.outputs.push({ type: 'result', subtype: 'success', total_cost_usd: 0.2, usage: { input_tokens: 100, output_tokens: 20 }, modelUsage: { opus: { inputTokens: 100, outputTokens: 20, costUSD: 0.2, contextWindow: 200000 } } });
    await vi.waitFor(() => expect(f.runner.isBusy()).toBe(false));
    await f.runner.send({ prompt: 'second' });
    f.outputs.push({ type: 'result', subtype: 'success', total_cost_usd: 0.5, usage: { input_tokens: 60, output_tokens: 15 }, modelUsage: { opus: { inputTokens: 160, outputTokens: 35, costUSD: 0.5, contextWindow: 200000 } } });
    await vi.waitFor(() => expect(f.stream.filter(e => e.type === 'result')).toHaveLength(2));
    const result = f.stream.filter(e => e.type === 'result')[1];
    expect(result.total_cost_usd).toBeCloseTo(0.3);
    expect(result.usage).toEqual({ input_tokens: 60, output_tokens: 15 });
    expect(result.cumulativeUsage).toMatchObject({ opus: { inputTokens: 160, outputTokens: 35 } });
    expect(result.modelUsage).toMatchObject({ opus: { inputTokens: 60, outputTokens: 15, contextWindow: 200000 } });
    expect(result.cumulativeCostUsd).toBe(0.5);
    expect(f.stream.every(e => e.conversationId === 'conversation' && e.runId === boot.runId)).toBe(true);
    expect(f.status.map(e => e.status)).toEqual(['starting', 'completed', 'completed']);
    expect(JSON.stringify(f.runner.getState())).not.toMatch(/private|secret|first/);
    expect(f.calls.filter(c => c[0] === 'query')).toHaveLength(1);
  });

  it('cancels known async UUIDs before and after interrupt while retaining the query', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const a = await f.runner.send({ prompt: 'one' });
    const b = await f.runner.send({ prompt: 'two' });
    f.q.interrupt = async () => { f.calls.push(['interrupt']); return { still_queued: [b.userMessageId, 'foreign'] }; };
    expect(await f.runner.interrupt()).toMatchObject({ success: true });
    expect(f.calls.filter(c => ['cancel', 'interrupt'].includes(c[0]))).toEqual([
      ['cancel', a.userMessageId], ['cancel', b.userMessageId], ['interrupt'], ['cancel', b.userMessageId],
    ]);
    expect(f.runner.isIdle()).toBe(false);
    expect(f.runner.isBusy()).toBe(false);
    expect((await f.runner.send({ prompt: 'next' })).success).toBe(true);
    expect(f.calls.filter(c => c[0] === 'query')).toHaveLength(1);
  });

  it('serializes concurrent bootstrap, rejects busy config changes, recreates idle runtime changes', async () => {
    let revision = 'v1';
    const f = fixture({ getRuntime: async () => ({ executable: '/fake/claude', env: {}, versionFingerprint: revision }) });
    const config = { cwd: tmpdir(), options: { model: 'opus', effortLevel: 'high', autocompact: '200k', maxBudgetUsd: 2,
      additionalDirectories: [tmpdir()], chrome: true, ide: true, worktree: 'branch' } };
    const [a, b] = await Promise.all([f.runner.start(config), f.runner.start(config)]);
    expect(a.runId).toBe(b.runId);
    expect(f.options).toMatchObject({ model: 'opus', effort: 'high', maxBudgetUsd: 2, additionalDirectories: [tmpdir()],
      extraArgs: { autocompact: '200k', chrome: null, ide: null, worktree: 'branch', 'replay-user-messages': null } });
    await f.runner.send({ prompt: 'busy' });
    revision = 'v2';
    expect(await f.runner.start(config)).toMatchObject({ success: false, error: expect.stringContaining('busy') });
    f.outputs.push({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} });
    await vi.waitFor(() => expect(f.runner.isBusy()).toBe(false));
    const recreated = await f.runner.start(config);
    expect(recreated.success).toBe(true);
    expect(recreated.runId).not.toBe(a.runId);
    expect(recreated.sessionId).toBe(a.sessionId);
    expect(f.options.resume).toBe(a.sessionId);
    expect(f.calls.filter(c => c[0] === 'query')).toHaveLength(2);
    await f.runner.close();
    expect(f.runner.isIdle()).toBe(true);
  });

  it('holds the session reservation until a real child process closes, including SIGKILL fallback', async () => {
    const { SessionOwnership } = require('../src/main/session-ownership.js');
    const registry = new SessionOwnership();
    const id = randomUUID();
    const output = channel();
    let child;
    const f = fixture({ acquireSession: (sid, owner) => registry.acquire(sid, owner), loadSdk: async () => ({ query: ({ options, prompt }) => {
      child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.on("SIGTERM",()=>{}); process.stdout.write("ready\\n"); setInterval(()=>{},1000)'], cwd: tmpdir(), env: process.env });
      (async () => { for await (const message of prompt) void message; })();
      return Object.assign(output[Symbol.asyncIterator](), { initializationResult: async () => { await once(child.stdout, 'data'); return {}; },
        supportedCommands: async () => [], mcpServerStatus: async () => [], close: () => output.end() });
    } }) });
    expect((await f.runner.start({ cwd: tmpdir(), sessionId: id })).success).toBe(true);
    const close = f.runner.close();
    expect(registry.owner(id)).toBeTruthy();
    expect(f.runner.isIdle()).toBe(false);
    await close;
    expect(child.signalCode).toBe('SIGKILL');
    expect(registry.owner(id)).toBeUndefined();
    expect(f.status.map(s => s.status)).toEqual(['starting']);
  }, 10000);

  it('resolves approvals only for their owner, validates edits and session-only suggestions', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const controller = new AbortController();
    const pending = f.options.canUseTool('Bash', { command: 'ls' }, { requestId: 'tool-1', signal: controller.signal,
      suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] },
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] });
    expect(f.runner.getState().pendingApprovals[0]).toMatchObject({ requestId: 'tool-1', kind: 'tool', status: 'waiting' });
    expect(await f.runner.respond('tool-1', { behavior: 'allow' }, 2)).toMatchObject({ success: false });
    expect(await f.runner.respond('tool-1', { behavior: 'allow', editedInput: [] }, 1)).toMatchObject({ success: false });
    expect(await f.runner.respond('tool-1', { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }] }, 1)).toMatchObject({ success: false });
    expect(await f.runner.respond('tool-1', { behavior: 'allow', alwaysAllow: true }, 1)).toEqual({ success: true });
    expect(await pending).toEqual({ behavior: 'allow', updatedPermissions: [
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] },
    ] });
    expect(await f.runner.respond('tool-1', { behavior: 'deny' }, 1)).toMatchObject({ success: false });
    expect(f.runner.getState().pendingApprovals).toEqual([]);
    expect(f.stream.filter(e => e.type === 'approval_resolved')).toHaveLength(1);
    const aborted = f.options.canUseTool('Read', { file_path: '/tmp/x' }, { requestId: 'tool-2', signal: controller.signal });
    controller.abort();
    expect(await aborted).toMatchObject({ behavior: 'deny' });
  });

  it('validates question answers and approves plan mode atomically through session permissions', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const ctx = id => ({ requestId: id, signal: new AbortController().signal });
    const question = f.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }, ctx('q1'));
    expect(await f.runner.respond('q1', { behavior: 'allow', answers: { Unknown: 'A' } }, 1)).toMatchObject({ success: false });
    expect(await f.runner.respond('q1', { behavior: 'allow', answers: { 'Which?': 'custom free text' } }, 1)).toEqual({ success: true });
    expect(await question).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which?': 'custom free text' } } });
    const plan = f.options.canUseTool('ExitPlanMode', { plan: 'do work' }, ctx('plan1'));
    expect(await f.runner.respond('plan1', { behavior: 'allow', mode: 'bypassPermissions' }, 1)).toMatchObject({ success: false });
    expect(await f.runner.respond('plan1', { behavior: 'allow', mode: 'acceptEdits' }, 1)).toEqual({ success: true });
    expect(await plan).toEqual({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    expect(f.runner.getState().info.permissionMode).toBe('acceptEdits');
    expect(f.calls.filter(c => c[0] === 'mode')).toEqual([]);
    expect(await f.runner.setPermissionMode('plan')).toEqual({ success: true, permissionMode: 'plan' });
    expect(f.calls).toContainEqual(['mode', 'plan']);
  });

  it('validates elicitation schema, fails closed for dialogs, clears waiters on interrupt and close', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    expect(f.options.supportedDialogKinds).toEqual([]);
    const ctx = id => ({ requestId: id, signal: new AbortController().signal });
    expect(await f.options.onUserDialog({ dialogKind: 'unknown', payload: {} }, ctx('unknown'))).toEqual({ behavior: 'cancelled' });
    const elicitation = f.options.onElicitation({ serverName: 'server', requestedSchema: { type: 'object', required: ['age'], additionalProperties: false,
      properties: { age: { type: 'integer', minimum: 18 }, role: { type: 'string', enum: ['admin', 'reader'] } } } }, ctx('e1'));
    expect(await f.runner.respond('e1', { action: 'accept', content: { age: 12 } }, 1)).toMatchObject({ success: false });
    expect(await f.runner.respond('e1', { action: 'accept', content: { age: 20, role: 'reader' } }, 1)).toEqual({ success: true });
    expect(await elicitation).toEqual({ action: 'accept', content: { age: 20, role: 'reader' } });
    const waiter = f.options.canUseTool('Bash', { command: 'sleep' }, ctx('wait'));
    await f.runner.interrupt();
    expect(await waiter).toMatchObject({ behavior: 'deny' });
    expect(f.runner.getState().pendingApprovals).toEqual([]);
    const waiter2 = f.options.onElicitation({ serverName: 'server' }, ctx('e2'));
    await f.runner.close();
    expect(await waiter2).toEqual({ action: 'cancel' });
  });

  it('projects MCP metadata without exposing configuration credentials', async () => {
    const f = fixture();
    f.q.mcpServerStatus = async () => [{ name: 'server', status: 'connected', config: { env: { KEY: 'private' }, headers: { Authorization: 'secret' } }, serverInfo: { name: 'server', version: '1' } }];
    const boot = await f.runner.start({ cwd: tmpdir() });
    expect(boot.info.mcpServers).toEqual([{ name: 'server', status: 'connected', serverInfo: { name: 'server', version: '1' } }]);
    expect(JSON.stringify(await f.runner.getMcpStatus())).not.toMatch(/private|secret|Authorization/);
  });

  it('does not apply always-allow rules to edited input and deduplicates live approvals', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir() });
    const ctx = { requestId: 'dup', signal: new AbortController().signal, suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }] };
    const one = f.options.canUseTool('Bash', { command: 'ls' }, ctx);
    const two = f.options.canUseTool('Bash', { command: 'ls' }, ctx);
    expect(f.stream.filter(e => e.type === 'approval_request')).toHaveLength(1);
    expect(await f.runner.respond('dup', { behavior: 'allow', editedInput: { command: 'rm' }, alwaysAllow: true }, 1)).toMatchObject({ success: false });
    await f.runner.respond('dup', { behavior: 'deny' }, 1);
    expect(await one).toEqual(await two);
  });

  it('supports only explicitly declared refusal dialog choices and cancels them on SDK abort', async () => {
    const f = fixture();
    await f.runner.start({ cwd: tmpdir(), options: { supportedDialogKinds: ['refusal_fallback_prompt'] } });
    const controller = new AbortController();
    const dialog = f.options.onUserDialog({ dialogKind: 'refusal_fallback_prompt', payload: { originalModel: 'opus', fallbackModel: 'sonnet' } }, { requestId: 'dialog', signal: controller.signal });
    expect(await f.runner.respond('dialog', { behavior: 'completed', result: { arbitrary: true } }, 1)).toMatchObject({ success: false });
    expect(await f.runner.respond('dialog', { behavior: 'completed', result: 'edit_prompt' }, 1)).toEqual({ success: true });
    expect(await dialog).toEqual({ behavior: 'completed', result: 'edit_prompt' });
    const cancelled = f.options.onUserDialog({ dialogKind: 'refusal_fallback_prompt', payload: {} }, { requestId: 'dialog2', signal: controller.signal });
    controller.abort();
    expect(await cancelled).toEqual({ behavior: 'cancelled' });
  });

  it('close can cancel a bootstrap stalled in initialization', async () => {
    const events = channel();
    const f = fixture({ loadSdk: async () => ({ query: () => Object.assign(events[Symbol.asyncIterator](), {
      initializationResult: () => new Promise(() => {}), close: () => events.end(),
    }) }) });
    const boot = f.runner.start({ cwd: tmpdir() });
    await vi.waitFor(() => expect(f.status).toHaveLength(1));
    const closing = f.runner.close();
    expect(await boot).toMatchObject({ success: false });
    await closing;
    expect(f.runner.isIdle()).toBe(true);
  }, 3000);

  it('invalid cwd and process startup failures settle bootstrap without leaked ownership', async () => {
    const f = fixture();
    expect(await f.runner.start({ cwd: '/definitely/not/exist' })).toMatchObject({ success: false });
    expect(f.calls).toEqual([]);
    const bad = fixture({ loadSdk: async () => ({ query: ({ options }) => {
      const child = options.spawnClaudeCodeProcess({ command: '/definitely/not/exist', args: [], cwd: tmpdir(), env: {} });
      const events = channel();
      return Object.assign(events[Symbol.asyncIterator](), { initializationResult: () => new Promise((_, reject) => child.once('error', reject)),
        close() { events.end(); } });
    } }) });
    expect(await bad.runner.start({ cwd: tmpdir() })).toMatchObject({ success: false });
    expect(bad.runner.isIdle()).toBe(true);
  });
});
