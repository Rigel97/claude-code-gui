import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer, type Server } from 'node:http';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server: ViteDevServer;
let httpServer: Server;
let cacheDir: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let url: string;
const errors: string[] = [];
const readLabel = '读取CLI命令（加载项目配置，不发送提示词）';
const field = () => page.getByRole('textbox', { name: '消息输入', exact: true });

beforeAll(async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-ui-vite-'));
  httpServer = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  server = await createServer({
    cacheDir,
    configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: 'custom',
    plugins: [{
      name: 'commands-isolated-browser-fixture',
      resolveId(id) { if (id === '/commands-fixture.tsx') return '\0commands-fixture.tsx'; },
      load(id) {
        if (id !== '\0commands-fixture.tsx') return;
        return `import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {InputBar} from '${root}/src/renderer/components/InputBar.tsx';
          import {SkillList} from '${root}/src/renderer/components/SkillList.tsx';
          import {useStore} from '${root}/src/renderer/store.ts';
          window.chatStore = useStore;
          useStore.setState({cwd:'/global',model:'pending-model',permissionMode:'default',effortLevel:'high',autocompact:'100k',maxBudgetUsd:2});
          useStore.getState().newConversation({id:'chat-a',cwd:'/project-a'});
          useStore.getState().newConversation({id:'chat-b',cwd:'/project-b',draft:'B draft'});
          useStore.getState().setActiveConversation('chat-a');
          const originalSend = useStore.getState().sendPrompt;
          useStore.setState({sendPrompt: (...args) => {
            window.fixture.dispatches.push(args);
            if (window.fixture.throwDispatch) return Promise.reject(new Error('dispatch rejected'));
            return originalSend(...args);
          }});
          function App() {
            const conv = useStore(s=>s.conversations.find(c=>c.id===s.activeConversationId));
            const diagnostics = [...conv.messages.flatMap(message=>message.blocks),...(conv.streamingMessage?.blocks ?? [])]
              .filter(block=>block.kind==='stderr').map(block=>block.text).join('\\n');
            return React.createElement(React.Fragment,null,
              React.createElement('section',{'aria-label':'聊天诊断'},diagnostics),
              React.createElement(SkillList),React.createElement(InputBar,{key:conv.id,initialDraft:conv.draft}));
          }
          createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));`;
      },
      configureServer(vite) {
        vite.middlewares.use('/__commands_test', async (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(await vite.transformIndexHtml('/__commands_test', '<html><body><div id="root"></div><script type="module" src="/commands-fixture.tsx"></script></body></html>'));
        });
      },
    }],
  });
  // HTTP and HMR share the OS-assigned port, with an isolated dependency cache.
  httpServer.on('request', server.middlewares);
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  url = `http://127.0.0.1:${address.port}/__commands_test`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
}, 60000);

beforeEach(async () => {
  errors.length = 0;
  context = await browser.newContext();
  await context.addInitScript(() => {
    const w = window as any;
    const calls: any[] = [];
    w.fixture = {
      calls, dispatches: [], fail: '', rejectSend: false, delaySend: false, delayCommands: false,
      commands: [
        { name: 'commit', description: 'CLI commit', argumentHint: '[message]', prompt: 'FAKE TEMPLATE NEVER SEND' },
        { name: 'context', description: 'CLI context' }, { name: 'compact', description: 'CLI compact' },
        { name: 'model', description: 'CLI model', argumentHint: '[model]' },
        { name: 'clear', description: 'CLI clear' }, { name: '审查', description: '多语言' },
        { name: 'plugin:review', description: 'Plugin' }, { name: 'plugin/check', description: 'Plugin path' },
        { name: 'commit', description: 'duplicate' }, null, { name: 'bad name' }, { name: 9 },
      ],
    };
    const record = (method: string, payload: unknown) => {
      calls.push({ method, payload });
      if (w.fixture.fail === method) throw new Error(`${method} unavailable`);
    };
    w.api = {
      claude: {
        commands: async (spec: any) => {
          record('commands', spec);
          if (w.fixture.delayCommands) await new Promise(resolve => { w.fixture.resolveCommands = resolve; });
          return w.fixture.commands;
        },
        runtimeState: async (spec: any) => {
          record('runtimeState', spec);
          return { conversationId: spec.conversationId, state: 'ready', busy: false, sessionId: w.fixture.sessionId ??= crypto.randomUUID(), runId: w.fixture.runId ??= crypto.randomUUID(), info: { model: 'actual-model', permissionMode: 'plan' } };
        },
        send: async (payload: any) => {
          record('send', payload);
          if (w.fixture.delaySend) await new Promise(resolve => { w.fixture.resolveSend = resolve; });
          if (w.fixture.rejectSend) return { success: false, error: 'SDK send rejected' };
          return { success: true, userMessageId: payload.userMessageId, sessionId: w.fixture.sessionId ??= crypto.randomUUID(), runId: w.fixture.runId ??= crypto.randomUUID() };
        },
        interrupt: async (id: string) => { record('interrupt', id); return { success: true, closed: false, stillQueued: [] }; },
        close: async (id: string) => { record('close', id); return { success: true, closed: true }; },
        start: async (spec: any) => { record('start', spec); throw new Error('No automatic bootstrap'); },
      },
      fs: { saveImage: async () => { throw new Error('image save rejected'); } },
      skills: {
        list: async (cwd: string) => {
          record('skills.list', cwd);
          return [
            { name: '审查', description: 'Skill', path: `${cwd}/.claude/skills/审查/SKILL.md`, scope: 'project' },
            { name: 'plugin:review', description: 'Plugin skill', path: '/global/plugin/SKILL.md', scope: 'global' },
            { name: 'plugin/check', description: 'Plugin path', path: '/global/check/SKILL.md', scope: 'global' },
            { name: 'bad name', description: 'Legacy', path: '/legacy/SKILL.md', scope: 'global' },
            { name: '审查', description: 'Duplicate', path: '/global/审查/SKILL.md', scope: 'global' }, null,
          ];
        },
        create: async (spec: any) => { record('skills.create', spec); return { ok: true }; },
        delete: async (skillPath: string) => { record('skills.delete', skillPath); return true; },
        reveal: async (skillPath: string) => { record('skills.reveal', skillPath); },
      },
    };
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  // Cold Vite dependency transforms compete with other browser suites in npm test.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await field().waitFor({ timeout: 60000 });
}, 90000);
afterEach(async () => { await context?.close(); expect(errors).toEqual([]); });
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (httpServer?.listening) await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
  if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
}, 60000);

const calls = (method: string) => page.evaluate(method => (window as any).fixture.calls.filter((call: any) => call.method === method), method);
async function known(commands: unknown[]) {
  await page.evaluate(commands => {
    const store = (window as any).chatStore;
    store.setState({ conversations: store.getState().conversations.map((c: any) => c.id === 'chat-a' ? { ...c, commands } : c) });
  }, commands);
}
async function busy() {
  await page.evaluate(() => {
    const store = (window as any).chatStore;
    store.setState({ conversations: store.getState().conversations.map((c: any) => ({ ...c, status: 'streaming', queue: c.id === 'chat-a' ? ['existing-a'] : ['existing-b'], currentModel: 'actual-model' })) });
  });
}

it('仅用户点击发现命令，使用会话 cwd 和完整选项快照，无模型探测和伪命令', async () => {
  expect(await calls('commands')).toHaveLength(0);
  expect(await calls('send')).toHaveLength(0);
  await field().fill('/');
  expect(await calls('commands')).toHaveLength(0);
  expect(await page.getByRole('button', { name: '/commit', exact: true }).count()).toBe(0);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.delayCommands = true;
    const s = w.chatStore;
    s.setState({ conversations: s.getState().conversations.map((c: any) => c.id === 'chat-a' ? { ...c, permissionMode: 'acceptEdits' } : c) });
  });
  await page.getByRole('button', { name: readLabel, exact: true }).click();
  await page.waitForFunction(() => !!(window as any).fixture.resolveCommands);
  expect(await page.getByRole('button', { name: '读取中…' }).isDisabled()).toBe(true);
  expect(await calls('commands')).toEqual([{ method: 'commands', payload: { conversationId: 'chat-a', cwd: '/project-a', options: { model: 'pending-model', permissionMode: 'acceptEdits', effortLevel: 'high', autocompact: '100k', maxBudgetUsd: 2 } } }]);
  await page.evaluate(() => (window as any).fixture.resolveCommands());
  await page.getByRole('button', { name: /\/commit\s*CLI commit \[message\]/ }).waitFor();
  expect(await page.getByRole('button', { name: /\/commit/ }).count()).toBe(1);
  expect(await page.getByRole('button', { name: /\/context/ }).count()).toBe(1);
  expect(await page.getByRole('button', { name: /\/compact/ }).count()).toBe(1);
  expect(await page.getByRole('button', { name: /\/model\s*CLI/ }).count()).toBe(1);
  expect(await calls('runtimeState')).toEqual([{ method: 'runtimeState', payload: { conversationId: 'chat-a' } }]);
  expect(await calls('send')).toHaveLength(0);
  expect(await calls('start')).toHaveLength(0);
  expect(await page.locator('body').innerText()).not.toContain('FAKE TEMPLATE');
  expect(await page.locator('body').innerText()).toContain('actual-model');
  expect(await page.locator('body').innerText()).toContain('非当前运行模型');
});

it('Enter 只补全再第二次发送字面量，TAB 支持多语言、命名空间及 plugin/ heads', async () => {
  await known([{ name: 'commit', description: '真实描述', argumentHint: '[message]', prompt: '中文 fake' }, '审查', 'plugin:review', '/plugin/check']);
  await field().fill('/com');
  await field().press('Enter');
  expect(await field().inputValue()).toBe('/commit ');
  expect(await field().getAttribute('placeholder')).toBe('[message]');
  expect(await calls('send')).toHaveLength(0);
  await field().press('Enter');
  await expect.poll(() => calls('send')).toHaveLength(1);
  const payload = (await calls('send'))[0].payload;
  expect(payload).toMatchObject({ prompt: '/commit', cwd: '/project-a', conversationId: 'chat-a', resume: false, options: { model: 'pending-model', permissionMode: 'default' } });
  expect(payload.userMessageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations[0].messages.find((m: any) => m.role === 'user').id)).toBe(payload.userMessageId);
  for (const [head, expected] of [['/审', '/审查 '], ['/plugin:r', '/plugin:review '], ['/plugin/c', '/plugin/check ']]) {
    await field().fill(head);
    await field().press('Tab');
    expect(await field().inputValue()).toBe(expected);
  }
  expect(await calls('send')).toHaveLength(1);
});

it('未知 slash 与 /clear 不拦截、不创建标签、不替换 prompt', async () => {
  await field().fill('/unknown arg 中文');
  await field().press('Enter');
  await expect.poll(() => calls('send')).toHaveLength(1);
  expect((await calls('send'))[0].payload.prompt).toBe('/unknown arg 中文');
  await page.evaluate(() => {
    const store = (window as any).chatStore;
    store.getState().setStatus('idle', 'chat-a');
    store.getState().setRuntime('chat-a', { busy: false, state: 'ready' });
  });
  await field().fill('/clear');
  expect(await page.locator('body').innerText()).toContain('不会新建 GUI 标签页');
  await field().press('Enter');
  await expect.poll(() => calls('send')).toHaveLength(2);
  expect((await calls('send'))[1].payload.prompt).toBe('/clear');
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations.length)).toBe(2);
  expect(await calls('close')).toHaveLength(0);
});

it('运行中 Enter 继续排队，Ctrl+Enter 直接 send 且不 abort，按钮插话/明确停止发送不改其他队列', async () => {
  await busy();
  await field().fill('queued');
  await field().press('Enter');
  expect(await calls('send')).toHaveLength(0);
  expect(await page.getByRole('button', { name: '停止', exact: true }).count()).toBe(1);
  expect(await page.getByRole('button', { name: '排队发送', exact: true }).count()).toBe(1);
  await field().fill('insert literal');
  await field().press('Control+Enter');
  await expect.poll(() => calls('send')).toHaveLength(1);
  expect(await calls('interrupt')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).fixture.dispatches[0])).toEqual(['insert literal', 'chat-a', { interrupt: false }]);
  await page.getByLabel('发送方式').selectOption('insert');
  await field().fill('/unknown insert');
  await page.getByRole('button', { name: '立即插话', exact: true }).click();
  await expect.poll(() => calls('send')).toHaveLength(2);
  expect(await calls('interrupt')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations.map((c: any) => c.queue))).toEqual([['existing-a', 'queued'], ['existing-b']]);
  await page.getByLabel('发送方式').selectOption('interrupt');
  await field().fill('stop then send');
  await page.getByRole('button', { name: '停止并发送', exact: true }).click();
  await expect.poll(() => calls('send')).toHaveLength(3);
  expect(await calls('interrupt')).toEqual([{ method: 'interrupt', payload: 'chat-a' }]);
  expect(await page.evaluate(() => (window as any).fixture.dispatches.at(-1))).toEqual(['stop then send', 'chat-a', { interrupt: true }]);
  // An explicitly confirmed stop cancels this conversation's pending GUI queue, never another tab's.
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations.map((c: any) => c.queue))).toEqual([[], ['existing-b']]);
  await field().press('Escape');
  await expect.poll(() => calls('interrupt')).toHaveLength(2);
});

it('IME Enter/TAB/Ctrl+Enter 不触发动作，Shift+Enter 保留换行，Escape 先关闭补全面板', async () => {
  await known(['审查']);
  await field().fill('/审');
  await field().dispatchEvent('compositionstart');
  await field().press('Enter');
  await field().press('Tab');
  await field().focus();
  await field().press('Control+Enter');
  expect(await calls('send')).toHaveLength(0);
  expect(await field().inputValue()).not.toBe('/审查 ');
  await field().dispatchEvent('compositionend');
  await field().fill('/审');
  await field().press('Shift+Enter');
  expect(await field().inputValue()).toBe('/审\n');
  await busy();
  await field().fill('/审');
  await field().press('Escape');
  expect(await calls('interrupt')).toHaveLength(0);
  await field().press('Escape');
  await expect.poll(() => calls('interrupt')).toHaveLength(1);
});

it('SDK discovery 和发送拒绝/throw/缺 API/未设置 cwd 均可见错误且保留草稿', async () => {
  await field().fill('/');
  await page.evaluate(() => { (window as any).fixture.fail = 'commands'; });
  await page.getByRole('button', { name: readLabel, exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'commands unavailable' }).waitFor();
  expect(await field().inputValue()).toBe('/');
  expect(await calls('send')).toHaveLength(0);
  await page.evaluate(() => { const f = (window as any).fixture; f.fail = ''; f.rejectSend = true; });
  await field().fill('/unknown preserved');
  await field().press('Enter');
  await page.getByRole('alert').filter({ hasText: 'SDK send rejected' }).waitFor();
  expect(await field().inputValue()).toBe('/unknown preserved');
  await page.evaluate(() => { (window as any).fixture.throwDispatch = true; });
  await field().fill('throw preserved');
  await field().press('Enter');
  await page.getByRole('alert').filter({ hasText: 'dispatch rejected' }).waitFor();
  expect(await field().inputValue()).toBe('throw preserved');
  await page.evaluate(() => { delete (window as any).api.claude.send; });
  await field().fill('IPC preserved');
  await field().press('Enter');
  await page.getByRole('alert').filter({ hasText: '发送 IPC 不可用' }).waitFor();
  expect(await field().inputValue()).toBe('IPC preserved');
  await page.evaluate(() => {
    const store = (window as any).chatStore;
    store.setState({ conversations: store.getState().conversations.map((c: any) => c.id === 'chat-a' ? { ...c, cwd: '' } : c) });
  });
  await field().press('Enter');
  await page.getByRole('alert').filter({ hasText: '未设置工作目录' }).waitFor();
  expect(await field().inputValue()).toBe('IPC preserved');
});

it.each([false, true])('回执前 CLI warning 不代表发送失败：transport rejected=%s', async (rejected) => {
  await busy();
  await page.evaluate(rejected => {
    const f = (window as any).fixture;
    f.delaySend = true;
    f.rejectSend = rejected;
  }, rejected);
  await field().fill('warning receipt prompt');
  await field().press('Control+Enter');
  await page.waitForFunction(() => !!(window as any).fixture.resolveSend);
  await page.evaluate(() => {
    (window as any).chatStore.getState().handleStream({
      type: 'stderr', text: 'CLI configuration warning before receipt', timestamp: Date.now(), conversationId: 'chat-a',
    });
  });
  await expect.poll(() => page.getByRole('region', { name: '聊天诊断' }).innerText()).toContain('CLI configuration warning before receipt');
  expect(await field().inputValue()).toBe('warning receipt prompt');
  expect(await calls('send')).toHaveLength(1);
  await page.evaluate(() => (window as any).fixture.resolveSend());
  if (rejected) {
    await page.getByRole('alert').filter({ hasText: 'SDK send rejected' }).waitFor();
    expect(await field().inputValue()).toBe('warning receipt prompt');
  } else {
    await expect.poll(() => field().inputValue()).toBe('');
    expect(await page.getByRole('alert').count()).toBe(0);
    // Empty Enter must not resend or queue a prompt that was already accepted.
    await field().press('Enter');
    await field().press('Control+Enter');
  }
  expect(await calls('send')).toHaveLength(1);
  expect(await calls('interrupt')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations.map((c: any) => c.queue))).toEqual([['existing-a'], ['existing-b']]);
  expect(await page.evaluate(() => {
    const c = (window as any).chatStore.getState().conversations[0];
    return { status: c.status, draft: c.draft, users: c.messages.filter((m: any) => m.role === 'user').length };
  })).toEqual({ status: 'streaming', draft: rejected ? 'warning receipt prompt' : '', users: 1 });
  expect(await page.getByRole('region', { name: '聊天诊断' }).innerText()).toContain('CLI configuration warning before receipt');
});

it('运行中 SDK 拒绝 resolve void 也保留草稿、队列以及现有生成', async () => {
  await busy();
  await page.evaluate(() => { (window as any).fixture.rejectSend = true; });
  await field().fill('busy rejected');
  await field().press('Control+Enter');
  await page.getByRole('alert').filter({ hasText: 'SDK send rejected' }).waitFor();
  expect(await field().inputValue()).toBe('busy rejected');
  expect(await calls('interrupt')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations[0].status)).toBe('streaming');
});

it('延迟发送期间新输入、切 tab 和重新编辑均不被旧 Promise 清空', async () => {
  await page.evaluate(() => { (window as any).fixture.delaySend = true; });
  await field().fill('original');
  await field().press('Enter');
  await page.waitForFunction(() => !!(window as any).fixture.resolveSend);
  await field().fill('new typing');
  await page.evaluate(() => (window as any).fixture.resolveSend());
  await page.getByRole('button', { name: '排队发送' }).waitFor();
  expect(await field().inputValue()).toBe('new typing');
  await field().fill('pending again');
  await field().press('Control+Enter');
  await expect.poll(() => calls('send')).toHaveLength(2);
  await page.evaluate(() => (window as any).chatStore.getState().setActiveConversation('chat-b'));
  expect(await field().inputValue()).toBe('B draft');
  await field().fill('B edited');
  await page.evaluate(() => (window as any).chatStore.getState().setActiveConversation('chat-a'));
  await field().fill('A remounted edit');
  await page.evaluate(() => (window as any).fixture.resolveSend());
  expect(await field().inputValue()).toBe('A remounted edit');
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations.map((c: any) => c.draft))).toEqual(['A remounted edit', 'B edited']);
});

it('技能取当前会话 cwd，插入不发送，非法名称禁用且显示同名技能路径，切 tab 重新读取', async () => {
  await page.getByRole('button', { name: '插入 /审查', exact: true }).first().waitFor();
  expect((await calls('skills.list')).every((call: { payload: unknown }) => call.payload === '/project-a')).toBe(true);
  expect(await page.getByRole('button', { name: '插入 /bad name', exact: true }).isDisabled()).toBe(true);
  expect(await page.locator('body').innerText()).toContain('/legacy/SKILL.md');
  expect(await page.locator('body').innerText()).toContain('/global/审查/SKILL.md');
  await page.getByRole('button', { name: '插入 /审查', exact: true }).first().click();
  await expect.poll(() => field().inputValue()).toBe('/审查 ');
  expect(await calls('send')).toHaveLength(0);
  await page.evaluate(() => (window as any).chatStore.getState().setActiveConversation('chat-b'));
  await expect.poll(() => calls('skills.list')).toContainEqual({ method: 'skills.list', payload: '/project-b' });
  await field().fill('');
  await page.getByRole('button', { name: '插入 /plugin:review', exact: true }).click();
  await expect.poll(() => field().inputValue()).toBe('/plugin:review ');
  await field().press('Enter');
  await expect.poll(() => calls('send')).toHaveLength(1);
  expect((await calls('send'))[0].payload).toMatchObject({ conversationId: 'chat-b', cwd: '/project-b', prompt: '/plugin:review' });
  await field().fill('/');
  await page.getByRole('button', { name: readLabel, exact: true }).click();
  await expect.poll(() => calls('commands')).toHaveLength(1);
  expect((await calls('commands'))[0].payload.cwd).toBe('/project-b');
});

it('技能列表错误可刷新恢复，SDK 关闭后不自动重读，显式点击可再次发现', async () => {
  await page.evaluate(() => { (window as any).fixture.fail = 'skills.list'; });
  await page.getByRole('button', { name: '刷新技能列表' }).click();
  await page.getByRole('alert').filter({ hasText: 'skills.list unavailable' }).waitFor();
  await page.evaluate(() => { (window as any).fixture.fail = ''; });
  await page.getByRole('button', { name: '刷新技能列表' }).click();
  await page.getByRole('button', { name: '插入 /plugin/check', exact: true }).waitFor();
  await field().fill('/');
  await page.getByRole('button', { name: readLabel, exact: true }).click();
  await page.getByRole('button', { name: /\/commit\s*CLI commit \[message\]/ }).waitFor();
  await page.evaluate(() => (window as any).chatStore.getState().setRuntime('chat-a', { state: 'closed' }));
  await expect.poll(() => page.getByRole('button', { name: /\/commit\s*CLI commit \[message\]/ }).count()).toBe(0);
  expect(await calls('commands')).toHaveLength(1);
  // A reopened SDK runtime has a new generation; a retired run must not be rebound.
  await page.evaluate(() => { (window as any).fixture.runId = crypto.randomUUID(); });
  await page.getByRole('button', { name: readLabel, exact: true }).click();
  await page.getByRole('button', { name: /\/commit\s*CLI commit \[message\]/ }).waitFor();
  expect(await calls('commands')).toHaveLength(2);
  expect(await calls('send')).toHaveLength(0);
});

it('图片粘贴保存异常显示错误、不清掉原有消息', async () => {
  await field().fill('keep paste draft');
  await field().evaluate(element => {
    const data = new DataTransfer();
    data.items.add(new File(['fake image'], 'shot.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await page.getByRole('alert').filter({ hasText: 'image save rejected' }).waitFor();
  expect(await field().inputValue()).toBe('keep paste draft');
  expect(await calls('send')).toHaveLength(0);
});
