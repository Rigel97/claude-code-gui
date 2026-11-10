import { useStore } from '../store';
import { Plus, X, Loader } from 'lucide-react';
import type { ReactNode } from 'react';
import { ICON_BUTTON_SM } from './controls';

/**
 * 对话标签栏：多标签页并行会话的入口。
 * 每个标签显示标题 + 状态指示（生成中转圈/错误红点），点击切换，× 关闭（运行中先终止）。
 */
export function TabBar({ trailing }: { trailing?: ReactNode }) {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeConversationId);
  const setActive = useStore((s) => s.setActiveConversation);
  const close = useStore((s) => s.closeConversation);
  const newConversation = useStore((s) => s.newConversation);
  const cwd = useStore((s) => s.cwd);

  const moveFocus = (index: number, step: number) => {
    const tabs = document.querySelectorAll<HTMLElement>('[role="tab"][data-conversation-tab]');
    if (!tabs.length) return;
    const next = (index + step + tabs.length) % tabs.length;
    tabs[next]?.focus();
  };

  return (
    <div className="flex shrink-0 items-end border-b border-border/30 bg-bg-deep/60">
    <div role="tablist" aria-label="对话标签" className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2 pt-1.5">
      {conversations.map((c, index) => {
        const active = c.id === activeId;
        const running = c.status === 'streaming' || c.status === 'starting';
        const errored = c.status === 'error';
        return (
          <div
            key={c.id}
            role="tab"
            data-conversation-tab
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => setActive(c.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActive(c.id); }
              if (event.key === 'Delete') { event.preventDefault(); close(c.id); }
              if (event.key === 'ArrowLeft') { event.preventDefault(); moveFocus(index, -1); }
              if (event.key === 'ArrowRight') { event.preventDefault(); moveFocus(index, 1); }
            }}
            title={`${c.title}${c.sessionId ? ` · ${c.sessionId.slice(0, 8)}` : ''}`}
            className={`group/tab flex h-9 max-w-[240px] shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border border-b-0 pl-3 pr-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan ${
              active
                ? 'border-border bg-bg-light text-text-primary'
                : 'border-transparent text-text-muted hover:bg-bg-light/50 hover:text-text-secondary'
            }`}
          >
            {running ? (
              <Loader className="h-3 w-3 shrink-0 animate-spin text-accent-cyan" />
            ) : errored ? (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-red" />
            ) : (
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-accent-cyan/60' : 'bg-text-dim/40'}`} />
            )}
            <span className="truncate text-xs">{c.title}</span>
            <button
              onClick={(event) => {
                event.stopPropagation();
                close(c.id);
              }}
              onKeyDown={(event) => event.stopPropagation()}
              aria-label={`关闭对话 ${c.title}`}
              title={running ? '终止并关闭此对话' : '关闭此对话'}
              className={`${ICON_BUTTON_SM} opacity-0 hover:text-accent-red focus:opacity-100 group-hover/tab:opacity-100`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        onClick={() => newConversation()}
        disabled={!cwd}
        aria-label="新建对话标签"
        title={cwd ? '新对话标签页（可与其他标签页并行）' : '先选择项目目录'}
        className={`${ICON_BUTTON_SM} mx-1 mb-1 hover:text-accent-cyan`}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
    {trailing && <div className="flex shrink-0 items-center pb-1 pr-2">{trailing}</div>}
    </div>
  );
}
