const fs = require('fs');
const path = require('path');
const os = require('os');

const EXT_BY_MIME = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp', bmp: 'bmp' };

/**
 * 把渲染层粘贴的 dataURL 图片写入临时目录，返回绝对路径（供 @ 引用发给 CLI）。
 * 失败返回 null。放在 os.tmpdir() 下的 claude-gui-images/，不污染项目目录；
 * 系统会周期性清理 tmp，图片只在即时会话内有意义。
 */
function saveImageDataUrl(dataUrl) {
  const m = /^data:image\/([\w+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  let buf;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch {
    return null;
  }
  if (!buf || buf.length === 0) return null;
  const ext = EXT_BY_MIME[m[1].toLowerCase()] || 'png';
  try {
    const dir = path.join(os.tmpdir(), 'claude-gui-images');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
    fs.writeFileSync(file, buf);
    return file;
  } catch {
    return null;
  }
}

module.exports = { saveImageDataUrl };
