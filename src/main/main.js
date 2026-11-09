// 防 ELECTRON_RUN_AS_NODE 污染：该变量会让 Electron 以纯 Node 模式运行，
// 导致窗口不弹出、跑完脚本即退出（launchd 全局环境被某些工具 setenv 时会踩中）。
// 打包版已通过 electronFuses 禁用 runAsNode（二进制层面无视该变量，见 package.json），
// 此处兜底 dev 模式（electron . 以 Node 加载 package.json main）。process.type
// 仅在 Electron 主进程存在——GUI 模式下变量即使残留也不触发无谓的重启。
if (process.env.ELECTRON_RUN_AS_NODE && process.type === undefined) {
  delete process.env.ELECTRON_RUN_AS_NODE;
  // Node 模式下 argv[1] 是本 main.js 的脚本路径；GUI 模式会把它当作 app 目录
  // 参数解析（找不到 package.json 而启动失败），重拉时必须剔除。
  // dev 模式的 "." 等真实参数不受影响（不含 src/main/main.js）。
  const respawnArgs = process.argv
    .slice(1)
    .filter((a) => !String(a).replace(/\\/g, '/').includes('src/main/main.js'));
  require('child_process')
    .spawn(process.argv[0], respawnArgs, {
      detached: true,
      stdio: 'ignore',
      env: process.env, // 此时变量已从 process.env 中删除，子进程将以 GUI 模式启动
    })
    .unref();
  process.exit(0);
}

const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu, clipboard, protocol, safeStorage, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Readable } = require('stream');
const { ClaudeService } = require('./claude-service');
const { ClaudeRuntime } = require('./claude-runtime');
const { SessionHistory } = require('./session-history');
const { NativeTerminalManager } = require('./native-terminal');
const { SessionOwnership } = require('./session-ownership');
const { readDirectory, readPreview } = require('./file-browser');
const { saveImageDataUrl } = require('./images');
const { Store } = require('./store');
const { ProjectsBackend } = require('./projects');

let mainWindow = null;
let store = null;
let projects = null;
let service = null;
let runtime = null;
let terminalManager = null;
const allowedRootPaths = new Set();
const ownedProcessGroups = new Map();
let processSnapshot = null;
async function captureOwnedProcessGroups() {
  if (process.platform === 'win32') return false;
  return new Promise(resolve => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 1500, maxBuffer: 2 * 1024 * 1024 }, (error, output) => {
      if (error || typeof output !== 'string') { resolve(false); return; }
      const rows = output.trim().split('\n').map(line => {
        const [pid, parent, group, ...start] = line.trim().split(/\s+/);
        return [Number(pid), Number(parent), Number(group), start.join(' ')];
      }).filter(([pid, parent, group]) => [pid, parent, group].every(Number.isSafeInteger));
      const descendants = new Set([process.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parent] of rows) if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
      }
      for (const [group, members] of ownedProcessGroups) {
        const live = rows.filter(([pid, , pgid, start]) => pgid === group && members.get(pid) === start);
        if (!live.length) ownedProcessGroups.delete(group);
        else ownedProcessGroups.set(group, new Map(live.map(([pid, , , start]) => [pid, start])));
      }
      for (const [pid, , group, start] of rows) {
        if (!descendants.has(pid) || group <= 1 || group === process.pid || group === process.ppid) continue;
        if (!ownedProcessGroups.has(group) && !rows.some(([leader]) => leader === group && descendants.has(leader))) continue;
        const members = ownedProcessGroups.get(group) || new Map();
        members.set(pid, start); ownedProcessGroups.set(group, members);
      }
      resolve(true);
    });
  });
}
async function forceKillOwnedProcesses() {
  await processSnapshot;
  if (!await captureOwnedProcessGroups()) return false;
  let confirmed = true;
  for (const group of ownedProcessGroups.keys()) {
    try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') confirmed = false; }
  }
  return confirmed;
}
function assertSender(event) {
  const sender = event?.sender;
  const window = BrowserWindow.getAllWindows().find(window => window.webContents === sender);
  if (!window || window.isDestroyed() || sender.isDestroyed()) throw new Error('Invalid IPC sender: an owned live window is required');
  if (event.senderFrame && sender.mainFrame && event.senderFrame !== sender.mainFrame) throw new Error('Invalid IPC sender frame');
  return sender.id;
}
// Gate every RPC before its body, including filesystem RPCs that do not need service readiness.
const registerHandle = ipcMain.handle.bind(ipcMain);
const registerOn = ipcMain.on.bind(ipcMain);
const handleIPC = (channel, operation) => registerHandle(channel, (event, ...args) => { assertSender(event); return operation(event, ...args); });
const onIPC = (channel, operation) => registerOn(channel, (event, ...args) => {
  try { assertSender(event); operation(event, ...args); } catch { /* fire-and-forget from an untrusted/destroyed sender */ }
});
function registerRoot(cwd) {
  if (typeof cwd === 'string' && path.isAbsolute(cwd) && !/[\x00-\x1f\x7f]/.test(cwd)) allowedRootPaths.add(path.resolve(cwd));
}
function registerStoredRoots() {
  let state;
  try { state = store?.get('appState'); } catch { return; } // Recovery UI must still load; never approve roots from unreadable state.
  registerRoot(state?.cwd);
  for (const conversation of Array.isArray(state?.conversations) ? state.conversations : Object.values(state?.conversations || {})) registerRoot(conversation?.cwd);
}

// Apply isolation before any Store is constructed (including integration runs).
if (process.env.CLAUDE_GUI_USER_DATA !== undefined) {
  const directory = process.env.CLAUDE_GUI_USER_DATA;
  if (!path.isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory)) throw new Error('CLAUDE_GUI_USER_DATA must be an absolute path');
  app.setPath('userData', directory);
}
function requireService() {
  if (!service) throw new Error('Claude service not ready; retry after app readiness');
  return service;
}
function ownerSend(owner, channel, payload) {
  const target = webContents.fromId(owner);
  if (!target || target.isDestroyed()) return;
  const { ownerWebContentsId: _owner, ...data } = payload;
  try { target.send(channel, data); } catch { /* destroyed between lookup and send */ }
}
async function openExternal(url) {
  try {
    if (typeof url !== 'string' || url.length > 2048 || /[\x00-\x1f\x7f]/.test(url)) throw new Error();
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    await shell.openExternal(parsed.href);
    return { success: true };
  } catch { return { success: false, error: 'External URL rejected or could not be opened' }; }
}
handleIPC('app:open-external', (_event, url) => openExternal(url));

// ─── bgmedia:// 自定义协议：动态视频背景 ──────────────────
// 渲染层 origin（dev 为 http://localhost:5170、生产为 file://）都无法直接用
// <video> 引用磁盘上的任意视频文件，注册专用协议统一两条加载路径：
// - 必须在 app ready 前声明特权（stream: 允许 <video> 边下边播）
// - 只服务当前登记的唯一视频路径（单一白名单，防止借协议任意读本机文件）
// - 实现 HTTP Range（206）分段响应：视频 seek / 循环回绕依赖它
const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
};
const VIDEO_EXT = new Set(Object.keys(VIDEO_MIME));
let bgVideoPath = null;

protocol.registerSchemesAsPrivileged([
  { scheme: 'bgmedia', privileges: { stream: true } },
]);

/** 解析 Range 头（bytes=start-end / start- / -suffix），返回 [start, end] 或 null */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const [, startRaw, endRaw] = m;
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    // suffix range：取文件末尾 N 字节
    const suffix = parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = parseInt(startRaw, 10);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  const end = endRaw === '' ? size - 1 : Math.min(parseInt(endRaw, 10), size - 1);
  if (start > end) return null;
  return [start, end];
}

/** 以流式 Response 提供视频文件（带 Range 支持） */
function serveVideoFile(filePath, rangeHeader) {
  return new Promise((resolve) => {
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        resolve(new Response(null, { status: 404 }));
        return;
      }
      const mime = VIDEO_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      const range = parseRange(rangeHeader, stat.size);
      const [start, end] = range || [0, stat.size - 1];
      const nodeStream = fs.createReadStream(filePath, range ? { start, end } : undefined);
      // 读取中途出错（文件被移走等）：流静默终止，渲染层 onError 兑现降级
      nodeStream.on('error', () => {});
      resolve(
        new Response(Readable.toWeb(nodeStream), {
          status: range ? 206 : 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
          },
        })
      );
    });
  });
}

function installBgMediaProtocol() {
  protocol.handle('bgmedia', async (request) => {
    try {
      // URL 形如 bgmedia://video/<encodeURIComponent(绝对路径)>
      const url = new URL(request.url);
      const requested = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (
        !bgVideoPath ||
        !requested ||
        path.resolve(requested) !== path.resolve(bgVideoPath)
      ) {
        return new Response(null, { status: 403 });
      }
      return await serveVideoFile(bgVideoPath, request.headers.get('range'));
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

// ─── IPC: 动态视频背景 ──────────────────────
// 选择本机视频文件（同时登记为 bgmedia:// 可服务的白名单路径）
handleIPC('dialog:open-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: '视频文件', extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv'] }],
  });
  const filePath = result.canceled ? null : result.filePaths[0] || null;
  if (filePath) bgVideoPath = filePath;
  return filePath;
});

// 启动恢复：渲染层从持久化 appState 拿回路径后重新登记（校验绝对路径与视频扩展名）
handleIPC('video-bg:set-path', (_e, filePath) => {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    !VIDEO_EXT.has(path.extname(filePath).toLowerCase())
  ) {
    return false;
  }
  bgVideoPath = filePath;
  return true;
});

handleIPC('video-bg:clear', () => {
  bgVideoPath = null;
  return true;
});

for (const method of ['list', 'prepare', 'scan', 'cancelScan', 'confirm', 'update', 'patch', 'create', 'archive', 'remove', 'merge', 'reveal', 'activeJob', 'discardPlan', 'reviewDraft', 'saveReviewDraft', 'linkConversation', 'recordConversation', 'reload', 'storageInfo', 'purge', 'restoreBackup']) {
  handleIPC(`projects:${method}`, async (event, ...args) => {
    if (!projects) throw new Error('Projects 后端尚未初始化，请稍后重试');
    if (method === 'scan' || method === 'prepare') return projects[method](args[0], progress => {
      if (event.sender && !event.sender.isDestroyed()) event.sender.send('projects:progress', progress);
    });
    return projects[method](...args);
  });
}

// SDK, history and native writers share the same SessionOwnership registry.

const http = require('http');

/**
 * 探测 Vite dev server 是否可用
 */
function isDevServerRunning() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:5170', () => resolve(true));
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#05070d',
    // macOS: 保留红绿灯按钮但隐藏标题栏；其他平台: 无边框
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 安全边界：聊天内容是模型输出（可被 prompt injection 操纵），任何链接都不允许
  // 在窗口内导航——导航后 preload 会重新注入，远程页面将拿到 IPC bridge
  // （claude:send 默认 bypassPermissions，等同任意命令执行），外链一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 仅放行本地页面（生产 file:// 与 dev server），其余导航拦截并转交系统浏览器
    const isLocal = url.startsWith('file://') || url.startsWith('http://localhost:5170');
    if (!isLocal) {
      event.preventDefault();
      void openExternal(url);
    }
  });

  const window = mainWindow;
  const owner = window.webContents.id;
  window.webContents.once('destroyed', () => {
    service?.disposeOwner(owner).catch(() => console.error('Window process cleanup failed; session locks retained'));
  });
  window.once('closed', () => { if (mainWindow === window) mainWindow = null; });

  // Electron does not show the browser's beforeunload prompt automatically.
  mainWindow.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', title: '尚有未保存内容',
      message: '存在未保存的项目内容、对话进展，或后台识别尚未结束。确定离开吗？已发出的模型请求可能产生费用；重载页面可重新连接仍在运行的识别。',
      buttons: ['继续编辑', '放弃未保存内容并离开'], defaultId: 0, cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
  });

  // 窗口聚焦时清除 Dock 角标
  mainWindow.on('focus', () => {
    if (app.dock) app.dock.setBadge('');
  });

  // 安装版必须使用内置资源，不能被本机恰好运行的开发服务器劫持。
  const devServerUp = !app.isPackaged && await isDevServerRunning();
  if (devServerUp) {
    // 开发模式：加载 Vite dev server（支持热更新）
    mainWindow.loadURL('http://localhost:5170');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // 生产模式：加载打包产物
    mainWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'));
  }
}

// ─── IPC: 项目目录选择 ──────────────────────────────────
// ─── IPC: 剪贴板 ──────────────────────────────
// 走主进程 clipboard：渲染进程失焦时 Web Clipboard API 会失败，
// 且 sandboxed preload 无法直接 require clipboard 模块
handleIPC('clipboard:write-text', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

// ─── 应用菜单 ──────────────────────────────
// macOS 上 Cmd+C / Cmd+A / Cmd+V 等编辑快捷键依赖菜单 role 注册，
// 不设置菜单时渲染进程内的复制/全选会失效
function setupApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    ...(isMac
      ? [{
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            { role: 'close' },
          ],
        }]
      : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

handleIPC('dialog:open-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    registerRoot(result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});

// ─── IPC: 持久化存储 ────────────────────────────────────
handleIPC('store:get', (_e, key) => {
  if (key !== 'appState' || !store) throw new Error('Only appState is available');
  return store.get('appState');
});
handleIPC('store:set', (_e, key, value) => {
  if (key !== 'appState' || !store) throw new Error('Only appState is available');
  const result = store.set('appState', value);
  registerStoredRoots();
  return result;
});
handleIPC('store:reload', () => { store.load(); registerStoredRoots(); return store.get('appState'); });
// 渲染层 beforeunload 时的兜底落盘：fire-and-forget（invoke 在 unload 阶段不保证送达）
onIPC('store:flush', (_e, value) => {
  try { if (store) { store.set('appState', value); registerStoredRoots(); } }
  catch (error) { console.error('Failed to flush configuration:', error); }
});

// ─── IPC: owner-scoped actual service boundary ───────────
const CLAUDE_METHODS = {
  start: 'start', send: 'send', abort: 'interrupt', interrupt: 'interrupt', close: 'close', mode: 'mode',
  'runtime-state': 'runtimeState', context: 'getContext', compact: 'compact',
  respond: 'respond', 'history-list': 'historyList', 'history-read': 'historyRead',
  fork: 'fork', 'edit-fork': 'editFork', rewind: 'rewind', rename: 'rename',
};
for (const [channel, method] of Object.entries(CLAUDE_METHODS)) {
  handleIPC(`claude:${channel}`, async (event, payload) => {
    const result = await requireService()[method](payload, event.sender.id);
    if (['start', 'send'].includes(method) && result?.success) registerRoot(payload?.cwd);
    return result;
  });
}
handleIPC('claude:states', event => requireService().states(event.sender.id));
for (const [channel, method] of [['commands', 'getCommands'], ['mcp-status', 'getMcpStatus'], ['plan', 'getPlan']]) {
  handleIPC(`claude:${channel}`, (event, payload) => requireService().control(payload, event.sender.id, method));
}
// Legacy automatic title calls are deliberately zero-cost and do not query a model.
handleIPC('claude:generate-title', () => null);
handleIPC('claude:export-transcript', async (event, payload) => {
  try {
    const sourceRuntime = await runtime.resolve();
    const sourceRoot = sourceRuntime.env.CLAUDE_CONFIG_DIR || path.join(app.getPath('home'), '.claude');
    const text = await requireService().exportTranscript(payload, event.sender.id);
    if (event.sender.isDestroyed()) return { success: false, canceled: true };
    const defaultName = typeof payload.defaultName === 'string' ? path.basename(payload.defaultName).slice(0, 120) : 'session.jsonl';
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      defaultPath: defaultName, filters: [{ name: 'Original JSONL transcript', extensions: ['jsonl'] }],
    });
    if (result.canceled || !result.filePath || event.sender.isDestroyed()) return { success: false, canceled: true };
    const target = path.resolve(result.filePath);
    const currentRoot = (await runtime.resolve()).env.CLAUDE_CONFIG_DIR || path.join(app.getPath('home'), '.claude');
    if (path.resolve(currentRoot) !== path.resolve(sourceRoot)) throw new Error('Transcript root changed during export');
    const transcriptRoot = path.resolve(sourceRoot, 'projects');
    const realTarget = await fs.promises.realpath(path.dirname(target)).then(parent => path.join(parent, path.basename(target)));
    const realRoot = await fs.promises.realpath(transcriptRoot).catch(() => transcriptRoot);
    if ([transcriptRoot, realRoot].some(root => realTarget === root || realTarget.startsWith(root + path.sep))) throw new Error('Export into the live transcript root is not allowed');
    let initial;
    try { initial = await fs.promises.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (initial && (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1)) throw new Error('Unsafe export destination');
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    let ownsTemporary = false;
    try {
      const handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      ownsTemporary = true;
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      let current;
      try { current = await fs.promises.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (initial ? !current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== initial.dev || current.ino !== initial.ino || current.mtimeMs !== initial.mtimeMs || current.size !== initial.size : current) throw new Error('Export destination changed');
      assertSender(event);
      if (initial) {
        await fs.promises.rename(temporary, target);
        ownsTemporary = false;
      } else await fs.promises.link(temporary, target); // Exclusive creation, never replace a new concurrent file.
    } finally { if (ownsTemporary) await fs.promises.unlink(temporary).catch(() => {}); }
    return { success: true, path: target };
  } catch { return { success: false, error: 'Raw transcript export failed; no success confirmed' }; }
});
handleIPC('runtime:get', event => { requireService()._active(event.sender.id); return runtime.get(); });
handleIPC('runtime:diagnostics', event => { requireService()._active(event.sender.id); return runtime.diagnostics(); });
handleIPC('runtime:set', (event, options, storage) => {
  requireService()._active(event.sender.id);
  if (storage !== undefined && (!storage || typeof storage !== 'object' || Array.isArray(storage)
    || Object.keys(storage).some(key => key !== 'persist') || typeof storage.persist !== 'boolean')) throw new Error('Invalid runtime storage policy');
  return runtime.set(options, storage);
});
handleIPC('terminal:create', (event, spec) => requireService().nativeCreate(spec, event.sender.id));
handleIPC('terminal:health', event => requireService().terminalHealth(event.sender.id));
const TERMINAL_METHODS = {
  list: owner => terminalManager.list(owner),
  attach: (owner, id) => terminalManager.attach(id, owner),
  write: (owner, id, data) => terminalManager.write(id, data, owner),
  resize: (owner, id, cols, rows) => terminalManager.resize(id, cols, rows, owner),
  close: (owner, id) => terminalManager.close(id, owner),
};
for (const [method, operation] of Object.entries(TERMINAL_METHODS)) {
  handleIPC(`terminal:${method}`, (event, ...args) => {
    requireService()._active(event.sender.id);
    return operation(event.sender.id, ...args);
  });
}

// ─── IPC: real paginated file browser ────────────────────
function fileOptions(input, allowed) {
  return Object.fromEntries(allowed.filter(key => input?.[key] !== undefined).map(key => [key, input[key]]));
}
handleIPC('fs:read-file', (_event, payload = {}) => readPreview(payload.path,
  fileOptions(payload, ['offset', 'limit'])));
handleIPC('fs:open-external', async (_event, filePath) => {
  try {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) throw new Error();
    const ext = path.extname(filePath).toLowerCase();
    const allowed = new Set(['.txt', '.md', '.json', '.jsonl', '.csv', '.tsv', '.log', '.css', '.ts', '.tsx', '.jsx', '.js', '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.yaml', '.yml', '.toml', '.xml', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
    if (!allowed.has(ext) || await fs.promises.realpath(filePath) !== path.resolve(filePath)) throw new Error();
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111)) throw new Error();
    const preview = await readPreview(filePath);
    if (!preview.ok || !['text', 'image'].includes(preview.kind)) throw new Error();
    const error = await shell.openPath(filePath);
    if (error) throw new Error();
    return { success: true };
  } catch { return { success: false, error: 'Only non-executable local text/image files can be opened' }; }
});

// ─── IPC: 图片保存（粘贴截图 → 临时文件 → @ 引用）──
handleIPC('fs:save-image', (_e, { dataUrl } = {}) => saveImageDataUrl(dataUrl));

handleIPC('fs:read-dir', async (_event, dirPath, options) => {
  const page = await readDirectory(dirPath, options === undefined ? { limit: 500 }
    : fileOptions(options, ['offset', 'limit', 'showHidden', 'showIgnored']));
  return options === undefined ? page.items : page;
});

// ─── IPC: Skills（Claude Code 技能目录）───────────────
// 技能为 <skills根目录>/.../<skill名>/SKILL.md 结构，YAML frontmatter 提供 name/description。
// 全局根在 ~/.claude/skills，项目根在 <cwd>/.claude/skills。
const SKILL_SCAN_MAX_DEPTH = 4;
const SKILL_IGNORE = new Set(['node_modules', '.git']);

function skillRoots(cwd) {
  const roots = [{ scope: 'global', dir: path.join(app.getPath('home'), '.claude', 'skills') }];
  if (typeof cwd === 'string' && path.isAbsolute(cwd) && allowedRootPaths.has(path.resolve(cwd))) {
    roots.unshift({ scope: 'project', dir: path.join(cwd, '.claude', 'skills') });
  }
  return roots;
}

/** 解析 SKILL.md 的 YAML frontmatter（仅提取 name/description，不引依赖） */
function parseSkillFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: null, description: '' };
  let name = null;
  let description = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    const key = kv[1].toLowerCase();
    if (key === 'name') name = val;
    if (key === 'description') description = val;
  }
  return { name, description };
}

/** 递归扫描技能目录：层级越界/无 SKILL.md 即止，找到后不再深入该目录 */
async function scanSkills(root, scope, out) {
  async function walk(dir, depth) {
    if (depth > SKILL_SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 根目录不存在或不可读时静默跳过
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      try {
        const content = await fs.promises.readFile(path.join(dir, 'SKILL.md'), 'utf8');
        const { name, description } = parseSkillFrontmatter(content);
        out.push({ name: name || path.basename(dir), description, path: dir, scope });
      } catch {
        /* 单个 SKILL.md 读取失败不影响整体 */
      }
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || SKILL_IGNORE.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }
  await walk(root, 0);
}

handleIPC('skills:list', async (_e, cwd) => {
  const out = [];
  for (const { scope, dir } of skillRoots(cwd)) {
    await scanSkills(dir, scope, out);
  }
  return out;
});

handleIPC('skills:create', async (_e, payload) => {
  const { name, description, scope, cwd } = payload || {};
  // 目录名即技能名：限制为简洁的 kebab-case，防止路径注入
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    return { ok: false, error: '名称需为小写字母/数字/连字符，且以字母或数字开头' };
  }
  const root = skillRoots(cwd).find((r) => r.scope === scope);
  if (!root) return { ok: false, error: 'Skill root is not an approved global/project directory' };
  const skillDir = path.join(root.dir, name);
  if (fs.existsSync(skillDir)) {
    return { ok: false, error: `目录已存在：${skillDir}` };
  }
  try {
    await validateSkillAncestors(root.dir);
    await fs.promises.mkdir(root.dir, { recursive: true });
    await validateSkillAncestors(root.dir);
    await fs.promises.mkdir(skillDir);
    // description 输出为 YAML 双引号标量（JSON 字符串是合法的 YAML 双引号标量），防注入/转义问题
    const safeDesc = JSON.stringify(String(description || '').replace(/\s+/g, ' ').trim());
    const content = [
      '---',
      `name: ${name}`,
      `description: ${safeDesc}`,
      '---',
      '',
      `# ${name}`,
      '',
      '在这里编写技能说明：适用场景、使用方式与注意事项。',
      '',
    ].join('\n');
    await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf8');
    return { ok: true, path: skillDir };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

async function validateSkillAncestors(target) {
  const project = [...allowedRootPaths].filter(root => target === root || target.startsWith(root + path.sep)).sort((a, b) => b.length - a.length)[0];
  let current = project || app.getPath('home');
  // OS aliases such as macOS /var are allowed above the trusted root, never below it.
  const rootStat = await fs.promises.stat(current);
  if (!rootStat.isDirectory()) throw new Error('Invalid skill root');
  for (const part of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe linked skill directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function approvedSkillRoot(target) {
  const roots = [path.join(app.getPath('home'), '.claude', 'skills'), ...[...allowedRootPaths].map(cwd => path.join(cwd, '.claude', 'skills'))];
  return roots.find(root => { const relative = path.relative(root, target); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); });
}
// 删除只允许发生在已登记 skills 根目录之内，拒绝任何 symlink 祖先。
handleIPC('skills:delete', async (_e, skillPath) => {
  if (typeof skillPath !== 'string') return false;
  const resolved = path.resolve(skillPath);
  if (!path.isAbsolute(skillPath) || !approvedSkillRoot(resolved)) return false;
  try {
    await validateSkillAncestors(resolved);
    const marker = await fs.promises.lstat(path.join(resolved, 'SKILL.md'));
    if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1) return false;
    await fs.promises.rm(resolved, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
});

// 在系统文件管理器中定位技能目录（便于手动编辑/拖入第三方技能包）
handleIPC('skills:reveal', (_e, skillPath) => {
  if (typeof skillPath !== 'string') return false;
  const target = fs.existsSync(skillPath) && fs.statSync(skillPath).isDirectory()
    ? path.join(skillPath, 'SKILL.md')
    : skillPath;
  shell.showItemInFolder(target);
  return true;
});

// ─── IPC: 系统通知（长任务完成提醒）────────────────────
handleIPC('app:notify', (_e, { title, body }) => {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notification.show();
  // macOS Dock 角标提醒
  if (app.dock) app.dock.setBadge('●');
  return true;
});

// ─── IPC: 导出会话为 Markdown ─────────────────────────
handleIPC('export:save-markdown', async (_e, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, 'utf8');
  return result.filePath;
});

handleIPC('export:save-json', async (_e, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, 'utf8');
  return result.filePath;
});

// ─── IPC: 窗口控制 ──────────────────────────────────────
handleIPC('window:minimize', () => mainWindow && mainWindow.minimize());
handleIPC('window:maximize', () => {
  if (mainWindow && mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else if (mainWindow) {
    mainWindow.maximize();
  }
});
handleIPC('window:close', () => mainWindow && mainWindow.close());

// 单实例锁：多开实例会同时读写同一份配置文件，并各自持有 runner 状态互相干扰
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 二次启动时唤起已有窗口而非开新实例
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // dev 模式下 macOS Dock 默认显示 Electron 图标，这里换成自定义图标
    // （打包版由 app bundle 提供图标，build/icon.png 不在包内，existsSync 兜底）
    if (process.platform === 'darwin' && app.dock) {
      const iconPath = path.join(__dirname, '../../build/icon.png');
      if (fs.existsSync(iconPath)) {
        app.dock.setIcon(iconPath);
      }
    }
    setupApplicationMenu();
    installBgMediaProtocol();
    store = new Store();
    registerStoredRoots();
    const runtimeStore = new Store({ filePath: path.join(app.getPath('userData'), 'claude-gui-runtime.json') });
    runtime = new ClaudeRuntime({ store: runtimeStore, safeStorage, home: app.getPath('home') });
    const ownership = new SessionOwnership();
    const getRuntime = () => runtime.resolve();
    const acquireSession = (id, owner) => ownership.acquire(id.toLowerCase(), owner);
    const history = new SessionHistory({ getRuntime, acquireSession, home: app.getPath('home') });
    terminalManager = new NativeTerminalManager({ getRuntime, acquireSession,
      sendEvent: (channel, payload) => ownerSend(payload.ownerWebContentsId, channel, payload) });
    service = new ClaudeService({ runtime, history, terminalManager, ownership, sendEvent: ownerSend, forceKill: forceKillOwnedProcesses });
    projects = new ProjectsBackend({
      home: app.getPath('home'),
      userData: app.getPath('userData'),
      revealFile: (filePath) => shell.showItemInFolder(filePath),
    });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  let quitReady = false;
  let quitCleanup = null;
  // Headless/automation launches (desktop regression) have no one to answer a
  // native quit dialog. Still attempt the same confirmed cleanup, then force
  // exit, so a broken shutdown fails the test instead of hanging forever.
  const nonInteractiveQuit = process.env.CLAUDE_GUI_NONINTERACTIVE === '1';
  app.on('before-quit', event => {
    if (quitReady || !service) return;
    event.preventDefault();
    if (quitCleanup) return;
    processSnapshot = captureOwnedProcessGroups();
    quitCleanup = (async () => {
      while (true) {
        try {
          await service.disposeAll();
          quitReady = true; app.quit();
          return;
        } catch (cleanupError) {
          if (nonInteractiveQuit) {
            console.error('Quit cleanup failed in noninteractive mode:', cleanupError?.message || cleanupError);
            await service.forceDisposeAll();
            app.exit(1);
            return;
          }
          const { response } = await dialog.showMessageBox({
            type: 'warning', title: '后台进程尚未确认退出',
            message: '清理失败，不能确认所有 Claude 子进程已退出。',
            detail: '重试会继续清理。强制退出会先尝试终止本应用拥有的进程；若终止失败，后台进程可能继续运行并产生费用。不会删除会话或项目文件。',
            buttons: ['重试清理', '强制退出'], defaultId: 0, cancelId: 0, noLink: true,
          });
          if (response === 1) {
            await service.forceDisposeAll();
            app.exit(1);
            return;
          }
        }
      }
    })().catch(() => {
      console.error('Quit cleanup/dialog failed; application retained');
    }).finally(() => { quitCleanup = null; });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
