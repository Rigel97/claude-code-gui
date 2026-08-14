import { useMemo, useState } from 'react';
import { ChevronsUpDown, ChevronsUp } from 'lucide-react';

interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
}

type RenderRow = DiffLine | { type: 'fold'; count: number };

/**
 * 基于 LCS 的行级 diff。
 * 行数乘积过大时（O(n·m) 会卡死渲染），退化为「全删 + 全增」展示。
 */
function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');

  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text): DiffLine => ({ type: 'del', text })),
      ...b.map((text): DiffLine => ({ type: 'add', text })),
    ];
  }

  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** 折叠未变化的上下文行，只保留变化行上下各 ctxLines 行 */
function collapseContext(lines: DiffLine[], ctxLines = 2): RenderRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, idx) => {
    if (line.type !== 'ctx') {
      for (let k = Math.max(0, idx - ctxLines); k <= Math.min(lines.length - 1, idx + ctxLines); k++) {
        keep[k] = true;
      }
    }
  });

  const rows: RenderRow[] = [];
  let foldCount = 0;
  const flushFold = () => {
    if (foldCount > 0) {
      rows.push({ type: 'fold', count: foldCount });
      foldCount = 0;
    }
  };
  lines.forEach((line, idx) => {
    if (keep[idx]) {
      flushFold();
      rows.push(line);
    } else {
      foldCount++;
    }
  });
  flushFold();
  return rows;
}

export function DiffView({ oldText, newText, label }: {
  oldText: string;
  newText: string;
  label?: string;
}) {
  const [showAll, setShowAll] = useState(false);

  const { rows, addCount, delCount, totalLines } = useMemo(() => {
    const lines = computeLineDiff(oldText, newText);
    const adds = lines.filter((l) => l.type === 'add').length;
    const dels = lines.filter((l) => l.type === 'del').length;
    // 变化少时全量展示上下文；变化分散时折叠
    const rendered = showAll ? lines : collapseContext(lines);
    return { rows: rendered, addCount: adds, delCount: dels, totalLines: lines.length };
  }, [oldText, newText, showAll]);

  const COLLAPSE_THRESHOLD = 60;

  return (
    <div className="rounded-lg border border-border/50 bg-bg-deepest/80 overflow-hidden">
      {/* 头部统计 */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border/30 bg-bg-deep/50">
        {label && <span className="text-[10px] font-mono text-text-dim truncate flex-1">{label}</span>}
        <span className="flex-1" />
        <span className="text-[10px] font-mono text-accent-green">+{addCount}</span>
        <span className="text-[10px] font-mono text-accent-red">-{delCount}</span>
      </div>

      {/* diff 内容 */}
      <div className="overflow-x-auto max-h-80 overflow-y-auto">
        <pre className="text-[11px] font-mono leading-5 min-w-full">
          {rows.map((row, i) => {
            if (row.type === 'fold') {
              return (
                <div key={i} className="px-3 py-0.5 text-text-dim/60 bg-bg-deep/30 select-none">
                  ⋯ {row.count} 行未变化 ⋯
                </div>
              );
            }
            const prefix = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
            const cls = row.type === 'add'
              ? 'bg-accent-green/10 text-accent-green/90'
              : row.type === 'del'
                ? 'bg-accent-red/10 text-accent-red/90'
                : 'text-text-dim';
            return (
              <div key={i} className={`px-3 whitespace-pre ${cls}`}>
                <span className="inline-block w-3 select-none opacity-70">{prefix}</span>
                {row.text || ' '}
              </div>
            );
          })}
        </pre>
      </div>

      {/* 展开全部 */}
      {totalLines > COLLAPSE_THRESHOLD && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="w-full flex items-center justify-center gap-1 px-2 py-1 border-t border-border/30 text-[10px] font-mono text-text-dim hover:text-accent-cyan hover:bg-bg-light/50 transition-colors"
        >
          {showAll ? <ChevronsUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
          {showAll ? '折叠上下文' : `展开全部 ${totalLines} 行`}
        </button>
      )}
    </div>
  );
}
