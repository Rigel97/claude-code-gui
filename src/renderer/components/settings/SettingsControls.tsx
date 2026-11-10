import type { ReactNode } from 'react';
import { AlertTriangle, Check, Info } from 'lucide-react';
import { BUTTON_SM, BUTTON_SM_PRIMARY } from '../controls';

type ApplyMode = 'immediate' | 'save' | 'save-try' | 'reconnect';

const APPLY_COPY: Record<ApplyMode, { label: string; className: string }> = {
  immediate: { label: '立即生效', className: 'text-accent-green bg-accent-green/10 border-accent-green/25' },
  save: { label: '保存后生效', className: 'text-accent-cyan bg-accent-cyan/10 border-accent-cyan/25' },
  'save-try': { label: '保存后尝试立即应用', className: 'text-accent-cyan bg-accent-cyan/10 border-accent-cyan/25' },
  reconnect: { label: '重新连接后生效', className: 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/25' },
};

export function ApplyBadge({ mode }: { mode: ApplyMode }) {
  const copy = APPLY_COPY[mode];
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-2xs leading-4 ${copy.className}`}>
      {copy.label}
    </span>
  );
}

export function SettingRow({
  id,
  title,
  description,
  technical,
  apply,
  warning,
  children,
  disabled,
  savedValue,
  draftValue,
}: {
  id: string;
  title: string;
  description: string;
  technical?: string;
  apply?: ApplyMode;
  warning?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
  savedValue?: string;
  draftValue?: string;
}) {
  return (
    <section
      id={`setting-${id}`}
      aria-label={title}
      className={`grid gap-3 border-b border-border/30 py-4 last:border-b-0 lg:grid-cols-[minmax(180px,0.9fr)_minmax(0,1.1fr)] ${disabled ? 'opacity-50' : ''}`}
    >
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">{description}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {apply && <ApplyBadge mode={apply} />}
          {technical && <code className="text-2xs text-text-dim font-mono">{technical}</code>}
        </div>
        {warning && <div className="mt-2 flex items-start gap-1.5 text-2xs leading-relaxed text-accent-yellow">{warning}</div>}
      </div>
      <div className="min-w-0">
        {children}
        {savedValue !== undefined && (
          <p className="mt-2 break-words text-2xs leading-5 text-text-secondary">
            已保存：<span className="text-text-primary">{savedValue}</span>
            {draftValue !== undefined && draftValue !== savedValue && <span className="ml-2 text-accent-yellow">待保存：{draftValue}</span>}
          </p>
        )}
      </div>
    </section>
  );
}

export function SectionIntro({ title, description }: { title: string; description: string }) {
  return (
    <header className="mb-1">
      <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">{description}</p>
    </header>
  );
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  columns = 6,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; desc?: string }[];
  onChange: (value: T) => void;
  columns?: number;
}) {
  const grid = columns >= 6 ? 'grid-cols-3' : columns === 4 ? 'grid-cols-2' : 'grid-cols-3';
  return (
    <div role="group" aria-label={label} className={`grid gap-1.5 ${grid}`}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={String(option.id) || 'default'}
            type="button"
            aria-pressed={active}
            title={option.desc}
            onClick={() => onChange(option.id)}
            className={`${active ? BUTTON_SM_PRIMARY : BUTTON_SM} min-h-7 justify-center !px-1.5`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  on,
  onChange,
}: {
  label: string;
  description: string;
  on: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={`flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan ${
        on ? 'border-accent-cyan/35 bg-accent-cyan/5' : 'border-border bg-bg-light/60 hover:border-border-light'
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm text-text-primary">{label}</span>
        <span className="mt-1 block text-xs leading-relaxed text-text-secondary">{description}</span>
      </span>
      <span className={`mt-0.5 h-5 w-9 shrink-0 rounded-full relative transition-colors ${on ? 'bg-accent-cyan/40' : 'bg-bg-lighter'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-text-primary transition-all ${on ? 'left-4' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

export function InfoNote({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warning' | 'success' }) {
  const toneClass = tone === 'warning'
    ? 'border-accent-yellow/30 bg-accent-yellow/5 text-accent-yellow'
    : tone === 'success'
      ? 'border-accent-green/25 bg-accent-green/5 text-accent-green'
      : 'border-border/50 bg-bg-light/40 text-text-secondary';
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-2xs leading-relaxed ${toneClass}`}>
      {tone === 'warning' ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : tone === 'success' ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function DangerZone({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-4 rounded-lg border border-accent-red/35 bg-accent-red/5 p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-accent-red">
        <AlertTriangle className="h-4 w-4" />
        {title}
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function StatusPill({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'ok' | 'warn' }) {
  const valueClass = tone === 'warn' ? 'text-accent-yellow' : tone === 'ok' ? 'text-accent-green' : 'text-text-primary';
  return (
    <div className="min-w-0">
      <div className="text-2xs text-text-muted">{label}</div>
      <div className={`mt-0.5 truncate text-xs font-medium ${valueClass}`} title={value}>{value}</div>
    </div>
  );
}

export function UsageMeter({ used, limit }: { used: number | null | undefined; limit: number | null | undefined }) {
  const safeUsed = Number.isFinite(used ?? NaN) && (used ?? 0) > 0 ? (used as number) : 0;
  const safeLimit = Number.isFinite(limit ?? NaN) && (limit ?? 0) > 0 ? (limit as number) : 0;
  const percent = safeLimit > 0 ? Math.min(100, Math.max(0, (safeUsed / safeLimit) * 100)) : 0;
  return (
    <div className="rounded-xl border border-border/50 bg-bg-light/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-text-secondary">上下文占用</span>
        <span className="text-2xs text-text-muted font-mono">
          {safeLimit > 0 ? `${Math.round(safeUsed).toLocaleString()} / ${Math.round(safeLimit).toLocaleString()}` : '尚未连接'}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-lighter">
        <div className="h-full rounded-full bg-accent-cyan transition-all" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-1.5 text-2xs text-text-dim">
        {safeLimit > 0 ? `已使用 ${percent.toFixed(1)}%` : '连接当前会话后可读取真实窗口占用'}
      </div>
    </div>
  );
}
