const { spawn } = require('child_process');
const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

class ClaudeRunner {
  constructor() {
    this.currentProcess = null;
    this.buffer = '';
    this.aborted = false;
  }

  async send(payload) {
    if (this.currentProcess) {
      this.abort();
    }
    // 重置中断标志（注意必须在 abort() 之后）
    this.aborted = false;

    const { prompt, cwd, sessionId, resume, options = {} } = payload;

    const args = ['-p', '--output-format', 'stream-json', '--verbose'];

    if (sessionId && resume) {
      args.push('--resume', sessionId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
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
      args.push(prompt);
    }

    this.emitStatus('starting');

    // 确保 claude 可执行文件在 PATH 中（GUI 环境可能缺失用户自定义 PATH）
    const extraPaths = [
      path.join(os.homedir(), '.local', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ];
    const envPath = [...extraPaths, process.env.PATH || ''].join(path.delimiter);

    try {
      this.currentProcess = spawn('claude', args, {
        cwd,
        env: { ...process.env, PATH: envPath, FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // 立即关闭 stdin，否则 claude 会等待 stdin 输入而不开始处理
      this.currentProcess.stdin.end();

      this.buffer = '';

      this.currentProcess.stdout.on('data', (chunk) => {
        this.buffer += chunk.toString();
        this.processBuffer();
      });

      this.currentProcess.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          this.emitStream({
            type: 'stderr',
            text,
            timestamp: Date.now(),
          });
        }
      });

      return new Promise((resolve) => {
        this.currentProcess.on('close', (code) => {
          if (this.buffer.trim()) {
            this.processLine(this.buffer.trim());
          }
          this.currentProcess = null;
          // 用户主动中断的进程退出码非 0，需要优先报告 aborted 而非 error
          const wasAborted = this.aborted;
          this.aborted = false;
          this.emitStatus(wasAborted ? 'aborted' : code === 0 ? 'completed' : 'error');
          resolve({
            success: wasAborted || code === 0,
            error: !wasAborted && code !== 0 ? `Process exited with code ${code}` : undefined,
          });
        });

        this.currentProcess.on('error', (err) => {
          this.currentProcess = null;
          this.emitStatus('error');
          this.emitStream({
            type: 'stderr',
            text: `Failed to start claude: ${err.message}`,
            timestamp: Date.now(),
          });
          resolve({ success: false, error: err.message });
        });
      });
    } catch (err) {
      this.emitStatus('error');
      return { success: false, error: String(err) };
    }
  }

  abort() {
    if (this.currentProcess) {
      this.aborted = true;
      this.currentProcess.kill('SIGTERM');
      setTimeout(() => {
        if (this.currentProcess) {
          this.currentProcess.kill('SIGKILL');
        }
      }, 2000);
      this.currentProcess = null;
      this.emitStatus('aborted');
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

  async listSessions(cwd) {
    try {
      const encoded = cwd.replace(/\//g, '-');
      const sessionsDir = path.join(os.homedir(), '.claude', 'projects', encoded);
      if (!fs.existsSync(sessionsDir)) return [];

      const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
      const sessions = [];

      for (const file of files) {
        try {
          const filepath = path.join(sessionsDir, file);
          const content = fs.readFileSync(filepath, 'utf8');
          const lines = content.split('\n').filter(Boolean);
          if (lines.length === 0) continue;

          const first = JSON.parse(lines[0]);
          const last = JSON.parse(lines[lines.length - 1]);

          sessions.push({
            sessionId: file.replace('.jsonl', ''),
            cwd,
            firstMessage: (first.message && first.message.content && first.message.content[0] && first.message.content[0].text) || first.type || 'unknown',
            lastActivity: last.timestamp || first.timestamp || null,
            messageCount: lines.length,
          });
        } catch {
          // skip
        }
      }

      sessions.sort((a, b) => {
        const timeA = new Date(a.lastActivity || 0).getTime();
        const timeB = new Date(b.lastActivity || 0).getTime();
        return timeB - timeA;
      });

      return sessions;
    } catch {
      return [];
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
