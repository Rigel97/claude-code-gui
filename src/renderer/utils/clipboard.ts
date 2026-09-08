/**
 * 统一的文本复制工具。
 *
 * 三级降级策略：
 * 1. 主进程 clipboard（IPC，preload 桥接）——最可靠，窗口失焦时也能写入
 * 2. Web Clipboard API（navigator.clipboard）——纯浏览器环境 / IPC 不可用时
 * 3. execCommand('copy') 兜底——老环境 / 前两者均失败时
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof text !== 'string' || text.length === 0) return false;

  // 1) 主进程 clipboard（Electron 环境下 preload 暴露）
  try {
    const bridge = (window as any)?.api?.clipboard;
    if (typeof bridge?.writeText === 'function') {
      await bridge.writeText(text);
      return true;
    }
  } catch {
    /* 降级到下一策略 */
  }

  // 2) Web Clipboard API
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 降级到兜底策略 */
  }

  // 3) execCommand 兜底：临时 textarea + 手动选中
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
