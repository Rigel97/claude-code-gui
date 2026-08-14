import type { ChatMessage, UIBlock } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallView } from './ToolCallView';
import { StatsView } from './StatsView';
import { ThinkingView } from './ThinkingView';
import { User } from 'lucide-react';
import { useStore } from '../store';

export function ChatMessageView({ message }: { message: ChatMessage }) {
  const showThinking = useStore((s) => s.showThinking);

  if (message.role === 'user') {
    return (
      <div className="flex gap-3 mb-6 message-glow-in">
        <div className="w-8 h-8 rounded-lg bg-accent-blue/20 border border-accent-blue/30 flex items-center justify-center shrink-0">
          <User className="w-4 h-4 text-accent-blue" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-text-muted font-mono mb-1">USER</div>
          <div className="glass-panel rounded-xl px-4 py-3">
            <MarkdownRenderer content={message.blocks.map(b => b.kind === 'text' ? b.text : '').join('')} />
          </div>
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex gap-3 mb-6 message-glow-in">
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
          <BlockRenderer key={i} block={block} showThinking={showThinking} isStreaming={message.status === 'streaming' && i === message.blocks.length - 1} />
        ))}
      </div>
    </div>
  );
}

function BlockRenderer({ block, showThinking, isStreaming }: { block: UIBlock; showThinking: boolean; isStreaming: boolean }) {
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
          <pre className="text-xs text-accent-red/80 font-mono whitespace-pre-wrap">{block.text}</pre>
        </div>
      );

    case 'stats':
      return <StatsView data={block.data} />;

    default:
      return null;
  }
}
