import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectsBackend } from '../src/main/projects.js';

const prose = '客户资料一直散落在多个文档里。接下来几个月先统一客户列表，再接通客户详情，之后持续让同事在同一个地方协作。';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const data = cwd => ({ sessions: [{ sessionId: 's', cwd, title: '持续客户工作', messages: [{ id: 'user', role: 'user', timestamp: 1, blocks: [{ kind: 'text', text: prose }] }] }], conversations: [] });
function response({ prompt }) {
  const source = JSON.parse(prompt).messages.find(message => message.role === 'user');
  const ref = quote => ({ sourceId: source.sourceId, quote });
  return { value: { projects: [{ name: '客户协作中心', goal: '逐步统一客户信息管理', summary: '跨多月推进的客户工作',
    evidence: [ref(prose)], criteria: { longTerm: true, shortQA: false, reasons: ['目标跨月推进，包含列表和详情两个阶段'] },
    tasks: [{ id: 'a', name: '客户列表', description: '', sourceRefs: [ref('先统一客户列表')] },
      { id: 'b', name: '客户详情', description: '', sourceRefs: [ref('再接通客户详情')] }],
  }] }, costUsd: 0.01 };
}
let dir, backend, analyzer;
const scanArgs = plan => ({ sessions: [], conversations: [], mode: 'llm', planId: plan.planId, consent: true, model: 'mock', maxBudgetUsd: 2, requestId: 'request' });
const review = candidate => ({ candidateId: candidate.id, name: candidate.name, goal: candidate.goal, description: candidate.description, ...(candidate.existingProjectId ? { existingProjectId: candidate.existingProjectId } : {}) });
beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'llm-backend-'));
  analyzer = vi.fn(async request => response(request));
  backend = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userData'), env: {}, analyzer });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.promises.rm(dir, { recursive: true, force: true }); });

describe('LLM 只读准备、显式发送与确认落盘', () => {
  it('prose 不被规则筛除；prepare 仅预览冻结快照，确认发送后仍需用户创建', async () => {
    const input = data(dir), plan = await backend.prepare(input);
    expect(plan.messages).toBe(1);
    expect(analyzer).not.toHaveBeenCalled();
    expect(plan).not.toHaveProperty('payload');
    expect(fs.existsSync(backend.filePath)).toBe(false);
    input.sessions[0].messages[0].blocks[0].text = 'changed after review';
    const progress = vi.fn();
    const scan = await backend.scan(scanArgs(plan), progress);
    expect(analyzer.mock.calls[0][0].prompt).toContain(prose);
    expect(analyzer.mock.calls[0][0].prompt).not.toContain('changed after review');
    expect(scan.candidates).toHaveLength(1);
    expect(scan.analysis).toMatchObject({ mode: 'llm', costUsd: 0.01 });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'request', phase: 'analyzing' }));
    expect(await backend.list()).toEqual([]);
    await backend.confirm(scan.scanId, [review(scan.candidates[0])]);
    expect(await backend.list()).toHaveLength(1);
    const restarted = new ProjectsBackend({ home: dir, userData: path.join(dir, 'userData'), env: {}, analyzer });
    expect(await restarted.list()).toEqual(await backend.list());
  });
  it('未同意、伪造/过期计划或坏预算都不会调用模型', async () => {
    const plan = await backend.prepare(data(dir));
    for (const changes of [{ consent: false }, { planId: 'fake' }, { maxBudgetUsd: 0 }, { maxBudgetUsd: 101 }]) {
      await expect(backend.scan({ ...scanArgs(plan), ...changes })).rejects.toThrow();
    }
    expect(analyzer).not.toHaveBeenCalled();
    backend.plans.get(plan.planId).expiresAt = 0;
    await expect(backend.scan(scanArgs(plan))).rejects.toThrow(/过期/);
    expect(analyzer).not.toHaveBeenCalled();
  });
  it('单次计划不可重放，重复识别通过同目录真实来源关联已有项目', async () => {
    const plan = await backend.prepare(data(dir));
    const scan = await backend.scan(scanArgs(plan));
    await expect(backend.scan(scanArgs(plan))).rejects.toThrow(/计划/);
    await backend.confirm(scan.scanId, [review(scan.candidates[0])]);
    const next = await backend.scan(scanArgs(await backend.prepare(data(dir))));
    expect(next.candidates[0].existingProjectId).toBe((await backend.list())[0].id);
    await backend.confirm(next.scanId, [review(next.candidates[0])]);
    expect(await backend.list()).toHaveLength(1);
  });
  it('任何 await 之前注册取消请求，不会在 load 后继续发出历史', async () => {
    const plan = await backend.prepare(data(dir));
    const waiting = deferred();
    vi.spyOn(backend, 'load').mockImplementation(() => waiting.promise);
    const pending = backend.scan(scanArgs(plan));
    expect(backend.cancelScan('other')).toBe(false);
    expect(backend.cancelScan('request')).toBe(true);
    waiting.resolve();
    await expect(pending).rejects.toThrow(/取消/);
    expect(analyzer).not.toHaveBeenCalled();
    expect(backend.scanBusy).toBe(false);
  });
  it('LLM 失败和取消不回退到规则、不产生可确认的部分项目', async () => {
    analyzer.mockRejectedValueOnce(new Error('invalid schema'));
    const plan = await backend.prepare(data(dir));
    await expect(backend.scan(scanArgs(plan))).rejects.toThrow(/invalid schema/);
    expect(await backend.list()).toEqual([]);
    expect(backend.scans.size).toBe(0);
    const wait = deferred();
    analyzer.mockImplementationOnce(() => wait.promise);
    const pending = backend.scan(scanArgs(await backend.prepare(data(dir))));
    await vi.waitFor(() => expect(analyzer).toHaveBeenCalledTimes(2));
    expect(backend.cancelScan('request')).toBe(true);
    await expect(pending).rejects.toThrow(/abort/i);
    expect(backend.scans.size).toBe(0);
    wait.resolve({ value: { projects: [] }, costUsd: 0.01 });
    expect(fs.existsSync(backend.filePath)).toBe(false);
  });
});
