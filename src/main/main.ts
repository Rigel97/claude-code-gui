const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { ClaudeRunner } = require('./runner');
const { Store } = require('./store');

let mainWindow = null;
const runner = new ClaudeRunner();
const store = new Store();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#05070d',
    titleBarStyle: 'hiddenInset',
    frame: process.platform === 'darwin' ? false : true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist-renderer/index.html'));
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

// ─── IPC: 获取历史会话列表 ──────────────────────────────
ipcMain.handle('claude:list-sessions', async (_e, cwd) => {
  return runner.listSessions(cwd);
});

// ─── IPC: 恢复历史会话 ──────────────────────────────────
ipcMain.handle('claude:resume-session', async (_e, payload) => {
  return runner.send({
    prompt: '',
    cwd: payload.cwd,
    sessionId: payload.sessionId,
    resume: true,
  });
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
