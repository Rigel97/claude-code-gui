import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { saveImageDataUrl } from '../src/main/images.js';

// 1x1 红色像素 PNG 的 dataURL
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

describe('saveImageDataUrl（粘贴图片存临时文件）', () => {
  it('合法 dataURL 写入临时目录并返回可读文件路径', () => {
    const file = saveImageDataUrl(PNG_1PX);
    expect(file).toBeTruthy();
    expect(file).toContain('claude-gui-images');
    expect(file.endsWith('.png')).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(10);
  });

  it('非法输入返回 null（不写文件）', () => {
    expect(saveImageDataUrl('not-a-dataurl')).toBeNull();
    expect(saveImageDataUrl('')).toBeNull();
    expect(saveImageDataUrl(null)).toBeNull();
    expect(saveImageDataUrl('data:image/png;base64,')).toBeNull(); // 空 base64 体
    expect(saveImageDataUrl('data:text/plain;base64,aGVsbG8=')).toBeNull(); // 非图片 MIME
  });

  it('JPEG 扩展名映射为 .jpg', () => {
    // 1x1 JPEG（合法性与可解码性无关，仅验证扩展名映射与写入）
    const JPEG_1PX =
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgA//9k=';
    const file = saveImageDataUrl(JPEG_1PX);
    expect(file).toBeTruthy();
    expect(file.endsWith('.jpg')).toBe(true);
  });
});
