import type { ChatMessage, UIBlock } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallView } from './ToolCallView';
import { StatsView } from './StatsView';
import { ThinkingView } from './ThinkingView';
import { User, Copy, Check } from 'lucide-react';
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

/** 消息一键复制按钮：hover 跟随消息卡片出现，成功后打勾 2s（流式消息可复制当前已生成部分） */
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
    <button
      onClick={handleCopy}
      title="复制消息"
      className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-text-muted hover:text-accent-cyan shrink-0 p-0.5"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-accent-green" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

/**
 * memo 的前提是 store 的不可变更新：已归档消息与已完成块引用稳定，
 * 流式事件（每秒可达数十次）不再触发全列表重渲染与 markdown 重新解析
 */
export const ChatMessageView = memo(function ChatMessageView({ message }: { message: ChatMessage }) {
  const showThinking = useStore((s) => s.showThinking);

  if (message.role === 'user') {
    const text = messageText(message);
    return (
      <div id={`msg-${message.id}`} className="flex gap-3 mb-6 message-glow-in rounded-xl group">
        <div className="w-8 h-8 rounded-lg bg-accent-blue/20 border border-accent-blue/30 flex items-center justify-center shrink-0">
          <User className="w-4 h-4 text-accent-blue" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-text-muted font-mono mb-1 flex items-center gap-2">
            USER
            {text && <MessageCopyButton getText={() => text} />}
          </div>
          <div className="glass-panel rounded-xl px-4 py-3">
            <MarkdownRenderer content={text} />
          </div>
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
          {text && <MessageCopyButton getText={() => text} />}
        </div>

        {message.blocks.map((block, i) => (
          <BlockRenderer
            key={i}
            block={block}
            showThinking={showThinking}
            isStreaming={message.status === 'streaming' && i === message.blocks.length - 1}
          />
        ))}
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
