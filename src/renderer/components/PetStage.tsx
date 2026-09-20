import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import {
  getPetLevel, SPECIES_INFO, CHATTER, STAGE_LINES,
  makePicker, isNightNow, PetSVG,
} from './petShared';

/** 行为调度间隔范围 */
const BEHAVIOR_MIN_MS = 2600;
const BEHAVIOR_MAX_MS = 6000;

type Behavior = 'idle' | 'walk' | 'jump' | 'dash';

/**
 * 宠物大舞台：活跃标签页是空对话时，宠物从侧栏小窝「搬家」到这里撒欢。
 * 随机游走 / 疾跑 / 跳跃 / 发呆，移动时按方向翻转朝向；点击照样能说话。
 */
export function PetStage() {
  const species = useStore((s) => s.petSpecies);
  const totalTokens = useStore((s) => s.totalInputTokens + s.totalOutputTokens);
  const { level } = getPetLevel(totalTokens);
  const info = SPECIES_INFO[species];

  // 舞台位置（百分比）与朝向（1=朝右，-1=朝左）
  const [pos, setPos] = useState({ x: 50, y: 55 });
  const [facing, setFacing] = useState<1 | -1>(1);
  const [behavior, setBehavior] = useState<Behavior>('idle');
  const [speech, setSpeech] = useState<{ text: string; nonce: number } | null>(null);

  const pickRef = useRef<((l: string[]) => string) | null>(null);
  if (!pickRef.current) pickRef.current = makePicker();
  const pick = pickRef.current;
  const speechTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 登场：弹跳 + 打招呼（仅首次挂载）
  useEffect(() => {
    speechTimer.current = setTimeout(() => {
      setSpeech({ text: pick(STAGE_LINES), nonce: Date.now() });
    }, 600);
    return () => {
      if (speechTimer.current) clearTimeout(speechTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 随机行为循环：游走（大头）/ 跳跃 / 疾跑 / 发呆
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const roll = Math.random();
      let next: Behavior = 'idle';
      if (roll < 0.55) {
        next = 'walk';
        setPos((p) => {
          const x = 8 + Math.random() * 84;
          setFacing(x < p.x ? -1 : 1);
          return { x, y: 30 + Math.random() * 50 };
        });
      } else if (roll < 0.75) {
        next = 'jump';
      } else if (roll < 0.9) {
        // 疾跑：快速冲到另一头
        next = 'dash';
        setPos((p) => {
          const x = p.x < 50 ? 88 : 12;
          setFacing(x < p.x ? -1 : 1);
          return { ...p, x };
        });
      }
      setBehavior(next);
      timer = setTimeout(schedule, BEHAVIOR_MIN_MS + Math.random() * (BEHAVIOR_MAX_MS - BEHAVIOR_MIN_MS));
    };
    timer = setTimeout(schedule, 1500);
    return () => clearTimeout(timer);
  }, []);

  const poke = useCallback(() => {
    if (speechTimer.current) clearTimeout(speechTimer.current);
    setSpeech({ text: pick(CHATTER[species]), nonce: Date.now() });
    speechTimer.current = setTimeout(() => setSpeech(null), 3200);
  }, [species, pick]);

  const night = isNightNow();

  return (
    <div className="relative w-full max-w-md h-44 mt-2 mx-auto">
      {/* 地面线 */}
      <div className="absolute left-[6%] right-[6%] bottom-6 h-px bg-gradient-to-r from-transparent via-accent-cyan/25 to-transparent" />

      {/* 宠物（游走容器 → 翻转层 → 弹跳/奔跑动画层 → SVG） */}
      <div
        role="button"
        onClick={poke}
        title="戳一戳"
        className="absolute cursor-pointer"
        style={{
          left: `${pos.x}%`,
          top: `${pos.y}%`,
          transform: 'translate(-50%, -100%)',
          transition: `left ${behavior === 'dash' ? 0.9 : 2.2}s cubic-bezier(.45,.05,.55,.95), top 2.2s ease-in-out`,
        }}
      >
        {speech && (
          <div
            key={speech.nonce}
            className="pet-speech absolute -top-9 left-1/2 -translate-x-1/2 z-20 max-w-[180px] px-2.5 py-1.5 rounded-xl rounded-bl-sm bg-bg-light border border-accent-purple/40 text-[11px] leading-snug text-text-primary whitespace-normal break-words shadow-lg pointer-events-none text-center"
          >
            {speech.text}
          </div>
        )}

        <div key={behavior} className={behavior === 'jump' ? 'pet-stage-jump' : behavior === 'walk' || behavior === 'dash' ? 'pet-stage-run' : 'pet-float'}>
          <div style={{ transform: `scaleX(${facing})` }}>
            <div style={{ transform: 'scale(1.9)', transformOrigin: 'center bottom' }}>
              <PetSVG species={species} eyeOpen level={level} blink decor={{ night }} />
            </div>
          </div>
        </div>
      </div>

      {/* 舞台标注 */}
      <div className="absolute bottom-0 inset-x-0 text-center text-[10px] text-text-dim/70 font-mono pointer-events-none">
        {info.name}的前台乐园 · 点击互动
      </div>
    </div>
  );
}
