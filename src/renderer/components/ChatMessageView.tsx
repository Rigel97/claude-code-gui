import type { ChatMessage, UIBlock } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallView } from './ToolCallView';
import { StatsView } from './StatsView';
import { ThinkingView } from './ThinkingView';
import { User, Copy, Check, RotateCcw } from 'lucide-react';
import { memo, useState } from 'react';
import { useStore } from '../store';
import { copyText } from '../utils/clipboard';

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
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors ${
          copied ? 'text-accent-green' : 'text-text-dim hover:text-accent-cyan'
        }`}
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
    </div>
  );
}

/** 失败重试：移除最后一轮（含失败的回复）并重发原文，相当于「这轮重来」。
 *  仅挂在活跃标签页末尾的 error 消息上，避免对历史旧错误误操作 */
function RetryButton() {
  const removeLastTurn = useStore((s) => s.removeLastTurn);

  const handleRetry = () => {
    const text = removeLastTurn();
    if (text) useStore.getState().sendPrompt(text);
  };

  return (
    <div>
      <button
        onClick={handleRetry}
        title="移除本轮失败对话并重新发送"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono text-accent-red/80 hover:text-accent-red border border-accent-red/20 hover:border-accent-red/40 transition-colors"
      >
        <RotateCcw className="w-3 h-3" />
        <span>重试</span>
      </button>
    </div>
  );
}

/**
 * memo 的前提是 store 的不可变更新：已归档消息与已完成块引用稳定，
 * 流式事件（每秒可达数十次）不再触发全列表重渲染与 markdown 重新解析
 */
export const ChatMessageView = memo(function ChatMessageView({ message }: { message: ChatMessage }) {
  const showThinking = useStore((s) => s.showThinking);
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
        {message.status === 'error' && isLatest && <RetryButton />}
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
