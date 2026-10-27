import type { ExecutionEdge, ExecutionGraph, ExecutionNode, NodeType } from './types';

export type Position3 = [number, number, number];
export type ExecutionLane = 'core' | 'agent' | 'operation' | 'artifact' | 'task';

export interface PositionedNode {
  node: ExecutionNode;
  position: Position3;
  scale: number;
  /** 顶层子 Agent；主 Agent 直接执行的节点归属 core id。 */
  branchId: string;
  /** 由父子、调用、依赖与重试边计算的最长路径层级。 */
  level: number;
  lane: ExecutionLane;
  /** 分支固定方向；任务轨节点也保留其真实分支归属。 */
  angle: number;
  sector: number;
}

export interface SceneGroup {
  id: string;
  label: string;
  angle: number;
  color: string;
  nodeIds: string[];
  maxRadius: number;
}

export interface SceneLayout {
  nodes: PositionedNode[];
  byId: Map<string, PositionedNode>;
  edges: ExecutionEdge[];
  groups: SceneGroup[];
  radius: number;
  center: Position3;
  size: Position3;
}

interface Slot {
  position: Position3;
  branchId: string;
  level: number;
  lane: ExecutionLane;
  angle: number;
  sector: number;
  type: NodeType;
}

const DEG = Math.PI / 180;
const ROOT_ANGLE = 90 * DEG;
// 先占远端对角，再补中间方向；新增 Agent 不挤压已有分支。
const BRANCH_ANGLES = [
  150, 30, 210, 330, 120, 240, 60, 300,
  15, 195, 105, 285, 45, 225, 135, 315,
  75, 255, 165, 345, 0, 180, 135 + 180, 270,
].map((degrees) => degrees * DEG);
const TASK_OFFSETS = [0, -2.7, 2.7, -5.4, 5.4, -8.1, 8.1];
const SCALES: Record<NodeType, number> = {
  core: 2.8,
  agent: 0.82,
  tool: 0.5,
  file: 0.46,
  task: 0.46,
  error: 0.58,
};

export function hashId(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function distance(a: Position3, b: Position3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function polar(radius: number, angle: number, y: number): Position3 {
  return [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
}

/**
 * 稳定、关系驱动的执行布局。
 *
 * - 顶层 Agent 拥有永久扇区，工具沿该分支的真实 DAG 层级向外展开。
 * - 同层节点并排，不把没有依赖的并行调用伪造成串行链。
 * - 文件位于制品层，任务位于独立前轨；过滤和状态变化不参与坐标计算。
 * - 每个节点只分配一次槽位；后续事件只能新增节点，不能推动整个场景重排。
 */
export class StableExecutionLayout {
  private slots = new Map<string, Slot>();
  private conversationId = '';
  private assigned = new Map<string, number>();
  private branchSectors = new Map<string, number>();

  clear(): void {
    this.slots.clear();
    this.assigned.clear();
    this.branchSectors.clear();
    this.conversationId = '';
  }

  private next(key: string): number {
    const value = this.assigned.get(key) ?? 0;
    this.assigned.set(key, value + 1);
    return value;
  }

  private rootId(graph: ExecutionGraph): string {
    return Object.values(graph.nodes).find((node) => node.type === 'core')?.id ?? `core:${graph.conversationId}`;
  }

  private isTopLevelAgent(node: ExecutionNode, graph: ExecutionGraph): boolean {
    if (node.type !== 'agent') return false;
    const parent = node.parentId ? graph.nodes[node.parentId] : undefined;
    return !parent || parent.type !== 'agent';
  }

  private branchOf(node: ExecutionNode, graph: ExecutionGraph, rootId: string): string {
    let current: ExecutionNode | undefined = node;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (this.isTopLevelAgent(current, graph)) return current.id;
      seen.add(current.id);
      current = current.parentId ? graph.nodes[current.parentId] : undefined;
    }
    return rootId;
  }

  private allocateBranches(graph: ExecutionGraph, rootId: string): void {
    const agents = Object.values(graph.nodes)
      .filter((node) => this.isTopLevelAgent(node, graph))
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    for (const agent of agents) {
      if (this.branchSectors.has(agent.id)) continue;
      const used = new Set(this.branchSectors.values());
      let sector = 0;
      while (used.has(sector)) sector++;
      this.branchSectors.set(agent.id, sector);
    }
    if (!this.branchSectors.has(rootId)) this.branchSectors.set(rootId, -1);
  }

  private branchAngle(branchId: string, rootId: string): number {
    if (branchId === rootId) return ROOT_ANGLE;
    const sector = this.branchSectors.get(branchId) ?? 0;
    return BRANCH_ANGLES[sector % BRANCH_ANGLES.length] + Math.floor(sector / BRANCH_ANGLES.length) * (7 * DEG);
  }

  private branchRadius(branchId: string, rootId: string): number {
    if (branchId === rootId) return 7.8;
    const sector = Math.max(0, this.branchSectors.get(branchId) ?? 0);
    return 7.8 + Math.floor(sector / 8) * 4;
  }

  private levels(graph: ExecutionGraph, rootId: string): Map<string, number> {
    const incoming = new Map<string, ExecutionEdge[]>();
    for (const edge of Object.values(graph.edges)) {
      if (edge.kind === 'read' || edge.kind === 'write') continue;
      const list = incoming.get(edge.target) ?? [];
      list.push(edge);
      incoming.set(edge.target, list);
    }
    const result = new Map<string, number>();
    const visiting = new Set<string>();
    const resolve = (node: ExecutionNode): number => {
      if (node.type === 'core' || node.id === rootId) return 0;
      const cached = result.get(node.id);
      if (cached !== undefined) return cached;
      if (visiting.has(node.id)) return 1; // 畸形环只影响当前层级，不制造额外边或无限递归。
      visiting.add(node.id);
      let level = this.isTopLevelAgent(node, graph) ? 0 : 1;
      if (!this.isTopLevelAgent(node, graph)) {
        const parent = node.parentId ? graph.nodes[node.parentId] : undefined;
        if (parent) {
          const parentLevel = resolve(parent);
          level = Math.max(level, node.type === 'file' ? parentLevel : parentLevel + 1);
        }
        for (const edge of incoming.get(node.id) ?? []) {
          const source = graph.nodes[edge.source];
          if (!source || source.id === node.id) continue;
          level = Math.max(level, resolve(source) + 1);
        }
      }
      visiting.delete(node.id);
      result.set(node.id, Math.min(64, level));
      return result.get(node.id)!;
    };
    for (const node of Object.values(graph.nodes)) resolve(node);
    return result;
  }

  private collides(node: ExecutionNode, candidate: Position3): boolean {
    const scale = SCALES[node.type];
    for (const [id, other] of this.slots) {
      if (id === node.id) continue;
      const required = (scale + SCALES[other.type]) * 1.55 + 0.35;
      if (distance(candidate, other.position) < required) return true;
    }
    return false;
  }

  private constrain(node: ExecutionNode, candidate: Position3, angle: number): Position3 {
    let next = candidate;
    // 碰撞只在同一分支径向解决，不跳扇区、不使用随机坐标。
    for (let attempt = 0; attempt < 96 && this.collides(node, next); attempt++) {
      const radius = Math.hypot(next[0], next[2]) + 1.65;
      next = polar(radius, angle, next[1]);
    }
    return next;
  }

  private place(node: ExecutionNode, graph: ExecutionGraph, rootId: string, levelMap: Map<string, number>): Slot {
    const branchId = this.branchOf(node, graph, rootId);
    const sector = branchId === rootId ? -1 : this.branchSectors.get(branchId) ?? 0;
    const angle = this.branchAngle(branchId, rootId);
    const level = levelMap.get(node.id) ?? 1;
    const baseRadius = this.branchRadius(branchId, rootId);
    let lane: ExecutionLane = 'operation';
    let position: Position3;

    if (node.type === 'core') {
      lane = 'core';
      position = [0, 2.1, 0];
    } else if (this.isTopLevelAgent(node, graph)) {
      lane = 'agent';
      position = polar(baseRadius, angle, 0.8);
    } else if (node.type === 'task') {
      lane = 'task';
      const slot = this.next('task-rail');
      const row = Math.floor(slot / TASK_OFFSETS.length);
      position = [TASK_OFFSETS[slot % TASK_OFFSETS.length], -2.35, 7.2 + row * 2.65];
    } else if (node.type === 'file') {
      lane = 'artifact';
      const parent = node.parentId ? this.slots.get(node.parentId) : undefined;
      const fileSlot = this.next(`artifact:${node.parentId ?? branchId}`);
      const parentRadius = parent ? Math.hypot(parent.position[0], parent.position[2]) : baseRadius + Math.max(1, level) * 3.5;
      const parentAngle = parent?.angle ?? angle;
      const direction = fileSlot % 2 === 0 ? 1 : -1;
      position = polar(parentRadius + 1.55 + Math.floor(fileSlot / 2) * 1.25, parentAngle + direction * 0.1, -2.05);
    } else {
      lane = 'operation';
      const slot = this.next(`operation:${branchId}:${level}`);
      const column = slot % 3;
      const row = Math.floor(slot / 3);
      const spread = sector >= 8 ? 0.13 : 0.22;
      const operationAngle = angle + (column - 1) * spread;
      // 每四层形成一个高度带：深 DAG 仍向外表达方向，但不会无限扩张成空旷线团。
      const band = Math.max(0, level - 1) % 4;
      const tier = Math.floor(Math.max(0, level - 1) / 4);
      const radius = baseRadius + 3.4 + band * 3.35 + tier * 1.25 + row * 3.05;
      position = this.constrain(node, polar(radius, operationAngle, tier * 1.55), operationAngle);
    }

    if (node.type !== 'core' && node.type !== 'file') {
      position = this.constrain(node, position, node.type === 'task' ? ROOT_ANGLE : angle);
    }
    return { position, branchId, level, lane, angle, sector, type: node.type };
  }

  build(graph: ExecutionGraph): SceneLayout {
    if (this.conversationId !== graph.conversationId) {
      this.clear();
      this.conversationId = graph.conversationId;
    }
    const ordered = Object.values(graph.nodes).sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    const rootId = this.rootId(graph);
    this.allocateBranches(graph, rootId);
    const levelMap = this.levels(graph, rootId);

    for (const node of ordered) {
      const cached = this.slots.get(node.id);
      if (cached && cached.type === node.type) continue;
      this.slots.set(node.id, this.place(node, graph, rootId, levelMap));
    }

    // 有界保留已消失槽位，保证回放与实时切换不会重新随机排布。
    if (this.slots.size > 560) {
      const alive = new Set(ordered.map((node) => node.id));
      for (const id of this.slots.keys()) if (!alive.has(id)) this.slots.delete(id);
    }

    const nodes = ordered.map((node) => {
      const slot = this.slots.get(node.id)!;
      return {
        node,
        position: slot.position,
        scale: SCALES[node.type],
        branchId: slot.branchId,
        level: slot.level,
        lane: slot.lane,
        angle: slot.angle,
        sector: slot.sector,
      };
    });
    const byId = new Map(nodes.map((item) => [item.node.id, item]));
    const edges = Object.values(graph.edges).filter((edge) => byId.has(edge.source) && byId.has(edge.target));
    const groups = new Map<string, SceneGroup>();
    for (const item of nodes) {
      if (item.node.type === 'core') continue;
      const radius = Math.hypot(item.position[0], item.position[2]);
      const existing = groups.get(item.branchId);
      if (existing) {
        existing.nodeIds.push(item.node.id);
        existing.maxRadius = Math.max(existing.maxRadius, radius + item.scale);
      } else {
        const branch = graph.nodes[item.branchId];
        groups.set(item.branchId, {
          id: item.branchId,
          label: branch?.type === 'agent' ? branch.label : '主 Agent 直接调用',
          angle: item.angle,
          color: branch?.type === 'agent' ? '#a98de8' : '#55d6e8',
          nodeIds: [item.node.id],
          maxRadius: radius + item.scale,
        });
      }
    }

    const min: Position3 = [Infinity, Infinity, Infinity];
    const max: Position3 = [-Infinity, -Infinity, -Infinity];
    for (const item of nodes) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], item.position[axis] - item.scale);
        max[axis] = Math.max(max[axis], item.position[axis] + item.scale);
      }
    }
    if (!nodes.length) {
      min.splice(0, 3, -1, -1, -1);
      max.splice(0, 3, 1, 1, 1);
    }
    const size: Position3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const center: Position3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    return {
      nodes,
      byId,
      edges,
      groups: [...groups.values()],
      radius: Math.max(14, ...nodes.map((item) => Math.hypot(item.position[0], item.position[2]) + item.scale)),
      center,
      size,
    };
  }
}

/** 选择节点时只突出真实上游与下游；不把同分支的无关兄弟节点混入路径。 */
export function executionPath(graph: ExecutionGraph, selectedId: string | null): Set<string> {
  const related = new Set<string>();
  if (!selectedId || !graph.nodes[selectedId]) return related;
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of Object.values(graph.edges)) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  }
  for (const node of Object.values(graph.nodes)) {
    if (!node.parentId) continue;
    outgoing.set(node.parentId, [...(outgoing.get(node.parentId) ?? []), node.id]);
    incoming.set(node.id, [...(incoming.get(node.id) ?? []), node.parentId]);
  }
  const walk = (start: string, edges: Map<string, string[]>) => {
    const queue = [start];
    while (queue.length) {
      const id = queue.shift()!;
      if (related.has(id) && id !== start) continue;
      related.add(id);
      for (const next of edges.get(id) ?? []) if (!related.has(next)) queue.push(next);
    }
  };
  walk(selectedId, incoming);
  walk(selectedId, outgoing);
  return related;
}

export function isDescendantOf(node: ExecutionNode, ancestorId: string, graph: ExecutionGraph): boolean {
  let current = node.parentId ? graph.nodes[node.parentId] : undefined;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === ancestorId) return true;
    seen.add(current.id);
    current = current.parentId ? graph.nodes[current.parentId] : undefined;
  }
  return false;
}

export function belongsToAgent(node: ExecutionNode, agentId: string, graph: ExecutionGraph): boolean {
  if (node.id === agentId || node.type === 'core') return true;
  return isDescendantOf(node, agentId, graph);
}

/** 兼容旧调用名；实现已替换为执行 DAG 布局，不再使用自由轨道散布。 */
export const StableOrbitalLayout = StableExecutionLayout;
