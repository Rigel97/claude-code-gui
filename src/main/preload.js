const { contextBridge, ipcRenderer, webUtils } = require('electron');

const api = {
  openDirectory: () => ipcRenderer.invoke('dialog:open-directory'),

  // 复制文本：走主进程 clipboard（渲染进程失焦时 Web Clipboard API 会失败）
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  },

  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    // beforeunload 兜底落盘：fire-and-forget，unload 阶段 invoke 不保证送达
    flush: (value) => ipcRenderer.send('store:flush', value),
  },

  claude: {
    send: (payload) => ipcRenderer.invoke('claude:send', payload),
    abort: () => ipcRenderer.invoke('claude:abort'),
    // 零成本查询会话当前上下文占用（/context 本地命令）
    getContext: (cwd, sessionId) => ipcRenderer.invoke('claude:context', { cwd, sessionId }),
    // 压缩会话上下文（/compact，需一次总结调用）；返回 { success, error?, context? }
    compact: (cwd, sessionId) => ipcRenderer.invoke('claude:compact', { cwd, sessionId }),

    onStream: (callback) => {
      const handler = (_e, data) => callback(data);
      ipcRenderer.on('claude:stream', handler);
      return () => ipcRenderer.removeListener('claude:stream', handler);
    },

    onStatusChange: (callback) => {
      const handler = (_e, status) => callback(status);
      ipcRenderer.on('claude:status', handler);
      return () => ipcRenderer.removeListener('claude:status', handler);
    },
  },

  fs: {
    readDir: (dirPath) => ipcRenderer.invoke('fs:read-dir', dirPath),
    // 粘贴的图片（dataURL）存为临时文件，返回绝对路径供 @ 引用
    saveImage: (dataUrl) => ipcRenderer.invoke('fs:save-image', { dataUrl }),
  },

  skills: {
    list: (cwd) => ipcRenderer.invoke('skills:list', cwd),
    create: (payload) => ipcRenderer.invoke('skills:create', payload),
    delete: (skillPath) => ipcRenderer.invoke('skills:delete', skillPath),
    reveal: (skillPath) => ipcRenderer.invoke('skills:reveal', skillPath),
  },

  // 拖入窗口的 File 对象取真实路径（Electron 32+ 移除了 File.path，必须走 webUtils）
  getFilePath: (file) => webUtils.getPathForFile(file),

  notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),

  exportMarkdown: (defaultName, content) => ipcRenderer.invoke('export:save-markdown', { defaultName, content }),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
};

contextBridge.exposeInMainWorld('api', api);
