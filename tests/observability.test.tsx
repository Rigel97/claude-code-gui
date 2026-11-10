import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CostDashboard } from '../src/renderer/components/CostDashboard';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCallView } from '../src/renderer/components/ToolCallView';
import { StatsView } from '../src/renderer/components/StatsView';
import { useStore } from '../src/renderer/store';
import type { UIBlock, Session, ResultMessage } from '../src/renderer/types';
import * as exports from '../src/renderer/utils/exportSession';

type Tool = Extract<UIBlock, { kind: 'tool_use' }>;
const longText = '完整文本'.repeat(1500) + 'LONG_TEXT_END';
const thinking = '推理'.repeat(500) + 'THINKING_END';
const tool = (overrides: Partial<Tool> = {}): Tool => ({
  kind: 'tool_use', toolName: 'Task', toolId: 'parent-id', input: {}, status: 'running', ...overrides,
});
const session = (blocks: UIBlock[], role: 'user' | 'assistant' | 'system' = 'assistant'): Session => ({
  sessionId: 'session-id', cwd: '/project', title: 'Audit', createdAt: 1,
  cost: 1, inputTokens: 2, outputTokens: 3, model: 'model', events: [{ t: 1, cost: 1, input: 2, output: 3 }],
  messages: [{ id: 'message-id', role, timestamp: 2, status: 'completed', blocks }],
});

// 标准 JSON 仅承诺序列化实际 Session，不宣称导出尚未保存的 raw 事件。
describe('会话无损导出', () => {
  it('完整长结果、嵌套结果、输入和 stderr 用足够长的动态 fence', () => {
    const result = longText + '\n```js\ncode\n```\n``````\nRESULT_END';
    const markdown = exports.sessionToMarkdown(session([tool({
      input: { command: 'literal ````` input' }, result,
      children: [tool({ toolId: 'deep-id', result }), { kind: 'thinking', text: thinking }],
    }), { kind: 'stderr', text: 'oops\n````\nSTDERR_END' }]));
    expect(markdown.split(result).length - 1).toBe(2);
    expect(markdown).toContain('```````\n' + result + '\n```````');
    expect(markdown).toContain('``````json\n');
    expect(markdown).toContain('`````\nSTDERR: oops\n````\nSTDERR_END\n`````');
    expect(markdown).toContain(thinking);
    expect(markdown).not.toContain('已截断');
  });

  it.each(['running', 'done', 'error', 'unknown'])('准确输出 %s 状态且 summary 防注入、无装饰 emoji', (status) => {
    const block = { ...tool({ toolName: '<img src=x onerror=alert(1)>', input: { description: '</summary><script>bad</script>' } }), status } as Tool;
    const markdown = exports.sessionToMarkdown(session([block]));
    expect(markdown).toContain({ running: '运行中', done: '已完成', error: '错误', unknown: '未知状态' }[status]!);
    expect(markdown).not.toMatch(/✅|❌|🔧|🤖|🧑|💭|⏱/u);
    const summary = markdown.match(/<summary>(.*?)<\/summary>/)?.[1];
    expect(summary).not.toContain('<img');
    expect(summary).not.toContain('<script>');
    expect(summary).toContain('&lt;img');
    expect(summary).toContain('&lt;/summary&gt;&lt;script&gt;bad&lt;/script&gt;');
    if (status !== 'done') expect(markdown).not.toContain('已完成');
  });

  it('JSON 完整保留 ID、所有 blocks 和已有附件，且不修改输入', () => {
    const attachment = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } };
    const block = { ...tool({ result: longText, children: [{ kind: 'thinking', text: thinking }, tool({ toolId: 'leaf-id', result: longText })] }), resultContent: [attachment] };
    const value = session([{ kind: 'text', text: longText, msgId: 'source-id' }, block, { kind: 'stderr', text: 'stderr' }, { kind: 'stats', data: {} as ResultMessage }], 'user');
    const before = JSON.stringify(value);
    const jsonExporter = (exports as unknown as { sessionToJson: (s: Session) => string }).sessionToJson;
    expect(typeof jsonExporter).toBe('function');
    const json = jsonExporter(value);
    expect(JSON.parse(json)).toEqual(value);
    expect(JSON.parse(json).messages[0].blocks[1].resultContent[0]).toEqual(attachment);
    expect(json).not.toContain('raw');
    expect(JSON.stringify(value)).toBe(before);
    const markdown = exports.sessionToMarkdown(value);
    expect(markdown).toContain('aW1hZ2U=');
    expect(markdown).toContain('LONG_TEXT_END');
    expect(markdown).toContain('THINKING_END');
  });
});

const completeStats: Partial<ResultMessage> = {
  usage: { input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 33, cache_read_input_tokens: 44 },
  duration_ms: 1500, ttft_ms: 25, num_turns: 2,
};
function statsValues(data: unknown): string[] {
  const html = renderToStaticMarkup(<StatsView data={data as ResultMessage} />);
  return [...html.matchAll(/<span class="text-xs font-mono font-semibold [^"]*">(.*?)<\/span>/g)].map(match => match[1]);
}

describe('Stats 指标防御（真实 SSR）', () => {
  it('Total 包含四种 token 用量', () => {
    expect(statsValues(completeStats)).toEqual(['110', '11', '22', '1.5s', '2', '25ms']);
  });

  it.each([undefined, null, {}])('usage %s 不崩溃且缺失值不冒充零', (usage) => {
    expect(statsValues({ usage })).toEqual(['—', '—', '—', '—', '—', '—']);
  });

  it.each([undefined, null, NaN, -1, Infinity, '12'])('指标 %s 无效时一律显示 —', (invalid) => {
    expect(statsValues({ usage: { input_tokens: invalid, output_tokens: invalid, cache_creation_input_tokens: invalid, cache_read_input_tokens: invalid }, duration_ms: invalid, ttft_ms: invalid, num_turns: invalid }))
      .toEqual(['—', '—', '—', '—', '—', '—']);
  });

  it.each(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'])('任一 %s 缺失不得显示不完整 Total', (key) => {
    const usage = { ...completeStats.usage };
    delete usage[key as keyof typeof usage];
    expect(statsValues({ ...completeStats, usage })[0]).toBe('—');
  });

  it('真实零指标保留零；求和溢出不能输出 Infinity', () => {
    expect(statsValues({ usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, duration_ms: 0, ttft_ms: 0, num_turns: 0 }))
      .toEqual(['0', '0', '0', '0.0s', '0', '0ms']);
    expect(statsValues({ ...completeStats, usage: { ...completeStats.usage, input_tokens: Number.MAX_VALUE, output_tokens: Number.MAX_VALUE } })[0]).toBe('—');
  });
});

describe('用量面板（真实 SSR）', () => {
  const initial = { ...useStore.getState() };
  const initialSSR = { ...useStore.getInitialState() };
  afterEach(() => {
    Object.assign(useStore.getInitialState(), initialSSR);
    useStore.setState(initial);
    vi.useRealTimers();
  });
  // Zustand 4 的 SSR 闭包读取初始对象；仅在面板用例内提供快照并立即还原。
  function renderDashboard() {
    Object.assign(useStore.getInitialState(), useStore.getState());
    try { return renderToStaticMarkup(<CostDashboard onClose={() => {}} />); }
    finally { Object.assign(useStore.getInitialState(), initialSSR); }
  }

  it('统一汇总带保留总量、输入输出配对和归档口径，关闭区域固定32px', () => {
    useStore.setState({ sessions: [session([])], totalInputTokens: 2, totalOutputTokens: 3 });
    const html = renderDashboard();
    expect(html).toContain('title="5"');
    expect(html).toContain('aria-label="归档用量汇总"');
    expect(html).toContain('总 Token');
    expect(html).toContain('会话数');
    expect(html).toContain('近 7 天');
    expect(html).toContain('仅当前保留的归档会话');
    expect(html).toContain('已清空的会话会从累计值中扣除');
    expect(html).not.toContain('lg:grid-cols-5');
    expect(html).toMatch(/aria-label="关闭用量统计"[^>]*class="[^"]*h-8 w-8 shrink-0/);
  });

  it('柱段保持线性真实比例，零日无stub，图例同色且精确值不缩写', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 10, 12));
    useStore.setState({ sessions: [{ ...session([]), events: [
      { t: new Date(2026, 10, 9, 12).getTime(), cost: 0, input: 1, output: 0 },
      { t: new Date(2026, 10, 10, 12).getTime(), cost: 0, input: 1234, output: 2766 },
    ] }] });
    const html = renderDashboard();
    const bars = [...html.matchAll(/<rect data-series="(input|output)"[^>]*height="([^"]+)"[^>]*fill="([^"]+)"/g)];
    expect(bars.map(b => [b[1], b[3]])).toEqual([
      ['input', '#3b82f6'], ['output', '#00e5ff'], ['input', '#3b82f6'],
    ]);
    [0.03, 82.98, 37.02].forEach((height, i) => expect(Number(bars[i][2])).toBeCloseTo(height, 10));
    expect(html).toContain('background-color:#3b82f6');
    expect(html).toContain('background-color:#00e5ff');
    expect(html).toContain('输入 1,234，输出 2,766，合计 4,000 Token');
    expect(html).toContain('class="py-1 text-right">1,234</td>');
    expect(html).toContain('class="py-1 text-right">2,766</td>');
    expect(html).toContain('class="py-1 text-right">4,000</td>');
    expect((html.match(/data-date=/g) ?? []).length).toBe(14);
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
  });

  it.each([
    { sessions: [] },
    { sessions: [{ ...session([]), events: undefined }] },
    { sessions: [{ ...session([]), events: [{ t: new Date(2026, 10, 10).getTime(), cost: 0, input: 0, output: 0 }] }] },
  ])('无归档、仅旧历史或全零用量均保留14天图架，不伪造柱数据', ({ sessions }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 10, 12));
    useStore.setState({ sessions });
    const html = renderDashboard();
    expect(html).toContain('近 14 天暂无用量数据');
    expect(html).toContain('查看每日数据表');
    expect((html.match(/data-date=/g) ?? []).length).toBe(14);
    expect(html).not.toContain('data-series=');
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it('现有事件优先、无事件回退createdAt，近7天含今天且不计未来日期', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 10, 12));
    useStore.setState({ sessions: [
      { ...session([]), sessionId: 'events', inputTokens: 999, outputTokens: 999, events: [
        { t: new Date(2026, 10, 3, 23, 59).getTime(), cost: 0, input: 10, output: 20 },
        { t: new Date(2026, 10, 4).getTime(), cost: 0, input: 30, output: 40 },
        { t: new Date(2026, 10, 11).getTime(), cost: 0, input: 500, output: 500 },
      ] },
      { ...session([]), sessionId: 'legacy', createdAt: new Date(2026, 10, 10).getTime(), events: [] },
    ] });
    const html = renderDashboard();
    expect(html).toContain('title="75">75 Token');
    expect(html).toContain('2026-11-10：输入 2，输出 3，合计 5 Token');
    expect(html).toContain('2026-11-03：输入 10，输出 20，合计 30 Token');
    expect(html).not.toContain('2026-11-11');
  });

  it.each([['America/New_York', 2, 8], ['America/New_York', 10, 1]])
    ('%s 夏令时切换前后仍按本地日历聚合，不丢失首日或重复日期', (timezone, month, day) => {
      const previous = process.env.TZ;
      process.env.TZ = timezone;
      try {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, month, day + 1, 12));
        useStore.setState({ sessions: [{ ...session([]), events: [
          { t: new Date(2026, month, day, 0, 30).getTime(), cost: 0, input: 7, output: 11 },
          { t: new Date(2026, month, day, 23, 30).getTime(), cost: 0, input: 13, output: 17 },
          { t: new Date(2026, month, day + 1, 0, 30).getTime(), cost: 0, input: 19, output: 23 },
          { t: new Date(2026, month, day - 12, 0, 30).getTime(), cost: 0, input: 29, output: 31 },
        ] }] });
        const html = renderDashboard();
        const dates = [...html.matchAll(/data-date="([^"]+)"/g)].map(m => m[1]);
        expect(new Set(dates).size).toBe(14);
        expect(html).toContain(`${dates[12]}：输入 20，输出 28，合计 48 Token`);
        expect(html).toContain(`${dates[13]}：输入 19，输出 23，合计 42 Token`);
        expect(html).toContain(`${dates[0]}：输入 29，输出 31，合计 60 Token`);
      } finally {
        if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
      }
    });

  it('Top5排序和细bar使用相对最高会话的真实比例，零会话不制造最小宽度', () => {
    useStore.setState({ sessions: [0, 1, 10, 100, 200, 400].map((total) => ({
      ...session([]), sessionId: `s${total}`, title: `Archive ${total}`, inputTokens: total, outputTokens: 0,
    })) });
    const html = renderDashboard();
    expect([...html.matchAll(/aria-label="打开归档会话 ([^"]+)"/g)].map(m => m[1]))
      .toEqual(['Archive 400', 'Archive 200', 'Archive 100', 'Archive 10', 'Archive 1']);
    expect([...html.matchAll(/data-session-share="[^"]+"[^>]*style="width:([^"]+)"/g)].map(m => m[1]))
      .toEqual(['100%', '50%', '25%', '2.5%', '0.25%']);
    useStore.setState({ sessions: [{ ...session([]), inputTokens: 0, outputTokens: 0 }] });
    expect(renderDashboard()).toContain('style="width:0%"');
  });
});

describe('用量面板交互与布局（真实浏览器）', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;
  let url: string;
  const errors: string[] = [];
  beforeAll(async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    server = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false },
      plugins: [{
        name: 'usage-dashboard-fixture',
        resolveId(id) { if (id === '/usage-fixture.tsx') return '\0usage-fixture.tsx'; },
        load(id) {
          if (id !== '\0usage-fixture.tsx') return;
          return `import React from 'react';
            import {createRoot} from 'react-dom/client';
            import {CostDashboard} from '${root}/src/renderer/components/CostDashboard.tsx';
            import {useStore} from '${root}/src/renderer/store.ts';
            import {useProjectsStore} from '${root}/src/renderer/projectStore.ts';
            import '${root}/src/renderer/styles/globals.css';
            window.chatStore=useStore; window.projectsStore=useProjectsStore;
            window.modelCalls=[]; window.api={claude:{send: p=>{window.modelCalls.push(p); throw new Error('Model requests forbidden');}}};
            const today=new Date(); today.setHours(12,0,0,0);
            const yesterday=new Date(today); yesterday.setDate(yesterday.getDate()-1);
            useStore.getState().hydrate({cwd:'/project'});
            window.draftId=useStore.getState().activeConversationId;
            useStore.getState().setDraft('untouched draft',window.draftId);
            const archive={sessionId:'archive',cwd:'/project',title:'Archive',createdAt:today.getTime(),cost:0,inputTokens:1235,outputTokens:2766,model:'example-model',messages:[],events:[
              {t:today.getTime(),cost:0,input:1234,output:2766},{t:yesterday.getTime(),cost:0,input:1,output:0}]};
            useStore.setState({sessions:[archive],totalInputTokens:1235,totalOutputTokens:2766});
            function Fixture(){const [open,setOpen]=React.useState(true);return open
              ? React.createElement(CostDashboard,{onClose:()=>setOpen(false)})
              : React.createElement('div',null,'dashboard closed');}
            createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
        },
        configureServer(vite) {
          vite.middlewares.use('/__usage_test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(await vite.transformIndexHtml('/__usage_test', '<html><body><div id="root"></div><script type="module" src="/usage-fixture.tsx"></script></body></html>'));
          });
        },
      }],
    });
    await new Promise<void>(resolve => server.httpServer!.listen(0, '127.0.0.1', resolve));
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    url = `http://127.0.0.1:${address.port}/__usage_test`;
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
  }, 60000);
  afterEach(async () => {
    if (page) {
      expect(await page.evaluate(() => (window as any).modelCalls)).toEqual([]);
      await page.context().close();
    }
    expect(errors.splice(0)).toEqual([]);
  });
  afterAll(async () => { await browser?.close(); await server?.close(); }, 60000);
  async function open(width = 900, height = 600) {
    const context = await browser.newContext({ viewport: { width, height } });
    page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('dialog', { name: 'Token 用量统计' }).waitFor();
    await page.getByLabel('关闭用量统计').waitFor();
  }

  it.each([[900, 600], [1400, 900]])('%dx%d 布局无横向溢出，关闭按钮32px且初始获得焦点', async (width, height) => {
    await open(width, height);
    await vi.waitFor(async () => expect(await page.getByLabel('关闭用量统计').evaluate(el => document.activeElement === el)).toBe(true));
    const box = await page.getByLabel('关闭用量统计').boundingBox();
    expect(box?.width).toBe(32); expect(box?.height).toBe(32);
    const layout = await page.getByRole('dialog').evaluate(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, overflow: el.scrollWidth > el.clientWidth };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0); expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(width); expect(layout.bottom).toBeLessThanOrEqual(height);
    expect(layout.overflow).toBe(false);
    await page.getByLabel('打开归档会话 Archive').scrollIntoViewIfNeeded();
    expect(await page.getByLabel('打开归档会话 Archive').isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    await page.getByText('dashboard closed').waitFor();
  });

  it('hover与键盘选择日期显示精确值，零日可选择但不渲染柱段', async () => {
    await open();
    const dates = page.locator('[data-date]');
    await dates.nth(12).hover();
    expect(await page.getByRole('status').textContent()).toContain('输入 1');
    expect(await dates.nth(12).getAttribute('aria-pressed')).toBe('true');
    await dates.nth(12).focus();
    await page.keyboard.press('ArrowRight');
    expect(await page.getByRole('status').textContent()).toContain('输入 1,234');
    expect(await page.getByRole('status').textContent()).toContain('输出 2,766');
    expect(await page.getByRole('status').textContent()).toContain('4,000');
    await page.keyboard.press('Home');
    expect(await dates.first().getAttribute('aria-pressed')).toBe('true');
    expect(await dates.first().locator('[data-series]').count()).toBe(0);
    expect(await page.getByRole('status').textContent()).toContain('合计 0');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    expect(await dates.last().getAttribute('aria-pressed')).toBe('true');
    await page.getByText('查看每日数据表').click();
    expect(await page.getByRole('table').textContent()).toContain('1,2342,7664,000');
  });

  it('打开归档先保护项目草稿，取消保留面板；成功复用标签且原聊天草稿不丢失', async () => {
    await open();
    await page.evaluate(() => (window as any).projectsStore.setState({open:true,dirty:true,dirtyReasons:{background:true}}));
    page.once('dialog', dialog => { void dialog.dismiss(); });
    await page.getByLabel('打开归档会话 Archive').click();
    await page.getByRole('alert').filter({hasText:'已取消'}).waitFor();
    expect(await page.evaluate(() => (window as any).projectsStore.getState().dirty)).toBe(true);
    expect(await page.evaluate(() => (window as any).chatStore.getState().conversations.length)).toBe(1);
    const existingId = await page.evaluate(() => (window as any).chatStore.getState().newConversation({fromSession:(window as any).chatStore.getState().sessions[0]}));
    page.once('dialog', dialog => { void dialog.accept(); });
    await page.getByLabel('打开归档会话 Archive').click();
    await page.getByText('dashboard closed').waitFor();
    expect(await page.evaluate(() => (window as any).chatStore.getState().activeConversationId)).toBe(existingId);
    expect(await page.evaluate(() => (window as any).chatStore.getState().conversations.length)).toBe(2);
    expect(await page.evaluate(() => (window as any).chatStore.getState().conversations.find((c:any)=>c.id===(window as any).draftId).draft)).toBe('untouched draft');
    expect(await page.evaluate(() => (window as any).projectsStore.getState().open)).toBe(false);
  });

  it('未打开的归档创建新标签，仅载入历史而不发送请求', async () => {
    await open();
    await page.getByLabel('打开归档会话 Archive').click();
    await page.getByText('dashboard closed').waitFor();
    const result = await page.evaluate(() => {
      const w = window as any;
      const state = w.chatStore.getState();
      return { count: state.conversations.length, sessionId: state.conversations.find((c:any)=>c.id===state.activeConversationId).sessionId,
        draft: state.conversations.find((c:any)=>c.id===w.draftId).draft };
    });
    expect(result).toEqual({ count: 2, sessionId: 'archive', draft: 'untouched draft' });
  });

  it.each(['throw', 'missing'])('归档打开%s失败透明且不关闭面板', async (failure) => {
    await open();
    await page.evaluate(failure => {
      const w = window as any;
      if (failure === 'throw') w.chatStore.setState({openSessionTab:()=>{throw new Error('archive unavailable');}});
      else w.projectsStore.setState({showChat:async()=>{w.chatStore.setState({sessions:[]});return true;}});
    }, failure);
    await page.getByLabel('打开归档会话 Archive').click();
    await page.getByRole('alert').filter({hasText:'打开会话失败'}).waitFor();
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
    expect(await page.getByRole('alert').textContent()).toContain(failure === 'throw' ? 'archive unavailable' : '未能打开归档标签');
  });
});

const initialThinking = useStore.getState().showThinking;
afterEach(() => useStore.getState().setShowThinking(initialThinking));

describe('工具调用可观测性（真实 React）', () => {
  it.each(['Task', 'Agent'])('%s 深嵌套文本和结果保持完整且可复制', (toolName) => {
    const block = tool({ toolName, children: [tool({ toolName: 'Agent', toolId: 'child-id', children: [
      { kind: 'text', text: longText },
      tool({ toolName: 'Write', toolId: 'leaf-id', result: longText }),
    ] })] });
    const html = renderToStaticMarkup(<ToolCallView block={block} />);
    expect(html.split(longText).length - 1).toBe(2);
    expect(html).toContain('复制完整文本');
    expect(html).toContain('复制完整结果');
    expect(html).toContain('overflow-y-auto');
  });

  it('嵌套 thinking 使用折叠思考视图并响应全局开关', () => {
    const block = tool({ children: [tool({ children: [{ kind: 'thinking', text: thinking }] })] });
    useStore.getState().setShowThinking(true);
    const shown = renderToStaticMarkup(<ToolCallView block={block} />);
    expect(shown).toContain('思考过程');
    expect(shown).toContain(`${thinking.length} chars`);
    expect(shown).not.toContain('THINKING_END'); // ThinkingView 初始折叠
    useStore.getState().setShowThinking(false);
    expect(renderToStaticMarkup(<ToolCallView block={block} />)).not.toContain('思考过程');
  });

  it('收起结果时仍有完整复制入口；running 不显示成功标记', () => {
    const html = renderToStaticMarkup(<ToolCallView block={tool({ toolName: 'Bash', result: longText })} />);
    expect(html).toContain('复制完整结果');
    expect(html).not.toContain('lucide-circle-check');
    const runningEdit = renderToStaticMarkup(<ToolCallView block={tool({ toolName: 'Edit', result: 'pending' })} />);
    expect(runningEdit).not.toContain('✓');
  });

  it('可选结构化结果安全读取，附件仍可完整查看/复制', () => {
    const block = { ...tool({ toolName: 'Write' }), resultContent: [
      { type: 'text', text: longText },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    ] };
    const html = renderToStaticMarkup(<ToolCallView block={block} />);
    expect(html).toContain('LONG_TEXT_END');
    expect(html).toContain('image/png');
    expect(html).toContain('aW1hZ2U=');
    expect(html).toContain('复制完整结果');
    const withoutContent = { ...tool(), resultContent: null };
    expect(() => renderToStaticMarkup(<ToolCallView block={withoutContent} />)).not.toThrow();
  });
});
