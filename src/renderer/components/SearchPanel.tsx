import { useState, useEffect, useRef, useMemo } from 'react';
import { useStore } from '../store';
import { Search, X, User, Bot, Wrench } from 'lucide-react';
import type { ChatMessage, Session, UIBlock } from '../types';

interface SearchHit {
  session: Session;
  sessionIndex: number;
  message: ChatMessage;
  snippet: string;
  /** 命中片段在原文中的起始位置（用于高亮） */
  matchStart: number;
  queryLen: number;
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
  const messages = useStore((s) => s.messages);
  const activeSessionIndex = useStore((s) => s.activeSessionIndex);
  const switchSession = useStore((s) => s.switchSession);
  const setHighlightMessage = useStore((s) => s.setHighlightMessage);
  const status = useStore((s) => s.status);

  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const isStreaming = status === 'streaming' || status === 'starting';

  useEffect(() => {
    if (open) {
      setQuery('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 跨会话搜索（当前未归档会话也参与）
  const hits = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    const results: SearchHit[] = [];

    sessions.forEach((session, sessionIndex) => {
      // 会话标题命中
      for (const message of session.messages) {
        const text = messageText(message);
        const hit = makeSnippet(text, q);
        if (hit) {
          results.push({ session, sessionIndex, message, queryLen: q.length, ...hit });
          if (results.length >= 50) return;
        }
      }
    });

    // 当前对话（可能未归档到 sessions）
    const covered = activeSessionIndex >= 0 ? sessions[activeSessionIndex]?.messages : null;
    if (messages.length > 0 && messages !== covered) {
      for (const message of messages) {
        const text = messageText(message);
        const hit = makeSnippet(text, q);
        if (hit && activeSessionIndex >= 0) {
          results.push({ session: sessions[activeSessionIndex], sessionIndex: activeSessionIndex, message, queryLen: q.length, ...hit });
        }
      }
    }

    return results.slice(0, 50);
  }, [query, sessions, messages, activeSessionIndex]);

  if (!open) return null;

  const jumpTo = (hit: SearchHit) => {
    if (isStreaming) return; // 生成中禁止切换会话
    if (hit.sessionIndex !== activeSessionIndex) {
      switchSession(hit.sessionIndex);
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
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter' && hits.length > 0) jumpTo(hits[0]);
            }}
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
              disabled={isStreaming}
              className="w-full flex items-start gap-2.5 px-4 py-2.5 text-left hover:bg-bg-light transition-colors border-b border-border/20 last:border-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {hit.message.role === 'user' ? (
                <User className="w-3.5 h-3.5 text-accent-blue shrink-0 mt-0.5" />
              ) : (
                <Bot className="w-3.5 h-3.5 text-accent-cyan shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <HighlightedSnippet snippet={hit.snippet} query={query.trim()} />
                <div className="text-[10px] text-text-dim font-mono mt-0.5 truncate">
                  {hit.session.title} · {new Date(hit.message.timestamp).toLocaleString()}
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
