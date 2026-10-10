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
let llmCalls = 0;
let llmFailure = false;
let llmWaiting = false;
const modelFixture = async (request: any) => {
  llmCalls++;
  if (llmFailure) throw new Error('LLM fixture: invalid structured response');
  if (llmWaiting) await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('LLM fixture: aborted')), { once: true }));
  const { messages } = JSON.parse(request.prompt);
  const user = messages.find((message: any) => message.role === 'user' && message.text.includes('构建一个会员管理平台'));
  const creates = messages.flatMap((message: any) => message.tools.filter((tool: any) => tool.name === 'TaskCreate').map((tool: any) => ({ message, tool })));
  const refs = (sourceId: string, quote: string) => ({ sourceId, quote });
  return { value: { projects: [{ name: '会员管理平台', goal: '构建一个会员管理平台', summary: '按接口、列表、详情与验收推进',
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
      if (method === 'update' && uiFailWrite) throw new Error('UI failure fixture: simulated disk permission failure');
      if (!['list', 'prepare', 'scan', 'cancelScan', 'confirm', 'update', 'reveal'].includes(method)) throw new Error('Unexpected test RPC');
      if (method === 'scan') return backend.scan(args[0], (progress: unknown) => {
        void _source.page.evaluate((detail: unknown) => window.dispatchEvent(new CustomEvent('project-test-progress', { detail })), progress).catch(() => {});
      });
      return backend[method](...args);
    });
    await context.addInitScript(() => {
      const rpc = (method: string, ...args: unknown[]) => (window as any).__projectTestRPC(method, args);
      // Only the pre-existing chat shell is stubbed. Project operations call the real backend.
      (window as any).api = {
        store: { get: async () => null, set: async () => {}, flush: () => {} },
        claude: { onStream: () => () => {}, onStatusChange: () => () => {} },
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
        },
        fs: { readFile: (file: string) => rpc('preview', file) },
      };
    });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL);
    await page.getByRole('button', { name: '项目管理中心', exact: false }).click();
    await page.getByRole('combobox', { name: '项目识别方式' }).selectOption('rules');
  }, 60000);

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) {
      console.error('UI failure state:', await page.locator('main').innerText());
      console.error('UI fields:', await page.locator('textarea').evaluateAll(fields => fields.map(field => ({ id: field.id, labels: [...(field as HTMLTextAreaElement).labels].map(label => label.textContent) }))));
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
    expect(await review.getByText(/发现 1 个候选/).count()).toBe(1);
    expect(await review.getByRole('checkbox', { name: '选择此候选' }).isChecked()).toBe(false);
    expect(await review.getByRole('button', { name: '确认创建 / 关联' }).isEnabled()).toBe(false);
    const nameField = review.getByRole('textbox', { name: /候选项目名称/ });
    await nameField.fill('会员长期项目');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    await page.getByPlaceholder('搜索所有会话的消息内容…').waitFor();
    await page.keyboard.press('Escape');
    expect(await review.isVisible()).toBe(true);
    expect(await nameField.inputValue()).toBe('会员长期项目');
    await review.getByRole('button', { name: '取消，不创建', exact: true }).click();
    expect(await projects()).toEqual([]);
    expect(fs.existsSync(backend.filePath)).toBe(false);

    await clickButton('识别项目');
    await review.waitFor();
    await nameField.fill('会员长期项目');
    await review.getByRole('checkbox', { name: '选择此候选' }).check();
    await review.getByRole('button', { name: '查看关联任务与原文' }).click();
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
    const mode = review.getByRole('combobox', { name: '创建方式' });
    expect(await mode.inputValue()).toBe((await projects())[0].id);
    await review.getByRole('checkbox', { name: '选择此候选' }).check();
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

  it('LLM 范围同意、预算、候选确认、失败不回退及取消识别', async () => {
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
    expect(await review.getByText('LLM 语义识别 + 本地证据校验', { exact: true }).count()).toBe(1);
    expect(await projects()).toEqual(before);
    await review.getByRole('checkbox', { name: '选择此候选' }).check();
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
});
