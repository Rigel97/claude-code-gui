import { describe, it, expect } from 'vitest';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { createServer, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { TerminalAPI, TerminalMeta } from '../src/renderer/terminalStore';

// Formal opt-in UI regression. No bridge replacement, store mutation, synthetic
// CLI events, SDK substitution, shell wrappers, or account credentials.
const desktop = describe.skipIf(process.env.RUN_DESKTOP_INTEGRATION !== '1');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const KEY = 'desktop-local-only-not-a-real-api-key';
const TIMEOUT = 180_000;
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type Message = { role: string; content: string | Array<Record<string, unknown>> };
type RequestBody = { model: string; stream: boolean; messages: Message[]; system?: Array<{ text?: string }>; tools?: Array<{ name: string; input_schema: { type: string } }> };
type RecordHTTP = { path: string; body: RequestBody | null };
type Responder = (body: RequestBody, response: ServerResponse) => void;
type RuntimeState = { state?: string; busy?: boolean; sessionId?: string; pendingApprovals?: unknown[]; pendingUserMessageIds?: string[]; info?: { permissionMode?: string } };
type SavedConversation = { id: string; sessionId?: string | null; draft?: string; messages?: unknown[] };
type SavedApp = { conversations: SavedConversation[]; totalInputTokens: number; totalOutputTokens: number };
interface DesktopAPI {
  runtime: {
    set(options: { executable: string; environmentUpdates: { key: string; value: string }[] }, storage: { persist: boolean }): Promise<{ executable: string; persisted: boolean; environmentKeys: string[] }>;
  };
  claude: {
    states(): Promise<RuntimeState[]>;
    runtimeState(id: string): Promise<RuntimeState | null>;
    plan(payload: { conversationId: string }): Promise<{ success: boolean; error?: string }>;
  };
  store: { get(key: 'appState'): Promise<SavedApp> };
  terminal: Omit<TerminalAPI, 'create'> & { create(spec: unknown): Promise<TerminalMeta> };
}
declare global { interface Window { api: DesktopAPI } }

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('') : '';
}
function result(body: RequestBody, id: string): string {
  const row = body.messages.filter(message => message.role === 'user')
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === id);
  expect(row, `Real CLI must return tool_result ${id}`).toBeTruthy();
  expect(row?.is_error, `CLI tool ${id} returned: ${text(row?.content).slice(0, 2000)}`).not.toBe(true);
  return text(row?.content);
}
function tool(body: RequestBody, name: string, id: string, input: Record<string, unknown>): Block {
  expect(body.tools?.find(item => item.name === name)?.input_schema.type, `Installed CLI must advertise ${name}`).toBe('object');
  return { type: 'tool_use', name, id, input };
}
function sse(response: ServerResponse, body: RequestBody, blocks: Block[]) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'request-id': randomUUID() });
  const emit = (frame: Record<string, unknown>) => response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  emit({ type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      emit({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      const input = JSON.stringify(block.input);
      for (let offset = 0; offset < input.length; offset += 19) emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input.slice(offset, offset + 19) } });
    } else {
      emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const part of block.text.match(/.{1,7}/gs) || []) emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
    }
    emit({ type: 'content_block_stop', index });
  });
  emit({ type: 'message_delta', delta: { stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
  emit({ type: 'message_stop' });
  response.end();
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function descendants(pid: number): Promise<number[]> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 5000 });
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const found = new Set([pid]);
  for (let pass = 0; pass < rows.length; pass++) {
    const count = found.size;
    rows.forEach(([child, parent]) => { if (found.has(parent)) found.add(child); });
    if (found.size === count) break;
  }
  return [...found].filter(child => child !== pid);
}
async function portOpen(port: number) {
  return new Promise<boolean>(yes => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(400);
    socket.once('connect', () => { socket.destroy(); yes(true); });
    socket.once('error', () => { socket.destroy(); yes(false); });
    socket.once('timeout', () => { socket.destroy(); yes(false); });
  });
}

async function fixture(body: (f: DesktopFixture) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), 'desktop-integration-'));
  const cwd = join(temporary, 'project');
  const home = join(temporary, 'home');
  const config = join(temporary, 'claude');
  const userData = join(temporary, 'electron');
  const first = randomUUID();
  const second = randomUUID();
  const requests: RecordHTTP[] = [];
  const failures: string[] = [];
  const errors: string[] = [];
  const blockedFonts: string[] = [];
  const sockets = new Set<Socket>();
  let responder: Responder = () => { throw new Error('Model request before explicit user input'); };
  let app: ElectronApplication | undefined;
  let page: Page;
  let mainPID = 0;
  let tracked: number[] = [];
  let primaryFailure = false;
  const mask = (value: unknown) => String(value).replaceAll(KEY, '[REDACTED]').slice(-6000);
  const server = createServer(async (request, response) => {
    try {
      // Seven real turns legitimately add model + count_tokens/metadata
      // calls, and a failed turn is retried by the SDK. Keep a hard bound so
      // runaway traffic still fails, without rejecting the expected protocol.
      expect(requests.length, 'Bound all local and ancillary traffic').toBeLessThan(120);
      if (/^https?:\/\//i.test(request.url || '')) throw new Error('External HTTP proxy request blocked');
      expect(request.headers.host).toBe(`127.0.0.1:${(server.address() as { port: number }).port}`);
      expect(request.socket.remoteAddress).toBe('127.0.0.1');
      let raw = '';
      for await (const chunk of request) {
        raw += chunk.toString('utf8');
        expect(Buffer.byteLength(raw)).toBeLessThan(2_000_000);
      }
      const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      const parsed = raw ? JSON.parse(raw) : null;
      requests.push({ path, body: parsed });
      if (path === '/api/metadata' || path === '/v1/messages/count_tokens') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(path.endsWith('count_tokens') ? { input_tokens: 100 } : {}));
        return;
      }
      expect(path, 'Unknown endpoints are not silently accepted').toBe('/v1/messages');
      expect(request.method).toBe('POST');
      expect(request.headers['x-api-key']).toBe(KEY);
      expect(request.headers.authorization).toBeUndefined();
      expect(parsed).toMatchObject({ stream: true });
      expect(parsed.model).toContain('sonnet');
      expect(Array.isArray(parsed.messages)).toBe(true);
      responder(parsed, response);
    } catch (error) {
      failures.push(mask(error));
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Desktop local fixture rejected request' } }));
    }
  });
  server.on('connect', (_request, socket) => {
    failures.push('External HTTPS CONNECT blocked');
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  // A predicate that awaits a stuck renderer/main IPC must not turn the whole
  // test into a silent 120s timeout. Race only against the remaining deadline;
  // a short per-probe race would abandon (but not cancel) in-flight Playwright
  // calls and let multiple probes click the same approval concurrently.
  const probe = async (predicate: () => boolean | Promise<boolean>, budget: number) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([Promise.resolve().then(predicate),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), budget); })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const wait = async (predicate: () => boolean | Promise<boolean>, label: string, timeout = 30_000, checkTraffic = true) => {
    const end = Date.now() + timeout;
    while (!await probe(predicate, Math.max(250, end - Date.now() + 500))) {
      if (checkTraffic && failures.length) throw new Error(`${label}: ${failures.join('\n')}`);
      if (Date.now() > end) {
        const runtime = page && !page.isClosed() ? await page.evaluate(() => window.api.claude.states()).catch(() => null) : null;
        const dom = page && !page.isClosed() ? await page.locator('body').innerText().catch(() => '') : '';
        const states = Array.isArray(runtime) ? runtime.map(state => ({ state: state.state, sessionId: state.sessionId, pending: state.pendingUserMessageIds, approvals: state.pendingApprovals, info: { permissionMode: state.info?.permissionMode } })) : runtime;
        throw new Error(mask(`${label} timed out; requests=${JSON.stringify(requests.map(r => ({ path: r.path, model: r.body?.model })))}; runtime=${JSON.stringify(states)}; errors=${errors.join('\n')}; UI=${dom.slice(0, 2000)}`));
      }
      await delay(40);
    }
    if (checkTraffic) expect(failures, label).toEqual([]);
  };
  try {
    await Promise.all([cwd, home, config, userData].map(directory => mkdir(directory, { recursive: true })));
    expect(await portOpen(5170), 'Stop Vite before this production-only regression; do not substitute a dev page').toBe(false);
    const builtHTML = await readFile(join(ROOT, 'dist-renderer/index.html'), 'utf8');
    expect(builtHTML).toContain('assets/index-');
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|GOOGLE_|GCLOUD_|VERTEX_|AZURE_|OPENAI_|OTEL_|ELECTRON_RUN_AS_NODE$)/i.test(key)
        && !/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|PROXY|NODE_OPTIONS|BASH_ENV|ENV$|ZDOTDIR|SHELL_SNAPSHOT/i.test(key)) env[key] = value;
    }
    Object.assign(env, {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
      CLAUDE_GUI_USER_DATA: userData, CLAUDE_CONFIG_DIR: config,
      // No human can answer the native "cleanup failed" dialog in CI.
      CLAUDE_GUI_NONINTERACTIVE: '1',
      ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_MODEL: 'sonnet', ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'sonnet', ANTHROPIC_DEFAULT_OPUS_MODEL: 'sonnet',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', DISABLE_AUTO_COMPACT: '1',
      CLAUDE_CODE_DISABLE_AUTOUPDATE: '1', CLAUDE_CODE_DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_BASH_NO_LOGIN: '1', SHELL: '/bin/bash', TMPDIR: temporary,
      HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint,
      http_proxy: endpoint, https_proxy: endpoint, all_proxy: endpoint,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    });
    // Resolve an actual installed binary before HOME isolation, never an alias or wrapper.
    let executable = '';
    const candidates = ['/Users/chenzhongshu/.local/bin/claude', ...(process.env.PATH || '').split(delimiter).filter(Boolean).map(directory => resolve(directory, 'claude'))];
    for (const candidate of candidates) {
      try { accessSync(candidate, constants.X_OK); executable = await realpath(candidate); break; } catch { /* Next real install. */ }
    }
    expect(executable, 'Opt-in desktop regression requires the real installed CLI').not.toBe('');
    env.PATH = [dirname(executable), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
    const version = await exec(executable, ['--version'], { env, cwd, timeout: 10_000 });
    expect(version.stdout.trim()).toBe('2.1.229 (Claude Code)');
    // Only public startup fixture files are written, all inside the temporary tree.
    await writeFile(join(config, 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash'] } }));
    await writeFile(join(userData, 'claude-gui-config.json'), JSON.stringify({ appState: {
      cwd, sessions: [], activeConversationId: first, model: 'sonnet', permissionMode: 'default', notifyOnComplete: false,
      conversations: [
        { id: first, title: 'Desktop first', cwd, sessionId: null, status: 'idle', messages: [], draft: '' },
        { id: second, title: 'Desktop second', cwd, sessionId: null, status: 'idle', messages: [], draft: 'unsent desktop draft' },
      ],
    } }));
    const launch = async () => {
      app = await _electron.launch({ cwd: ROOT, args: [ROOT], env, timeout: 30_000 });
      mainPID = app.process().pid!;
      app.process().stderr?.on('data', chunk => {
        const line = String(chunk);
        if (/Uncaught|Unhandled|Error occurred in handler|Cannot find module|spawn-helper|ABI mismatch/i.test(line)) errors.push(mask(line));
      });
      page = await app.firstWindow();
      page.setDefaultTimeout(20_000);
      page.on('pageerror', error => errors.push(mask(error)));
      page.on('crash', () => errors.push('Renderer process crashed'));
      page.on('console', message => {
        if (message.type() !== 'error') return;
        // Offline web-font fallback is not a core UI error; the resource is
        // explicitly denied, never fulfilled with a fabricated DOM or asset.
        if (/^https:\/\/fonts\.(gstatic|googleapis)\.com\//.test(message.location().url) && /ERR_BLOCKED_BY_CLIENT/.test(message.text())) return;
        // Keep the failing URL: a bare ERR_FILE_NOT_FOUND cannot tell which
        // generated asset or entry chunk is missing from the production copy.
        errors.push(mask(`${message.text()} @ ${message.location().url || '(unknown)'}`));
      });
      page.on('dialog', dialog => { void dialog.accept().catch(() => { /* already dismissed */ }); });
      await app.context().route(/^https?:\/\//, route => {
        const url = new URL(route.request().url());
        if (url.origin === endpoint) return route.continue();
        if (/^fonts\.(gstatic|googleapis)\.com$/.test(url.hostname) && route.request().method() === 'GET') {
          blockedFonts.push(`${url.origin}${url.pathname}`);
          return route.abort('blockedbyclient');
        }
        failures.push(`External renderer request blocked: ${url.origin}${url.pathname}`);
        return route.abort('blockedbyclient');
      });
      await wait(() => page.url().startsWith('file:'), 'production file URL');
      expect(fileURLToPath(page.url())).toBe(join(ROOT, 'dist-renderer/index.html'));
      const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')));
      expect(scripts).toContain(builtHTML.match(/src="([^"]+assets\/index-[^"]+)"/)?.[1]);
      expect(await app.evaluate(({ app }) => ({ version: process.versions.electron, userData: app.getPath('userData'), ready: app.isReady() })))
        .toMatchObject({ version: expect.stringMatching(/^33\./), userData, ready: true });
      // After a resumed launch the live tab title includes its session prefix.
      await wait(() => page.getByTitle(/^Desktop first(?: · |$)/).isVisible(), 'App config hydration');
      const summary = await page.evaluate(async ({ executable, endpoint, config, key }) => window.api.runtime.set({ executable,
        environmentUpdates: Object.entries({ ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: key, CLAUDE_CONFIG_DIR: config,
          HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, NO_PROXY: '127.0.0.1,localhost' }).map(([key, value]) => ({ key, value })) }, { persist: false }),
      { executable, endpoint, config, key: KEY });
      expect(summary).toMatchObject({ executable, persisted: false, environmentKeys: expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']) });
      expect(JSON.stringify(summary)).not.toContain(KEY);
    };
    const quit = async () => {
      if (!app) return;
      tracked = [...new Set([...tracked, mainPID, ...await descendants(mainPID)])];
      await app.close();
      app = undefined;
      await wait(() => tracked.every(pid => !alive(pid)), 'Electron, real SDK and PTY descendants all exited', 30_000);
    };
    const f: DesktopFixture = {
      get page() { return page; }, cwd, config, userData, first, second, errors, failures, requests, wait, launch, quit,
      set respond(value: Responder) { responder = value; },
      modelRequests: () => requests.filter(request => request.path === '/v1/messages'),
      async send(prompt) {
        await page.getByRole('textbox', { name: '消息输入', exact: true }).fill(prompt);
        await page.getByRole('textbox', { name: '消息输入', exact: true }).press('Enter');
      },
      async ready(id = first) {
        await wait(async () => {
          const state = await page.evaluate(id => window.api.claude.runtimeState(id), id);
          return state?.state === 'ready' && !state.busy && !state.pendingApprovals?.length && !state.pendingUserMessageIds?.length;
        }, 'real persistent SDK ready');
      },
      async settings() {
        await page.getByRole('button', { name: '设置', exact: true }).click();
        // The overlay mounts asynchronously; count()-style assertions do not retry.
        await page.getByRole('heading', { name: '设置', exact: true }).waitFor({ state: 'visible' });
      },
      async closeSettings() { await page.getByRole('heading', { name: '设置', exact: true }).locator('..').getByRole('button').click(); },
      async saved() { return page.evaluate(() => window.api.store.get('appState')); },
      async terminal() {
        await page.getByRole('button', { name: '原生终端', exact: true }).click();
        const panel = page.getByRole('region', { name: '官方原生终端', exact: true });
        await wait(() => panel.isVisible(), 'App NativeTerminalHost mounted');
        await panel.getByRole('combobox', { name: '模式', exact: true }).selectOption('shell');
        await panel.getByRole('button', { name: '创建终端', exact: true }).click();
        await wait(async () => (await page.evaluate(() => window.api.terminal.list())).length === 1, 'real node-pty create');
        const [terminal] = await page.evaluate(() => window.api.terminal.list());
        await wait(() => panel.locator('.xterm-helper-textarea').count().then(count => count === 1), 'official xterm input mounted');
        return { id: terminal.id, panel };
      },
      async transcript(sid, expected) {
        const files: string[] = [];
        const walk = async (directory: string) => {
          for (const item of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, item.name);
            if (item.isDirectory()) await walk(path);
            else if (item.name === `${sid}.jsonl`) files.push(path);
          }
        };
        // The file appears before the CLI flushes every row. Wait for the
        // requested final content, otherwise a fast read catches queue-operation
        // only and looks like a lost assistant reply.
        await wait(async () => {
          files.length = 0; await walk(config);
          if (files.length !== 1) return false;
          return !expected || (await readFile(files[0], 'utf8')).includes(expected);
        }, expected ? `real CLI transcript contains ${expected}` : 'real CLI transcript flushed to isolated config');
        expect(files, 'Real CLI generated exactly one isolated transcript').toHaveLength(1);
        expect(files[0].startsWith(config + '/')).toBe(true);
        return readFile(files[0], 'utf8');
      },
    };
    await launch();
    await body(f);
    expect(errors, 'Real renderer/main errors').toEqual([]);
    expect(failures, 'No external/provider/secret traffic, including shutdown').toEqual([]);
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    // Always shut down the actual app and every descendant before deleting fixtures.
    console.info(`desktop evidence: modelRequests=${requests.filter(request => request.path === '/v1/messages').length}, deniedExternalFonts=${blockedFonts.length}, coreErrors=${errors.length}, providerViolations=${failures.length}`);
    try {
      if (app) {
        tracked = [...new Set([...tracked, mainPID, ...await descendants(mainPID)])];
        await app.close();
        await wait(() => tracked.every(pid => !alive(pid)), 'cleanup child exit', 30_000, false);
      }
      if (!primaryFailure) expect(failures, 'No external traffic during cleanup').toEqual([]);
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>(yes => server.close(() => yes()));
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

interface DesktopFixture {
  readonly page: Page; cwd: string; config: string; userData: string; first: string; second: string;
  errors: string[]; failures: string[]; requests: RecordHTTP[]; respond: Responder;
  wait(predicate: () => boolean | Promise<boolean>, label: string, timeout?: number): Promise<void>;
  launch(): Promise<void>; quit(): Promise<void>; modelRequests(): RecordHTTP[];
  send(prompt: string): Promise<void>; ready(id?: string): Promise<void>;
  settings(): Promise<void>; closeSettings(): Promise<void>;
  saved(): Promise<SavedApp>;
  terminal(): Promise<{ id: string; panel: ReturnType<Page['getByRole']> }>;
  transcript(sid: string, expected?: string): Promise<string>;
}

// page.evaluate is used only for documented, real preload APIs and read-only
// observations. User actions always enter through the actual production DOM.
desktop('production App → preload → main → native/SDK, Electron 33, local provider only', () => {
  it('hydrates both tabs; exposes all six permissions and masked real runtime diagnostics without invoking a model', async () => {
    await fixture(async f => {
      expect(await f.page.getByTitle('Desktop second', { exact: true }).count()).toBe(1);
      await f.page.getByTitle('Desktop second', { exact: true }).click();
      expect(await f.page.getByRole('textbox', { name: '消息输入' }).inputValue()).toBe('unsent desktop draft');
      await f.page.getByTitle('Desktop first', { exact: true }).click();
      await f.settings();
      for (const permission of ['逐次审批', '仅自动接受文件编辑', '只读规划', '自动审批（依赖 CLI 可用）', '仅规则、不弹问', '全部放行（危险）']) {
        expect(await f.page.getByRole('button', { name: permission, exact: false }).count(), permission).toBe(1);
      }
      await f.page.getByRole('button', { name: '刷新运行时诊断', exact: true }).click();
      await f.wait(() => f.page.getByText('CLI 版本：2.1.229', { exact: true }).isVisible(), 'real executable version diagnostics');
      expect(await f.page.getByLabel('环境变量值', { exact: true }).getAttribute('type')).toBe('password');
      expect(await f.page.getByLabel('环境变量值', { exact: true }).inputValue()).toBe('');
      expect(await f.page.locator('body').innerText()).not.toContain(KEY);
      expect(await readFile(join(f.userData, 'claude-gui-config.json'), 'utf8')).not.toContain(KEY);
      await f.closeSettings();
      await delay(400);
      expect(f.modelRequests()).toHaveLength(0);
      expect(await f.page.evaluate(() => window.api.claude.states())).toEqual([]);
    });
  }, TIMEOUT);

  it('approves real Bash once, answers single/multi questions, and approves a plan with public getPlan fallback', async () => {
    await fixture(async f => {
      let stage = 0;
      let planPath = '';
      const question = 'Which colour?';
      const multi = 'Which checks?';
      f.respond = (body, response) => {
        switch (stage++) {
          case 0:
            expect(body.messages.some(message => text(message.content).includes('writefixture'))).toBe(true);
            sse(response, body, [tool(body, 'Bash', 'toolu_desktop_bash', { command: "printf 'done'" })]); break;
          case 1:
            expect(result(body, 'toolu_desktop_bash')).toBe('done');
            sse(response, body, [{ type: 'text', text: 'Desktop Bash completed' }]); break;
          case 2:
            expect(body.messages.some(message => text(message.content).includes('askfixture'))).toBe(true);
            sse(response, body, [tool(body, 'AskUserQuestion', 'toolu_desktop_ask', { questions: [
              { question, header: 'Colour', multiSelect: false, options: [{ label: 'Blue', description: 'cool' }, { label: 'Red', description: 'warm' }] },
              { question: multi, header: 'Checks', multiSelect: true, options: [{ label: 'Lint', description: 'static' }, { label: 'Test', description: 'runtime' }] },
            ] })]); break;
          case 3: {
            const answer = result(body, 'toolu_desktop_ask');
            expect(answer).toContain('Which colour?'); expect(answer).toContain('Blue');
            expect(answer).toContain('Which checks?'); expect(answer).toContain('Lint, Test');
            expect(answer).not.toContain('Red');
            sse(response, body, [{ type: 'text', text: 'Desktop answers completed' }]); break;
          }
          case 4: {
            const context = [...(body.system || []), ...body.messages.map(message => ({ text: text(message.content) }))].map(item => item.text || '').join('\n');
            planPath = context.match(/\/[^\s"'<>]*\/plans\/[^\s"'<>]+\.md/)?.[0] || '';
            expect(planPath.startsWith(dirname(f.cwd) + '/'), 'Real CLI plan path stays isolated').toBe(true);
            sse(response, body, [tool(body, 'Write', 'toolu_desktop_plan_write', { file_path: planPath, content: '# Desktop verification\nOnly local tests.\n' })]); break;
          }
          case 5:
            expect(result(body, 'toolu_desktop_plan_write')).toContain('successfully');
            sse(response, body, [tool(body, 'ExitPlanMode', 'toolu_desktop_plan_exit', {})]); break;
          case 6:
            expect(result(body, 'toolu_desktop_plan_exit')).toContain('approved');
            sse(response, body, [{ type: 'text', text: 'Desktop plan completed' }]); break;
          default: throw new Error('Unexpected additional model call (including title generation)');
        }
      };
      await f.send('writefixture');
      await f.wait(() => f.modelRequests().length === 1, 'actual CLI model request');
      const approval = f.page.getByRole('region', { name: 'Claude审批与追问', exact: true });
      await f.wait(() => approval.isVisible(), 'ChatArea ApprovalPanel mounted for real Bash');
      expect(await approval.getByLabel('工具参数预览').innerText()).toContain("printf 'done'");
      await approval.getByRole('button', { name: '批准一次', exact: true }).click();
      await f.ready();
      await f.wait(() => f.page.getByText('Desktop Bash completed', { exact: true }).isVisible(), 'completed assistant UI');
      await f.wait(async () => (await f.saved()).totalInputTokens > 0, 'persisted real SDK token metrics');
      expect(await f.page.getByText('Turns', { exact: true }).count()).toBeGreaterThan(0);
      expect(f.modelRequests()).toHaveLength(2);
      await f.send('askfixture');
      await f.wait(() => approval.getByRole('button', { name: '提交回答', exact: true }).isVisible(), 'real AskUserQuestion UI');
      await approval.getByRole('radio', { name: 'Blue — cool', exact: true }).check();
      await approval.getByRole('checkbox', { name: 'Lint — static', exact: true }).check();
      await approval.getByRole('checkbox', { name: 'Test — runtime', exact: true }).check();
      await approval.getByRole('button', { name: '提交回答', exact: true }).click();
      await f.ready();
      await f.wait(() => f.page.getByText('Desktop answers completed', { exact: true }).isVisible(), 'answers assistant UI');
      await f.settings();
      await f.page.getByRole('button', { name: /只读规划/ }).click();
      await f.page.getByRole('button', { name: '保存', exact: true }).click();
      await f.wait(async () => (await f.page.evaluate(id => window.api.claude.runtimeState(id), f.first))?.info?.permissionMode === 'plan', 'manual settings changed actual CLI mode');
      // Saving applies the mode in place; the settings overlay stays mounted and
      // would otherwise intercept the later plan-approval click.
      if (await f.page.getByRole('heading', { name: '设置', exact: true }).isVisible()) await f.closeSettings();
      await f.send('planfixture');
      await f.wait(async () => {
        if (await approval.getByRole('button', { name: '批准一次', exact: true }).isVisible()) await approval.getByRole('button', { name: '批准一次', exact: true }).click();
        return approval.getByRole('button', { name: '批准计划', exact: true }).isVisible();
      }, 'real ExitPlanMode approval');
      const planBody = '# Desktop verification\nOnly local tests.\n';
      expect(await readFile(planPath, 'utf8')).toBe(planBody);
      // The real CLI enriches ExitPlanMode with the written plan body; the
      // approval card must show that exact content, not just the file path.
      expect((await approval.getByLabel('计划正文').innerText()).trimEnd()).toBe(planBody.trimEnd());
      expect(await f.page.evaluate(id => window.api.claude.plan({ conversationId: id }), f.first)).toMatchObject({
        success: true, exists: true, content: planBody, source: 'approval',
      });
      await approval.getByLabel('批准后权限模式').selectOption('default');
      await approval.getByRole('button', { name: '批准计划', exact: true }).click();
      await f.ready();
      expect((await f.page.evaluate(id => window.api.claude.runtimeState(id), f.first))?.info?.permissionMode).toBe('default');
      expect(stage).toBe(7);
      expect(f.modelRequests()).toHaveLength(7);
    });
  }, TIMEOUT);

  it('creates a bash PTY via sidebar, renders xterm, survives hide/tab switching, rejects invalid native specs and kills the real child on close', async () => {
    await fixture(async f => {
      const { id, panel } = await f.terminal();
      const marker = `PTY-${randomUUID()}`;
      const input = panel.locator('.xterm-helper-textarea');
      await input.pressSequentially(`printf '\\n${marker}:%s\\n' "$$"`);
      await input.press('Enter');
      let pid = 0;
      await f.wait(async () => {
        const snapshot = await f.page.evaluate(id => window.api.terminal.attach(id), id);
        pid = Number(snapshot.snapshot.match(new RegExp(`${marker}:(\\d+)`))?.[1] || 0);
        return pid > 1;
      }, 'real shell output and child PID');
      expect(alive(pid)).toBe(true);
      await f.wait(() => panel.locator('.xterm-rows').innerText().then(value => value.includes(`${marker}:${pid}`)), 'official xterm rendered PTY output');
      await panel.getByRole('button', { name: '隐藏终端', exact: true }).click();
      await f.page.getByTitle('Desktop second', { exact: true }).click();
      expect(await f.page.getByRole('textbox', { name: '消息输入' }).inputValue()).toBe('unsent desktop draft');
      await f.page.getByTitle('Desktop first', { exact: true }).click();
      await f.page.getByRole('button', { name: '原生终端', exact: true }).click();
      await f.wait(() => panel.locator('.xterm-rows').innerText().then(value => value.includes(`${marker}:${pid}`)), 'same xterm history after hide and tab switch');
      expect((await f.page.evaluate(() => window.api.terminal.list())).map(term => term.id)).toEqual([id]);
      const invalid = await f.page.evaluate(async cwd => {
        const rejected: string[] = [];
        for (const spec of [
          { mode: 'cloud', cwd, options: { cloudSession: 'untrusted task description' } },
          { mode: 'shell', cwd, initialCommand: '/config' },
          { mode: 'shell', cwd, cols: 0 },
          { mode: 'interactive', cwd, options: { chrome: 'yes' } },
        ]) {
          try { await window.api.terminal.create(spec); rejected.push('NOT REJECTED'); }
          catch { rejected.push('rejected'); }
        }
        return rejected;
      }, f.cwd);
      expect(invalid).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
      // Electron logs every rejected ipcMain handler. These four are the
      // intentional invalid specs asserted above, not unexpected failures.
      f.errors.splice(0, f.errors.length, ...f.errors.filter(line => !/Error occurred in handler for 'terminal:create'/.test(line)));
      expect((await f.page.evaluate(() => window.api.terminal.list())).map(term => term.id)).toEqual([id]);
      await panel.getByRole('button', { name: '关闭 Terminal', exact: true }).click();
      await f.wait(() => !alive(pid), 'explicit UI close killed actual bash child');
      expect(await f.page.evaluate(() => window.api.terminal.list())).toEqual([]);
      expect(f.modelRequests()).toHaveLength(0);
    });
  }, TIMEOUT);

  it('imports real CLI-generated JSONL through history worker, forks and prefills an edit draft with zero additional model calls', async () => {
    await fixture(async f => {
      f.respond = (body, response) => {
        expect(f.modelRequests()).toHaveLength(1);
        expect(body.messages.some(message => text(message.content).includes('historyfixture')), 'Real history prompt must reach provider').toBe(true);
        sse(response, body, [{ type: 'text', text: 'Desktop history completed' }]);
      };
      await f.send('historyfixture');
      await f.wait(() => f.page.getByText('Desktop history completed', { exact: true }).first().isVisible(), 'real completed history response');
      await f.ready();
      const source = await f.page.evaluate(id => window.api.claude.runtimeState(id), f.first);
      const sid = source!.sessionId!;
      const transcript = await f.transcript(sid, 'Desktop history completed');
      expect(transcript).toContain('historyfixture'); expect(transcript).toContain('Desktop history completed');
      expect(await f.page.getByText('Desktop history completed', { exact: true }).count(), 'One actual model response must render exactly once').toBe(1);
      expect(transcript.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(row => row.type === 'user' && typeof row.uuid === 'string')).toBe(true);
      await f.wait(() => f.page.getByRole('region', { name: '会话操作', exact: true }).isVisible(), 'ChatArea SessionActions mounted');
      // A live tab's title appends the real session prefix; match the stable
      // prefix and hover so the opacity-0 close control becomes actionable.
      const firstTab = f.page.getByTitle(/^Desktop first(?: · |$)/);
      await firstTab.hover();
      await firstTab.getByTitle('关闭此对话', { exact: true }).click();
      await f.page.getByRole('button', { name: 'CLI 历史', exact: true }).click();
      const history = f.page.getByRole('dialog', { name: 'CLI 历史', exact: true });
      await f.wait(() => history.getByText(sid, { exact: false }).isVisible(), 'worker SDK historyList sees generated SID');
      await history.getByRole('button', { name: /^导入 / }).click();
      await f.wait(() => f.page.getByRole('region', { name: '会话操作', exact: true }).getByText(`Session ID: ${sid}`, { exact: true }).isVisible(), 'real imported full history session');
      expect(await f.page.getByText('Desktop history completed', { exact: true }).isVisible()).toBe(true);
      await f.page.getByRole('button', { name: '分叉会话', exact: true }).click();
      await f.wait(async () => (await f.saved()).conversations.some(conv => Boolean(conv.sessionId && conv.sessionId !== sid)), 'SDK history fork imported distinct SID');
      expect(await f.page.getByText('Desktop history completed', { exact: true }).isVisible()).toBe(true);
      await f.page.getByRole('button', { name: '编辑并分叉', exact: true }).first().click();
      await f.wait(() => f.page.getByRole('textbox', { name: '消息输入' }).inputValue().then(value => value === 'historyfixture'), 'original first user message becomes unsent draft');
      await delay(500);
      expect(f.modelRequests()).toHaveLength(1);
    });
  }, TIMEOUT);

  it('quits with live SDK and PTY children, reloads persisted transcript/draft and does not duplicate model calls or handles', async () => {
    await fixture(async f => {
      f.respond = (body, response) => {
        expect(f.modelRequests()).toHaveLength(1);
        sse(response, body, [{ type: 'text', text: 'Desktop restart completed' }]);
      };
      await f.send('restartfixture');
      await f.wait(() => f.page.getByText('Desktop restart completed', { exact: true }).first().isVisible(), 'real completed restart response');
      await f.ready();
      const before = await f.page.evaluate(id => window.api.claude.runtimeState(id), f.first);
      expect(before?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      await f.transcript(before!.sessionId!, 'Desktop restart completed');
      expect(await f.page.getByText('Desktop restart completed', { exact: true }).count(), 'No replay/result duplicate assistant messages').toBe(1);
      await f.terminal();
      await f.page.getByRole('textbox', { name: '消息输入' }).fill('restart unsent draft');
      await f.wait(async () => (await f.saved()).conversations.some((conv: { draft?: string }) => conv.draft === 'restart unsent draft'), 'draft flushed before quit');
      await f.quit();
      const stored = JSON.parse(await readFile(join(f.userData, 'claude-gui-config.json'), 'utf8'));
      expect(JSON.stringify(stored)).not.toContain(KEY);
      expect(stored.runtimeConfiguration).toBeUndefined();
      await f.launch();
      expect(await f.page.getByRole('textbox', { name: '消息输入' }).inputValue()).toBe('restart unsent draft');
      expect(await f.page.getByText('Desktop restart completed', { exact: true }).isVisible()).toBe(true);
      expect(await f.page.evaluate(() => window.api.terminal.list())).toEqual([]);
      expect(await f.page.evaluate(() => window.api.claude.states())).toEqual([]);
      await f.page.getByRole('button', { name: 'CLI 历史', exact: true }).click();
      await f.wait(() => f.page.getByRole('dialog', { name: 'CLI 历史' }).getByText(before!.sessionId!, { exact: false }).isVisible(), 'history worker reopened on restart');
      await f.page.getByRole('button', { name: '关闭历史', exact: true }).click();
      await delay(500);
      expect(f.modelRequests()).toHaveLength(1);
      await f.quit();
    });
  }, TIMEOUT);
});
