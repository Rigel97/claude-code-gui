import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import fs from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server: ViteDevServer;
let httpServer: Server;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let url: string;
const errors: string[] = [];
beforeAll(async () => {
  server = await createServer({ configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { middlewareMode: true, hmr: false }, plugins: [{
    name: 'approval-browser-fixture',
    resolveId(id) { if (id === '/approval-fixture.tsx') return '\0approval-fixture.tsx'; },
    load(id) {
      if (id !== '\0approval-fixture.tsx') return;
      return `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {NamedApprovalPanel as ApprovalPanel} from '${root}/src/renderer/components/ApprovalPanel.tsx';
        import {useStore} from '${root}/src/renderer/store.ts';
        window.chatStore = useStore;
        const a = {id:'a',runId:'run-a',runtime:{runId:'run-a'},pendingApprovals:[],messages:[],queue:[],cwd:'/a',status:'streaming'};
        useStore.setState({conversations:[a,{...a,id:'b',runId:'run-b',runtime:{runId:'run-b'}}],activeConversationId:'a'});
        window.request = (p, id='a') => useStore.getState().handleStream({type:'approval_request',status:'waiting',conversationId:id,runId:id==='a'?'run-a':'run-b',...p});
        function Fixture() { const conv = useStore(s=>s.conversations.find(c=>c.id===s.activeConversationId)); return conv ? React.createElement(ApprovalPanel,{conv}) : null; }
        createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Fixture)));`;
    },
    configureServer(vite) {
      vite.middlewares.use('/__approval_test', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(await vite.transformIndexHtml('/__approval_test', '<html><body><button id="outside">聊天输入区</button><div id="root"></div><script type="module" src="/approval-fixture.tsx"></script></body></html>'));
      });
    },
  }] });
  httpServer = createHttpServer(server.middlewares);
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  url = `http://127.0.0.1:${address.port}/__approval_test`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
}, 60000);
beforeEach(async () => {
  errors.length = 0;
  context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await context.addInitScript(() => {
    const w = window as any;
    w.fixture = { calls: [], opens: [], fail: '', hold: false };
    w.api = { claude: { respond: async (payload: unknown) => {
      w.fixture.calls.push(payload);
      if (w.fixture.hold) return new Promise(resolve => { w.fixture.resolve = resolve; });
      if (w.fixture.fail === 'throw') throw new Error('IPC unavailable');
      if (w.fixture.fail) return { success: false, error: w.fixture.fail };
      return { success: true };
    }, abort: () => { throw new Error('Must not abort conversation'); } }, openExternal: async (value: string) => { w.fixture.opens.push(value); return { success: true }; } };
    w.open = () => { throw new Error('Must not open a renderer window'); };
  });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  // First navigation also waits for Vite's cold dependency transform.
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => !!(window as any).request);
});
afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') console.error(errors, await page.locator('body').innerText().catch(() => 'Unavailable'));
  await context?.close();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (httpServer?.listening) await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
}, 60000);

it('工具参数真实预览，批准一次携带所属会话与 run，成功无事件也移除卡片', async () => {
  await page.evaluate(() => (window as any).request({requestId:'t',kind:'tool',toolName:'Bash',input:{command:'pwd'},alwaysAllowAvailable:false}));
  await page.getByRole('region', {name:'Claude审批与追问'}).waitFor();
  expect(await page.getByLabel('工具参数预览').innerText()).toContain('"command": "pwd"');
  expect(await page.getByRole('button', {name:'当前会话始终允许'}).isDisabled()).toBe(true);
  await page.getByRole('button', {name:'批准一次',exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls)).toEqual([{conversationId:'a',requestId:'t',runId:'run-a',decision:{behavior:'allow'}}]);
  await page.getByRole('region', {name:'Claude审批与追问'}).waitFor({state:'detached'});
  expect(errors).toEqual([]);
});

it('计划只展示真实正文或缺失提示，批准模式限制为 default/acceptEdits，拒绝带可选反馈', async () => {
  await page.evaluate(() => (window as any).request({requestId:'p',kind:'plan',toolName:'ExitPlanMode',input:{plan:'真实计划：先修改，再验证'}}));
  expect(await page.getByLabel('计划正文').innerText()).toBe('真实计划：先修改，再验证');
  expect(await page.getByLabel('批准后权限模式').inputValue()).toBe('default');
  expect(await page.getByLabel('批准后权限模式').locator('option').evaluateAll(nodes => nodes.map(n => (n as HTMLOptionElement).value))).toEqual(['default','acceptEdits']);
  await page.getByLabel('批准后权限模式').selectOption('acceptEdits');
  await page.getByRole('button', {name:'批准计划'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({behavior:'allow',mode:'acceptEdits'});
  await page.evaluate(() => (window as any).request({requestId:'missing',kind:'plan',toolName:'ExitPlanMode',input:{planFilePath:'/not-a-plan-body'}}));
  await page.getByText('未提供正文，先在聊天检查计划',{exact:true}).waitFor();
  expect(await page.getByLabel('工具参数预览').innerText()).toContain('/not-a-plan-body');
  await page.getByLabel('拒绝反馈（可选）').fill('请补充回滚步骤');
  await page.getByRole('button', {name:'拒绝计划'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({behavior:'deny',message:'请补充回滚步骤'});
  expect(errors).toEqual([]);
});

it('追问每题必填，多选和自由答案按问题字符串精确提交，单选使用 radio', async () => {
  await page.evaluate(() => (window as any).request({requestId:'q',kind:'question',toolName:'AskUserQuestion',input:{questions:[
    {header:'范围',question:'选择范围？',multiSelect:true,options:[{label:'UI',description:'界面'},{label:'API',description:'接口'}]},
    {header:'语言',question:'选择语言？',multiSelect:false,options:[{label:'TS',description:'类型安全'},{label:'JS',description:'脚本'}]},
  ]}}));
  await page.getByRole('button', {name:'提交回答'}).click();
  await page.getByRole('alert').filter({hasText:'每个问题'}).waitFor();
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
  await page.getByRole('checkbox', {name:/UI/}).check();
  await page.getByRole('checkbox', {name:/API/}).check();
  await page.getByLabel('其他答案：选择范围？').fill('测试');
  await page.getByRole('radio', {name:/TS/}).check();
  await page.getByRole('radio', {name:/JS/}).check();
  await page.getByRole('button', {name:'提交回答'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls)).toEqual([{conversationId:'a',requestId:'q',runId:'run-a',decision:{behavior:'allow',answers:{'选择范围？':'UI, API, 测试','选择语言？':'JS'}}}]);
  expect(errors).toEqual([]);
});

it('畸形问题不能批准但可以取消，缺少 run 不发送；外链失败不批准且可重试', async () => {
  await page.evaluate(() => (window as any).request({requestId:'invalid',kind:'question',input:{questions:[{question:'重复'},{question:'重复'}]}}));
  expect(await page.getByRole('button',{name:'提交回答'}).isDisabled()).toBe(true);
  await page.getByRole('button',{name:'取消追问'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({behavior:'deny'});
  await page.evaluate(() => {
    const w=window as any;
    w.chatStore.setState({conversations:w.chatStore.getState().conversations.map((c:any)=>c.id==='a'?{...c,runId:undefined,runtime:{},pendingApprovals:[{requestId:'no-run',kind:'tool',status:'waiting'}]}:c)});
  });
  await page.getByRole('button',{name:'批准一次'}).click();
  await page.getByRole('alert').filter({hasText:'缺少运行标识'}).waitFor();
  expect(await page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await page.evaluate(() => {
    const w=window as any;
    w.chatStore.getState().setRuntime('a',{runId:'url-run',pendingApprovals:[{requestId:'url-fail',kind:'elicitation',status:'waiting',mode:'url',url:'https://example.com/auth'}]});
    w.openSaved=w.api.openExternal; w.api.openExternal=async()=>({success:false,error:'外链拒绝'});
  });
  await page.getByRole('button',{name:'打开验证链接'}).click();
  await page.getByRole('alert').filter({hasText:'外链拒绝'}).waitFor();
  expect(await page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await page.evaluate(() => { const w=window as any; w.api.openExternal=w.openSaved; });
  await page.getByRole('button',{name:'打开验证链接'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.opens)).toEqual(['https://example.com/auth']);
  await page.getByRole('button',{name:'取消请求'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({action:'cancel'});
});

it('elicitation primitive form 保留 primitive 类型，必填校验不发送，失败等待重试', async () => {
  await page.evaluate(() => (window as any).request({requestId:'e',kind:'elicitation',serverName:'MCP',message:'请输入配置',mode:'form',requestedSchema:{type:'object',required:['name','count','enabled'],properties:{name:{type:'string'},count:{type:'integer'},enabled:{type:'boolean'},tier:{type:'string',enum:['basic','pro']}}}}));
  await page.getByRole('button',{name:'接受并提交'}).click();
  await page.getByRole('alert').waitFor();
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
  await page.getByLabel('name', {exact:true}).fill('Alice');
  await page.getByLabel('count', {exact:true}).fill('3');
  await page.getByLabel('enabled', {exact:true}).selectOption('false');
  await page.getByLabel('tier', {exact:true}).selectOption('1');
  await page.evaluate(() => { (window as any).fixture.fail='schema validation failed'; });
  await page.getByRole('button',{name:'接受并提交'}).click();
  await page.getByRole('alert').filter({hasText:'schema validation failed'}).waitFor();
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations[0].pendingApprovals[0].status)).toBe('waiting');
  await page.evaluate(() => { (window as any).fixture.fail=''; });
  await page.getByRole('button',{name:'接受并提交'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1))).toEqual({conversationId:'a',requestId:'e',runId:'run-a',decision:{action:'accept',content:{name:'Alice',count:3,enabled:false,tier:'pro'}}});
  await page.getByRole('region').waitFor({state:'detached'});
});

it('nested schema 使用 JSON，拒绝与取消不携带 content，未知模式仍可取消', async () => {
  await page.evaluate(() => (window as any).request({requestId:'nested',kind:'elicitation',requestedSchema:{type:'object',properties:{config:{type:'object'},items:{type:'array'}}}}));
  await page.getByLabel('响应内容 JSON').fill('[]');
  await page.getByRole('button',{name:'接受并提交'}).click();
  await page.getByRole('alert').filter({hasText:'JSON 对象'}).waitFor();
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
  await page.getByLabel('响应内容 JSON').fill('{"config":{"port":8080},"items":[1,true]}');
  await page.getByRole('button',{name:'接受并提交'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({action:'accept',content:{config:{port:8080},items:[1,true]}});
  await page.evaluate(() => (window as any).request({requestId:'decline',kind:'elicitation'}));
  await page.getByRole('button',{name:'拒绝提供'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({action:'decline'});
  await page.evaluate(() => (window as any).request({requestId:'unknown',kind:'elicitation',mode:'future'}));
  await page.getByRole('alert').filter({hasText:'不支持'}).waitFor();
  expect(await page.getByRole('button',{name:'接受并提交'}).isDisabled()).toBe(true);
  await page.getByRole('button',{name:'取消请求'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({action:'cancel'});
});

it('URL 显式交给桥接打开，不自动批准，接受按当前 backend 带空对象；危险 URL 可取消', async () => {
  await page.evaluate(() => (window as any).request({requestId:'url',kind:'elicitation',mode:'url',url:'https://example.com/auth',elicitationId:'auth-id'}));
  expect(await page.evaluate(() => (window as any).fixture.opens)).toEqual([]);
  await page.getByRole('button',{name:'打开验证链接'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.opens)).toEqual(['https://example.com/auth']);
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
  await page.getByRole('button',{name:'接受并提交'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({action:'accept',content:{}});
  await page.evaluate(() => (window as any).request({requestId:'bad-url',kind:'elicitation',mode:'url',url:'javascript:alert(1)'}));
  expect(await page.getByRole('button',{name:'打开验证链接'}).isDisabled()).toBe(true);
  expect(await page.getByRole('button',{name:'接受并提交'}).isDisabled()).toBe(true);
  await page.getByRole('button',{name:'取消请求'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({action:'cancel'});
});

it('refusal fallback 展示 SDK payload 并发送精确外层对象，未知 dialog 安全取消', async () => {
  for (const [button,result] of [['切换模型重试','retry_fallback'],['编辑提示后重试','edit_prompt']]) {
    await page.evaluate(() => (window as any).request({requestId:'dialog',kind:'dialog',dialogKind:'refusal_fallback_prompt',input:{originalModel:'model-a',fallbackModel:'model-b',guidanceText:'真实指导',apiRefusalCategory:'coding'}}));
    await page.getByText('真实指导',{exact:true}).waitFor();
    await page.getByRole('button',{name:button}).click();
    await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({behavior:'completed',result});
    await page.getByRole('region').waitFor({state:'detached'});
  }
  await page.evaluate(() => (window as any).request({requestId:'unsupported',kind:'dialog',dialogKind:'future'}));
  await page.getByRole('alert').filter({hasText:'不支持'}).waitFor();
  await page.getByRole('button',{name:'取消对话请求'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({behavior:'cancelled'});
});

it('工具编辑无效 JSON 不发 IPC，编辑后禁用始终允许，deny 与 alwaysAllow 精确提交', async () => {
  await page.evaluate(() => (window as any).request({requestId:'edit',kind:'tool',toolName:'Bash',input:{command:'pwd'},alwaysAllowAvailable:true}));
  await page.getByRole('checkbox',{name:'编辑工具参数 JSON（可选）'}).check();
  expect(await page.getByRole('button',{name:'当前会话始终允许'}).isDisabled()).toBe(true);
  for (const invalid of ['{','[]','null','{"__proto__":{}}','{"n":1e999}']) {
    await page.getByLabel('编辑后的参数 JSON').fill(invalid);
    await page.getByRole('button',{name:'批准一次'}).click();
    await page.getByRole('alert').waitFor();
    expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
  }
  await page.getByLabel('编辑后的参数 JSON').fill('{"command":"ls","nested":{"safe":true}}');
  await page.getByRole('button',{name:'批准一次'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({behavior:'allow',editedInput:{command:'ls',nested:{safe:true}}});
  await page.evaluate(() => (window as any).request({requestId:'always',kind:'tool',alwaysAllowAvailable:true}));
  await page.getByRole('button',{name:'当前会话始终允许'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({behavior:'allow',alwaysAllow:true});
  await page.evaluate(() => (window as any).request({requestId:'deny',kind:'tool'}));
  await page.getByLabel('拒绝反馈（可选）').fill('  不要执行  ');
  await page.getByRole('button',{name:'拒绝',exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({behavior:'deny',message:'不要执行'});
});

it('双击和切 tab 再点击同一 pending 请求只发送一次，回执只清所属请求', async () => {
  await page.evaluate(() => {
    const w=window as any; w.fixture.hold=true;
    w.request({requestId:'shared',kind:'tool',toolName:'A'});
    w.request({requestId:'other',kind:'tool',toolName:'Other'});
    w.request({requestId:'shared',kind:'tool',toolName:'B'},'b');
  });
  await page.getByRole('article',{name:'A shared'}).getByRole('button',{name:'批准一次'}).evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
  await page.evaluate(() => (window as any).chatStore.setState({activeConversationId:'b'}));
  await page.getByRole('article',{name:'B shared'}).waitFor();
  await page.evaluate(() => (window as any).chatStore.setState({activeConversationId:'a'}));
  await page.getByRole('article',{name:'A shared'}).getByRole('button',{name:'批准一次'}).click();
  await page.evaluate(() => (window as any).request({requestId:'shared',kind:'tool',toolName:'A'}));
  await page.getByRole('article',{name:'A shared'}).getByRole('button',{name:'批准一次'}).evaluate(node => (node as HTMLButtonElement).click());
  expect(await page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await page.evaluate(() => (window as any).fixture.resolve({success:true}));
  await page.getByRole('article',{name:'A shared'}).waitFor({state:'detached'});
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations.map((c:any)=>c.pendingApprovals.map((p:any)=>p.requestId)))).toEqual([['other'],['shared']]);
});

it('旧回执不能清除同 ID 新请求或新 run，stream resolved 先到也不清其他请求', async () => {
  await page.evaluate(() => { const w=window as any; w.fixture.hold=true; w.request({requestId:'race',kind:'tool',toolName:'Old'}); });
  await page.getByRole('button',{name:'批准一次'}).click();
  await page.evaluate(() => {
    const w=window as any;
    w.chatStore.getState().handleStream({type:'approval_resolved',conversationId:'a',runId:'run-a',requestId:'race'});
    w.request({requestId:'race',kind:'tool',toolName:'New'});
    w.fixture.resolve({success:true});
  });
  await page.getByRole('article',{name:'New race'}).waitFor();
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations[0].pendingApprovals.map((p:any)=>p.toolName))).toEqual(['New']);
  await page.evaluate(() => {
    const w=window as any; w.fixture.hold=false;
    w.chatStore.getState().handleStream({type:'approval_resolved',conversationId:'a',runId:'run-a',requestId:'race'});
    w.chatStore.getState().setRuntime('a',{runId:'new-run',pendingApprovals:[{requestId:'race',runId:'new-run',kind:'tool',toolName:'NewRun',status:'waiting'}]});
    w.chatStore.getState().handleStream({type:'approval_resolved',conversationId:'a',runId:'run-a',requestId:'race'});
  });
  await page.getByRole('article',{name:'NewRun race'}).waitFor();
  await page.getByRole('button',{name:'批准一次'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).runId)).toBe('new-run');
});

it('安全键盘无全局快捷批准或焦点抢夺，单选 custom 使用完整问题 key', async () => {
  await page.locator('#outside').focus();
  await page.evaluate(() => (window as any).request({requestId:'keyboard',kind:'question',input:{questions:[{question:'完整问题？\n不要缩成 header',header:'短标题',multiSelect:false,options:[{label:'A'},{label:'B'}]}]}}));
  expect(await page.locator('#outside').evaluate(node=>node===document.activeElement)).toBe(true);
  await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
  await page.getByRole('radio',{name:'A',exact:true}).check();
  await page.getByLabel('其他答案：完整问题？ 不要缩成 header').fill('我的自定义回答');
  expect(await page.getByRole('radio',{name:'A',exact:true}).isChecked()).toBe(false);
  await page.getByRole('button',{name:'提交回答'}).focus();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.at(-1).decision)).toEqual({behavior:'allow',answers:{'完整问题？\n不要缩成 header':'我的自定义回答'}});
});

it('IPC 缺失或抛错保留等待和输入，可重试，错误不触发 abort', async () => {
  await page.evaluate(() => { const w=window as any; w.request({requestId:'retry',kind:'tool'}); w.saved=w.api.claude.respond; delete w.api.claude.respond; });
  await page.getByRole('button',{name:'批准一次'}).click();
  await page.getByRole('alert').filter({hasText:'IPC'}).waitFor();
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
  await page.evaluate(() => { const w=window as any; w.api.claude.respond=w.saved; w.fixture.fail='throw'; });
  await page.getByRole('button',{name:'批准一次'}).click();
  await page.getByRole('alert').filter({hasText:'IPC unavailable'}).waitFor();
  await page.evaluate(() => { (window as any).fixture.fail=''; });
  await page.getByRole('button',{name:'批准一次'}).click();
  await page.getByRole('region').waitFor({state:'detached'});
  expect(errors).toEqual([]);
});
