import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { useProjectsStore } from '../projectStore';
import { X, BarChart3, Trophy, ArrowUpRight } from 'lucide-react';
import type { SessionEvent } from '../types';
import { useDialogBehavior } from './useDialogBehavior';
import { formatTokens, TOKEN_LABELS } from '../utils/format';

const INPUT_COLOR = '#3b82f6';
const OUTPUT_COLOR = '#00e5ff';
const exactTokens = (value: number) => Number.isFinite(value) && value >= 0 ? value.toLocaleString('en-US') : '—';

/** 使用本地日历键，而非固定24小时桶，以兼容夏令时。 */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 旧归档没有事件流时仍回退到 createdAt 上的累计用量。 */
function extractEvents(sessions: ReturnType<typeof useStore.getState>['sessions']): SessionEvent[] {
  return sessions.flatMap((s) => s.events && s.events.length > 0
    ? s.events
    : [{ t: s.createdAt, cost: s.cost, input: s.inputTokens, output: s.outputTokens }]);
}

/** 四个等间隔，刻度取1/2/5的整洁步长；零数据仅提供图架刻度。 */
function chartScale(max: number): { step: number; ceiling: number } {
  const rawStep = Math.max(max, 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = Math.max(1, [1, 2, 5, 10].find(n => n * magnitude >= rawStep)! * magnitude);
  return { step, ceiling: step * 4 };
}

export function CostDashboard({ onClose }: { onClose: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const totalInputTokens = useStore((s) => s.totalInputTokens);
  const totalOutputTokens = useStore((s) => s.totalOutputTokens);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dateRefs = useRef<(SVGGElement | null)[]>([]);
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);
  const [navigationError, setNavigationError] = useState('');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  useDialogBehavior({ open: true, dialogRef, onRequestClose: onClose, initialFocusSelector: '[aria-label="关闭用量统计"]' });

  const events = useMemo(() => extractEvents(sessions), [sessions]);
  const todayKey = localDateKey(new Date());
  const daily = useMemo(() => {
    const [year, month, day] = todayKey.split('-').map(Number);
    const days = Array.from({ length: 14 }, (_, i) => {
      const date = new Date(year, month - 1, day - 13 + i);
      return { label: `${date.getMonth() + 1}/${date.getDate()}`, date: localDateKey(date), input: 0, output: 0 };
    });
    const byDate = new Map(days.map(d => [d.date, d]));
    for (const event of events) {
      const bucket = byDate.get(localDateKey(new Date(event.t)));
      if (bucket) { bucket.input += event.input; bucket.output += event.output; }
    }
    return days;
  }, [events, todayKey]);

  const last7Tokens = daily.slice(7).reduce((sum, d) => sum + d.input + d.output, 0);
  const topSessions = useMemo(
    () => [...sessions].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)).slice(0, 5),
    [sessions]
  );
  const maxDaily = Math.max(...daily.map(d => d.input + d.output), 0);
  const { step, ceiling } = chartScale(maxDaily);
  const selectedIndex = Math.max(0, selectedDate ? daily.findIndex(d => d.date === selectedDate) : 13);
  const selected = daily[selectedIndex];
  const maxSession = topSessions[0] ? topSessions[0].inputTokens + topSessions[0].outputTokens : 0;

  const openSession = async (sessionId: string) => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setNavigationError('');
    try {
      if (!useStore.getState().sessions.some(s => s.sessionId === sessionId)) throw new Error('该归档会话已不存在。');
      if (!(await useProjectsStore.getState().showChat())) {
        setNavigationError('已取消打开会话，项目草稿未丢弃。');
        return;
      }
      useStore.getState().openSessionTab(sessionId);
      const state = useStore.getState();
      if (!state.conversations.some(c => c.id === state.activeConversationId && c.sessionId === sessionId)) {
        throw new Error('未能打开归档标签，请确认会话仍保留在本地。');
      }
      onClose();
    } catch (error) {
      setNavigationError(`打开会话失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm animate-fade-in"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Token 用量统计"
        className="flex max-h-[calc(100dvh-24px)] w-[min(820px,94vw)] flex-col overflow-hidden rounded-2xl border border-border glass-panel">
        <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <BarChart3 className="h-4 w-4 text-accent-green" />Token 用量统计
          </h2>
          <button type="button" onClick={onClose} aria-label="关闭用量统计"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-bg-light hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5">
          <section aria-label="归档用量汇总" className="overflow-hidden rounded-xl border border-border/50 bg-bg-light/40">
            <dl className="grid grid-cols-1 items-center gap-4 p-4 sm:grid-cols-[1fr_1fr]">
              <div className="min-w-0">
                <dt className="text-xs text-text-secondary">{TOKEN_LABELS.total}</dt>
                <dd className="mt-1 break-all font-mono text-3xl font-semibold tabular-nums text-text-primary" title={exactTokens(totalInputTokens + totalOutputTokens)}>
                  {formatTokens(totalInputTokens + totalOutputTokens)}
                  <span className="ml-2 text-xs font-normal text-text-muted">Token</span>
                </dd>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:border-l sm:border-border/50 sm:pl-4">
                {[{ label: TOKEN_LABELS.input, value: totalInputTokens, color: INPUT_COLOR }, { label: TOKEN_LABELS.output, value: totalOutputTokens, color: OUTPUT_COLOR }].map(item => (
                  <div key={item.label} className="min-w-0">
                    <dt className="flex items-center gap-1.5 text-xs text-text-secondary"><span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />{item.label}</dt>
                    <dd className="mt-1 break-all font-mono text-lg tabular-nums text-text-primary" title={exactTokens(item.value)}>{formatTokens(item.value)}</dd>
                  </div>
                ))}
              </div>
            </dl>
            <dl className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border/40 px-4 py-2 text-xs text-text-secondary">
              <div className="flex items-baseline gap-2"><dt>会话数</dt><dd className="font-mono tabular-nums text-text-primary">{sessions.length}</dd></div>
              <div className="flex items-baseline gap-2"><dt>{TOKEN_LABELS.last7}</dt><dd className="font-mono tabular-nums text-text-primary" title={exactTokens(last7Tokens)}>{formatTokens(last7Tokens)} Token</dd></div>
            </dl>
          </section>
          <p className="text-2xs leading-5 text-text-secondary">统计口径：仅当前保留的归档会话；已清空的会话会从累计值中扣除。“近 7 天”包含今天。输入 / 输出按 CLI 上报的 token 计。</p>

          <section aria-label="每日用量趋势">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-text-secondary">近 14 天每日 Token 用量</h3>
              <div className="flex gap-4 text-2xs text-text-secondary">
                {[{ label: '输入（上）', color: INPUT_COLOR }, { label: '输出（下）', color: OUTPUT_COLOR }].map(item => (
                  <span key={item.label} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ backgroundColor: item.color }} />{item.label}</span>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border/30 bg-bg-deep/50 p-3">
              <div className="relative">
                <svg viewBox="0 0 700 180" className="block w-full" role="group" aria-label="近 14 天每日 Token 用量柱状图" aria-describedby="usage-chart-help">
                  <title>{`近 14 天每日 Token 用量，最高单日 ${exactTokens(maxDaily)} Token`}</title>
                  {[0, 1, 2, 3, 4].map(tick => (
                    <g key={tick} aria-hidden="true">
                      <line x1="62" y1={144 - tick * 30} x2="692" y2={144 - tick * 30} className="stroke-border" strokeDasharray={tick ? '3,3' : undefined} />
                      <text x="54" y={148 - tick * 30} textAnchor="end" className="fill-text-muted" fontSize="11" fontFamily="monospace">{formatTokens(tick * step)}</text>
                    </g>
                  ))}
                  {daily.map((d, i) => {
                    const x = 62 + i * 45;
                    const inputHeight = d.input / ceiling * 120;
                    const outputHeight = d.output / ceiling * 120;
                    const description = `${d.date}：${TOKEN_LABELS.input} ${exactTokens(d.input)}，${TOKEN_LABELS.output} ${exactTokens(d.output)}，合计 ${exactTokens(d.input + d.output)} Token`;
                    return (
                      <g key={d.date} ref={node => { dateRefs.current[i] = node; }} role="button" tabIndex={i === selectedIndex ? 0 : -1}
                        aria-label={description} aria-pressed={i === selectedIndex} data-date={d.date}
                        className="group cursor-pointer focus:outline-none"
                        onMouseEnter={() => setSelectedDate(d.date)} onFocus={() => setSelectedDate(d.date)} onClick={() => setSelectedDate(d.date)}
                        onKeyDown={event => {
                          let next = i;
                          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(13, i + 1);
                          else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, i - 1);
                          else if (event.key === 'Home') next = 0;
                          else if (event.key === 'End') next = 13;
                          else if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          setSelectedDate(daily[next].date);
                          dateRefs.current[next]?.focus();
                        }}>
                        <title>{description}</title>
                        {/* 全高透明命中区不是数据柱：零日不渲染任何彩色stub。 */}
                        <rect x={x + 1} y="20" width="43" height="128" fill="transparent" className="group-focus:stroke-accent-cyan" />
                        {d.output > 0 && <rect data-series="output" x={x + 8} y={144 - outputHeight} width="29" height={outputHeight} fill={OUTPUT_COLOR} />}
                        {d.input > 0 && <rect data-series="input" x={x + 8} y={144 - outputHeight - inputHeight} width="29" height={inputHeight} fill={INPUT_COLOR} />}
                        {i === selectedIndex && <line x1={x + 7} x2={x + 38} y1="150" y2="150" className="stroke-text-secondary" strokeWidth="2" />}
                        {(i % 2 === 0 || i === 13) && <text x={x + 22.5} y="168" textAnchor="middle" className="fill-text-secondary" fontSize="11" fontFamily="monospace">{d.label}</text>}
                      </g>
                    );
                  })}
                </svg>
                {maxDaily === 0 && <p className="pointer-events-none absolute inset-x-16 top-1/3 text-center text-xs text-text-secondary">近 14 天暂无用量数据</p>}
              </div>
              <div role="status" aria-live="polite" aria-atomic="true" className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-border/30 pt-2 font-mono text-xs tabular-nums text-text-secondary">
                <span>{selected.date}</span>
                <span>{TOKEN_LABELS.input} <strong className="font-medium text-text-primary">{exactTokens(selected.input)}</strong></span>
                <span>{TOKEN_LABELS.output} <strong className="font-medium text-text-primary">{exactTokens(selected.output)}</strong></span>
                <span>合计 <strong className="font-medium text-text-primary">{exactTokens(selected.input + selected.output)}</strong> Token</span>
              </div>
              <p id="usage-chart-help" className="mt-2 text-2xs text-text-muted">悬停或点击查看精确用量；Tab 聚焦日期，方向键切换，Home / End 跳至首尾。</p>
              <details className="mt-2 text-2xs text-text-secondary">
                <summary className="w-fit cursor-pointer rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan">查看每日数据表</summary>
                <div className="overflow-x-auto">
                  <table className="mt-2 w-full text-left font-mono text-2xs tabular-nums">
                    <caption className="sr-only">近 14 天每日精确 Token 用量</caption>
                    <thead><tr className="text-text-muted"><th scope="col" className="py-1">日期</th><th scope="col" className="py-1 text-right">输入</th><th scope="col" className="py-1 text-right">输出</th><th scope="col" className="py-1 text-right">合计</th></tr></thead>
                    <tbody>{daily.map(d => (
                      <tr key={d.date} className="border-t border-border/30"><th scope="row" className="whitespace-nowrap py-1 font-normal">{d.date}</th><td className="py-1 text-right">{exactTokens(d.input)}</td><td className="py-1 text-right">{exactTokens(d.output)}</td><td className="py-1 text-right">{exactTokens(d.input + d.output)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </details>
            </div>
          </section>

          <section aria-label="用量最高的会话">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-text-secondary">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold"><Trophy className="h-3.5 w-3.5 text-accent-yellow" />用量最高的会话 · Top 5</h3>
              <span className="text-2xs text-text-muted">相对最高会话 · 点击打开归档</span>
            </div>
            {navigationError && <p role="alert" className="mb-2 break-words text-xs text-accent-orange">{navigationError}</p>}
            {opening && <p role="status" className="mb-2 text-xs text-text-secondary">正在打开归档会话…</p>}
            {topSessions.length === 0 ? <p className="py-4 text-center text-xs text-text-secondary">暂无会话</p> : (
              <ol className="divide-y divide-border/30 rounded-xl border border-border/30 bg-bg-light/20">
                {topSessions.map((s, i) => {
                  const total = s.inputTokens + s.outputTokens;
                  const ratio = maxSession > 0 ? total / maxSession : 0;
                  return (
                    <li key={s.sessionId}>
                      <button type="button" disabled={opening} onClick={() => { void openSession(s.sessionId); }} aria-label={`打开归档会话 ${s.title}`}
                        className="grid w-full grid-cols-[20px_minmax(0,1fr)_100px_16px] items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-bg-light/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan disabled:opacity-50 sm:grid-cols-[20px_minmax(0,1fr)_140px_16px]">
                        <span className="text-center font-mono text-xs tabular-nums text-text-muted">{i + 1}</span>
                        <span className="min-w-0"><span className="block truncate text-xs text-text-primary" title={s.title}>{s.title}</span>{s.model && <span className="block truncate font-mono text-2xs text-text-muted" title={s.model}>{s.model}</span>}</span>
                        <span className="min-w-0 text-right"><span className="block font-mono text-xs tabular-nums text-text-primary" title={`${exactTokens(total)} Token`}>{formatTokens(total)} <span className="text-2xs text-text-muted">Token</span></span>
                          <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-bg-lighter" aria-hidden="true"><span data-session-share={s.sessionId} className="block h-full bg-accent-green/70" style={{ width: `${ratio * 100}%` }} /></span>
                        </span>
                        <ArrowUpRight className="h-3.5 w-3.5 text-text-muted" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
