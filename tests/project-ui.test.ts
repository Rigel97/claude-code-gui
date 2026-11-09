import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManagedProject } from '../src/renderer/projectTypes';

/** Real scanner + atomic backend persistence + browser UI, isolated from the user's history.
 * RUN_PROJECT_UI=1 npm test -- tests/project-ui.test.ts
 * Uses installed Chrome on macOS, or Playwright Chromium / PROJECT_UI_CHROMIUM_PATH elsewhere.
 * No Claude API calls or edits to real userData are performed.
 */
const RUN_UI = process.env.RUN_PROJECT_UI === '1';
const require = createRequire(import.meta.url);
const { ProjectsBackend } = require('../src/main/projects.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let directory: string;
let backend: InstanceType<typeof ProjectsBackend>;
let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let baseURL: string;
let outputPath: string;
let uiFailWrite = false;
let uiFailLifecycle = false;
let llmCalls = 0;
let llmFailure = false;
let llmWaiting = false;
let llmFieldReview = false;
const sendCalls: unknown[][] = [];
let configFixture: Record<string, unknown> | null = null;
const modelFixture = async (request: any) => {
  llmCalls++;
  if (llmFailure) throw new Error('LLM fixture: invalid structured response');
  if (llmWaiting) await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('LLM fixture: aborted')), { once: true }));
  const { messages } = JSON.parse(request.prompt);
  const user = messages.find((message: any) => message.role === 'user' && message.text.includes('构建一个会员管理平台'));
  const creates = messages.flatMap((message: any) => message.tools.filter((tool: any) => tool.name === 'TaskCreate').map((tool: any) => ({ message, tool })));
  const refs = (sourceId: string, quote: string) => ({ sourceId, quote });
  return { value: { projects: [{ name: '会员管理平台', goal: '构建一个会员管理平台', summary: '按接口、列表、详情与验收推进',
    background: '整理会员档案与生命周期', constraints: '保留现有账户数据', deliverables: '会员列表与详情页面',
    ...(llmFieldReview ? { constraints: '模型解释：账户数据需离线迁移', decisions: '虚构：已经批准云端方案', deliverables: '模型解释：需额外交付迁移报告' } : {}),
    fieldEvidence: {
      background: { kind: 'quoted', refs: [refs(user.sourceId, '项目背景：整理会员档案与生命周期')] },
      constraints: { kind: 'quoted', refs: [refs(user.sourceId, '约束条件：保留现有账户数据')] },
      deliverables: { kind: 'quoted', refs: [refs(user.sourceId, '预期交付物：会员列表与详情页面')] },
      ...(llmFieldReview ? {
        constraints: { kind: 'model', refs: [refs(user.sourceId, '约束条件：保留现有账户数据')] },
        decisions: { kind: 'model', refs: [] },
        deliverables: { kind: 'model', refs: [refs(user.sourceId, '预期交付物：会员列表与详情页面')] },
      } : {}),
    },
    evidence: [refs(user.sourceId, '任务：构建一个会员管理平台')], criteria: { longTerm: true, shortQA: false, reasons: ['四个阶段与明确交付物'] },
    tasks: creates.map(({ message, tool }: any) => ({ id: tool.createdTaskId, name: tool.input.subject, description: tool.input.description,
      sourceRefs: [refs(message.sourceId, tool.input.subject)] })),
  }] }, costUsd: 0.02 };
};
const errors: string[] = [];
const names = ['接口阶段', '列表阶段', '详情阶段', '验收阶段'];
const projects = async (): Promise<ManagedProject[]> => backend.list();

async function clickButton(name: string) {
  await page.getByRole('button', { name, exact: true }).click();
}
async function openProject() {
  await page.getByRole('button', { name: '会员长期项目', exact: false }).click();
}
async function currentTask(name = names[0]) {
  return (await projects())[0].tasks.find(task => task.name === name)!;
}

async function freshCase(code: string, withHistory = false) {
  uiFailWrite = false; uiFailLifecycle = false; llmFailure = false; llmWaiting = false; llmFieldReview = false;
  const home = path.join(directory, code);
  await fs.promises.mkdir(home, { recursive: true });
  backend = new ProjectsBackend({ home: withHistory ? directory : home, userData: path.join(home, 'userData'), env: {}, analyzer: modelFixture });
  configFixture = { cwd: path.join(directory, 'global-default'), sessions: [], conversations: [] };
  sendCalls.length = 0;
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.reload();
  await page.getByRole('button', { name: /^项目管理中心/ }).click();
  await page.getByRole('button', { name: '新建项目', exact: true }).waitFor();
  await expect.poll(() => page.getByRole('button', { name: '新建项目', exact: true }).isEnabled()).toBe(true);
}

// Kept opt-in because it requires a local browser, unlike the pure Vitest suite.
describe.skipIf(!RUN_UI)('项目中心真实扫描与浏览器端到端', () => {
  beforeAll(async () => {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-ui-'));
    const workspace = path.join(directory, 'workspace');
    const history = path.join(directory, '.claude', 'projects', 'fixture');
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.mkdir(history, { recursive: true });
    outputPath = path.join(workspace, 'members.ts');
    await fs.promises.writeFile(outputPath, 'export const members = [];\n');
    let sequence = 0;
    const row = (type: string, content: unknown) => ({ type, sessionId: 'ui-fixture', cwd: workspace,
      uuid: `row-${++sequence}`, timestamp: new Date(1760000000000 + sequence * 1000).toISOString(),
      message: { role: type, content } });
    const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
    const result = (id: string, content = '成功') => ({ type: 'tool_result', tool_use_id: id, content });
    const rows = [row('user', '任务：构建一个会员管理平台\n项目背景：整理会员档案与生命周期\n约束条件：保留现有账户数据\n预期交付物：会员列表与详情页面')];
    for (let i = 0; i < names.length; i++) {
      rows.push(row('assistant', [use(`create-${i}`, 'TaskCreate', { subject: names[i], description: `${names[i]}的真实测试任务` })]));
      rows.push(row('user', [result(`create-${i}`, `Task #${i + 1} created successfully: ${names[i]}`)]));
    }
    for (const [id, blocked] of [['2', ['1']], ['3', ['1']], ['4', ['2', '3']]] as const) {
      rows.push(row('assistant', [use(`dep-${id}`, 'TaskUpdate', { taskId: id, addBlockedBy: blocked })]));
      rows.push(row('user', [result(`dep-${id}`)]));
    }
    rows.push(row('assistant', [use('start-1', 'TaskUpdate', { taskId: '1', status: 'in_progress' })]));
    rows.push(row('user', [result('start-1')]));
    rows.push(row('assistant', [use('write-1', 'Write', { file_path: outputPath, content: 'export const members = [];\n' })]));
    rows.push(row('user', [result('write-1', 'File created successfully')]));
    // A separate short query with multiple answer bullets must not become a second project.
    rows.push(row('user', '什么是 HTTP？\n1. 解释请求\n2. 解释响应'));
    await fs.promises.writeFile(path.join(history, 'ui-fixture.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    backend = new ProjectsBackend({ home: directory, userData: path.join(directory, 'userData'), env: {}, revealFile: () => {}, analyzer: modelFixture });
    server = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Vite test server did not provide a port');
    baseURL = `http://127.0.0.1:${address.port}`;
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, executablePath: process.env.PROJECT_UI_CHROMIUM_PATH || (fs.existsSync(systemChrome) ? systemChrome : undefined) });
    context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.exposeBinding('__projectTestRPC', async (_source, method: string, args: unknown[]) => {
      if (method === 'preview') {
        try { return { ok: true, kind: 'text', content: await fs.promises.readFile(String(args[0]), 'utf8') }; }
        catch (error) { return { ok: false, error: (error as Error).message }; }
      }
      if (method === 'configGet') return configFixture;
      if (method === 'configSet') { configFixture = args[1] as Record<string, unknown>; return; }
      if (method === 'send') { sendCalls.push(args); return { ok: true }; }
      if (['update', 'patch'].includes(method) && uiFailWrite) throw new Error('UI failure fixture: simulated disk permission failure');
      if (['archive', 'remove', 'merge'].includes(method) && uiFailLifecycle) throw new Error('UI failure fixture: simulated lifecycle write failure');
      if (!['list', 'prepare', 'scan', 'cancelScan', 'confirm', 'update', 'reveal', 'patch', 'create', 'archive', 'remove', 'merge', 'reload', 'storageInfo', 'purge', 'restoreBackup', 'reviewDraft', 'saveReviewDraft', 'activeJob', 'linkConversation', 'recordConversation'].includes(method)) throw new Error(`Unexpected test RPC: ${method}`);
      if (method === 'scan' || method === 'prepare') return backend[method](args[0], (progress: unknown) => {
        void _source.page.evaluate((detail: unknown) => window.dispatchEvent(new CustomEvent('project-test-progress', { detail })), progress).catch(() => {});
      });
      return backend[method](...args);
    });
    await context.addInitScript(() => {
      const rpc = (method: string, ...args: unknown[]) => (window as any).__projectTestRPC(method, args);
      // Only the pre-existing chat shell is stubbed. Project operations call the real backend.
      (window as any).api = {
        store: { get: () => rpc('configGet'), set: (...args: unknown[]) => rpc('configSet', ...args), flush: async () => {}, reload: () => rpc('configGet') },
        claude: {
          send: (...args: unknown[]) => rpc('send', ...args), abort: async () => {}, getContext: async () => null,
          onStream: (callback: (data: unknown) => void) => {
            const listener = (event: Event) => callback((event as CustomEvent).detail);
            window.addEventListener('project-test-stream', listener);
            return () => window.removeEventListener('project-test-stream', listener);
          },
          onStatusChange: (callback: (data: unknown) => void) => {
            const listener = (event: Event) => callback((event as CustomEvent).detail);
            window.addEventListener('project-test-status', listener);
            return () => window.removeEventListener('project-test-status', listener);
          },
        },
        openDirectory: async () => null, notify: () => {},
        window: { minimize: () => {}, maximize: () => {}, close: () => {} },
        projects: {
          list: () => rpc('list'), prepare: (data: unknown) => rpc('prepare', data), scan: (data: unknown) => rpc('scan', data),
          cancelScan: (id: string) => rpc('cancelScan', id),
          onScanProgress: (callback: (progress: unknown) => void) => {
            const listener = (event: Event) => callback((event as CustomEvent).detail);
            window.addEventListener('project-test-progress', listener);
            return () => window.removeEventListener('project-test-progress', listener);
          },
          confirm: (id: string, reviews: unknown) => rpc('confirm', id, reviews),
          update: (project: unknown) => rpc('update', project), reveal: (file: string) => rpc('reveal', file),
          ...Object.fromEntries(['patch', 'create', 'archive', 'remove', 'merge', 'reload', 'storageInfo', 'purge', 'restoreBackup', 'reviewDraft', 'saveReviewDraft', 'activeJob', 'linkConversation', 'recordConversation']
            .map(method => [method, (...args: unknown[]) => rpc(method, ...args)])),
        },
        fs: { readFile: (file: string) => rpc('preview', file) },
      };
    });
    page = await context.newPage();
    page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL);
    await page.getByRole('button', { name: '项目管理中心', exact: false }).click();
    await page.getByRole('combobox', { name: '项目识别方式' }).selectOption('rules');
  }, 60000);

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) {
      console.error('UI page errors:', errors);
      console.error('UI failure state:', await page.locator('body').innerText({ timeout: 3000 }));
      console.error('UI fields:', await page.locator('textarea').evaluateAll(fields => fields.map(field => ({ id: field.id, labels: [...(field as HTMLTextAreaElement).labels].map(label => label.textContent) }))));
      // A failed review must not lock recognition in every subsequent baseline case.
      await backend.saveReviewDraft(null);
      uiFailWrite = false; uiFailLifecycle = false; llmFailure = false; llmWaiting = false;
    }
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await server?.close();
    if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
  }, 60000);

  it('真实历史识别→审核取消/修改确认→进度与流程同步→重启恢复', async () => {
    await clickButton('识别项目');
    const review = page.getByRole('dialog', { name: '审核识别结果' });
    await review.waitFor();
    expect(await review.getByText(/1 个候选/).count()).toBe(1);
    expect(await review.getByRole('checkbox', { name: /选择项目/ }).isChecked()).toBe(false);
    expect(await review.getByRole('button', { name: '确认创建 / 关联' }).isEnabled()).toBe(false);
    await review.getByRole('button', { name: /^编辑/ }).click();
    const nameField = review.getByRole('textbox', { name: /项目名称/ });
    await nameField.fill('会员长期项目');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    await page.getByPlaceholder('搜索所有会话的消息内容…').waitFor();
    await page.keyboard.press('Escape');
    expect(await review.isVisible()).toBe(true);
    expect(await nameField.inputValue()).toBe('会员长期项目');
    page.once('dialog', dialog => void dialog.accept());
    await review.getByRole('button', { name: '取消，不创建', exact: true }).click();
    expect(await projects()).toEqual([]);
    expect(fs.existsSync(backend.filePath)).toBe(false);

    await clickButton('识别项目');
    await review.waitFor();
    await review.getByRole('button', { name: /^编辑/ }).click();
    await nameField.fill('会员长期项目');
    await review.getByRole('checkbox', { name: /选择项目/ }).check();
    await review.getByRole('button', { name: /详情/ }).click();
    expect(await review.getByText('接口阶段', { exact: true }).count()).toBe(1);
    await review.getByRole('button', { name: /^Claude Code/ }).first().click();
    await page.getByRole('dialog', { name: '历史来源详情' }).waitFor();
    await page.keyboard.press('Escape');
    expect(await review.isVisible()).toBe(true);
    expect(await nameField.inputValue()).toBe('会员长期项目');
    await review.getByRole('button', { name: '确认创建 / 关联' }).click();
    await review.waitFor({ state: 'hidden' });
    expect(await projects()).toHaveLength(1);
    await openProject();
    expect(await page.getByText('整理会员档案与生命周期', { exact: true }).count()).toBe(1);
    await clickButton('预览');
    await page.locator('[data-file-preview]').waitFor();
    await expect.poll(async () => await page.locator('[data-file-preview]').textContent()).toContain('export const members');
    await page.keyboard.press('Escape');
    await page.locator('[data-file-preview]').waitFor({ state: 'hidden' });

    await clickButton('任务列表');
    // Editing an old draft must not roll back a status changed in the list meanwhile.
    await page.getByRole('button', { name: /^接口阶段/ }).click();
    const panel = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: '接口阶段', exact: true }) });
    await panel.getByRole('button', { name: '编辑任务' }).click();
    await panel.getByRole('textbox', { name: /^说明/ }).fill('经过用户确认的接口说明');
    await page.getByRole('combobox', { name: '任务状态 接口阶段', exact: true }).selectOption('completed');
    await expect.poll(async () => (await currentTask()).status).toBe('completed');
    await panel.getByRole('button', { name: '保存更改' }).click();
    await expect.poll(async () => (await currentTask()).description).toBe('经过用户确认的接口说明');
    expect((await currentTask()).status).toBe('completed');
    await panel.getByRole('button', { name: '关闭任务详情' }).click();
    for (const name of names.slice(1)) {
      await page.getByRole('combobox', { name: `任务状态 ${name}`, exact: true }).selectOption('completed');
      await expect.poll(async () => (await currentTask(name)).status).toBe('completed');
    }
    const acceptance = page.getByRole('checkbox', { name: /我已核对交付物/ });
    expect(await acceptance.isChecked()).toBe(false);
    // Controlled status is committed only after asynchronous atomic persistence succeeds.
    await acceptance.click();
    await expect.poll(async () => (await projects())[0].goalConfirmed).toBe(true);
    await expect.poll(() => acceptance.isChecked()).toBe(true);
    await clickButton('工作流');
    const canvas = page.getByRole('region', { name: '可滚动工作流画布' });
    await canvas.waitFor();
    expect(await canvas.locator('svg > path[marker-end]').count()).toBe(4);
    expect(await canvas.getByRole('button').count()).toBe(4);
    await canvas.getByRole('button', { name: /^接口阶段/ }).click();
    await panel.getByRole('button', { name: '进行中', exact: true }).click();
    await expect.poll(async () => (await currentTask()).status).toBe('in_progress');
    expect((await projects())[0].goalConfirmed).toBe(false);
    expect(await acceptance.isChecked()).toBe(false);
    expect(await canvas.getByRole('button', { name: /^接口阶段，进行中/ }).count()).toBe(1);
    await panel.getByRole('button', { name: '关闭任务详情' }).click();

    await clickButton('项目总览');
    await clickButton('识别项目');
    await review.waitFor();
    const mode = review.getByRole('combobox', { name: /创建方式/ });
    expect(await mode.inputValue()).toBe((await projects())[0].id);
    await review.getByRole('checkbox', { name: /选择项目/ }).check();
    await review.getByRole('button', { name: '确认创建 / 关联' }).click();
    await review.waitFor({ state: 'hidden' });
    expect(await projects()).toHaveLength(1);
    expect((await currentTask()).description).toBe('经过用户确认的接口说明');
    expect((await currentTask()).status).toBe('in_progress');

    backend = new ProjectsBackend({ home: directory, userData: path.join(directory, 'userData'), env: {}, analyzer: modelFixture });
    await page.reload();
    await page.getByRole('button', { name: '项目管理中心', exact: false }).click();
    await page.getByRole('combobox', { name: '项目识别方式' }).selectOption('rules');
    await openProject();
    expect((await currentTask()).description).toBe('经过用户确认的接口说明');
    expect(JSON.parse(await fs.promises.readFile(backend.filePath, 'utf8')).version).toBe(1);
    await page.setViewportSize({ width: 900, height: 600 });
    await clickButton('工作流');
    await canvas.scrollIntoViewIfNeeded();
    const bounds = await canvas.boundingBox();
    expect(bounds && bounds.height).toBeGreaterThan(100);
    expect(bounds && bounds.y).toBeLessThan(600);
    expect(await canvas.getByRole('button').count()).toBeGreaterThan(0);
  }, 60000);

  it('保存失败保留草稿、循环依赖阻止保存、缺失文件明确反馈', async () => {
    // This test can run independently of the full lifecycle case above.
    if (!(await projects()).length) {
      const scanned = await backend.scan({ sessions: [], conversations: [] });
      const candidate = scanned.candidates[0];
      await backend.confirm(scanned.scanId, [{ candidateId: candidate.id, name: '会员长期项目', goal: candidate.goal, description: '' }]);
    }
    const saved = (await projects())[0];
    saved.tasks[0].description = '经过用户确认的接口说明';
    await backend.update(saved);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.reload();
    await page.getByRole('button', { name: '项目管理中心', exact: false }).click();
    await page.getByRole('combobox', { name: '项目识别方式' }).selectOption('rules');
    await openProject();
    await clickButton('任务列表');
    await page.getByRole('button', { name: /^接口阶段/ }).click();
    const panel = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: '接口阶段', exact: true }) });
    await panel.getByRole('button', { name: '编辑任务' }).click();
    await panel.getByRole('textbox', { name: /^说明/ }).fill('写失败时保留的草稿');
    uiFailWrite = true;
    await panel.getByRole('button', { name: '保存更改' }).click();
    await panel.getByRole('alert').waitFor();
    expect(await panel.getByRole('alert').textContent()).toContain('simulated disk permission failure');
    expect(await panel.getByRole('textbox', { name: /^说明/ }).inputValue()).toBe('写失败时保留的草稿');
    expect((await currentTask()).description).toBe('经过用户确认的接口说明');
    uiFailWrite = false;
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    await panel.getByRole('button', { name: '编辑任务' }).click();
    await panel.getByRole('checkbox', { name: '验收阶段', exact: true }).check();
    expect(await panel.getByRole('button', { name: '保存更改' }).isEnabled()).toBe(false);
    expect(await panel.getByText(/前置依赖形成循环/).count()).toBeGreaterThan(0);
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    await panel.getByRole('button', { name: '关闭任务详情' }).click();
    await clickButton('新增任务');
    await page.getByRole('textbox', { name: '新任务名称' }).fill('交付复核');
    await clickButton('添加');
    await expect.poll(async () => (await projects())[0].tasks.length).toBe(5);
    const manualPanel = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: '交付复核', exact: true }) });
    await manualPanel.getByRole('button', { name: '编辑任务' }).click();
    await manualPanel.getByRole('textbox', { name: /^输入/ }).fill('会员页面\n已保存的执行记录');
    await manualPanel.getByRole('textbox', { name: /^输出/ }).fill('复核报告（预期）');
    await manualPanel.getByRole('checkbox', { name: '验收阶段', exact: true }).check();
    await manualPanel.getByRole('textbox', { name: /^依赖说明/ }).fill('依据验收阶段交付物进行复核');
    await manualPanel.getByRole('checkbox', { name: /我已核实所选依赖/ }).check();
    await manualPanel.getByRole('button', { name: '保存更改' }).click();
    await expect.poll(async () => (await currentTask('交付复核')).outputs).toEqual(['复核报告（预期）']);
    const manual = await currentTask('交付复核');
    expect(manual.inputs).toEqual(['会员页面', '已保存的执行记录']);
    expect(manual.dependsOn).toEqual([(await currentTask('验收阶段')).id]);
    expect(manual.records).toEqual([]);
    expect(manual.dependencyNote).toContain('用户已确认');
    await manualPanel.getByRole('button', { name: '关闭任务详情' }).click();
    await clickButton('背景与文件');
    await fs.promises.unlink(outputPath);
    await clickButton('预览');
    await page.locator('[data-file-preview]').waitFor();
    await expect.poll(async () => await page.locator('[data-file-preview]').textContent()).toContain('ENOENT');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  }, 60000);

  it('重复打开、任务切换和取消离开都保留未保存草稿且没有导航副作用', async () => {
    if (!(await projects()).length) {
      const scanned = await backend.scan({ sessions: [], conversations: [] });
      await backend.confirm(scanned.scanId, [{ candidateId: scanned.candidates[0].id, name: '会员长期项目', goal: scanned.candidates[0].goal, description: '' }]);
    }
    await page.reload();
    await page.getByRole('button', { name: /^项目管理中心/ }).click();
    await openProject();
    await clickButton('编辑背景');
    const background = page.getByRole('textbox', { name: '需求背景', exact: true });
    await background.fill('未保存的背景草稿');
    await page.getByRole('button', { name: /^项目管理中心/ }).click();
    expect(await background.inputValue()).toBe('未保存的背景草稿');
    await clickButton('取消编辑');
    await clickButton('任务列表');
    await page.getByRole('button', { name: /^接口阶段/ }).click();
    const panel = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: '接口阶段', exact: true }) });
    await panel.getByRole('button', { name: '编辑任务' }).click();
    await panel.getByRole('textbox', { name: '说明', exact: true }).fill('切换前的任务草稿');
    page.once('dialog', dialog => void dialog.dismiss());
    await page.getByRole('button', { name: /^列表阶段/ }).click();
    expect(await panel.getByRole('textbox', { name: '说明', exact: true }).inputValue()).toBe('切换前的任务草稿');
    page.once('dialog', dialog => void dialog.dismiss());
    await panel.getByRole('textbox', { name: '说明', exact: true }).press('Escape');
    expect(await panel.getByRole('textbox', { name: '说明', exact: true }).inputValue()).toBe('切换前的任务草稿');
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    await panel.getByRole('button', { name: '关闭任务详情' }).click();
    await clickButton('项目总览');
  }, 60000);

  it('LLM 范围同意、预算、候选确认、失败不回退及取消识别', async () => {
    if (!(await projects()).length) {
      const scanned = await backend.scan({ sessions: [], conversations: [] });
      await backend.confirm(scanned.scanId, [{ candidateId: scanned.candidates[0].id, name: '会员长期项目', goal: scanned.candidates[0].goal, description: '' }]);
      const saved = (await projects())[0];
      saved.tasks[0].description = '经过用户确认的接口说明';
      await backend.update(saved);
    }
    await page.reload();
    await page.getByRole('button', { name: '项目管理中心', exact: false }).click();
    const mode = page.getByRole('combobox', { name: '项目识别方式' });
    await mode.selectOption('llm');
    await clickButton('识别项目');
    const consent = page.getByRole('dialog', { name: '确认 LLM 识别范围与费用' });
    await consent.waitFor();
    expect(llmCalls).toBe(0);
    expect(await consent.getByRole('button', { name: '同意并开始 LLM 识别' }).isEnabled()).toBe(false);
    await consent.getByRole('button', { name: '取消，不发送' }).click();
    expect(llmCalls).toBe(0);
    const before = await projects();
    await clickButton('识别项目');
    await consent.waitFor();
    await consent.getByRole('spinbutton', { name: '项目识别总预算' }).fill('0.25');
    await consent.getByRole('textbox', { name: '项目识别模型' }).fill('mock');
    await consent.getByRole('checkbox', { name: /我确认可以将上述历史摘录发送/ }).check();
    await consent.getByRole('button', { name: '同意并开始 LLM 识别' }).click();
    const review = page.getByRole('dialog', { name: '审核识别结果' });
    await review.waitFor();
    expect(llmCalls).toBe(1);
    expect(await review.getByText(/LLM 识别 · /).count()).toBe(1);
    expect(await projects()).toEqual(before);
    await review.getByRole('checkbox', { name: /选择项目/ }).check();
    await review.getByRole('button', { name: '确认创建 / 关联' }).click();
    await review.waitFor({ state: 'hidden' });
    expect(await projects()).toHaveLength(1);
    expect((await currentTask()).description).toBe('经过用户确认的接口说明');

    llmFailure = true;
    await clickButton('识别项目'); await consent.waitFor();
    await consent.getByRole('checkbox', { name: /我确认可以将上述历史摘录发送/ }).check();
    await consent.getByRole('button', { name: '同意并开始 LLM 识别' }).click();
    await expect.poll(async () => page.getByRole('alert').first().textContent()).toContain('不会自动回退');
    expect(llmCalls).toBe(2);
    expect(await review.count()).toBe(0);
    llmFailure = false; llmWaiting = true;
    await clickButton('识别项目'); await consent.waitFor();
    await consent.getByRole('checkbox', { name: /我确认可以将上述历史摘录发送/ }).check();
    await consent.getByRole('button', { name: '同意并开始 LLM 识别' }).click();
    await page.getByRole('button', { name: '取消识别' }).click();
    await expect.poll(async () => page.getByRole('status').first().textContent()).toContain('识别已取消');
    expect(await review.count()).toBe(0);
    expect(await projects()).toHaveLength(1);
    expect(errors).toEqual([]);
    llmWaiting = false;
  }, 60000);

  it('PROJECT_UI_CREATE：显式工作目录、无历史不警告、全部取消进度不适用', async () => {
    await freshCase('PROJECT_UI_CREATE');
    await clickButton('新建项目');
    const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
    const cwd = dialog.getByRole('textbox', { name: '新项目工作目录' });
    expect(await cwd.inputValue()).toBe('');
    await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('独立手动项目');
    await dialog.getByRole('textbox', { name: '项目目标', exact: true }).fill('完成已核实的交付');
    await cwd.fill(path.join(directory, 'workspace'));
    await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: '独立手动项目', exact: true }).waitFor();
    expect((await projects())[0].workingDirectory).toBe(path.join(directory, 'workspace'));
    expect((await projects())[0].sources).toEqual([]);
    expect(await page.getByRole('status').filter({ hasText: /无历史来源|待整理/ }).count()).toBe(0);
    expect(await page.getByText(/无必要任务 · 进度不适用/).count()).toBe(1);
    const acceptance = page.getByRole('checkbox', { name: /我已核对交付物/ });
    expect(await acceptance.isEnabled()).toBe(false);
    await clickButton('任务列表');
    await clickButton('新增任务');
    await page.getByRole('textbox', { name: '新任务名称' }).fill('不再执行的任务');
    await clickButton('添加');
    await expect.poll(async () => (await projects())[0].tasks.length).toBe(1);
    const panel = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: '不再执行的任务', exact: true }) });
    await panel.getByRole('button', { name: '关闭任务详情' }).click();
    await page.getByRole('combobox', { name: '任务状态 不再执行的任务', exact: true }).selectOption('cancelled');
    await expect.poll(async () => (await projects())[0].tasks[0].status).toBe('cancelled');
    expect(await page.getByText('无必要任务 · 进度不适用 · 1 已取消', { exact: true }).count()).toBe(1);
    expect(await acceptance.isEnabled()).toBe(false);
    expect((await projects())[0].goalConfirmed).toBe(false);
    expect(configFixture?.cwd).toBe(path.join(directory, 'global-default'));
    expect(sendCalls).toEqual([]);
  }, 60000);

  it('PROJECT_UI_LIFECYCLE：活跃、归档与回收站独立计数，只读及恢复', async () => {
    await freshCase('PROJECT_UI_LIFECYCLE');
    await backend.create({ name: '活跃计数项目', goal: '保留活跃工作' });
    await backend.create({ name: '归档计数项目', goal: '保存已归档档案' });
    await backend.create({ name: '删除计数项目', goal: '保留可恢复档案' });
    const records = await projects();
    const archived = records.find(item => item.name === '归档计数项目')!;
    const deleted = records.find(item => item.name === '删除计数项目')!;
    await backend.archive(archived.id, true);
    await backend.remove(deleted.id, true);
    await page.reload();
    await page.getByRole('button', { name: /^项目管理中心/ }).click();
    await page.getByRole('button', { name: '活跃项目 1', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: '归档 1', exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: '回收站 1', exact: true }).count()).toBe(1);
    const counts = page.getByRole('group', { name: '项目状态筛选' });
    expect(await counts.getByRole('button', { name: '活跃全部项目 1', exact: true }).count()).toBe(1);
    expect(await page.getByRole('heading', { name: '活跃计数项目', exact: true }).count()).toBe(1);
    expect(await page.getByRole('heading', { name: '归档计数项目', exact: true }).count()).toBe(0);
    await clickButton('归档 1');
    expect(await counts.getByRole('button', { name: '归档全部项目 1', exact: true }).count()).toBe(1);
    await page.getByRole('button').filter({ has: page.getByRole('heading', { name: '归档计数项目', exact: true }) }).click();
    expect(await page.getByText('只读，恢复后可编辑', { exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: '编辑背景', exact: true }).isEnabled()).toBe(false);
    expect(await page.getByRole('button', { name: '继续项目', exact: true }).isEnabled()).toBe(false);
    await page.getByText('更多', { exact: true }).click();
    await clickButton('恢复归档');
    await expect.poll(async () => (await projects()).find(item => item.id === archived.id)?.archivedAt).toBeUndefined();
    await expect.poll(() => page.getByRole('button', { name: '编辑背景', exact: true }).isEnabled()).toBe(true);
    await clickButton('项目总览');
    await clickButton('回收站 1');
    expect(await counts.getByRole('button', { name: '回收站全部项目 1', exact: true }).count()).toBe(1);
    await page.getByRole('button').filter({ has: page.getByRole('heading', { name: '删除计数项目', exact: true }) }).click();
    expect(await page.getByRole('button', { name: '编辑背景', exact: true }).isEnabled()).toBe(false);
    expect(await page.getByRole('checkbox', { name: /我已核对交付物/ }).isEnabled()).toBe(false);
    await clickButton('任务列表');
    expect(await page.getByRole('button', { name: '新增任务', exact: true }).isEnabled()).toBe(false);
    await page.getByText('更多', { exact: true }).click();
    await clickButton('恢复');
    await expect.poll(async () => (await projects()).find(item => item.id === deleted.id)?.deletedAt).toBeUndefined();
    await clickButton('项目总览');
    await clickButton('活跃项目 3');
    expect(await counts.getByRole('button', { name: '活跃全部项目 3', exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: '归档 0', exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: '回收站 0', exact: true }).count()).toBe(1);
    expect(await projects()).toHaveLength(3);
  }, 60000);

  it('PROJECT_UI_CONVERSATION：新会话仅生成草稿、关联幂等，扫描中端到端完成记录不验收', async () => {
    await freshCase('PROJECT_UI_CONVERSATION', true);
    await backend.create({ name: '会话进展项目', goal: '核对实际执行进展', workingDirectory: path.join(directory, 'workspace') });
    const saved = (await projects())[0];
    await backend.patch({ id: saved.id, expectedRevision: saved.revision, changes: { tasks: [{
      id: 'manual:conversation-task', name: '待核实任务', description: '不能以模型结束代替验收', status: 'pending',
      inputs: [], outputs: [], dependsOn: [], dependencyNote: '', sourceIds: [], records: [],
    }] } });
    await page.reload();
    await page.getByRole('button', { name: /^项目管理中心/ }).click();
    await page.getByRole('button').filter({ has: page.getByRole('heading', { name: '会话进展项目', exact: true }) }).click();
    await clickButton('继续项目');
    const draft = page.getByPlaceholder('输入指令，/ 唤起快捷命令，Enter 发送');
    await draft.waitFor();
    expect(await draft.inputValue()).toContain('# 继续项目：会话进展项目');
    expect(await draft.inputValue()).toContain('待核实任务');
    expect(sendCalls).toEqual([]);
    await expect.poll(async () => (await projects())[0].conversations?.length).toBe(1);
    const conversationId = (await projects())[0].conversations![0].conversationId;
    expect((await projects())[0].conversations![0].cwd).toBe(path.join(directory, 'workspace'));
    await page.getByRole('button', { name: /^项目管理中心/ }).click();
    await clickButton('关联当前对话');
    await expect.poll(async () => (await projects())[0].conversations?.length).toBe(1);
    await clickButton('关联当前对话');
    expect((await projects())[0].conversations).toHaveLength(1);
    await expect.poll(() => page.getByRole('button', { name: '编辑背景', exact: true }).isEnabled()).toBe(true);
    await page.getByRole('combobox', { name: '项目识别方式' }).selectOption('llm');
    await clickButton('识别项目');
    const consent = page.getByRole('dialog', { name: '确认 LLM 识别范围与费用' });
    await consent.waitFor();
    llmWaiting = true;
    await consent.getByRole('checkbox', { name: /我确认可以将上述历史摘录发送/ }).check();
    await consent.getByRole('button', { name: '同意并开始 LLM 识别' }).click();
    await expect.poll(() => page.getByRole('status').filter({ hasText: /等待模型|模型处理/ }).count()).toBeGreaterThan(0);
    await clickButton('编辑背景');
    await page.getByRole('textbox', { name: '需求背景', exact: true }).fill('扫描进行时仍可保存背景');
    await clickButton('保存背景');
    await expect.poll(async () => (await projects())[0].background).toBe('扫描进行时仍可保存背景');
    expect(await page.getByRole('button', { name: '取消识别', exact: true }).isEnabled()).toBe(true);
    await page.evaluate(({ conversationId }) => {
      window.dispatchEvent(new CustomEvent('project-test-stream', { detail: { conversationId, type: 'assistant', message: {
        id: 'project-ui-completion', role: 'assistant', content: [{ type: 'text', text: '已生成执行摘录，仍需人工核实' }],
      } } }));
      window.dispatchEvent(new CustomEvent('project-test-stream', { detail: {
        conversationId, type: 'result', subtype: 'success', is_error: false, duration_ms: 120, duration_api_ms: 100,
        num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 12 }, result: '已生成执行摘录，仍需人工核实',
      } }));
      window.dispatchEvent(new CustomEvent('project-test-status', { detail: { conversationId, status: 'completed' } }));
    }, { conversationId });
    await expect.poll(async () => (await projects())[0].conversations![0].lastRun?.excerpt).toContain('仍需人工核实');
    const recorded = (await projects())[0];
    expect(recorded.conversations![0].lastRun?.status).toBe('completed');
    expect(recorded.conversations![0].lastRun?.verified).toBe(false);
    expect(recorded.tasks[0].status).toBe('pending');
    expect(recorded.goalConfirmed).toBe(false);
    expect(await page.getByText('待核对进展', { exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: '取消识别', exact: true }).isEnabled()).toBe(true);
    await clickButton('取消识别');
    await expect.poll(() => page.getByRole('status').filter({ hasText: '识别已取消' }).count()).toBeGreaterThan(0);
    llmWaiting = false;
    await clickButton('标记进展已核对');
    await expect.poll(async () => (await projects())[0].conversations![0].reviewedAt).toBeGreaterThan(0);
    expect((await projects())[0].tasks[0].status).toBe('pending');
    expect((await projects())[0].goalConfirmed).toBe(false);
    await expect.poll(() => page.getByRole('button', { name: '继续最近对话', exact: true }).isEnabled()).toBe(true);
    await clickButton('继续最近对话');
    await draft.waitFor({ timeout: 5000 });
    expect(await draft.inputValue()).toContain('# 继续项目：会话进展项目');
    expect((await projects())[0].conversations).toHaveLength(1);
    await expect.poll(() => configFixture?.cwd).toBe(path.join(directory, 'global-default'));
    expect(sendCalls).toEqual([]);
  }, 60000);

  it('PROJECT_UI_REVIEW：逐字段证据审核、清空虚构字段，稍后与 Escape 草稿重启恢复不重复收费', async () => {
    await freshCase('PROJECT_UI_REVIEW', true);
    llmFieldReview = true;
    const callsBefore = llmCalls;
    await page.getByRole('combobox', { name: '项目识别方式' }).selectOption('llm');
    await clickButton('识别项目');
    const consent = page.getByRole('dialog', { name: '确认 LLM 识别范围与费用' });
    await consent.waitFor();
    await consent.getByRole('checkbox', { name: /我确认可以将上述历史摘录发送/ }).check();
    await consent.getByRole('button', { name: '同意并开始 LLM 识别' }).click();
    const review = page.getByRole('dialog', { name: '审核识别结果' });
    await review.waitFor();
    expect(llmCalls).toBe(callsBefore + 1);
    await review.getByRole('checkbox', { name: /选择项目/ }).check();
    await review.getByRole('button', { name: /详情 ·/ }).click();
    const confirm = review.getByRole('button', { name: '确认创建 / 关联' });
    expect(await confirm.isEnabled()).toBe(false);
    const background = review.getByRole('textbox', { name: /^项目背景/ });
    expect(await background.inputValue()).toBe('整理会员档案与生命周期');
    const backgroundEvidence = background.locator('..').locator('..');
    expect(await backgroundEvidence.textContent()).toContain('原文引用');
    expect(await backgroundEvidence.locator('blockquote').textContent()).toBe('项目背景：整理会员档案与生命周期');
    await backgroundEvidence.getByRole('button', { name: /^查看真实来源/ }).click();
    const source = page.getByRole('dialog', { name: '历史来源详情' });
    await source.waitFor();
    expect(await source.textContent()).toContain('约束条件：保留现有账户数据');
    await page.keyboard.press('Escape');
    await source.waitFor({ state: 'hidden' });
    expect(await review.isVisible()).toBe(true);
    expect(await review.getByRole('textbox', { name: /^项目约束/ }).inputValue()).toContain('模型解释');
    await review.getByRole('checkbox', { name: /^我已核对约束/ }).check();
    expect(await confirm.isEnabled()).toBe(false);
    await review.getByRole('textbox', { name: /^项目决策/ }).fill('');
    expect(await review.getByRole('checkbox', { name: /^我已核对决策/ }).isChecked()).toBe(false);
    expect(await confirm.isEnabled()).toBe(false);
    await review.getByRole('checkbox', { name: /^我已核对交付物/ }).check();
    expect(await confirm.isEnabled()).toBe(true);
    await review.getByRole('button', { name: /^编辑/ }).click();
    await review.getByRole('textbox', { name: /^项目名称/ }).fill('核实后的项目名称');
    await review.getByRole('textbox', { name: /^项目简述/ }).fill('审核后保留的修改');
    await review.locator('footer').getByRole('button', { name: '稍后审核', exact: true }).click();
    await review.waitFor({ state: 'hidden' });
    await expect.poll(async () => Object.values((await backend.reviewDraft()).reviews)[0]).toMatchObject({ name: '核实后的项目名称', description: '审核后保留的修改', fields: { decisions: '' } });
    expect(await projects()).toEqual([]);
    await page.getByRole('button', { name: /^继续审核/ }).click();
    await review.waitFor();
    await review.getByRole('button', { name: /^编辑/ }).click();
    expect(await review.getByRole('textbox', { name: /^项目名称/ }).inputValue()).toBe('核实后的项目名称');
    await review.getByRole('textbox', { name: /^项目简述/ }).fill('Escape 后恢复的审核修改');
    await page.keyboard.press('Escape');
    await review.waitFor({ state: 'hidden' });
    await expect.poll(async () => Object.values((await backend.reviewDraft()).reviews)[0]).toMatchObject({ description: 'Escape 后恢复的审核修改' });
    const home = path.join(directory, 'PROJECT_UI_REVIEW');
    backend = new ProjectsBackend({ home: directory, userData: path.join(home, 'userData'), env: {}, analyzer: modelFixture });
    await page.reload();
    await page.getByRole('button', { name: /^项目管理中心/ }).click();
    await page.getByRole('button', { name: /^继续审核/ }).click();
    await review.waitFor();
    await review.getByRole('button', { name: /^编辑/ }).click();
    expect(await review.getByRole('textbox', { name: /^项目简述/ }).inputValue()).toBe('Escape 后恢复的审核修改');
    await review.getByRole('button', { name: /详情 ·/ }).click();
    expect(await review.getByRole('textbox', { name: /^项目决策/ }).inputValue()).toBe('');
    expect(await review.getByRole('checkbox', { name: /^我已核对约束/ }).isChecked()).toBe(true);
    expect(await review.getByRole('checkbox', { name: /^我已核对交付物/ }).isChecked()).toBe(true);
    expect(await confirm.isEnabled()).toBe(true);
    await confirm.click();
    await review.waitFor({ state: 'hidden' });
    expect(llmCalls).toBe(callsBefore + 1);
    const confirmed = (await projects())[0];
    expect(confirmed.name).toBe('核实后的项目名称');
    expect(confirmed.description).toBe('Escape 后恢复的审核修改');
    expect(confirmed.decisions).toBe('');
    expect(confirmed.background).toBe('整理会员档案与生命周期');
    expect(confirmed.fieldEvidence?.background?.kind).toBe('quoted');
    expect(confirmed.fieldEvidence?.constraints?.reviewedAt).toBeGreaterThan(0);
    expect(confirmed.fieldEvidence?.deliverables?.reviewedAt).toBeGreaterThan(0);
    expect(await backend.reviewDraft()).toBeNull();
    expect(confirmed.goalConfirmed).toBe(false);
  }, 60000);

  it('PROJECT_UI_GUARDS：新建项目与新任务离开取消保留草稿、明确放弃才离开', async () => {
    await freshCase('PROJECT_UI_GUARDS');
    await clickButton('新建项目');
    const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
    const name = dialog.getByRole('textbox', { name: '项目名称', exact: true });
    await name.fill('尚未创建的项目');
    page.once('dialog', prompt => void prompt.dismiss());
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(await name.inputValue()).toBe('尚未创建的项目');
    page.once('dialog', prompt => void prompt.dismiss());
    await name.press('Escape');
    expect(await dialog.isVisible()).toBe(true);
    expect(await name.inputValue()).toBe('尚未创建的项目');
    expect(await projects()).toEqual([]);
    page.once('dialog', prompt => void prompt.accept());
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    expect(await projects()).toEqual([]);
    await backend.create({ name: '任务草稿保护项目', goal: '不丢弃未保存任务' });
    await page.reload();
    await page.getByRole('button', { name: /^项目管理中心/ }).click();
    await page.getByRole('button').filter({ has: page.getByRole('heading', { name: '任务草稿保护项目', exact: true }) }).click();
    await clickButton('任务列表');
    await clickButton('新增任务');
    const taskName = page.getByRole('textbox', { name: '新任务名称' });
    await taskName.fill('离开前未保存的新任务');
    page.once('dialog', prompt => void prompt.dismiss());
    await clickButton('背景与文件');
    expect(await taskName.inputValue()).toBe('离开前未保存的新任务');
    page.once('dialog', prompt => void prompt.dismiss());
    await clickButton('项目总览');
    expect(await taskName.inputValue()).toBe('离开前未保存的新任务');
    page.once('dialog', prompt => void prompt.dismiss());
    await clickButton('返回对话');
    expect(await taskName.inputValue()).toBe('离开前未保存的新任务');
    expect((await projects())[0].tasks).toEqual([]);
    page.once('dialog', prompt => void prompt.accept());
    await clickButton('项目总览');
    await page.getByRole('textbox', { name: '搜索项目' }).waitFor();
    expect((await projects())[0].tasks).toEqual([]);
  }, 60000);

  it('PROJECT_UI_LIFECYCLE_FAILURE：删除写入失败保留背景草稿与关闭保护，成功后才读只读', async () => {
    await freshCase('PROJECT_UI_LIFECYCLE_FAILURE');
    await backend.create({ name: '失败保护项目', goal: '验证失败不丢草稿', workingDirectory: path.join(directory, 'workspace') });
    await page.reload();
    await page.getByRole('button', { name: /^项目管理中心/ }).click();
    await page.getByRole('button').filter({ has: page.getByRole('heading', { name: '失败保护项目', exact: true }) }).click();
    await clickButton('编辑背景');
    const background = page.getByRole('textbox', { name: '需求背景', exact: true });
    await background.fill('失败后仍应保留的草稿');
    uiFailLifecycle = true;
    await page.getByText('更多', { exact: true }).click();
    // Deletion and the unsaved-draft confirmation are two sequential native dialogs.
    const acceptDialogs = (prompt: import('playwright').Dialog) => void prompt.accept();
    page.on('dialog', acceptDialogs);
    try {
      await clickButton('移入回收站');
      await expect.poll(async () => (await projects())[0].deletedAt).toBeUndefined();
    } finally { page.off('dialog', acceptDialogs); }
    expect(await page.getByRole('alert').filter({ hasText: /原有数据未改变/ }).count()).toBeGreaterThan(0);
    expect(await background.isVisible()).toBe(true);
    expect(await background.inputValue()).toBe('失败后仍应保留的草稿');
    expect(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(true);
    uiFailLifecycle = false;
    await clickButton('取消编辑');
    await expect.poll(() => background.isVisible()).toBe(false);
    await page.getByText('更多', { exact: true }).click();
    page.once('dialog', prompt => void prompt.accept());
    await clickButton('移入回收站');
    await expect.poll(async () => (await projects())[0].deletedAt).toBeDefined();
  }, 60000);
});
