import type { ResultMessage } from '../types';
import { Clock, Coins, Cpu, Zap, TrendingUp } from 'lucide-react';

export function StatsView({ data }: { data: ResultMessage }) {
  const stats = [
    {
      icon: <Coins className="w-3.5 h-3.5" />,
      label: 'Cost',
      value: `$${data.total_cost_usd.toFixed(6)}`,
      color: 'text-accent-green',
    },
    {
      icon: <Cpu className="w-3.5 h-3.5" />,
      label: 'Input',
      value: `${formatTokens(data.usage.input_tokens)}`,
      color: 'text-accent-blue',
    },
    {
      icon: <Zap className="w-3.5 h-3.5" />,
      label: 'Output',
      value: `${formatTokens(data.usage.output_tokens)}`,
      color: 'text-accent-cyan',
    },
    {
      icon: <Clock className="w-3.5 h-3.5" />,
      label: 'Duration',
      value: `${(data.duration_ms / 1000).toFixed(1)}s`,
      color: 'text-accent-orange',
    },
    {
      icon: <TrendingUp className="w-3.5 h-3.5" />,
      label: 'Turns',
      value: `${data.num_turns}`,
      color: 'text-accent-purple',
    },
    {
      icon: <Zap className="w-3.5 h-3.5" />,
      label: 'TTFT',
      value: `${data.ttft_ms}ms`,
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

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
