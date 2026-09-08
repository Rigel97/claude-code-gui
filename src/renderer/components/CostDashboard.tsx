import { useMemo } from 'react';
import { useStore } from '../store';
import { X, BarChart3, CalendarDays, MessageSquare, Zap, Trophy, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import type { SessionEvent } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地时区日期键（toISOString 的 UTC 偏移会使日期标签与本地日历错位一天） */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 从会话列表提取用量事件流（旧数据没有 events 时用 createdAt 单点退化） */
function extractEvents(sessions: ReturnType<typeof useStore.getState>['sessions']): (SessionEvent & { title: string })[] {
  return sessions.flatMap((s) => {
    const base = s.events && s.events.length > 0
      ? s.events
      : [{ t: s.createdAt, cost: s.cost, input: s.inputTokens, output: s.outputTokens }];
    return base.map((e) => ({ ...e, title: s.title }));
  });
}

/** 每日 token 总量（输入 + 输出）；cost 字段保留在事件流中以兼容旧数据，但不再展示 */
export function CostDashboard({ onClose }: { onClose: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const totalInputTokens = useStore((s) => s.totalInputTokens);
  const totalOutputTokens = useStore((s) => s.totalOutputTokens);

  const events = useMemo(() => extractEvents(sessions), [sessions]);

  // 近 14 天按日聚合
  const daily = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days: { label: string; date: string; input: number; output: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getTime() - i * DAY_MS);
      days.push({
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        date: localDateKey(d),
        input: 0,
        output: 0,
      });
    }
    const startTs = today.getTime() - 13 * DAY_MS;
    for (const e of events) {
      if (e.t < startTs) continue;
      const idx = Math.floor((e.t - startTs) / DAY_MS);
      if (idx >= 0 && idx < 14) {
        days[idx].input += e.input;
        days[idx].output += e.output;
      }
    }
    return days;
  }, [events]);

  const last7Tokens = useMemo(
    () => daily.slice(7).reduce((sum, d) => sum + d.input + d.output, 0),
    [daily]
  );

  const topSessions = useMemo(
    () => [...sessions].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)).slice(0, 5),
    [sessions]
  );

  const maxDaily = Math.max(...daily.map((d) => d.input + d.output), 1);

  const stats = [
    { icon: <Zap className="w-4 h-4" />, label: '总 Tokens', value: formatTokens(totalInputTokens + totalOutputTokens), color: 'text-accent-green' },
    { icon: <CalendarDays className="w-4 h-4" />, label: '近 7 天', value: formatTokens(last7Tokens), color: 'text-accent-cyan' },
    { icon: <ArrowDownToLine className="w-4 h-4" />, label: '输入', value: formatTokens(totalInputTokens), color: 'text-accent-blue' },
    { icon: <ArrowUpFromLine className="w-4 h-4" />, label: '输出', value: formatTokens(totalOutputTokens), color: 'text-accent-purple' },
    { icon: <MessageSquare className="w-4 h-4" />, label: '会话数', value: String(sessions.length), color: 'text-accent-orange' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-2xl glass-panel rounded-2xl border border-border overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
          <h2 className="text-sm font-semibold gradient-text-cyan flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-accent-green" />
            Token 用量统计
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* 统计卡片 */}
          <div className="grid grid-cols-5 gap-3">
            {stats.map((stat, i) => (
              <div key={i} className="rounded-xl bg-bg-light/50 border border-border/50 px-3 py-2.5">
                <div className={`flex items-center gap-1.5 ${stat.color} mb-1`}>
                  {stat.icon}
                  <span className="text-[10px] font-mono uppercase opacity-70">{stat.label}</span>
                </div>
                <div className={`text-sm font-mono font-semibold ${stat.color}`}>{stat.value}</div>
              </div>
            ))}
          </div>

          {/* 近 14 天柱状图 */}
          <div>
            <div className="text-xs text-text-secondary font-mono uppercase tracking-wider mb-2">
              近 14 天每日 Token 用量
            </div>
            <div className="rounded-xl bg-bg-deep/50 border border-border/30 p-3">
              {events.length === 0 ? (
                <div className="text-xs text-text-dim text-center py-8">暂无数据，开始对话后这里会展示用量趋势</div>
              ) : (
                <svg viewBox="0 0 560 150" className="w-full">
                  {/* 网格线 */}
                  {[0.25, 0.5, 0.75].map((ratio) => (
                    <line
                      key={ratio}
                      x1="0" y1={110 - ratio * 100} x2="560" y2={110 - ratio * 100}
                      stroke="rgba(30, 37, 56, 0.6)" strokeDasharray="3,3"
                    />
                  ))}
                  {daily.map((d, i) => {
                    const barWidth = 26;
                    const gap = (560 - barWidth * 14) / 15;
                    const x = gap + i * (barWidth + gap);
                    const total = d.input + d.output;
                    const h = Math.max((total / maxDaily) * 100, total > 0 ? 2 : 0);
                    // 输入段（下，蓝）/ 输出段（上，青），按比例堆叠
                    const inH = total > 0 ? (d.input / total) * h : 0;
                    return (
                      <g key={d.date}>
                        <rect
                          x={x} y={110 - h} width={barWidth} height={h}
                          rx={3}
                          fill={total > 0 ? 'url(#barGradient)' : 'rgba(30, 37, 56, 0.4)'}
                        >
                          <title>{`${d.date}\nin ${formatTokens(d.input)} · out ${formatTokens(d.output)} · 共 ${formatTokens(total)} tokens`}</title>
                        </rect>
                        {total > 0 && (
                          <rect
                            x={x} y={110 - h} width={barWidth} height={inH}
                            fill="#3b82f6" opacity={0.65}
                          >
                            <title>{`${d.date}\nin ${formatTokens(d.input)} · out ${formatTokens(d.output)} · 共 ${formatTokens(total)} tokens`}</title>
                          </rect>
                        )}
                        {/* 日期标签（隔一个显示） */}
                        {i % 2 === 1 && (
                          <text
                            x={x + barWidth / 2} y={126}
                            textAnchor="middle"
                            className="fill-text-dim"
                            fontSize="9"
                            fontFamily="monospace"
                          >
                            {d.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  <defs>
                    <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00e5ff" stopOpacity="0.9" />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.5" />
                    </linearGradient>
                  </defs>
                  {/* 基线 */}
                  <line x1="0" y1="110" x2="560" y2="110" stroke="rgba(30, 37, 56, 1)" />
                </svg>
              )}
              {/* 图例 */}
              <div className="flex items-center gap-4 justify-center mt-1 text-[10px] text-text-dim font-mono">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-accent-cyan/70 inline-block" />输出</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-accent-blue/70 inline-block" />输入</span>
              </div>
            </div>
          </div>

          {/* Top 5 用量会话 */}
          <div>
            <div className="flex items-center gap-1.5 text-xs text-text-secondary font-mono uppercase tracking-wider mb-2">
              <Trophy className="w-3.5 h-3.5 text-accent-yellow" />
              用量最高的会话
            </div>
            <div className="space-y-1">
              {topSessions.length === 0 ? (
                <div className="text-xs text-text-dim text-center py-4">暂无会话</div>
              ) : (
                topSessions.map((s, i) => (
                  <div
                    key={s.sessionId}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-light/30 border border-border/30"
                  >
                    <span className={`text-xs font-mono font-bold w-5 shrink-0 ${
                      i === 0 ? 'text-accent-yellow' : i === 1 ? 'text-text-secondary' : i === 2 ? 'text-accent-orange' : 'text-text-dim'
                    }`}>
                      {i + 1}
                    </span>
                    <span className="flex-1 text-xs text-text-primary truncate">{s.title}</span>
                    {s.model && (
                      <span className="text-[10px] text-text-dim font-mono shrink-0 hidden md:block">
                        {s.model}
                      </span>
                    )}
                    <span className="text-xs text-accent-green font-mono font-semibold shrink-0">
                      {formatTokens(s.inputTokens + s.outputTokens)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}K`;
  return String(n);
}
