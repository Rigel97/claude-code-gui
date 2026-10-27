import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CubicBezierCurve3,
  DynamicDrawUsage,
  InstancedMesh,
  NormalBlending,
  Object3D,
  Vector3,
} from 'three';
import type { EdgeKind } from './types';
import type { SceneLayout } from './layout';
import { hashId } from './layout';
import { isActive } from './palette';

interface Props {
  layout: SceneLayout;
  visibleIds: Set<string>;
  selectedId: string | null;
  pathIds: Set<string>;
  paused: boolean;
  hoveredId?: string | null;
}

const EDGE_COLORS: Record<EdgeKind, string> = {
  call: '#45bad1',
  delegation: '#a18bd0',
  read: '#6d9fc5',
  write: '#ca75b4',
  dependency: '#706f94',
  retry: '#ee6dad',
};
const MAX_PACKETS = 192;

function Links({ layout, visibleIds, selectedId, pathIds, paused, hoveredId = null }: Props) {
  const elapsed = useRef(0);
  const photons = useRef<InstancedMesh>(null);
  const scratch = useMemo(() => new Object3D(), []);
  const position = useMemo(() => new Vector3(), []);
  const particleColor = useMemo(() => new Color(), []);
  const links = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const traces: { curve: CubicBezierCurve3; color: Color; active: boolean; offset: number; highlighted: boolean }[] = [];
    const tint = new Color();
    const subdivisions = layout.edges.length > 160 ? 10 : layout.edges.length > 80 ? 16 : 24;

    for (const edge of layout.edges) {
      if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue;
      const source = layout.byId.get(edge.source)!;
      const target = layout.byId.get(edge.target)!;
      const a = new Vector3(...source.position);
      const b = new Vector3(...target.position);
      const direction = b.clone().sub(a);
      const normal = new Vector3(-direction.z, 0.12, direction.x).normalize();
      const sign = (hashId(edge.id) & 1) === 0 ? 1 : -1;
      const isArtifact = edge.kind === 'read' || edge.kind === 'write';
      const isDependency = edge.kind === 'dependency';
      const isRetry = edge.kind === 'retry';
      const arc = isDependency || isRetry ? sign * Math.min(1.3, direction.length() * 0.08) : Math.min(0.45, direction.length() * 0.035);
      const lift = isArtifact ? -0.2 : isRetry ? 1.9 : isDependency ? 1.05 : 0.28;
      const c1 = a.clone().addScaledVector(direction, 0.3).addScaledVector(normal, arc);
      const c2 = a.clone().addScaledVector(direction, 0.72).addScaledVector(normal, arc);
      c1.y += lift;
      c2.y += lift * 0.75;
      const curve = new CubicBezierCurve3(a, c1, c2, b);

      const active = isActive(target.node.status);
      const hovered = hoveredId !== null && (edge.source === hoveredId || edge.target === hoveredId);
      const connected = pathIds.has(edge.source) && pathIds.has(edge.target);
      const highlighted = connected || hovered;
      // 密集图中仅常显调用结构、活跃路径与重试；选择节点即恢复完整历史依赖和制品关系。
      if ((isDependency || isArtifact) && !highlighted && !active && layout.edges.length > 28) continue;
      const focus = selectedId && !connected ? 0.055 : 1;
      const baseTint = new Color(EDGE_COLORS[edge.kind]);
      if (target.node.status === 'error') baseTint.set('#ef667e');
      const strength = (highlighted ? 1.05 : active ? (isDependency ? 0.28 : 0.58) : isDependency ? 0.075 : 0.25) * focus;
      tint.copy(baseTint).multiplyScalar(strength);
      const points = curve.getPoints(subdivisions);
      for (let index = 0; index < points.length - 1; index++) {
        if ((isDependency || isRetry) && index % 4 === 2) continue;
        positions.push(...points[index].toArray(), ...points[index + 1].toArray());
        colors.push(...tint.toArray(), ...tint.toArray());
      }

      // 静态方向标只在可辨识的关系上显示，避免高密度时形成噪点。
      if (highlighted || active || layout.edges.length < 90) {
        const arrow = curve.getPoint(0.8);
        const tangent = curve.getTangent(0.8).multiplyScalar(0.24);
        for (const side of [-1, 1]) {
          const tip = arrow.clone().sub(tangent).addScaledVector(normal, side * 0.13);
          positions.push(...tip.toArray(), ...arrow.toArray());
          const arrowTint = tint.clone().multiplyScalar(1.3);
          colors.push(...arrowTint.toArray(), ...arrowTint.toArray());
        }
      }
      traces.push({ curve, color: baseTint, active, offset: (hashId(edge.id) % 1000) / 1000, highlighted });
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    geometry.computeBoundingSphere();
    return { geometry, traces };
  }, [layout, visibleIds, selectedId, pathIds, hoveredId]);

  useEffect(() => () => links.geometry.dispose(), [links]);
  useEffect(() => {
    photons.current?.instanceMatrix.setUsage(DynamicDrawUsage);
  }, []);

  useFrame((_, delta) => {
    if (!paused) elapsed.current += Math.min(delta, 0.05);
    if (!photons.current) return;
    let index = 0;
    for (const trace of links.traces) {
      if (!trace.active) continue;
      const count = trace.highlighted ? 3 : 2;
      for (let packet = 0; packet < count && index < MAX_PACKETS; packet++) {
        const t = (elapsed.current * 0.2 + trace.offset + packet / count) % 1;
        trace.curve.getPoint(t, position);
        scratch.position.copy(position);
        scratch.scale.setScalar(trace.highlighted ? 0.052 : 0.036);
        scratch.updateMatrix();
        photons.current.setMatrixAt(index, scratch.matrix);
        particleColor.copy(trace.color).multiplyScalar(trace.highlighted ? 1.65 : 1.15);
        photons.current.setColorAt(index, particleColor);
        index++;
      }
    }
    photons.current.count = index;
    photons.current.instanceMatrix.needsUpdate = true;
    if (photons.current.instanceColor) photons.current.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      <lineSegments geometry={links.geometry}>
        <lineBasicMaterial vertexColors transparent opacity={0.86} depthWrite={false} blending={NormalBlending} toneMapped={false} />
      </lineSegments>
      <instancedMesh ref={photons} args={[undefined, undefined, MAX_PACKETS]} frustumCulled={false}>
        <sphereGeometry args={[1, 6, 4]} />
        <meshBasicMaterial vertexColors toneMapped={false} transparent opacity={0.88} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}

export const EnergyLinks = memo(Links);
