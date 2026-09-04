import { describe, it, expect } from 'vitest';
import { computeLineDiff, collapseContext } from '../src/renderer/components/DiffView';

const kinds = (lines: { type: string }[]) => lines.map((l) => l.type);

const line = (type: 'add' | 'del' | 'ctx', text: string) => ({ type, text });

describe('computeLineDiff（LCS 行级 diff）', () => {
  it('单行替换：ctx / del / add / ctx', () => {
    const out = computeLineDiff('a\nb\nc', 'a\nx\nc');
    expect(kinds(out)).toEqual(['ctx', 'del', 'add', 'ctx']);
    expect(out.map((l) => l.text)).toEqual(['a', 'b', 'x', 'c']);
  });

  it('纯新增：旧为空', () => {
    const out = computeLineDiff('', 'x\ny');
    expect(kinds(out)).toEqual(['add', 'add']);
  });

  it('纯删除：新为空', () => {
    const out = computeLineDiff('x\ny', '');
    expect(kinds(out)).toEqual(['del', 'del']);
  });

  it('完全一致：全为上下文行', () => {
    const out = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(kinds(out)).toEqual(['ctx', 'ctx', 'ctx']);
  });

  it('保留公共子序列（LCS 正确性）', () => {
    const out = computeLineDiff('1\n2\n3\n4\n5', '1\n9\n3\n8\n5');
    const ctxTexts = out.filter((l) => l.type === 'ctx').map((l) => l.text);
    expect(ctxTexts).toEqual(['1', '3', '5']);
  });

  it('行数乘积超阈值时退化为全删+全增（不卡死）', () => {
    const a = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 500 }, (_, i) => `b${i}`).join('\n');
    const out = computeLineDiff(a, b);
    expect(out.length).toBe(600 + 500); // 无 ctx 行
    expect(out.filter((l) => l.type === 'del').length).toBe(600);
    expect(out.filter((l) => l.type === 'add').length).toBe(500);
  });

  it('两空串：无输出行', () => {
    expect(computeLineDiff('', '')).toEqual([]);
  });
});

describe('collapseContext（上下文折叠）', () => {
  it('保留变化行上下各 2 行，其余折叠', () => {
    // 10 行 ctx，第 5 行（索引 4）是变化行
    const lines = [
      line('ctx', 'l0'),
      line('ctx', 'l1'),
      line('ctx', 'l2'),
      line('ctx', 'l3'),
      line('add', 'NEW'),
      line('ctx', 'l5'),
      line('ctx', 'l6'),
      line('ctx', 'l7'),
      line('ctx', 'l8'),
      line('ctx', 'l9'),
    ];
    const rows = collapseContext(lines);
    // 头部折叠 2 行（l0 l1），保留 l2..l6，尾部折叠 3 行（l7 l8 l9）
    expect(rows[0]).toEqual({ type: 'fold', count: 2 });
    expect(rows.slice(1, -1)).toEqual([
      line('ctx', 'l2'),
      line('ctx', 'l3'),
      line('add', 'NEW'),
      line('ctx', 'l5'),
      line('ctx', 'l6'),
    ]); // 中间无折叠段
    expect(rows[rows.length - 1]).toEqual({ type: 'fold', count: 3 });
  });

  it('全部为变化行时不折叠', () => {
    const lines = [line('add', 'a'), line('del', 'b')];
    expect(collapseContext(lines)).toEqual(lines);
  });

  it('相邻变化行（间隔 ≤ 2*ctx）之间不产生折叠段', () => {
    const lines = [
      line('ctx', 'c0'),
      line('add', 'a1'),
      line('ctx', 'c2'),
      line('del', 'd3'),
      line('ctx', 'c4'),
    ];
    const rows = collapseContext(lines);
    expect(rows.some((r) => r.type === 'fold')).toBe(false);
  });
});
