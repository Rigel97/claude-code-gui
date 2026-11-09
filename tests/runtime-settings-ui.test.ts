import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Component/API seam only: this partial preload fixture is not full App/main workflow coverage.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let url: string;
const errors: string[] = [];

beforeAll(async () => {
  server = await createServer({
    configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{
      name: 'runtime-settings-fixture',
      resolveId(id) { if (id === '/runtime-fixture.tsx') return '\0runtime-fixture.tsx'; },
      load(id) {
        if (id !== '\0runtime-fixture.tsx') return;
        return `import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {SettingsPanel} from '${root}/src/renderer/components/SettingsPanel.tsx';
          import {useStore} from '${root}/src/renderer/store.ts';
          import {useTerminalStore} from '${root}/src/renderer/terminalStore.ts';
          window.chatStore = useStore;
          window.terminalStore = useTerminalStore;
          useStore.setState({model:'',permissionMode:'default',effortLevel:'',autocompact:'',maxBudgetUsd:0,cwd:'/fallback',
            conversations:[{id:'chat-a',cwd:'/project',sessionId:'session-a',status:'completed',messages:[],queue:[],pendingApprovals:[],protocolConnected:true,permissionMode:'default',runtime:{state:'ready',busy:false,runId:'run-a',info:{permissionMode:'default'}}}],activeConversationId:'chat-a'});
          createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,
            React.createElement(SettingsPanel,{onClose:()=>{window.fixture.closed++}})));`;
      },
      configureServer(vite) {
        vite.middlewares.use('/__runtime_test', async (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(await vite.transformIndexHtml('/__runtime_test', '<html><body><div id="root"></div><script type="module" src="/runtime-fixture.tsx"></script></body></html>'));
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  url = `http://127.0.0.1:${address.port}/__runtime_test`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
}, 60000);

beforeEach(async () => {
  errors.length = 0;
  context = await browser.newContext();
  await context.addInitScript(() => {
    const w = window as any;
    w.fixture = { calls: [], closed: 0, fail: '', confirms: [], consent: true,
      summary: {executable:null,environmentKeys:['ANTHROPIC_AUTH_TOKEN','HTTPS_PROXY'],removedKeys:[],encryptionAvailable:true,persisted:true,endpoint:'https://gateway.invalid/api',versionFingerprint:'v1'},
      runtime: {state:'ready',busy:false,sessionId:'session-a',runId:'run-a',info:{permissionMode:'default'}},
    };
    w.confirm = (message: string) => { w.fixture.confirms.push(message); return w.fixture.consent; };
    const call = async (method: string, args: unknown[], result: unknown) => {
      w.fixture.calls.push({method,args});
      if (w.fixture.fail === method) throw new Error(`${method} failed; existing configuration was not changed`);
      return structuredClone(result);
    };
    w.api = {
      runtime: {
        get: () => call('get', [], w.fixture.summary),
        set: async (options: any, storage: any) => {
          await call('set', [options,storage], null);
          const summary = w.fixture.summary;
          if ('executable' in options) summary.executable = options.executable;
          for (const update of options.environmentUpdates || []) {
            summary.environmentKeys = summary.environmentKeys.filter((k: string) => k !== update.key);
            if (!update.remove) summary.environmentKeys.push(update.key);
          }
          summary.persisted = storage.persist;
          summary.versionFingerprint = 'v2';
          return structuredClone(summary);
        },
        diagnostics: () => call('diagnostics', [], {...w.fixture.summary,version:'2.1.99',error:null}),
      },
      claude: {
        runtimeState: (id: string) => call('runtimeState', [id], w.fixture.runtime),
        mode: async (payload: any) => {
          if (w.fixture.modeRejected) return call('mode', [payload], {success:false,error:'mode rejected'});
          await call('mode',[payload],null);
          w.fixture.runtime.info.permissionMode = payload.mode;
          return {success:true};
        },
        close: async (id: string) => {
          const result = await call('close',[id],w.fixture.closeRejected ? {success:false,error:'busy owner blocks close'} : {success:true});
          if (w.fixture.closePending) await new Promise(resolve => { w.fixture.resolveClose = resolve; });
          if ((result as any).success) w.fixture.runtime = {...w.fixture.runtime,state:'closed',busy:false};
          return result;
        },
        start: async (payload: any) => {
          await call('start',[payload],null);
          w.fixture.runtime = {state:'ready',busy:false,runId:'run-b',sessionId:'session-a',info:{permissionMode:payload.options.permissionMode}};
          return {success:true,runId:'run-b',sessionId:'session-a',info:{permissionMode:payload.options.permissionMode}};
        },
      },
      terminal: { health: async () => ({available:true}),list:async()=>[] },
    };
  });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', e => errors.push(e.message));
});
afterEach(async () => { await context?.close(); expect(errors).toEqual([]); });
afterAll(async () => { await browser?.close(); await server?.close(); }, 60000);
async function open() {
  await page.goto(url);
  await page.waitForFunction(() => !!(window as any).chatStore);
}
it('保存全局权限后以 conversationId+mode 更新 ready 对话，成功才刷新真实运行状态', async () => {
  await open();
  for (const name of ['逐次审批', '仅自动接受文件编辑', '只读规划', '自动审批（依赖 CLI 可用）', '仅规则、不弹问', '全部放行（危险）']) {
    expect(await page.getByRole('button', {name: new RegExp(name.replace(/[()（）]/g, '.'))}).count()).toBe(1);
  }
  await page.getByRole('button', {name:/只读规划/}).click();
  await page.getByRole('button', {name:'保存',exact:true}).click();
  await expect.poll(() => calls('mode')).toHaveLength(1);
  expect((await calls('mode'))[0].args).toEqual([{conversationId:'chat-a',mode:'plan'}]);
  await expect.poll(() => page.evaluate(() => (window as any).chatStore.getState().conversations[0].permissionMode)).toBe('plan');
  expect(await page.evaluate(() => (window as any).chatStore.getState().permissionMode)).toBe('plan');
  expect((await calls('runtimeState')).length).toBeGreaterThanOrEqual(2);
});

it('显式重连等待 close 成功再 start，携带全局配置快照并保持历史会话', async () => {
  await open();
  await page.getByPlaceholder('填写模型 ID，如 glm-5.3-m17').fill('model-test');
  await page.getByRole('button',{name:'高',exact:true}).click();
  await page.getByRole('button',{name:'1M',exact:true}).click();
  await page.getByPlaceholder('0 = 不限制').fill('12.5');
  await page.getByRole('button',{name:/只读规划/}).click();
  await page.getByRole('button',{name:'重新连接当前对话',exact:true}).click();
  await expect.poll(() => calls('start')).toHaveLength(1);
  expect((await calls('close'))[0].args).toEqual(['chat-a']);
  expect((await calls('start'))[0].args).toEqual([{conversationId:'chat-a',cwd:'/project',options:{sessionId:'session-a',permissionMode:'plan',model:'model-test',effortLevel:'high',autocompact:'1M',maxBudgetUsd:12.5}}]);
  const sequence = await page.evaluate(() => (window as any).fixture.calls.map((c: any)=>c.method));
  expect(sequence.indexOf('close')).toBeLessThan(sequence.indexOf('start'));
  await expect.poll(() => page.evaluate(() => (window as any).chatStore.getState().conversations[0].runtime.state)).toBe('ready');
});

it('权限失败不伪造局部模式，busy 与 close 拒绝都不启动新进程，bypass 必须 confirm', async () => {
  await open();
  await page.evaluate(() => { (window as any).fixture.modeRejected = true; });
  await page.getByRole('button',{name:/只读规划/}).click();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'权限模式更新失败'}).waitFor();
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations[0].permissionMode)).toBe('default');
  expect(await page.evaluate(() => (window as any).fixture.closed)).toBe(0);
  await page.evaluate(() => { (window as any).fixture.runtime.busy = true; });
  await page.getByRole('button',{name:'重新连接当前对话',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'不能重新连接'}).waitFor();
  expect(await calls('close')).toHaveLength(0);
  await page.evaluate(() => { const f = (window as any).fixture; f.runtime.busy = false; f.closeRejected = true; });
  await page.getByRole('button',{name:'重新连接当前对话',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'主进程拒绝关闭'}).waitFor();
  expect(await calls('start')).toHaveLength(0);
  await page.evaluate(() => { (window as any).fixture.consent = false; });
  await page.getByRole('button',{name:/全部放行（危险）/}).click();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).chatStore.getState().permissionMode)).toBe('plan');
  expect(await page.evaluate(() => (window as any).fixture.confirms.some((m: string)=>m.includes('bypassPermissions')))).toBe(true);
});

it('无安全存储禁用持久化但允许内存更新；移除必须包含明确键确认，Shell 导入必须双重同意', async () => {
  await context.addInitScript(() => { (window as any).fixture.summary.encryptionAvailable = false; });
  await open();
  const persist = page.getByLabel('使用系统安全存储持久化环境配置（默认关闭）');
  await expect.poll(() => persist.isDisabled()).toBe(true);
  expect(await persist.isChecked()).toBe(false);
  await page.getByLabel('环境变量键', {exact:true}).selectOption('HTTPS_PROXY');
  await page.evaluate(() => { (window as any).fixture.consent = false; });
  await page.getByRole('button',{name:'移除此环境变量',exact:true}).click();
  expect(await calls('set')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).fixture.confirms.at(-1))).toContain('HTTPS_PROXY');
  await page.evaluate(() => { (window as any).fixture.consent = true; });
  await page.getByRole('button',{name:'移除此环境变量',exact:true}).click();
  await expect.poll(() => calls('set')).toHaveLength(1);
  expect((await calls('set'))[0].args).toEqual([{environmentUpdates:[{key:'HTTPS_PROXY',remove:true}]},{persist:false}]);
  const importButton = page.getByRole('button',{name:'导入登录 Shell 环境',exact:true});
  expect(await importButton.isDisabled()).toBe(true);
  await page.getByLabel('将运行shell启动配置并仅导入允许的环境变量').check();
  await page.evaluate(() => { (window as any).fixture.consent = false; });
  await importButton.click();
  expect(await calls('set')).toHaveLength(1);
  await page.evaluate(() => { (window as any).fixture.consent = true; });
  await importButton.click();
  await expect.poll(() => calls('set')).toHaveLength(2);
  expect((await calls('set'))[1].args).toEqual([{importLoginEnvironment:true},{persist:false}]);
  await expect.poll(() => page.getByLabel('将运行shell启动配置并仅导入允许的环境变量').isChecked()).toBe(false);
});

it('绝对 CLI 路径及 null 重置，安全存储明确勾选才 persist true；诊断只展示版本、脱敏端点和代理存在', async () => {
  await open();
  await page.getByLabel('CLI 可执行文件绝对路径').fill('claude --flag');
  await page.getByRole('button',{name:'保存 CLI 路径',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'必须是绝对路径'}).waitFor();
  expect(await calls('set')).toHaveLength(0);
  await page.getByLabel('CLI 可执行文件绝对路径').fill('/opt/claude');
  await page.getByRole('button',{name:'保存 CLI 路径',exact:true}).click();
  await expect.poll(() => calls('set')).toHaveLength(1);
  expect((await calls('set'))[0].args).toEqual([{executable:'/opt/claude'},{persist:false}]);
  await page.getByRole('button',{name:'重置为自动查找 CLI',exact:true}).click();
  await expect.poll(() => calls('set')).toHaveLength(2);
  expect((await calls('set'))[1].args[0]).toEqual({executable:null});
  await page.getByLabel('使用系统安全存储持久化环境配置（默认关闭）').check();
  await page.getByRole('button',{name:'覆盖此环境变量',exact:true}).click();
  await expect.poll(() => calls('set')).toHaveLength(3);
  expect((await calls('set'))[2].args[1]).toEqual({persist:true});
  await page.evaluate(() => { const s = (window as any).fixture.summary; s.endpoint = 'https://user:private-password@gateway.invalid/api?token=private-query#secret'; s.environment = {ANTHROPIC_AUTH_TOKEN:'private-value'}; });
  await page.getByRole('button',{name:'刷新运行时诊断',exact:true}).click();
  await page.getByText('CLI 版本：2.1.99',{exact:true}).waitFor();
  const text = await page.locator('body').innerText();
  expect(text).toContain('脱敏端点：https://gateway.invalid/api');
  expect(text).toContain('代理配置存在：是');
  for (const secret of ['private-password','private-query','private-value']) expect(text).not.toContain(secret);
  await page.evaluate(() => { (window as any).fixture.fail = 'diagnostics'; });
  await page.getByRole('button',{name:'刷新运行时诊断',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'运行时操作失败'}).waitFor();
  expect(await page.getByText('CLI 版本：2.1.99',{exact:true}).count()).toBe(0);
});

it('解密与权限失败不清配置；清错误只作用 UI，明确重试后恢复，缺失 API 禁用而不 crash', async () => {
  await context.addInitScript(() => { (window as any).api.runtime.get = async () => { throw new Error('Runtime configuration could not be read or decrypted; token=secret'); }; });
  await open();
  await page.getByRole('alert').filter({hasText:'读取或解密失败'}).waitFor();
  expect(await page.getByRole('button',{name:'覆盖此环境变量',exact:true}).isDisabled()).toBe(true);
  expect(await calls('set')).toHaveLength(0);
  await page.getByRole('button',{name:'清除错误提示',exact:true}).click();
  expect(await calls('set')).toHaveLength(0);
  await page.evaluate(() => { const w = window as any; w.api.runtime.get = async () => structuredClone(w.fixture.summary); });
  await page.getByRole('button',{name:'重新读取配置',exact:true}).click();
  await expect.poll(() => page.getByRole('button',{name:'覆盖此环境变量',exact:true}).isDisabled()).toBe(false);
  await page.evaluate(() => { (window as any).api.runtime.set = async () => { throw new Error('EACCES token=secret'); }; });
  await page.getByLabel('环境变量值').fill('input-secret');
  await page.getByRole('button',{name:'覆盖此环境变量',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'权限不足'}).waitFor();
  expect(await page.getByLabel('环境变量值').inputValue()).toBe('input-secret');
  expect(await page.locator('body').innerText()).not.toContain('token=secret');
  expect(await page.getByText('已配置环境键：ANTHROPIC_AUTH_TOKEN, HTTPS_PROXY',{exact:true}).count()).toBe(1);
  await page.evaluate(() => { delete (window as any).api.runtime; delete (window as any).api.claude.runtimeState; });
  await page.getByRole('button',{name:'重新读取配置',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'运行时 API 不可用'}).waitFor();
  expect(await page.getByRole('button',{name:'覆盖此环境变量',exact:true}).isDisabled()).toBe(true);
  await page.getByRole('button',{name:'重新连接当前对话',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'重新连接 API 不可用'}).waitFor();
  expect(await calls('close')).toHaveLength(0);
});

it('原生功能只打开下个表单，interactive 仅受支持选项；其他 mode 不带选项且 busy 不移交', async () => {
  await open();
  await page.getByLabel('Chrome（原生交互终端）').check();
  await page.getByLabel('IDE（原生交互终端）').check();
  await page.getByLabel('Worktree 名称（原生交互终端，可选）').fill('feature');
  await page.getByRole('button',{name:'原生功能管理',exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).terminalStore.getState().formSpec)).toEqual({mode:'interactive',cwd:'/project',options:{chrome:true,ide:true,worktree:'feature'}});
  for (const mode of ['mcp','plugins','agents','auth','doctor']) {
    await page.getByLabel('原生功能',{exact:true}).selectOption(mode);
    await page.getByRole('button',{name:'原生功能管理',exact:true}).click();
    await expect.poll(() => page.evaluate(() => (window as any).terminalStore.getState().formSpec)).toEqual({mode,cwd:'/project'});
  }
  expect(await calls('close')).toHaveLength(0);
  expect(await calls('start')).toHaveLength(0);
  await page.evaluate(() => { const w = window as any; w.chatStore.setState({conversations:w.chatStore.getState().conversations.map((c: any)=>({...c,runtime:{...c.runtime,busy:true}}))}); });
  await page.getByRole('button',{name:'原生功能管理',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'不能移交原生功能'}).waitFor();
});

it('close 未完成不能 start，启动失败不伪造连接且可以显式重试已关闭对话', async () => {
  await open();
  await page.evaluate(() => { const f = (window as any).fixture; f.closePending = true; f.fail = 'start'; });
  await page.getByRole('button',{name:'重新连接当前对话',exact:true}).click();
  await page.waitForFunction(() => !!(window as any).fixture.resolveClose);
  expect(await calls('start')).toHaveLength(0);
  expect(await page.getByRole('button',{name:'重新连接当前对话',exact:true}).isDisabled()).toBe(true);
  await page.evaluate(() => { const f = (window as any).fixture; f.closePending = false; f.resolveClose(); });
  await page.getByRole('alert').filter({hasText:'重新连接失败'}).waitFor();
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations[0].protocolConnected)).toBe(false);
  await page.evaluate(() => { (window as any).fixture.fail = ''; });
  await page.getByRole('button',{name:'重新连接当前对话',exact:true}).click();
  await expect.poll(() => calls('start')).toHaveLength(2);
  await expect.poll(() => page.evaluate(() => (window as any).chatStore.getState().conversations[0].runtime.state)).toBe('ready');
});

async function calls(method: string) {
  return page.evaluate(method => (window as any).fixture.calls.filter((c: any) => c.method === method), method);
}

it('环境值只接受 password 覆盖输入；空值显式覆盖，set 的 persist 为第二参数且不写 localStorage', async () => {
  await open();
  await page.getByText('已配置环境键：ANTHROPIC_AUTH_TOKEN, HTTPS_PROXY', {exact:true}).waitFor();
  expect(await page.getByLabel('环境变量值').getAttribute('type')).toBe('password');
  expect(await page.getByLabel('环境变量值').inputValue()).toBe('');
  await page.getByLabel('环境变量键', {exact:true}).selectOption('ANTHROPIC_AUTH_TOKEN');
  await page.getByLabel('环境变量值').fill('secret-test-token');
  await page.getByRole('button', {name:'覆盖此环境变量',exact:true}).click();
  await expect.poll(() => calls('set')).toHaveLength(1);
  expect((await calls('set'))[0].args).toEqual([{environmentUpdates:[{key:'ANTHROPIC_AUTH_TOKEN',value:'secret-test-token'}]},{persist:false}]);
  await expect.poll(() => page.getByLabel('环境变量值').inputValue()).toBe('');
  await page.getByRole('button', {name:'覆盖此环境变量',exact:true}).click();
  await expect.poll(() => calls('set')).toHaveLength(2);
  expect((await calls('set'))[1].args[0]).toEqual({environmentUpdates:[{key:'ANTHROPIC_AUTH_TOKEN',value:''}]});
  expect(await page.locator('body').innerText()).not.toContain('secret-test-token');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('secret-test-token');
  expect((await calls('set')).every((c: any) => !('importLoginEnvironment' in c.args[0]))).toBe(true);
});
