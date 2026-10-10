import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { analyzeWithClaude } from '../src/main/projects-analyzer.js';

const request = overrides => ({ prompt: 'Synthetic evidence only; no user history.', systemPrompt: 'Return structured projects.',
  schema: { type: 'object', properties: { projects: { type: 'array' } }, required: ['projects'] }, model: 'sonnet', maxBudgetUsd: 2, ...overrides });
const success = overrides => ({ type: 'result', subtype: 'success', is_error: false, structured_output: { projects: [] }, total_cost_usd: 0.01, ...overrides });
let captured;
let behavior;
let exited;
beforeEach(() => {
  captured = null; exited = false;
  behavior = proc => { proc.stdout.end(JSON.stringify(success())); proc.emit('close', 0); exited = true; };
  vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
    const proc = new EventEmitter();
    Object.assign(proc, { pid: 424242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    captured = { command, args, options, proc, input: '' };
    proc.stdin.on('data', chunk => { captured.input += chunk; });
    proc.stdin.on('finish', () => { setImmediate(() => behavior(proc)); });
    return proc;
  });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (!exited) setImmediate(() => { exited = true; captured.proc.emit('close', null); });
    return true;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe.skipIf(process.platform === 'win32')('工具禁用的 Claude 结构化分析调用', () => {
  it('stdin 传历史、禁用工具/MCP/技能/会话保存，不加载项目目录', async () => {
    expect(await analyzeWithClaude(request())).toEqual({ value: { projects: [] }, costUsd: 0.01 });
    expect(captured.command).toBe('claude');
    expect(captured.input).toBe(request().prompt);
    expect(captured.args).not.toContain(request().prompt);
    expect(captured.args).toContain('--safe-mode');
    expect(captured.args).toContain('--no-session-persistence');
    expect(captured.args).toContain('--strict-mcp-config');
    expect(captured.args).toContain('--disable-slash-commands');
    expect(captured.args[captured.args.indexOf('--tools') + 1]).toBe('');
    expect(captured.args[captured.args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(captured.args[captured.args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(captured.args).not.toContain('--resume');
    expect(captured.args).not.toContain('--dangerously-skip-permissions');
    expect(captured.args[captured.args.indexOf('--max-budget-usd') + 1]).toBe('2');
    expect(fs.existsSync(captured.options.cwd)).toBe(false);
  });
  it.each([
    ['plain output', 'not JSON', /有效 JSON/],
    ['no structured output', JSON.stringify(success({ structured_output: undefined, result: '```json\n{}\n```' })), /结构化输出缺失/],
    ['no cost', JSON.stringify(success({ total_cost_usd: undefined })), /费用/],
    ['budget terminal', JSON.stringify(success({ subtype: 'error_max_budget_usd' })), /未完成/],
  ])('拒绝无效分析结果：%s', async (_name, output, expected) => {
    behavior = proc => { proc.stdout.end(output); proc.emit('close', 0); exited = true; };
    await expect(analyzeWithClaude(request())).rejects.toThrow(expected);
    expect(fs.existsSync(captured.options.cwd)).toBe(false);
  });
  it('旧 CLI 不支持安全选项时失败，不能悄悄去掉安全限制重试', async () => {
    behavior = proc => { proc.stderr.end('unknown option --safe-mode'); proc.emit('close', 1); exited = true; };
    await expect(analyzeWithClaude(request())).rejects.toThrow(/更新 CLI/);
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });
  it('启动失败返回可理解错误且清理临时目录', async () => {
    behavior = proc => { proc.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); };
    await expect(analyzeWithClaude(request())).rejects.toThrow(/未找到 Claude Code/);
    expect(fs.existsSync(captured.options.cwd)).toBe(false);
  });
  it('取消与超时终止进程组，不返回部分候选', async () => {
    behavior = () => {};
    const controller = new AbortController();
    const pending = analyzeWithClaude(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(captured).not.toBeNull());
    controller.abort();
    await expect(pending).rejects.toThrow(/取消/);
    expect(process.kill).toHaveBeenCalledWith(-424242, 'SIGTERM');
    expect(fs.existsSync(captured.options.cwd)).toBe(false);
    exited = false;
    await expect(analyzeWithClaude(request({ timeoutMs: 10 }))).rejects.toThrow(/超时（等待 \d+ 秒后终止）/);
    expect(fs.existsSync(captured.options.cwd)).toBe(false);
  });
  it('输出超过上限被中止；提前取消或坏预算不会 spawn', async () => {
    behavior = proc => { proc.stdout.write('x'.repeat(2 * 1024 * 1024 + 1)); };
    await expect(analyzeWithClaude(request())).rejects.toThrow(/输出超过/);
    const calls = vi.mocked(childProcess.spawn).mock.calls.length;
    await expect(analyzeWithClaude(request({ maxBudgetUsd: 0 }))).rejects.toThrow(/预算/);
    const controller = new AbortController(); controller.abort();
    await expect(analyzeWithClaude(request({ signal: controller.signal }))).rejects.toThrow(/取消/);
    expect(childProcess.spawn).toHaveBeenCalledTimes(calls);
  });
});
