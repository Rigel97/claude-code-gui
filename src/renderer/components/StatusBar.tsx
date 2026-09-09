import { useStore } from '../store';
import { Circle, Loader, CheckCircle, XCircle, Pause, Activity, Zap, Database, Archive } from 'lucide-react';
import { useState } from 'react';
import type { RunStatus, ContextUsage, Conversation } from '../types';

const STATUS_CONFIG: Record<RunStatus, { icon: React.ReactNode; label: string; color: string }> = {
  idle: { icon: <Circle className="w-3 h-3" />, label: '就绪', color: 'text-text-muted' },
  starting: { icon: <Loader className="w-3 h-3 animate-spin" />, label: '启动中', color: 'text-accent-yellow' },
  streaming: { icon: <Activity className="w-3 h-3 animate-pulse" />, label: '生成中', color: 'text-accent-cyan' },
  completed: { icon: <CheckCircle className="w-3 h-3" />, label: '已完成', color: 'text-accent-green' },
  aborted: { icon: <Pause className="w-3 h-3" />, label: '已中断', color: 'text-accent-orange' },
  error: { icon: <XCircle className="w-3 h-3" />, label: '错误', color: 'text-accent-red' },
};

export function StatusBar() {
  const conv = useStore((s): Conversation | undefined =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  );
  // 其他标签页的运行计数（并行会话指示）
  const runningOthers = useStore(
    (s) => s.conversations.filter((c) => c.id !== s.activeConversationId && (c.status === 'streaming' || c.status === 'starting')).length
  );
  const totalInputTokens = useStore((s) => s.totalInputTokens);
  const totalOutputTokens = useStore((s) => s.totalOutputTokens);
  const cwd = useStore((s) => s.cwd);
  const model = useStore((s) => s.model);
  const setContextUsage = useStore((s) => s.setContextUsage);

  const status = conv?.status ?? 'idle';
  const thinkingTokens = conv?.thinkingTokens ?? 0;
  const contextUsage = conv?.contextUsage ?? null;
  const sessionId = conv?.sessionId ?? null;
  const convCwd = conv?.cwd ?? cwd;
  const currentModel = conv?.currentModel || '';
  const displayModel = model || currentModel;

  const config = STATUS_CONFIG[status];
  const isBusy = status === 'streaming' || status === 'starting';

  // 上下文压缩进行中（CLI /compact，需一次总结调用，可能耗时较长）
  const [compacting, setCompacting] = useState(false);

  const handleCompact = async () => {
    if (compacting || !convCwd || !sessionId) return;
    setCompacting(true);
    try {
      const r = await (window as any).api.claude.compact(convCwd, sessionId);
      if (r?.context) setContextUsage(r.context);
      if (r && r.success === false) {
        (window as any).api.notify('上下文压缩失败', String(r.error || '未知错误'));
      }
    } catch {
      /* IPC 异常静默：水位计保持旧值 */
    } finally {
      setCompacting(false);
    }
  };

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

        {/* 并行会话指示：其他标签页正在生成 */}
        {runningOthers > 0 && (
          <div className="flex items-center gap-1 text-accent-cyan" title="其他标签页正在生成，点击对应标签查看">
            <Activity className="w-3 h-3 animate-pulse" />
            <span>{runningOthers} 个后台对话运行中</span>
          </div>
        )}

        {/* 上下文水位计 + 压缩按钮（当前标签页的） */}
        {contextUsage && (
          <>
            <ContextMeter usage={contextUsage} />
            <button
              onClick={handleCompact}
              disabled={!sessionId || isBusy || compacting}
              title={compacting
                ? '正在压缩上下文…'
                : '压缩上下文：把历史折叠为摘要，释放空间（需一次总结调用，可能耗时较长）'}
              className="text-text-dim hover:text-accent-cyan transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
            >
              {compacting
                ? <Loader className="w-3 h-3 animate-spin text-accent-cyan" />
                : <Archive className="w-3 h-3" />}
            </button>
          </>
        )}
      </div>

      {/* 右侧：统计 */}
      <div className="flex items-center gap-4 text-text-muted">
        {displayModel && (
          <span className="text-accent-purple">{displayModel}</span>
        )}

        {convCwd && (
          <span className="text-text-dim truncate max-w-xs">{convCwd}</span>
        )}

        <div className="flex items-center gap-1 text-accent-blue">
          <Zap className="w-3 h-3" />
          <span>in: {formatTokens(totalInputTokens)}</span>
        </div>

        <div className="flex items-center gap-1 text-accent-cyan">
          <Zap className="w-3 h-3" />
          <span>out: {formatTokens(totalOutputTokens)}</span>
        </div>
      </div>
    </div>
  );
}

/** 上下文窗口水位条：>60% 变黄，>85% 变红提醒开新会话 */
function ContextMeter({ usage }: { usage: ContextUsage }) {
  const { used, limit, free, autocompactBuffer } = usage;
  const ratio = Math.min(used / limit, 1);
  const pct = (ratio * 100).toFixed(1);
  const remaining = free ?? Math.max(0, limit - used);
  const color =
    ratio > 0.85
      ? { bar: 'bg-accent-red', text: 'text-accent-red', tip: '上下文即将耗尽，建议新开会话' }
      : ratio > 0.6
        ? { bar: 'bg-accent-yellow', text: 'text-accent-yellow', tip: '上下文占用较高' }
        : { bar: 'bg-accent-cyan', text: 'text-accent-cyan', tip: '上下文占用' };

  const tipLines = [
    `${color.tip}`,
    `已占用：${formatTokens(used)} / ${formatTokens(limit)} (${pct}%)`,
    `剩余可用：${formatTokens(remaining)}`,
  ];
  if (typeof autocompactBuffer === 'number' && autocompactBuffer > 0) {
    tipLines.push(`自动压缩缓冲：${formatTokens(autocompactBuffer)}（剩余低于此值时 CLI 自动压缩历史）`);
  }

  return (
    <div
      className={`flex items-center gap-1.5 ${color.text}`}
      title={tipLines.join('\n')}
    >
      <Database className="w-3 h-3" />
      <div className="w-14 h-1.5 rounded-full bg-bg-lighter overflow-hidden">
        <div
          className={`h-full rounded-full ${color.bar} transition-all duration-500`}
          style={{ width: `${Math.max(ratio * 100, 2)}%` }}
        />
      </div>
      <span>
        {formatTokens(used)}/{formatTokens(limit)}
      </span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${+(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}K`;
  return String(n);
}
