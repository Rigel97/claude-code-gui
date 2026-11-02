const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class Store {
  constructor({ filePath } = {}) {
    this.filePath = filePath ?? path.join(require('electron').app.getPath('userData'), 'claude-gui-config.json');
    this.data = {};
    this.lastSerialized = '{}';
    this.loadError = null;
    // Keep Electron startup alive; access remains blocked until an explicit load succeeds.
    try {
      this.load();
    } catch (err) {
      this.loadError = err;
    }
  }

  load() {
    try {
      let content;
      try {
        content = fs.readFileSync(this.filePath, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const data = content === undefined ? {} : JSON.parse(content);
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Config root must be a JSON object');
      }
      const serialized = JSON.stringify(data);
      this.data = data;
      this.lastSerialized = serialized;
      this.loadError = null;
    } catch (cause) {
      const error = new Error(`Config load failed (${this.filePath}): ${cause.code || cause.message}`, { cause });
      if (cause.code) error.code = cause.code;
      this.loadError = error;
      throw error;
    }
  }

  save(serialized) {
    if (this.loadError) throw this.loadError;
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    let fd;
    let ownsTmp = false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fd = fs.openSync(tmpPath, 'wx', 0o600);
      ownsTmp = true;
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmpPath, this.filePath);
      ownsTmp = false;
    } catch (cause) {
      const error = new Error(`Config save failed (${this.filePath}): ${cause.code || cause.message}`, { cause });
      if (cause.code) error.code = cause.code;
      throw error;
    } finally {
      // Cleanup must not replace the original write error or remove an unowned file.
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* Best effort after IO failure. */ }
      }
      if (ownsTmp) {
        try { fs.unlinkSync(tmpPath); } catch { /* Best effort after IO failure. */ }
      }
    }
  }

  get(key) {
    if (this.loadError) throw this.loadError;
    return this.data[key];
  }

  set(key, value) {
    if (this.loadError) throw this.loadError;
    const nextData = { ...this.data, [key]: value };
    const serialized = JSON.stringify(nextData);
    // 内容无变化时跳过同步写盘：渲染层节流之外的第二道闸，
    // 避免重复快照的空转 IO 阻塞主进程
    if (serialized === this.lastSerialized) return;
    this.save(serialized);
    this.data = nextData;
    this.lastSerialized = serialized;
  }
}

module.exports = { Store };
