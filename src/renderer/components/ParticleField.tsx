import { useEffect, useRef } from 'react';
import { useStore } from '../store';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  hue: number; // 0 = cyan, 1 = purple
}

const PARTICLE_COUNT = 70;
const BASE_LINK_DIST = 110;

/**
 * 科技感粒子网络背景
 * - 粒子缓慢漂移，邻近粒子间连线
 * - 鼠标附近粒子会被轻微排斥并增强连线
 * - Claude 生成中时粒子加速、连线更亮
 */
export function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<string>('idle');
  const status = useStore((s) => s.status);

  // 用 ref 同步 status，避免重建动画循环
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let rafId = 0;
    const particles: Particle[] = [];
    const mouse = { x: -9999, y: -9999 };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const initParticles = () => {
      particles.length = 0;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.35,
          vy: (Math.random() - 0.5) * 0.35,
          radius: Math.random() * 1.6 + 0.6,
          hue: Math.random(),
        });
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };

    const onMouseLeave = () => {
      mouse.x = -9999;
      mouse.y = -9999;
    };

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    // 平滑过渡的活跃系数 0（idle）~ 1（streaming）
    let activity = 0;

    const draw = () => {
      const streaming = statusRef.current === 'streaming' || statusRef.current === 'starting';
      activity = lerp(activity, streaming ? 1 : 0, 0.03);

      ctx.clearRect(0, 0, width, height);

      const speedMul = 1 + activity * 1.6;
      const linkDist = BASE_LINK_DIST + activity * 50;
      const linkDistSq = linkDist * linkDist;

      // 更新粒子
      for (const p of particles) {
        p.x += p.vx * speedMul;
        p.y += p.vy * speedMul;

        // 鼠标轻微排斥
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < 120 * 120 && distSq > 0.01) {
          const dist = Math.sqrt(distSq);
          const force = ((120 - dist) / 120) * 0.12;
          p.vx += (dx / dist) * force;
          p.vy += (dy / dist) * force;
        }

        // 速度阻尼，防止越推越快
        p.vx *= 0.995;
        p.vy *= 0.995;

        // 保底速度，防止完全静止
        if (Math.abs(p.vx) < 0.05) p.vx += (Math.random() - 0.5) * 0.02;
        if (Math.abs(p.vy) < 0.05) p.vy += (Math.random() - 0.5) * 0.02;

        // 边缘回绕
        if (p.x < -20) p.x = width + 20;
        if (p.x > width + 20) p.x = -20;
        if (p.y < -20) p.y = height + 20;
        if (p.y > height + 20) p.y = -20;
      }

      // 连线
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < linkDistSq) {
            const t = 1 - Math.sqrt(distSq) / linkDist;
            const alpha = t * (0.06 + activity * 0.14);
            ctx.strokeStyle = `rgba(0, 229, 255, ${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // 粒子
      for (const p of particles) {
        const r = Math.round(lerp(0, 168, p.hue));
        const g = Math.round(lerp(229, 85, p.hue));
        const b = Math.round(lerp(255, 247, p.hue));
        const alpha = 0.35 + activity * 0.35;

        // 发光核心
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius * (1 + activity * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        ctx.fill();

        // 光晕
        const glowRadius = p.radius * 4;
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius);
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${0.12 + activity * 0.1})`);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.beginPath();
        ctx.arc(p.x, p.y, glowRadius, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      rafId = requestAnimationFrame(draw);
    };

    resize();
    initParticles();
    draw();

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    />
  );
}
