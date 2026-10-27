import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three';

/** Seeded geometry only: decorative neural filaments never represent hidden Claude reasoning. */
function randomSource(seed: number): () => number {
  return () => {
    seed = Math.imul(seed, 1664525) + 1013904223;
    return (seed >>> 0) / 4294967296;
  };
}

export interface NeuralGeometry {
  filaments: BufferGeometry;
  neurons: BufferGeometry;
  interior: BufferGeometry;
  dispose: () => void;
}

export function createNeuralGeometry(detail: 'high' | 'balanced' | 'low'): NeuralGeometry {
  const random = randomSource(97);
  const rows = detail === 'low' ? 17 : detail === 'high' ? 30 : 23;
  const columns = detail === 'low' ? 28 : detail === 'high' ? 48 : 38;
  const points: Vector3[] = [];
  const sides: number[] = [];
  const pointSizes: number[] = [];
  for (const side of [-1, 1]) {
    for (let row = 0; row <= rows; row++) {
      const latitude = 0.10 + row / rows * (Math.PI - 0.20);
      for (let column = 0; column <= columns; column++) {
        const longitude = -Math.PI / 2 + column / columns * Math.PI;
        const ridge = 1 + 0.085 * Math.sin(longitude * 9 + latitude * 4) + 0.05 * Math.cos(latitude * 13 - longitude * 3);
        const shell = Math.sin(latitude);
        const x = side * (0.12 + 2.35 * shell * Math.cos(longitude) * ridge);
        const y = 2.05 * Math.cos(latitude) * (1 + 0.025 * Math.sin(longitude * 7));
        const z = 1.85 * shell * Math.sin(longitude) * ridge - 0.15 * Math.sin(latitude * 2);
        points.push(new Vector3(x, y, z));
        sides.push(side);
        pointSizes.push(random() > 0.94 ? 5.6 : 1.8 + random() * 1.6);
      }
    }
  }
  const filamentPositions: number[] = [];
  const filamentColors: number[] = [];
  const left = new Color('#369da8');
  const right = new Color('#7768b7');
  const ice = new Color('#6ec6ff');
  const connect = (a: number, b: number, brightness = 1) => {
    if (!points[a] || !points[b] || a === b) return;
    const color = (sides[a] < 0 ? left : right).clone().lerp(ice, random() * 0.5).multiplyScalar(brightness);
    filamentPositions.push(...points[a].toArray(), ...points[b].toArray());
    filamentColors.push(...color.toArray(), ...color.toArray());
  };
  const span = (rows + 1) * (columns + 1);
  for (let i = 0; i < points.length; i++) {
    const local = i % span;
    const row = Math.floor(local / (columns + 1));
    const column = local % (columns + 1);
    if (column < columns) connect(i, i + 1, 0.7);
    if (row < rows) connect(i, i + columns + 1, 0.65);
    if (row < rows && column < columns && random() > 0.34) connect(i, i + columns + 2, 0.45);
    if (row < rows - 2 && column < columns - 2 && random() > 0.72) connect(i, i + (columns + 1) * 2 + 2, 0.36);
    // A sparse commissure binds the hemispheres rather than a sphere-like complete mesh.
    if (i < span && column < 3 && row % 3 === 0) connect(i, i + span, 0.45);
  }
  const filaments = new BufferGeometry();
  filaments.setAttribute('position', new BufferAttribute(new Float32Array(filamentPositions), 3));
  filaments.setAttribute('color', new BufferAttribute(new Float32Array(filamentColors), 3));

  const neuronColors: number[] = [];
  points.forEach((_, i) => {
    const color = (sides[i] < 0 ? new Color('#72e9ee') : new Color('#bcacff')).lerp(ice, random() * 0.4);
    neuronColors.push(...color.toArray());
  });
  const neurons = new BufferGeometry();
  neurons.setAttribute('position', new BufferAttribute(new Float32Array(points.flatMap(point => point.toArray())), 3));
  neurons.setAttribute('color', new BufferAttribute(new Float32Array(neuronColors), 3));
  neurons.setAttribute('aSize', new BufferAttribute(new Float32Array(pointSizes), 1));

  const inner: number[] = [];
  for (let i = 0; i < (detail === 'low' ? 240 : 620); i++) {
    const phi = i * 2.3999632;
    const radius = Math.cbrt(random()) * 0.8;
    const y = (random() * 2 - 1) * radius;
    const horizontal = Math.sqrt(Math.max(0, radius * radius - y * y));
    inner.push(Math.cos(phi) * horizontal * 2.4, y * 2.0, Math.sin(phi) * horizontal * 1.7);
  }
  const interior = new BufferGeometry();
  interior.setAttribute('position', new BufferAttribute(new Float32Array(inner), 3));
  filaments.computeBoundingSphere();
  neurons.computeBoundingSphere();
  interior.computeBoundingSphere();
  return { filaments, neurons, interior, dispose: () => { filaments.dispose(); neurons.dispose(); interior.dispose(); } };
}

export const NEURON_VERTEX = `
  attribute float aSize;
  varying vec3 vColor;
  varying float vDepth;
  uniform float uTime;
  uniform float uEnergy;
  uniform float uPixelRatio;
  void main() {
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mvPosition.z;
    float pulse = 1.0 + uEnergy * 0.22 * sin(uTime * 1.3 + position.y * 4.0 + position.x * 2.0);
    gl_PointSize = clamp(aSize * uPixelRatio * (24.0 / max(6.0, vDepth)) * pulse, 1.0, 7.5);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const NEURON_FRAGMENT = `
  varying vec3 vColor;
  varying float vDepth;
  uniform float uEnergy;
  void main() {
    float r = length(gl_PointCoord - vec2(0.5));
    if (r > 0.5) discard;
    float core = smoothstep(0.45, 0.05, r);
    float alpha = core * (0.5 + uEnergy * 0.2);
    gl_FragColor = vec4(vColor * (1.25 + uEnergy * 0.4), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
