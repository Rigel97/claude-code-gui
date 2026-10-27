import { describe, expect, it } from 'vitest';
import { StableOrbitalLayout, executionPath, belongsToAgent } from '../src/renderer/agent/layout';
import { createGraph, getRootId } from '../src/renderer/agent/model';
import { getDemoGraph, DEMO_INITIAL_TIME } from '../src/renderer/agent/demo';
import { createNeuralGeometry } from '../src/renderer/agent/neuralGeometry';
import type { ExecutionNode } from '../src/renderer/agent/types';

describe('deterministic three-dimensional execution layout', () => {
  it('does not move established nodes when state, filters or later events change', () => {
    const engine = new StableOrbitalLayout();
    const first = engine.build(getDemoGraph(DEMO_INITIAL_TIME));
    const second = engine.build(getDemoGraph(DEMO_INITIAL_TIME + 17000));
    for (const item of first.nodes) {
      expect(second.byId.get(item.node.id)?.position).toEqual(item.position);
    }
    expect(first.byId.get(getRootId(first.nodes[0].node.id))?.position).toBeUndefined();
  });

  it('produces finite, collision-free positions for the demonstration', () => {
    const layout = new StableOrbitalLayout().build(getDemoGraph(DEMO_INITIAL_TIME));
    for (const item of layout.nodes) expect(item.position.every(Number.isFinite)).toBe(true);
    for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i];
      const b = layout.nodes[j];
      const separation = Math.hypot(...a.position.map((value, axis) => value - b.position[axis]));
      expect(separation).toBeGreaterThan((a.scale + b.scale) * 1.4);
    }
    expect(layout.edges.every(edge => layout.byId.has(edge.source) && layout.byId.has(edge.target))).toBe(true);
  });

  it('retains stable positions while rewinding and resuming', () => {
    const engine = new StableOrbitalLayout();
    const full = engine.build(getDemoGraph(118000));
    engine.build(getDemoGraph(15000));
    const resumed = engine.build(getDemoGraph(118000));
    expect(resumed.nodes.map(item => item.position)).toEqual(full.nodes.map(item => item.position));
  });

  it('supports 240 nodes without NaN, jitter or coincident positions', () => {
    const graph = createGraph('large', 'live');
    for (let i = 0; i < 240; i++) {
      const type = i < 12 ? 'agent' : i % 5 === 0 ? 'file' : i % 6 === 0 ? 'task' : 'tool';
      const node: ExecutionNode = { id: `n${i}`, label: `Node ${i}`, type,
        parentId: i < 12 ? getRootId('large') : `n${i % 12}`, sequence: i + 1,
        status: 'running', relatedFiles: [], lastEventAt: 1 };
      graph.nodes[node.id] = node;
    }
    const engine = new StableOrbitalLayout();
    const result = engine.build(graph);
    expect(result.nodes).toHaveLength(241);
    expect(new Set(result.nodes.map(item => item.position.join(':'))).size).toBe(241);
    expect(result.nodes.every(item => item.position.every(Number.isFinite))).toBe(true);
    expect(engine.build({ ...graph, status: 'completed' }).nodes.map(item => item.position)).toEqual(result.nodes.map(item => item.position));
  });

  it('keeps independent tools on the same parallel level and only ranks observed dependencies', () => {
    const graph = createGraph('parallel', 'demo');
    const rootId = getRootId(graph.conversationId);
    const agent: ExecutionNode = { id: 'agent:parallel', label: 'Parallel', type: 'agent', parentId: rootId,
      sequence: 1, status: 'running', relatedFiles: [], lastEventAt: 1 };
    const first: ExecutionNode = { id: 'tool:first', label: 'First', type: 'tool', parentId: agent.id,
      sequence: 2, status: 'running', relatedFiles: [], lastEventAt: 2 };
    const second: ExecutionNode = { id: 'tool:second', label: 'Second', type: 'tool', parentId: agent.id,
      sequence: 3, status: 'running', relatedFiles: [], lastEventAt: 2 };
    Object.assign(graph.nodes, { [agent.id]: agent, [first.id]: first, [second.id]: second });
    graph.edges['e:root-agent'] = { id: 'e:root-agent', source: rootId, target: agent.id, kind: 'delegation', status: 'running' };
    graph.edges['e:agent-first'] = { id: 'e:agent-first', source: agent.id, target: first.id, kind: 'call', status: 'running' };
    graph.edges['e:agent-second'] = { id: 'e:agent-second', source: agent.id, target: second.id, kind: 'call', status: 'running' };
    const parallel = new StableOrbitalLayout().build(graph);
    expect(parallel.byId.get(first.id)?.level).toBe(parallel.byId.get(second.id)?.level);
    expect(parallel.byId.get(first.id)?.position).not.toEqual(parallel.byId.get(second.id)?.position);
    expect(executionPath(graph, first.id).has(second.id)).toBe(false);

    graph.edges['e:first-second'] = { id: 'e:first-second', source: first.id, target: second.id, kind: 'dependency', status: 'running' };
    const serial = new StableOrbitalLayout().build(graph);
    expect(serial.byId.get(second.id)!.level).toBeGreaterThan(serial.byId.get(first.id)!.level);
    expect(executionPath(graph, first.id).has(second.id)).toBe(true);
  });

  it('does not relocate surviving nodes when another branch is added or removed', () => {
    const engine = new StableOrbitalLayout();
    const full = engine.build(getDemoGraph(DEMO_INITIAL_TIME));
    const reducedGraph = getDemoGraph(DEMO_INITIAL_TIME);
    delete reducedGraph.nodes['agent:builder'];
    for (const [id, node] of Object.entries(reducedGraph.nodes)) {
      let current = node.parentId ? reducedGraph.nodes[node.parentId] : undefined;
      while (current) {
        if (current.id === 'agent:builder') {
          delete reducedGraph.nodes[id];
          break;
        }
        current = current.parentId ? reducedGraph.nodes[current.parentId] : undefined;
      }
    }
    reducedGraph.edges = Object.fromEntries(Object.entries(reducedGraph.edges).filter(([, edge]) =>
      reducedGraph.nodes[edge.source] && reducedGraph.nodes[edge.target]));
    const reduced = engine.build(reducedGraph);
    for (const item of reduced.nodes) expect(item.position).toEqual(full.byId.get(item.node.id)?.position);
    const restored = engine.build(getDemoGraph(DEMO_INITIAL_TIME));
    for (const item of restored.nodes) expect(item.position).toEqual(full.byId.get(item.node.id)?.position);
  });

  it('only highlights observed ancestry and dependency / retry relations', () => {
    const graph = getDemoGraph(DEMO_INITIAL_TIME);
    const id = 'tool:retry-test';
    const path = executionPath(graph, id);
    expect(path.has(id)).toBe(true);
    expect(path.has('tool:test-fail')).toBe(true); // retry 边指向失败的上一次运行
    expect(path.has(getRootId(graph.conversationId))).toBe(true);
    expect(path.has('agent:builder')).toBe(false);
    // scout 子链的祖先高亮
    const scoutPath = executionPath(graph, 'tool:test-fail');
    expect(scoutPath.has('agent:scout')).toBe(true);
    expect(scoutPath.has('agent:builder')).toBe(false);
    expect(belongsToAgent(graph.nodes['tool:test-fail'], 'agent:scout', graph)).toBe(true);
    expect(belongsToAgent(graph.nodes['tool:test-fail'], 'agent:builder', graph)).toBe(false);
    expect(belongsToAgent(graph.nodes[id], 'agent:builder', graph)).toBe(false);
  });
});

describe('neural surface geometry', () => {
  it('has a detailed twin-lobe mesh with efficient shared buffer attributes', () => {
    const geometry = createNeuralGeometry('balanced');
    expect(geometry.neurons.getAttribute('position').count).toBeGreaterThan(1700);
    expect(geometry.filaments.getAttribute('position').count).toBeGreaterThan(10000);
    expect(geometry.neurons.getAttribute('color').count).toBe(geometry.neurons.getAttribute('position').count);
    expect(geometry.neurons.getAttribute('aSize').count).toBe(geometry.neurons.getAttribute('position').count);
    expect(geometry.neurons.boundingSphere?.radius).toBeGreaterThan(2);
    geometry.dispose();
  });
  it('is deterministic and uses less geometry in low quality', () => {
    const low = createNeuralGeometry('low');
    const high = createNeuralGeometry('high');
    const other = createNeuralGeometry('low');
    expect(low.neurons.getAttribute('position').array).toEqual(other.neurons.getAttribute('position').array);
    expect(high.neurons.getAttribute('position').count).toBeGreaterThan(low.neurons.getAttribute('position').count * 2);
    low.dispose(); high.dispose(); other.dispose();
  });
});
