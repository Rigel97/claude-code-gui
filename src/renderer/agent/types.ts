// 执行可视化数据模型：节点、边、事件、图的类型定义与有界预算。

export type NodeType = 'core' | 'agent' | 'tool' | 'file' | 'task' | 'error';

export type NodeStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'blocked'
  | 'retrying'
  | 'cancelled'
  | 'unknown';

export type DataSource = 'live' | 'demo' | 'history';

/** 执行图节点；id 在会话内稳定 */
export interface ExecutionNode {
  id: string;
  type: NodeType;
  label: string;
  subtitle?: string;
  parentId?: string;
  status: NodeStatus;
  /** 布局序号：仅首次创建时分配，状态更新不改变 */
  sequence: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  input?: unknown;
  output?: string;
  error?: string;
  filePath?: string;
  toolName?: string;
  /** 工具观测到的文件路径（不代表操作系统层面的确认） */
  relatedFiles: string[];
  /** 观测到该节点的最新事件时间，单调不减 */
  lastEventAt: number;
  metadata?: Record<string, unknown>;
}

export type EdgeKind = 'call' | 'delegation' | 'read' | 'write' | 'dependency' | 'retry';

export interface ExecutionEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  status: NodeStatus;
}

/** 指标仅取自 usage / result；无法确知的字段为 null（不由 usage 推算上下文占用） */
export interface ExecutionMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  model: string | null;
}

export type ExecutionEventKind =
  | 'session'
  | 'agent'
  | 'tool'
  | 'file'
  | 'task'
  | 'status'
  | 'error'
  | 'metrics';

/** 事件对图的结构化增量 */
export interface EventDelta {
  node?: Partial<ExecutionNode> & Pick<ExecutionNode, 'id'>;
  edge?: Pick<ExecutionEdge, 'source' | 'target' | 'kind'> & { id?: string };
  /**
   * 指标增量：显式 null 表示回退为未知（例如新一轮 run 开始），
   * undefined 表示不改动；负数或非有限数值整条忽略。
   */
  metrics?: Partial<Record<keyof ExecutionMetrics, number | string | null>>;
  graph?: Partial<Pick<ExecutionGraph, 'sessionId' | 'title' | 'projectPath' | 'endedAt' | 'status'>>;
}

export interface ExecutionEvent {
  id: string;
  conversationId: string;
  timestamp: number;
  source: DataSource;
  kind: ExecutionEventKind;
  label: string;
  nodeId?: string;
  status?: NodeStatus;
  sessionId?: string;
  delta?: EventDelta;
}

/** 事件裁剪基线：该时刻之前的事件已折叠进快照 */
export interface GraphBaseline {
  timestamp: number;
  /** 已裁剪的事件数（计入 droppedEvents） */
  prunedEvents: number;
}

/** 裁剪时刻的节点快照（回放只重放基线之后的真实事件） */
export interface BaselineNode {
  id: string;
  type: NodeType;
  label: string;
  subtitle?: string;
  parentId?: string;
  status: NodeStatus;
  sequence: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  input?: unknown;
  output?: string;
  error?: string;
  filePath?: string;
  toolName?: string;
  relatedFiles: string[];
  metadata?: Record<string, unknown>;
}

/**
 * 裁剪时刻的完整状态快照：由被裁剪事件按时间折叠得到，不从最终节点反推。
 * 回放以此为起点，保证过去不会出现未来的指标、输出或文件关系。
 */
export interface GraphBaselineSnapshot {
  nodes: Record<string, BaselineNode>;
  edges: Record<string, ExecutionEdge>;
  metrics: ExecutionMetrics;
  status: NodeStatus;
  startedAt: number | null;
  endedAt: number | null;
  title: string;
  sessionId: string | null;
  projectPath: string;
  /** 快照后的下一个可用节点序号 */
  nextSequence: number;
}

export interface GraphInternals {
  /** 已见事件 id（有界） */
  seenEventIds: string[];
  /** 下一个节点序号 */
  nextSequence: number;
  /** 事件裁剪基线 */
  baseline: GraphBaseline | null;
  /** 基线时刻的节点快照（无基线时为 null；完整快照见 baselineSnapshot） */
  baselineNodes: Record<string, BaselineNode> | null;
  /** 基线时刻的完整状态快照（含边、指标与会话级信息） */
  baselineSnapshot?: GraphBaselineSnapshot | null;
}

export interface ExecutionGraph {
  conversationId: string;
  source: DataSource;
  sessionId: string | null;
  title: string;
  projectPath: string;
  status: NodeStatus;
  startedAt: number | null;
  /** 仅表示执行终止时刻；回放当前时刻见 replayTime */
  endedAt: number | null;
  nodes: Record<string, ExecutionNode>;
  edges: Record<string, ExecutionEdge>;
  events: ExecutionEvent[];
  metrics: ExecutionMetrics;
  droppedEvents: number;
  droppedNodes: number;

  internal?: GraphInternals;
  /** replayGraph 的当前时刻（live 图为 undefined） */
  replayTime?: number;
  /** replayGraph 的可回放起点（存在事件裁剪时为基线时刻） */
  replayStart?: number | null;
}

export interface GraphStatistics {
  nodes: number;
  agents: number;
  tools: number;
  files: number;
  tasks: number;
  running: number;
  completed: number;
  errors: number;
}

export type AgentViewMode = 'live' | 'demo';

// ─── 有界预算 ─────────────────────────────────────────────

/** 节点上限，core 节点不占预算 */
export const MAX_GRAPH_NODES = 240;
/** 文件节点单独预算：不参与 240 节点裁剪，避免活跃文件被挤掉 */
export const MAX_FILE_NODES = 40;
/** 事件上限 */
export const MAX_GRAPH_EVENTS = 1200;
/** 节点文本保留上限 */
export const MAX_NODE_TEXT = 1200;
/** 工具参数序列化快照上限 */
export const MAX_TOOL_INPUT_TEXT = 900;
/** 事件 label 上限 */
export const MAX_EVENT_LABEL = 240;
/** adapter 索引 / 去重缓冲上限 */
export const MAX_ADAPTER_BUFFER = 2000;
/** store 中 live 图数量上限 */
export const MAX_LIVE_GRAPHS = 32;
