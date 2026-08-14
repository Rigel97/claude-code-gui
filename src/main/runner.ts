const { spawn } = require('child_process');
const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

class ClaudeRunner {
  constructor() {
    this.currentProcess = null;
    this.buffer = '';
  }

  async send(payload) {
    if (this.currentProcess) {
      this.abort();
    }

    const { prompt, cwd, sessionId, resume, options = {} } = payload;

    const args = ['-p', '--output-format', 'stream-json', '--verbose'];

    if (sessionId && resume) {
      args.push('--resume', sessionId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
    }

    args.push('--allowedTools');

    if (options.model) {
      args.push('--model', options.model);
    }

    if (prompt) {
      args.push(prompt);
    }

    this.emitStatus('starting');

    try {
      this.currentProcess = spawn('claude', args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

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
          this.emitStatus(code === 0 ? 'completed' : 'error');
          resolve({ success: code === 0, error: code !== 0 ? `Process exited with code ${code}` : undefined });
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
