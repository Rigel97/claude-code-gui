import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  Object3D,
  OctahedronGeometry,
  TorusGeometry,
  type BufferGeometry,
} from 'three';
import type { PositionedNode, SceneLayout } from './layout';
import type { NodeType } from './types';
import { isActive, nodeColor } from './palette';

interface Props {
  layout: SceneLayout;
  visibleIds: Set<string>;
  selectedId: string | null;
  hoveredId: string | null;
  pathIds: Set<string>;
  paused: boolean;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
}

type SatelliteType = Exclude<NodeType, 'core'>;
type BatchItem = { item: PositionedNode; ghost: boolean };
type Ghost = { item: PositionedNode; at: number };

const SPAWN_DURATION = 0.46;
const GONE_DURATION = 0.42;
const FLASH_DURATION = 0.72;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}

function makeShape(type: SatelliteType, shell: boolean): BufferGeometry {
  if (type === 'agent') return new IcosahedronGeometry(shell ? 1.08 : 0.65, shell ? 1 : 2);
  if (type === 'tool') {
    const geometry = shell
      ? new CylinderGeometry(0.92, 0.92, 0.66, 6, 1, true)
      : new CylinderGeometry(0.58, 0.64, 0.56, 12, 1);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }
  if (type === 'file') return new BoxGeometry(shell ? 1.42 : 1.12, shell ? 1.58 : 1.28, shell ? 0.2 : 0.12);
  if (type === 'task') return new BoxGeometry(shell ? 1.08 : 0.72, shell ? 1.08 : 0.72, shell ? 1.08 : 0.72);
  return new OctahedronGeometry(shell ? 1.08 : 0.7, shell ? 0 : 1);
}

function NodeBatch({
  type,
  items,
  selectedId,
  hoveredId,
  pathIds,
  paused,
  clock,
  spawnAt,
  flashAt,
  gone,
  onSelect,
  onHover,
}: {
  type: SatelliteType;
  items: BatchItem[];
  selectedId: string | null;
  hoveredId: string | null;
  pathIds: Set<string>;
  paused: boolean;
  clock: { current: number };
  spawnAt: Map<string, number>;
  flashAt: Map<string, number>;
  gone: Map<string, Ghost>;
  onSelect: Props['onSelect'];
  onHover: Props['onHover'];
}) {
  const shell = useRef<InstancedMesh>(null);
  const inner = useRef<InstancedMesh>(null);
  const rim = useRef<InstancedMesh>(null);
  const selection = useRef<InstancedMesh>(null);
  const elapsed = useRef(0);
  const hoverLevels = useRef(new Map<string, number>());
  const scratch = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(), []);
  const white = useMemo(() => new Color('#dff8ff'), []);
  const graphite = useMemo(() => new Color('#07121c'), []);
  const geometries = useMemo(
    () => ({
      shell: makeShape(type, true),
      inner: makeShape(type, false),
      rim: new TorusGeometry(1.22, type === 'agent' ? 0.026 : 0.018, 6, type === 'agent' ? 64 : 24, Math.PI * 1.62),
      selection: new TorusGeometry(1.42, 0.022, 6, 64),
    }),
    [type]
  );
  useEffect(() => () => Object.values(geometries).forEach((geometry) => geometry.dispose()), [geometries]);
  const capacity = Math.max(1, items.length);
  const meshes = [shell, inner, rim, selection];
  useEffect(() => {
    meshes.forEach((ref) => ref.current?.instanceMatrix.setUsage(DynamicDrawUsage));
  }, [capacity]);

  const update = (delta: number) => {
    const now = clock.current;
    for (let index = 0; index < items.length; index++) {
      const { item, ghost } = items[index];
      const { node, position, scale } = item;
      const id = node.id;
      const active = isActive(node.status);
      const selected = id === selectedId;
      const inPath = pathIds.has(id);
      const dimmed = selectedId !== null && !inPath;

      const previousLevel = hoverLevels.current.get(id) ?? 0;
      const target = id === hoveredId ? 1 : 0;
      const level = paused || delta <= 0 ? target : previousLevel + (target - previousLevel) * Math.min(1, delta * 12);
      hoverLevels.current.set(id, level);

      const spawnT = paused ? 1 : clamp01((now - (spawnAt.get(id) ?? -10)) / SPAWN_DURATION);
      const goneT = ghost ? (paused ? 1 : clamp01((now - (gone.get(id)?.at ?? now)) / GONE_DURATION)) : 0;
      const appear = ghost ? 1 - goneT : easeOutCubic(spawnT);
      const fade = ghost ? 1 - goneT : Math.max(0.01, spawnT);
      const flashT = paused ? 1 : clamp01((now - (flashAt.get(id) ?? -10)) / FLASH_DURATION);
      const flash = flashT < 1 ? 1 - flashT : 0;
      const focus = dimmed ? 0.1 : 1;
      const grow = appear * (1 + level * 0.12 + flash * 0.08);
      const pulse = active && !paused ? 1 + Math.sin(elapsed.current * 2.2 + node.sequence) * 0.018 : 1;
      const intensity =
        (selected ? 1.7 : active ? 1.36 : node.status === 'error' ? 1.42 : node.status === 'completed' ? 0.94 : 0.72) *
        fade *
        focus *
        (1 + level * 0.42 + flash * 0.55);

      scratch.position.set(...position);
      scratch.rotation.set(type === 'task' ? 0.22 : 0, node.sequence * 0.37, type === 'agent' ? 0.18 : 0);
      scratch.scale.setScalar(scale * 1.1 * grow);
      scratch.updateMatrix();
      shell.current?.setMatrixAt(index, scratch.matrix);
      color.set(nodeColor(node)).multiplyScalar(0.34 * fade * focus * (1 + level * 0.35));
      shell.current?.setColorAt(index, color);

      scratch.scale.setScalar(scale * 1.18 * pulse * grow);
      scratch.rotation.y += active && !paused ? elapsed.current * 0.08 : 0;
      scratch.updateMatrix();
      inner.current?.setMatrixAt(index, scratch.matrix);
      color.set(nodeColor(node)).lerp(graphite, 0.34).multiplyScalar(intensity);
      if (flash > 0) color.lerp(white, flash * 0.38);
      inner.current?.setColorAt(index, color);

      scratch.rotation.set(type === 'agent' ? 0.74 : 0.08, node.sequence * 0.24, active && !paused ? elapsed.current * 0.07 : 0.3);
      scratch.scale.setScalar(scale * grow);
      scratch.updateMatrix();
      rim.current?.setMatrixAt(index, scratch.matrix);
      color.set(nodeColor(node)).multiplyScalar((selected ? 1.55 : active ? 0.92 : 0.32) * fade * focus * (1 + level * 0.5));
      rim.current?.setColorAt(index, color);

      scratch.rotation.set(Math.PI / 2, 0, 0);
      scratch.position.y -= scale * 1.02;
      scratch.scale.setScalar(selected || inPath || level > 0.25 ? scale * grow * (1 + level * 0.1) : 0);
      scratch.updateMatrix();
      selection.current?.setMatrixAt(index, scratch.matrix);
      color.set(nodeColor(node)).multiplyScalar((selected ? 1.45 : level > 0.25 ? 1.0 : 0.5) * fade * focus);
      selection.current?.setColorAt(index, color);
    }
    meshes.forEach((ref) => {
      const mesh = ref.current;
      if (!mesh) return;
      mesh.count = items.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  };

  useEffect(() => update(0), [items, selectedId, hoveredId, pathIds, capacity]);
  useFrame((_, delta) => {
    if (paused) return;
    elapsed.current += Math.min(delta, 0.05);
    update(Math.min(delta, 0.05));
  });

  const eventNode = (event: ThreeEvent<PointerEvent | MouseEvent>) => {
    const entry = items[event.instanceId ?? -1];
    return entry && !entry.ghost ? entry.item.node.id : null;
  };

  return (
    <group>
      <instancedMesh
        key={`shell-${capacity}`}
        ref={shell}
        args={[geometries.shell, undefined, capacity]}
        frustumCulled={false}
        onClick={(event) => {
          event.stopPropagation();
          const id = eventNode(event);
          if (id) onSelect(id);
        }}
        onPointerMove={(event) => {
          event.stopPropagation();
          const id = eventNode(event);
          if (id) onHover(id);
        }}
        onPointerOut={() => onHover(null)}
      >
        <meshStandardMaterial vertexColors wireframe transparent opacity={0.62} metalness={0.88} roughness={0.3} />
      </instancedMesh>
      <instancedMesh key={`inner-${capacity}`} ref={inner} args={[geometries.inner, undefined, capacity]} frustumCulled={false}>
        <meshStandardMaterial vertexColors metalness={0.48} roughness={0.34} emissive="#102631" emissiveIntensity={0.48} />
      </instancedMesh>
      <instancedMesh key={`rim-${capacity}`} ref={rim} args={[geometries.rim, undefined, capacity]} frustumCulled={false}>
        <meshBasicMaterial vertexColors transparent opacity={0.74} toneMapped={false} depthWrite={false} />
      </instancedMesh>
      <instancedMesh key={`selection-${capacity}`} ref={selection} args={[geometries.selection, undefined, capacity]} frustumCulled={false}>
        <meshBasicMaterial vertexColors transparent opacity={0.58} toneMapped={false} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}

function AgentNodesComponent(props: Props) {
  const clock = useRef(0);
  const spawnAt = useRef(new Map<string, number>()).current;
  const flashAt = useRef(new Map<string, number>()).current;
  const gone = useRef(new Map<string, Ghost>()).current;
  const previous = useRef(new Map<string, PositionedNode>()).current;
  const [transitionVersion, setTransitionVersion] = useState(0);
  const selectedId = props.selectedId;

  const batches = useMemo(() => {
    const groups = new Map<SatelliteType, BatchItem[]>();
    const current = new Map<string, PositionedNode>();
    for (const item of props.layout.nodes) {
      if (item.node.type === 'core' || !props.visibleIds.has(item.node.id)) continue;
      current.set(item.node.id, item);
    }
    for (const [id, item] of current) {
      const before = previous.get(id);
      if (!before) spawnAt.set(id, clock.current);
      else if (before.node.status !== item.node.status && (item.node.status === 'completed' || item.node.status === 'error')) {
        flashAt.set(id, clock.current);
      }
      gone.delete(id);
      const type = item.node.type as SatelliteType;
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type)!.push({ item, ghost: false });
    }
    for (const [id, item] of previous) {
      if (!current.has(id) && !gone.has(id)) gone.set(id, { item, at: clock.current });
    }
    previous.clear();
    for (const [id, item] of current) previous.set(id, item);
    for (const [id, ghost] of gone) {
      if (current.has(id)) continue;
      const type = ghost.item.node.type as SatelliteType;
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type)!.push({ item: ghost.item, ghost: true });
    }
    return groups;
  }, [props.layout, props.visibleIds, transitionVersion]);

  useEffect(() => {
    if (selectedId) flashAt.set(selectedId, clock.current);
  }, [selectedId]);

  useFrame((_, delta) => {
    if (props.paused) return;
    clock.current += Math.min(delta, 0.05);
    let expired = false;
    for (const [id, ghost] of gone) {
      if (clock.current - ghost.at > GONE_DURATION + 0.08) {
        gone.delete(id);
        spawnAt.delete(id);
        flashAt.delete(id);
        expired = true;
      }
    }
    if (expired) setTransitionVersion((version) => version + 1);
  });

  return (
    <>
      {[...batches].map(([type, items]) => (
        <NodeBatch
          key={type}
          type={type}
          items={items}
          selectedId={props.selectedId}
          hoveredId={props.hoveredId}
          pathIds={props.pathIds}
          paused={props.paused}
          clock={clock}
          spawnAt={spawnAt}
          flashAt={flashAt}
          gone={gone}
          onSelect={props.onSelect}
          onHover={props.onHover}
        />
      ))}
    </>
  );
}

export const AgentNodes = memo(AgentNodesComponent);
