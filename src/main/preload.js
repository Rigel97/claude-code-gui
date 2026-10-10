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

  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    prepare: (data) => ipcRenderer.invoke('projects:prepare', data),
    scan: (data) => ipcRenderer.invoke('projects:scan', data),
    cancelScan: (requestId) => ipcRenderer.invoke('projects:cancelScan', requestId),
    onScanProgress: (callback) => {
      const handler = (_event, progress) => callback(progress);
      ipcRenderer.on('projects:progress', handler);
      return () => ipcRenderer.removeListener('projects:progress', handler);
    },
    confirm: (scanId, reviews) => ipcRenderer.invoke('projects:confirm', scanId, reviews),
    update: (project) => ipcRenderer.invoke('projects:update', project),
    reveal: (filePath) => ipcRenderer.invoke('projects:reveal', filePath),
  },

  claude: {
    send: (payload) => ipcRenderer.invoke('claude:send', payload),
    // 中断指定对话（多标签页各自的 runner）
    abort: (conversationId) => ipcRenderer.invoke('claude:abort', conversationId),
    // 零成本查询会话当前上下文占用（/context 本地命令）
    getContext: (cwd, sessionId) => ipcRenderer.invoke('claude:context', { cwd, sessionId }),
    // 压缩会话上下文（/compact，需一次总结调用）；返回 { success, error?, context? }
    compact: (cwd, sessionId) => ipcRenderer.invoke('claude:compact', { cwd, sessionId }),
    // AI 自动命名：传入首条用户消息文本，返回标题或 null（失败静默）
    generateTitle: (cwd, text) => ipcRenderer.invoke('claude:generate-title', { cwd, text }),

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
    // 文件预览：返回 { ok, kind: 'text'|'image', content?, dataUrl?, size, truncated? }
    readFile: (filePath) => ipcRenderer.invoke('fs:read-file', { path: filePath }),
  },

  git: {
    // 返回 { repo, branch?, changes?: [{path, change, staged}] }
    status: (cwd) => ipcRenderer.invoke('git:status', cwd),
    // 单文件 unified diff 文本（无差异返回 ''）
    diff: (cwd, filePath) => ipcRenderer.invoke('git:diff', { cwd, path: filePath }),
    // 回滚单文件工作区改动，返回 { ok, error? }
    checkoutFile: (cwd, filePath) => ipcRenderer.invoke('git:checkout', { cwd, path: filePath }),
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
