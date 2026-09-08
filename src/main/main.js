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

const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { ClaudeRunner, queryContext, compactSession } = require('./runner');
const { saveImageDataUrl } = require('./images');
const { Store } = require('./store');

let mainWindow = null;
let runner = null;
let store = null;

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
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 仅放行本地页面（生产 file:// 与 dev server），其余导航拦截并转交系统浏览器
    const isLocal = url.startsWith('file://') || url.startsWith('http://localhost:5170');
    if (!isLocal) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // 窗口聚焦时清除 Dock 角标
  mainWindow.on('focus', () => {
    if (app.dock) app.dock.setBadge('');
  });

  const devServerUp = await isDevServerRunning();
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
ipcMain.handle('clipboard:write-text', (_e, text) => {
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

ipcMain.handle('dialog:open-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// ─── IPC: 持久化存储 ────────────────────────────────────
ipcMain.handle('store:get', (_e, key) => store.get(key));
ipcMain.handle('store:set', (_e, key, value) => store.set(key, value));
// 渲染层 beforeunload 时的兜底落盘：fire-and-forget（invoke 在 unload 阶段不保证送达）
ipcMain.on('store:flush', (_e, value) => {
  if (store) store.set('appState', value);
});

// ─── IPC: Claude Code 执行 ──────────────────────────────
ipcMain.handle('claude:send', async (_e, payload) => {
  await auxCommandLock;
  return runner.send(payload);
});

ipcMain.handle('claude:abort', () => {
  runner.abort();
  return true;
});

// 零成本查询某会话的当前上下文占用（内部跑 /context 本地命令，不调 API）。
// 一次性命令与正式生成互斥：压缩期间到达的 send 排队等待，
// 避免两个进程并发读写同一会话；反之生成中前端已禁用压缩按钮
let auxCommandLock = Promise.resolve();
function withAuxLock(fn) {
  const prev = auxCommandLock;
  let release;
  auxCommandLock = new Promise((r) => (release = r));
  return prev.then(fn).finally(release);
}

ipcMain.handle('claude:context', (_e, payload) => withAuxLock(() => queryContext(payload || {})));

// 压缩会话上下文（CLI /compact，需一次总结调用）；返回压缩后的新占用
ipcMain.handle('claude:compact', (_e, payload) => withAuxLock(() => compactSession(payload || {})));

// ─── IPC: 图片保存（粘贴截图 → 临时文件 → @ 引用）──
ipcMain.handle('fs:save-image', (_e, { dataUrl } = {}) => saveImageDataUrl(dataUrl));

// ─── IPC: 文件树（懒加载目录）──────────────────────────
const FS_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'dist-renderer', 'build', 'out', '.next',
  '__pycache__', 'target', '.venv', 'venv', 'coverage', '.idea', '.vscode',
]);

ipcMain.handle('fs:read-dir', async (_e, dirPath) => {
  try {
    if (typeof dirPath !== 'string') return [];
    // 异步读取：大目录的同步 IO 会阻塞主进程（IPC/窗口事件）
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      // 跳过隐藏文件与常见噪音目录
      if (entry.name.startsWith('.')) continue;
      if (FS_IGNORE.has(entry.name)) continue;
      items.push({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDir: entry.isDirectory(),
      });
    }
    // 目录优先，按名称排序
    items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return items.slice(0, 500);
  } catch {
    return [];
  }
});

// ─── IPC: Skills（Claude Code 技能目录）───────────────
// 技能为 <skills根目录>/.../<skill名>/SKILL.md 结构，YAML frontmatter 提供 name/description。
// 全局根在 ~/.claude/skills，项目根在 <cwd>/.claude/skills。
const SKILL_SCAN_MAX_DEPTH = 4;
const SKILL_IGNORE = new Set(['node_modules', '.git']);

function skillRoots(cwd) {
  const roots = [{ scope: 'global', dir: path.join(app.getPath('home'), '.claude', 'skills') }];
  if (typeof cwd === 'string' && cwd) {
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

ipcMain.handle('skills:list', async (_e, cwd) => {
  const out = [];
  for (const { scope, dir } of skillRoots(cwd)) {
    await scanSkills(dir, scope, out);
  }
  return out;
});

ipcMain.handle('skills:create', async (_e, payload) => {
  const { name, description, scope, cwd } = payload || {};
  // 目录名即技能名：限制为简洁的 kebab-case，防止路径注入
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    return { ok: false, error: '名称需为小写字母/数字/连字符，且以字母或数字开头' };
  }
  const root = skillRoots(cwd).find((r) => r.scope === scope) || skillRoots(cwd)[0];
  const skillDir = path.join(root.dir, name);
  if (fs.existsSync(skillDir)) {
    return { ok: false, error: `目录已存在：${skillDir}` };
  }
  try {
    await fs.promises.mkdir(skillDir, { recursive: true });
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

// 删除只允许发生在 skills 根目录之内，且目录必须含 SKILL.md（防误删/越权删任意目录）
ipcMain.handle('skills:delete', async (_e, skillPath) => {
  if (typeof skillPath !== 'string') return false;
  const resolved = path.resolve(skillPath);
  const globalRoot = path.join(app.getPath('home'), '.claude', 'skills');
  const inSkillsTree =
    resolved.startsWith(globalRoot + path.sep) ||
    resolved.split(path.sep).join('/').includes('/.claude/skills/');
  if (!inSkillsTree) return false;
  if (!fs.existsSync(path.join(resolved, 'SKILL.md'))) return false;
  try {
    await fs.promises.rm(resolved, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
});

// 在系统文件管理器中定位技能目录（便于手动编辑/拖入第三方技能包）
ipcMain.handle('skills:reveal', (_e, skillPath) => {
  if (typeof skillPath !== 'string') return false;
  const target = fs.existsSync(skillPath) && fs.statSync(skillPath).isDirectory()
    ? path.join(skillPath, 'SKILL.md')
    : skillPath;
  shell.showItemInFolder(target);
  return true;
});

// ─── IPC: 系统通知（长任务完成提醒）────────────────────
ipcMain.handle('app:notify', (_e, { title, body }) => {
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
ipcMain.handle('export:save-markdown', async (_e, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, 'utf8');
  return result.filePath;
});

// ─── IPC: 窗口控制 ──────────────────────────────────────
ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow && mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else if (mainWindow) {
    mainWindow.maximize();
  }
});
ipcMain.handle('window:close', () => mainWindow && mainWindow.close());

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
    runner = new ClaudeRunner();
    store = new Store();
    setupApplicationMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
