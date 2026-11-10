import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// RUN_CONFIG_UI=1 npm test -- tests/config-ui.test.ts
// Isolated browser + in-memory bridge: no Electron, CLI, or user history.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let baseURL: string;
let disk: any;
let readFailure = false;
let writeFailure = false;
const writes: any[] = [];
const flushes: any[] = [];
const errors: string[] = [];
const conversation = (id: string, draft: string, cwd = '/fixture/project') => ({
  id, title: id, cwd, draft, messages: [], status: 'idle', sessionId: null,
});
const draftField = () => page.getByPlaceholder('输入指令，/ 唤起快捷命令，Enter 发送');
const unload = () => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

describe.skipIf(process.env.RUN_CONFIG_UI !== '1')('配置与输入框独立浏览器回归', () => {
  beforeAll(async () => {
    server = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite fixture port');
    baseURL = `http://127.0.0.1:${address.port}`;
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, executablePath: process.env.CONFIG_UI_CHROMIUM_PATH || (fs.existsSync(chrome) ? chrome : undefined) });
  }, 60000);

  beforeEach(async () => {
    disk = { cwd: '/fixture/project', sessions: [], conversations: [conversation('标签甲', '甲原草稿'), conversation('标签乙', '乙原草稿')], activeConversationId: '标签甲' };
    readFailure = false; writeFailure = false;
    writes.length = 0; flushes.length = 0; errors.length = 0;
    context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.exposeBinding('__configRPC', async (_source, method: string, args: any[]) => {
      if (method === 'get' || method === 'reload') {
        if (readFailure) throw new Error('fixture corrupt config');
        return disk;
      }
      if (method === 'set') {
        writes.push(args[1]);
        if (writeFailure) throw new Error('fixture write denied');
        disk = args[1];
        return;
      }
      if (method === 'flush') { flushes.push(args[0]); return; }
      throw new Error(`Unexpected fixture call: ${method}`);
    });
    await context.addInitScript(() => {
      const rpc = (method: string, ...args: unknown[]) => (window as any).__configRPC(method, args);
      (window as any).api = {
        store: { get: () => rpc('get'), reload: () => rpc('reload'), set: (...args: unknown[]) => rpc('set', ...args), flush: (data: unknown) => rpc('flush', data) },
        projects: { list: async () => [], storageInfo: async () => null, reviewDraft: async () => null, activeJob: async () => null },
        claude: { onStream: () => () => {}, onStatusChange: (callback: (payload: unknown) => void) => { (window as any).__configChangeStatus = callback; return () => {}; }, getContext: async () => null, send: async () => { throw new Error('Unexpected model invocation'); } },
        terminal: { health: async () => ({ available: true }), list: async () => [] },
        fs: { readDir: async () => [] }, openDirectory: async () => '/fixture/project',
        window: { minimize: () => {}, maximize: () => {}, close: () => {} },
      };
    });
    page = await context.newPage();
    page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) console.error('Config UI failure:', errors, await page.locator('body').innerText({ timeout: 3000 }).catch(() => 'Page unavailable'));
    await context?.close();
  });
  afterAll(async () => { await browser?.close(); await server?.close(); }, 60000);

  it('可见设置入口：危险保存确认的 Esc 只取消顶层，保留草稿，成功保存才关闭', async () => {
    await page.goto(baseURL);
    const opener = page.getByRole('button', { name: '设置', exact: true });
    await opener.click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('button', { name: '权限与安全', exact: true }).click();
    await settings.getByRole('button', { name: /全部放行（危险）/ }).click();
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
    await settings.getByRole('button', { name: '保存并关闭', exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: '启用全部放行', exact: true });
    await confirm.waitFor();
    await page.keyboard.press('Escape');
    await confirm.waitFor({ state: 'hidden' });
    expect(await settings.isVisible()).toBe(true);
    expect(await settings.getByRole('alertdialog', { name: '有未保存的设置更改', exact: true }).isVisible()).toBe(true);
    await settings.getByText('1 项更改未保存', { exact: true }).waitFor();
    expect(disk.permissionMode).not.toBe('bypassPermissions');
    await settings.getByRole('button', { name: '保存并关闭', exact: true }).click();
    await confirm.getByRole('button', { name: '启用全部放行', exact: true }).click();
    await settings.waitFor({ state: 'hidden' });
    await expect.poll(() => disk.permissionMode, { timeout: 6000 }).toBe('bypassPermissions');
    await expect.poll(() => opener.evaluate(el => el === document.activeElement)).toBe(true);
    expect(errors).toEqual([]);
  }, 20000);

  it('切换标签不污染新标签草稿，正在输入的草稿无需卸载即可持久化', async () => {
    await page.goto(baseURL);
    await draftField().fill('甲正在输入');
    await page.locator('[title="标签乙"]').click();
    expect(await draftField().inputValue()).toBe('乙原草稿');
    await draftField().fill('乙正在输入');
    await page.locator('[title="标签甲"]').click();
    expect(await draftField().inputValue()).toBe('甲正在输入');
    await page.locator('[title="标签乙"]').click();
    expect(await draftField().inputValue()).toBe('乙正在输入');
    await page.getByTitle('新对话标签页（可与其他标签页并行）', { exact: true }).click();
    expect(await draftField().inputValue()).toBe('');
    await draftField().fill('新标签独立草稿');
    await page.locator('[title="标签甲"]').click();
    expect(await draftField().inputValue()).toBe('甲正在输入');
    await page.locator('[title="新对话"]').click();
    expect(await draftField().inputValue()).toBe('新标签独立草稿');
    await expect.poll(() => disk.conversations.map((item: any) => item.draft), { timeout: 6000 }).toEqual(['甲正在输入', '乙正在输入', '新标签独立草稿']);
    expect(errors).toEqual([]);
  }, 20000);

  it('配置读取损坏时项目草稿仍阻止关闭，且不写入或 flush 配置', async () => {
    readFailure = true;
    await page.goto(baseURL);
    await page.getByRole('alert').filter({ hasText: '会话配置读取失败' }).waitFor();
    await page.getByRole('button', { name: /^项目管理中心/ }).click();
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByRole('dialog', { name: '新建项目', exact: true }).getByRole('textbox', { name: '项目名称', exact: true }).fill('坏配置期间的项目草稿');
    expect(await unload()).toBe(true);
    expect(writes).toEqual([]);
    expect(flushes).toEqual([]);
    expect(errors).toEqual([]);
  }, 20000);

  it('写失败后不丢弃捕获数据，无新输入也能自动重试成功', async () => {
    writeFailure = true;
    await page.goto(baseURL);
    await draftField().fill('写失败也要保存的草稿');
    await page.getByRole('alert').filter({ hasText: '会话配置保存失败' }).waitFor();
    const failedPayload = writes[0];
    expect(failedPayload.conversations[0].draft).toBe('写失败也要保存的草稿');
    writeFailure = false;
    await expect.poll(() => writes.length, { timeout: 6000 }).toBeGreaterThan(1);
    expect(writes[1]).toEqual(failedPayload);
    await expect.poll(() => disk.conversations[0].draft).toBe('写失败也要保存的草稿');
    await page.getByRole('alert').filter({ hasText: '会话配置保存失败' }).waitFor({ state: 'hidden' });
    expect(errors).toEqual([]);
  }, 20000);

  it('项目草稿阻止关闭之前先 flush 尚在节流窗口内的聊天草稿', async () => {
    await page.goto(baseURL);
    await draftField().fill('先写一次');
    await expect.poll(() => writes.length).toBeGreaterThan(0);
    await draftField().fill('关闭前的最新聊天草稿');
    await page.getByRole('button', { name: /^项目管理中心/ }).click();
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByRole('dialog', { name: '新建项目', exact: true }).getByRole('textbox', { name: '项目名称', exact: true }).fill('未保存项目');
    expect(await unload()).toBe(true);
    await expect.poll(() => flushes.length).toBeGreaterThan(0);
    expect(flushes.at(-1).conversations[0].draft).toBe('关闭前的最新聊天草稿');
    expect(errors).toEqual([]);
  }, 20000);

  it('坏配置期间新草稿恢复读取需确认，取消保留内存，确认后合并并保存', async () => {
    readFailure = true;
    await page.goto(baseURL);
    await page.getByRole('alert').filter({ hasText: '会话配置读取失败' }).waitFor();
    await page.getByRole('button', { name: /^工作目录：/ }).click();
    await draftField().fill('坏配置期间的新草稿');
    expect(writes).toEqual([]);
    readFailure = false;
    const retry = page.getByRole('button', { name: '修复后重新读磁盘（确认合并内存）', exact: true });
    await retry.click();
    const recovery = page.getByRole('alertdialog', { name: '重新读取配置', exact: true });
    await recovery.waitFor();
    expect(await recovery.innerText()).toContain('尚未保存的会话与草稿');
    await recovery.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '已取消恢复读取' }).waitFor();
    expect(await draftField().inputValue()).toBe('坏配置期间的新草稿');
    expect(writes).toEqual([]);
    expect(await unload()).toBe(false);
    expect(flushes).toEqual([]);
    await retry.click();
    await recovery.getByRole('button', { name: '读取并合并', exact: true }).click();
    await expect.poll(() => disk.conversations.length).toBe(3);
    expect(disk.conversations.map((item: any) => item.draft)).toEqual(['甲原草稿', '乙原草稿', '坏配置期间的新草稿']);
    expect(await draftField().inputValue()).toBe('坏配置期间的新草稿');
    expect(errors).toEqual([]);
  }, 20000);

  it('最小窗口展开终端后长输入仍可见可点击，说明与参数不挤走发送动作', async () => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto(baseURL);
    const text = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行完整工作说明`).join('\n');
    await page.getByRole('button', { name: '原生终端', exact: true }).click();
    await draftField().fill(text);
    const terminal = page.getByRole('region', { name: '官方原生终端', exact: true });
    await terminal.waitFor();
    const send = page.getByRole('button', { name: '发送', exact: true });
    const initialHit = await send.evaluate(button => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return button === hit || button.contains(hit);
    });
    expect(initialHit).toBe(true);
    await send.click({ trial: true });
    const bounds = await send.boundingBox();
    const terminalBounds = await terminal.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(terminalBounds!.y);
    await page.getByText('说明与参数', { exact: true }).click();
    await send.click({ trial: true });
    expect(await draftField().inputValue()).toBe(text);
    await page.keyboard.press('Escape');
    await terminal.getByRole('button', { name: '隐藏终端', exact: true }).click();
    await send.click({ trial: true });
    expect(errors).toEqual([]);
  }, 20000);

  it('最小窗口排队列表与命令说明顶层展开，不裁切停止和发送操作', async () => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto(baseURL);
    await draftField().waitFor();
    await page.evaluate(() => (window as any).__configChangeStatus({ conversationId: '标签甲', status: 'streaming' }));
    const field = page.getByRole('textbox', { name: '消息输入', exact: true });
    await field.fill('排队指令甲');
    await field.press('Enter');
    await field.fill('排队指令乙');
    await field.press('Enter');
    await page.getByRole('button', { name: '原生终端', exact: true }).click();
    const separator = page.getByRole('separator', { name: '拖拽调整终端高度' });
    await separator.press('End');
    await field.fill(Array.from({ length: 12 }, (_, i) => `长输入 ${i + 1}`).join('\n'));
    await page.getByText('排队中 · 2 条', { exact: true }).click();
    const send = page.getByRole('button', { name: '排队发送', exact: true });
    expect(await send.evaluate(button => { const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return button === hit || button.contains(hit); })).toBe(true);
    await page.getByRole('button', { name: '移出队列 1', exact: true }).click();
    await send.click({ trial: true });
    await page.getByRole('button', { name: '停止', exact: true }).click({ trial: true });
    expect(await field.inputValue()).toContain('长输入 12');
    expect(errors).toEqual([]);
  }, 20000);

  it('新终端弹层优先持有键盘，全局搜索不会在背后打开或抢焦点', async () => {
    await page.goto(baseURL);
    await draftField().waitFor();
    await page.getByRole('button', { name: '原生终端', exact: true }).click();
    const form = page.getByRole('dialog', { name: '新终端', exact: true });
    await form.waitFor();
    const cwd = form.getByLabel('工作目录', { exact: true });
    await cwd.focus();
    await page.keyboard.press('Meta+f');
    expect(await page.getByRole('dialog', { name: '搜索消息', exact: true }).count()).toBe(0);
    expect(await cwd.evaluate(el => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    await form.waitFor({ state: 'hidden' });
    expect(errors).toEqual([]);
  }, 20000);

  it('折叠侧栏的文件和会话入口自动展开内容，不产生空操作或新对话', async () => {
    await page.goto(baseURL);
    await draftField().waitFor();
    await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
    await page.getByRole('button', { name: '文件', exact: true }).click();
    await page.getByRole('button', { name: '折叠侧栏', exact: true }).waitFor();
    expect(await page.locator('#sidebar-content').isVisible()).toBe(true);
    await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
    await page.getByRole('button', { name: '会话', exact: true }).click();
    expect(await page.locator('#sidebar-content').isVisible()).toBe(true);
    expect(await draftField().inputValue()).toBe('甲原草稿');
    expect(errors).toEqual([]);
  }, 20000);

  it('发送缺少会话工作目录时显示错误并保留文本，不借用全局目录', async () => {
    disk.conversations[0].cwd = '';
    await page.goto(baseURL);
    await draftField().fill('没有目录时不能丢弃', { timeout: 3000 });
    await draftField().press('Enter');
    await page.getByRole('alert').filter({ hasText: '当前对话未设置工作目录' }).waitFor();
    expect(await draftField().inputValue()).toBe('没有目录时不能丢弃');
    expect(errors).toEqual([]);
  }, 20000);
});
