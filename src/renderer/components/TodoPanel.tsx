import { useState } from 'react';
import { ListTodo, ChevronDown, ChevronRight, Circle, CircleDot, CheckCircle2 } from 'lucide-react';
import type { Conversation, TodoItem } from '../types';

/**
 * TodoWrite 任务清单进度面板：显示在标签栏下方。
 * 数据由 store 从流中最新的 TodoWrite 调用同步（conv.todoList）。
 * 折叠态显示进度条 + 当前进行中的任务；展开显示全部条目。
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
    <div className="mx-4 mt-2 rounded-xl border border-accent-purple/25 bg-accent-purple/5 overflow-hidden shrink-0 animate-fade-in">
      {/* 头部：进度摘要 */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex h-9 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-white/5"
      >
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-text-dim shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-text-dim shrink-0" />}
        <ListTodo className={`w-3.5 h-3.5 shrink-0 ${running ? 'text-accent-purple animate-pulse' : 'text-accent-purple/70'}`} />
        <span className="text-2xs font-mono text-text-secondary shrink-0">
          任务清单 {done}/{items.length}
        </span>
        {/* 当前任务与进度合并为一行，避免折叠态长期占用两行高度 */}
        {current && (
          <span className="min-w-0 flex-1 truncate text-2xs text-text-muted">
            {current.activeForm || current.content}
          </span>
        )}
        {!current && <span className="flex-1" />}
        {/* 进度条 */}
        <div role="progressbar" aria-label="会话任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-bg-deepest">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              done === items.length ? 'bg-accent-green' : 'bg-accent-purple'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={`text-2xs font-mono shrink-0 ${done === items.length ? 'text-accent-green' : 'text-text-dim'}`}>
          {pct}%
        </span>
      </button>

      {/* 展开态：全部条目 */}
      {expanded && (
        <div className="max-h-[min(180px,20vh)] space-y-1 overflow-y-auto border-t border-accent-purple/15 px-3 pb-2 pt-2">
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
