/**
 * 全局统一的指标名称：同一数值在侧栏、状态栏、用量统计和消息统计中使用同一个名字。
 */
export const TOKEN_LABELS = {
  total: '总 Token',
  input: '输入',
  output: '输出',
  last7: '近 7 天',
} as const;

/**
 * 全局统一的 Token 数字格式：所有组件共用一份实现和单位大小写。
 * - 负数或非有限值显示占位符，不伪造 0；
 * - 1M 以上保留一位小数，1K 以上使用大写 K。
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${+(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}
