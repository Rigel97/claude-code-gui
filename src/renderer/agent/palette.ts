import type { ExecutionNode, NodeStatus, NodeType } from './types';

/** A single semantic palette shared by the scene, timeline and inspector. */
export const NODE_TYPES: Record<NodeType, { label: string; color: string; code: string }> = {
  core: { label: '主 Agent', color: '#79edff', code: 'CORE' },
  agent: { label: '子 Agent', color: '#b69aff', code: 'AGENT' },
  tool: { label: '工具', color: '#64d7ef', code: 'TOOL' },
  file: { label: '文件', color: '#93baff', code: 'FILE' },
  task: { label: '任务', color: '#c6a7ef', code: 'TASK' },
  error: { label: '异常', color: '#ff7184', code: 'ERROR' },
};

export const NODE_STATUSES: Record<NodeStatus, { label: string; color: string }> = {
  idle: { label: '就绪', color: '#8296ad' },
  pending: { label: '待执行', color: '#9aa7ba' },
  running: { label: '执行中', color: '#6ae8ff' },
  completed: { label: '已完成', color: '#7cd8c2' },
  error: { label: '执行失败', color: '#ff7184' },
  blocked: { label: '等待 / 阻塞', color: '#ffc582' },
  retrying: { label: '重试中', color: '#ec9bcf' },
  cancelled: { label: '已中断', color: '#b2a5a0' },
  unknown: { label: '状态未知', color: '#8e9aaf' },
};

export function isActive(status: NodeStatus): boolean {
  return status === 'running' || status === 'retrying';
}

export function nodeColor(node: Pick<ExecutionNode, 'type' | 'status'>): string {
  if (['error', 'blocked', 'retrying', 'cancelled'].includes(node.status)) return NODE_STATUSES[node.status].color;
  return NODE_TYPES[node.type].color;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function formatCount(value: number | null | undefined): string {
  return value == null ? '—' : new Intl.NumberFormat('en-US').format(value);
}
