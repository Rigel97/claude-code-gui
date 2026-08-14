import { useStore } from '../store';
import { Circle, Loader, CheckCircle, XCircle, AlertCircle, Pause, Activity, DollarSign, Zap, Database } from 'lucide-react';
import type { RunStatus } from '../types';

const STATUS_CONFIG: Record<RunStatus, { icon: React.ReactNode; label: string; color: string }> = {
  idle: { icon: <Circle className="w-3 h-3" />, label: '就绪', color: 'text-text-muted' },
  starting: { icon: <Loader className="w-3 h-3 animate-spin" />, label: '启动中', color: 'text-accent-yellow' },
  streaming: { icon: <Activity className="w-3 h-3 animate-pulse" />, label: '生成中', color: 'text-accent-cyan' },
  completed: { icon: <CheckCircle className="w-3 h-3" />, label: '已完成', color: 'text-accent-green' },
  aborted: { icon: <Pause className="w-3 h-3" />, label: '已中断', color: 'text-accent-orange' },
  error: { icon: <XCircle className="w-3 h-3" />, label: '错误', color: 'text-accent-red' },
};

export function StatusBar() {
  const status = useStore((s) => s.status);
  const thinkingTokens = useStore((s) => s.thinkingTokens);
  const totalCost = useStore((s) => s.totalCost);
  const totalInputTokens = useStore((s) => s.totalInputTokens);
  const totalOutputTokens = useStore((s) => s.totalOutputTokens);
  const cwd = useStore((s) => s.cwd);
  const currentModel = useStore((s) => s.currentModel);
  const contextUsage = useStore((s) => s.contextUsage);

  const config = STATUS_CONFIG[status];

  return (
    <div className="flex items-center justify-between h-7 px-4 bg-bg-deep border-t border-border/30 text-[10px] font-mono shrink-0">
      {/* 左侧：状态 */}
      <div className="flex items-center gap-4">
        <div className={`flex items-center gap-1.5 ${config.color}`}>
          {config.icon}
          <span>{config.label}</span>
        </div>

        {thinkingTokens > 0 && status === 'streaming' && (
          <div className="flex items-center gap-1.5 text-accent-purple">
            <span>thinking: {thinkingTokens} tokens</span>
          </div>
        )}

        {/* 上下文水位计 */}
        {contextUsage && (
          <ContextMeter used={contextUsage.used} limit={contextUsage.limit} />
        )}
      </div>

      {/* 右侧：统计 */}
      <div className="flex items-center gap-4 text-text-muted">
        {currentModel && (
          <span className="text-accent-purple">{currentModel}</span>
        )}

        {cwd && (
          <span className="text-text-dim truncate max-w-xs">{cwd}</span>
        )}

        <div className="flex items-center gap-1 text-accent-blue">
          <Zap className="w-3 h-3" />
          <span>in: {formatTokens(totalInputTokens)}</span>
        </div>

        <div className="flex items-center gap-1 text-accent-cyan">
          <Zap className="w-3 h-3" />
          <span>out: {formatTokens(totalOutputTokens)}</span>
        </div>

        <div className="flex items-center gap-1 text-accent-green">
          <DollarSign className="w-3 h-3" />
          <span>${totalCost.toFixed(4)}</span>
        </div>
      </div>
    </div>
  );
}

/** 上下文窗口水位条：>60% 变黄，>85% 变红提醒开新会话 */
function ContextMeter({ used, limit }: { used: number; limit: number }) {
  const ratio = Math.min(used / limit, 1);
  const pct = (ratio * 100).toFixed(1);
  const color =
    ratio > 0.85
      ? { bar: 'bg-accent-red', text: 'text-accent-red', tip: '上下文即将耗尽，建议新开会话' }
      : ratio > 0.6
        ? { bar: 'bg-accent-yellow', text: 'text-accent-yellow', tip: '上下文占用较高' }
        : { bar: 'bg-accent-cyan', text: 'text-accent-cyan', tip: '上下文占用' };

  return (
    <div
      className={`flex items-center gap-1.5 ${color.text}`}
      title={`${color.tip}\n${formatTokens(used)} / ${formatTokens(limit)} tokens (${pct}%)`}
    >
      <Database className="w-3 h-3" />
      <div className="w-16 h-1.5 rounded-full bg-bg-lighter overflow-hidden">
        <div
          className={`h-full rounded-full ${color.bar} transition-all duration-500`}
          style={{ width: `${Math.max(ratio * 100, 2)}%` }}
        />
      </div>
      <span>{pct}%</span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
