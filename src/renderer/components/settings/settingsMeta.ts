import type { PermissionMode } from '../../types';

export type ViewId = 'model' | 'context' | 'permission' | 'appearance' | 'sessions' | 'runtime' | 'about';

export type EffortLevel = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Autocompact = '' | 'auto' | '100k' | '200k' | '400k' | '800k' | '1M';

export interface SettingsDraft {
  model: string;
  permissionMode: PermissionMode;
  showThinking: boolean;
  notifyOnComplete: boolean;
  particlesEnabled: boolean;
  maxSessions: number;
  effortLevel: EffortLevel;
  autocompact: Autocompact;
  maxBudget: string;
}

export const EFFORT_OPTIONS: { id: EffortLevel; label: string; desc: string }[] = [
  { id: '', label: '默认', desc: '由 CLI 自动决定' },
  { id: 'low', label: '低', desc: '快速响应，最省 token' },
  { id: 'medium', label: '中', desc: '速度与深度均衡' },
  { id: 'high', label: '高', desc: '更多思考，适合复杂任务' },
  { id: 'xhigh', label: '超高', desc: '深度推理，更慢更贵' },
  { id: 'max', label: '最大', desc: '最强思考预算' },
];

export const AUTOCOMPACT_OPTIONS: { id: Autocompact; label: string; desc: string }[] = [
  { id: '', label: '默认', desc: '由 CLI 自动管理' },
  { id: 'auto', label: 'Auto', desc: '自动选择压缩时机' },
  { id: '100k', label: '100k', desc: '更早压缩，最省 token' },
  { id: '200k', label: '200k', desc: '较早压缩' },
  { id: '400k', label: '400k', desc: '中等，需要更大窗口' },
  { id: '800k', label: '800k', desc: '尽量保留历史' },
  { id: '1M', label: '1M', desc: '仅在 1M 窗口模型上有效' },
];

export const PERMISSION_MODES: { id: PermissionMode; label: string; desc: string; danger?: boolean }[] = [
  { id: 'default', label: '逐次审批', desc: '执行命令、修改文件前逐次询问你，最安全。' },
  { id: 'acceptEdits', label: '仅自动接受文件编辑', desc: '文件编辑自动放行，命令执行等仍按规则审批。' },
  { id: 'plan', label: '只读规划', desc: '只做只读分析和规划，不执行任何修改。' },
  { id: 'auto', label: '自动审批（依赖 CLI 可用）', desc: '由 CLI 自动判断是否放行；依赖 CLI 支持。' },
  { id: 'dontAsk', label: '仅规则、不弹问', desc: '只执行已有允许规则，未获允许的操作直接拒绝。' },
  { id: 'bypassPermissions', label: '全部放行（危险）', desc: '跳过权限检查，模型可以执行任意命令。', danger: true },
];

export const SESSION_LIMIT_OPTIONS = [20, 50, 100, 200];

export interface SettingsIndexEntry {
  view: ViewId;
  id: string;
  label: string;
  keywords: string[];
}

/** 设置搜索索引：中文名、说明关键词和 CLI 参数都可用于搜索。 */
export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  { view: 'model', id: 'model', label: '模型', keywords: ['model', '模型', 'glm', 'sonnet', 'opus'] },
  { view: 'model', id: 'effort', label: '思考深度', keywords: ['effort', '思考', '推理', '深度', 'max'] },
  { view: 'context', id: 'autocompact', label: '自动压缩阈值', keywords: ['autocompact', '压缩', '上下文', 'context', '1m'] },
  { view: 'context', id: 'budget', label: '单次连接花费上限', keywords: ['budget', '花费', '费用', '美元', 'usd'] },
  { view: 'permission', id: 'permission', label: '工具执行权限', keywords: ['permission', '权限', '审批', 'approval', 'bypass'] },
  { view: 'appearance', id: 'thinking', label: '显示思考过程', keywords: ['thinking', '思考', '显示'] },
  { view: 'appearance', id: 'notify', label: '任务完成通知', keywords: ['notify', '通知', '提醒'] },
  { view: 'appearance', id: 'video', label: '动态视频背景', keywords: ['video', '视频', '背景', 'bgmedia'] },
  { view: 'sessions', id: 'limit', label: '保留会话数量', keywords: ['session', '会话', '历史', '数量'] },
  { view: 'sessions', id: 'clear', label: '清空历史会话', keywords: ['clear', '清空', '删除', '历史'] },
  { view: 'runtime', id: 'cli', label: 'CLI 可执行文件', keywords: ['cli', '路径', 'executable', '运行时'] },
  { view: 'runtime', id: 'env', label: '环境变量', keywords: ['env', '环境变量', '密钥', 'api', 'proxy'] },
  { view: 'runtime', id: 'diagnostics', label: '运行时诊断', keywords: ['diagnostics', '诊断', '版本', '端点'] },
  { view: 'runtime', id: 'native', label: '原生功能管理', keywords: ['native', '终端', 'mcp', 'plugin', 'doctor'] },
  { view: 'about', id: 'about', label: '版本与数据位置', keywords: ['about', '版本', '数据', '路径'] },
];

export const VIEW_LABELS: Record<ViewId, string> = {
  model: '模型与推理',
  context: '上下文与成本',
  permission: '权限与安全',
  appearance: '外观与通知',
  sessions: '会话与数据',
  runtime: '运行环境',
  about: '关于',
};

export function parseBudget(raw: string): number {
  const value = parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

export { formatTokens } from '../../utils/format';

export function formatWindow(value: number | null | undefined): string {
  if (!Number.isFinite(value ?? NaN) || !value) return '未知';
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
