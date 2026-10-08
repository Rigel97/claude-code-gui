import { useEffect } from 'react';
import { useStore } from '../store';
import type { Conversation, UIBlock } from '../types';

declare global {
  interface Window {
    __dshWhaleMoeStarted?: boolean;
  }
}

function blocksOf(conv: Conversation): UIBlock[] {
  return [...conv.messages.flatMap((message) => message.blocks), ...(conv.streamingMessage?.blocks ?? [])];
}

function countTools(blocks: UIBlock[]): number {
  return blocks.reduce((total, block) => total + (block.kind === 'tool_use' ? 1 + countTools(block.children ?? []) : 0), 0);
}

function activeTool(blocks: UIBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind !== 'tool_use') continue;
    const child = activeTool(block.children ?? []);
    if (child) return child;
    if (block.status === 'running') return block.toolName;
  }
  return null;
}

/** Only publish metadata to the original mascot: never pass chat or tool arguments. */
export function syncWhaleSignals(
  body: HTMLElement,
  signal: HTMLElement,
  conversations: Conversation[],
  activeId: string,
  previous: { statuses: Map<string, string>; successAt: number }
) {
  const active = conversations.find((conv) => conv.id === activeId);
  const running = conversations.filter((conv) => conv.status === 'starting' || conv.status === 'streaming');
  const source = running.find((conv) => conv.id === activeId) ?? running[0];
  const toolName = source ? activeTool(source.streamingMessage?.blocks ?? []) : null;
  const thinking = !!source && !toolName;
  const error = active?.status === 'error' || conversations.some((conv) =>
    (conv.status === 'starting' || conv.status === 'streaming') &&
    (conv.streamingMessage?.blocks ?? []).some((block) => block.kind === 'tool_use' && block.status === 'error')
  );

  for (const conv of conversations) {
    const last = previous.statuses.get(conv.id);
    if ((last === 'starting' || last === 'streaming') && conv.status === 'completed') {
      previous.successAt = Date.now();
    }
  }
  previous.statuses = new Map(conversations.map((conv) => [conv.id, conv.status]));

  let changed = false;
  const update = (attribute: string, value: string) => {
    if (body.getAttribute(attribute) !== value) { body.setAttribute(attribute, value); changed = true; }
  };
  const toggle = (attribute: string, on: boolean, text = '') => {
    const existing = signal.querySelector<HTMLElement>(`[${attribute}]`);
    if (!on) { if (existing) { existing.remove(); changed = true; } return; }
    const node = existing ?? document.createElement('span');
    if (!existing) {
      node.setAttribute(attribute, 'true');
      Object.assign(node.style, { display: 'inline-block', width: '2px', height: '2px' });
      signal.appendChild(node);
      changed = true;
    }
    if (node.textContent !== text) { node.textContent = text; changed = true; }
  };
  // Never replace unchanged nodes: the upstream MutationObserver would otherwise loop.
  toggle('data-claude-whale-tool', !!toolName, toolName ?? '');
  toggle('data-claude-whale-thinking', thinking);
  toggle('data-claude-whale-error', error);
  update('data-claude-whale-success-at', String(previous.successAt));
  update('data-claude-whale-code-count', String(conversations.reduce((total, conv) => total + countTools(blocksOf(conv)), 0)));
  update('data-claude-whale-message-count', String(conversations.reduce((total, conv) => total + conv.messages.length + (conv.streamingMessage ? 1 : 0), 0)));
  if (changed) window.dispatchEvent(new Event('claude-whale-signals-change'));
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`无法加载鲸鱼娘资源: ${src}`));
    document.body.appendChild(script);
  });
}

export function WhalePet() {
  useEffect(() => {
    const signal = document.createElement('div');
    signal.setAttribute('data-claude-whale-signals', 'true');
    // The source's visibility check requires a nonzero, on-screen box.
    Object.assign(signal.style, { position: 'fixed', left: '2px', top: '2px', width: '2px', height: '2px', overflow: 'hidden', pointerEvents: 'none' });
    document.body.appendChild(signal);
    document.body.setAttribute('data-claude-whale-host', 'true');
    const previous = { statuses: new Map<string, string>(), successAt: 0 };
    const sync = () => {
      const state = useStore.getState();
      syncWhaleSignals(document.body, signal, state.conversations, state.activeConversationId, previous);
    };
    sync();
    const unsubscribe = useStore.subscribe(sync);
    const speak = (event: Event) => {
      if (localStorage.getItem('claude-whale:tts') !== '1' || !window.speechSynthesis) return;
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (!text || text.length > 240) return;
      window.speechSynthesis.cancel();
      const line = new SpeechSynthesisUtterance(text);
      line.lang = 'zh-CN';
      const voices = window.speechSynthesis.getVoices();
      line.voice = voices.find((voice) => voice.lang.toLowerCase().startsWith('zh')) ?? null;
      window.speechSynthesis.speak(line);
    };
    window.addEventListener('dsh-whale-musume:interaction-line', speak);
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = './whale/dsh-whale-moe.css';
    document.head.appendChild(stylesheet);
    // Serial loading ensures the original presenter sees its state-machine global.
    if (!window.__dshWhaleMoeStarted && !document.querySelector('[data-claude-whale-loading]')) {
      const marker = document.createElement('meta');
      marker.setAttribute('data-claude-whale-loading', 'true');
      document.head.appendChild(marker);
      loadScript('./whale/whale-moe-core.js')
        .then(() => loadScript('./whale/dsh-whale-moe.js'))
        .catch((error) => console.warn('[claude-whale]', error))
        .finally(() => marker.remove());
    }
    return () => {
      unsubscribe();
      window.removeEventListener('dsh-whale-musume:interaction-line', speak);
      window.speechSynthesis?.cancel();
      signal.remove();
      document.body.removeAttribute('data-claude-whale-host');
      stylesheet.remove();
    };
  }, []);
  return null;
}
