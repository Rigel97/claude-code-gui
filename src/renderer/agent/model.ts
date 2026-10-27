// 执行图 reducer：事件合入、有界裁剪、时间回放。
// 不可变更新；事件按 id 去重；节点终止状态不被旧事件回退。

import type {
  BaselineNode,
  DataSource,
  EdgeKind,
  ExecutionEdge,
  ExecutionEvent,
  ExecutionEventKind,
  ExecutionGraph,
  ExecutionNode,
  ExecutionMetrics,
  GraphBaseline,
  GraphBaselineSnapshot,
  GraphInternals,
  GraphStatistics,
  NodeStatus,
  NodeType,
} from './types';
import { MAX_FILE_NODES, MAX_GRAPH_EVENTS, MAX_GRAPH_NODES, MAX_NODE_TEXT } from './types';

const ROOT_PREFIX = 'core:';

/** 会话根节点 id */
export function getRootId(conversationId: string): string {
  return `${ROOT_PREFIX}${conversationId}`;
}

/** 文件节点 id 只取决于路径：同一文件多次操作复用同一节点 */
export function getFileId(filePath: string): string {
  return `file:${filePath}`;
}

const TERMINAL: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['completed', 'error', 'blocked', 'cancelled']);
const GRAPH_TERMINAL: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['completed', 'error', 'cancelled']);
const ACTIVE: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['running', 'retrying']);

const NODE_TYPES: ReadonlySet<string> = new Set<NodeType>(['core', 'agent', 'tool', 'file', 'task', 'error']);
const NODE_STATUSES: ReadonlySet<string> = new Set<NodeStatus>([
  'idle',
  'pending',
  'running',
  'completed',
  'error',
  'blocked',
  'retrying',
  'cancelled',
  'unknown',
]);
const EDGE_KINDS: ReadonlySet<string> = new Set<EdgeKind>(['call', 'delegation', 'read', 'write', 'dependency', 'retry']);
const EVENT_KINDS: ReadonlySet<string> = new Set<ExecutionEventKind>([
  'session',
  'agent',
  'tool',
  'file',
  'task',
  'status',
  'error',
  'metrics',
]);

/** 会写文件的工具（观测到 file_path 时派生 write 边） */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** 会读文件的工具（观测到 file_path 时派生 read 边） */
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

export function emptyMetrics(): ExecutionMetrics {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheTokens: null,
    costUsd: null,
    durationMs: null,
    turns: null,
    model: null,
  };
}

// ─── 工具函数 ───────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function clip(s: string, max = MAX_NODE_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? clip(v) : undefined;
}

function asStatus(v: unknown, fallback: NodeStatus): NodeStatus {
  return typeof v === 'string' && NODE_STATUSES.has(v) ? (v as NodeStatus) : fallback;
}

function asKind(v: unknown): EdgeKind {
  return typeof v === 'string' && EDGE_KINDS.has(v) ? (v as EdgeKind) : 'dependency';
}

export function edgeKey(source: string, target: string, kind: EdgeKind): string {
  return `e:${source}->${target}:${kind}`;
}

function uniqueStrings(list: unknown[]): string[] {
  const out: string[] = [];
  for (const v of list) if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
  return out;
}

function kindFromEvent(kind: ExecutionEventKind, type: unknown): NodeType {
  if (typeof type === 'string' && NODE_TYPES.has(type) && type !== 'core') return type as NodeType;
  switch (kind) {
    case 'agent':
      return 'agent';
    case 'file':
      return 'file';
    case 'task':
      return 'task';
    case 'error':
      return 'error';
    case 'session':
      return 'core';
    default:
      return 'tool';
  }
}

function emptyInternals(): GraphInternals {
  return { seenEventIds: [], nextSequence: 1, baseline: null, baselineNodes: null, baselineSnapshot: null };
}

// ─── 创建 / 统计 ────────────────────────────────────────────

export function createGraph(
  conversationId: string,
  source: DataSource,
  title = '新会话',
  projectPath = ''
): ExecutionGraph {
  const rootId = getRootId(conversationId);
  const root: ExecutionNode = {
    id: rootId,
    type: 'core',
    label: title,
    subtitle: source === 'demo' ? 'demo' : source === 'history' ? 'history' : 'live',
    status: 'unknown',
    sequence: 0,
    relatedFiles: [],
    lastEventAt: 0,
  };
  return {
    conversationId,
    source,
    sessionId: null,
    title,
    projectPath,
    status: 'unknown',
    startedAt: null,
    endedAt: null,
    nodes: { [rootId]: root },
    edges: {},
    events: [],
    metrics: emptyMetrics(),
    droppedEvents: 0,
    droppedNodes: 0,
    internal: emptyInternals(),
  };
}

export function getStatistics(graph: ExecutionGraph): GraphStatistics {
  const stats: GraphStatistics = {
    nodes: 0,
    agents: 0,
    tools: 0,
    files: 0,
    tasks: 0,
    running: 0,
    completed: 0,
    errors: 0,
  };
  for (const node of Object.values(graph.nodes || {})) {
    stats.nodes++;
    if (node.type === 'agent') stats.agents++;
    else if (node.type === 'tool') stats.tools++;
    else if (node.type === 'file') stats.files++;
    else if (node.type === 'task') stats.tasks++;
    if (ACTIVE.has(node.status)) stats.running++;
    else if (node.status === 'completed') stats.completed++;
    if (node.status === 'error' || node.status === 'blocked') stats.errors++;
  }
  return stats;
}

// ─── 节点合并 ───────────────────────────────────────────────

function mergeNode(existing: ExecutionNode, patch: Record<string, unknown>, timestamp: number): ExecutionNode {
  const lastEventAt = Math.max(existing.lastEventAt, timestamp, num(patch.lastEventAt) ?? 0);

  let status = existing.status;
  let reopened = false;
  let endedAt = num(patch.endedAt) ?? existing.endedAt;
  if (patch.status !== undefined) {
    const wanted = asStatus(patch.status, existing.status);
    if (existing.type === 'file' && ACTIVE.has(wanted) && TERMINAL.has(existing.status) && existing.endedAt !== undefined) {
      // 文件被后续工具重新操作：completed/error → running，重新计时并清除旧结束信息
      status = wanted;
      reopened = true;
      endedAt = num(patch.endedAt);
    } else if (TERMINAL.has(existing.status) && existing.endedAt !== undefined) {
      // 已终止：只接受由终止事件给出的修正，不回退到进行中（旧 start 不覆盖 error）
      if (TERMINAL.has(wanted) && wanted !== existing.status && endedAt !== undefined) status = wanted;
    } else {
      status = wanted;
    }
  }

  // 占位节点（结果先到）允许被真实名称一次性补齐
  const placeholder = existing.metadata?.placeholder === true || !existing.toolName || existing.toolName === 'Tool';
  const label =
    typeof patch.label === 'string' && patch.label && (placeholder || !existing.label)
      ? clip(patch.label, 120)
      : existing.label;

  const start = reopened
    ? num(patch.startedAt) ?? timestamp
    : existing.startedAt ?? num(patch.startedAt) ?? (status !== 'pending' && status !== 'unknown' ? timestamp : undefined);
  const durationMs = reopened
    ? num(patch.durationMs)
    : num(patch.durationMs) ?? (endedAt !== undefined && start !== undefined ? Math.max(0, endedAt - start) : existing.durationMs);
  const relatedFiles = Array.isArray(patch.relatedFiles)
    ? uniqueStrings([...existing.relatedFiles, ...patch.relatedFiles])
    : existing.relatedFiles;
  const metadata =
    isObj(patch.metadata) && Object.keys(patch.metadata).length
      ? { ...(existing.metadata ?? {}), ...patch.metadata }
      : existing.metadata;

  const out: ExecutionNode = {
    id: existing.id,
    type: existing.type,
    label,
    status,
    sequence: existing.sequence,
    relatedFiles,
    lastEventAt,
  };
  const subtitle = typeof patch.subtitle === 'string' ? patch.subtitle : existing.subtitle;
  if (subtitle !== undefined) out.subtitle = subtitle;
  const parentId = existing.parentId ?? (typeof patch.parentId === 'string' ? patch.parentId : undefined);
  if (parentId !== undefined) out.parentId = parentId;
  if (start !== undefined) out.startedAt = start;
  if (endedAt !== undefined) out.endedAt = endedAt;
  if (durationMs !== undefined) out.durationMs = durationMs;
  if (patch.input !== undefined) out.input = patch.input;
  else if (existing.input !== undefined) out.input = existing.input;
  if (patch.output !== undefined) out.output = str(patch.output);
  else if (existing.output !== undefined) out.output = existing.output;
  if (patch.error !== undefined) out.error = str(patch.error);
  else if (existing.error !== undefined) out.error = existing.error;
  const filePath = typeof patch.filePath === 'string' ? patch.filePath : existing.filePath;
  if (filePath !== undefined) out.filePath = filePath;
  const toolName = typeof patch.toolName === 'string' ? patch.toolName : existing.toolName;
  if (toolName !== undefined) out.toolName = toolName;
  if (metadata && Object.keys(metadata).length) out.metadata = metadata;
  return out;
}

function createNode(
  patch: Record<string, unknown> & { id: string },
  kind: ExecutionEventKind,
  timestamp: number,
  sequence: number
): ExecutionNode {
  const status = asStatus(patch.status, kind === 'session' ? 'unknown' : 'pending');
  const startedAt = num(patch.startedAt) ?? (status !== 'pending' && status !== 'unknown' ? timestamp : undefined);
  const endedAt = num(patch.endedAt);
  const node: ExecutionNode = {
    id: patch.id,
    type: kindFromEvent(kind, patch.type),
    label: (typeof patch.label === 'string' && patch.label ? patch.label : patch.id).slice(0, 120),
    status,
    sequence,
    relatedFiles: Array.isArray(patch.relatedFiles) ? uniqueStrings(patch.relatedFiles) : [],
    lastEventAt: timestamp,
  };
  if (typeof patch.subtitle === 'string') node.subtitle = patch.subtitle;
  if (typeof patch.parentId === 'string') node.parentId = patch.parentId;
  if (startedAt !== undefined) node.startedAt = startedAt;
  if (endedAt !== undefined) node.endedAt = endedAt;
  const duration = num(patch.durationMs) ?? (startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined);
  if (duration !== undefined) node.durationMs = duration;
  if (patch.input !== undefined) node.input = patch.input;
  const output = str(patch.output);
  if (output !== undefined) node.output = output;
  const error = str(patch.error);
  if (error !== undefined) node.error = error;
  if (typeof patch.filePath === 'string') node.filePath = patch.filePath;
  if (typeof patch.toolName === 'string') node.toolName = patch.toolName;
  if (isObj(patch.metadata) && Object.keys(patch.metadata).length) node.metadata = { ...patch.metadata };
  return node;
}

function mergeMetrics(base: ExecutionMetrics, patch: Record<string, unknown>): ExecutionMetrics {
  const take = (k: 'inputTokens' | 'outputTokens' | 'cacheTokens' | 'costUsd' | 'durationMs' | 'turns'): number | null => {
    if (!(k in patch)) return base[k];
    const v = patch[k];
    if (v === null) return null; // 显式 null：回退为未知（新一轮 run）
    const n = num(v);
    if (n === undefined || n < 0) return base[k]; // 非法值（负数 / 非有限）忽略，不覆盖旧值
    return n;
  };
  return {
    inputTokens: take('inputTokens'),
    outputTokens: take('outputTokens'),
    cacheTokens: take('cacheTokens'),
    costUsd: take('costUsd'),
    durationMs: take('durationMs'),
    turns: take('turns'),
    model: typeof patch.model === 'string' && patch.model ? patch.model : base.model,
  };
}

/**
 * 是否显式开启执行：带节点结构的事件，或携带执行状态的图级事件。
 * 纯观测（无状态的 status）不开启时间线，避免给空图伪造 startedAt。
 */
function beginsTimeline(kind: ExecutionEventKind, eventStatus: NodeStatus | undefined, hasNode: boolean): boolean {
  if (hasNode) return true;
  if (kind === 'session' || kind === 'agent' || kind === 'tool' || kind === 'task' || kind === 'file') return true;
  return eventStatus !== undefined && eventStatus !== 'pending' && eventStatus !== 'unknown' && eventStatus !== 'idle';
}

// ─── 文件节点派生 ───────────────────────────────────────────

/**
 * Read/Edit/Write 等工具观测到 file_path 时，派生文件节点与 read/write 边：
 * 文件节点代表「该工具操作过这个文件」，状态跟随工具结果，不代表操作系统确认。
 */
function deriveFileNodes(
  tool: ExecutionNode,
  nodes: Record<string, ExecutionNode>,
  edges: Record<string, ExecutionEdge>,
  sequenceCursor: { next: number },
  timestamp: number
): { nodes: Record<string, ExecutionNode>; edges: Record<string, ExecutionEdge>; changed: boolean } {
  const toolName = tool.toolName;
  const filePath = tool.filePath ?? tool.relatedFiles[0];
  if (!toolName || !filePath) return { nodes, edges, changed: false };
  const kind: EdgeKind | null = WRITE_TOOLS.has(toolName) ? 'write' : READ_TOOLS.has(toolName) ? 'read' : null;
  if (!kind) return { nodes, edges, changed: false };

  const fileId = getFileId(filePath);
  const fileStatus: NodeStatus = tool.status === 'error' ? 'error' : tool.status === 'completed' ? 'completed' : 'running';
  const existingFile = nodes[fileId];
  let fileNode: ExecutionNode;
  if (existingFile) {
    // 同一文件被后续工具重新操作：completed/error → running，保留同一节点与序号，
    // 清除上一轮的结束时间并重新计时，同时记录 operation 变化
    const reopened = fileStatus === 'running' && existingFile.endedAt !== undefined;
    fileNode = {
      ...existingFile,
      status: fileStatus,
      lastEventAt: Math.max(existingFile.lastEventAt, timestamp),
      metadata: {
        ...(existingFile.metadata ?? {}),
        lastToolId: tool.id,
        operations: uniqueStrings([...(Array.isArray(existingFile.metadata?.operations) ? (existingFile.metadata!.operations as unknown[]) : []), toolName]),
      },
    };
    if (fileStatus === 'running') {
      fileNode.startedAt = reopened ? tool.startedAt ?? timestamp : existingFile.startedAt ?? timestamp;
      if (reopened) {
        delete fileNode.endedAt;
        delete fileNode.durationMs;
      }
    } else {
      fileNode.endedAt = existingFile.endedAt ?? tool.endedAt ?? timestamp;
    }
  } else {
    fileNode = {
      id: fileId,
      type: 'file',
      label: filePath.split('/').pop() || filePath,
      subtitle: filePath,
      parentId: tool.id,
      status: fileStatus,
      sequence: sequenceCursor.next++,
      startedAt: tool.startedAt ?? timestamp,
      ...(fileStatus === 'running' ? {} : { endedAt: tool.endedAt ?? timestamp }),
      filePath,
      relatedFiles: [filePath],
      lastEventAt: timestamp,
      metadata: { observedBy: tool.id, lastToolId: tool.id, operations: [toolName] },
    };
  }

  let nextNodes = nodes;
  let nextEdges = edges;
  let changed = false;
  if (fileNode !== existingFile) {
    nextNodes = { ...nodes, [fileId]: fileNode };
    changed = true;
  }
  const id = edgeKey(tool.id, fileId, kind);
  if (!edges[id]) {
    nextEdges = { ...edges, [id]: { id, source: tool.id, target: fileId, kind, status: fileNode.status } };
    changed = true;
  } else if (edges[id].status !== fileNode.status) {
    nextEdges = { ...edges, [id]: { ...edges[id], status: fileNode.status } };
    changed = true;
  }
  return { nodes: nextNodes, edges: nextEdges, changed };
}

// ─── 有界裁剪 ───────────────────────────────────────────────

const DROP_ORDER: NodeStatus[] = ['completed', 'cancelled', 'blocked', 'error', 'idle', 'unknown', 'pending', 'retrying', 'running'];

function trimNodes(
  nodes: Record<string, ExecutionNode>,
  dropped: number
): { nodes: Record<string, ExecutionNode>; dropped: number } {
  const all = Object.values(nodes);
  const nonCore = all.filter((n) => n.type !== 'core');
  const files = nonCore.filter((n) => n.type === 'file');
  const others = nonCore.filter((n) => n.type !== 'file');
  if (others.length <= MAX_GRAPH_NODES && files.length <= MAX_FILE_NODES) return { nodes, dropped };

  const dropSet = new Set<string>();
  // 非文件节点：240 上限，优先丢已完成
  if (others.length > MAX_GRAPH_NODES) {
    const ordered = [...others].sort((a, b) => {
      const rank = DROP_ORDER.indexOf(a.status) - DROP_ORDER.indexOf(b.status);
      if (rank !== 0) return rank;
      if (a.lastEventAt !== b.lastEventAt) return a.lastEventAt - b.lastEventAt;
      return a.sequence - b.sequence;
    });
    const preferred = ordered.filter((n) => !ACTIVE.has(n.status) && !n.metadata?.selected);
    const fallback = ordered.filter((n) => !preferred.includes(n));
    let droppedOthers = 0;
    for (const n of [...preferred, ...fallback]) {
      if (droppedOthers >= others.length - MAX_GRAPH_NODES) break;
      dropSet.add(n.id);
      droppedOthers++;
    }
  }
  // 文件节点：独立预算，只丢最久未活跃的
  if (files.length > MAX_FILE_NODES) {
    const orderedFiles = [...files].sort((a, b) => a.lastEventAt - b.lastEventAt || a.sequence - b.sequence);
    let droppedFiles = 0;
    for (const n of orderedFiles) {
      if (droppedFiles >= files.length - MAX_FILE_NODES) break;
      dropSet.add(n.id);
      droppedFiles++;
    }
  }
  if (!dropSet.size) return { nodes, dropped };
  const next: Record<string, ExecutionNode> = {};
  for (const n of all) if (!dropSet.has(n.id)) next[n.id] = n;
  return { nodes: next, dropped: dropped + dropSet.size };
}

/** 节点快照：纯拷贝，状态真实来自事件折叠，不做未来信息推断 */
function snapshotNode(node: ExecutionNode): BaselineNode {
  const snap: BaselineNode = {
    id: node.id,
    type: node.type,
    label: node.label,
    status: node.status,
    sequence: node.sequence,
    relatedFiles: [...node.relatedFiles],
  };
  if (node.subtitle !== undefined) snap.subtitle = node.subtitle;
  if (node.parentId !== undefined) snap.parentId = node.parentId;
  if (node.startedAt !== undefined) snap.startedAt = node.startedAt;
  if (node.endedAt !== undefined) snap.endedAt = node.endedAt;
  if (node.durationMs !== undefined) snap.durationMs = node.durationMs;
  if (node.input !== undefined) snap.input = node.input;
  if (node.output !== undefined) snap.output = node.output;
  if (node.error !== undefined) snap.error = node.error;
  if (node.filePath !== undefined) snap.filePath = node.filePath;
  if (node.toolName !== undefined) snap.toolName = node.toolName;
  const restMeta = { ...(node.metadata ?? {}) };
  delete restMeta.placeholder;
  if (Object.keys(restMeta).length) snap.metadata = restMeta;
  return snap;
}

// ─── 事件应用 ───────────────────────────────────────────────

/**
 * 事件合入核心：只做节点 / 边 / 指标 / 状态合并与有界裁剪，
 * 不做事件裁剪与基线折叠（供 live 合入与基线折叠共用，避免递归裁剪）。
 */
function applyEventCore(graph: ExecutionGraph, event: ExecutionEvent): ExecutionGraph {
  if (!graph || !event || !isObj(event)) return graph;
  if (typeof event.conversationId !== 'string' || event.conversationId !== graph.conversationId) return graph;
  if (typeof event.id !== 'string' || !event.id) return graph;

  const internal = graph.internal ?? emptyInternals();
  if (internal.seenEventIds.includes(event.id)) return graph;
  if ((event.source === 'live' && graph.source === 'demo') || (event.source === 'demo' && graph.source === 'live')) return graph;

  const timestamp = num(event.timestamp) ?? graph.endedAt ?? graph.startedAt ?? 0;
  const kind: ExecutionEventKind =
    typeof event.kind === 'string' && EVENT_KINDS.has(event.kind) ? (event.kind as ExecutionEventKind) : 'status';
  const delta = isObj(event.delta) ? event.delta : undefined;

  let nodes = graph.nodes;
  let edges = graph.edges;
  let droppedNodes = graph.droppedNodes;
  const seqCursor = { next: internal.nextSequence };

  const nodePatch = delta && isObj(delta.node) ? delta.node : undefined;
  let touchedNode: ExecutionNode | undefined;
  if (nodePatch && typeof nodePatch.id === 'string' && nodePatch.id) {
    const existing = nodes[nodePatch.id];
    if (existing) {
      touchedNode = mergeNode(existing, nodePatch, timestamp);
    } else {
      const explicitSeq = num(nodePatch.sequence);
      const sequence = explicitSeq ?? seqCursor.next;
      seqCursor.next = Math.max(seqCursor.next, sequence + 1);
      touchedNode = createNode({ ...nodePatch, id: nodePatch.id }, kind, timestamp, sequence);
    }
    nodes = { ...nodes, [touchedNode.id]: touchedNode };
  }

  // 工具 → 文件：派生文件节点与 read/write 边
  if (touchedNode && touchedNode.type !== 'file' && touchedNode.type !== 'core') {
    const derived = deriveFileNodes(touchedNode, nodes, edges, seqCursor, timestamp);
    if (derived.changed) {
      nodes = derived.nodes;
      edges = derived.edges;
    }
  }

  // 显式边（两端必须存在，且不能自环）
  if (delta && isObj(delta.edge)) {
    const e = delta.edge;
    if (
      typeof e.source === 'string' &&
      typeof e.target === 'string' &&
      e.source !== e.target &&
      nodes[e.source] &&
      nodes[e.target]
    ) {
      const edgeKind = asKind(e.kind);
      const id = typeof e.id === 'string' && e.id ? e.id : edgeKey(e.source, e.target, edgeKind);
      if (!edges[id]) {
        edges = { ...edges, [id]: { id, source: e.source, target: e.target, kind: edgeKind, status: nodes[e.target].status } };
      }
    }
  }

  // 图级字段
  let sessionId = graph.sessionId;
  let title = graph.title;
  let projectPath = graph.projectPath;
  let endedAt = graph.endedAt;
  let status = graph.status;
  const graphPatch = delta && isObj(delta.graph) ? delta.graph : undefined;
  if (graphPatch) {
    if (typeof graphPatch.sessionId === 'string' && graphPatch.sessionId) sessionId = graphPatch.sessionId;
    if (typeof graphPatch.title === 'string' && graphPatch.title) title = graphPatch.title;
    if (typeof graphPatch.projectPath === 'string' && graphPatch.projectPath) projectPath = graphPatch.projectPath;
    const patchedEnd = num(graphPatch.endedAt);
    if (patchedEnd !== undefined) endedAt = patchedEnd;
    if (graphPatch.status !== undefined) {
      const nextStatus = asStatus(graphPatch.status, status);
      // 新一轮 starting 已在 store 中另建图；旧运行的迟到事件不得让终态回退。
      if (!(GRAPH_TERMINAL.has(status) && nextStatus === 'running')) status = nextStatus;
    }
  }
  if (typeof event.sessionId === 'string' && event.sessionId) sessionId = event.sessionId;

  const eventStatus = event.status !== undefined ? asStatus(event.status, status) : undefined;
  if (kind === 'error' && (eventStatus === undefined || eventStatus === 'error')) status = 'error';
  if (kind === 'status' && eventStatus && !(GRAPH_TERMINAL.has(status) && eventStatus === 'running')) status = eventStatus;
  if (status === 'completed' || status === 'cancelled' || status === 'error') endedAt = endedAt ?? timestamp;
  if (kind === 'session' && status !== 'completed' && status !== 'error' && status !== 'cancelled') status = 'running';

  let metrics = graph.metrics;
  if (delta && isObj(delta.metrics)) metrics = mergeMetrics(metrics, delta.metrics);

  const beginStarted = graph.startedAt !== null;
  const begins = beginsTimeline(kind, eventStatus, Boolean(nodePatch && typeof nodePatch.id === 'string'));
  const startedAt = graph.startedAt ?? (!beginStarted && begins ? timestamp : null);
  if (graph.status === 'unknown' && !beginStarted && !begins) status = 'unknown';

  // 根节点跟随图状态
  const rootId = getRootId(graph.conversationId);
  const root = nodes[rootId];
  if (root) {
    const rootStatus: NodeStatus =
      status === 'completed' || status === 'error' || status === 'cancelled' || status === 'blocked'
        ? status
        : status === 'unknown'
          ? 'unknown'
          : status === 'idle'
            ? 'idle'
            : 'running';
    const nextRoot: ExecutionNode = { ...root, id: rootId, type: 'core', sequence: 0, label: title, status: rootStatus, lastEventAt: Math.max(root.lastEventAt, timestamp) };
    if (root.startedAt !== undefined || rootStatus === 'running') nextRoot.startedAt = root.startedAt ?? timestamp;
    if (rootStatus !== 'running' && rootStatus !== 'unknown' && endedAt !== null) nextRoot.endedAt = endedAt;
    if (nextRoot.status !== root.status || nextRoot.lastEventAt !== root.lastEventAt || nextRoot.label !== root.label || nextRoot.endedAt !== root.endedAt) {
      nodes = { ...nodes, [rootId]: nextRoot };
    }
  }

  // 边状态跟随目标节点（状态未变时不产生新边对象）
  {
    let changed = false;
    const nextEdges: Record<string, ExecutionEdge> = { ...edges };
    for (const [id, edge] of Object.entries(edges)) {
      const target = nodes[edge.target];
      if (target && target.status !== edge.status) {
        nextEdges[id] = { ...edge, status: target.status };
        changed = true;
      }
    }
    if (changed) edges = nextEdges;
  }

  // 节点有界；同时清理悬空边
  const trimmed = trimNodes(nodes, droppedNodes);
  nodes = trimmed.nodes;
  if (nodes !== graph.nodes) {
    let removed = false;
    let cleaned = edges;
    for (const [id, edge] of Object.entries(edges)) {
      if (!nodes[edge.source] || !nodes[edge.target]) {
        if (!removed) {
          cleaned = { ...edges };
          removed = true;
        }
        delete cleaned[id];
      }
    }
    edges = cleaned;
  }

  // 事件按 id 去重后追加；裁剪与基线折叠由外层 applyEvent 负责
  const stamped: ExecutionEvent = {
    ...event,
    timestamp,
    source: event.source === 'demo' ? 'demo' : event.source === 'history' ? 'history' : 'live',
    kind,
    label: typeof event.label === 'string' ? event.label.slice(0, 240) : '',
    ...(eventStatus !== undefined ? { status: eventStatus } : {}),
    ...(sessionId ? { sessionId } : {}),
  };

  const seenLimit = MAX_GRAPH_EVENTS * 4;
  const seen = [...internal.seenEventIds, event.id];

  return {
    conversationId: graph.conversationId,
    source: graph.source,
    sessionId,
    title,
    projectPath,
    status,
    startedAt: startedAt || null,
    endedAt,
    nodes,
    edges,
    events: [...graph.events, stamped],
    metrics,
    droppedEvents: graph.droppedEvents,
    droppedNodes: trimmed.dropped,
    internal: {
      seenEventIds: seen.length > seenLimit ? seen.slice(-seenLimit / 2) : seen,
      nextSequence: seqCursor.next,
      baseline: internal.baseline,
      baselineNodes: internal.baselineNodes,
      baselineSnapshot: internal.baselineSnapshot,
    },
  };
}

/**
 * 将单个事件合入图。不属于本会话、重复或畸形的事件返回原图。
 * live 与 demo 来源互斥；history 图可继续接收 live 事件（同一会话的实时推进）。
 * 事件超限时折叠增量基线快照：由被裁剪事件按时间折叠得到，不从最终节点反推。
 */
export function applyEvent(graph: ExecutionGraph, event: ExecutionEvent): ExecutionGraph {
  const next = applyEventCore(graph, event);
  if (next === graph) return graph;
  const internal = next.internal ?? emptyInternals();
  if (next.events.length <= MAX_GRAPH_EVENTS) return next;

  const pruned = next.events.length - MAX_GRAPH_EVENTS;
  const removed = next.events.slice(0, pruned);
  const events = next.events.slice(pruned);
  const cutAt = events[0]?.timestamp ?? num(event.timestamp) ?? 0;
  const snapshot = foldBaseline(internal.baselineSnapshot ?? null, graph.conversationId, graph.source, removed);
  const baseline: GraphBaseline = {
    timestamp: Math.max(internal.baseline?.timestamp ?? cutAt, cutAt),
    prunedEvents: (internal.baseline?.prunedEvents ?? 0) + pruned,
  };
  return {
    ...next,
    events,
    droppedEvents: next.droppedEvents + pruned,
    internal: { ...internal, baseline, baselineNodes: snapshot.nodes, baselineSnapshot: snapshot },
  };
}

/** 基线快照 → 可继续折叠的图（事件与去重为空，节点序号从快照续接） */
function snapshotToGraph(snap: GraphBaselineSnapshot, conversationId: string, source: DataSource): ExecutionGraph {
  const rootId = getRootId(conversationId);
  const nodes: Record<string, ExecutionNode> = {};
  for (const n of Object.values(snap.nodes)) nodes[n.id] = baselineToNode(n);
  if (!nodes[rootId]) {
    nodes[rootId] = {
      id: rootId,
      type: 'core',
      label: snap.title,
      status: snap.status,
      sequence: 0,
      relatedFiles: [],
      lastEventAt: snap.startedAt ?? 0,
    };
  }
  return {
    conversationId,
    source,
    sessionId: snap.sessionId,
    title: snap.title,
    projectPath: snap.projectPath,
    status: snap.status,
    startedAt: snap.startedAt,
    endedAt: snap.endedAt,
    nodes,
    edges: { ...snap.edges },
    events: [],
    metrics: { ...snap.metrics },
    droppedEvents: 0,
    droppedNodes: 0,
    internal: { seenEventIds: [], nextSequence: snap.nextSequence, baseline: null, baselineNodes: null, baselineSnapshot: null },
  };
}

/** 折叠被裁剪事件：从上一基线快照继续按时间推进，得到新裁剪时刻的完整状态 */
function foldBaseline(
  prev: GraphBaselineSnapshot | null,
  conversationId: string,
  source: DataSource,
  removed: readonly ExecutionEvent[]
): GraphBaselineSnapshot {
  let acc = prev ? snapshotToGraph(prev, conversationId, source) : createGraph(conversationId, source);
  const ordered = [...removed].sort((a, b) => (num(a.timestamp) ?? 0) - (num(b.timestamp) ?? 0));
  for (const ev of ordered) acc = applyEventCore(acc, ev);
  return {
    nodes: Object.fromEntries(Object.values(acc.nodes).map((n) => [n.id, snapshotNode(n)])),
    edges: { ...acc.edges },
    metrics: { ...acc.metrics },
    status: acc.status,
    startedAt: acc.startedAt,
    endedAt: acc.endedAt,
    title: acc.title,
    sessionId: acc.sessionId,
    projectPath: acc.projectPath,
    nextSequence: acc.internal?.nextSequence ?? 1,
  };
}

export function applyEvents(graph: ExecutionGraph, events: readonly ExecutionEvent[]): ExecutionGraph {
  let acc = graph;
  for (const ev of events) acc = applyEvent(acc, ev);
  return acc;
}

// ─── 回放 ───────────────────────────────────────────────────

/** 按时间稳定排序（同时间戳保持插入顺序） */
function chronological(events: readonly ExecutionEvent[]): ExecutionEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const ta = num(a.event.timestamp) ?? 0;
      const tb = num(b.event.timestamp) ?? 0;
      return ta === tb ? a.index - b.index : ta - tb;
    })
    .map((x) => x.event);
}

function baselineToNode(snap: BaselineNode): ExecutionNode {
  const node: ExecutionNode = {
    id: snap.id,
    type: snap.type,
    label: snap.label,
    status: snap.status,
    sequence: snap.sequence,
    relatedFiles: [...snap.relatedFiles],
    lastEventAt: snap.startedAt ?? 0,
  };
  if (snap.subtitle !== undefined) node.subtitle = snap.subtitle;
  if (snap.parentId !== undefined) node.parentId = snap.parentId;
  if (snap.startedAt !== undefined) node.startedAt = snap.startedAt;
  if (snap.endedAt !== undefined) node.endedAt = snap.endedAt;
  if (snap.durationMs !== undefined) node.durationMs = snap.durationMs;
  if (snap.input !== undefined) node.input = snap.input;
  if (snap.output !== undefined) node.output = snap.output;
  if (snap.error !== undefined) node.error = snap.error;
  if (snap.filePath !== undefined) node.filePath = snap.filePath;
  if (snap.toolName !== undefined) node.toolName = snap.toolName;
  if (snap.metadata) node.metadata = { ...snap.metadata };
  return node;
}

/**
 * 回放到 timestamp。
 * 存在事件裁剪时，从基线快照（裁剪时刻的真实节点状态）起算，只重放基线之后的真实事件；
 * 回放范围早于基线则钳制到基线，并在 replayStart 中反馈。
 * endedAt 只在执行真正终止时存在；当前时刻通过 replayTime 表达。
 */
export function replayGraph(graph: ExecutionGraph, timestamp: number): ExecutionGraph {
  if (!Number.isFinite(timestamp)) return graph;
  const internal = graph.internal ?? emptyInternals();
  const events = chronological(graph.events);
  const rootId = getRootId(graph.conversationId);

  const baselineTs = internal.baseline?.timestamp ?? null;
  const start = baselineTs !== null ? Math.min(baselineTs, events[0]?.timestamp ?? baselineTs) : events[0]?.timestamp ?? 0;
  const at = Math.max(timestamp, start);

  // 起点图：基线完整快照（由被裁剪事件折叠所得，无未来信息）或空图
  const snap = internal.baselineSnapshot ?? null;
  let acc: ExecutionGraph = snap
    ? {
        ...snapshotToGraph(snap, graph.conversationId, graph.source),
        droppedEvents: graph.droppedEvents,
        droppedNodes: graph.droppedNodes,
      }
    : {
        conversationId: graph.conversationId,
        source: graph.source,
        sessionId: graph.sessionId,
        title: graph.title,
        projectPath: graph.projectPath,
        status: 'unknown',
        startedAt: null,
        endedAt: null,
        nodes: {},
        edges: {},
        events: [],
        metrics: emptyMetrics(),
        droppedEvents: graph.droppedEvents,
        droppedNodes: graph.droppedNodes,
        // 回放序号只取决于回放范围本身（无基线时从 1 起播），不随全图增长漂移
        internal: { seenEventIds: [], nextSequence: 1, baseline: null, baselineNodes: null, baselineSnapshot: null },
      };

  for (const ev of events) {
    if (ev.timestamp > at) break;
    if (baselineTs !== null && ev.timestamp < baselineTs) continue;
    acc = applyEvent(acc, ev);
  }

  const nodes: Record<string, ExecutionNode> = {};
  for (const [id, node] of Object.entries(acc.nodes)) {
    if (node.type !== 'core' && node.startedAt !== undefined && node.startedAt > at) continue;
    nodes[id] = node;
  }
  const edges: Record<string, ExecutionEdge> = {};
  for (const [id, edge] of Object.entries(acc.edges)) {
    if (nodes[edge.source] && nodes[edge.target]) edges[id] = edge;
  }

  const nodeEndedAt = Object.values(nodes)
    .map((n) => n.endedAt)
    .filter((v): v is number => typeof v === 'number' && v <= at)
    .sort((a, b) => b - a)[0] ?? null;
  return {
    ...acc,
    nodes,
    edges,
    startedAt: acc.startedAt ?? (Object.values(nodes).find((n) => n.type !== 'core')?.startedAt ?? null),
    // 只保留回放到该时刻已发生的终止；当前时刻由 replayTime 表达
    endedAt: acc.status === 'completed' || acc.status === 'error' || acc.status === 'cancelled' ? nodeEndedAt ?? (acc.endedAt !== null && acc.endedAt <= at ? acc.endedAt : null) : null,
    droppedEvents: graph.droppedEvents,
    droppedNodes: graph.droppedNodes,
    internal: {
      seenEventIds: acc.internal?.seenEventIds ?? [],
      nextSequence: acc.internal?.nextSequence ?? 1,
      baseline: null,
      baselineNodes: null,
      baselineSnapshot: null,
    },
    replayTime: at,
    replayStart: start,
  };
}

/** 按布局序号排列节点 */
export function sortedNodes(graph: ExecutionGraph): ExecutionNode[] {
  return Object.values(graph.nodes).sort((a, b) => a.sequence - b.sequence);
}
