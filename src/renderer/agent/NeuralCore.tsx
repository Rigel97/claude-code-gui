import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  NormalBlending,
  Object3D,
  ShaderMaterial,
} from 'three';
import type { NodeStatus } from './types';
import { isActive, NODE_STATUSES } from './palette';

interface Props {
  status: NodeStatus;
  paused: boolean;
  quality: 'high' | 'balanced' | 'low';
  selected: boolean;
}

const SHELL_VERTEX = `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const SHELL_FRAGMENT = `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uEnergy;
  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vView)));
    float fresnel = pow(1.0 - facing, 3.4);
    float latitude = abs(fract(vUv.y * 18.0) - 0.5);
    float grid = 1.0 - smoothstep(0.47, 0.5, latitude);
    float scan = pow(max(0.0, sin(vUv.y * 3.14159 - uTime * 0.55)), 18.0);
    float alpha = fresnel * 0.23 + grid * 0.012 + scan * fresnel * uEnergy * 0.07;
    vec3 color = uColor * (0.32 + fresnel * 0.7 + scan * 0.1);
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function CoreHardware({ quality, accent }: { quality: Props['quality']; accent: string }) {
  const teeth = useRef<InstancedMesh>(null);
  const fasteners = useRef<InstancedMesh>(null);
  const count = quality === 'high' ? 48 : quality === 'balanced' ? 32 : 20;
  useEffect(() => {
    const scratch = new Object3D();
    for (let index = 0; index < count; index++) {
      const angle = (index / count) * Math.PI * 2;
      scratch.position.set(Math.cos(angle) * 2.55, -2.05, Math.sin(angle) * 2.55);
      scratch.rotation.set(0, -angle, 0);
      scratch.scale.set(index % 4 === 0 ? 1.35 : 0.72, 1, 1);
      scratch.updateMatrix();
      teeth.current?.setMatrixAt(index, scratch.matrix);

      scratch.position.set(Math.cos(angle) * 2.23, -1.89, Math.sin(angle) * 2.23);
      scratch.rotation.set(0, 0, 0);
      scratch.scale.setScalar(index % 4 === 0 ? 1.25 : 0.75);
      scratch.updateMatrix();
      fasteners.current?.setMatrixAt(index, scratch.matrix);
    }
    if (teeth.current) teeth.current.instanceMatrix.needsUpdate = true;
    if (fasteners.current) fasteners.current.instanceMatrix.needsUpdate = true;
  }, [count]);

  return (
    <group>
      <instancedMesh ref={teeth} args={[undefined, undefined, count]} key={`teeth-${count}`}>
        <boxGeometry args={[0.16, 0.12, 0.38]} />
        <meshStandardMaterial color="#263744" metalness={0.96} roughness={0.28} />
      </instancedMesh>
      <instancedMesh ref={fasteners} args={[undefined, undefined, count]} key={`fasteners-${count}`}>
        <cylinderGeometry args={[0.027, 0.027, 0.04, 8]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.18} metalness={0.8} roughness={0.24} />
      </instancedMesh>
    </group>
  );
}

function NeuralCoreComponent({ status, paused, quality, selected }: Props) {
  const gyroA = useRef<Group>(null);
  const gyroB = useRef<Group>(null);
  const gyroC = useRef<Group>(null);
  const orbital = useRef<Group>(null);
  const heartbeat = useRef<Group>(null);
  const time = useRef(0);
  const active = isActive(status);
  const error = status === 'error' || status === 'blocked';
  const accent = error ? NODE_STATUSES[status].color : '#61d9ee';
  const secondary = error ? '#d84d76' : '#a472d8';

  const shellMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: SHELL_VERTEX,
        fragmentShader: SHELL_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: NormalBlending,
        uniforms: { uTime: { value: 0 }, uEnergy: { value: 0 }, uColor: { value: new Color(accent) } },
      }),
    []
  );
  useEffect(() => () => shellMaterial.dispose(), [shellMaterial]);
  useEffect(() => {
    (shellMaterial.uniforms.uColor.value as Color).set(accent);
  }, [accent, shellMaterial]);

  const interior = useMemo(() => {
    const count = quality === 'high' ? 180 : quality === 'balanced' ? 100 : 48;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) {
      const ratio = (index + 0.5) / count;
      const y = 1 - ratio * 2;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const angle = index * 2.399963229728653;
      positions[index * 3] = Math.cos(angle) * radius * 1.48;
      positions[index * 3 + 1] = y * 1.48;
      positions[index * 3 + 2] = Math.sin(angle) * radius * 1.48;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    return geometry;
  }, [quality]);
  useEffect(() => () => interior.dispose(), [interior]);

  useFrame((_, delta) => {
    if (!paused && active) time.current += Math.min(delta, 0.05);
    const t = time.current;
    shellMaterial.uniforms.uTime.value = t;
    shellMaterial.uniforms.uEnergy.value = active ? 1 : 0;
    if (gyroA.current) gyroA.current.rotation.set(0.48, t * 0.075, 0.18);
    if (gyroB.current) gyroB.current.rotation.set(1.12, -0.35 - t * 0.055, -0.62);
    if (gyroC.current) gyroC.current.rotation.set(-0.68, 0.82 + t * 0.04, 1.18);
    if (orbital.current) orbital.current.rotation.y = t * 0.16;
    if (heartbeat.current) {
      const phase = (t % 5.2) / 5.2;
      const visible = active && phase < 0.16;
      const progress = visible ? phase / 0.16 : 0;
      heartbeat.current.visible = visible;
      heartbeat.current.scale.setScalar(1.1 + progress * 1.3);
      const mesh = heartbeat.current.children[0] as import('three').Mesh | undefined;
      if (mesh) (mesh.material as import('three').MeshBasicMaterial).opacity = (1 - progress) * 0.16;
    }
  });

  return (
    <group>
      {/* 固态能量晶体：有明确明暗，而不是白色光球。 */}
      <group ref={orbital}>
        <mesh rotation={[0.2, 0.35, 0.1]}>
          <icosahedronGeometry args={[0.82, 3]} />
          <meshPhysicalMaterial
            color="#082331"
            emissive={accent}
            emissiveIntensity={active ? 0.34 : 0.16}
            metalness={0.76}
            roughness={0.34}
            clearcoat={0.22}
            clearcoatRoughness={0.32}
          />
        </mesh>
        <mesh scale={1.04} rotation={[0.2, 0.35, 0.1]}>
          <icosahedronGeometry args={[0.82, 2]} />
          <meshBasicMaterial color={accent} wireframe transparent opacity={0.18} depthWrite={false} />
        </mesh>
        <points geometry={interior}>
          <pointsMaterial color={accent} size={0.022} transparent opacity={0.34} depthWrite={false} sizeAttenuation />
        </points>
      </group>
      <mesh>
        <sphereGeometry args={[0.27, 24, 16]} />
          <meshBasicMaterial color={error ? '#ff9cae' : '#8ee8f8'} transparent opacity={0.72} blending={AdditiveBlending} toneMapped={false} />
      </mesh>

      {/* 半透明干涉壳，仅保留 Fresnel 与极细纬线。 */}
      <mesh material={shellMaterial}>
        <sphereGeometry args={[1.64, quality === 'low' ? 32 : 56, quality === 'low' ? 20 : 36]} />
      </mesh>
      <mesh>
        <sphereGeometry args={[1.69, 32, 20]} />
        <meshPhysicalMaterial
          color="#68c9dd"
          transparent
          opacity={0.055}
          roughness={0.08}
          metalness={0.08}
          clearcoat={1}
          depthWrite={false}
        />
      </mesh>

      {/* 三层独立进动的钛合金轨道。 */}
      <group ref={gyroA}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.02, 0.075, 10, 160]} />
          <meshStandardMaterial color="#263d4c" metalness={0.98} roughness={0.24} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.025, 0.013, 5, 160, Math.PI * 1.45]} />
          <meshBasicMaterial color={accent} transparent opacity={0.8} toneMapped={false} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, Math.PI * 0.9]}>
          <torusGeometry args={[2.03, 0.025, 6, 48, Math.PI * 0.26]} />
          <meshStandardMaterial color="#a8dce8" emissive={accent} emissiveIntensity={0.38} metalness={0.85} roughness={0.2} />
        </mesh>
      </group>
      <group ref={gyroB}>
        <mesh>
          <torusGeometry args={[2.38, 0.055, 8, 144, Math.PI * 1.78]} />
          <meshStandardMaterial color="#222d3e" metalness={0.96} roughness={0.3} />
        </mesh>
        <mesh rotation={[0, 0, 1.2]}>
          <torusGeometry args={[2.39, 0.012, 5, 160]} />
          <meshBasicMaterial color={secondary} transparent opacity={0.58} toneMapped={false} />
        </mesh>
      </group>
      <group ref={gyroC}>
        <mesh rotation={[0, 0, Math.PI * 0.5]}>
          <torusGeometry args={[2.78, 0.035, 8, 160, Math.PI * 1.62]} />
          <meshStandardMaterial color="#30394a" metalness={0.95} roughness={0.27} />
        </mesh>
        <mesh rotation={[0, 0, Math.PI * 0.5]}>
          <torusGeometry args={[2.79, 0.009, 4, 160, Math.PI * 0.7]} />
          <meshBasicMaterial color={secondary} transparent opacity={0.66} toneMapped={false} />
        </mesh>
      </group>

      {/* 有界心跳：仅执行中每 5.2 秒发出一次局部脉冲。 */}
      <group ref={heartbeat} rotation={[0.42, 0, 0.18]} visible={false}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[2.08, 2.1, 96]} />
          <meshBasicMaterial color={accent} transparent opacity={0} side={DoubleSide} depthWrite={false} />
        </mesh>
      </group>

      {/* 多层机械基座与实例化精密齿件。 */}
      <group>
        <mesh position={[0, -2.12, 0]}>
          <cylinderGeometry args={[2.3, 2.5, 0.2, 80]} />
          <meshStandardMaterial color="#111d28" metalness={0.97} roughness={0.32} />
        </mesh>
        <mesh position={[0, -2.24, 0]}>
          <cylinderGeometry args={[1.86, 2.12, 0.16, 64]} />
          <meshStandardMaterial color="#1b2a35" metalness={0.92} roughness={0.38} />
        </mesh>
        <mesh position={[0, -2.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.9, 2.04, 96]} />
          <meshStandardMaterial color="#203b47" emissive={accent} emissiveIntensity={0.24} metalness={0.82} roughness={0.26} side={DoubleSide} />
        </mesh>
        {[2.22, 2.58, 2.96].map((radius, index) => (
          <mesh key={radius} position={[0, -2.15 - index * 0.06, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[radius, index === 1 ? 0.014 : 0.007, 5, 128]} />
            <meshBasicMaterial color={index === 1 ? accent : '#446274'} transparent opacity={0.36 - index * 0.06} toneMapped={false} />
          </mesh>
        ))}
        <CoreHardware quality={quality} accent={accent} />
      </group>

      {selected && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -2.0, 0]}>
          <torusGeometry args={[3.12, 0.022, 6, 128]} />
          <meshBasicMaterial color={accent} transparent opacity={0.9} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

export const NeuralCore = memo(NeuralCoreComponent);
