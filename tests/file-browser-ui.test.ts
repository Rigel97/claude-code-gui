import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from 'vitest';
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
let mode: string;
let failure: boolean;
let changed: boolean;
const calls: { method: string; path: string; options: any }[] = [];
const errors: string[] = [];
beforeAll(async () => {
  server = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{ name: 'file-browser-fixture', configureServer(vite) {
  vite.middlewares.use('/__file_test', async (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(await server.transformIndexHtml('/__file_test', `<html><body><div id="root"></div><script type="module">
      import React from '/@fs/${root}/node_modules/.vite/deps/react.js';
      import {createRoot} from '/@fs/${root}/node_modules/.vite/deps/react-dom_client.js';
      import {FileTree} from '/components/FileTree.tsx';
      import {FilePreview} from '/components/FilePreview.tsx';
      const query = new URLSearchParams(location.search);
      createRoot(document.getElementById('root')).render(query.has('preview') ? React.createElement(FilePreview,{path:query.get('preview'),onClose:()=>{}}) : React.createElement(FileTree,{root:'/fixture'}));
      </script></body></html>`));
  });
  } }] });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('Missing fixture port');
  url = `http://127.0.0.1:${addr.port}/__file_test`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
}, 60000);
beforeEach(async () => {
  mode = 'paged'; failure = false; changed = false; calls.length = 0; errors.length = 0;
  context = await browser.newContext();
  await context.exposeBinding('__fileRPC', async (_source, method: string, filePath: string, options: any = {}) => {
    calls.push({ method, path: filePath, options });
    if (method === 'openExternal') return { ok: false, error: '外部应用拒绝打开' };
    if (method === 'readDir') {
      if (failure) throw new Error('目录读取失败');
      const offset = options.offset || 0;
      if (mode === 'legacy') return [{ name: 'legacy.txt', path: '/fixture/legacy.txt', isDir: false }];
      const all = Array.from({ length: filePath === '/fixture' ? 505 : 3 }, (_, i) => ({ name: `entry-${String(i).padStart(3, '0')}`, path: `${filePath}/entry-${i}`, isDir: filePath === '/fixture' }));
      if (options.showHidden) all.push({ name: '.secret', path: `${filePath}/.secret`, isDir: false });
      if (options.showIgnored) all.push({ name: 'node_modules', path: `${filePath}/node_modules`, isDir: true });
      return { items: all.slice(offset, offset + 200), offset, total: all.length, nextOffset: offset + 200 < all.length ? offset + 200 : null };
    }
    if (mode === 'throw') throw new Error('预览读取异常');
    if (mode === 'oversize') return { ok: true, kind: 'text', content: 'a'.repeat(524289), size: 524289, offset: 0, nextOffset: null };
    if (mode === 'large') return { ok: true, kind: 'text', content: 'a'.repeat(524288), size: 524300, offset: 0, nextOffset: 524288 };
    if (failure) return { ok: false, error: '偏移超出文件范围' };
    if (mode === 'binary') return { ok: false, kind: 'binary', error: '二进制文件，请在外部打开' };
    if (mode === 'image') return { ok: false, kind: 'image', error: '图片超过 8MB，请在外部打开' };
    if (mode === 'legacy') return { ok: true, kind: 'text', content: '旧预览', size: 999999, truncated: true };
    const offset = options.offset || 0;
    return { ok: true, kind: 'text', content: offset === 0 ? '第一页中文😀' : '末页内容🚀', size: 100, offset, nextOffset: offset === 0 ? 50 : null, truncated: true, version: changed ? 'changed' : 'original' };
  });
  await context.addInitScript(() => {
    (window as any).api = { fs: Object.fromEntries(['readDir', 'readFile', 'openExternal'].map(method => [method, (...args: unknown[]) => (window as any).__fileRPC(method, ...args)])) };
  });
  page = await context.newPage();
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', e => errors.push(e.message));
});
afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') console.error('File browser UI failure:', errors, calls, await page.locator('body').innerText().catch(() => 'Unavailable'));
  await context?.close();
});
afterAll(async () => { await browser?.close(); await server?.close(); }, 60000);

it('目录 500+分页、懒展开、加载失败不丢已加载且可重试', async () => {
  await page.goto(url);
  await page.getByRole('button', { name: 'entry-000', exact: true }).waitFor();
  expect(calls.filter(c => c.method === 'readDir')).toHaveLength(1);
  failure = true;
  await page.getByRole('button', { name: /加载更多/ }).click();
  await page.getByRole('alert').waitFor();
  expect(await page.getByRole('button', { name: 'entry-000', exact: true }).count()).toBe(1);
  failure = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('button', { name: 'entry-399', exact: true }).waitFor();
  await page.getByRole('button', { name: /加载更多/ }).click();
  await page.getByRole('button', { name: 'entry-504', exact: true }).waitFor();
  await page.getByRole('button', { name: 'entry-000', exact: true }).click();
  await expect.poll(() => calls.some(c => c.path === '/fixture/entry-0')).toBe(true);
  expect(errors).toEqual([]);
});

it('过滤切换与旧数组 bridge兼容，初次错误可以重试', async () => {
  failure = true;
  await page.goto(url);
  await page.getByRole('alert').waitFor();
  failure = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByLabel('显示隐藏文件').check();
  await page.getByLabel('显示忽略目录').check();
  await expect.poll(() => calls.at(-1)?.options).toMatchObject({ showHidden: true, showIgnored: true });
  mode = 'legacy';
  await page.reload();
  await page.getByRole('button', { name: 'legacy.txt', exact: true }).waitFor();
  expect(errors).toEqual([]);
});

it('预览上一页下一页重新读取，末页仍注明分页而非全部文本，外部打开错误可见', async () => {
  await page.goto(`${url}?preview=/fixture/large.txt`);
  await page.getByText('第一页中文😀', { exact: true }).waitFor();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText('末页内容🚀', { exact: true }).waitFor();
  expect(await page.getByText('第一页中文😀', { exact: true }).count()).toBe(0);
  expect(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled()).toBe(true);
  expect(await page.locator('body').innerText()).toContain('字节');
  expect(await page.locator('body').innerText()).not.toContain('全部文本');
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.getByText('第一页中文😀', { exact: true }).waitFor();
  expect(calls.filter(c => c.method === 'readFile').map(c => c.options.offset)).toEqual([0, 50, 0]);
  await page.getByRole('button', { name: '在外部打开', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '外部应用拒绝打开' }).waitFor();
  expect(errors).toEqual([]);
});

it('偏移错误保留旧页、重试及回到首页，文件变化拒绝混用旧分页', async () => {
  await page.goto(`${url}?preview=/fixture/large.txt`);
  await page.getByText('第一页中文😀', { exact: true }).waitFor();
  failure = true;
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '偏移超出' }).waitFor();
  expect(await page.getByText('第一页中文😀', { exact: true }).count()).toBe(1);
  failure = false; changed = true;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '文件已变化' }).waitFor();
  expect(await page.getByText('末页内容🚀', { exact: true }).count()).toBe(0);
  await page.getByRole('alert').getByRole('button', { name: '回到首页', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  expect(errors).toEqual([]);
});

it('binary/超限图片提示外部打开，旧截断 bridge 不假装支持下一页', async () => {
  for (const scenario of ['binary', 'image', 'legacy']) {
    mode = scenario;
    await page.goto(`${url}?preview=/fixture/sample.txt`);
    await page.getByRole('button', { name: '在外部打开', exact: true }).waitFor();
    if (scenario === 'legacy') {
      await page.getByText('旧预览', { exact: true }).waitFor();
      expect(await page.getByRole('button', { name: '下一页', exact: true }).count()).toBe(0);
      expect(await page.locator('body').innerText()).toContain('当前连接不支持分页');
    } else await page.getByText(/请在外部打开/).waitFor();
  }
  expect(errors).toEqual([]);
});

it('初次预览异常与超限返回不留下永久 loading，大页只渲染当前页纯文本', async () => {
  for (const scenario of ['throw', 'oversize']) {
    mode = scenario;
    await page.goto(`${url}?preview=/fixture/sample.txt`);
    await page.getByRole('alert').waitFor();
    expect(await page.locator('.animate-spin').count()).toBe(0);
    mode = 'paged';
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('第一页中文😀', { exact: true }).waitFor();
  }
  mode = 'large';
  await page.goto(`${url}?preview=/fixture/large.ts`);
  await page.getByRole('button', { name: '下一页', exact: true }).waitFor();
  expect(await page.locator('pre').innerText()).toHaveLength(524288);
  expect(await page.locator('pre span').count()).toBe(0);
  expect(errors).toEqual([]);
});

it('外部打开阻止远程 URL 和可执行路径', async () => {
  for (const file of ['https://example.com/large.txt', '/fixture/untrusted.exe', '/fixture/script.sh']) {
    await page.goto(`${url}?preview=${encodeURIComponent(file)}`);
    await page.getByText('第一页中文😀', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: '在外部打开', exact: true }).isDisabled()).toBe(true);
  }
  expect(calls.some(c => c.method === 'openExternal')).toBe(false);
  expect(errors).toEqual([]);
});
