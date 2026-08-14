import { useStore } from '../store';
import { Circle, Loader, CheckCircle, XCircle, AlertCircle, Pause, Activity, DollarSign, Zap } from 'lucide-react';
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

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
