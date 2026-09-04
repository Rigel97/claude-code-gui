import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Module from 'node:module';
import { createRequire } from 'node:module';
import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 捕获 runner 广播的 stream/status 事件
const captured = { stream: [], status: [] };

// electron stub：纯 Node 环境 require('electron') 返回二进制路径字符串
// （BrowserWindow 为 undefined），必须在加载 runner 之前注入。
// 双保险：既预置模块缓存，也拦截模块解析（vitest 对 CJS require 的
// 外部依赖加载走 node require，会命中缓存）
const nodeRequire = createRequire(import.meta.url);
const ELECTRON_PATH = nodeRequire.resolve('electron');
const electronStub = {
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (ch, data) => {
            if (ch === 'claude:status') captured.status.push(data);
            else if (ch === 'claude:stream') captured.stream.push(data);
          },
        },
      },
    ],
  },
};
nodeRequire.cache[ELECTRON_PATH] = {
  id: ELECTRON_PATH,
  filename: ELECTRON_PATH,
  loaded: true,
  exports: electronStub,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return ELECTRON_PATH;
  return origResolve.call(this, request, ...args);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-claude.sh');

// 必须在加载 runner 之前拦截 spawn：runner 在模块加载时解构捕获 spawn 引用，
// 且 fixture 不能进 PATH（runner 会把 ~/.local/bin 等排在前面，可能命中真 claude）
const realSpawn = cp.spawn;
cp.spawn = (file, args, opts) => {
  if (file === 'claude') {
    const mode = args[args.length - 1] === 'stubborn' ? 'stubborn' : 'normal';
    return realSpawn(FIXTURE, [mode], opts);
  }
  return realSpawn(file, args, opts);
};

let ClaudeRunner;
beforeAll(async () => {
  ({ ClaudeRunner } = await import('../src/main/runner.js'));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// fixture 是 bash 脚本，Windows 上无法执行
describe.skipIf(process.platform === 'win32')('ClaudeRunner 生命周期（代际隔离）', () => {
  let runner;
  beforeEach(() => {
    runner = new ClaudeRunner();
    captured.stream.length = 0;
    captured.status.length = 0;
  });

  it('T1 正常完成：状态序列 starting → completed', async () => {
    const r = await runner.send({ prompt: 'normal', cwd: '/tmp' });
    expect(r.success).toBe(true);
    expect(captured.status).toEqual(['starting', 'completed']);
  });

  it('T2 中断后立即重发：旧进程完全退出后才启动新进程，残流被丢弃', async () => {
    const sendA = runner.send({ prompt: 'normal', cwd: '/tmp' });
    await sleep(80); // A 已 spawn，init 已到
    const initA = captured.stream.find((d) => d.type === 'system');
    expect(initA).toBeTruthy();
    const pidA = initA.pid;

    runner.abort();
    expect(captured.status).toContain('aborted');
    const streamLenAtAbort = captured.stream.length;

    const sendB = runner.send({ prompt: 'normal', cwd: '/tmp' }); // A 可能仍在退出中
    await sendB;

    expect(alive(pidA)).toBe(false); // waitForExit 生效
    expect(captured.status[0]).toBe('starting');
    expect(captured.status).toContain('completed');
    // abort 之后不得再出现 A 的任何输出（黑洞生效）
    const tail = captured.stream.slice(streamLenAtAbort);
    expect(tail.filter((d) => d.type === 'assistant' && String(d.message?.content?.[0]?.text || '').includes(`hello-from-${pidA}`))).toHaveLength(0);
  });

  it('T3 SIGKILL 兜底：忽略 SIGTERM 的进程 2s 后被强制终止', async () => {
    const sendC = runner.send({ prompt: 'stubborn', cwd: '/tmp' });
    await sleep(400);
    const initC = captured.stream.find((d) => d.type === 'system' && d.mode === 'stubborn');
    expect(initC).toBeTruthy();
    // abort 前确实有输出流入
    expect(captured.stream.filter((d) => d.type === 'assistant').length).toBeGreaterThan(0);

    const t0 = Date.now();
    runner.abort();
    const streamLenAtAbort = captured.stream.length;
    await sendC; // SIGTERM 被忽略 → 2s 后 SIGKILL → close
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(elapsed).toBeLessThanOrEqual(5000);
    expect(alive(initC.pid)).toBe(false);
    const tail = captured.stream.slice(streamLenAtAbort);
    expect(tail.filter((d) => d.message?.content?.[0]?.text === 'STUBBORN-LINE')).toHaveLength(0);
  });

  it('T4 中断→重发→再中断：新进程引用不被旧 close 清空', async () => {
    const sendD = runner.send({ prompt: 'stubborn', cwd: '/tmp' });
    await sleep(200);
    runner.abort();
    const sendE = runner.send({ prompt: 'normal', cwd: '/tmp' }); // 等 stubborn 退出后启动
    // stubborn 需等 SIGKILL（~2s），轮询到 E 的 starting 再断言
    let waited = 0;
    while (!captured.status.slice(1).includes('starting') && waited < 5000) {
      await sleep(100);
      waited += 100;
    }
    expect(runner.currentProcess).not.toBeNull(); // 引用健在
    runner.abort(); // 再次 ESC 应能停掉 E
    await sendE;
    expect(runner.currentProcess).toBeNull();
    expect(captured.status).toEqual(['starting', 'aborted', 'starting', 'aborted']);
    await sendD; // 兜底回收（SIGKILL 后早已 resolve）
  });

  it('T5 cwd 无效时不 spawn，直接报错', async () => {
    const r = await runner.send({ prompt: 'x', cwd: '/definitely/not/exist' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('工作目录不存在');
    expect(captured.status).toEqual(['starting', 'error']);
    expect(runner.currentProcess).toBeNull();
  });
});
