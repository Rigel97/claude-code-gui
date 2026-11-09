import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let url: string;
let cacheDir: string;
const errors: string[] = [];

beforeAll(async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-ui-vite-'));
  server = await createServer({
    cacheDir,
    optimizeDeps: { include: ['react', 'react-dom/client', 'zustand', '@xterm/xterm', '@xterm/addon-fit'] },
    configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'native-terminal-browser-fixture',
      resolveId(id) { if (id === '/terminal-fixture.tsx') return '\0terminal-fixture.tsx'; },
      load(id) {
        if (id !== '\0terminal-fixture.tsx') return;
        return `import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {NativeTerminalHost} from '${root}/src/renderer/components/NativeTerminal.tsx';
          import {useTerminalStore} from '${root}/src/renderer/terminalStore.ts';
          import {useStore} from '${root}/src/renderer/store.ts';
          window.terminalStore = useTerminalStore;
          window.chatStore = useStore;
          useStore.setState({cwd:'/fallback',conversations:[{id:'chat-a',cwd:'/project-a',sessionId:null},{id:'chat-b',cwd:'/project-b',sessionId:null}],activeConversationId:'chat-a'});
          const root = createRoot(document.getElementById('root'));
          window.unmountHost = () => root.unmount();
          root.render(React.createElement(React.StrictMode,null,React.createElement(NativeTerminalHost)));
          document.getElementById('show').onclick = () => useTerminalStore.getState().show();`;
      },
      configureServer(vite) {
        vite.middlewares.use('/__terminal_test', async (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(await vite.transformIndexHtml('/__terminal_test', '<html><body style="margin:0;background:#10131b;color:white"><button id="show">侧栏终端</button><div id="root"></div><script type="module" src="/terminal-fixture.tsx"></script></body></html>'));
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  url = `http://127.0.0.1:${address.port}/__terminal_test`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
}, 60000);

beforeEach(async () => {
  errors.length = 0;
  context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  await context.addInitScript(() => {
    const w = window as any;
    const data = new Set<Function>();
    const exits = new Set<Function>();
    const records: any[] = [];
    w.fixture = {
      calls: [], records, data, exits, fail: '', attachPending: false,
      emit(event: unknown) { data.forEach(fn => fn(event)); },
      exit(event: any) { const record = records.find(r => r.id === event.id); if (record) Object.assign(record, event); exits.forEach(fn => fn(event)); },
    };
    const call = async (method: string, args: unknown[], value: unknown) => {
      w.fixture.calls.push({ method, args });
      if (w.fixture.fail === method) throw new Error(`${method} unavailable`);
      return value;
    };
    w.api = { terminal: {
      health: () => call('health', [], { available: true }),
      list: () => call('list', [], [...records]),
      create: async (spec: any) => {
        const suggested: Record<string, string> = {mcp:'claude mcp --help',plugins:'claude plugin --help',agents:'claude agents --help'};
        const meta = { id: crypto.randomUUID(), title: `Terminal ${records.length + 1}`, mode: spec.mode, cwd: spec.cwd,
          ...(['interactive','teams','remote'].includes(spec.mode) ? {sessionId:spec.sessionId || crypto.randomUUID(),resume:spec.resume === true} : {}),
          ...(suggested[spec.mode] ? {suggestedCommand:suggested[spec.mode]} : {}),
          ...(spec.initialCommand ? {initialCommand:spec.initialCommand} : {}), status: 'running', seq: 0 };
        await call('create', [spec], meta);
        if (w.fixture.createPending) await new Promise(resolve => { w.fixture.resolveCreate = resolve; });
        records.push(meta); return meta;
      },
      attach: async (id: string) => {
        await call('attach', [id], null);
        if (w.fixture.attachPending) return new Promise(resolve => { w.fixture.resolveAttach = resolve; });
        const record = records.find(r => r.id === id);
        return { snapshot: 'READY\r\n', lastSeq: 0, status: record.status, truncated: false };
      },
      write: (id: string, value: string) => call('write', [id, value], undefined),
      resize: (id: string, cols: number, rows: number) => call('resize', [id, cols, rows], undefined),
      close: async (id: string) => { await call('close', [id], undefined); w.fixture.exit({ id, status: 'exited', exitCode: 0, seq: 0 }); records.splice(records.findIndex(r => r.id === id), 1); },
      onData: (fn: Function) => { data.add(fn); return () => data.delete(fn); },
      onExit: (fn: Function) => { exits.add(fn); return () => exits.delete(fn); },
    } };
  });
  page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', e => errors.push(e.message));
});
afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') console.error('Terminal fixture:', errors, await page.locator('body').innerText().catch(() => 'No page'));
  await context?.close();
});
afterAll(async () => {
  try { await browser?.close(); await server?.close(); }
  finally { if (cacheDir) fs.rmSync(cacheDir, {recursive:true,force:true}); }
}, 60000);

async function openForm() {
  await page.goto(url);
  await page.waitForFunction(() => !!(window as any).terminalStore);
  await page.getByRole('button', { name: '侧栏终端' }).click();
  await page.getByLabel('工作目录').waitFor();
}

it('独立 StrictMode Host 从全局 show 打开原生表单，默认新 session 和当前 chat cwd', async () => {
  await openForm();
  expect(await page.getByLabel('工作目录').inputValue()).toBe('/project-a');
  expect(await page.getByLabel('恢复会话').inputValue()).toBe('');
  await page.getByLabel('Chrome', {exact:true}).selectOption('enabled');
  await page.getByLabel('IDE').check();
  await page.getByLabel('Worktree 名称（可选）').fill('feature-ui');
  await page.getByRole('button', { name: '创建终端', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'create'))).toHaveLength(1);
  const spec = await page.evaluate(() => (window as any).fixture.calls.find((c: any) => c.method === 'create').args[0]);
  expect(spec).toEqual({ mode: 'interactive', cwd: '/project-a', options: { chrome: true, ide: true, worktree: 'feature-ui' } });
  await page.getByRole('tab', { name: /Terminal 1/ }).waitFor();
  expect(errors).toEqual([]);
});

it('先订阅再 attach，快照切点去重且乱序保序，exit 竞态保留尾输出与退出状态', async () => {
  await openForm();
  await page.evaluate(() => { (window as any).fixture.attachPending = true; });
  await page.getByRole('button', { name: '创建终端', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).fixture.resolveAttach);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    const id = f.records[0].id;
    if (f.data.size !== 1 || f.exits.size !== 1) throw new Error('Listeners must exist before attach');
    f.emit({ id, seq: 3, data: 'THIRD\r\n', ownerWebContentsId: 12 });
    f.emit({ id, seq: 1, data: 'DUPLICATE\r\n' });
    f.exit({ id, seq: 3, status: 'exited', exitCode: 7 });
    f.resolveAttach({ snapshot: 'SNAPSHOT\r\n', lastSeq: 1, status: 'running', truncated: false });
    f.emit({ id, seq: 2, data: 'SECOND\r\n' });
    f.emit({ id, seq: 2, data: 'DUPLICATE\r\n' });
  });
  await page.getByRole('tab', { name: /已退出 \(7\)/ }).waitFor();
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('THIRD');
  const text = await page.locator('.xterm-rows').innerText();
  expect(text).toContain('SNAPSHOT');
  expect(text.indexOf('SECOND')).toBeLessThan(text.indexOf('THIRD'));
  expect(text).not.toContain('DUPLICATE');
  expect(errors).toEqual([]);
});

it('真实键盘与 ResizeObserver，隐藏/切聊天/终端 tab 保留同一 Host，重连只 attach，卸载不 close', async () => {
  await openForm();
  await page.getByRole('button', { name: '创建终端', exact: true }).click();
  const output = page.getByRole('tabpanel');
  await expect.poll(() => output.locator('.xterm-rows').innerText()).toContain('READY');
  await output.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'write').map((c: any) => c.args[1]).join(''))).toBe('hello\r');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'resize').length)).toBeGreaterThan(0);
  const before = await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'resize').length);
  await page.getByLabel('面板高度').selectOption('large');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'resize').length)).toBeGreaterThan(before);
  await page.evaluate(() => { (window as any).originalXterm = document.querySelector('.xterm'); });
  await page.getByRole('button', { name: '隐藏终端' }).click();
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.evaluate(() => {
    const w = window as any;
    w.chatStore.setState({activeConversationId:'chat-b'});
    w.fixture.emit({id:w.fixture.records[0].id,seq:1,data:'HIDDEN-TAIL\r\n'});
  });
  await page.getByRole('button', { name: '侧栏终端' }).click();
  expect(await page.getByLabel('工作目录').inputValue()).toBe('/project-b');
  expect(await page.evaluate(() => (window as any).originalXterm === document.querySelector('.xterm'))).toBe(true);
  await expect.poll(() => output.locator('.xterm-rows').innerText()).toContain('HIDDEN-TAIL');
  await page.getByRole('button', { name: '刷新列表' }).click();
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'attach').length)).toBe(1);
  await page.getByRole('button', { name: '创建终端', exact: true }).click();
  await page.getByRole('tab', { name: /Terminal 2/ }).waitFor();
  await page.getByRole('tab', { name: /Terminal 1/ }).click();
  expect(await page.evaluate(() => (window as any).originalXterm === document.querySelector('.xterm'))).toBe(true);
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'attach').length)).toBe(3);
  await page.evaluate(() => (window as any).unmountHost());
  expect(await page.evaluate(() => ({ data:(window as any).fixture.data.size, exits:(window as any).fixture.exits.size, close:(window as any).fixture.calls.filter((c: any) => c.method === 'close').length }))).toEqual({data:0,exits:0,close:0});
  const dimensions = await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'resize').map((c: any) => c.args.slice(1)));
  expect(dimensions.every(([cols, rows]: number[]) => cols > 0 && rows > 0)).toBe(true);
  expect(errors).toEqual([]);
});

it('缺失 API 与 health unavailable 禁用而不 crash，刷新恢复；错误保留终端，只有显式关闭 kill', async () => {
  await page.goto(url);
  await page.waitForFunction(() => !!(window as any).terminalStore);
  await page.evaluate(() => { const w = window as any; w.savedAPI = w.api; delete w.api; });
  await page.getByRole('button', { name: '侧栏终端' }).click();
  await page.getByRole('alert').filter({hasText:'IPC'}).waitFor();
  expect(await page.getByRole('button', { name:'创建终端',exact:true }).isDisabled()).toBe(true);
  await page.evaluate(() => { const w = window as any; w.api = w.savedAPI; w.api.terminal.health = async () => ({available:false,diagnostic:'PTY ABI mismatch'}); });
  await page.getByRole('button', { name:'刷新列表' }).click();
  await page.getByRole('alert').filter({hasText:'PTY ABI mismatch'}).waitFor();
  expect(await page.getByRole('button', { name:'创建终端',exact:true }).isDisabled()).toBe(true);
  await page.evaluate(() => { (window as any).api.terminal.health = async () => ({available:true}); (window as any).fixture.fail = 'list'; });
  await page.getByRole('button', { name:'刷新列表' }).click();
  await page.getByRole('alert').filter({hasText:'list unavailable'}).waitFor();
  await page.evaluate(() => { (window as any).fixture.fail = 'create'; });
  await page.getByRole('button', { name:'创建终端',exact:true }).click();
  await page.getByRole('alert').filter({hasText:'create unavailable'}).waitFor();
  await page.evaluate(() => { (window as any).fixture.fail = 'attach'; });
  await page.getByRole('button', { name:'创建终端',exact:true }).click();
  await page.getByRole('alert').filter({hasText:'attach unavailable'}).waitFor();
  await page.evaluate(() => { (window as any).fixture.fail = ''; });
  await page.getByRole('button', { name:'重新连接' }).click();
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('READY');
  await page.evaluate(() => { (window as any).fixture.fail = 'write'; });
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('x');
  await page.getByRole('alert').filter({hasText:'write unavailable'}).waitFor();
  await page.evaluate(() => { (window as any).fixture.fail = 'resize'; });
  await page.getByLabel('面板高度').selectOption('large');
  await page.getByRole('alert').filter({hasText:'resize unavailable'}).waitFor();
  await page.evaluate(() => { (window as any).fixture.fail = 'close'; });
  await page.getByRole('button', { name:'关闭 Terminal 1' }).click();
  await page.getByRole('alert').filter({hasText:'close unavailable'}).waitFor();
  expect(await page.getByRole('tab').count()).toBe(1);
  await page.evaluate(() => { (window as any).fixture.fail = ''; });
  await page.getByRole('button', { name:'关闭 Terminal 1' }).click();
  await page.getByRole('tab').waitFor({state:'detached'});
  await page.getByRole('button', {name:'刷新列表'}).click();
  await page.waitForFunction(() => !(window as any).terminalStore.getState().loading);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    const id = f.calls.find((c: any) => c.method === 'close').args[0];
    f.emit({id,seq:999,data:'AFTER-CLOSE'});
    f.exit({id,status:'exited',seq:1000,exitCode:0});
  });
  expect(await page.getByRole('tab').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).fixture.data.size)).toBe(0);
  expect(errors).toEqual([]);
});

it('session 恢复必须显式选择，各 mode 只发送对应选项，Cloud 仅已有 SID/URL，无模型 prompt', async () => {
  await openForm();
  const sid = await page.evaluate(() => {
    const sid = crypto.randomUUID();
    (window as any).chatStore.setState({sessions:[{sessionId:sid,cwd:'/archive',title:'历史会话'}]});
    return sid;
  });
  await page.getByLabel('恢复会话').selectOption(sid);
  await page.getByRole('button', {name:'创建终端',exact:true}).click();
  await page.getByRole('tab').waitFor();
  expect(await page.evaluate(() => (window as any).fixture.calls.find((c: any) => c.method === 'create').args[0])).toEqual({mode:'interactive',cwd:'/project-a',sessionId:sid,resume:true});
  for (const mode of ['teams','remote','shell','mcp','plugins','agents','auth','doctor','cloud']) {
    await page.getByLabel('模式', {exact:true}).selectOption(mode);
    if (mode === 'cloud') await page.getByLabel('已有 Cloud session ID 或 URL').fill('https://claude.ai/code/session_existing');
    await page.getByRole('button', {name:'创建终端',exact:true}).click();
    await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'create').at(-1).args[0].mode)).toBe(mode);
    await page.waitForFunction(() => !(window as any).terminalStore.getState().loading);
  }
  const specs = await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'create').map((c: any) => c.args[0]));
  for (const spec of specs.filter((s: any) => ['shell','mcp','plugins','agents','auth','doctor'].includes(s.mode))) expect(spec).toEqual({mode:spec.mode,cwd:'/project-a'});
  expect(specs.at(-1)).toEqual({mode:'cloud',cwd:'/project-a',options:{cloudSession:'https://claude.ai/code/session_existing'}});
  expect(await page.evaluate(() => (window as any).fixture.calls.some((c: any) => c.method === 'write'))).toBe(false);
  expect(errors).toEqual([]);
});

it('创建 promise 去重且隐藏期间完成不再打开面板；4 MiB 批量与快照截断显示官方终端 banner', async () => {
  await openForm();
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.createPending = true;
    const spec = {mode:'interactive',cwd:'/project-a'};
    const a = w.terminalStore.getState().create(spec);
    const b = w.terminalStore.getState().create(spec);
    if (a !== b) throw new Error('Create must deduplicate pending promise');
  });
  await page.waitForFunction(() => !!(window as any).fixture.resolveCreate);
  await page.getByRole('button', {name:'隐藏终端'}).click();
  await page.evaluate(() => { (window as any).fixture.resolveCreate(); });
  await page.waitForFunction(() => (window as any).terminalStore.getState().terminals.length === 1);
  expect(await page.getByRole('region', {name:'官方原生终端'}).count()).toBe(0);
  await page.getByRole('button', {name:'侧栏终端'}).click();
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('READY');
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.emit({id:f.records[0].id,seq:1,data:'x'.repeat(4 * 1024 * 1024) + '\r\nBULK-END\r\n',truncated:true});
  });
  await page.getByRole('status').filter({hasText:'历史已截断'}).waitFor();
  await expect.poll(() => page.locator('.xterm-rows').innerText(), {timeout:45000}).toContain('BULK-END');
  expect(await page.locator('pre').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'create').length)).toBe(1);
  expect(errors).toEqual([]);
}, 60000);

it('刷新旧响应不覆盖创建/关闭，session lock 错误可见，卸载后晚 attach 不创建 xterm 或关闭 PTY', async () => {
  await openForm();
  await page.evaluate(() => {
    const w = window as any;
    w.api.terminal.list = () => new Promise(resolve => { w.fixture.resolveList = resolve; });
    void w.terminalStore.getState().refresh();
  });
  await page.waitForFunction(() => !!(window as any).fixture.resolveList);
  await page.evaluate(async () => {
    const w = window as any;
    await w.terminalStore.getState().create({mode:'interactive',cwd:'/project-a'});
    w.fixture.resolveList([]);
  });
  await page.getByRole('tab').waitFor();
  expect(await page.getByRole('tab').count()).toBe(1);
  await page.evaluate(() => {
    const w = window as any;
    w.api.terminal.create = async () => { throw new Error('Terminal session busy'); };
  });
  await page.getByRole('button', {name:'创建终端',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Terminal session busy'}).waitFor();
  expect(await page.getByRole('tab').count()).toBe(1);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.attachPending = true;
  });
  await page.getByRole('button', {name:'重新连接'}).click();
  await page.waitForFunction(() => !!(window as any).fixture.resolveAttach);
  await page.evaluate(() => {
    const w = window as any;
    w.unmountHost();
    w.fixture.resolveAttach({snapshot:'LATE',lastSeq:0,status:'running',truncated:true});
  });
  expect(await page.locator('.xterm').count()).toBe(0);
  expect(await page.evaluate(() => ({data:(window as any).fixture.data.size,exits:(window as any).fixture.exits.size,close:(window as any).fixture.calls.filter((c: any) => c.method === 'close').length}))).toEqual({data:0,exits:0,close:0});
  expect(errors).toEqual([]);
});

it('仅 attach 快照也显示截断提示，并在重连后保留后端原有 PTY metadata', async () => {
  await openForm();
  await page.evaluate(() => {
    const w = window as any;
    w.api.terminal.attach = async (id: string) => {
      w.fixture.calls.push({method:'attach',args:[id]});
      return {snapshot:'RESTORED\r\n',lastSeq:120,status:'exited',exitCode:0,truncated:true};
    };
  });
  await page.getByRole('button', {name:'创建终端',exact:true}).click();
  await page.getByRole('status').filter({hasText:'历史已截断'}).waitFor();
  await page.getByRole('tab', {name:/已退出 \(0\)/}).waitFor();
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('RESTORED');
  await page.getByRole('button', {name:'重新连接'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'attach').length)).toBe(2);
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'create').length)).toBe(1);
  expect(errors).toEqual([]);
});

it('管理模式是真 shell，建议命令仅显式插入，不自动执行；IPC 占用显示 ID', async () => {
  await openForm();
  for (const [mode, command] of [['mcp','claude mcp --help'],['plugins','claude plugin --help'],['agents','claude agents --help']]) {
    await page.getByLabel('模式', {exact:true}).selectOption(mode);
    await page.getByRole('button', {name:'创建终端',exact:true}).click();
    await expect.poll(() => page.getByRole('tabpanel').locator('.xterm-rows').innerText()).toContain('READY');
    const writesBefore = await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'write').length);
    await page.getByRole('tabpanel').getByText(/完整 shell/).waitFor();
    await page.getByText(command, {exact:true}).waitFor();
    const id = await page.evaluate(() => (window as any).terminalStore.getState().activeTerminalId);
    await page.getByText(`原生 PTY 占用 · ${id}`, {exact:true}).waitFor();
    await page.getByRole('button', {name:'刷新列表'}).click();
    expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'write').length)).toBe(writesBefore);
    await page.getByRole('button', {name:'插入管理命令'}).click();
    await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'write').at(-1)?.args)).toEqual([id,command]);
    await page.getByRole('tabpanel').locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'write').at(-1)?.args)).toEqual([id,'\r']);
  }
  expect(errors).toEqual([]);
});

it('默认 Chrome/IDE 不覆盖 CLI，禁用 Chrome 显式 false，新 session 省略 resume；/hooks 预设等待用户操作', async () => {
  await openForm();
  await page.evaluate(() => (window as any).terminalStore.getState().show({}));
  expect(await page.evaluate(() => (window as any).fixture.calls.some((c: any) => c.method === 'create'))).toBe(false);
  await page.getByRole('button', {name:'创建终端',exact:true}).click();
  await page.getByRole('tab').waitFor();
  expect(await page.evaluate(() => (window as any).fixture.calls.find((c: any) => c.method === 'create').args[0])).toEqual({mode:'interactive',cwd:'/project-a'});
  await page.getByLabel('Chrome', {exact:true}).selectOption('disabled');
  await page.getByLabel('交互预设').selectOption('/hooks');
  await page.getByRole('button', {name:'创建终端',exact:true}).click();
  await page.getByRole('button', {name:'执行 /hooks',exact:true}).waitFor();
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'create').at(-1).args[0])).toEqual({mode:'interactive',cwd:'/project-a',options:{chrome:false},initialCommand:'/hooks'});
  expect(await page.evaluate(() => (window as any).fixture.calls.some((c: any) => c.method === 'write'))).toBe(false);
  await page.getByRole('button', {name:'执行 /hooks',exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'write').at(-1)?.args[1])).toBe('/hooks');
  await page.getByRole('button', {name:'发送回车',exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'write').at(-1)?.args[1])).toBe('\r');
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.exit({id:w.terminalStore.getState().activeTerminalId,status:'exited',exitCode:0});
  });
  expect(await page.getByRole('button', {name:'执行 /hooks',exact:true}).isDisabled()).toBe(true);
  expect(errors).toEqual([]);
});

it('metadata 命令只允许固定预设，显式写入失败可见；show 草稿不自动创建或恢复 chat SID', async () => {
  await openForm();
  const sid = await page.evaluate(() => {
    const w = window as any;
    const sid = crypto.randomUUID();
    w.chatStore.setState({conversations:[{id:'chat-a',cwd:'/project-a',sessionId:sid}]});
    w.terminalStore.getState().show({mode:'interactive',initialCommand:'/hooks'});
    return sid;
  });
  expect(await page.getByLabel('恢复会话').inputValue()).toBe('');
  expect(await page.getByLabel('交互预设').inputValue()).toBe('/hooks');
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'create').length)).toBe(0);
  await page.getByRole('button', {name:'创建终端',exact:true}).click();
  await expect.poll(() => page.getByRole('tabpanel').locator('.xterm-rows').innerText()).toContain('READY');
  expect(await page.evaluate(() => (window as any).fixture.records[0].sessionId)).not.toBe(sid);
  await page.evaluate(() => { (window as any).fixture.fail = 'write'; });
  await page.getByRole('button', {name:'执行 /hooks',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'write unavailable'}).waitFor();
  await page.evaluate(() => {
    const w = window as any;
    const current = w.terminalStore.getState();
    w.terminalStore.setState({terminals:current.terminals.map((term: any) => ({...term,mode:'mcp',suggestedCommand:'rm -rf untrusted',initialCommand:'/not-whitelisted'}))});
  });
  expect(await page.getByRole('button', {name:'插入管理命令'}).count()).toBe(0);
  expect(await page.getByRole('button', {name:/执行 \//}).count()).toBe(0);
  expect(errors).toEqual([]);
});

it('显式 close 立即 closing，pending 去重不移除，拒绝/失败对象保留锁状态，手动重试成功才移除', async () => {
  await openForm();
  await page.getByRole('button', {name:'创建终端',exact:true}).click();
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('READY');
  await page.evaluate(() => {
    const w = window as any;
    w.api.terminal.close = (id: string) => {
      w.fixture.calls.push({method:'close',args:[id]});
      return new Promise((resolve,reject) => { w.fixture.resolveClose = resolve; w.fixture.rejectClose = reject; });
    };
  });
  await page.getByRole('button', {name:'关闭 Terminal 1'}).click();
  await page.getByRole('tab', {name:/关闭中/}).waitFor();
  await page.evaluate(() => {
    const w = window as any;
    const id = w.terminalStore.getState().activeTerminalId;
    void w.terminalStore.getState().close(id).catch(() => {});
    w.fixture.emit({id,seq:1,data:'CLOSING-TAIL\r\n'});
  });
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'close').length)).toBe(1);
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('CLOSING-TAIL');
  expect(await page.getByRole('button', {name:'关闭 Terminal 1'}).isDisabled()).toBe(true);
  await page.evaluate(() => (window as any).fixture.rejectClose(new Error('close timeout: process alive')));
  await page.getByRole('alert').filter({hasText:'close timeout: process alive'}).waitFor();
  expect(await page.getByRole('tab', {name:/关闭中/}).count()).toBe(1);
  expect(await page.getByRole('button', {name:'关闭 Terminal 1'}).isEnabled()).toBe(true);
  await page.getByRole('button', {name:'关闭 Terminal 1'}).click();
  await page.evaluate(() => (window as any).fixture.resolveClose({success:false,error:'close refused'}));
  await page.getByRole('alert').filter({hasText:'close refused'}).waitFor();
  expect(await page.getByRole('tab', {name:/关闭中/}).count()).toBe(1);
  await page.getByRole('button', {name:'关闭 Terminal 1'}).click();
  await page.evaluate(() => {
    const w = window as any;
    const id = w.terminalStore.getState().activeTerminalId;
    w.fixture.exit({id,status:'exited',exitCode:0});
    w.fixture.resolveClose({id,status:'exited',exitCode:0});
  });
  await page.getByRole('tab').waitFor({state:'detached'});
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.exit({id:f.calls.find((c: any) => c.method === 'close').args[0],status:'exited',exitCode:0});
  });
  expect(await page.getByRole('tab').count()).toBe(0);
  expect(errors).toEqual([]);
});

it('health 拒绝或 unavailable 仍读取真实 list，关闭失败可刷新退出状态，不自动重试 IPC', async () => {
  await openForm();
  await page.getByRole('button', {name:'创建终端',exact:true}).click();
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('READY');
  await page.evaluate(() => { (window as any).fixture.fail = 'close'; });
  await page.getByRole('button', {name:'关闭 Terminal 1'}).click();
  await page.getByRole('alert').filter({hasText:'close unavailable'}).waitFor();
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.fail = 'health';
    w.fixture.records[0].status = 'exited';
    w.fixture.records[0].exitCode = 9;
  });
  await page.getByRole('button', {name:'刷新列表'}).click();
  await page.getByRole('tab', {name:/已退出 \(9\)/}).waitFor();
  await page.getByRole('alert').filter({hasText:'health unavailable'}).waitFor();
  expect(await page.getByRole('button', {name:'创建终端',exact:true}).isDisabled()).toBe(true);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.fail = '';
    w.api.terminal.health = async () => ({available:false,diagnostic:'PTY ABI unavailable'});
    w.fixture.records[0].title = 'Actual metadata';
  });
  await page.getByRole('button', {name:'刷新列表'}).click();
  await page.getByRole('tab', {name:/Actual metadata/}).waitFor();
  await page.getByRole('alert').filter({hasText:'PTY ABI unavailable'}).waitFor();
  const before = await page.evaluate(() => (window as any).fixture.calls.length);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => (window as any).fixture.calls.length)).toBe(before);
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'close').length)).toBe(1);
  expect(errors).toEqual([]);
});
