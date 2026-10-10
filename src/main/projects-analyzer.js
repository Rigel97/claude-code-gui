const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
// 单批结构化输出可能很大（实测 8 批 / 21 万字符历史时 120 秒不够）；
// 与 compactSession 的一次性 LLM 调用超时保持一致（5 分钟）
const TIMEOUT_MS = 300000;

/** Independent, tool-free Claude invocation. Never resumes or persists a chat session. */
async function analyzeWithClaude({ prompt, systemPrompt, schema, model, maxBudgetUsd, signal, timeoutMs = TIMEOUT_MS }) {
  if (typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error('LLM 分析输入为空或超过大小上限');
  if (typeof systemPrompt !== 'string' || !systemPrompt || !schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('LLM 分析契约无效');
  if (typeof model !== 'string' && model !== undefined) throw new Error('模型名称无效');
  if (model && (model.length > 200 || model.includes('\0') || model.startsWith('-'))) throw new Error('模型名称无效');
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 100) throw new Error('LLM 识别预算必须大于 0 且不超过 100 美元');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('分析超时设置无效');
  if (signal?.aborted) throw new Error('项目识别已取消');
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-gui-analysis-'));
  try {
    if (signal?.aborted) throw new Error('项目识别已取消');
    const args = [
      '-p', '--input-format', 'text', '--output-format', 'json',
      '--json-schema', JSON.stringify(schema), '--system-prompt', systemPrompt,
      '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-chrome',
      '--no-session-persistence', '--safe-mode', '--settings', '{"disableAllHooks":true}',
      '--setting-sources', 'user', '--max-budget-usd', String(maxBudgetUsd),
      ...(model ? ['--model', model] : []),
    ];
    const env = { ...process.env, PATH: [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', process.env.PATH || ''].join(path.delimiter), FORCE_COLOR: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    const output = await new Promise((resolve, reject) => {
      let proc;
      let failure = null;
      let timer;
      let killTimer;
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let closed = false;
      const terminate = () => {
        if (!proc || closed) return;
        try {
          if (process.platform === 'win32') {
            childProcess.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { try { proc.kill(); } catch { /* exited */ } });
          } else if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
        } catch { try { proc.kill('SIGTERM'); } catch { /* exited */ } }
        if (!killTimer) killTimer = setTimeout(() => {
          try { if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGKILL'); else proc.kill('SIGKILL'); }
          catch { try { proc.kill('SIGKILL'); } catch { /* exited */ } }
        }, 2000);
      };
      const fail = error => { if (!failure) failure = error; terminate(); };
      const cancel = () => fail(new Error('项目识别已取消；已发出的模型请求可能产生费用，未保存候选。'));
      const cleanup = () => { closed = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel); };
      try {
        proc = process.platform === 'win32'
          ? childProcess.spawn('cmd.exe', ['/d', '/s', '/c', ['claude', ...args].map(require('./runner').escapeWindowsArg).join(' ')], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
          : childProcess.spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      } catch (error) { cleanup(); reject(new Error(`Claude Code 启动失败：${error.message}`)); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => fail(new Error(`Claude Code 分析超时（等待 ${Math.max(1, Math.round(timeoutMs / 1000))} 秒后终止）：历史较大或模型响应较慢时可能发生；可能已产生费用，未保存候选。可直接重试，或减小历史范围、更换更快的模型。`)), timeoutMs);
      proc.on('error', error => {
        cleanup();
        reject(new Error(error.code === 'ENOENT' ? '未找到 Claude Code，请确认 CLI 已安装并能在当前环境登录。' : `Claude Code 启动失败：${error.message}`));
      });
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) fail(new Error('Claude Code 分析输出超过大小上限，未采信结果。'));
        else stdout += chunk;
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
      proc.stdin.on('error', error => fail(new Error(`Claude Code 输入失败：${error.message}`)));
      proc.on('close', code => {
        cleanup();
        if (failure) { reject(failure); return; }
        if (code !== 0) {
          const unsupported = /unknown option|unrecognized|invalid option/i.test(stderr);
          reject(new Error(unsupported ? '当前 Claude Code 不支持安全结构化识别选项，请更新 CLI 后重试；未回退为无保护调用。'
            : `Claude Code 分析失败（exit ${code}）：${stderr.trim() || '请检查登录、模型和网络配置。'}`));
          return;
        }
        resolve(stdout);
      });
      // Large history is sent over stdin, never command-line arguments or an on-disk prompt file.
      if (signal?.aborted) cancel();
      else proc.stdin.end(prompt);
    });
    let result;
    try { result = JSON.parse(output); }
    catch { throw new Error('Claude Code 未返回有效 JSON 结果，未采信候选。'); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.is_error || (result.subtype && result.subtype !== 'success')) {
      throw new Error(`Claude Code 未完成结构化分析：${Array.isArray(result?.errors) ? result.errors.map(error => String(error).slice(0, 600)).join('; ') : typeof result?.result === 'string' ? result.result.slice(0, 1500) : '调用未成功或已超出预算。'}`);
    }
    let value = result.structured_output;
    if (value === undefined && typeof result.result === 'string') {
      // Some CLI versions put a pure JSON result in result; never scrape markdown or prose.
      try { value = JSON.parse(result.result); } catch { /* rejected below */ }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude Code 结构化输出缺失，未采信候选。');
    if (!Number.isFinite(result.total_cost_usd) || result.total_cost_usd < 0) throw new Error('Claude Code 未提供可核对的费用，已停止识别以免失去总预算约束。');
    if (signal?.aborted) throw new Error('项目识别已取消，未保存候选。');
    return { value, costUsd: result.total_cost_usd };
  } finally {
    await fs.promises.rm(cwd, { recursive: true, force: true });
  }
}

module.exports = { analyzeWithClaude };
