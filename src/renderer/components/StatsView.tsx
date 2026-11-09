import type { ResultMessage } from '../types';
import { Clock, Cpu, Zap, TrendingUp, Layers } from 'lucide-react';

export function StatsView({ data }: { data: ResultMessage }) {
  // CLI 版本间字段可缺省：局部放宽读取，不改变 ResultMessage 契约。
  const metrics: Partial<Omit<ResultMessage, 'usage'>> & { usage?: Partial<ResultMessage['usage']> | null } = data;
  const usage = metrics.usage;
  const tokens = [usage?.input_tokens, usage?.output_tokens, usage?.cache_creation_input_tokens, usage?.cache_read_input_tokens];
  const total = tokens.every(validMetric) ? tokens.reduce((sum, value) => sum + value, 0) : undefined;
  const stats = [
    {
      icon: <Layers className="w-3.5 h-3.5" />,
      label: 'Total',
      value: formatTokens(total),
      color: 'text-accent-green',
    },
    {
      icon: <Cpu className="w-3.5 h-3.5" />,
      label: 'Input',
      value: formatTokens(usage?.input_tokens),
      color: 'text-accent-blue',
    },
    {
      icon: <Zap className="w-3.5 h-3.5" />,
      label: 'Output',
      value: formatTokens(usage?.output_tokens),
      color: 'text-accent-cyan',
    },
    {
      icon: <Clock className="w-3.5 h-3.5" />,
      label: 'Duration',
      value: validMetric(metrics.duration_ms) ? `${(metrics.duration_ms / 1000).toFixed(1)}s` : '—',
      color: 'text-accent-orange',
    },
    {
      icon: <TrendingUp className="w-3.5 h-3.5" />,
      label: 'Turns',
      value: validMetric(metrics.num_turns) ? String(metrics.num_turns) : '—',
      color: 'text-accent-purple',
    },
    {
      icon: <Zap className="w-3.5 h-3.5" />,
      label: 'TTFT',
      value: validMetric(metrics.ttft_ms) ? `${metrics.ttft_ms}ms` : '—',
      color: 'text-accent-yellow',
    },
  ];

  return (
    <div className="rounded-xl border border-border/50 bg-bg-deep/50 px-3 py-2 animate-fade-in">
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        {stats.map((stat, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            <div className={`flex items-center gap-1 ${stat.color}`}>
              {stat.icon}
              <span className="text-[10px] font-mono uppercase opacity-70">{stat.label}</span>
            </div>
            <span className={`text-xs font-mono font-semibold ${stat.color}`}>{stat.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function validMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function formatTokens(n: unknown): string {
  if (!validMetric(n)) return '—';
  if (n >= 1000000) return `${+(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}K`;
  return String(n);
}
