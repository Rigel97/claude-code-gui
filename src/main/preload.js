const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  openExternal: url => ipcRenderer.invoke('app:open-external', url),
  runtime: {
    get: () => ipcRenderer.invoke('runtime:get'),
    set: (options, storage) => ipcRenderer.invoke('runtime:set', options, storage),
    diagnostics: () => ipcRenderer.invoke('runtime:diagnostics'),
  },
  terminal: {
    create: spec => ipcRenderer.invoke('terminal:create', spec),
    list: () => ipcRenderer.invoke('terminal:list'),
    attach: id => ipcRenderer.invoke('terminal:attach', id),
    write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    close: id => ipcRenderer.invoke('terminal:close', id),
    health: () => ipcRenderer.invoke('terminal:health'),
    onData: callback => subscribe('native-terminal:data', callback),
    onExit: callback => subscribe('native-terminal:exit', callback),
  },
  openDirectory: () => ipcRenderer.invoke('dialog:open-directory'),

  // 复制文本：走主进程 clipboard（渲染进程失焦时 Web Clipboard API 会失败）
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  },

  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    reload: () => ipcRenderer.invoke('store:reload'),
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
    create: (input) => ipcRenderer.invoke('projects:create', input),
    archive: (id, archived) => ipcRenderer.invoke('projects:archive', id, archived),
    remove: (id, deleted) => ipcRenderer.invoke('projects:remove', id, deleted),
    merge: (sourceId, targetId) => ipcRenderer.invoke('projects:merge', sourceId, targetId),
    reveal: (filePath) => ipcRenderer.invoke('projects:reveal', filePath),
    patch: (request) => ipcRenderer.invoke('projects:patch', request),
    activeJob: () => ipcRenderer.invoke('projects:activeJob'),
    discardPlan: (planId) => ipcRenderer.invoke('projects:discardPlan', planId),
    reviewDraft: () => ipcRenderer.invoke('projects:reviewDraft'),
    saveReviewDraft: (draft) => ipcRenderer.invoke('projects:saveReviewDraft', draft),
    linkConversation: (id, link) => ipcRenderer.invoke('projects:linkConversation', id, link),
    recordConversation: (conversationId, result) => ipcRenderer.invoke('projects:recordConversation', conversationId, result),
    reload: () => ipcRenderer.invoke('projects:reload'),
    storageInfo: () => ipcRenderer.invoke('projects:storageInfo'),
    purge: (id) => ipcRenderer.invoke('projects:purge', id),
    restoreBackup: () => ipcRenderer.invoke('projects:restoreBackup'),
  },

  claude: {
    start: payload => ipcRenderer.invoke('claude:start', payload),
    interrupt: payload => ipcRenderer.invoke('claude:interrupt', payload),
    close: payload => ipcRenderer.invoke('claude:close', payload),
    // Explicit read-only snapshot: no bootstrap, prompt, polling or implicit model call.
    runtimeState: payload => ipcRenderer.invoke('claude:runtime-state', payload),
    states: () => ipcRenderer.invoke('claude:states'),
    getRunners: () => ipcRenderer.invoke('claude:states'),
    commands: payload => ipcRenderer.invoke('claude:commands', payload),
    mcpStatus: payload => ipcRenderer.invoke('claude:mcp-status', payload),
    mode: payload => ipcRenderer.invoke('claude:mode', payload),
    respond: payload => ipcRenderer.invoke('claude:respond', payload),
    plan: payload => ipcRenderer.invoke('claude:plan', payload),
    historyList: payload => ipcRenderer.invoke('claude:history-list', payload),
    historyRead: payload => ipcRenderer.invoke('claude:history-read', payload),
    fork: payload => ipcRenderer.invoke('claude:fork', payload),
    editFork: payload => ipcRenderer.invoke('claude:edit-fork', payload),
    rewind: payload => ipcRenderer.invoke('claude:rewind', payload),
    rename: payload => ipcRenderer.invoke('claude:rename', payload),
    exportTranscript: payload => ipcRenderer.invoke('claude:export-transcript', payload),
    onRuntime: callback => subscribe('claude:runtime', callback),
    onRuntimeChange: callback => subscribe('claude:runtime', callback),
    send: (payload) => ipcRenderer.invoke('claude:send', payload),
    // 中断指定对话（多标签页各自的 runner）
    abort: (conversationId) => ipcRenderer.invoke('claude:abort', conversationId),
    // 优先读取 live SDK context；不支持时交由主进程执行可取消的 /context CLI。
    getContext: (cwd, sessionId, conversationId) => ipcRenderer.invoke('claude:context', typeof cwd === 'object' ? cwd : { cwd, sessionId, conversationId }),
    // 压缩会话上下文（/compact，需一次总结调用）；返回 { success, error?, context? }
    compact: (cwd, sessionId, conversationId) => ipcRenderer.invoke('claude:compact', typeof cwd === 'object' ? cwd : { cwd, sessionId, conversationId }),
    // Legacy API 保留兼容；主进程返回 null，不进行自动命名模型调用。
    generateTitle: (cwd, text) => ipcRenderer.invoke('claude:generate-title', { cwd, text }),

    onStream: (callback) => {
      const handler = (_e, data) => callback(data);
      ipcRenderer.on('claude:stream', handler);
      // Legacy App uses this metadata-only branch; consumers should choose this OR onRuntime, not both.
      const runtimeHandler = (_event, state) => callback({ type: 'system', subtype: 'runtime', conversationId: state.conversationId, runId: state.runId, state });
      ipcRenderer.on('claude:runtime', runtimeHandler);
      return () => {
        ipcRenderer.removeListener('claude:stream', handler);
        ipcRenderer.removeListener('claude:runtime', runtimeHandler);
      };
    },

    onStatusChange: (callback) => {
      const handler = (_e, status) => callback(status);
      ipcRenderer.on('claude:status', handler);
      return () => ipcRenderer.removeListener('claude:status', handler);
    },
  },

  fs: {
    readDir: (dirPath, options) => ipcRenderer.invoke('fs:read-dir', dirPath, options),
    openExternal: filePath => ipcRenderer.invoke('fs:open-external', filePath),
    // 粘贴的图片（dataURL）存为临时文件，返回绝对路径供 @ 引用
    saveImage: (dataUrl) => ipcRenderer.invoke('fs:save-image', { dataUrl }),
    // 文件预览：返回 { ok, kind: 'text'|'image', content?, dataUrl?, size, truncated? }
    readFile: (filePath, options) => ipcRenderer.invoke('fs:read-file', { ...options, path: filePath }),
  },
  skills: {
    list: (cwd) => ipcRenderer.invoke('skills:list', cwd),
    create: (payload) => ipcRenderer.invoke('skills:create', payload),
    delete: (skillPath) => ipcRenderer.invoke('skills:delete', skillPath),
    reveal: (skillPath) => ipcRenderer.invoke('skills:reveal', skillPath),
  },

  // 动态视频背景：选择本机视频 / 重新登记播放路径（主进程 bgmedia:// 协议提供流）
  videoBg: {
    // 弹出系统选框选择视频文件，返回绝对路径或 null（取消）
    pick: () => ipcRenderer.invoke('dialog:open-video'),
    // 启动恢复时把持久化的路径重新登记进主进程白名单
    setPath: (filePath) => ipcRenderer.invoke('video-bg:set-path', filePath),
    // 清除登记（关闭视频背景时释放白名单）
    clear: () => ipcRenderer.invoke('video-bg:clear'),
  },

  // 拖入窗口的 File 对象取真实路径（Electron 32+ 移除了 File.path，必须走 webUtils）
  getFilePath: (file) => webUtils.getPathForFile(file),

  notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),

  exportMarkdown: (defaultName, content) => ipcRenderer.invoke('export:save-markdown', { defaultName, content }),
  exportJson: (defaultName, content) => ipcRenderer.invoke('export:save-json', { defaultName, content }),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
};

contextBridge.exposeInMainWorld('api', api);
