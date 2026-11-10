import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{
      name: 'session-actions-fixture',
      resolveId(id) { if (id === '/session-fixture.tsx') return '\0session-fixture.tsx'; },
      load(id) {
        if (id !== '\0session-fixture.tsx') return;
        return `import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {SessionActions} from '${root}/src/renderer/components/SessionActions.tsx';
          import {Sidebar} from '${root}/src/renderer/components/Sidebar.tsx';
          import {ChatMessageView} from '${root}/src/renderer/components/ChatMessageView.tsx';
          import {useStore} from '${root}/src/renderer/store.ts';
          import {useTerminalStore} from '${root}/src/renderer/terminalStore.ts';
          window.chatStore = useStore; window.terminalStore = useTerminalStore;
          useStore.getState().hydrate({cwd:'/project'});
          const id = useStore.getState().activeConversationId;
          const messages = [
            {id:'gui-user',cliUuid:'user-anchor',role:'user',status:'completed',timestamp:1,blocks:[{kind:'text',text:'original prompt'}]},
            {id:'gui-answer',cliUuid:'assistant-start',endUuid:'assistant-end',role:'assistant',status:'error',timestamp:2,blocks:[{kind:'thinking',text:'private thinking'},{kind:'stderr',text:'failed turn'}]}
          ];
          useStore.setState(s=>({conversations:s.conversations.map(c=>({...c,sessionId:'original-sid',title:'Original',messages})),sessions:[{sessionId:'original-sid',cwd:'/project',title:'Original',messages,createdAt:1,cost:0,inputTokens:0,outputTokens:0}]}));
          window.originalId = id;
          function Fixture() {
            const conv = useStore(s=>s.conversations.find(c=>c.id===s.activeConversationId));
            return React.createElement(React.Fragment,null,React.createElement(Sidebar),React.createElement('main',null,conv && React.createElement(React.Fragment,null,
              React.createElement('h1',null,conv.title),React.createElement(SessionActions,{conv}),
              ...conv.messages.map(m=>React.createElement(ChatMessageView,{key:m.id,message:m})),
              React.createElement('textarea',{'aria-label':'Draft',value:conv.draft,onChange:e=>useStore.getState().setDraft(e.target.value,conv.id)}))));
          }
          createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Fixture)));`;
      },
      configureServer(vite) {
        vite.middlewares.use('/__sessions_test', async (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(await vite.transformIndexHtml('/__sessions_test', '<html><body><div id="root"></div><script type="module" src="/session-fixture.tsx"></script></body></html>'));
        });
      },
    }],
  });
  await new Promise<void>(resolve => server.httpServer!.listen(0, '127.0.0.1', resolve));
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  url = `http://127.0.0.1:${address.port}/__sessions_test`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
}, 60000);

beforeEach(async () => {
  errors.length = 0;
  context = await browser.newContext();
  await context.addInitScript(() => {
    const w = window as any;
    w.fixture = { calls: [], fail: '', pending: '', responses: {}, resolvers: {} };
    const call = async (method: string, payload: unknown, fallback: unknown) => {
      const f = w.fixture;
      f.calls.push({ method, payload });
      if (f.fail === method) throw new Error(`${method}: backend refused custom root`);
      if (f.pending === method) return new Promise(resolve => { f.resolvers[method] = resolve; });
      return Object.hasOwn(f.responses, method) ? f.responses[method] : fallback;
    };
    w.api = {
      exportJson: (name: string, content: string) => call('exportJson', { name, content }, { success: true }),
      terminal: { health: async () => ({ available: true }), list: async () => [] },
      claude: {
        runtimeState: (id: string) => call('runtimeState', id, { state: 'ready', busy: false }),
        close: (id: string) => call('close', id, { success: true }),
        historyList: (p: any) => call('historyList', p, [{ sessionId: 'history-sid', cwd: '/project', customTitle: 'CLI archive', summary: 'summary', lastModified: 1 }]),
        historyRead: (p: any) => call('historyRead', p, { sessionId: p.sessionId, cwd: p.cwd, nextOffset: null, messages: [{ type: 'user', uuid: 'history-user', message: { content: 'history prompt' } }] }),
        fork: (p: any) => call('fork', p, { success: true, sessionId: 'fork-sid', cwd: p.cwd, title: 'Forked', messages: [{ type: 'assistant', uuid: 'fresh-anchor', message: { content: [{ type: 'thinking', thinking: 'fork thinking' }, { type: 'text', text: 'fork response' }] } }] }),
        editFork: (p: any) => call('editFork', p, { success: true, sessionId: 'edit-sid', cwd: p.cwd, title: 'Edited', messages: [], draft: 'original prompt' }),
        rewind: (p: any) => call('rewind', p, p.dryRun ? { success: true, canRewind: true, filesChanged: ['src/example.ts'], insertions: 3, deletions: 2, confirmationToken: 'authorized-token' } : { success: true, skippedLinks: ['unsafe-link'] }),
        exportTranscript: (p: any) => call('exportTranscript', p, { success: true, path: '/saved/full.jsonl' }),
        send: (p: any) => call('send', p, { success: false, error: 'test rejection' }),
      },
    };
  });
  page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
});
afterEach(async () => { await context?.close(); expect(errors).toEqual([]); });
afterAll(async () => { await browser?.close(); await server?.close(); }, 60000);

async function open() {
  await page.goto(url);
  await page.getByRole('heading', { name: 'Original', exact: true }).waitFor();
}
async function openRewind() {
  const menu = page.getByLabel('危险操作', { exact: true });
  if (await menu.locator('..').getAttribute('open') === null) await menu.click();
}
it('StrictMode 下 CLI 历史仅显式打开，全分页读取后导入，不自动分叉或发送', async () => {
  await open();
  expect(await calls('historyList')).toEqual([]);
  await page.evaluate(() => {
    const w = window as any;
    w.api.claude.historyRead = async (p: any) => {
      w.fixture.calls.push({method:'historyRead',payload:p});
      return {sessionId:p.sessionId,cwd:p.cwd,nextOffset:p.offset === 0 ? 200 : null,messages:p.offset === 0
        ? [{type:'user',uuid:'first',message:{content:'first page'}}]
        : [{type:'assistant',uuid:'last',message:{content:[{type:'thinking',thinking:'last thinking'},{type:'text',text:'last page'}]}}]};
    };
  });
  await page.getByRole('button', { name: 'CLI 历史', exact: true }).click();
  await page.getByRole('button', { name: '导入 CLI archive', exact: true }).click();
  await page.getByRole('heading', { name: 'CLI archive', exact: true }).waitFor();
  expect((await calls('historyRead')).map(c => c.payload.offset)).toEqual([0, 200]);
  const conv = await page.evaluate(() => (window as any).chatStore.getState().conversations.at(-1));
  expect(conv.messages).toHaveLength(2);
  expect(conv.messages[1].blocks[0]).toEqual({kind:'thinking',text:'last thinking'});
  expect(await calls('fork')).toEqual([]);
  expect(await calls('send')).toEqual([]);
});

it('编辑分叉只预填新标签草稿；助手分叉使用 endUuid 而非 GUI ID', async () => {
  await open();
  await page.getByRole('button', {name:'编辑并分叉',exact:true}).click();
  await page.getByRole('heading', {name:'Edited',exact:true}).waitFor();
  expect(await page.getByLabel('Draft').inputValue()).toBe('original prompt');
  await page.getByLabel('Draft').fill('edited later');
  expect((await calls('editFork'))[0].payload.messageId).toBe('user-anchor');
  expect(await calls('send')).toEqual([]);
  await page.evaluate(() => { const w = window as any; w.chatStore.getState().setActiveConversation(w.originalId); });
  await page.getByRole('button', {name:'从此处分叉',exact:true}).click();
  await page.getByRole('heading', {name:'Forked',exact:true}).waitFor();
  expect((await calls('fork'))[0].payload.upToMessageId).toBe('assistant-end');
});

it('文件回退先预览再原生确认，提交授权 token，跳过链接不宣称全部恢复', async () => {
  await open();
  let prompt = '';
  page.once('dialog', async dialog => { prompt = dialog.message(); await dialog.accept(); });
  await openRewind();
  await page.getByRole('button', {name:'回退文件',exact:true}).click();
  await page.getByRole('status').filter({hasText:'跳过'}).waitFor();
  expect(prompt).toContain('src/example.ts');
  expect(prompt).toContain('外部操作');
  const requests = await calls('rewind');
  expect(requests.map(c=>c.payload.dryRun)).toEqual([true,false]);
  expect(requests[1].payload.confirmationToken).toBe('authorized-token');
  expect(requests[1].payload.messageId).toBe('user-anchor');
  expect(await page.evaluate(()=>(window as any).chatStore.getState().conversations[0].messages.map((m:any)=>m.id))).toEqual(['gui-user','gui-answer']);
});

it('冷会话回退接续本次 dryRun bootstrap 的真实 runId，消息数组重建不丢失确认', async () => {
  await open();
  await page.evaluate(() => {
    const w = window as any;
    const source = w.chatStore.getState().conversations[0];
    w.fixture.sourceMessages = source.messages;
    w.api.claude.runtimeState = async (id: string) => {
      w.fixture.calls.push({ method: 'runtimeState', payload: id });
      return w.fixture.bootRuntime ?? { conversationId: id, sessionId: 'original-sid', runId: null, state: 'closed', busy: false };
    };
    w.api.claude.rewind = async (p: { conversationId: string; dryRun: boolean }) => {
      w.fixture.calls.push({ method: 'rewind', payload: p });
      if (!p.dryRun) return { success: true };
      const runtime = { conversationId: p.conversationId, sessionId: 'original-sid', runId: 'bootstrap-run', state: 'ready', busy: false };
      w.fixture.bootRuntime = runtime;
      w.chatStore.getState().setRuntime(p.conversationId, runtime);
      w.chatStore.setState((s: { conversations: import('../src/renderer/types').Conversation[] }) => ({
        conversations: s.conversations.map(c => c.id === p.conversationId ? { ...c, messages: [...c.messages] } : c),
      }));
      return { success: true, canRewind: true, confirmationToken: 'cold-token', filesChanged: ['cold.ts'], runtimeState: runtime };
    };
  });
  let confirmations = 0;
  page.on('dialog', async dialog => { confirmations++; await dialog.accept(); });
  await openRewind();
  await page.getByRole('button', { name: '回退文件', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '文件回退已执行' }).waitFor();
  expect(confirmations).toBe(1);
  const requests = await calls('rewind');
  expect(requests.map(c => c.payload.dryRun)).toEqual([true, false]);
  expect(requests[1].payload).toMatchObject({ sessionId: 'original-sid', messageId: 'user-anchor', confirmationToken: 'cold-token' });
  expect(await calls('runtimeState')).toHaveLength(2);
  expect(await calls('send')).toEqual([]);
  expect(await page.evaluate(() => {
    const w = window as any;
    const c = w.chatStore.getState().conversations[0];
    return { runId: c.runId, sameRows: c.messages.every((m: unknown, i: number) => m === w.fixture.sourceMessages[i]) };
  })).toEqual({ runId: 'bootstrap-run', sameRows: true });
});

it('终端恢复仅打开显式 resume 表单，完整 JSON 与原生 JSONL 使用各自安全 API', async () => {
  await open();
  await page.getByRole('button', {name:'原生终端恢复',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).terminalStore.getState().formSpec)).toEqual({mode:'interactive',cwd:'/project',sessionId:'original-sid',resume:true});
  expect(await calls('close')).toEqual([]);
  await page.getByRole('button', {name:/^会话操作 /}).first().click();
  await page.getByRole('menuitem', {name:'导出 JSON', exact:true}).click();
  const exported = JSON.parse((await calls('exportJson'))[0].payload.content);
  expect(exported.messages[1].blocks).toEqual([{kind:'thinking',text:'private thinking'},{kind:'stderr',text:'failed turn'}]);
  await page.getByRole('button', {name:'导出原生 JSONL',exact:true}).click();
  await page.getByRole('status').filter({hasText:'/saved/full.jsonl'}).waitFor();
  expect((await calls('exportTranscript'))[0].payload).toEqual({cwd:'/project',sid:'original-sid',defaultName:'Original.jsonl'});
  await page.getByRole('button', {name:'原生终端',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).terminalStore.getState().formSpec)).toBeUndefined();
});

it('正常关闭空闲引擎的 closed 事件不会误取消分叉，新标签不继承运行态', async () => {
  await open();
  await page.evaluate(() => {
    const w = window as any;
    w.chatStore.getState().setRuntime(w.originalId,{state:'ready',busy:false,runId:'old-run',commands:['old-command']});
    w.api.claude.close = async (id:string) => {
      w.fixture.calls.push({method:'close',payload:id});
      w.chatStore.getState().setRuntime(id,{state:'closed',runId:null,busy:false});
      return {success:true};
    };
  });
  await page.getByRole('button', {name:'分叉会话',exact:true}).click();
  await page.getByRole('heading', {name:'Forked',exact:true}).waitFor();
  const fork = await page.evaluate(()=>(window as any).chatStore.getState().conversations.at(-1));
  expect(fork.protocolConnected).toBe(false);
  expect(fork.pendingApprovals).toEqual([]);
  expect(fork.commands).toEqual([]);
  expect(fork.runId).toBeUndefined();
});

it('显式取消分叉后迟到响应不创建标签或改变原会话', async () => {
  await open();
  await page.evaluate(() => { (window as any).fixture.pending = 'fork'; });
  await page.getByRole('button', {name:'分叉会话',exact:true}).click();
  await page.waitForFunction(() => !!(window as any).fixture.resolvers.fork);
  await page.getByRole('button', {name:'取消等待',exact:true}).click();
  await page.evaluate(async () => {
    const w = window as any;
    w.fixture.resolvers.fork({success:true,sessionId:'late-sid',cwd:'/project',title:'Late',messages:[]});
    await new Promise(resolve => setTimeout(resolve,0));
  });
  expect(await page.evaluate(() => (window as any).chatStore.getState().conversations.length)).toBe(1);
  expect(await page.getByRole('heading',{name:'Original',exact:true}).count()).toBe(1);
  expect(await page.getByRole('button',{name:'分叉会话',exact:true}).isEnabled()).toBe(true);
});

it('历史列表加载更多失败保留已加载项，以相同 offset 重试并支持 worktree cwd', async () => {
  await open();
  await page.evaluate(() => {
    const w = window as any;
    w.api.claude.historyList = async (p:any) => {
      w.fixture.calls.push({method:'historyList',payload:p});
      if (p.offset === 50 && !w.fixture.recovered) throw new Error('list page unavailable');
      return p.offset === 0 ? Array.from({length:50},(_,i)=>({sessionId:`list-${i}`,cwd:'/project',summary:`Archive ${i}`}))
        : [{sessionId:'worktree-sid',cwd:'/project-worktree',customTitle:'Worktree history'}];
    };
  });
  await page.getByRole('button',{name:'CLI 历史',exact:true}).click();
  await page.getByRole('button',{name:'加载更多',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'list page unavailable'}).waitFor();
  expect(await page.getByRole('button',{name:'导入 Archive 0',exact:true}).count()).toBe(1);
  await page.evaluate(() => { (window as any).fixture.recovered = true; });
  await page.getByRole('button',{name:'重试加载',exact:true}).click();
  await page.getByRole('button',{name:'导入 Worktree history',exact:true}).click();
  await page.getByRole('heading',{name:'Worktree history',exact:true}).waitFor();
  expect((await calls('historyList')).filter(c=>c.payload.offset === 50)).toHaveLength(2);
  expect((await calls('historyRead'))[0].payload.cwd).toBe('/project-worktree');
});

it('分叉补读期间同 SID 已被其他标签打开，不覆盖其消息与草稿', async () => {
  await open();
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.responses.fork = {success:true,sessionId:'fork-sid',cwd:'/project',title:'Forked'};
    w.fixture.pending = 'historyRead';
  });
  await page.getByRole('button',{name:'分叉会话',exact:true}).click();
  await page.waitForFunction(() => !!(window as any).fixture.resolvers.historyRead);
  await page.evaluate(async () => {
    const w = window as any;
    const id = w.chatStore.getState().importSession({sessionId:'fork-sid',cwd:'/project',title:'Other opened',messages:[{type:'user',uuid:'other-uuid',message:{content:'keep these messages'}}]});
    w.chatStore.getState().setDraft('keep this draft',id);
    // Keep the source active, so the result must also defend against a background target collision.
    w.chatStore.getState().setActiveConversation(w.originalId);
    w.fixture.resolvers.historyRead({sessionId:'fork-sid',cwd:'/project',messages:[],nextOffset:null});
    await new Promise(resolve => setTimeout(resolve,0));
  });
  const state = await page.evaluate(() => ({active:(window as any).chatStore.getState().activeConversationId,original:(window as any).originalId,target:(window as any).chatStore.getState().conversations.at(-1)}));
  expect(state.active).toBe(state.original);
  expect(state.target.draft).toBe('keep this draft');
  expect(state.target.messages[0].blocks[0].text).toBe('keep these messages');
});

it('待审批和未知运行上下文禁止分叉/移交，后端失败保留原标签与消息', async () => {
  await open();
  await page.evaluate(() => {
    const w = window as any;
    w.chatStore.setState((s:any)=>({conversations:s.conversations.map((c:any)=>({...c,pendingApprovals:[{requestId:'pending',kind:'tool',status:'pending'}]}))}));
  });
  await openRewind();
  for (const name of ['分叉会话','原生终端恢复','编辑并分叉','回退文件']) {
    expect(await page.getByRole('button',{name,exact:true}).isDisabled()).toBe(true);
  }
  expect(await calls('close')).toEqual([]);
  await page.evaluate(() => {
    const w = window as any;
    w.chatStore.setState((s:any)=>({conversations:s.conversations.map((c:any)=>({...c,pendingApprovals:[]}))}));
    w.fixture.responses.runtimeState = {state:'ready',busy:false,pendingApprovals:[{requestId:'backend-pending'}]};
  });
  await page.getByRole('button',{name:'原生终端恢复',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'等待审批'}).waitFor();
  expect(await page.evaluate(()=>(window as any).terminalStore.getState().open)).toBe(false);
  await page.evaluate(() => { (window as any).fixture.responses.runtimeState = {conversationId:'foreign-tab',sessionId:'foreign-sid',state:'ready',busy:false}; });
  await page.getByRole('button',{name:'分叉会话',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'运行上下文不匹配'}).waitFor();
  expect(await calls('close')).toEqual([]);
  await page.evaluate(() => { const f = (window as any).fixture; f.responses.runtimeState = {state:'closed',busy:false}; f.fail = 'fork'; });
  await page.getByRole('button',{name:'分叉会话',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'fork: backend refused custom root'}).waitFor();
  const conversations = await page.evaluate(()=>(window as any).chatStore.getState().conversations);
  expect(conversations).toHaveLength(1);
  expect(conversations[0].messages.map((m:any)=>m.id)).toEqual(['gui-user','gui-answer']);
});

it('消息分叉待完成时会话级移交和其他消息操作也被禁用', async () => {
  await open();
  await page.evaluate(() => { (window as any).fixture.pending = 'editFork'; });
  await page.getByRole('button',{name:'编辑并分叉',exact:true}).click();
  await page.waitForFunction(() => !!(window as any).fixture.resolvers.editFork);
  for (const name of ['分叉会话','原生终端恢复','从此处分叉']) expect(await page.getByRole('button',{name,exact:true}).isDisabled()).toBe(true);
  await page.getByRole('button',{name:'取消等待',exact:true}).click();
  await page.evaluate(() => { (window as any).fixture.resolvers.editFork({success:true,newSession:true,cwd:'/project',messages:[],draft:'original prompt'}); });
  await expect.poll(() => page.getByRole('button',{name:'原生终端恢复',exact:true}).isEnabled()).toBe(true);
});

it('失败重试保留旧消息并只重发一次，不调用移除历史或文件回退', async () => {
  await open();
  await page.evaluate(() => { (window as any).chatStore.setState({removeLastTurn:()=>{throw new Error('must not remove history');}}); });
  const retry = page.getByRole('button',{name:'重试',exact:true});
  expect(await retry.getAttribute('title')).toBe('保留失败历史再次发送，不自动撤销文件/外部操作');
  await retry.click();
  await expect.poll(() => calls('send')).toHaveLength(1);
  const state = await page.evaluate(()=>(window as any).chatStore.getState().conversations[0]);
  expect(state.messages.slice(0,2).map((m:any)=>m.id)).toEqual(['gui-user','gui-answer']);
  expect(state.messages[2].blocks[0].text).toBe('original prompt');
  expect((await calls('send'))[0].payload.prompt).toBe('original prompt');
  expect(await calls('rewind')).toEqual([]);
  expect(await calls('fork')).toEqual([]);
});

it('首条用户消息编辑返回 newSession 时保持 SID null，只预填草稿', async () => {
  await open();
  await page.evaluate(() => { (window as any).fixture.responses.editFork = {success:true,newSession:true,cwd:'/project',title:'First edited',messages:[],draft:'original prompt'}; });
  await page.getByRole('button',{name:'编辑并分叉',exact:true}).click();
  await page.getByRole('heading',{name:'First edited',exact:true}).waitFor();
  const conv = await page.evaluate(()=>(window as any).chatStore.getState().conversations.at(-1));
  expect(conv.sessionId).toBeNull();
  expect(conv.messages).toEqual([]);
  expect(conv.draft).toBe('original prompt');
  expect(await page.getByRole('button',{name:'原生终端恢复',exact:true}).isDisabled()).toBe(true);
  expect(await calls('send')).toEqual([]);
});

it('原会话关闭后的迟到分叉结果不覆盖或激活其他标签', async () => {
  await open();
  await page.evaluate(() => { (window as any).fixture.pending = 'fork'; });
  await page.getByRole('button',{name:'分叉会话',exact:true}).click();
  await page.waitForFunction(() => !!(window as any).fixture.resolvers.fork);
  await page.evaluate(async () => {
    const w = window as any;
    w.chatStore.getState().newConversation({cwd:'/other',title:'Unrelated',draft:'unrelated draft'});
    w.chatStore.getState().closeConversation(w.originalId);
    w.fixture.resolvers.fork({success:true,sessionId:'late-sid',cwd:'/project',title:'Late',messages:[]});
    await new Promise(resolve=>setTimeout(resolve,0));
  });
  await page.getByRole('heading',{name:'Unrelated',exact:true}).waitFor();
  const state = await page.evaluate(()=>(window as any).chatStore.getState());
  expect(state.conversations).toHaveLength(1);
  expect(state.conversations[0].draft).toBe('unrelated draft');
  expect(state.conversations[0].messages).toEqual([]);
  expect(state.sessions.some((s:any)=>s.sessionId==='late-sid')).toBe(false);
});

it('close 必须完成后才分叉；缺少完整返回消息时读取所有后续分页', async () => {
  await open();
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.pending = 'close';
    w.fixture.responses.fork = {success:true,sessionId:'fork-sid',cwd:'/project',title:'Paged fork'};
    w.api.claude.historyRead = async (p:any) => {
      w.fixture.calls.push({method:'historyRead',payload:p});
      return {sessionId:p.sessionId,cwd:p.cwd,nextOffset:p.offset === 0 ? 200 : null,messages:[{type:'user',uuid:`page-${p.offset}`,message:{content:`fork page ${p.offset}`}}]};
    };
  });
  await page.getByRole('button',{name:'分叉会话',exact:true}).click();
  await page.waitForFunction(() => !!(window as any).fixture.resolvers.close);
  expect(await calls('fork')).toEqual([]);
  await page.evaluate(() => { const f=(window as any).fixture; f.pending=''; f.resolvers.close({success:true}); });
  await page.getByRole('heading',{name:'Paged fork',exact:true}).waitFor();
  expect((await calls('historyRead')).map(c=>c.payload.offset)).toEqual([0,200]);
  const conv = await page.evaluate(()=>(window as any).chatStore.getState().conversations.at(-1));
  expect(conv.messages.map((m:any)=>m.cliUuid)).toEqual(['page-0','page-200']);
});

it('关闭历史面板取消待完成导入；中途分页失败不导入残缺历史且可重试', async () => {
  await open();
  await page.getByRole('button',{name:'CLI 历史',exact:true}).click();
  await page.evaluate(() => { (window as any).fixture.pending='historyRead'; });
  await page.getByRole('button',{name:'导入 CLI archive',exact:true}).click();
  await page.waitForFunction(() => !!(window as any).fixture.resolvers.historyRead);
  await page.getByRole('button',{name:'关闭历史',exact:true}).click();
  await page.evaluate(async () => {
    const w = window as any;
    w.fixture.pending='';
    w.fixture.resolvers.historyRead({sessionId:'history-sid',cwd:'/project',messages:[],nextOffset:null});
    await new Promise(resolve=>setTimeout(resolve,0));
    w.api.claude.historyRead=async (p:any)=>{
      w.fixture.calls.push({method:'historyRead',payload:p});
      if (p.offset === 200 && !w.fixture.recovered) throw new Error('second page failed');
      return {sessionId:p.sessionId,cwd:p.cwd,nextOffset:p.offset===0?200:null,messages:[{type:'user',uuid:`uuid-${p.offset}`,message:{content:`history-${p.offset}`}}]};
    };
  });
  expect(await page.evaluate(()=>(window as any).chatStore.getState().conversations.length)).toBe(1);
  await page.getByRole('button',{name:'CLI 历史',exact:true}).click();
  await page.getByRole('button',{name:'导入 CLI archive',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'second page failed'}).waitFor();
  expect(await page.evaluate(()=>(window as any).chatStore.getState().sessions.length)).toBe(1);
  await page.evaluate(()=>{(window as any).fixture.recovered=true;});
  await page.getByRole('button',{name:'导入 CLI archive',exact:true}).click();
  await page.getByRole('heading',{name:'CLI archive',exact:true}).waitFor();
  expect(await page.evaluate(()=>(window as any).chatStore.getState().conversations.at(-1).messages.length)).toBe(2);
});

it('回退取消、不可用检查点或缺 token 都不提交实际回退', async () => {
  await open();
  page.once('dialog',dialog=>dialog.dismiss());
  await openRewind();
  await page.getByRole('button',{name:'回退文件',exact:true}).click();
  await expect.poll(() => page.getByRole('button', { name: '分叉会话', exact: true }).isEnabled()).toBe(true);
  expect((await calls('rewind')).map(c=>c.payload.dryRun)).toEqual([true]);
  await page.evaluate(()=>{(window as any).fixture.responses.rewind={success:true,canRewind:false};});
  await openRewind();
  await page.getByRole('button',{name:'回退文件',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'没有可用'}).waitFor();
  await page.evaluate(()=>{(window as any).fixture.responses.rewind={success:true,canRewind:true,filesChanged:['src/example.ts']};});
  await openRewind();
  await page.getByRole('button',{name:'回退文件',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'没有可用'}).waitFor();
  expect((await calls('rewind')).every(c=>c.payload.dryRun)).toBe(true);
  expect(await page.evaluate(()=>(window as any).chatStore.getState().conversations[0].messages.length)).toBe(2);
});

it('分叉返回 GUI 形状消息时生成新 UI ID，保留 CLI UUID、metadata 与嵌套 blocks', async () => {
  await open();
  await page.evaluate(()=>{
    (window as any).fixture.responses.fork={success:true,sessionId:'fork-sid',cwd:'/project',title:'UI fork',messages:[{id:'gui-user',role:'user',cliUuid:'fresh-user',endUuid:'fresh-user',timestamp:3,status:'completed',metadata:{uuid:'fresh-user'},blocks:[{kind:'text',text:'fresh prompt'},{kind:'notice',text:'attachment',raw:{path:'image.png',opaque:'preserved'}}]}]};
  });
  await page.getByRole('button',{name:'分叉会话',exact:true}).click();
  await page.getByRole('heading',{name:'UI fork',exact:true}).waitFor();
  const m=await page.evaluate(()=>(window as any).chatStore.getState().conversations.at(-1).messages[0]);
  expect(m.id).not.toBe('gui-user');
  expect(m.cliUuid).toBe('fresh-user');
  expect(m.metadata).toEqual({uuid:'fresh-user'});
  expect(m.blocks[1].raw).toEqual({path:'image.png',opaque:'preserved'});
});

it('缺失会话 API 与原生导出失败均显示诊断；取消保存不显示导出成功', async () => {
  await open();
  await page.evaluate(()=>{delete (window as any).api.claude.fork;});
  await page.getByRole('button',{name:'分叉会话',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'fork'}).waitFor();
  expect(await page.evaluate(()=>(window as any).chatStore.getState().conversations.length)).toBe(1);
  await page.evaluate(()=>{(window as any).fixture.responses.exportTranscript={success:false,error:'raw export refused'};});
  await page.getByRole('button',{name:'导出原生 JSONL',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'raw export refused'}).waitFor();
  await page.evaluate(()=>{(window as any).fixture.responses.exportTranscript={success:false,canceled:true};});
  await page.getByRole('button',{name:'导出原生 JSONL',exact:true}).click();
  await expect.poll(()=>page.getByRole('button',{name:'导出原生 JSONL',exact:true}).isEnabled()).toBe(true);
  expect(await page.getByRole('status').filter({hasText:'已导出'}).count()).toBe(0);
});

it('消息操作绑定当前标签上下文，即使历史 GUI ID 重复也不误分叉另一会话', async () => {
  await open();
  await page.evaluate(() => {
    const w=window as any;
    const source=w.chatStore.getState().conversations[0];
    w.chatStore.getState().newConversation({fromSession:{sessionId:'other-sid',cwd:'/other',title:'Same GUI IDs',createdAt:1,cost:0,inputTokens:0,outputTokens:0,messages:source.messages.map((m:any)=>({...m,cliUuid:m.role==='user'?'other-user':'other-start',endUuid:'other-end'}))}});
  });
  await page.getByRole('button',{name:'从此处分叉',exact:true}).click();
  await page.getByRole('heading',{name:'Forked',exact:true}).waitFor();
  expect((await calls('fork'))[0].payload).toMatchObject({cwd:'/other',sessionId:'other-sid',upToMessageId:'other-end'});
  const state=await page.evaluate(()=>(window as any).chatStore.getState().conversations);
  expect((await calls('fork'))[0].payload.conversationId).toBe(state[1].id);
});

async function calls(method: string): Promise<{ method: string; payload: any }[]> {
  return page.evaluate(m => (window as any).fixture.calls.filter((c: any) => c.method === m), method);
}

it('显式整段分叉创建独立标签页，保留原始失败历史和完整 SDK blocks', async () => {
  await open();
  await page.getByRole('button', { name: '分叉会话', exact: true }).click();
  await page.getByRole('heading', { name: 'Forked', exact: true }).waitFor();
  const state = await page.evaluate(() => (window as any).chatStore.getState().conversations);
  expect(state).toHaveLength(2);
  expect(state[0].messages.map((m: any) => m.id)).toEqual(['gui-user', 'gui-answer']);
  expect(state[1].messages[0].blocks).toEqual([{ kind: 'thinking', text: 'fork thinking' }, { kind: 'text', text: 'fork response' }]);
  expect(state[1].id).not.toBe(state[0].id);
  expect((await calls('fork'))[0].payload).toEqual({ conversationId: state[0].id, cwd: '/project', sessionId: 'original-sid' });
  expect((await calls('close'))[0].payload).toBe(state[0].id);
  expect(await calls('send')).toEqual([]);
  expect(errors).toEqual([]);
});
