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
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors text-left"
      >
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-text-dim shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-text-dim shrink-0" />}
        <ListTodo className={`w-3.5 h-3.5 shrink-0 ${running ? 'text-accent-purple animate-pulse' : 'text-accent-purple/70'}`} />
        <span className="text-[11px] font-mono text-text-secondary shrink-0">
          任务清单 {done}/{items.length}
        </span>
        {/* 进度条 */}
        <div className="flex-1 h-1.5 rounded-full bg-bg-deepest overflow-hidden min-w-[40px]">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              done === items.length ? 'bg-accent-green' : 'bg-accent-purple'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={`text-[10px] font-mono shrink-0 ${done === items.length ? 'text-accent-green' : 'text-text-dim'}`}>
          {pct}%
        </span>
      </button>

      {/* 折叠态：当前进行中的任务 */}
      {!expanded && current && (
        <div className="px-3 pb-2 -mt-0.5 flex items-center gap-1.5">
          <CircleDot className="w-3 h-3 text-accent-cyan animate-pulse shrink-0" />
          <span className="text-[11px] text-text-muted truncate">
            {current.activeForm || current.content}
          </span>
        </div>
      )}

      {/* 展开态：全部条目 */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1 border-t border-accent-purple/15 pt-2">
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
