import { describe, expect, it, vi, afterEach } from 'vitest';
import { syncWhaleSignals } from '../src/renderer/components/WhalePet';
import type { Conversation, UIBlock } from '../src/renderer/types';

function element() {
  const attributes = new Map<string, string>();
  const children: ReturnType<typeof element>[] = [];
  return {
    attributes, children, style: {}, textContent: '',
    getAttribute(name: string) { return attributes.get(name) ?? null; },
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    querySelector(selector: string) { return children.find((child) => child.attributes.has(selector.slice(1, -1))) ?? null; },
    appendChild(child: ReturnType<typeof element>) { children.push(child); },
    remove() { /* the host fixture removes the child explicitly */ },
  };
}

function conversation(id: string, status: Conversation['status'], blocks: UIBlock[] = []): Conversation {
  return {
    id, title: '', sessionId: null, cwd: '/tmp', messages: [],
    streamingMessage: blocks.length ? { id: 'message', role: 'assistant', timestamp: 0, blocks } : null,
    status, thinkingTokens: 0, contextUsage: null, queue: [], currentModel: '', draft: '', activity: null,
  };
}

describe('Claude Code → 鲸鱼娘状态适配', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('从当前运行会话选择工具名，不泄露工具参数和聊天正文', () => {
    const body = element();
    const signal = element();
    const events = vi.fn();
    vi.stubGlobal('document', { createElement: element });
    vi.stubGlobal('window', { dispatchEvent: events });
    const previous = { statuses: new Map<string, string>(), successAt: 0 };
    const tool: UIBlock = { kind: 'tool_use', toolId: '1', toolName: 'Bash', input: { command: 'SECRET' }, status: 'running' };
    syncWhaleSignals(body as never, signal as never, [conversation('a', 'streaming', [tool])], 'a', previous);
    expect(signal.querySelector('[data-claude-whale-tool]')?.textContent).toBe('Bash');
    expect(signal.children.map((child) => child.textContent).join(' ')).not.toContain('SECRET');
    expect(body.getAttribute('data-claude-whale-code-count')).toBe('1');
    expect(events).toHaveBeenCalledTimes(1);
    syncWhaleSignals(body as never, signal as never, [conversation('a', 'streaming', [tool])], 'a', previous);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('成功只在会话结束时记录，不把中断视为成功', () => {
    const body = element();
    const signal = element();
    vi.stubGlobal('document', { createElement: element });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const previous = { statuses: new Map<string, string>(), successAt: 0 };
    const sync = (status: Conversation['status']) => syncWhaleSignals(body as never, signal as never, [conversation('a', status)], 'a', previous);
    sync('streaming');
    sync('aborted');
    expect(previous.successAt).toBe(0);
    sync('streaming');
    sync('completed');
    expect(previous.successAt).toBeGreaterThan(0);
    expect(signal.querySelector('[data-claude-whale-tool]')).toBeNull();
  });
});
