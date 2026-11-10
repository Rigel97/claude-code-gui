import type { ChatMessage, UIBlock } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallView } from './ToolCallView';
import { StatsView } from './StatsView';
import { ThinkingView } from './ThinkingView';
import { User, Copy, Check, RotateCcw } from 'lucide-react';
import { memo, useState } from 'react';
import { useStore } from '../store';
import { copyText } from '../utils/clipboard';
import { SessionMessageActions } from './SessionActions';

/** 提取消息纯文本正文（不含 thinking / 工具调用 / stats）*/
function messageText(message: ChatMessage): string {
  return message.blocks
    .filter((b): b is Extract<UIBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();
}

/** 消息一键复制按钮：位于消息正文下方，hover 消息卡片时显现，
 *  成功后打勾 2s；仅复制正文文本（不含思考/工具调用/统计） */
function MessageCopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (await copyText(getText())) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <button
        onClick={handleCopy}
        title="复制消息正文"
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-2xs font-mono transition-colors ${
          copied ? 'text-accent-green' : 'text-text-dim hover:text-accent-cyan'
        }`}
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
    </div>
  );
}

/** 保留失败历史重发，不隐式撤销文件或外部操作。 */
function RetryButton({ conversationId }: { conversationId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const unavailable = useStore(s => {
    const conv = s.conversations.find(c => c.id === conversationId);
    return !conv || conv.status === 'starting' || conv.status === 'streaming' || !!conv.streamingMessage
      || !!conv.queue?.length || !!conv.pendingApprovals?.length || !!conv.runtime?.busy
      || !!conv.runtime?.pendingApprovals?.length || !!conv.runtime?.pendingUserMessageIds?.length
      || ['starting', 'busy', 'closing'].includes(conv.runtime?.state || '');
  });
  const handleRetry = async () => {
    if (pending || unavailable) return;
    setPending(true); setError('');
    try { await useStore.getState().retryLastTurn(conversationId); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };

  return (
    <div>
      <button
        onClick={handleRetry}
        disabled={pending || unavailable}
        title="保留失败历史再次发送，不自动撤销文件/外部操作"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-2xs font-mono text-accent-red/80 hover:text-accent-red border border-accent-red/20 hover:border-accent-red/40 transition-colors"
      >
        <RotateCcw className="w-3 h-3" />
        <span>{pending ? '重试中…' : '重试'}</span>
      </button>
      {error && <p role="alert" className="text-xs text-accent-red">{error}</p>}
    </div>
  );
}

/**
 * memo 的前提是 store 的不可变更新：已归档消息与已完成块引用稳定，
 * 流式事件（每秒可达数十次）不再触发全列表重渲染与 markdown 重新解析
 */
export const ChatMessageView = memo(function ChatMessageView({ message }: { message: ChatMessage }) {
  const showThinking = useStore((s) => s.showThinking);
  const conversationId = useStore(s => {
    const active = s.conversations.find(c => c.id === s.activeConversationId);
    return active?.messages.includes(message) ? active.id : undefined;
  });
  // 是否为活跃标签页消息列表末尾（重试按钮只对最新的 error 消息显示）
  const isLatest = useStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId);
    return conv?.messages[conv.messages.length - 1]?.id === message.id;
  });

  if (message.role === 'user') {
    const text = messageText(message);
    return (
      <div id={`msg-${message.id}`} className="flex gap-3 mb-6 message-glow-in rounded-xl group">
        <div className="w-8 h-8 rounded-lg bg-accent-blue/20 border border-accent-blue/30 flex items-center justify-center shrink-0">
          <User className="w-4 h-4 text-accent-blue" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-text-muted font-mono mb-1">USER</div>
          <div className="glass-panel rounded-xl px-4 py-3">
            <MarkdownRenderer content={text} />
          </div>
          {conversationId && <SessionMessageActions message={message} conversationId={conversationId} />}
          {/* 复制按钮：正文下方，hover 消息时显现 */}
          {text && (
            <div className="mt-1">
              <MessageCopyButton getText={() => text} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.role === 'system') {
    return <div id={`msg-${message.id}`} className="mb-3 space-y-2 text-xs text-text-muted" role="status">
      {message.blocks.map((block, index) => <BlockRenderer key={index} block={block} showThinking={showThinking} isStreaming={false} />)}
    </div>;
  }

  // assistant
  const text = messageText(message);
  return (
    <div id={`msg-${message.id}`} className="flex gap-3 mb-6 message-glow-in rounded-xl group">
      <div className="w-8 h-8 rounded-lg bg-accent-cyan/20 border border-accent-cyan/30 flex items-center justify-center shrink-0 tech-glow-cyan">
        <svg className="w-4 h-4 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      </div>
      <div className="flex-1 min-w-0 space-y-3">
        <div className="text-xs text-accent-cyan font-mono mb-1 flex items-center gap-2">
          CLAUDE
          {message.status === 'streaming' && (
            <span className="flex items-center gap-1 text-text-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
              生成中
            </span>
          )}
        </div>

        {message.blocks.map((block, i) => (
          <BlockRenderer
            key={i}
            block={block}
            showThinking={showThinking}
            isStreaming={message.status === 'streaming' && i === message.blocks.length - 1}
          />
        ))}

        {/* 操作条：失败时提供重试（仅最新错误消息）；完成后提供复制 */}
        {message.status === 'error' && isLatest && conversationId && <RetryButton conversationId={conversationId} />}
        {conversationId && <SessionMessageActions message={message} conversationId={conversationId} />}
        {text && message.status !== 'streaming' && <MessageCopyButton getText={() => text} />}
      </div>
    </div>
  );
});

const BlockRenderer = memo(function BlockRenderer({ block, showThinking, isStreaming }: { block: UIBlock; showThinking: boolean; isStreaming: boolean }) {
  switch (block.kind) {
    case 'text':
      return (
        <div className={`glass-panel rounded-xl px-4 py-3 ${isStreaming ? 'streaming-border stream-cursor' : ''}`}>
          <MarkdownRenderer content={block.text} />
        </div>
      );

    case 'thinking':
      return showThinking ? <ThinkingView text={block.text} /> : null;

    case 'tool_use':
      return <ToolCallView block={block} />;

    case 'notice':
      return <details className="rounded-lg border border-border/40 px-3 py-2 bg-bg-deep/50">
        <summary className="cursor-pointer whitespace-pre-wrap break-words">{block.text || 'CLI 事件'}</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words selectable-text">{JSON.stringify(block.raw, null, 2)}</pre>
      </details>;

    case 'stderr':
      return (
        <div className="rounded-xl px-4 py-3 bg-accent-red/5 border border-accent-red/20">
          <div className="text-xs text-accent-red font-mono mb-1">STDERR</div>
          <pre className="text-xs text-accent-red/80 font-mono whitespace-pre-wrap selectable-text">{block.text}</pre>
        </div>
      );

    case 'stats':
      return <StatsView data={block.data} />;

    default:
      return null;
  }
});
