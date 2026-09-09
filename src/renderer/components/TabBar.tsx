import { useStore } from '../store';
import { Plus, X, Loader } from 'lucide-react';

/**
 * 对话标签栏：多标签页并行会话的入口。
 * 每个标签显示标题 + 状态指示（生成中转圈/错误红点），点击切换，× 关闭（运行中先终止）。
 */
export function TabBar() {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeConversationId);
  const setActive = useStore((s) => s.setActiveConversation);
  const close = useStore((s) => s.closeConversation);
  const newConversation = useStore((s) => s.newConversation);
  const cwd = useStore((s) => s.cwd);

  return (
    <div className="flex items-end gap-0.5 px-2 pt-1.5 border-b border-border/30 bg-bg-deep/60 shrink-0 overflow-x-auto">
      {conversations.map((c) => {
        const active = c.id === activeId;
        const running = c.status === 'streaming' || c.status === 'starting';
        const errored = c.status === 'error';
        return (
          <div
            key={c.id}
            onClick={() => setActive(c.id)}
            title={`${c.title}${c.sessionId ? ` · ${c.sessionId.slice(0, 8)}` : ''}`}
            className={`group/tab flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-t-lg cursor-pointer max-w-[180px] border border-b-0 transition-colors shrink-0 ${
              active
                ? 'bg-bg-light border-border text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-secondary hover:bg-bg-light/50'
            }`}
          >
            {running ? (
              <Loader className="w-3 h-3 animate-spin text-accent-cyan shrink-0" />
            ) : errored ? (
              <span className="w-1.5 h-1.5 rounded-full bg-accent-red shrink-0" />
            ) : (
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? 'bg-accent-cyan/60' : 'bg-text-dim/40'}`} />
            )}
            <span className="text-xs truncate">{c.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                close(c.id);
              }}
              title={running ? '终止并关闭此对话' : '关闭此对话'}
              className="p-0.5 rounded text-text-dim hover:text-accent-red opacity-0 group-hover/tab:opacity-100 focus:opacity-100 transition-all shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
      <button
        onClick={() => newConversation()}
        disabled={!cwd}
        title={cwd ? '新对话标签页（可与其他标签页并行）' : '先选择项目目录'}
        className="flex items-center justify-center w-7 h-7 mb-1 mx-1 rounded-lg text-text-muted hover:text-accent-cyan hover:bg-bg-light transition-all disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
