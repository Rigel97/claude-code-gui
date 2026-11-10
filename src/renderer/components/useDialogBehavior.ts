import { useEffect, useRef, type RefObject } from 'react';

/** details 保留键盘语义；内容进入浏览器顶层并自动翻转，避免列表滚动区域裁切。 */
export function usePopoverBehavior(containerRef: RefObject<HTMLElement>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.setAttribute('data-popover-scope', '');
    const opened = new Map<HTMLDetailsElement, { panel: HTMLElement; style: string | null }>();
    const close = (menu: HTMLDetailsElement) => {
      const entry = opened.get(menu);
      if (entry) {
        if (entry.panel.matches(':popover-open')) entry.panel.hidePopover();
        entry.panel.removeAttribute('popover');
        if (entry.style === null) entry.panel.removeAttribute('style');
        else entry.panel.setAttribute('style', entry.style);
        opened.delete(menu);
      }
      menu.open = false;
    };
    const position = (menu: HTMLDetailsElement, panel: HTMLElement) => {
      const trigger = menu.querySelector('summary');
      if (!trigger) return;
      const anchor = menu.getAttribute('data-popover-anchor') === 'container' ? container : trigger;
      const rect = anchor.getBoundingClientRect();
      const above = menu.getAttribute('data-popover-anchor') === 'container';
      const panelWidth = Math.min(panel.getBoundingClientRect().width, window.innerWidth - 16);
      const belowSpace = Math.max(0, window.innerHeight - rect.bottom - 14);
      const aboveSpace = Math.max(0, rect.top - 14);
      const useAbove = above || (panel.scrollHeight > belowSpace && aboveSpace > belowSpace);
      const available = useAbove ? aboveSpace : belowSpace;
      panel.style.maxHeight = `${Math.min(window.innerHeight * 0.7, available)}px`;
      const panelHeight = panel.getBoundingClientRect().height;
      const rightAligned = panel.classList.contains('right-0');
      panel.style.left = `${Math.max(8, Math.min(window.innerWidth - panelWidth - 8, rightAligned ? rect.right - panelWidth : rect.left))}px`;
      panel.style.top = `${Math.max(8, useAbove ? rect.top - panelHeight - 6 : rect.bottom + 6)}px`;
    };
    const onToggle = (event: Event) => {
      const menu = event.target;
      if (!(menu instanceof HTMLDetailsElement) || !menu.hasAttribute('data-popover') || menu.closest('[data-popover-scope]') !== container) return;
      if (!menu.open) { close(menu); return; }
      for (const previous of opened.keys()) if (previous !== menu) close(previous);
      if (opened.has(menu)) return;
      const panel = menu.querySelector('summary')?.nextElementSibling;
      if (!(panel instanceof HTMLElement) || typeof panel.showPopover !== 'function') return;
      opened.set(menu, { panel, style: panel.getAttribute('style') });
      panel.setAttribute('popover', 'manual');
      Object.assign(panel.style, { position: 'fixed', inset: 'auto', margin: '0', maxWidth: 'calc(100vw - 16px)', overflowY: 'auto' });
      panel.showPopover();
      position(menu, panel);
    };
    const onPointer = (event: PointerEvent) => {
      for (const menu of opened.keys()) if (!menu.contains(event.target as Node)) close(menu);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const menu = [...opened.keys()].reverse().find(item => item.open);
      if (!menu || (layers.length && !menu.contains(document.activeElement))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(menu);
      menu.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    };
    const reposition = () => { for (const [menu, { panel }] of opened) position(menu, panel); };
    container.addEventListener('toggle', onToggle, true);
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      for (const menu of opened.keys()) close(menu);
      container.removeAttribute('data-popover-scope');
      container.removeEventListener('toggle', onToggle, true);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [containerRef]);
}

/**
 * 统一的弹层交互契约：
 * - Esc 只关闭最上层弹层（用模块级栈保证叠层顺序），并阻止事件继续冒泡到输入框；
 * - Tab / Shift+Tab 焦点陷阱，关闭后焦点归还给打开前的元素；
 * - 打开时聚焦指定的初始元素（默认第一个可聚焦控件）。
 *
 * 只处理键盘与焦点，不负责遮罩样式；调用方仍可用 onClick 关闭。
 */
const layers: symbol[] = [];

const FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function useDialogBehavior(options: {
  open: boolean;
  dialogRef: RefObject<HTMLElement>;
  onRequestClose: () => void;
  /** 打开时优先聚焦的元素；找不到时退回第一个可聚焦元素。 */
  initialFocusSelector?: string;
  /** 为 true 时允许从打开它的元素外恢复焦点（默认 true）。 */
  restoreFocus?: boolean;
}) {
  const { open, dialogRef, onRequestClose, initialFocusSelector, restoreFocus = true } = options;
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;
  const layerRef = useRef<symbol>(Symbol('dialog-layer'));

  useEffect(() => {
    if (!open) return;
    const layer = layerRef.current;
    layers.push(layer);
    const isTop = () => layers[layers.length - 1] === layer;
    const previous = restoreFocus ? (document.activeElement as HTMLElement | null) : null;
    const container = dialogRef.current;

    const focusables = () => {
      if (!container) return [] as HTMLElement[];
      return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
    };

    const initial = (initialFocusSelector ? container?.querySelector<HTMLElement>(initialFocusSelector) : null)
      ?? focusables()[0]
      ?? container;
    // 焦点已由用户/autoFocus进入其他字段时不再抢回，避免输入落到错误字段。
    if (container && !container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    const focusFrame = requestAnimationFrame(() => {
      if (isTop() && !container?.contains(document.activeElement)) initial?.focus({ preventScroll: true });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        container?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !container?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !container?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKeyDown, true);
      const index = layers.lastIndexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      // 归还焦点只在元素仍然存在时执行，且避免抢走更高层弹层的焦点。
      if (previous?.isConnected && (!layers.length || document.activeElement === document.body)) previous.focus();
    };
  }, [open, dialogRef, initialFocusSelector, restoreFocus]);
}
