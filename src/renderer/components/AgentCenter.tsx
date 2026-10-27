import {
  Component,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  Crosshair,
  Download,
  Gauge,
  HelpCircle,
  List,
  Maximize2,
  Minimize2,
  Orbit,
  PanelRightOpen,
  Pause,
  Play,
  RotateCcw,
  Search,
  SkipBack,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
  X,
} from 'lucide-react';
import AgentScene from '../agent/AgentScene';
import {
  StableOrbitalLayout,
  belongsToAgent,
  executionPath,
  isDescendantOf,
  type SceneLayout,
} from '../agent/layout';
import {
  NODE_STATUSES,
  NODE_TYPES,
  formatCount,
  formatDuration,
  isActive,
  nodeColor,
} from '../agent/palette';
import {
  createGraph,
  getRootId,
  getStatistics,
  replayGraph,
  sortedNodes,
} from '../agent/model';
import {
  DEMO_DURATION,
  DEMO_INITIAL_TIME,
  getDemoFullGraph,
} from '../agent/demo';
import { useAgentStore } from '../agent/store';
import { useStore } from '../store';
import { copyText } from '../utils/clipboard';
import type {
  AgentViewMode,
  DataSource,
  ExecutionEvent,
  ExecutionGraph,
  ExecutionNode,
  NodeStatus,
  NodeType,
} from '../agent/types';
import '../styles/agent-center.css';

// ─── 类型与纯函数 ───────────────────────────────────────────

type Quality = 'auto' | 'high' | 'balanced' | 'low';
type Density = 'smart' | 'all';
type Rate = 0.5 | 1 | 2;
type ToastTone = 'info' | 'error';

interface CameraCommand {
  type: 'reset' | 'focus' | 'top' | 'zoomIn' | 'zoomOut';
  id?: string;
  nonce: number;
}

interface Telemetry {
  fps: number | null;
  drawCalls: number | null;
  triangles: number | null;
  renderer?: string;
}

interface ToastState {
  id: number;
  text: string;
  tone: ToastTone;
}

interface Filters {
  types: Set<NodeType>;
  status: NodeStatus | 'all';
  agent: string;
}

interface TimelineBar {
  id: string;
  label: string;
  status: NodeStatus;
  color: string;
  left: number;
  width: number;
  active: boolean;
}

interface TimelineLane {
  id: string;
  label: string;
  color: string;
  bars: TimelineBar[];
}

const TYPE_LIST: NodeType[] = ['core', 'agent', 'tool', 'file', 'task', 'error'];
const LEGEND_TYPES: NodeType[] = ['core', 'agent', 'tool', 'file', 'task'];
const CONVERSATION_SEP = '\u0002';
const FIELD_SEP = '\u0001';
const MAX_DRAWER_ITEMS = 100;
const MAX_EVENT_TICKS = 600;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatAxisTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function formatClock(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatCost(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(4)}`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseConversations(signature: string): Array<{ id: string; title: string }> {
  if (!signature) return [];
  return signature.split(CONVERSATION_SEP).map((part) => {
    const at = part.indexOf(FIELD_SEP);
    if (at < 0) return { id: part, title: part };
    return { id: part.slice(0, at), title: part.slice(at + 1) };
  });
}

function nodePasses(node: ExecutionNode, graph: ExecutionGraph, filters: Filters): boolean {
  if (node.type === 'core') return true;
  if (filters.types.size > 0 && !filters.types.has(node.type)) return false;
  if (filters.status !== 'all' && node.status !== filters.status) return false;
  if (filters.agent !== 'all' && !belongsToAgent(node, filters.agent, graph)) return false;
  return true;
}

function matchesNodeQuery(node: ExecutionNode, query: string): boolean {
  if (!query) return true;
  const haystack = [node.label, node.subtitle, node.toolName, node.filePath, node.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function buildLanes(
  graph: ExecutionGraph,
  time: number,
  start: number,
  end: number
): TimelineLane[] {
  if (!(end > start)) return [];
  const nodes = sortedNodes(graph);
  const agents = nodes.filter((node) => node.type === 'agent');
  const shownAgents = agents.slice(0, 5);
  const shownIds = new Set(shownAgents.map((node) => node.id));
  const extraIds = new Set(agents.slice(5).map((node) => node.id));
  const root = nodes.find((node) => node.type === 'core') ?? null;
  const coreLaneId = root?.id ?? '__core';
  const laneIds = [coreLaneId, ...shownAgents.map((node) => node.id)];
  if (extraIds.size > 0) laneIds.push('__other');

  const laneNodes = new Map<string, ExecutionNode[]>(laneIds.map((id) => [id, []]));
  const push = (laneId: string, node: ExecutionNode) => {
    const list = laneNodes.get(laneId);
    if (list) list.push(node);
  };

  for (const node of nodes) {
    if (node.type === 'core') {
      push(coreLaneId, node);
      continue;
    }
    if (node.type === 'agent') {
      if (shownIds.has(node.id)) push(node.id, node);
      else if (extraIds.has(node.id)) push('__other', node);
      continue;
    }
    const owner = shownAgents.find((agent) => belongsToAgent(node, agent.id, graph));
    if (owner) {
      push(owner.id, node);
    } else if (agents.some((agent) => extraIds.has(agent.id) && belongsToAgent(node, agent.id, graph))) {
      push('__other', node);
    } else {
      push(coreLaneId, node);
    }
  }

  const span = Math.max(1, end - start);
  const defs = [
    { id: coreLaneId, label: 'CORE', color: NODE_TYPES.core.color },
    ...shownAgents.map((agent) => ({ id: agent.id, label: agent.label, color: NODE_TYPES.agent.color })),
    ...(extraIds.size > 0 ? [{ id: '__other', label: '其余', color: '#8296ad' }] : []),
  ];

  return defs
    .map((def) => {
      const bars = (laneNodes.get(def.id) ?? []).flatMap((node): TimelineBar[] => {
        if (node.startedAt == null) return [];
        const from = clamp(node.startedAt, start, end);
        const to = clamp(node.endedAt ?? time, start, end);
        if (to < from) return [];
        return [
          {
            id: node.id,
            label: node.label,
            status: node.status,
            color: nodeColor(node),
            left: ((from - start) / span) * 100,
            width: Math.max(0.35, ((to - from) / span) * 100),
            active: isActive(node.status),
          },
        ];
      });
      return { ...def, bars };
    })
    .filter((lane) => lane.bars.length > 0 || lane.id === coreLaneId);
}

function eventTickColor(event: ExecutionEvent): string {
  if (event.status) return NODE_STATUSES[event.status].color;
  if (event.kind === 'error') return NODE_TYPES.error.color;
  if (event.kind === 'file') return NODE_TYPES.file.color;
  if (event.kind === 'agent') return NODE_TYPES.agent.color;
  if (event.kind === 'task') return NODE_TYPES.task.color;
  return '#5f7b93';
}

// ─── 小型展示组件 ───────────────────────────────────────────

function TypeGlyph({ type, size = 10 }: { type: NodeType; size?: number }) {
  const color = NODE_TYPES[type].color;
  if (type === 'core') {
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
        <circle cx="5" cy="5" r="4" fill="none" stroke={color} strokeWidth="1.2" />
        <circle cx="5" cy="5" r="1.5" fill={color} />
      </svg>
    );
  }
  if (type === 'agent') {
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
        <polygon points="5,0.5 9.5,5 5,9.5 0.5,5" fill="none" stroke={color} strokeWidth="1.1" />
      </svg>
    );
  }
  if (type === 'tool') {
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
        <polygon points="2.5,0.8 7.5,0.8 9.4,5 7.5,9.2 2.5,9.2 0.6,5" fill="none" stroke={color} strokeWidth="1.1" />
      </svg>
    );
  }
  if (type === 'file') {
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
        <rect x="1" y="1.6" width="8" height="6.8" rx="0.8" fill="none" stroke={color} strokeWidth="1.1" />
      </svg>
    );
  }
  if (type === 'task') {
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
        <rect x="1" y="1" width="8" height="8" rx="0.7" fill="none" stroke={color} strokeWidth="1.1" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 1 L9 9 M9 1 L1 9" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}

const TypeLegend = memo(function TypeLegend() {
  return (
    <div className="acs-legend-stack">
      <div className="acs-legend-row" aria-label="节点类型图例">
        {LEGEND_TYPES.map((type) => (
          <span className="acs-legend-item" key={type}>
            <TypeGlyph type={type} />
            <span style={{ color: NODE_TYPES[type].color }}>{NODE_TYPES[type].label}</span>
          </span>
        ))}
      </div>
      <div className="acs-edge-legend" aria-label="连线语义图例">
        <span data-edge="call"><i />调用</span>
        <span data-edge="dependency"><i />依赖</span>
        <span data-edge="write"><i />读写</span>
        <span data-edge="retry"><i />重试</span>
      </div>
    </div>
  );
});

const Rail = memo(function Rail({
  onChat,
  onFocusCore,
  onToggleDrawer,
  onToggleHelp,
  drawerOpen,
  helpOpen,
  nodeCount,
}: {
  onChat: () => void;
  onFocusCore: () => void;
  onToggleDrawer: () => void;
  onToggleHelp: () => void;
  drawerOpen: boolean;
  helpOpen: boolean;
  nodeCount: number;
}) {
  return (
    <aside className="acs-rail" aria-label="执行空间导航">
      <div className="acs-brand" aria-label="执行空间标识">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <ellipse cx="14" cy="14" rx="12" ry="5.4" stroke="currentColor" strokeOpacity="0.4" transform="rotate(-24 14 14)" />
          <ellipse cx="14" cy="14" rx="8" ry="8" stroke="currentColor" strokeOpacity="0.22" />
          <circle cx="14" cy="14" r="2.3" fill="currentColor" />
          <circle cx="23.1" cy="8.2" r="1.35" fill="currentColor" fillOpacity="0.72" />
        </svg>
      </div>
      <button type="button" className="acs-rail-btn" onClick={onChat} aria-label="返回对话" title="返回对话">
        <ArrowLeft size={18} />
      </button>
      <button
        type="button"
        className="acs-rail-btn is-active"
        onClick={onFocusCore}
        aria-label="聚焦主 Agent"
        title="聚焦主 Agent 核心"
      >
        <Orbit size={18} />
      </button>
      <button
        type="button"
        className={drawerOpen ? 'acs-rail-btn is-active' : 'acs-rail-btn'}
        aria-pressed={drawerOpen}
        onClick={onToggleDrawer}
        aria-label="节点列表"
        title={`节点列表（${nodeCount}）`}
      >
        <List size={18} />
        {nodeCount > 0 && <span className="acs-rail-count">{nodeCount > 99 ? '99+' : nodeCount}</span>}
      </button>
      <div className="acs-rail-spacer" />
      <button
        type="button"
        className={helpOpen ? 'acs-rail-btn is-active' : 'acs-rail-btn'}
        aria-pressed={helpOpen}
        onClick={onToggleHelp}
        aria-label="帮助与真实信息边界"
        title="帮助与真实信息边界"
      >
        <HelpCircle size={18} />
      </button>
    </aside>
  );
});

const StatsBar = memo(function StatsBar({
  agents,
  tools,
  files,
  running,
  inputTokens,
  outputTokens,
  cacheTokens,
  costText,
  hasData,
}: {
  agents: string;
  tools: string;
  files: string;
  running: string;
  inputTokens: string;
  outputTokens: string;
  cacheTokens: string;
  costText: string;
  hasData: boolean;
}) {
  const stat = (label: string, value: string) => (
    <span className="acs-stat">
      <em>{label}</em>
      <b>{hasData ? value : '—'}</b>
    </span>
  );
  return (
    <div
      className="acs-stats"
      role="group"
      aria-label="执行统计"
      title="Tokens 与成本仅来自 usage / result；未知记为 —，不推算上下文占用"
    >
      {stat('Agents', agents)}
      {stat('Tools', tools)}
      {stat('Files', files)}
      {stat('运行', running)}
      <span className="acs-stat-sep" aria-hidden="true" />
      <span className="acs-stat acs-stat-metric">
        <em>Tokens in</em>
        <b>{hasData ? inputTokens : '—'}</b>
      </span>
      <span className="acs-stat acs-stat-metric">
        <em>out</em>
        <b>{hasData ? outputTokens : '—'}</b>
      </span>
      <span className="acs-stat acs-stat-metric">
        <em>cache</em>
        <b>{hasData ? cacheTokens : '—'}</b>
      </span>
      <span className="acs-stat acs-stat-metric">
        <em>成本</em>
        <b>{hasData ? costText : '—'}</b>
      </span>
    </div>
  );
});

const TimelineChart = memo(function TimelineChart({
  lanes,
  ticks,
  start,
  end,
}: {
  lanes: TimelineLane[];
  ticks: ExecutionEvent[];
  start: number;
  end: number;
}) {
  const span = Math.max(1, end - start);
  const pct = (ts: number) => clamp((ts - start) / span, 0, 1) * 1000;

  return (
    <div
      className="acs-lane-scroll"
      role="img"
      aria-label="执行时间线，按真实 startedAt 与事件时间绘制"
    >
      <div className="acs-lanes">
        <div className="acs-lane-row acs-axis-row">
          <span className="acs-lane-name">EVENT</span>
          <svg className="acs-lane-track acs-axis-track" viewBox="0 0 1000 16" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="8" x2="1000" y2="8" stroke="rgba(121,237,255,0.16)" strokeWidth="1" />
            {ticks.map((event) => (
              <rect
                key={event.id}
                x={Math.max(0, pct(event.timestamp) - 1)}
                y="3.5"
                width="2"
                height="9"
                fill={eventTickColor(event)}
                fillOpacity="0.7"
              >
                <title>{`${formatAxisTime(event.timestamp - start)} · ${event.label}`}</title>
              </rect>
            ))}
          </svg>
        </div>
        {lanes.map((lane) => (
          <div className="acs-lane-row" key={lane.id}>
            <span className="acs-lane-name" style={{ color: lane.color }} title={lane.label}>
              {lane.label}
            </span>
            <svg className="acs-lane-track" viewBox="0 0 1000 12" preserveAspectRatio="none" aria-hidden="true">
              <line x1="0" y1="6" x2="1000" y2="6" stroke="rgba(121,237,255,0.07)" strokeWidth="1" />
              {lane.bars.map((bar) => (
                <rect
                  key={bar.id}
                  x={(bar.left / 100) * 1000}
                  y="2.6"
                  width={Math.max(2, (bar.width / 100) * 1000)}
                  height="6.8"
                  rx="1"
                  fill={bar.color}
                  fillOpacity={bar.active ? 0.95 : 0.5}
                >
                  <title>{`${bar.label} · ${NODE_STATUSES[bar.status].label}`}</title>
                </rect>
              ))}
            </svg>
          </div>
        ))}
      </div>
    </div>
  );
});

const TimelineEvents = memo(
  function TimelineEvents({
    events,
    start,
    total,
    onSelect,
  }: {
    events: ExecutionEvent[];
    start: number;
    total: number;
    onSelect: (event: ExecutionEvent) => void;
  }) {
    return (
      <div className="acs-events" aria-label="最近执行事件">
        <div className="acs-events-head">
          <span>最近 6 条</span>
          <span className="acs-events-count">共 {total}</span>
        </div>
        {events.length === 0 ? (
          <p className="acs-events-empty">当前回放时刻尚无事件。</p>
        ) : (
          events.map((event) => (
            <button
              type="button"
              key={event.id}
              className="acs-event-row"
              onClick={() => onSelect(event)}
              title={event.label}
            >
              <span className="acs-event-top">
                <span className="acs-event-dot" style={{ background: eventTickColor(event) }} />
                <span className="acs-event-time">{formatAxisTime(event.timestamp - start)}</span>
                <span className="acs-event-kind">{event.kind}</span>
              </span>
              <span className="acs-event-label">{event.label || '未命名事件'}</span>
            </button>
          ))
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.start === next.start &&
    prev.total === next.total &&
    prev.onSelect === next.onSelect &&
    prev.events.length === next.events.length &&
    prev.events.every(
      (event, index) => event.id === next.events[index]?.id && event.status === next.events[index]?.status
    )
);

const InspectorPanel = memo(
  function InspectorPanel({
    node,
    missingSelection,
    mode,
    graphStart,
    eventCount,
    filterNote,
    onClose,
    onClearSelection,
    onFocus,
    onCopy,
    onDownload,
    onOpenDrawer,
  }: {
    node: ExecutionNode | null;
    missingSelection: boolean;
    mode: AgentViewMode;
    graphStart: number | null;
    eventCount: number;
    filterNote: string | null;
    onClose: () => void;
    onClearSelection: () => void;
    onFocus: () => void;
    onCopy: (kind: string, text: string) => void;
    onDownload: () => void;
    onOpenDrawer: () => void;
  }) {
    const timeLabel = (ts: number | null | undefined) => {
      if (ts == null) return '—';
      return mode === 'demo' ? `+${formatAxisTime(ts)}` : formatClock(ts);
    };
    const inputText = node && node.input !== undefined ? stringifyValue(node.input) : '';
    const outputText = node?.output ?? '';
    const duration =
      node?.durationMs ??
      (node?.startedAt != null && node?.endedAt != null ? node.endedAt - node.startedAt : null);
    const statusColor = node ? NODE_STATUSES[node.status].color : '#8e9aaf';

    return (
      <aside className="acs-inspector" aria-label="节点 Inspector">
        <header className="acs-inspector-head">
          <span className="acs-inspector-title">
            <Activity size={13} />
            Inspector
          </span>
          <button type="button" className="acs-icon-btn" onClick={onClose} aria-label="关闭 Inspector" title="关闭 Inspector">
            <X size={14} />
          </button>
        </header>
        <div className="acs-inspector-body">
          {filterNote && <p className="acs-inline-note">{filterNote}</p>}
          {missingSelection ? (
            <div className="acs-inspector-placeholder">
              <p>所选节点不在当前回放时刻，可能尚未创建或已被有界裁剪。</p>
              <button type="button" className="acs-text-btn" onClick={onClearSelection}>
                清除选择，查看核心概览
              </button>
            </div>
          ) : !node ? (
            <div className="acs-inspector-placeholder">
              <p>当前时刻没有可显示的核心节点，执行图仍是空的。</p>
              <button type="button" className="acs-text-btn" onClick={onOpenDrawer}>
                打开节点列表
              </button>
            </div>
          ) : (
            <>
              <div className="acs-inspector-meta">
                <span className="acs-node-type">
                  <TypeGlyph type={node.type} size={11} />
                  {NODE_TYPES[node.type].label}
                </span>
                <span
                  className="acs-status-badge"
                  style={{ color: statusColor, borderColor: `${statusColor}55` }}
                >
                  {NODE_STATUSES[node.status].label}
                </span>
              </div>
              <h2 className="acs-node-title" title={node.label}>
                {node.label}
              </h2>
              {node.subtitle && <p className="acs-node-sub">{node.subtitle}</p>}

              {node.metadata?.approval === true && (
                <p className="acs-warn-note">
                  真实审批操作在当前执行空间不可用。请在对话中处理；此处不提供批准或拒绝按钮。
                </p>
              )}

              <dl className="acs-facts">
                <div>
                  <dt>开始</dt>
                  <dd title={node.startedAt != null ? new Date(node.startedAt).toISOString() : undefined}>
                    {timeLabel(node.startedAt)}
                  </dd>
                </div>
                <div>
                  <dt>结束</dt>
                  <dd>{timeLabel(node.endedAt)}</dd>
                </div>
                <div>
                  <dt>耗时</dt>
                  <dd>{formatDuration(duration)}</dd>
                </div>
                {node.toolName && (
                  <div>
                    <dt>工具</dt>
                    <dd className="acs-mono">{node.toolName}</dd>
                  </div>
                )}
                {graphStart != null && node.startedAt != null && (
                  <div>
                    <dt>相对起点</dt>
                    <dd className="acs-mono">{formatAxisTime(node.startedAt - graphStart)}</dd>
                  </div>
                )}
              </dl>

              {(node.filePath || node.relatedFiles.length > 0) && (
                <section className="acs-inspector-section">
                  <h3>相关文件</h3>
                  {node.filePath && <p className="acs-file-path acs-mono">{node.filePath}</p>}
                  {node.relatedFiles.length > 0 && (
                    <ul className="acs-file-list">
                      {node.relatedFiles.map((file) => (
                        <li key={file} className="acs-mono" title={file}>
                          {file}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="acs-boundary-line">文件名来自工具观测，未做操作系统层面的校验。</p>
                </section>
              )}

              {node.input !== undefined && (
                <section className="acs-inspector-section">
                  <div className="acs-section-head">
                    <h3>输入</h3>
                    <button
                      type="button"
                      className="acs-icon-btn"
                      onClick={() => onCopy('输入', inputText)}
                      aria-label="复制输入"
                      title="复制输入"
                    >
                      <Copy size={12} />
                    </button>
                  </div>
                  <pre className="acs-pre selectable-text">{inputText}</pre>
                </section>
              )}

              {node.output && (
                <section className="acs-inspector-section">
                  <div className="acs-section-head">
                    <h3>输出</h3>
                    <button
                      type="button"
                      className="acs-icon-btn"
                      onClick={() => onCopy('输出', outputText)}
                      aria-label="复制输出"
                      title="复制输出"
                    >
                      <Copy size={12} />
                    </button>
                  </div>
                  <pre className="acs-pre selectable-text">{outputText}</pre>
                  <p className="acs-boundary-line">输出是工具观测结果，不代表操作系统确认。</p>
                </section>
              )}

              {node.error && (
                <section className="acs-inspector-section">
                  <div className="acs-section-head">
                    <h3>错误</h3>
                    <button
                      type="button"
                      className="acs-icon-btn"
                      onClick={() => onCopy('错误', node.error ?? '')}
                      aria-label="复制错误"
                      title="复制错误"
                    >
                      <Copy size={12} />
                    </button>
                  </div>
                  <pre className="acs-pre acs-pre-error selectable-text">{node.error}</pre>
                </section>
              )}

              <section className="acs-boundary">
                <h3>真实信息边界</h3>
                <p>节点与连线来自收到的执行事件；回放只重放已发生的事实。</p>
                <p>Tokens / 成本只取 usage / result，无法确知时显示 —，不从 usage 推算上下文占用。</p>
                <p>文件与工具输出仅表示观测结果；审批操作当前不支持。</p>
              </section>
            </>
          )}
        </div>
        <footer className="acs-inspector-footer">
          {node && (
            <button type="button" className="acs-text-btn" onClick={onFocus}>
              <Crosshair size={12} />
              聚焦该节点
            </button>
          )}
          {eventCount > 0 && (
            <button type="button" className="acs-text-btn" onClick={onDownload}>
              <Download size={12} />
              导出事件 JSON
            </button>
          )}
        </footer>
      </aside>
    );
  },
  (prev, next) => {
    const a = prev.node;
    const b = next.node;
    return (
      a?.id === b?.id &&
      a?.status === b?.status &&
      a?.label === b?.label &&
      a?.subtitle === b?.subtitle &&
      a?.toolName === b?.toolName &&
      a?.filePath === b?.filePath &&
      a?.startedAt === b?.startedAt &&
      a?.endedAt === b?.endedAt &&
      a?.durationMs === b?.durationMs &&
      a?.output === b?.output &&
      a?.error === b?.error &&
      a?.input === b?.input &&
      a?.relatedFiles === b?.relatedFiles &&
      a?.metadata === b?.metadata &&
      prev.missingSelection === next.missingSelection &&
      prev.mode === next.mode &&
      prev.graphStart === next.graphStart &&
      prev.eventCount === next.eventCount &&
      prev.filterNote === next.filterNote &&
      prev.onClose === next.onClose &&
      prev.onClearSelection === next.onClearSelection &&
      prev.onFocus === next.onFocus &&
      prev.onCopy === next.onCopy &&
      prev.onDownload === next.onDownload &&
      prev.onOpenDrawer === next.onOpenDrawer
    );
  }
);

const NodeDrawer = memo(
  function NodeDrawer({
    items,
    total,
    query,
    selectedId,
    onQuery,
    onSelect,
    onFocus,
    onClose,
  }: {
    items: ExecutionNode[];
    total: number;
    query: string;
    selectedId: string | null;
    onQuery: (value: string) => void;
    onSelect: (id: string) => void;
    onFocus: (id: string) => void;
    onClose: () => void;
  }) {
    return (
      <div className="acs-drawer" role="dialog" aria-modal="true" aria-label="节点列表">
        <header className="acs-drawer-head">
          <div>
            <h2>节点列表</h2>
            <p>
              显示 {items.length}/{total} · 搜索仅作用于当前筛选结果
            </p>
          </div>
          <button type="button" className="acs-icon-btn" onClick={onClose} aria-label="关闭节点列表" title="关闭节点列表">
            <X size={15} />
          </button>
        </header>
        <label className="acs-search">
          <Search size={13} />
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.currentTarget.value)}
            placeholder="搜索名称 / 工具 / 文件"
            aria-label="搜索节点"
            autoFocus
          />
          {query && (
            <button type="button" className="acs-search-clear" onClick={() => onQuery('')} aria-label="清除搜索">
              <X size={12} />
            </button>
          )}
        </label>
        <div className="acs-node-list">
          {items.length === 0 ? (
            <p className="acs-events-empty">没有匹配当前筛选的节点。</p>
          ) : (
            items.map((node) => (
              <button
                type="button"
                key={node.id}
                className={node.id === selectedId ? 'acs-node-item is-selected' : 'acs-node-item'}
                onClick={() => onSelect(node.id)}
                onDoubleClick={() => onFocus(node.id)}
                aria-label={`选择节点 ${node.label}`}
                title="单击选择，双击聚焦"
              >
                <TypeGlyph type={node.type} size={12} />
                <span className="acs-node-item-main">
                  <span className="acs-node-item-label">{node.label}</span>
                  <span className="acs-node-item-sub">
                    {node.toolName || node.filePath || NODE_TYPES[node.type].code}
                  </span>
                </span>
                <span
                  className="acs-node-item-status"
                  style={{ color: NODE_STATUSES[node.status].color }}
                >
                  {NODE_STATUSES[node.status].label}
                </span>
              </button>
            ))
          )}
        </div>
        {total > MAX_DRAWER_ITEMS && (
          <p className="acs-drawer-footnote">列表上限 {MAX_DRAWER_ITEMS} 条；请用搜索缩小范围。</p>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.total === next.total &&
    prev.query === next.query &&
    prev.selectedId === next.selectedId &&
    prev.onQuery === next.onQuery &&
    prev.onSelect === next.onSelect &&
    prev.onFocus === next.onFocus &&
    prev.onClose === next.onClose &&
    prev.items.length === next.items.length &&
    prev.items.every(
      (node, index) =>
        node.id === next.items[index]?.id &&
        node.status === next.items[index]?.status &&
        node.label === next.items[index]?.label
    )
);

// ─── 场景错误边界 ───────────────────────────────────────────

class SceneBoundary extends Component<
  { children: ReactNode; onFailure: (reason: string) => void; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const message = error?.message || '三维场景渲染异常';
    this.props.onFailure(info?.componentStack ? `${message}（组件栈已记录）` : message);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// ─── 主组件 ─────────────────────────────────────────────────

export default function AgentCenter() {
  const mode = useAgentStore((state) => state.mode);
  const setMode = useAgentStore((state) => state.setMode);
  const hideAgentSpace = useAgentStore((state) => state.hide);
  const activeConversationId = useStore((state) => state.activeConversationId);
  const setActiveConversation = useStore((state) => state.setActiveConversation);
  const cwd = useStore((state) => state.cwd);
  // 只订阅 id/title 拼接签名：token 流会替换 conversations 数组，
  // 但签名不变时 HUD 不会随每个 token 重渲染。
  const conversationSignature = useStore((state) =>
    state.conversations.map((conv) => `${conv.id}${FIELD_SEP}${conv.title}`).join(CONVERSATION_SEP)
  );
  const conversations = useMemo(
    () => parseConversations(conversationSignature),
    [conversationSignature]
  );
  const activeMeta = useMemo(
    () => conversations.find((conv) => conv.id === activeConversationId) ?? null,
    [conversations, activeConversationId]
  );
  const rawLive = useAgentStore((state) => state.live[activeConversationId]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);

  const [typeFilter, setTypeFilter] = useState<Set<NodeType>>(() => new Set());
  const [statusFilter, setStatusFilter] = useState<NodeStatus | 'all'>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [filterNotice, setFilterNotice] = useState<string | null>(null);
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(() => new Set());
  const [density, setDensity] = useState<Density>('smart');

  const [paused, setPaused] = useState(false);
  const [labels, setLabels] = useState(true);
  const [quality, setQuality] = useState<Quality>('auto');
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry>({
    fps: null,
    drawCalls: null,
    triangles: null,
  });
  const [sceneFailure, setSceneFailure] = useState<string | null>(null);
  const [sceneKey, setSceneKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const [demoTime, setDemoTime] = useState(DEMO_INITIAL_TIME);
  const [hudDemoTime, setHudDemoTime] = useState(DEMO_INITIAL_TIME);
  const [demoPaused, setDemoPaused] = useState(false);
  const [demoRate, setDemoRate] = useState<Rate>(1);
  const [liveFollow, setLiveFollow] = useState(true);
  const [liveSeek, setLiveSeek] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const demoFullGraph = useMemo(() => getDemoFullGraph(), []);
  const emptyLiveGraph = useMemo(() => {
    const conversationId = activeConversationId || 'live';
    const graph = createGraph(conversationId, 'live', activeMeta?.title || '等待执行', cwd);
    const rootId = getRootId(conversationId);
    const root = graph.nodes[rootId];
    if (!root) return graph;
    return {
      ...graph,
      status: 'idle' as NodeStatus,
      nodes: {
        ...graph.nodes,
        [rootId]: { ...root, status: 'idle' as NodeStatus, label: activeMeta?.title || '等待执行' },
      },
    };
  }, [activeConversationId, activeMeta?.title, cwd]);

  const baseLive = rawLive ?? emptyLiveGraph;
  const rawGraph = mode === 'demo' ? demoFullGraph : baseLive;

  const liveRange = useMemo(() => {
    const events = baseLive.events;
    const first = events[0]?.timestamp ?? null;
    const last = events.length > 0 ? events[events.length - 1].timestamp : null;
    const start = baseLive.startedAt ?? first;
    const terminal =
      baseLive.endedAt != null ||
      baseLive.source === 'history' ||
      ['completed', 'error', 'cancelled', 'blocked'].includes(baseLive.status);
    const end = terminal
      ? Math.max(baseLive.endedAt ?? 0, last ?? 0, start ?? 0)
      : Math.max(start ?? 0, last ?? 0, clock);
    return { start, end, terminal };
  }, [baseLive, clock]);

  // 场景按 100ms tick 推进；HUD 单独 250ms 采样，避免 Inspector/列表
  // 在 1 秒内被高频 graph 对象反复驱动。
  const sceneGraph = useMemo(() => {
    if (mode === 'demo') return replayGraph(demoFullGraph, demoTime);
    if (liveFollow) return baseLive;
    const at = liveSeek ?? liveRange.end ?? clock;
    return replayGraph(baseLive, at);
  }, [mode, demoFullGraph, demoTime, baseLive, liveFollow, liveSeek, liveRange.end, clock]);

  const hudGraph = useMemo(() => {
    if (mode === 'demo') return replayGraph(demoFullGraph, hudDemoTime);
    if (liveFollow) return baseLive;
    return sceneGraph;
  }, [mode, demoFullGraph, hudDemoTime, liveFollow, baseLive, sceneGraph]);

  const timelineStart = mode === 'demo' ? 0 : liveRange.start;
  const timelineEnd = mode === 'demo' ? DEMO_DURATION : liveRange.end;
  const timelineTime =
    mode === 'demo'
      ? demoTime
      : liveFollow
        ? liveRange.end ?? clock
        : liveSeek ?? liveRange.end ?? clock;
  const chartTime = mode === 'demo' ? hudDemoTime : timelineTime;
  const hasTimeline =
    mode === 'demo'
      ? true
      : baseLive.events.length > 0 &&
        timelineStart != null &&
        timelineEnd != null &&
        timelineEnd > timelineStart;

  const filters = useMemo<Filters>(
    () => ({ types: typeFilter, status: statusFilter, agent: agentFilter }),
    [typeFilter, statusFilter, agentFilter]
  );

  const coreNode = useMemo(
    () => sortedNodes(hudGraph).find((node) => node.type === 'core') ?? null,
    [hudGraph]
  );
  const selectedNode = selectedId ? hudGraph.nodes[selectedId] ?? null : coreNode;
  const missingSelection = Boolean(selectedId && !selectedNode);
  const rootId = coreNode?.id ?? null;

  const agentOptions = useMemo(
    () => sortedNodes(rawGraph).filter((node) => node.type === 'agent'),
    [rawGraph]
  );

  const drawerFiltered = useMemo(() => {
    const base = sortedNodes(hudGraph).filter(
      (node) => node.type === 'core' || nodePasses(node, hudGraph, filters)
    );
    const search = query.trim().toLowerCase();
    const matched = search ? base.filter((node) => matchesNodeQuery(node, search)) : base;
    return { items: matched.slice(0, MAX_DRAWER_ITEMS), total: matched.length };
  }, [hudGraph, filters, query]);

  const typeCounts = useMemo(() => {
    const counts: Record<NodeType, number> = {
      core: 0,
      agent: 0,
      tool: 0,
      file: 0,
      task: 0,
      error: 0,
    };
    for (const node of Object.values(hudGraph.nodes)) counts[node.type] += 1;
    return counts;
  }, [hudGraph]);

  const stats = useMemo(() => getStatistics(hudGraph), [hudGraph]);
  const hasData = mode === 'demo' || baseLive.events.length > 0;
  const metrics = hudGraph.metrics;

  const currentTask = useMemo(() => {
    const nodes = sortedNodes(hudGraph);
    const active = nodes.filter(
      (node) => isActive(node.status) && (node.type === 'task' || node.type === 'agent' || node.type === 'tool')
    );
    return (
      active[active.length - 1]?.label ||
      nodes.filter((node) => node.type === 'task').slice(-1)[0]?.label ||
      hudGraph.title ||
      '等待执行'
    );
  }, [hudGraph]);

  const lanes = useMemo(
    () => buildLanes(hudGraph, chartTime, timelineStart ?? 0, timelineEnd ?? 0),
    [hudGraph, chartTime, timelineStart, timelineEnd]
  );

  const recentEvents = useMemo(() => hudGraph.events.slice(-6).reverse(), [hudGraph.events]);

  const eventTickKey = useMemo(() => {
    const events = hudGraph.events;
    return `${events.length}:${events[0]?.id ?? ''}:${events[events.length - 1]?.id ?? ''}`;
  }, [hudGraph.events]);

  const chartEvents = useMemo(() => {
    const events = hudGraph.events;
    return events
      .filter(
        (event) =>
          event.timestamp >= (timelineStart ?? 0) && event.timestamp <= (timelineEnd ?? 0)
      )
      .slice(-MAX_EVENT_TICKS);
  }, [eventTickKey, timelineStart, timelineEnd]);

  const selectedOutOfFilter = Boolean(
    selectedNode && selectedNode.type !== 'core' && !nodePasses(selectedNode, hudGraph, filters)
  );
  const filterNoticeText =
    filterNotice ??
    (selectedOutOfFilter ? '当前筛选会隐藏所选节点；已将其临时保留在可见集合中。' : null);

  const hasBridge = useMemo(() => {
    const apiClaude = (window as any)?.api?.claude;
    return typeof apiClaude === 'function' || typeof apiClaude?.onStream === 'function';
  }, []);

  const source: DataSource = hudGraph.source;
  const projectLabel = hudGraph.projectPath || cwd || '未选择项目';

  // 所有最新值集中到 refs，供稳定回调和 Scene 使用。
  const mainRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(new StableOrbitalLayout());
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeqRef = useRef(0);
  const telemetryTimerRef = useRef<number | null>(null);
  const telemetryRef = useRef<Telemetry>({ fps: null, drawCalls: null, triangles: null });

  const sceneGraphRef = useRef(sceneGraph);
  const hudGraphRef = useRef(hudGraph);
  const rawGraphRef = useRef(rawGraph);
  const filtersRef = useRef(filters);
  const modeRef = useRef(mode);
  const liveRangeRef = useRef(liveRange);
  const liveFollowRef = useRef(liveFollow);
  const clockRef = useRef(clock);
  const demoTimeRef = useRef(demoTime);
  const sendCameraRef = useRef<(type: CameraCommand['type'], id?: string) => void>(() => undefined);
  const rootIdRef = useRef<string | null>(rootId);
  const uiRef = useRef({ helpOpen, drawerOpen, inspectorOpen, selectedId, rootId });

  sceneGraphRef.current = sceneGraph;
  hudGraphRef.current = hudGraph;
  rawGraphRef.current = rawGraph;
  filtersRef.current = filters;
  modeRef.current = mode;
  liveRangeRef.current = liveRange;
  liveFollowRef.current = liveFollow;
  clockRef.current = clock;
  demoTimeRef.current = demoTime;
  rootIdRef.current = rootId;
  uiRef.current = { helpOpen, drawerOpen, inspectorOpen, selectedId, rootId };

  // ─── 定时器与生命周期 ───────────────────────────────────

  // 演示默认 65s 自动推进；120s 后暂停，不会无限循环伪造执行。
  useEffect(() => {
    if (mode !== 'demo' || demoPaused) return;
    const timer = window.setInterval(() => {
      setDemoTime((current) => Math.min(DEMO_DURATION, current + 100 * demoRate));
    }, 100);
    return () => window.clearInterval(timer);
  }, [mode, demoPaused, demoRate]);

  useEffect(() => {
    if (mode === 'demo' && demoTime >= DEMO_DURATION && !demoPaused) {
      setDemoPaused(true);
    }
  }, [mode, demoTime, demoPaused]);

  useEffect(() => {
    if (mode !== 'demo') return;
    const timer = window.setInterval(() => {
      setHudDemoTime((previous) =>
        previous === demoTimeRef.current ? previous : demoTimeRef.current
      );
    }, 250);
    return () => window.clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'live' || !liveFollow || liveRange.terminal) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [mode, liveFollow, liveRange.terminal]);

  useEffect(() => {
    setSelectedId(null);
    setFilterNotice(null);
    setDrawerOpen(false);
    setCollapsedAgents(new Set());
  }, [mode, activeConversationId]);

  useEffect(() => {
    if (mode === 'live') {
      setLiveFollow(true);
      setLiveSeek(null);
    } else {
      setHudDemoTime(demoTimeRef.current);
    }
  }, [mode, activeConversationId]);

  useEffect(() => {
    const original = document.body.dataset.agentSpace;
    document.body.dataset.agentSpace = 'open';
    return () => {
      if (original === undefined) delete document.body.dataset.agentSpace;
      else document.body.dataset.agentSpace = original;
    };
  }, []);

  useEffect(() => {
    const sync = () => {
      const element = document.fullscreenElement;
      setIsFullscreen(Boolean(element && mainRef.current && element.contains(mainRef.current)));
    };
    document.addEventListener('fullscreenchange', sync);
    sync();
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  useEffect(() => {
    return () => {
      const element = document.fullscreenElement;
      if (element && mainRef.current?.contains(element)) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (telemetryTimerRef.current != null) window.clearTimeout(telemetryTimerRef.current);
    };
  }, []);

  // ─── 稳定回调 ───────────────────────────────────────────

  const showToast = useCallback((text: string, tone: ToastTone = 'info') => {
    toastSeqRef.current += 1;
    setToast({ id: toastSeqRef.current, text, tone });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2600);
  }, []);

  const sendCamera = useCallback((type: CameraCommand['type'], id?: string) => {
    setCameraCommand((previous) => ({ type, id, nonce: (previous?.nonce ?? 0) + 1 }));
  }, []);
  sendCameraRef.current = sendCamera;

  const handleTelemetry = useCallback(
    (next: { fps: number | null; drawCalls: number; triangles: number; renderer?: string }) => {
      const previous = telemetryRef.current;
      if (
        previous.fps === next.fps &&
        previous.drawCalls === next.drawCalls &&
        previous.triangles === next.triangles &&
        previous.renderer === next.renderer
      ) {
        return;
      }
      telemetryRef.current = {
        fps: next.fps,
        drawCalls: next.drawCalls,
        triangles: next.triangles,
        renderer: next.renderer,
      };
      // 最多 1s 提交一次遥测；callback 身份恒定，避免 Scene layout effect 反复重跑。
      if (telemetryTimerRef.current != null) return;
      telemetryTimerRef.current = window.setTimeout(() => {
        telemetryTimerRef.current = null;
        setTelemetry(telemetryRef.current);
      }, 1000);
    },
    []
  );

  const handleSceneFailure = useCallback((reason: string) => {
    setSceneFailure(reason || '未知的三维渲染错误');
  }, []);

  const handleRetryScene = useCallback(() => {
    setSceneFailure(null);
    setSceneKey((key) => key + 1);
    showToast('正在重试三维场景');
  }, [showToast]);

  const resetFilters = useCallback(() => {
    setTypeFilter(new Set());
    setStatusFilter('all');
    setAgentFilter('all');
    setFilterNotice(null);
  }, []);

  const selectNode = useCallback(
    (id: string | null, focus = false) => {
      setSelectedId(id);
      if (id) setInspectorOpen(true);
      if (!id) {
        setFilterNotice(null);
        return;
      }
      const graph = sceneGraphRef.current;
      const node = graph.nodes[id] ?? hudGraphRef.current.nodes[id];
      if (node && !nodePasses(node, graph, filtersRef.current)) {
        resetFilters();
        setFilterNotice('已清除筛选，以显示所选的执行节点。');
      } else {
        setFilterNotice(null);
      }
      if (focus) sendCameraRef.current('focus', id);
    },
    [resetFilters]
  );

  const handleSceneSelect = useCallback(
    (id: string | null) => selectNode(id, false),
    [selectNode]
  );

  const handleHover = useCallback((id: string | null) => setHoveredId(id), []);
  const hoveredNode = hoveredId ? hudGraph.nodes[hoveredId] ?? null : null;

  const handleEventSelect = useCallback((event: ExecutionEvent) => {
    const nodeId = event.nodeId ?? event.delta?.node?.id ?? null;
    const node = nodeId ? rawGraphRef.current.nodes[nodeId] : undefined;
    let at = event.timestamp;
    if (node?.startedAt != null) at = Math.max(at, node.startedAt);

    if (modeRef.current === 'demo') {
      const time = clamp(at, 0, DEMO_DURATION);
      setDemoTime(time);
      setHudDemoTime(time);
      setDemoPaused(true);
    } else {
      const range = liveRangeRef.current;
      const lo = range.start ?? at;
      const hi = Math.max(lo, range.end ?? at);
      setLiveFollow(false);
      setLiveSeek(clamp(at, lo, hi));
    }

    if (node) {
      setSelectedId(node.id);
      setInspectorOpen(true);
      if (!nodePasses(node, rawGraphRef.current, filtersRef.current)) {
        setTypeFilter(new Set());
        setStatusFilter('all');
        setAgentFilter('all');
        setFilterNotice('已清除筛选，以显示所选的事件节点。');
      } else {
        setFilterNotice(null);
      }
      sendCameraRef.current('focus', node.id);
    }
  }, []);

  const handleSeek = useCallback((value: number) => {
    if (modeRef.current === 'demo') {
      const time = clamp(value, 0, DEMO_DURATION);
      setDemoTime(time);
      setHudDemoTime(time);
      setDemoPaused(true);
      return;
    }
    const range = liveRangeRef.current;
    const lo = range.start ?? value;
    const hi = Math.max(lo, range.end ?? value);
    setLiveFollow(false);
    setLiveSeek(clamp(value, lo, hi));
  }, []);

  const handleToggleDemoPlay = useCallback(() => {
    if (demoPaused) {
      if (demoTimeRef.current >= DEMO_DURATION) {
        setDemoTime(0);
        setHudDemoTime(0);
        setDemoPaused(false);
      } else {
        setDemoPaused(false);
      }
    } else {
      setDemoPaused(true);
    }
  }, [demoPaused]);

  const handleRestartDemo = useCallback(() => {
    setDemoTime(0);
    setHudDemoTime(0);
    setDemoPaused(false);
  }, []);

  const handleDemoRate = useCallback((rate: Rate) => setDemoRate(rate), []);

  const handleToggleLiveFollow = useCallback(() => {
    if (liveFollowRef.current) {
      const range = liveRangeRef.current;
      const at = clamp(clockRef.current, range.start ?? 0, range.end ?? clockRef.current);
      setLiveSeek(at);
      setLiveFollow(false);
    } else {
      setLiveFollow(true);
      setLiveSeek(null);
    }
  }, []);

  const handleReturnToLive = useCallback(() => {
    setLiveFollow(true);
    setLiveSeek(null);
  }, []);

  const handleToggleCollapse = useCallback(
    () => setTimelineCollapsed((collapsed) => !collapsed),
    []
  );
  const handleToggleFilters = useCallback(() => setFiltersOpen((open) => !open), []);
  const handleToggleLabels = useCallback(() => setLabels((value) => !value), []);
  const handleToggleHelp = useCallback(() => setHelpOpen((open) => !open), []);
  const handleOpenDrawer = useCallback(() => setDrawerOpen(true), []);
  const handleCloseDrawer = useCallback(() => setDrawerOpen(false), []);
  const handleCloseInspector = useCallback(() => setInspectorOpen(false), []);
  const handleOpenInspector = useCallback(() => setInspectorOpen(true), []);
  const handleClearSelection = useCallback(() => {
    setSelectedId(null);
    setFilterNotice(null);
    setInspectorOpen(true);
  }, []);
  const handleToggleType = useCallback((type: NodeType) => {
    setFilterNotice(null);
    setTypeFilter((previous) => {
      const next = new Set(previous);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);
  const handleStatusFilterChange = useCallback((value: NodeStatus | 'all') => {
    setStatusFilter(value);
    setFilterNotice(null);
  }, []);
  const handleAgentFilterChange = useCallback((value: string) => {
    setAgentFilter(value);
    setFilterNotice(null);
  }, []);
  const handleDrawerSelect = useCallback(
    (id: string) => selectNode(id, false),
    [selectNode]
  );

  const handleCopy = useCallback(
    async (kind: string, text: string) => {
      try {
        const ok = await copyText(text);
        showToast(ok ? `${kind}已复制` : '复制失败：剪贴板不可用', ok ? 'info' : 'error');
      } catch {
        showToast('复制失败：剪贴板不可用', 'error');
      }
    },
    [showToast]
  );

  const handleDownloadEvents = useCallback(() => {
    const events = hudGraphRef.current.events;
    if (events.length === 0) {
      showToast('当前没有可导出的事件', 'error');
      return;
    }
    try {
      const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `agent-events-${Date.now()}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`已导出 ${events.length} 条事件`);
    } catch {
      showToast('导出事件失败', 'error');
    }
  }, [showToast]);

  const handleToggleFullscreen = useCallback(async () => {
    const element = mainRef.current;
    if (!element) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (typeof element.requestFullscreen === 'function') {
        await element.requestFullscreen();
      } else {
        showToast('当前环境不支持全屏', 'error');
      }
    } catch {
      showToast('全屏请求被浏览器拒绝', 'error');
    }
  }, [showToast]);

  const handleInspectorFocus = useCallback(() => {
    const id = uiRef.current.selectedId ?? uiRef.current.rootId;
    if (id) sendCamera('focus', id);
  }, [sendCamera]);

  const handleFocusNode = useCallback((id: string) => selectNode(id, true), [selectNode]);
  const handleToggleBranch = useCallback((id: string) => {
    setCollapsedAgents((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const handleToggleDensity = useCallback(
    () => setDensity((current) => (current === 'smart' ? 'all' : 'smart')),
    []
  );

  const handleFocusCore = useCallback(() => {
    const id = rootIdRef.current;
    if (id) sendCamera('focus', id);
  }, [sendCamera]);

  // ─── 派生可视化数据 ─────────────────────────────────────

  const layout = useMemo<SceneLayout>(() => layoutRef.current.build(sceneGraph), [sceneGraph]);
  const pathIds = useMemo(() => executionPath(sceneGraph, selectedId), [sceneGraph, selectedId]);

  const visibility = useMemo(() => {
    const candidates = new Set<string>();
    for (const node of Object.values(sceneGraph.nodes)) {
      if (!nodePasses(node, sceneGraph, filters)) continue;
      const collapsed = [...collapsedAgents].some((id) => id !== node.id && isDescendantOf(node, id, sceneGraph));
      if (!collapsed) candidates.add(node.id);
    }
    const ids = new Set(candidates);
    let hidden = 0;

    if (density === 'smart' && candidates.size > 32) {
      ids.clear();
      const branches = new Map<string, ExecutionNode[]>();
      for (const item of layout.nodes) {
        const { node } = item;
        if (!candidates.has(node.id)) continue;
        const mandatory =
          node.type === 'core' ||
          node.type === 'agent' ||
          node.id === selectedId ||
          pathIds.has(node.id) ||
          isActive(node.status) ||
          node.status === 'error' ||
          node.status === 'blocked';
        if (mandatory) {
          ids.add(node.id);
          continue;
        }
        const list = branches.get(item.branchId) ?? [];
        list.push(node);
        branches.set(item.branchId, list);
      }
      for (const nodes of branches.values()) {
        nodes.sort((a, b) => b.sequence - a.sequence || b.id.localeCompare(a.id));
        // 每个分支保留最近真实事件；运行、失败、阻塞与选择路径已在上方永久保留。
        for (const node of nodes.slice(0, 6)) ids.add(node.id);
      }
      // 可见工具的文件制品不因密度策略与父工具断开。
      for (const item of layout.nodes) {
        if (item.node.type === 'file' && item.node.parentId && ids.has(item.node.parentId) && candidates.has(item.node.id)) {
          ids.add(item.node.id);
        }
      }
      for (const id of candidates) if (!ids.has(id)) hidden++;
    }

    if (selectedId && sceneGraph.nodes[selectedId]) ids.add(selectedId);
    for (const id of pathIds) if (sceneGraph.nodes[id]) ids.add(id);
    return { ids, hidden };
  }, [sceneGraph, filters, collapsedAgents, density, layout, selectedId, pathIds]);
  const visibleIds = visibility.ids;
  const sceneQuality: Exclude<Quality, 'auto'> =
    quality === 'auto' ? (layout.nodes.length > 160 ? 'low' : layout.nodes.length > 72 ? 'balanced' : 'high') : quality;

  // ─── 键盘 ───────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (uiRef.current.helpOpen) {
          setHelpOpen(false);
          return;
        }
        if (uiRef.current.drawerOpen) {
          setDrawerOpen(false);
          return;
        }
        if (uiRef.current.selectedId) {
          setSelectedId(null);
          return;
        }
        if (uiRef.current.inspectorOpen) setInspectorOpen(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setPaused((value) => !value);
      } else if (event.key === 'r' || event.key === 'R') {
        sendCamera('reset');
      } else if (event.key === 'f' || event.key === 'F') {
        const id = uiRef.current.selectedId ?? uiRef.current.rootId;
        if (id) sendCamera('focus', id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sendCamera]);

  // ─── 展示值 ─────────────────────────────────────────────

  const startLabel = timelineStart == null ? '—' : formatAxisTime(0);
  const endLabel =
    timelineStart == null || timelineEnd == null ? '—' : formatAxisTime(timelineEnd - timelineStart);
  const timeLabel =
    timelineStart == null ? '—' : formatAxisTime(Math.max(0, timelineTime - timelineStart));
  const seekMin = timelineStart ?? 0;
  const seekMax = timelineEnd ?? 0;
  const seekValue = clamp(timelineTime, seekMin, Math.max(seekMin, seekMax));
  const isDemoEnded = mode === 'demo' && demoTime >= DEMO_DURATION;
  const isLiveEmpty = mode === 'live' && baseLive.events.length === 0;
  const runStatusLabel =
    mode === 'demo'
      ? isDemoEnded
        ? '演示结束'
        : demoPaused
          ? '演示暂停'
          : '演示播放'
      : !hasData
        ? '等待事件'
        : NODE_STATUSES[hudGraph.status]?.label ?? '状态未知';
  const runStatus =
    mode === 'demo'
      ? demoPaused
        ? 'paused'
        : isDemoEnded
          ? 'completed'
          : 'running'
      : hasData
        ? hudGraph.status
        : 'unknown';
  const scene = (
    <AgentScene
      graph={sceneGraph}
      layout={layout}
      visibleIds={visibleIds}
      selectedId={selectedId}
      pathIds={pathIds}
      paused={paused}
      quality={sceneQuality}
      labels={labels}
      cameraCommand={cameraCommand}
      onSelect={handleSceneSelect}
      onTelemetry={handleTelemetry}
      onFailure={handleSceneFailure}
      onHover={handleHover}
    />
  );

  return (
    <div className="agent-space">
      <Rail
        onChat={hideAgentSpace}
        onFocusCore={handleFocusCore}
        onToggleDrawer={drawerOpen ? handleCloseDrawer : handleOpenDrawer}
        onToggleHelp={handleToggleHelp}
        drawerOpen={drawerOpen}
        helpOpen={helpOpen}
        nodeCount={Object.keys(hudGraph.nodes).length}
      />

      <main className="acs-main" ref={mainRef}>
        <header className="acs-header">
          <div className="acs-header-left">
            <div className="acs-title-block">
              <h1>Agent 执行空间</h1>
              <span className="acs-subtitle">CLAUDE CODE / EXECUTION OBSERVATORY</span>
            </div>

            <label className="acs-conv-select">
              <span>会话</span>
              <select
                value={activeConversationId}
                onChange={(event) => setActiveConversation(event.currentTarget.value)}
                disabled={mode === 'demo'}
                aria-label="选择会话"
                title={mode === 'demo' ? 'DEMO 固定使用示例会话，不读取当前会话事件' : '选择会话'}
              >
                {conversations.length === 0 && <option value="">无会话</option>}
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title || '未命名会话'}
                  </option>
                ))}
              </select>
            </label>

            <div className="acs-mode-switch" role="group" aria-label="数据源">
              <button
                type="button"
                aria-pressed={mode === 'live'}
                onClick={() => setMode('live')}
                title="只显示 Claude Code 实时 / 历史事件；未收到事件时保持空场"
              >
                实时
              </button>
              <button
                type="button"
                aria-pressed={mode === 'demo'}
                onClick={() => setMode('demo')}
                title="使用固定示例事件流，不代表真实 Claude 执行"
              >
                演示
              </button>
            </div>

            {mode === 'demo' && <span className="acs-demo-badge">DEMO · 模拟执行数据</span>}
          </div>

          <div className="acs-header-right">
            <span className="acs-run-status" data-status={runStatus}>
              <span className="acs-status-dot" />
              {runStatusLabel}
            </span>
            <button
              type="button"
              className="acs-icon-btn"
              aria-pressed={paused}
              onClick={() => setPaused((value) => !value)}
              aria-label={paused ? '继续三维动画' : '暂停三维动画'}
              title={paused ? '继续三维动画（Space）' : '暂停三维动画，事件与回放不受影响（Space）'}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
            </button>
            <button
              type="button"
              className="acs-icon-btn"
              aria-pressed={isFullscreen}
              onClick={handleToggleFullscreen}
              aria-label={isFullscreen ? '退出全屏' : '进入全屏'}
              title={isFullscreen ? '退出全屏' : '进入全屏'}
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </header>

        <StatsBar
          agents={formatCount(stats.agents)}
          tools={formatCount(stats.tools)}
          files={formatCount(stats.files)}
          running={formatCount(stats.running)}
          inputTokens={formatCount(metrics.inputTokens)}
          outputTokens={formatCount(metrics.outputTokens)}
          cacheTokens={formatCount(metrics.cacheTokens)}
          costText={formatCost(metrics.costUsd)}
          hasData={hasData}
        />

        <div className="acs-subbar">
          <span className="acs-project" title={projectLabel}>
            {hudGraph.title || activeMeta?.title || '未命名执行'} · {projectLabel}
          </span>
          <div className="acs-subbar-right">
            <span className={`acs-source-badge ${source}`}>
              {source === 'history' ? 'HISTORICAL' : source === 'demo' ? 'DEMO' : 'LIVE'}
            </span>
            <span className="acs-bridge-badge" data-connected={hasBridge}>
              {hasBridge ? 'Electron · CLI 桥已接入' : '浏览器预览 · 未连接 Claude CLI'}
            </span>
            {mode === 'demo' && (
              <span className="acs-demo-footnote">示例任务与用量，不代表真实 Claude 执行</span>
            )}
          </div>
        </div>

        <div className="acs-stage">
          <div className="acs-canvas-wrap">
            <div className="acs-canvas">
              <SceneBoundary key={sceneKey} onFailure={handleSceneFailure} fallback={null}>
                {scene}
              </SceneBoundary>
            </div>

            <div className="acs-overlay">
              <div className="acs-stage-left">
                <div className="acs-topology-card">
                  <div className="acs-topology-head">
                    <span className="acs-topology-title">神经执行拓扑</span>
                    <span className="acs-topology-source">{source.toUpperCase()}</span>
                  </div>
                  <p className="acs-topology-task" title={currentTask}>
                    {currentTask}
                  </p>
                  {hoveredNode && (
                    <p className="acs-topology-hover" style={{ color: nodeColor(hoveredNode) }}>
                      {hoveredNode.label} · {NODE_STATUSES[hoveredNode.status].label}
                    </p>
                  )}
                  {layout.groups.length > 0 && (
                    <div className="acs-branch-section">
                      <div className="acs-branch-head">
                        <span><GitBranch size={11} />执行分支</span>
                        <button
                          type="button"
                          className="acs-density-btn"
                          aria-pressed={density === 'all'}
                          onClick={handleToggleDensity}
                          title="智能密度保留活跃、异常、选择路径及每分支最近 6 个节点"
                        >
                          {density === 'smart' ? '智能密度' : '全部节点'}
                        </button>
                      </div>
                      <div className="acs-branch-list">
                        {layout.groups.map((group) => {
                          const isAgent = hudGraph.nodes[group.id]?.type === 'agent';
                          const collapsed = collapsedAgents.has(group.id);
                          const activeCount = group.nodeIds.filter((id) => {
                            const node = hudGraph.nodes[id];
                            return node ? isActive(node.status) : false;
                          }).length;
                          return (
                            <div className="acs-branch-row" key={group.id} data-collapsed={collapsed}>
                              <button
                                type="button"
                                className="acs-branch-focus"
                                onClick={() => (isAgent ? handleFocusNode(group.id) : sendCamera('focus', group.id))}
                                title={`聚焦 ${group.label}`}
                              >
                                <i style={{ background: group.color }} />
                                <span>{group.label}</span>
                                <b>{activeCount > 0 ? `${activeCount} 活跃` : group.nodeIds.length}</b>
                              </button>
                              {isAgent && (
                                <button
                                  type="button"
                                  className="acs-branch-collapse"
                                  aria-pressed={collapsed}
                                  aria-label={`${collapsed ? '展开' : '折叠'} ${group.label}`}
                                  title={collapsed ? '展开此分支' : '折叠此分支，位置保持稳定'}
                                  onClick={() => handleToggleBranch(group.id)}
                                >
                                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {visibility.hidden > 0 && (
                        <button type="button" className="acs-hidden-nodes" onClick={() => setDensity('all')}>
                          <Eye size={11} />另有 {visibility.hidden} 个历史节点已聚合，点击查看全部
                        </button>
                      )}
                      {collapsedAgents.size > 0 && (
                        <button type="button" className="acs-hidden-nodes" onClick={() => setCollapsedAgents(new Set())}>
                          <EyeOff size={11} />{collapsedAgents.size} 个分支已折叠，点击全部展开
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className={filtersOpen ? 'acs-filter-panel' : 'acs-filter-panel is-collapsed'}>
                  <div className="acs-filter-head">
                    <button
                      type="button"
                      className="acs-filter-toggle"
                      onClick={handleToggleFilters}
                      aria-expanded={filtersOpen}
                      aria-label={filtersOpen ? '收起筛选' : '展开筛选'}
                    >
                      <SlidersHorizontal size={12} />
                      筛选
                      {filtersOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {filtersOpen && (
                      <button type="button" className="acs-text-btn acs-text-btn-small" onClick={resetFilters}>
                        清除
                      </button>
                    )}
                  </div>
                  {filtersOpen && (
                    <>
                      <div className="acs-type-chips">
                        {TYPE_LIST.map((type) => (
                          <button
                            type="button"
                            key={type}
                            className="acs-type-chip"
                            aria-pressed={typeFilter.has(type)}
                            onClick={() => handleToggleType(type)}
                            title={`切换 ${NODE_TYPES[type].label} 过滤`}
                          >
                            <TypeGlyph type={type} size={9} />
                            {NODE_TYPES[type].label}
                            <span className="acs-chip-count">{typeCounts[type]}</span>
                          </button>
                        ))}
                      </div>
                      <div className="acs-filter-selects">
                        <label>
                          <span>状态</span>
                          <select
                            value={statusFilter}
                            onChange={(event) =>
                              handleStatusFilterChange(event.currentTarget.value as NodeStatus | 'all')
                            }
                            aria-label="按状态筛选"
                          >
                            <option value="all">全部状态</option>
                            {(Object.keys(NODE_STATUSES) as NodeStatus[]).map((status) => (
                              <option key={status} value={status}>
                                {NODE_STATUSES[status].label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Agent</span>
                          <select
                            value={agentFilter}
                            onChange={(event) => handleAgentFilterChange(event.currentTarget.value)}
                            aria-label="按 Agent 筛选"
                          >
                            <option value="all">全部 Agent</option>
                            {agentOptions.map((agent) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {filterNoticeText && <p className="acs-filter-notice">{filterNoticeText}</p>}
                    </>
                  )}
                </div>
              </div>

              {!inspectorOpen && (
                <div className="acs-scene-actions">
                  <button
                    type="button"
                    className="acs-icon-btn acs-float-btn"
                    onClick={handleOpenInspector}
                    aria-label="打开 Inspector"
                    title="打开 Inspector"
                  >
                    <PanelRightOpen size={14} />
                  </button>
                </div>
              )}

              <div className="acs-legend">
                <TypeLegend />
                <p className="acs-note">拖拽旋转 · 滚轮缩放 · 平移视角</p>
                <p className="acs-note">空间晶格为视觉载体，执行节点与连线来自事件</p>
              </div>

              <div className="acs-scene-settings" role="group" aria-label="场景设置">
                <div className="acs-settings-row">
                  <Gauge size={11} />
                  <select
                    value={quality}
                    onChange={(event) => setQuality(event.currentTarget.value as Quality)}
                    aria-label="渲染质量"
                    title="渲染质量"
                  >
                    <option value="auto">自动</option>
                    <option value="high">高</option>
                    <option value="balanced">均衡</option>
                    <option value="low">低</option>
                  </select>
                </div>
                <div className="acs-settings-row">
                  <button
                    type="button"
                    className="acs-tiny-btn"
                    aria-pressed={labels}
                    onClick={handleToggleLabels}
                    title="切换节点标签"
                  >
                    标签
                  </button>
                  <button
                    type="button"
                    className="acs-icon-btn acs-icon-btn-small"
                    onClick={() => sendCamera('top')}
                    aria-label="俯视视角"
                    title="俯视视角"
                  >
                    <Crosshair size={12} />
                  </button>
                  <button
                    type="button"
                    className="acs-icon-btn acs-icon-btn-small"
                    onClick={() => sendCamera('reset')}
                    aria-label="重置视角"
                    title="重置视角（R）"
                  >
                    <RotateCcw size={12} />
                  </button>
                  <button
                    type="button"
                    className="acs-icon-btn acs-icon-btn-small"
                    onClick={() => sendCamera('zoomIn')}
                    aria-label="放大"
                    title="放大"
                  >
                    <ZoomIn size={12} />
                  </button>
                  <button
                    type="button"
                    className="acs-icon-btn acs-icon-btn-small"
                    onClick={() => sendCamera('zoomOut')}
                    aria-label="缩小"
                    title="缩小"
                  >
                    <ZoomOut size={12} />
                  </button>
                </div>
                <div className="acs-telemetry" title={telemetry.renderer ?? '等待场景上报'}>
                  FPS {telemetry.fps != null ? Math.round(telemetry.fps) : '—'} · TRI{' '}
                  {telemetry.triangles != null ? formatCount(telemetry.triangles) : '—'} · DC{' '}
                  {telemetry.drawCalls != null ? formatCount(telemetry.drawCalls) : '—'}
                </div>
              </div>

              {isLiveEmpty && (
                <div className="acs-empty">
                  <p className="acs-empty-title">等待 Claude Code 执行事件</p>
                  <p className="acs-empty-sub">
                    该会话尚未收到可绘制的 Agent / 工具事件。空间只显示空闲核心，不填充模拟节点。
                  </p>
                  <div className="acs-empty-actions">
                    <button type="button" className="acs-primary-btn" onClick={hideAgentSpace}>
                      返回对话开始任务
                    </button>
                    <button type="button" className="acs-text-btn" onClick={() => setMode('demo')}>
                      进入 DEMO
                    </button>
                  </div>
                </div>
              )}

              {sceneFailure && (
                <div className="acs-failure" role="alert">
                  <h2>三维场景不可用</h2>
                  <p className="acs-failure-reason acs-mono">{sceneFailure}</p>
                  <p>
                    已停止三维渲染；HUD、节点列表与事件仍可用。不会用二维假 3D 替代。
                  </p>
                  <div className="acs-failure-actions">
                    <button type="button" className="acs-primary-btn" onClick={handleRetryScene}>
                      重试三维场景
                    </button>
                    <button type="button" className="acs-text-btn" onClick={handleOpenDrawer}>
                      打开节点列表
                    </button>
                  </div>
                  <h3>可访问节点回退</h3>
                  <ul className="acs-failure-list">
                    {sortedNodes(hudGraph).slice(0, 8).map((node) => (
                      <li key={node.id}>
                        <button
                          type="button"
                          onClick={() => selectNode(node.id, true)}
                          aria-label={`选择节点 ${node.label}`}
                        >
                          <TypeGlyph type={node.type} size={10} />
                          <span>{node.label}</span>
                          <span style={{ color: NODE_STATUSES[node.status].color }}>
                            {NODE_STATUSES[node.status].label}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {inspectorOpen && (
            <InspectorPanel
              node={missingSelection ? null : selectedNode}
              missingSelection={missingSelection}
              mode={mode}
              graphStart={timelineStart}
              eventCount={hudGraph.events.length}
              filterNote={filterNoticeText}
              onClose={handleCloseInspector}
              onClearSelection={handleClearSelection}
              onFocus={handleInspectorFocus}
              onCopy={handleCopy}
              onDownload={handleDownloadEvents}
              onOpenDrawer={handleOpenDrawer}
            />
          )}
        </div>

        <section
          className={timelineCollapsed ? 'acs-timeline is-collapsed' : 'acs-timeline'}
          aria-label="执行时间线"
        >
          <header className="acs-timeline-head">
            <button
              type="button"
              className="acs-icon-btn"
              onClick={handleToggleCollapse}
              aria-label={timelineCollapsed ? '展开时间线' : '收起时间线'}
              title={timelineCollapsed ? '展开时间线' : '收起时间线'}
            >
              {timelineCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            <span className="acs-timeline-title">
              <Activity size={11} />
              执行时间线
            </span>
            <span className={`acs-source-badge ${source}`}>
              {source === 'history' ? 'HISTORY' : source === 'demo' ? 'DEMO' : 'LIVE'}
            </span>

            <div className="acs-timeline-controls">
              {mode === 'demo' ? (
                <>
                  <button
                    type="button"
                    className="acs-icon-btn"
                    onClick={handleToggleDemoPlay}
                    aria-label={demoPaused ? '播放演示' : '暂停演示'}
                    title={demoPaused ? '播放演示' : '暂停演示'}
                  >
                    {demoPaused ? <Play size={13} /> : <Pause size={13} />}
                  </button>
                  <button
                    type="button"
                    className="acs-icon-btn"
                    onClick={handleRestartDemo}
                    aria-label="从 0 重新播放"
                    title="从 0 重新播放"
                  >
                    <SkipBack size={13} />
                  </button>
                  <div className="acs-rate" role="group" aria-label="演示速度">
                    {([0.5, 1, 2] as Rate[]).map((rate) => (
                      <button
                        type="button"
                        key={rate}
                        aria-pressed={demoRate === rate}
                        onClick={() => handleDemoRate(rate)}
                        title={`播放速度 ${rate}×`}
                      >
                        {rate}×
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className="acs-tiny-btn"
                  onClick={liveFollow ? handleToggleLiveFollow : handleReturnToLive}
                  aria-pressed={!liveFollow}
                  disabled={!hasTimeline}
                  title={!hasTimeline ? '尚无执行事件' : liveFollow ? '切到回放' : '返回实时跟随'}
                >
                  {liveFollow ? '回放' : '返回实时'}
                </button>
              )}
            </div>

            <div className="acs-seek-wrap">
              <label className="acs-seek-label" htmlFor="acs-seek">
                回放时间
              </label>
              <span className="acs-time-readout">{startLabel}</span>
              <input
                id="acs-seek"
                className="acs-seek"
                type="range"
                min={seekMin}
                max={Math.max(seekMin + 1, seekMax)}
                step={100}
                value={seekValue}
                onChange={(event) => handleSeek(Number(event.currentTarget.value))}
                aria-label="回放时间"
                disabled={!hasTimeline}
              />
              <span className="acs-time-readout">{endLabel}</span>
              <span className="acs-time-readout acs-time-current">{timeLabel}</span>
            </div>

            {mode === 'demo' && (
              <span className="acs-demo-footnote">示例任务与用量，不代表真实 Claude 执行</span>
            )}
          </header>

          {!timelineCollapsed && (
            <div className="acs-timeline-body">
              {hasTimeline ? (
                <TimelineChart
                  lanes={lanes}
                  ticks={chartEvents}
                  start={timelineStart ?? 0}
                  end={timelineEnd ?? 0}
                />
              ) : (
                <div className="acs-timeline-empty">尚无真实执行事件，时间线保持空白。</div>
              )}
              <TimelineEvents
                events={recentEvents}
                start={timelineStart ?? 0}
                total={hudGraph.events.length}
                onSelect={handleEventSelect}
              />
            </div>
          )}
        </section>

        {drawerOpen && (
          <>
            <div className="acs-drawer-backdrop" onClick={handleCloseDrawer} aria-hidden="true" />
            <NodeDrawer
              items={drawerFiltered.items}
              total={drawerFiltered.total}
              query={query}
              selectedId={selectedId}
              onQuery={setQuery}
              onSelect={handleDrawerSelect}
              onFocus={handleFocusNode}
              onClose={handleCloseDrawer}
            />
          </>
        )}

        {helpOpen && (
          <div className="acs-modal-backdrop" onClick={() => setHelpOpen(false)}>
            <div
              className="acs-modal"
              role="dialog"
              aria-modal="true"
              aria-label="帮助与真实信息边界"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="acs-modal-head">
                <h2>执行空间说明</h2>
                <button
                  type="button"
                  className="acs-icon-btn"
                  onClick={() => setHelpOpen(false)}
                  aria-label="关闭帮助"
                  title="关闭帮助"
                >
                  <X size={15} />
                </button>
              </header>
              <div className="acs-help-sections">
                <section>
                  <h3>数据源</h3>
                  <p>LIVE 只显示 Claude Code 的实时 / 历史事件。未收到事件时保留空闲核心，不填充伪造节点。</p>
                  <p>DEMO 使用固定示例事件流；HISTORICAL 标记从已有会话消息回填的历史图。</p>
                  <p>浏览器预览没有 Electron preload 桥，会明确显示“未连接 Claude CLI”。</p>
                </section>
                <section>
                  <h3>交互</h3>
                  <p>拖拽旋转、滚轮缩放、平移视角。节点可点击；选择后仅突出真实上下游，Inspector 可聚焦。Space 只暂停三维动画，不暂停事件或回放。</p>
                  <p>分支按钮可折叠 / 展开；智能密度保留活跃、异常和选择路径。密集图中的历史依赖在选择节点后恢复显示。</p>
                  <p>时间线按真实 startedAt / 事件 timestamp 绘制；拖动“回放时间”会进入历史视图，LIVE 可点“返回实时”。</p>
                </section>
                <section>
                  <h3>真实信息边界</h3>
                  <p>Tokens / 成本来自 usage / result，未知显示 —，不从 usage 推算上下文占用。</p>
                  <p>文件与输出是工具观测结果，不做操作系统级确认。真实审批在当前执行空间不可操作。</p>
                  <p>下载事件只导出当前回放时刻已收到的事件 JSON。</p>
                </section>
                <section>
                  <h3>快捷键</h3>
                  <p>Space 暂停 / 继续三维动画；R 重置视角；F 聚焦选中节点或核心；Esc 关闭帮助、节点列表、详情与 Inspector，不关闭应用。</p>
                </section>
              </div>
              <footer className="acs-modal-foot">
                <button type="button" className="acs-primary-btn" onClick={() => setHelpOpen(false)}>
                  关闭
                </button>
              </footer>
            </div>
          </div>
        )}

        {toast && (
          <div className="acs-toast" data-tone={toast.tone} role="status">
            {toast.text}
          </div>
        )}
      </main>
    </div>
  );
}
