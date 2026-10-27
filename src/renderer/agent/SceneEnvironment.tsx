import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  NormalBlending,
  Object3D,
  ShaderMaterial,
} from 'three';
import type { SceneLayout } from './layout';

const FLOOR_VERTEX = `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const FLOOR_FRAGMENT = `
  varying vec3 vWorld;
  void main() {
    vec2 p = vWorld.xz;
    vec2 d = abs(fract(p / 1.75 - 0.5) - 0.5) / max(fwidth(p / 1.75), vec2(0.001));
    float grid = 1.0 - min(min(d.x, d.y), 1.0);
    vec2 majorD = abs(fract(p / 8.75 - 0.5) - 0.5) / max(fwidth(p / 8.75), vec2(0.001));
    float major = 1.0 - min(min(majorD.x, majorD.y), 1.0);
    float distanceFade = exp(-length(p) * 0.052) * smoothstep(2.8, 6.2, length(p));
    vec3 color = mix(vec3(0.10, 0.20, 0.28), vec3(0.12, 0.38, 0.46), major);
    gl_FragColor = vec4(color, (grid * 0.065 + major * 0.12) * distanceFade);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
const DUST_VERTEX = `
  attribute float aSize;
  varying float vOpacity;
  uniform float uTime;
  void main() {
    vec3 p = position;
    p.y += sin(uTime * 0.06 + p.x * 0.1) * 0.09;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(aSize * 24.0 / max(-mv.z, 12.0), 0.8, 2.2);
    vOpacity = clamp(34.0 / max(-mv.z, 12.0), 0.15, 0.58);
    gl_Position = projectionMatrix * mv;
  }
`;
const DUST_FRAGMENT = `
  varying float vOpacity;
  void main() {
    float r = length(gl_PointCoord - vec2(0.5));
    if (r > 0.5) discard;
    gl_FragColor = vec4(0.36, 0.57, 0.68, (1.0 - r * 2.0) * vOpacity * 0.5);
  }
`;
const BEAM_VERTEX = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const BEAM_FRAGMENT = `
  varying vec2 vUv;
  uniform vec3 uColor;
  void main() {
    float edge = pow(max(0.0, 1.0 - abs(vUv.x - 0.5) * 2.0), 3.0);
    float falloff = pow(1.0 - vUv.y, 2.8);
    gl_FragColor = vec4(uColor, edge * falloff * 0.045);
  }
`;
const HAZE_FRAGMENT = `
  varying vec2 vUv;
  void main() {
    float cyan = exp(-distance(vUv, vec2(0.47, 0.52)) * 8.5);
    float violet = exp(-distance(vUv, vec2(0.72, 0.62)) * 11.0);
    vec3 color = vec3(0.025, 0.12, 0.16) * cyan + vec3(0.07, 0.025, 0.10) * violet;
    gl_FragColor = vec4(color, cyan * 0.5 + violet * 0.28);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function DistantArchitecture({ quality }: { quality: 'high' | 'balanced' | 'low' }) {
  const pillars = useRef<InstancedMesh>(null);
  const count = quality === 'low' ? 12 : 24;
  useEffect(() => {
    const scratch = new Object3D();
    for (let index = 0; index < count; index++) {
      const angle = -1.12 + (index / Math.max(1, count - 1)) * 2.24;
      const radius = 42 + (index % 4) * 4;
      const height = 5 + ((index * 7) % 13);
      scratch.position.set(Math.sin(angle) * radius, height / 2 - 4.2, -Math.cos(angle) * radius - 8);
      scratch.scale.set(index % 3 === 0 ? 1.8 : 0.8, height, index % 3 === 0 ? 1.8 : 0.8);
      scratch.rotation.set(0, -angle, 0);
      scratch.updateMatrix();
      pillars.current?.setMatrixAt(index, scratch.matrix);
    }
    if (pillars.current) pillars.current.instanceMatrix.needsUpdate = true;
  }, [count]);
  return (
    <instancedMesh ref={pillars} args={[undefined, undefined, count]} key={count}>
      <boxGeometry args={[0.28, 1, 0.28]} />
      <meshStandardMaterial color="#0a1823" metalness={0.88} roughness={0.55} />
    </instancedMesh>
  );
}

export const ExecutionDeck = memo(function ExecutionDeck({ layout }: { layout: SceneLayout }) {
  const signature = layout.groups.map((group) => `${group.id}:${group.nodeIds.length}:${Math.round(group.maxRadius * 10)}`).join('|');
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const y = -3.38;
    const push = (a: [number, number, number], b: [number, number, number], color: Color) => {
      positions.push(...a, ...b);
      colors.push(...color.toArray(), ...color.toArray());
    };
    for (const group of layout.groups) {
      const tint = new Color(group.color).multiplyScalar(0.23);
      const start = 4.4;
      const end = Math.max(11.2, group.maxRadius + 1.2);
      const width = group.id.startsWith('core:') ? 0.34 : 0.28;
      for (const side of [-1, 1]) {
        const angle = group.angle + side * width;
        push(
          [Math.cos(angle) * start, y, Math.sin(angle) * start],
          [Math.cos(angle) * end, y, Math.sin(angle) * end],
          tint
        );
      }
      push(
        [Math.cos(group.angle) * start, y, Math.sin(group.angle) * start],
        [Math.cos(group.angle) * end, y, Math.sin(group.angle) * end],
        tint.clone().multiplyScalar(0.55)
      );
      for (let radius = 11.2; radius < end; radius += 3.55) {
        for (let segment = 0; segment < 12; segment++) {
          const a = group.angle - width + (segment / 12) * width * 2;
          const b = group.angle - width + ((segment + 1) / 12) * width * 2;
          push([Math.cos(a) * radius, y, Math.sin(a) * radius], [Math.cos(b) * radius, y, Math.sin(b) * radius], tint);
        }
      }
    }
    const tasks = layout.nodes.filter((item) => item.lane === 'task');
    if (tasks.length) {
      const tint = new Color('#8e79ad').multiplyScalar(0.2);
      const maxZ = Math.max(...tasks.map((item) => item.position[2])) + 1.25;
      for (const x of [-9.7, 9.7]) push([x, y, 5.75], [x, y, maxZ], tint);
      for (let z = 5.75; z <= maxZ; z += 2.65) push([-9.7, y, z], [9.7, y, z], tint);
    }
    const result = new BufferGeometry();
    result.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    result.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    result.computeBoundingSphere();
    return result;
  }, [signature]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial vertexColors transparent opacity={0.34} depthWrite={false} blending={NormalBlending} />
      </lineSegments>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -3.36, 0]}>
        <torusGeometry args={[4.05, 0.012, 5, 128, Math.PI * 1.82]} />
        <meshBasicMaterial color="#32677a" transparent opacity={0.26} depthWrite={false} />
      </mesh>
    </group>
  );
});

function Environment({ paused, active, quality }: { paused: boolean; active: boolean; quality: 'high' | 'balanced' | 'low' }) {
  const time = useRef(0);
  const floor = useMemo(
    () => new ShaderMaterial({ vertexShader: FLOOR_VERTEX, fragmentShader: FLOOR_FRAGMENT, transparent: true, depthWrite: false, side: DoubleSide }),
    []
  );
  const dust = useMemo(() => {
    const count = quality === 'low' ? 220 : quality === 'balanced' ? 420 : 620;
    const positions: number[] = [];
    const sizes: number[] = [];
    for (let index = 0; index < count; index++) {
      const angle = index * 2.399963;
      const radius = 8 + ((index * 97) % 571) / 571 * 43;
      positions.push(Math.cos(angle) * radius, ((index * 73) % 211) / 211 * 26 - 7, Math.sin(angle) * radius - 14);
      sizes.push(index % 41 === 0 ? 2.2 : 1 + (index % 7) * 0.1);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('aSize', new BufferAttribute(new Float32Array(sizes), 1));
    const material = new ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
    });
    return { geometry, material };
  }, [quality]);
  const beam = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        side: DoubleSide,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: { uColor: { value: new Color('#4d9ab5') } },
      }),
    []
  );
  const haze = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: BEAM_VERTEX,
        fragmentShader: HAZE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: NormalBlending,
      }),
    []
  );
  useEffect(() => () => floor.dispose(), [floor]);
  useEffect(() => () => {
    dust.geometry.dispose();
    dust.material.dispose();
  }, [dust]);
  useEffect(() => () => beam.dispose(), [beam]);
  useEffect(() => () => haze.dispose(), [haze]);
  useFrame((_, delta) => {
    if (!paused && active) time.current += Math.min(delta, 0.05);
    dust.material.uniforms.uTime.value = time.current;
  });

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -3.65, 0]} material={floor}>
        <planeGeometry args={[140, 140]} />
      </mesh>
      <mesh position={[0, -1.95, 0]}>
        <cylinderGeometry args={[2.0, 2.7, 3.2, 64, 1, true]} />
        <meshBasicMaterial color="#2a8ca8" transparent opacity={0.022} side={DoubleSide} depthWrite={false} />
      </mesh>
      <mesh position={[0, 7, -46]} material={haze}>
        <planeGeometry args={[100, 64]} />
      </mesh>
      <points geometry={dust.geometry} material={dust.material} />
      <DistantArchitecture quality={quality} />
      <group position={[0, 8, -48]} rotation={[0.08, 0, 0.12]}>
        <mesh>
          <torusGeometry args={[24, 0.025, 5, 160, Math.PI * 1.3]} />
          <meshBasicMaterial color="#1b4559" transparent opacity={0.2} depthWrite={false} />
        </mesh>
        <mesh rotation={[0, 0, 2.4]}>
          <torusGeometry args={[29, 0.018, 5, 160, Math.PI * 0.72]} />
          <meshBasicMaterial color="#493c65" transparent opacity={0.14} depthWrite={false} />
        </mesh>
      </group>
      {quality === 'high' && (
        <group position={[0, 2.5, -0.5]}>
          <mesh rotation={[0, 0, -0.08]} material={beam}>
            <planeGeometry args={[4.8, 12]} />
          </mesh>
          <mesh rotation={[0, Math.PI / 2, 0.06]} material={beam}>
            <planeGeometry args={[4.8, 12]} />
          </mesh>
        </group>
      )}
    </group>
  );
}

export const SceneEnvironment = memo(Environment);
