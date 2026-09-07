// 防 ELECTRON_RUN_AS_NODE 污染：该变量会让 Electron 以纯 Node 模式运行，
// 导致窗口不弹出、跑完脚本即退出（launchd 全局环境被某些工具 setenv 时会踩中）。
// 模式在二进制启动时就已决定，进程内 delete 无效，必须以干净环境重新拉起自身。
if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE;
  require('child_process')
    .spawn(process.argv[0], process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      env: process.env, // 此时变量已从 process.env 中删除，子进程将以 GUI 模式启动
    })
    .unref();
  process.exit(0);
}

const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { ClaudeRunner } = require('./runner');
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
  return runner.send(payload);
});

ipcMain.handle('claude:abort', () => {
  runner.abort();
  return true;
});

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
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
