import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { Conversation } from '../types';

const PHASE_CONFIG: Record<string, { dots: string; label: string; color: string }> = {
  requesting: { dots: ' ⟳', label: '正在请求', color: 'text-accent-blue' },
  thinking: { dots: ' 💭', label: '思考中', color: 'text-accent-purple' },
  tool: { dots: ' 🔧', label: '执行工具', color: 'text-accent-yellow' },
  writing: { dots: ' ✎', label: '撰写回复', color: 'text-accent-cyan' },
};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/**
 * 活动反馈条：生成期间显示当前阶段（请求/思考/工具/撰写）+ 已耗时；
 * 思考阶段同时展示思考内容的实时预览（末尾 90 字符，来自逐 token delta）。
 * 解决「执行中长时间无反馈」的感知问题（工具中间输出 CLI 不下发，用阶段+计时缓解）。
 */
export function ActivityStrip({ conv }: { conv: Conversation }) {
  const activity = conv.activity;
  // 1s tick：耗时计时
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!activity) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [activity]);

  if (!activity) return null;

  const config = PHASE_CONFIG[activity.phase] || PHASE_CONFIG.requesting;
  const elapsed = Date.now() - activity.since;

  // 思考实时预览：取流式消息中最后一个 thinking 块的尾部
  let preview = '';
  if (activity.phase === 'thinking' && conv.streamingMessage) {
    for (let i = conv.streamingMessage.blocks.length - 1; i >= 0; i--) {
      const b = conv.streamingMessage.blocks[i];
      if (b.kind === 'thinking') {
        preview = b.text.slice(-90);
        break;
      }
    }
  }

  return (
    <div className="px-6 pb-1 animate-fade-in select-none">
      <div className="flex items-center gap-2 text-[11px] font-mono">
        <span className={`flex items-center gap-1.5 ${config.color}`}>
          <span className="flex gap-0.5">
            <span className="w-1 h-1 rounded-full bg-current animate-pulse" />
            <span className="w-1 h-1 rounded-full bg-current animate-pulse [animation-delay:200ms]" />
            <span className="w-1 h-1 rounded-full bg-current animate-pulse [animation-delay:400ms]" />
          </span>
          <span>
            {config.label}
            {activity.phase === 'tool' && activity.toolName ? ` ${activity.toolName}` : ''}
            <span className="text-text-dim"> · {formatElapsed(elapsed)}</span>
          </span>
        </span>
        {preview && (
          <span className="flex-1 min-w-0 text-text-dim truncate" title="思考实时预览（完整内容见上方思考块）">
            …{preview}
          </span>
        )}
      </div>
    </div>
  );
}
