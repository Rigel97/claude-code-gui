import { useStore } from '../store';
import { ChatMessageView } from './ChatMessageView';
import { InputBar } from './InputBar';
import { useRef, useEffect } from 'react';

export function ChatArea() {
  const messages = useStore((s) => s.messages);
  const streamingMessage = useStore((s) => s.streamingMessage);
  const addUserMessage = useStore((s) => s.addUserMessage);
  const status = useStore((s) => s.status);
  const thinkingTokens = useStore((s) => s.thinkingTokens);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingMessage, thinkingTokens]);

  const isEmpty = messages.length === 0 && !streamingMessage;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* 消息流 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 py-4"
      >
        {/* 历史消息 */}
        {messages.map((msg) => (
          <ChatMessageView key={msg.id} message={msg} />
        ))}

        {/* 流式消息 */}
        {streamingMessage && (
          <ChatMessageView message={streamingMessage} />
        )}

        {/* 空状态提示 */}
        {isEmpty && status === 'idle' && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="relative mb-6">
              <div className="absolute inset-0 bg-accent-cyan/20 blur-3xl rounded-full" />
              <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-accent-cyan/20 to-accent-purple/20 border border-accent-cyan/30 flex items-center justify-center">
                <svg className="w-8 h-8 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
            </div>
            <div className="font-mono text-sm text-accent-green mb-2 flex items-center gap-2">
              <span>●</span>
              <span className="tracking-widest">LINK ESTABLISHED</span>
            </div>
            <p className="text-sm text-text-muted max-w-md font-mono">
              链路已就绪，等待指令输入<span className="stream-cursor" />
            </p>
          </div>
        )}

        {/* 思考中指示器 */}
        {status === 'streaming' && thinkingTokens > 0 && !streamingMessage && (
          <ThinkingIndicator tokens={thinkingTokens} />
        )}
      </div>

      {/* 输入栏 */}
      <InputBar onSend={addUserMessage} />
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
      <span className="font-mono text-xs">思考中... {tokens} tokens</span>
    </div>
  );
}
