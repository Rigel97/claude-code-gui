const { spawn } = require('child_process');
const { BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';

/**
 * Windows 参数转义（cross-spawn 同款标准规则）：
 * CRT argv 解析时双引号内的 cmd 元字符失效；内部双引号转义为 \"，
 * 且其前导反斜杠翻倍；末尾反斜杠翻倍。避免空格/元字符破坏参数。
 */
function escapeWindowsArg(arg) {
  let s = String(arg);
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\+)$/, '$1$1');
  return '"' + s + '"';
}

/**
 * 生命周期模型（代际隔离）：
 * - currentProcess    当前活跃进程，close 后置 null；
 * - dyingProcess      已请求终止、尚未退出的旧进程；send() 启动新进程前必须等它退出；
 * - abort() 解除 currentProcess 引用后，旧进程的一切 stdout/stderr 输出按残流丢弃，
 *   其 close 只负责兑现上一次 send 的 promise，不再发出任何状态/流事件。
 * 由此保证：任一时刻最多只有一个活跃进程；旧运行的事件永远不会混入新会话。
 */
class ClaudeRunner {
  constructor() {
    this.currentProcess = null;
    this.dyingProcess = null;
    this.buffer = '';
    this.pendingResolve = null;
  }

  async send(payload) {
    // 并发 send 兜底：上一进程仍在运行时先请求终止
    if (this.currentProcess) {
      this.abort();
    }
    // 上一个进程可能仍处于退出中（用户中断后快速重发）。必须等它完全退出再
    // spawn，否则会重现「旧进程残流写入新会话 / 旧 close 误清新进程引用」的竞态。
    // 5s 兜底：即便进程杀不掉（病态场景）也放行，后续残流已被黑洞，无串扰风险。
    if (this.dyingProcess) {
      await Promise.race([
        this.waitForExit(this.dyingProcess),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      this.dyingProcess = null;
    }

    const { prompt, cwd, sessionId, resume, options = {} } = payload;

    const args = ['-p', '--output-format', 'stream-json', '--verbose'];

    // 已有会话 ID 时必须 --resume 续接多轮上下文；新会话的 id 由 CLI 在 init
    // 事件中返回。渲染层恒以 resume 传递，不存在「预指定 --session-id」的调用方
    if (sessionId && resume) {
      args.push('--resume', sessionId);
    }

    // 权限模式：非交互模式下必须指定，否则工具调用会被拒绝
    // bypassPermissions: 全部放行（GUI 场景，用户自己把控）
    // acceptEdits: 仅自动接受文件编辑
    const permissionMode = options.permissionMode || 'bypassPermissions';
    args.push('--permission-mode', permissionMode);

    if (options.model) {
      args.push('--model', options.model);
    }

    if (prompt) {
      // 以 - 开头的 prompt 会被 commander 解析为 flag，用 -- 强制按位置参数处理
      if (prompt.startsWith('-')) {
        args.push('--');
      }
      args.push(prompt);
    }

    this.emitStatus('starting');

    // 校验工作目录存在：cwd 失效时 Node 的 spawn 会抛误导性的
    // `ENOENT spawn claude ENOENT`（看似找不到 claude，实则是 cwd 不存在），
    // 这里提前拦截并给出明确提示
    if (!cwd || !fs.existsSync(cwd)) {
      const msg = `工作目录不存在或为空: ${cwd || '(空)'}。请在侧栏重新选择一个有效的项目目录。`;
      this.emitStatus('error');
      this.emitStream({ type: 'stderr', text: msg, timestamp: Date.now() });
      return { success: false, error: msg };
    }

    // 确保 claude 可执行文件在 PATH 中（GUI 环境可能缺失用户自定义 PATH）
    const extraPaths = [
      path.join(os.homedir(), '.local', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ];
    const envPath = [...extraPaths, process.env.PATH || ''].join(path.delimiter);

    try {
      const env = { ...process.env, PATH: envPath, FORCE_COLOR: '0' };
      const stdio = ['pipe', 'pipe', 'pipe'];
      // Windows 上 npm 安装的 claude 是 .cmd shim；Node 因 CVE-2024-27980 不再
      // 隐式经 shell 执行 .cmd/.bat，这里显式经 cmd.exe 启动并逐参数转义。
      // 注：该分支未在 Windows 实测，属尽力支持（macOS/Linux 路径不变）
      const proc = IS_WIN
        ? spawn('cmd.exe', ['/d', '/s', '/c', ['claude', ...args].map(escapeWindowsArg).join(' ')], { cwd, env, stdio })
        : spawn('claude', args, { cwd, env, stdio });
      this.currentProcess = proc;

      // 立即关闭 stdin，否则 claude 会等待 stdin 输入而不开始处理
      proc.stdin.end();

      this.buffer = '';

      proc.stdout.on('data', (chunk) => {
        // 进程被 abort 后引用已解除，其残流一律丢弃，避免旧运行的输出混入新会话
        if (this.currentProcess !== proc) return;
        this.buffer += chunk.toString();
        this.processBuffer();
      });

      proc.stderr.on('data', (chunk) => {
        if (this.currentProcess !== proc) return;
        const text = chunk.toString().trim();
        if (text) {
          this.emitStream({
            type: 'stderr',
            text,
            timestamp: Date.now(),
          });
        }
      });

      return await new Promise((resolve) => {
        this.pendingResolve = resolve;
        proc.on('close', (code) => this.handleClose(proc, code));
        proc.on('error', (err) => this.handleError(proc, err));
      });
    } catch (err) {
      this.emitStatus('error');
      return { success: false, error: String(err) };
    }
  }

  /** 进程正常退出（未经 abort）：刷新尾部数据并广播最终状态 */
  handleClose(proc, code) {
    if (this.currentProcess === proc) {
      this.currentProcess = null;
      this.flushBuffer();
      const success = code === 0;
      this.emitStatus(success ? 'completed' : 'error');
      this.settle({
        success,
        error: success ? undefined : `Process exited with code ${code}`,
      });
    } else if (this.dyingProcess === proc) {
      // 被 abort 的进程退出：状态已由 abort() 广播，残流丢弃，只兑现 send 的 promise
      this.dyingProcess = null;
      this.buffer = '';
      this.settle({ success: true });
    }
    // 两者皆非（如 spawn error 后又收到 close）：settle 已兑现，无需处理
  }

  handleError(proc, err) {
    if (this.currentProcess === proc) {
      this.currentProcess = null;
      this.emitStatus('error');
      this.emitStream({
        type: 'stderr',
        text: `Failed to start claude: ${err.message}`,
        timestamp: Date.now(),
      });
      this.settle({ success: false, error: err.message });
    } else if (this.dyingProcess === proc) {
      this.dyingProcess = null;
      this.settle({ success: false, error: err.message });
    }
  }

  abort() {
    const proc = this.currentProcess;
    if (!proc) return;
    // 立即解除引用：后续 stdout/stderr 按「旧进程残流」黑洞丢弃；
    // dyingProcess 供 send() 等待旧进程真正退出后再启动新一轮
    this.currentProcess = null;
    this.dyingProcess = proc;
    if (IS_WIN) {
      // Windows 下进程经 cmd.exe 包装，kill 只能杀到包装层；taskkill /T 连同
      // 子进程树一起终止（claude 无法收到优雅退出信号，/F 强制）
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
    } else {
      proc.kill('SIGTERM');
      // SIGTERM 后 2s 仍未退出则 SIGKILL。
      // 注意 killed 只代表「信号已发出」，判断是否真正退出要看 exitCode/signalCode，
      // 否则兜底永远不会执行（旧实现的 bug）
      setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL');
          }
        } catch {
          // 进程已退出，忽略
        }
      }, 2000);
    }
    this.emitStatus('aborted');
  }

  waitForExit(proc) {
    return new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      proc.once('close', () => resolve());
    });
  }

  /** 刷出缓冲区中最后一个不完整行之后剩余的完整行，并清空缓冲区 */
  flushBuffer() {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) {
      this.processLine(rest);
    }
  }

  settle(result) {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(result);
    }
  }

  processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        this.processLine(trimmed);
      }
    }
  }

  processLine(line) {
    try {
      const data = JSON.parse(line);
      this.emitStream(data);
    } catch {
      this.emitStream({
        type: 'raw',
        text: line,
        timestamp: Date.now(),
      });
    }
  }

  emitStream(data) {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('claude:stream', data);
    }
  }

  emitStatus(status) {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('claude:status', status);
    }
  }
}

module.exports = { ClaudeRunner };
