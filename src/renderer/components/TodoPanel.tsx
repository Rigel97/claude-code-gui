import { useState } from 'react';
import { ListTodo, ChevronDown, ChevronRight, Circle, CircleDot, CheckCircle2 } from 'lucide-react';
import type { Conversation, TodoItem } from '../types';

/**
 * TodoWrite 任务清单：默认只占一行摘要，展开内容以浮层覆盖消息区，
 * 不再把整段任务列表塞进常驻布局。
 */
export function TodoPanel({ conv }: { conv: Conversation }) {
  const [expanded, setExpanded] = useState(false);
  const items = conv.todoList?.items ?? [];
  if (items.length === 0) return null;

  const done = items.filter((t) => t.status === 'completed').length;
  const current = items.find((t) => t.status === 'in_progress');
  const pct = Math.round((done / items.length) * 100);
  const running = conv.status === 'streaming' || conv.status === 'starting';

  return (
    <div className="relative shrink-0 border-t border-border/30 bg-bg-deep/50">
      {/* 单行摘要 */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label="任务清单"
        className="flex h-7 w-full items-center gap-2 px-4 text-left transition-colors hover:bg-bg-light/50"
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 text-text-dim shrink-0" />
          : <ChevronRight className="w-3 h-3 text-text-dim shrink-0" />}
        <ListTodo className={`w-3 h-3 shrink-0 ${running ? 'text-accent-purple animate-pulse' : 'text-accent-purple/70'}`} />
        <span className="shrink-0 text-2xs font-mono text-text-secondary">
          {done}/{items.length}
        </span>
        {current && (
          <span className="min-w-0 flex-1 truncate text-2xs text-text-muted">
            {current.activeForm || current.content}
          </span>
        )}
        {!current && <span className="flex-1" />}
        <div role="progressbar" aria-label="会话任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-bg-deepest">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              done === items.length ? 'bg-accent-green' : 'bg-accent-purple'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={`shrink-0 text-2xs font-mono ${done === items.length ? 'text-accent-green' : 'text-text-dim'}`}>
          {pct}%
        </span>
      </button>

      {/* 展开态：浮层，不挤压消息区 */}
      {expanded && (
        <div className="absolute bottom-full left-0 right-0 z-20 max-h-[min(240px,40vh)] space-y-1 overflow-y-auto border-t border-border/40 bg-bg-deep/95 px-4 py-2 shadow-xl backdrop-blur-sm">
          {items.map((t, i) => (
            <TodoRow key={i} item={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TodoRow({ item }: { item: TodoItem }) {
  const icon =
    item.status === 'completed' ? (
      <CheckCircle2 className="w-3.5 h-3.5 text-accent-green shrink-0" />
    ) : item.status === 'in_progress' ? (
      <CircleDot className="w-3.5 h-3.5 text-accent-cyan animate-pulse shrink-0" />
    ) : (
      <Circle className="w-3.5 h-3.5 text-text-dim shrink-0" />
    );
  return (
    <div className="flex items-start gap-2 px-1 py-0.5">
      <span className="mt-0.5">{icon}</span>
      <span
        className={`text-xs leading-relaxed ${
          item.status === 'completed'
            ? 'text-text-dim line-through decoration-text-dim/50'
            : item.status === 'in_progress'
              ? 'text-text-primary'
              : 'text-text-muted'
        }`}
      >
        {item.content}
      </span>
    </div>
  );
}
