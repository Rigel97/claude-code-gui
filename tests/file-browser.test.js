import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let root;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-browser-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const api = () => require('../src/main/file-browser.js');

it('隐藏与忽略目录独立切换、零上限与无效参数、读取错误不伪装空目录', async () => {
  for (const name of ['.git', 'node_modules', 'src']) await fs.mkdir(path.join(root, name));
  await fs.writeFile(path.join(root, '.env'), 'secret');
  await fs.writeFile(path.join(root, 'dist'), 'ordinary file');
  expect((await api().readDirectory(root, { showHidden: true })).items.map(x => x.name)).toEqual(['src', '.env', 'dist']);
  expect((await api().readDirectory(root, { showIgnored: true })).items.map(x => x.name)).toEqual(['node_modules', 'src', 'dist']);
  expect((await api().readDirectory(root, { showHidden: true, showIgnored: true })).total).toBe(5);
  expect(await api().readDirectory(root, { limit: 0 })).toMatchObject({ items: [], total: 2, offset: 0, nextOffset: 0 });
  for (const options of [null, [], { limit: 501 }, { limit: -1 }, { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { showHidden: 'yes' }, { showIgnored: 1 }]) {
    expect((await api().readDirectory(root, options)).error).toBeTruthy();
  }
  expect((await api().readDirectory(path.join(root, 'missing'))).error).toMatch(/ENOENT/);
  expect((await api().readDirectory('relative')).error).toBeTruthy();
  await fs.symlink(root, path.join(root, 'link'));
  expect((await api().readDirectory(path.join(root, 'link'))).error).toBeTruthy();
});

it('UTF8 英文中文 emoji 跨每个边界分页拼接不丢字且偏移是真实字节', async () => {
  const file = path.join(root, 'unicode.txt');
  const text = 'AB中😀文XYZ🚀尾';
  await fs.writeFile(file, text);
  for (const limit of [4, 5, 6, 7, 8, 9, 10]) {
    let offset = 0;
    let joined = '';
    do {
      const page = await api().readPreview(file, { offset, limit });
      expect(page.ok).toBe(true);
      expect(page.kind).toBe('text');
      expect(page.offset).toBe(offset);
      expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(limit);
      joined += page.content;
      const end = offset + Buffer.byteLength(page.content);
      expect(page.nextOffset).toBe(end < Buffer.byteLength(text) ? end : null);
      expect(page.truncated).toBe(offset > 0 || end < Buffer.byteLength(text));
      offset = page.nextOffset;
    } while (offset !== null);
    expect(joined).toBe(text);
  }
});

it('大文本末页、空文件、BOM、无效偏移与参数、文件变化可辨识', async () => {
  const file = path.join(root, 'large.txt');
  const text = 'a'.repeat(512 * 1024 - 1) + '中😀' + 'b'.repeat(512 * 1024) + '末尾🚀';
  await fs.writeFile(file, text);
  const first = await api().readPreview(file);
  expect(first.content).toBe('a'.repeat(512 * 1024 - 1));
  expect(first.nextOffset).toBe(512 * 1024 - 1);
  const second = await api().readPreview(file, { offset: first.nextOffset });
  const last = await api().readPreview(file, { offset: second.nextOffset });
  expect(first.content + second.content + last.content).toBe(text);
  expect(last.content.endsWith('末尾🚀')).toBe(true);
  expect(last.nextOffset).toBeNull();
  expect(last.truncated).toBe(true);
  expect((await api().readPreview(file, { offset: first.nextOffset + 1 })).error).toMatch(/边界/);
  for (const options of [null, [], { offset: -1 }, { offset: 0.5 }, { offset: Infinity }, { limit: 0 }, { limit: 512 * 1024 + 1 }, { limit: -1 }, { limit: '5' }]) {
    expect((await api().readPreview(file, options)).ok).toBe(false);
  }
  expect((await api().readPreview(file, { offset: Buffer.byteLength(text) + 1 })).error).toMatch(/范围/);
  await fs.writeFile(file, '新');
  expect((await api().readPreview(file, { offset: first.nextOffset })).ok).toBe(false);
  expect((await api().readPreview(file)).version).not.toBe(first.version);
  await fs.writeFile(file, '\uFEFF中');
  expect((await api().readPreview(file)).content).toBe('\uFEFF中');
  expect((await api().readPreview(file, { limit: 1 })).error).toMatch(/完整/);
  await fs.writeFile(file, '');
  expect(await api().readPreview(file)).toMatchObject({ ok: true, content: '', size: 0, offset: 0, nextOffset: null, truncated: false });
});

it('8KB 探测头跨汉字边界、同大小替换、EOF偏移和不足字符页不产生重复或乱码', async () => {
  const file = path.join(root, 'head.txt');
  const text = 'x'.repeat(8191) + '中😀尾';
  await fs.writeFile(file, text);
  expect((await api().readPreview(file)).content).toBe(text);
  expect(await api().readPreview(file, { offset: Buffer.byteLength(text) })).toMatchObject({ ok: true, content: '', nextOffset: null, truncated: true });
  await fs.writeFile(file, '😀');
  for (const limit of [1, 2, 3]) {
    const result = await api().readPreview(file, { limit });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/完整/);
    expect(result.nextOffset).toBeNull();
  }
  expect((await api().readPreview(file, { limit: 4 })).content).toBe('😀');
  const previous = await api().readPreview(file);
  await fs.unlink(file);
  await fs.writeFile(file, 'ABCD');
  const replacement = await api().readPreview(file);
  expect(replacement.size).toBe(previous.size);
  expect(replacement.version).not.toBe(previous.version);
  expect(replacement.content).toBe('ABCD');
});

it('图片保持 8MB 限额，binary/非法UTF8/非普通文件/本地路径校验', async () => {
  const image = path.join(root, 'pic.png');
  await fs.writeFile(image, Buffer.from([137, 80, 78, 71]));
  expect(await api().readPreview(image)).toMatchObject({ ok: true, kind: 'image', size: 4, dataUrl: 'data:image/png;base64,iVBORw==' });
  await fs.truncate(image, 8 * 1024 * 1024 + 1);
  expect(await api().readPreview(image)).toMatchObject({ ok: false, kind: 'image', error: '图片超过 8MB，请在外部打开' });
  for (const bytes of [Buffer.from([65, 0, 66]), Buffer.from([0xff, 0xfe]), Buffer.from([0xe4, 0xb8])]) {
    const file = path.join(root, 'binary.dat');
    await fs.writeFile(file, bytes);
    expect(await api().readPreview(file)).toMatchObject({ ok: false, kind: 'binary' });
  }
  const late = path.join(root, 'late.bin');
  await fs.writeFile(late, Buffer.concat([Buffer.alloc(8192, 65), Buffer.from([0])]));
  expect((await api().readPreview(late)).kind).toBe('binary');
  expect((await api().readPreview(root)).ok).toBe(false);
  await fs.symlink(image, path.join(root, 'link.png'));
  expect((await api().readPreview(path.join(root, 'link.png'))).ok).toBe(false);
  for (const file of ['relative', 'https://example.com/x', '\0bad', path.join(root, 'missing')]) expect((await api().readPreview(file)).ok).toBe(false);
});

it('目录默认过滤、目录优先排序，分页可访问超过 500 个条目且不递归 symlink', async () => {
  await fs.mkdir(path.join(root, 'z-folder'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.secret'), 'hidden');
  await fs.symlink(root, path.join(root, 'loop'));
  await Promise.all(Array.from({ length: 507 }, (_, i) => fs.writeFile(path.join(root, `f${String(i).padStart(3, '0')}`), 'x')));
  const first = await api().readDirectory(root);
  expect(first.total).toBe(509);
  expect(first.items).toHaveLength(200);
  expect(first.items[0].name).toBe('z-folder');
  expect(first.nextOffset).toBe(200);
  const second = await api().readDirectory(root, { offset: first.nextOffset, limit: 500 });
  expect(second.items).toHaveLength(309);
  expect(second.nextOffset).toBeNull();
  expect(new Set([...first.items, ...second.items].map(item => item.path)).size).toBe(509);
  expect(second.items.find(item => item.name === 'loop')).toMatchObject({ isDir: false, isSymlink: true });
});
