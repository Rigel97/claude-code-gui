// 清除可能存在的 ELECTRON_RUN_AS_NODE，确保以完整 Electron 模式运行
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
    const req = http.get('http://localhost:5173', () => resolve(true));
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

  const devServerUp = await isDevServerRunning();
  if (devServerUp) {
    // 开发模式：加载 Vite dev server（支持热更新）
    mainWindow.loadURL('http://localhost:5173');
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
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
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

app.whenReady().then(() => {
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
