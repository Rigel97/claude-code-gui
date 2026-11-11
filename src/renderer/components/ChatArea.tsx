import { useStore } from '../store';
import { ChatMessageView } from './ChatMessageView';
import { InputBar } from './InputBar';
import { TabBar } from './TabBar';
import { ActivityStrip } from './ActivityStrip';
import { TodoPanel } from './TodoPanel';
import { NamedApprovalPanel } from './ApprovalPanel';
import { SessionActionsPopover } from './SessionActions';
import { useRef, useEffect } from 'react';
import type { Conversation } from '../types';

export function ChatArea() {
  const conv = useStore((s): Conversation | undefined =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  );
  const highlightMessageId = useStore((s) => s.highlightMessageId);
  const setHighlightMessage = useStore((s) => s.setHighlightMessage);
  const forceScrollNonce = useStore((s) => s.forceScrollNonce);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 用户是否贴在底部（向上翻阅历史时暂停自动滚动）
  const stickToBottom = useRef(true);

  const messages = conv?.messages ?? [];
  const streamingMessage = conv?.streamingMessage ?? null;
  const thinkingTokens = conv?.thinkingTokens ?? 0;

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // 仅在贴底时自动滚动，避免打断用户阅读历史
  useEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingMessage, thinkingTokens, conv?.activity?.phase]);

  // 用户发送新消息（含失败重试/后台队列续发）时强制回到底部
  useEffect(() => {
    if (forceScrollNonce && scrollRef.current) {
      stickToBottom.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [forceScrollNonce]);

  // 搜索跳转：滚动到目标消息并闪烁高亮
  useEffect(() => {
    if (!highlightMessageId) return;
    const timer = setTimeout(() => {
      const el = document.getElementById(`msg-${highlightMessageId}`);
      if (el) {
        stickToBottom.current = false; // 定位期间不被自动滚动干扰
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('search-flash');
        setTimeout(() => el.classList.remove('search-flash'), 1600);
      }
      setHighlightMessage(null);
    }, 120);
    return () => clearTimeout(timer);
  }, [highlightMessageId, setHighlightMessage]);

  const isEmpty = messages.length === 0 && !streamingMessage;
  // 空态只在真实握手完成后才宣称“已连接”，避免给用户错误的安全感。
  const connected = !!(conv?.protocolConnected || conv?.runtime?.state === 'ready' || conv?.runtime?.state === 'busy');
  const approvals = conv?.pendingApprovals ?? conv?.runtime?.pendingApprovals ?? [];
  const focusApproval = () => {
    const panel = document.querySelector<HTMLElement>('[aria-label="Claude审批与追问"]');
    if (!panel) return;
    panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
    panel.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* 对话标签栏：单标签折叠为薄会话头；会话操作收进右侧弹层 */}
      <TabBar trailing={conv ? <SessionActionsPopover conv={conv} /> : null} />

      {/* 消息流 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {/* 阅读列：限制正文宽度，超宽屏不产生过长行 */}
        <div className="mx-auto w-full max-w-[968px] px-4 py-4 md:px-6">
          {/* 历史消息 */}
          {messages.map((msg) => (
            <ChatMessageView key={msg.id} message={msg} />
          ))}

          {/* 流式消息（key 保证新一轮流式消息重新挂载、动画重播） */}
          {streamingMessage && (
            <ChatMessageView key={streamingMessage.id} message={streamingMessage} />
          )}

          {/* 空状态提示 */}
          {isEmpty && (!conv || conv.status === 'idle') && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="relative mb-5">
                <div className="absolute inset-0 rounded-full bg-accent-cyan/10 blur-2xl" />
                <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-accent-cyan/25 bg-accent-cyan/5">
                  <svg className="h-7 w-7 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                </div>
              </div>
              <p className="text-sm font-medium text-text-primary">{connected ? '会话已连接，等待指令' : '准备开始对话'}</p>
              <p className="mt-1.5 max-w-md text-xs leading-6 text-text-secondary">
                {connected ? '可以继续提问；当前对话空闲，不会自动启动新的调用。' : '发送第一条消息后才会启动 CLI；打开界面不会占用会话或产生费用。'}
              </p>
              <p className="mt-3 flex items-center gap-2 font-mono text-2xs text-text-muted">
                <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-accent-green' : 'bg-text-muted'}`} />
                {connected ? 'READY' : 'NOT CONNECTED'}
              </p>
            </div>
          )}

          {/* 思考中指示器 */}
          {conv?.status === 'streaming' && thinkingTokens > 0 && !streamingMessage && (
            <ThinkingIndicator tokens={thinkingTokens} />
          )}
          {/* A waiting request must remain reachable even with a long transcript. */}
          {conv && <NamedApprovalPanel conv={conv} />}

          {/* 活动反馈并入消息流末尾：阶段 + 计时 + 思考预览，不再占用固定横条 */}
          {conv && (conv.status === 'streaming' || conv.status === 'starting') && (
            <ActivityStrip conv={conv} />
          )}
        </div>
      </div>

      {/* 任务清单：默认单行摘要，详情浮层展开 */}
      {conv && conv.todoList && conv.todoList.items.length > 0 && <TodoPanel conv={conv} />}

      {/* 阻塞提醒：压缩为单行入口 */}
      {approvals.length > 0 && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-accent-yellow/25 bg-accent-yellow/5 px-4 text-xs text-accent-yellow" role="status">
          <span className="shrink-0 font-medium">等待确认</span>
          <span className="min-w-0 flex-1 truncate text-text-secondary">{approvals.length} 项审批或追问正在阻塞当前任务</span>
          <button type="button" onClick={focusApproval} className="inline-flex h-6 shrink-0 items-center rounded px-2 text-xs text-accent-yellow hover:bg-accent-yellow/10">
            查看
          </button>
        </div>
      )}

      {/* 输入栏（草稿随标签页切换保留/恢复） */}
      <InputBar key={conv?.id ?? 'none'} initialDraft={conv?.draft ?? ''} />
    </div>
  );
}

function ThinkingIndicator({ tokens }: { tokens: number }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-muted animate-fade-in">
      <div className="flex gap-1">
        <span className="w-2 h-2 rounded-full bg-accent-cyan animate-pulse" />
        <span className="w-2 h-2 rounded-full bg-accent-cyan animate-pulse [animation-delay:200ms]" />
        <span className="w-2 h-2 rounded-full bg-accent-cyan animate-pulse [animation-delay:400ms]" />
      </div>
      <span className="font-mono text-xs">思考中… {tokens} Token</span>
    </div>
  );
}
