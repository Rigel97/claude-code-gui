const fs = require('node:fs');
const path = require('node:path');
const IGNORED = new Set(['node_modules', '.git', 'dist', 'dist-renderer', 'build', 'out', '.next', '__pycache__', 'target', '.venv', 'venv', 'coverage', '.idea', '.vscode']);

function validatePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('非法路径：仅支持本地绝对路径');
}
function validateOptions(options, max, defaultLimit, allowZero = true) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('非法分页参数');
  const { offset = 0, limit = defaultLimit } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < (allowZero ? 0 : 1) || limit > max) throw new Error('非法分页参数');
  return { offset, limit };
}

async function readDirectory(dirPath, options = {}) {
  let offset = 0;
  try {
    validatePath(dirPath);
    const page = validateOptions(options, 500, 200);
    offset = page.offset;
    const { showHidden = false, showIgnored = false } = options;
    if (typeof showHidden !== 'boolean' || typeof showIgnored !== 'boolean') throw new Error('非法过滤参数');
    const stat = await fs.promises.lstat(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('不是常规目录（不展开符号链接）');
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const items = entries.filter(entry => (showHidden || !entry.name.startsWith('.')) && (showIgnored || !entry.isDirectory() || !IGNORED.has(entry.name)))
      .map(entry => ({ name: entry.name, path: path.join(dirPath, entry.name), isDir: entry.isDirectory(), isSymlink: entry.isSymbolicLink() }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (offset > items.length) throw new Error('目录已变化或分页偏移超出范围，请刷新');
    const end = Math.min(offset + page.limit, items.length);
    return { items: items.slice(offset, end), total: items.length, offset, nextOffset: end < items.length ? end : null };
  } catch (error) {
    return { items: [], total: 0, offset, nextOffset: null, error: error.message || String(error) };
  }
}
const TEXT_MAX = 512 * 1024;
const IMAGE_MAX = 8 * 1024 * 1024;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };

// At most three trailing bytes can belong to an incomplete UTF-8 codepoint.
function completeEnd(buffer, eof) {
  if (eof || !buffer.length) return buffer.length;
  let start = buffer.length - 1;
  while (start >= 0 && (buffer[start] & 0xc0) === 0x80 && buffer.length - start <= 4) start--;
  if (start < 0) return buffer.length;
  const lead = buffer[start];
  const width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
  return buffer.length - start < width ? start : buffer.length;
}
async function readBytes(handle, length, offset) {
  const buffer = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const { bytesRead } = await handle.read(buffer, count, length - count, offset + count);
    if (!bytesRead) break;
    count += bytesRead;
  }
  return buffer.subarray(0, count);
}
function fileVersion(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
async function readPreview(filePath, options = {}) {
  let handle;
  let offset = 0;
  let size = 0;
  let kind = 'text';
  try {
    validatePath(filePath);
    const page = validateOptions(options, TEXT_MAX, TEXT_MAX, false);
    offset = page.offset;
    const initial = await fs.promises.lstat(filePath);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error('不是常规文件（不读取符号链接）');
    // NONBLOCK avoids hanging on a FIFO swapped in between lstat and open.
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== initial.ino || stat.dev !== initial.dev) throw new Error('文件已变化，请重新读取');
    size = stat.size;
    const version = fileVersion(stat);
    if (offset > size) throw new Error('分页偏移超出文件范围，文件可能已变化，请回到首页');
    const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()];
    if (mime) {
      kind = 'image';
      if (offset !== 0) throw new Error('图片不支持字节分页');
      if (size > IMAGE_MAX) throw new Error('图片超过 8MB，请在外部打开');
      const buffer = await readBytes(handle, size, 0);
      if (buffer.length !== size || fileVersion(await handle.stat()) !== version) throw new Error('文件已变化，请重新读取');
      return { ok: true, kind, content: '', size, offset: 0, nextOffset: null, truncated: false, dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, version };
    }
    const head = await readBytes(handle, Math.min(8192, size), 0);
    try {
      if (head.includes(0)) throw new Error('binary');
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(head.subarray(0, completeEnd(head, head.length === size)));
    } catch {
      kind = 'binary';
      throw new Error('二进制或非 UTF-8 文件，请在外部打开');
    }
    const buffer = await readBytes(handle, Math.min(page.limit, size - offset), offset);
    if (buffer.length && (buffer[0] & 0xc0) === 0x80) throw new Error('偏移不在 UTF-8 字符边界，请回到首页');
    const end = completeEnd(buffer, offset + buffer.length === size);
    if (!end && buffer.length) throw new Error('分页上限不足以容纳一个完整 UTF-8 字符');
    let content;
    try {
      if (buffer.includes(0)) throw new Error('binary');
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, end));
    } catch {
      kind = 'binary';
      throw new Error('二进制或非 UTF-8 文件，请在外部打开');
    }
    if (buffer.length !== Math.min(page.limit, size - offset) || fileVersion(await handle.stat()) !== version) throw new Error('文件已变化，请重新读取');
    const nextOffset = offset + end < size ? offset + end : null;
    return { ok: true, kind, content, size, offset, nextOffset, truncated: offset > 0 || nextOffset !== null, version };
  } catch (error) {
    return { ok: false, kind, content: '', size, offset, nextOffset: null, truncated: false, error: error.message || String(error) };
  } finally {
    if (handle) await handle.close();
  }
}
module.exports = { readDirectory, readPreview };
