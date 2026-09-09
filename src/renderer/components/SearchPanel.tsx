import { useState, useEffect, useRef, useMemo } from 'react';
import { useStore } from '../store';
import { Search, X, User, Bot } from 'lucide-react';
import type { ChatMessage, Session, UIBlock } from '../types';

interface SearchHit {
  /** 展示用标题（标签页/会话标题） */
  title: string;
  message: ChatMessage;
  snippet: string;
  /** 命中片段在原文中的起始位置（用于高亮） */
  matchStart: number;
  queryLen: number;
  /** 跳转目标：优先激活已打开的标签页；归档会话则打开为标签页 */
  conversationId: string | null;
  sessionId: string | null;
}

/** 提取消息的可搜索纯文本（含工具调用的命令/路径摘要） */
function messageText(msg: ChatMessage): string {
  const parts: string[] = [];
  const walk = (blocks: UIBlock[]) => {
    for (const b of blocks) {
      if (b.kind === 'text') parts.push(b.text);
      else if (b.kind === 'thinking') parts.push(b.text);
      else if (b.kind === 'tool_use') {
        parts.push(b.toolName, JSON.stringify(b.input), b.result || '');
        if (b.children) walk(b.children);
      }
    }
  };
  walk(msg.blocks);
  return parts.join('\n');
}

/** 生成命中片段（命中词前后各取 40 字符） */
function makeSnippet(text: string, query: string): { snippet: string; matchStart: number } | null {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 40);
  return {
    snippet: (start > 0 ? '…' : '') + text.slice(start, end).replace(/\n+/g, ' ') + (end < text.length ? '…' : ''),
    matchStart: idx - start + (start > 0 ? 1 : 0),
  };
}

export function SearchPanel() {
  const open = useStore((s) => s.searchOpen);
  const setOpen = useStore((s) => s.setSearchOpen);
  const sessions = useStore((s) => s.sessions);
  const conversations = useStore((s) => s.conversations);
  const setActiveConversation = useStore((s) => s.setActiveConversation);
  const openSessionTab = useStore((s) => s.openSessionTab);
  const setHighlightMessage = useStore((s) => s.setHighlightMessage);

  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // 输入法组合状态：组合中的 Enter 是确认上屏而非跳转
  const isComposingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setQuery('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 跨会话搜索：所有打开的标签页（含活跃）+ 全部归档会话，按消息 id 去重
  const hits = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    const results: SearchHit[] = [];
    const seen = new Set<string>();
    const MAX_RESULTS = 50;

    const scan = (messages: ChatMessage[], title: string, conversationId: string | null, sessionId: string | null) => {
      for (const message of messages) {
        if (seen.has(message.id)) continue;
        const text = messageText(message);
        const hit = makeSnippet(text, q);
        if (hit) {
          seen.add(message.id);
          results.push({ title, message, queryLen: q.length, conversationId, sessionId, ...hit });
          if (results.length >= MAX_RESULTS) return true;
        }
      }
      return false;
    };

    // 打开的标签页优先（跳转直接激活，不必新开）
    for (const conv of conversations) {
      if (scan(conv.messages, conv.title || '未命名对话', conv.id, conv.sessionId)) break;
    }
    // 归档会话（未被标签页覆盖的消息）
    if (results.length < MAX_RESULTS) {
      for (const session of sessions) {
        // 已有同 sessionId 的标签页：其消息已扫过，跳过会话条目避免重复展示
        const covered = conversations.some((c) => c.sessionId === session.sessionId);
        if (covered) continue;
        if (scan(session.messages, session.title, null, session.sessionId)) break;
      }
    }

    return results.slice(0, MAX_RESULTS);
  }, [query, sessions, conversations]);

  if (!open) return null;

  const jumpTo = (hit: SearchHit) => {
    // 先切到目标标签页（多标签页下跳转不受生成中限制）
    if (hit.conversationId) {
      setActiveConversation(hit.conversationId);
    } else if (hit.sessionId) {
      openSessionTab(hit.sessionId);
    }
    setHighlightMessage(hit.message.id);
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl glass-panel rounded-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 搜索输入 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50">
          <Search className="w-4 h-4 text-accent-cyan shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // 输入法组合中不响应快捷键（Enter 属于输入法确认）
              if (isComposingRef.current || e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter' && hits.length > 0) jumpTo(hits[0]);
            }}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            placeholder="搜索所有会话的消息内容…"
            className="flex-1 bg-transparent text-sm text-text-primary placeholder-text-dim"
          />
          <button onClick={() => setOpen(false)} className="text-text-muted hover:text-text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 结果列表 */}
        <div className="max-h-96 overflow-y-auto">
          {query.trim().length >= 2 && hits.length === 0 && (
            <div className="text-xs text-text-dim text-center py-8">无匹配结果</div>
          )}
          {query.trim().length < 2 && (
            <div className="text-xs text-text-dim text-center py-8">输入至少 2 个字符开始搜索</div>
          )}
          {hits.map((hit, i) => (
            <button
              key={`${hit.message.id}-${i}`}
              onClick={() => jumpTo(hit)}
              className="w-full flex items-start gap-2.5 px-4 py-2.5 text-left hover:bg-bg-light transition-colors border-b border-border/20 last:border-0"
            >
              {hit.message.role === 'user' ? (
                <User className="w-3.5 h-3.5 text-accent-blue shrink-0 mt-0.5" />
              ) : (
                <Bot className="w-3.5 h-3.5 text-accent-cyan shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <HighlightedSnippet snippet={hit.snippet} query={query.trim()} />
                <div className="text-[10px] text-text-dim font-mono mt-0.5 truncate">
                  {hit.title} · {new Date(hit.message.timestamp).toLocaleString()}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="px-4 py-1.5 border-t border-border/30 flex items-center justify-between">
          <span className="text-[10px] text-text-dim font-mono">
            {hits.length > 0 ? `${hits.length} 条结果` : ''}
          </span>
          <span className="text-[10px] text-text-dim font-mono">ESC 关闭 · ⏎ 跳转第一条</span>
        </div>
      </div>
    </div>
  );
}

/** 高亮命中词 */
function HighlightedSnippet({ snippet, query }: { snippet: string; query: string }) {
  const idx = snippet.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <span className="text-xs text-text-secondary">{snippet}</span>;
  return (
    <span className="text-xs text-text-secondary break-all">
      {snippet.slice(0, idx)}
      <mark className="bg-accent-yellow/30 text-accent-yellow rounded px-0.5">
        {snippet.slice(idx, idx + query.length)}
      </mark>
      {snippet.slice(idx + query.length)}
    </span>
  );
}
