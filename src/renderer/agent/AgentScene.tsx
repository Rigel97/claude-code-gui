import { Component, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  ACESFilmicToneMapping,
  PMREMGenerator,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { ExecutionGraph } from './types';
import type { PositionedNode, SceneLayout } from './layout';
import { NODE_STATUSES, NODE_TYPES, isActive, nodeColor } from './palette';
import { NeuralCore } from './NeuralCore';
import { ExecutionDeck, SceneEnvironment } from './SceneEnvironment';
import { AgentNodes } from './AgentNodes';
import { EnergyLinks } from './EnergyLinks';
import '../styles/agent-scene.css';

export type SceneQuality = 'high' | 'balanced' | 'low';
export interface CameraCommand {
  type: 'reset' | 'focus' | 'top' | 'zoomIn' | 'zoomOut';
  id?: string;
  nonce: number;
}
export interface SceneTelemetry {
  fps: number | null;
  drawCalls: number;
  triangles: number;
  renderer?: string;
}
export interface AgentSceneProps {
  graph: ExecutionGraph;
  layout: SceneLayout;
  visibleIds: Set<string>;
  selectedId: string | null;
  pathIds: Set<string>;
  paused: boolean;
  quality: SceneQuality;
  labels: boolean;
  cameraCommand: CameraCommand | null;
  onSelect: (id: string | null) => void;
  onTelemetry: (telemetry: SceneTelemetry) => void;
  onFailure: (reason: string) => void;
  onHover?: (id: string | null) => void;
}

type LabelRefs = Map<string, HTMLButtonElement>;
type Rectangle = { x: number; y: number; w: number; h: number };

class SceneBoundary extends Component<{ onFailure: (reason: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onFailure(`三维渲染失败：${error.message}`);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function SceneLighting({ quality }: { quality: SceneQuality }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const generator = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const target = generator.fromScene(room, 0.04);
    const previous = scene.environment;
    const previousIntensity = scene.environmentIntensity;
    scene.environment = target.texture;
    scene.environmentIntensity = quality === 'low' ? 0.42 : 0.68;
    generator.dispose();
    room.dispose();
    return () => {
      scene.environment = previous;
      scene.environmentIntensity = previousIntensity;
      target.dispose();
    };
  }, [gl, scene, quality]);
  return (
    <>
      <hemisphereLight args={['#a7c6d8', '#020407', 0.58]} />
      <directionalLight position={[7, 14, 10]} intensity={2.35} color="#b9e6f4" />
      <directionalLight position={[-11, 6, -9]} intensity={1.45} color="#aa82d1" />
      <pointLight position={[0, 2.5, 1]} intensity={14} distance={15} decay={2} color="#4fc7e5" />
    </>
  );
}

function SceneCamera({ layout, command }: { layout: SceneLayout; command: CameraCommand | null }) {
  const { camera, gl, invalidate } = useThree();
  const controls = useRef<OrbitControls | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const flight = useRef<{ from: Vector3; to: Vector3; fromTarget: Vector3; toTarget: Vector3; time: number } | null>(null);
  const userAdjusted = useRef(false);
  const autoFit = useRef({ radius: layout.radius, at: 0 });
  const reset = useCallback(() => {
    const current = layoutRef.current;
    const size = Math.max(0.85, Math.min(2.2, current.radius / 30));
    return {
      position: new Vector3(15.5 * size, 12.5 * size, 25.5 * size),
      target: new Vector3(current.center[0] * 0.12, -0.15, 1.1 + current.center[2] * 0.08),
    };
  }, []);

  useEffect(() => {
    const orbit = new OrbitControls(camera, gl.domElement);
    controls.current = orbit;
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.075;
    orbit.minDistance = 4.5;
    orbit.maxDistance = 145;
    orbit.minPolarAngle = 0.1;
    orbit.maxPolarAngle = Math.PI * 0.52;
    orbit.screenSpacePanning = true;
    orbit.rotateSpeed = 0.48;
    orbit.zoomSpeed = 0.72;
    orbit.panSpeed = 0.7;
    const initial = reset();
    camera.position.copy(initial.position);
    orbit.target.copy(initial.target);
    orbit.update();
    const onChange = () => invalidate();
    const onStart = () => {
      flight.current = null;
      userAdjusted.current = true;
    };
    orbit.addEventListener('change', onChange);
    orbit.addEventListener('start', onStart);
    invalidate();
    return () => {
      orbit.removeEventListener('change', onChange);
      orbit.removeEventListener('start', onStart);
      orbit.dispose();
      controls.current = null;
    };
  }, [camera, gl, invalidate, reset]);

  useEffect(() => {
    const orbit = controls.current;
    if (!orbit || !command) return;
    userAdjusted.current = command.type !== 'reset';
    let position: Vector3;
    let target: Vector3;
    if (command.type === 'focus') {
      const item = command.id ? layoutRef.current.byId.get(command.id) : undefined;
      if (!item) return;
      target = new Vector3(...item.position);
      const distance = item.node.type === 'core' ? 12.5 : item.node.type === 'agent' ? 6.2 : 4.4;
      const direction = camera.position.clone().sub(orbit.target).normalize();
      position = target.clone().addScaledVector(direction, distance);
    } else if (command.type === 'top') {
      target = new Vector3(0, -0.2, 1);
      position = new Vector3(0.01, Math.max(23, layoutRef.current.radius * 1.75), 0.1);
    } else if (command.type === 'zoomIn' || command.type === 'zoomOut') {
      target = orbit.target.clone();
      const direction = camera.position.clone().sub(target);
      const distance = Math.max(
        orbit.minDistance,
        Math.min(orbit.maxDistance, direction.length() * (command.type === 'zoomIn' ? 0.78 : 1.28))
      );
      position = target.clone().addScaledVector(direction.normalize(), distance);
    } else {
      const initial = reset();
      position = initial.position;
      target = initial.target;
    }
    flight.current = {
      from: camera.position.clone(),
      to: position,
      fromTarget: orbit.target.clone(),
      toTarget: target,
      time: 0,
    };
    invalidate();
  }, [command?.nonce, camera, invalidate, reset]);

  useEffect(() => {
    const previous = autoFit.current.radius;
    autoFit.current.radius = layout.radius;
    const now = performance.now();
    const grew = layout.radius > Math.max(22, previous * 1.3);
    if (!grew || userAdjusted.current || now - autoFit.current.at < 1800) return;
    const orbit = controls.current;
    if (!orbit) return;
    const initial = reset();
    autoFit.current.at = now;
    flight.current = {
      from: camera.position.clone(),
      to: initial.position,
      fromTarget: orbit.target.clone(),
      toTarget: initial.target,
      time: 0,
    };
    invalidate();
  }, [layout.radius, camera, reset, invalidate]);

  useFrame((_, delta) => {
    const orbit = controls.current;
    if (!orbit) return;
    const move = flight.current;
    if (move) {
      move.time = Math.min(1, move.time + Math.min(delta, 0.05) / 0.72);
      const progress = move.time * move.time * (3 - 2 * move.time);
      camera.position.lerpVectors(move.from, move.to, progress);
      orbit.target.lerpVectors(move.fromTarget, move.toTarget, progress);
      if (move.time >= 1) flight.current = null;
      invalidate();
    }
    orbit.update();
  });
  return null;
}

function intersects(a: Rectangle, b: Rectangle, gap = 7): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

function ProjectedLabels({
  items,
  refs,
  selectedId,
  pathIds,
}: {
  items: PositionedNode[];
  refs: LabelRefs;
  selectedId: string | null;
  pathIds: Set<string>;
}) {
  const { camera, size, gl } = useThree();
  const vector = useMemo(() => new Vector3(), []);
  const frame = useRef(0);
  useFrame(() => {
    frame.current++;
    if (frame.current % 2 !== 0) return;
    const rectangles: Rectangle[] = [];
    const limit = size.width < 600 ? 9 : size.width < 1000 ? 18 : 30;
    let count = 0;
    const canvasRect = gl.domElement.getBoundingClientRect();
    const root = gl.domElement.closest('.agent-space');
    const reserved = [
      ...(root?.querySelectorAll<HTMLElement>('.acs-inspector, .acs-topology-card, .acs-filter-panel, .acs-branch-dock, .acs-scene-actions, .acs-drawer') ?? []),
    ]
      .filter((element) => element.offsetWidth > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left - canvasRect.left, y: rect.top - canvasRect.top, w: rect.width, h: rect.height };
      });
    const core = items.find((item) => item.node.type === 'core');
    let coreBounds: Rectangle | null = null;
    if (core) {
      const world = new Vector3(...core.position);
      const center = world.clone().project(camera);
      const horizontal = world.clone().add(new Vector3(4.05, 0, 0)).project(camera);
      const vertical = world.clone().add(new Vector3(0, 4.05, 0)).project(camera);
      const rx = Math.min(size.width * 0.42, Math.abs(horizontal.x - center.x) * size.width * 0.5);
      const ry = Math.min(size.height * 0.42, Math.abs(vertical.y - center.y) * size.height * 0.5);
      const x = (center.x * 0.5 + 0.5) * size.width;
      const y = (-center.y * 0.5 + 0.5) * size.height;
      coreBounds = { x: x - rx, y: y - ry, w: rx * 2, h: ry * 2 };
    }

    for (const item of items) {
      const element = refs.get(item.node.id);
      if (!element) continue;
      const { node, position, scale } = item;
      vector.set(position[0], position[1] + (node.type === 'core' ? 4.5 : scale * 1.5), position[2]).project(camera);
      const x = (vector.x * 0.5 + 0.5) * size.width;
      const y = (-vector.y * 0.5 + 0.5) * size.height;
      const w = element.offsetWidth || 112;
      const h = element.offsetHeight || 38;
      const candidates: Rectangle[] = [
        { x: x - w / 2, y: y - h - 7, w, h },
        { x: x + 13, y: y - h / 2, w, h },
        { x: x - w - 13, y: y - h / 2, w, h },
        { x: x - w / 2, y: y + 10, w, h },
      ];
      const selected = node.id === selectedId;
      const related = !selectedId || pathIds.has(node.id);
      let chosen: Rectangle | null = null;
      const occupied = node.type === 'core' || !coreBounds ? [...rectangles, ...reserved] : [...rectangles, ...reserved, coreBounds];
      for (const candidate of candidates) {
        const blocked = occupied.some((other) => intersects(candidate, other, selected ? 3 : 7));
        const inside = candidate.x > 8 && candidate.x + w < size.width - 8 && candidate.y > 8 && candidate.y + h < size.height - 28;
        if (!blocked && inside) {
          chosen = candidate;
          break;
        }
      }
      const inFrustum = vector.z > -1 && vector.z < 1 && x > -w && x < size.width + w && y > -h && y < size.height + h;
      const visible = Boolean(chosen && inFrustum && (selected || (count < limit && (related || node.type === 'agent' || node.type === 'core'))));
      element.style.opacity = visible ? (related ? '1' : '0.16') : '0';
      element.style.visibility = visible ? 'visible' : 'hidden';
      element.style.zIndex = selected ? '4' : '1';
      if (!visible || !chosen) continue;
      element.style.transform = `translate3d(${Math.round(chosen.x)}px, ${Math.round(chosen.y)}px, 0)`;
      rectangles.push(chosen);
      count++;
    }
  });
  return null;
}

function PostProcessing({ quality, paused, onTelemetry }: { quality: SceneQuality; paused: boolean; onTelemetry: AgentSceneProps['onTelemetry'] }) {
  const { gl, scene, camera, size, invalidate } = useThree();
  const telemetry = useRef({ frames: 0, time: performance.now() });
  const latestCallback = useRef(onTelemetry);
  latestCallback.current = onTelemetry;
  const effect = useMemo(() => {
    if (quality === 'low') return null;
    const composer = new EffectComposer(gl);
    const render = new RenderPass(scene, camera);
    const bloom = new UnrealBloomPass(new Vector2(size.width, size.height), quality === 'high' ? 0.34 : 0.25, 0.32, 1.04);
    bloom.nMips = quality === 'high' ? 4 : 3;
    const output = new OutputPass();
    composer.addPass(render);
    composer.addPass(bloom);
    composer.addPass(output);
    return { composer, render, bloom, output };
  }, [gl, scene, camera, quality]);
  useEffect(() => {
    effect?.composer.setSize(size.width, size.height);
    effect?.composer.setPixelRatio(gl.getPixelRatio());
    invalidate();
  }, [effect, size.width, size.height, gl, invalidate]);
  useEffect(() => {
    const previous = gl.info.autoReset;
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = previous;
    };
  }, [gl]);
  useEffect(
    () => () => {
      effect?.bloom.dispose();
      effect?.output.dispose();
      effect?.render.dispose();
      effect?.composer.dispose();
    },
    [effect]
  );
  useFrame((_, delta) => {
    gl.info.reset();
    if (effect) effect.composer.render(delta);
    else gl.render(scene, camera);
    telemetry.current.frames++;
    const now = performance.now();
    const elapsed = now - telemetry.current.time;
    if (elapsed < 1100) return;
    const context = gl.getContext();
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    latestCallback.current({
      fps: paused ? null : Math.round((telemetry.current.frames * 1000) / elapsed),
      drawCalls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      renderer: debug ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : undefined,
    });
    telemetry.current = { frames: 0, time: now };
  }, 1);
  return null;
}

function SceneContent({
  props,
  labelItems,
  refs,
  onHover,
  hoveredId,
}: {
  props: AgentSceneProps;
  labelItems: PositionedNode[];
  refs: LabelRefs;
  onHover: (id: string | null) => void;
  hoveredId: string | null;
}) {
  const { graph, layout, visibleIds, selectedId, pathIds, paused, quality } = props;
  const core = layout.nodes.find((item) => item.node.type === 'core');
  return (
    <>
      <color attach="background" args={['#010307']} />
      <fog attach="fog" args={['#010307', 38, 118]} />
      <SceneLighting quality={quality} />
      <SceneEnvironment paused={paused} active={isActive(graph.status)} quality={quality} />
      <ExecutionDeck layout={layout} />
      {core && (
        <group position={core.position} scale={1.42}>
          <NeuralCore status={core.node.status} paused={paused} quality={quality} selected={selectedId === core.node.id} />
          <mesh
            onClick={(event) => {
              event.stopPropagation();
              props.onSelect(core.node.id);
            }}
            onPointerOver={() => onHover(core.node.id)}
            onPointerOut={() => onHover(null)}
          >
            <sphereGeometry args={[3.08, 18, 12]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </group>
      )}
      <AgentNodes
        layout={layout}
        visibleIds={visibleIds}
        selectedId={selectedId}
        hoveredId={hoveredId}
        pathIds={pathIds}
        paused={paused}
        onSelect={props.onSelect}
        onHover={onHover}
      />
      <EnergyLinks
        layout={layout}
        visibleIds={visibleIds}
        selectedId={selectedId}
        pathIds={pathIds}
        paused={paused}
        hoveredId={hoveredId}
      />
      <SceneCamera layout={layout} command={props.cameraCommand} />
      <ProjectedLabels items={labelItems} refs={refs} selectedId={selectedId} pathIds={pathIds} />
      <PostProcessing quality={quality} paused={paused} onTelemetry={props.onTelemetry} />
    </>
  );
}

function AgentSceneComponent(props: AgentSceneProps) {
  const refs = useRef<LabelRefs>(new Map());
  const container = useRef<HTMLDivElement>(null);
  const rendererCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => rendererCleanup.current?.(), []);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReducedMotion(media.matches);
    document.addEventListener('visibilitychange', onVisibility);
    media.addEventListener('change', onMotion);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      media.removeEventListener('change', onMotion);
    };
  }, []);
  const onHover = useCallback(
    (id: string | null) => {
      setHoveredId(id);
      props.onHover?.(id);
    },
    [props.onHover]
  );
  const labelItems = useMemo(() => {
    if (!props.labels) return [];
    const priority = (item: PositionedNode) =>
      item.node.id === props.selectedId
        ? 0
        : props.selectedId && props.pathIds.has(item.node.id)
          ? 1
          : item.node.type === 'core'
            ? 2
            : item.node.type === 'agent'
              ? 3
              : ['error', 'blocked', 'retrying'].includes(item.node.status)
                ? 4
                : isActive(item.node.status)
                  ? 5
                  : item.node.type === 'tool'
                    ? 6
                    : 7;
    return props.layout.nodes
      .filter((item) => props.visibleIds.has(item.node.id))
      .sort((a, b) => priority(a) - priority(b) || a.node.sequence - b.node.sequence)
      .slice(0, 52);
  }, [props.layout, props.visibleIds, props.selectedId, props.pathIds, props.labels]);
  const setupRenderer = useCallback(
    ({ gl }: { gl: WebGLRenderer }) => {
      gl.outputColorSpace = SRGBColorSpace;
      gl.toneMapping = ACESFilmicToneMapping;
      gl.toneMappingExposure = 0.86;
      const lost = (event: Event) => {
        event.preventDefault();
        props.onFailure('WebGL 上下文已丢失。执行事件仍在采集，请降低画质后重新加载场景。');
      };
      gl.domElement.addEventListener('webglcontextlost', lost);
      rendererCleanup.current?.();
      rendererCleanup.current = () => gl.domElement.removeEventListener('webglcontextlost', lost);
    },
    [props.onFailure]
  );
  const active = props.layout.nodes.some((item) => isActive(item.node.status));
  const paused = props.paused || reducedMotion || hidden;
  const renderProps = { ...props, paused: paused || !active };
  return (
    <div ref={container} className="agent-scene" data-webgl-scene="true" style={{ position: 'absolute', inset: 0 }}>
      <SceneBoundary onFailure={props.onFailure}>
        <Canvas
          camera={{ position: [15.5, 12.5, 25.5], fov: 41, near: 0.1, far: 180 }}
          dpr={props.quality === 'high' ? [1, 1.6] : props.quality === 'balanced' ? [1, 1.25] : 1}
          frameloop={hidden ? 'never' : paused || !active ? 'demand' : 'always'}
          gl={{ antialias: props.quality !== 'low', powerPreference: 'high-performance', alpha: false }}
          onCreated={setupRenderer}
          onPointerMissed={() => props.onSelect(null)}
          fallback={<div role="alert">当前设备无法创建 WebGL 场景，请使用节点列表检查执行事件。</div>}
          style={{ cursor: hoveredId ? 'pointer' : 'grab', touchAction: 'none' }}
        >
          <SceneContent props={renderProps} labelItems={labelItems} refs={refs.current} onHover={onHover} hoveredId={hoveredId} />
        </Canvas>
      </SceneBoundary>
      <div className="agent-projected-labels" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {labelItems.map((item) => {
          const { node } = item;
          const summary = node.error || node.output;
          return (
            <button
              key={node.id}
              ref={(element) => {
                if (element) refs.current.set(node.id, element);
                else refs.current.delete(node.id);
              }}
              type="button"
              className={`agent-spatial-label ${node.id === props.selectedId ? 'is-selected' : ''} ${node.type === 'core' ? 'is-core' : ''}`}
              data-node-type={node.type}
              data-node-status={node.status}
              data-agent-node={node.id}
              aria-label={`选择节点 ${node.label}`}
              title={`${node.label} · ${NODE_STATUSES[node.status].label}`}
              style={
                {
                  '--node-accent': nodeColor(node),
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  opacity: 0,
                  pointerEvents: 'auto',
                } as CSSProperties
              }
              onClick={() => props.onSelect(node.id)}
              onMouseEnter={() => onHover(node.id)}
              onMouseLeave={() => onHover(null)}
            >
              <span className="agent-spatial-label-code">
                {node.type === 'core' ? 'CLAUDE · ORCHESTRATOR' : `${NODE_TYPES[node.type].code} · L${item.level} · #${node.sequence}`}
              </span>
              <span className="agent-spatial-label-name">{node.type === 'core' ? '主 Agent' : node.label}</span>
              <span className="agent-spatial-label-state">
                <i />
                {NODE_STATUSES[node.status].label}
                {node.toolName ? <b>{node.toolName}</b> : null}
              </span>
              {summary && <span className="agent-spatial-label-result">{summary}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default memo(AgentSceneComponent);
