// ─── Git 变更面板：主进程侧一次性命令封装 ──────────────
// 仅在项目目录内执行只读状态查询与受控的 checkout 单文件回滚；
// 路径全部来自 git status 输出（相对路径），再做一层防御性校验。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { escapeWindowsArg } = require('./runner');

const IS_WIN = process.platform === 'win32';

/** 运行一次 git 命令，收集 stdout/stderr。返回 { code, stdout, stderr } 或 null（启动失败/超时） */
function runGit(args, cwd, timeoutMs = 15000) {
  if (typeof cwd !== 'string' || !cwd || !fs.existsSync(cwd)) return Promise.resolve(null);
  const env = { ...process.env, FORCE_COLOR: '0' };
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let proc = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc && result === null) {
        try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      proc = IS_WIN
        ? spawn('cmd.exe', ['/d', '/s', '/c', ['git', ...args].map(escapeWindowsArg).join(' ')], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn('git', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      finish(null);
      return;
    }
    proc.stdin.end();
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', () => finish(null));
    proc.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** 防御：git status 返回的相对路径必须是干净的相对路径（禁止绝对路径/.. 逃逸） */
function isSafeRelPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return false;
  if (path.isAbsolute(p)) return false;
  const norm = p.replace(/\\/g, '/');
  if (norm.split('/').some((seg) => seg === '..')) return false;
  return true;
}

/** 变更类型归并（XY 双列状态 → 单一展示语义） */
function classifyChange(x, y) {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'R') return 'renamed';
  if (x === 'M' || y === 'M') return 'modified';
  return 'modified'; // 其余少见类型（C/T/U 等）按修改展示
}

/** 解析 `git status --porcelain -z` 的 NUL 分隔输出 */
function parsePorcelainZ(z) {
  const out = [];
  const parts = z.split('\0').filter((s) => s.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    // 格式：XY<空格>path（重命名时下一个 NUL 段是原路径）
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    let p = entry.slice(3);
    if (x === 'R' || x === 'C') i++; // 跳过原路径段
    if (!isSafeRelPath(p)) continue;
    out.push({
      path: p,
      change: classifyChange(x, y),
      staged: x !== ' ' && x !== '?',
    });
  }
  return out;
}

/** 当前分支名 + 工作区变更列表。非 git 仓库返回 { repo: false } */
async function gitStatus(cwd) {
  const branchR = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 10000);
  if (!branchR || branchR.code !== 0) return { repo: false };
  const branch = branchR.stdout.trim() || 'HEAD';
  const statusR = await runGit(['status', '--porcelain=v1', '-z'], cwd, 15000);
  const changes = statusR && statusR.code === 0 ? parsePorcelainZ(statusR.stdout) : [];
  return { repo: true, branch, changes };
}

/** 单文件 diff（优先工作区，其次暂存区）。无 diff（如未跟踪）返回 '' */
async function gitDiffFile(cwd, filePath) {
  if (!isSafeRelPath(filePath)) return '';
  let r = await runGit(['diff', '--', filePath], cwd, 15000);
  if (!r || r.code !== 0) return '';
  if (!r.stdout.trim()) {
    // 工作区无差异 → 尝试暂存区（已 staged 的改动）
    r = await runGit(['diff', '--cached', '--', filePath], cwd, 15000);
    if (!r || r.code !== 0) return '';
  }
  return r.stdout;
}

/** 回滚单个已跟踪文件的工作区改动（git checkout -- <path>）。
 *  仅对 modified/deleted 的跟踪文件有效；未跟踪文件会被 git 拒绝（天然防护） */
async function gitCheckoutFile(cwd, filePath) {
  if (!isSafeRelPath(filePath)) return { ok: false, error: '非法路径' };
  // 只回滚相对 cwd 的路径，且目标必须处于项目内
  const abs = path.resolve(cwd, filePath);
  if (!abs.startsWith(path.resolve(cwd) + path.sep)) return { ok: false, error: '路径越界' };
  const r = await runGit(['checkout', '--', filePath], cwd, 15000);
  if (!r) return { ok: false, error: 'git 命令超时' };
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || '').trim().split('\n')[0] || `git 退出码 ${r.code}` };
  }
  return { ok: true };
}

module.exports = { gitStatus, gitDiffFile, gitCheckoutFile };
