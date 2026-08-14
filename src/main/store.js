const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Store {
  constructor() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'claude-gui-config.json');
    this.data = {};
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf8');
        this.data = JSON.parse(content);
      }
    } catch {
      this.data = {};
    }
  }

  save() {
    try {
      // 原子写：先写临时文件再 rename，避免写入中途崩溃导致整个配置损坏
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.data));
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }
}

module.exports = { Store };
