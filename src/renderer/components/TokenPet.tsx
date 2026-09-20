import { useState, useCallback, useRef, useEffect } from 'react';
import { useStore } from '../store';
import { RefreshCw, Carrot, Fish, Cookie } from 'lucide-react';
import type { PetSpecies } from '../types';
import {
  getPetLevel, SPECIES_INFO, SPECIES_COLORS,
  CHATTER, BUSY_LINES, FEED_LINES, LEVELUP_LINES, DONE_LINES,
  NIGHT_LINES, ANXIOUS_LINES, SLEEPY_LINES, ERROR_LINES,
  DRAG_FAR_LINES, DRAG_NEAR_LINES, ROLL_LINES, ANGRY_LINES, FULL_LINES,
  makePicker, isNightNow, PetSVG,
} from './petShared';
import type { PetDecor, PetMouth } from './petShared';

/** 喂食图标（侧栏小按钮用） */
const FOOD_ICONS: Record<PetSpecies, React.ReactNode> = {
  bunny: <Carrot className="w-3 h-3" />,
  cat: <Fish className="w-3 h-3" />,
  bear: <Cookie className="w-3 h-3" />,
};

/** 深夜检查间隔 */
const NIGHT_TICK_MS = 60_000;
/** 生成中挂机多久后开始打盹 */
const SLEEPY_AFTER_MS = 5 * 60_000;
/** 焦虑台词冷却（防刷屏） */
const ANXIOUS_COOLDOWN_MS = 10 * 60_000;
/** 喂食计数窗口（窗口内 >5 次撑到吃不下） */
const FEED_WINDOW_MS = 5 * 60_000;
/** 挠痒痒：1 秒内戳够次数触发打滚 */
const TICKLE_WINDOW_MS = 1000;
const TICKLE_ROLL_COUNT = 5;
/** 连戳累计到该值后开始不耐烦（每次触发生气 1.6s） */
const ANGRY_TOTAL = 10;
/** 拖拽判定为「点击」的最大位移 */
const CLICK_SLOP_PX = 6;
/** 拖拽超过该距离算「扔得远」 */
const DRAG_FAR_PX = 120;

/**
 * Token 宠物（侧栏小窝版）：随累计用量升级，生成中蹦跳，空闲睡觉。
 * 情绪感知：上下文焦虑冒冷汗 / 深夜戴睡帽 / 长任务打盹 / 翻车歪头问号。
 * 物理互动：戳一戳说话、拖拽扔出去（弹簧飞回）、挠痒痒打滚、连戳不耐烦、喂食撑到变胖。
 * 活跃标签页是空对话时「搬家」去聊天区舞台撒欢，这里显示空窝。
 */
export function TokenPet() {
  const species = useStore((s) => s.petSpecies);
  const setPetSpecies = useStore((s) => s.setPetSpecies);
  const totalTokens = useStore((s) => s.totalInputTokens + s.totalOutputTokens);
  const running = useStore((s) =>
    s.conversations.some((c) => c.status === 'streaming' || c.status === 'starting')
  );
  // 活跃标签页是否为「空对话」（宠物是否搬家去聊天区）
  const awayToStage = useStore((s) => {
    const c = s.conversations.find((x) => x.id === s.activeConversationId);
    return !!c && c.messages.length === 0 && !c.streamingMessage && c.status === 'idle';
  });

  const [pop, setPop] = useState(0); // 变身弹跳动画的 key
  const [speech, setSpeech] = useState<{ text: string; nonce: number } | null>(null);
  type Mood = 'idle' | 'happy' | 'eating' | 'roll' | 'angry' | 'confused';
  const [mood, setMood] = useState<Mood>('idle');
  const [hearts, setHearts] = useState(0);
  const [night, setNight] = useState(isNightNow);
  const [sleepy, setSleepy] = useState(false); // 生成中挂机打盹

  // 拖拽状态：dragging=跟手移动，flying=松手弹簧飞回
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  // 互动统计（瞬时，不持久化）
  const [pokes, setPokes] = useState<number[]>([]); // 挠痒痒窗口
  const [totalPokes, setTotalPokes] = useState(0);
  const [feeds, setFeeds] = useState<number[]>([]); // 吃撑窗口
  // 周期 tick：驱动「吃撑状态自然过期」（否则组件不重渲染时胖状态会卡住）
  const [, setTick] = useState(0);

  const pickRef = useRef<((l: string[]) => string) | null>(null);
  if (!pickRef.current) pickRef.current = makePicker();
  const pick = pickRef.current;
  const speechTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moodTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (speechTimer.current) clearTimeout(speechTimer.current);
      if (moodTimer.current) clearTimeout(moodTimer.current);
    },
    []
  );

  const say = useCallback((text: string) => {
    if (speechTimer.current) clearTimeout(speechTimer.current);
    setSpeech({ text, nonce: Date.now() });
    speechTimer.current = setTimeout(() => setSpeech(null), 3200);
  }, []);

  const setMoodFor = useCallback((m: Mood, ms: number) => {
    if (moodTimer.current) clearTimeout(moodTimer.current);
    setMood(m);
    moodTimer.current = setTimeout(() => setMood('idle'), ms);
  }, []);

  const happy = useCallback((ms = 1200) => setMoodFor('happy', ms), [setMoodFor]);

  // ── 情绪感知：上下文焦虑（>80% 冒冷汗 + 冷却台词）────────
  const maxCtxRatio = useStore((s) => {
    let m = 0;
    for (const c of s.conversations) {
      const u = c.contextUsage;
      if (u && u.limit > 0) m = Math.max(m, u.used / u.limit);
    }
    return m;
  });
  const anxious = maxCtxRatio >= 0.8;
  const anxiousRef = useRef(false);
  const lastAnxiousAtRef = useRef(0);
  useEffect(() => {
    if (anxious && !anxiousRef.current && Date.now() - lastAnxiousAtRef.current > ANXIOUS_COOLDOWN_MS) {
      say(pick(ANXIOUS_LINES));
      lastAnxiousAtRef.current = Date.now();
    }
    anxiousRef.current = anxious;
  }, [anxious, say, pick]);

  // ── 情绪感知：翻车歪头（error 边沿触发，歪头 3s）─────────
  const anyError = useStore((s) => s.conversations.some((c) => c.status === 'error'));
  const errRef = useRef(false);
  useEffect(() => {
    if (anyError && !errRef.current) {
      say(pick(ERROR_LINES));
      setMoodFor('confused', 3000);
    }
    errRef.current = anyError;
  }, [anyError, say, pick, setMoodFor]);

  // ── 情绪感知：深夜模式（每分钟检查时钟）──────────────────
  useEffect(() => {
    const t = setInterval(() => {
      setNight(isNightNow());
      setTick((n) => n + 1);
    }, NIGHT_TICK_MS);
    return () => clearInterval(t);
  }, []);

  // ── 情绪感知：长任务挂机打盹（生成中 >5min）──────────────
  const runningSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!running) {
      runningSinceRef.current = null;
      setSleepy(false);
      return;
    }
    runningSinceRef.current ??= Date.now();
    const t = setInterval(() => {
      if (runningSinceRef.current && Date.now() - runningSinceRef.current > SLEEPY_AFTER_MS && !sleepy) {
        setSleepy(true);
        say(pick(SLEEPY_LINES));
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [running, sleepy, say, pick]);

  // ── 事件庆祝：升级 / 任务完成（边沿触发）─────────────────
  const { level, name, nextAt, progress } = getPetLevel(totalTokens);
  const info = SPECIES_INFO[species];

  const levelRef = useRef(level);
  useEffect(() => {
    if (level > levelRef.current) {
      say(pick(LEVELUP_LINES));
      setHearts((h) => h + 1);
      happy(1500);
    }
    levelRef.current = level;
  }, [level, say, happy, pick]);

  const runningRef = useRef(running);
  useEffect(() => {
    if (runningRef.current && !running) {
      say(pick(DONE_LINES));
      happy(1400);
    }
    runningRef.current = running;
  }, [running, say, happy, pick]);

  // ── 物理互动：戳一戳 / 挠痒痒 / 不耐烦 ──────────────────
  const poke = useCallback(() => {
    const now = Date.now();
    const win = [...pokes, now].filter((t) => now - t <= TICKLE_WINDOW_MS);
    setPokes(win);
    const total = totalPokes + 1;
    setTotalPokes(total);

    // 连戳太多：不耐烦（优先级最高）
    if (total >= ANGRY_TOTAL && total % 3 === 0) {
      say(pick(ANGRY_LINES));
      setMoodFor('angry', 1600);
      return;
    }
    // 1 秒内 >=5 次：挠痒痒打滚
    if (win.length >= TICKLE_ROLL_COUNT) {
      say(pick(ROLL_LINES));
      setMoodFor('roll', 1100);
      return;
    }
    // 生成中：忙碌台词
    if (running) {
      say(pick(BUSY_LINES));
      return;
    }
    // 深夜：一半概率说夜话
    if (night && Math.random() < 0.5) {
      say(pick(NIGHT_LINES));
      happy();
      return;
    }
    say(pick(CHATTER[species]));
    happy();
  }, [pokes, totalPokes, running, night, species, say, happy, pick, setMoodFor]);

  // ── 物理互动：喂食 / 撑到吃不下 ─────────────────────────
  /** 5 分钟窗口内已喂次数（渲染时实时计算，自然过期恢复身材） */
  const fedCount = feeds.filter((t) => Date.now() - t <= FEED_WINDOW_MS).length;
  const fat = fedCount > 5;

  const feed = useCallback(() => {
    const now = Date.now();
    const win = [...feeds, now].filter((t) => now - t <= FEED_WINDOW_MS);
    setFeeds(win);
    if (win.length > 5) {
      // 第 6 口起：撑到吃不下，只说话不动嘴
      say(pick(FULL_LINES));
      return;
    }
    setMoodFor('eating', 1500);
    setHearts((h) => h + 1);
    say(pick(FEED_LINES[species]));
  }, [feeds, species, say, pick, setMoodFor]);

  // ── 物理互动：拖拽扔出去（弹簧飞回）─────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > CLICK_SLOP_PX) {
      d.moved = true;
      setDragging(true);
    }
    if (d.moved) setDragOffset({ x: dx, y: dy });
  }, []);

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.moved) {
      poke(); // 位移极小 → 视为点击（戳一戳/挠痒痒）
      return;
    }
    // 松手：弹簧飞回原位
    const dist = Math.hypot(dragOffset.x, dragOffset.y);
    setDragging(false);
    setDragOffset({ x: 0, y: 0 }); // transition 弹性曲线收回
    setMoodFor('happy', 700); // 落地弹一下
    say(pick(dist > DRAG_FAR_PX ? DRAG_FAR_LINES : DRAG_NEAR_LINES));
  }, [dragOffset, poke, pick, setMoodFor]);

  const cycle = useCallback(() => {
    const next = SPECIES_INFO[species].next;
    setPetSpecies(next);
    setPop((p) => p + 1);
    say(`变！我是${SPECIES_INFO[next].name}！`);
  }, [species, setPetSpecies, say]);

  // ── 装饰与表情聚合 ───────────────────────────────────────
  const decor: PetDecor = {
    night,
    anxious,
    confused: mood === 'confused',
    angry: mood === 'angry',
    fat,
    laughing: mood === 'roll',
  };
  const mouth: PetMouth = mood === 'angry' ? 'frown' : sleepy ? 'yawn' : 'smile';
  // 打盹：闭眼；歪头由外层容器旋转
  const eyeOpen = !sleepy;
  const tilt = mood === 'confused' ? 'rotate-6' : '';

  // ── 空窝态：宠物搬家去聊天区舞台了 ────────────────────────
  if (awayToStage) {
    return (
      <div
        className="flex items-center gap-2.5 px-2 py-2 rounded-lg bg-bg-light/40 border border-dashed border-border/60 select-none"
        title="宠物去聊天区撒欢了——发条消息它就回来"
      >
        {/* 空窝 */}
        <svg width="40" height="40" viewBox="0 0 64 64" fill="none" className="shrink-0 opacity-70">
          <ellipse cx="32" cy="50" rx="22" ry="9" fill="#8a6b4a" opacity="0.5" />
          <ellipse cx="32" cy="47" rx="22" ry="9" fill="#a5825c" opacity="0.6" />
          <path d="M12 47 q4 -8 8 -9 M52 47 q-4 -8 -8 -9" stroke="#a5825c" strokeWidth="3" strokeLinecap="round" opacity="0.6" />
          <ellipse cx="32" cy="45" rx="12" ry="4.5" fill="#3d2f22" opacity="0.55" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-text-dim leading-snug">
            {info.name}去前台撒欢了
          </div>
          <div className="text-[10px] text-text-dim/70 font-mono mt-0.5">
            发条消息它就回来
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="group/pet flex items-center gap-2.5 px-2 py-1.5 rounded-lg bg-accent-purple/5 border border-accent-purple/20 hover:border-accent-purple/40 transition-all select-none"
      title={`${info.name} · Lv.${level} ${name} · 累计 ${totalTokens.toLocaleString()} tokens${nextAt ? ` · ${nextAt.toLocaleString()} tokens 升级` : ' · 已满级'}\n戳一戳/挠痒痒/拖拽扔出去 · 悬停出现喂食/变身按钮`}
    >
      {/* 宠物本体（拖拽层 → 点击 = 戳一戳） */}
      <div
        role="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative w-11 h-11 flex items-center justify-center shrink-0 cursor-grab active:cursor-grabbing touch-none"
        title="戳一戳 · 拖拽可以扔出去"
      >
        {/* 气泡台词 */}
        {speech && (
          <div
            key={speech.nonce}
            className="pet-speech absolute -top-2 left-9 z-30 max-w-[150px] px-2 py-1 rounded-lg rounded-bl-sm bg-bg-light border border-accent-purple/40 text-[10px] leading-snug text-text-primary whitespace-normal break-words shadow-lg pointer-events-none"
          >
            {speech.text}
          </div>
        )}

        {/* 爱心粒子 */}
        {hearts > 0 && (
          <div key={hearts} className="absolute inset-0 pointer-events-none z-20">
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className="pet-heart"
                style={{ left: `${6 + i * 7}px`, animationDelay: `${i * 0.13}s` }}
              >
                ♥
              </span>
            ))}
          </div>
        )}

        {/* 拖拽/飞回层：跟手时无过渡，松手后弹性曲线飞回 */}
        <div
          className={dragging ? 'z-40' : ''}
          style={{
            transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
            transition: dragging ? 'none' : 'transform .55s cubic-bezier(.34,1.56,.64,1)',
          }}
        >
          <div key={pop} className={pop > 0 ? 'pet-pop' : ''}>
            {/* 歪头层（翻车困惑时旋转 6°） */}
            <div className={`transition-transform duration-300 ${tilt}`}>
              {/* 情绪层：开心/吃东西/打滚/生气 */}
              <div
                className={
                  mood === 'happy'
                    ? 'pet-happy'
                    : mood === 'eating'
                      ? 'pet-eating'
                      : mood === 'roll'
                        ? 'pet-roll'
                        : mood === 'angry'
                          ? 'pet-angry'
                          : ''
                }
              >
                {/* 律动层：生成中蹦跳 / 挂机打盹缓慢呼吸 / 空闲漂浮 */}
                <div className={running ? (sleepy ? 'pet-drowse' : 'pet-bounce') : 'pet-float'}>
                  <PetSVG species={species} eyeOpen={eyeOpen} level={level} blink={!running || sleepy} decor={decor} mouth={mouth} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 睡觉 Zzz（空闲睡觉，或生成中挂机打盹） */}
        {(!running || sleepy) && (
          <div className={`pet-zzz absolute -top-1 -right-0.5 pointer-events-none ${sleepy ? 'pet-zzz-big' : ''}`}>
            <span>z</span>
            <span>z</span>
            <span>z</span>
          </div>
        )}
      </div>

      {/* 信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-primary">{info.name}</span>
          <span className={`text-[10px] font-mono px-1 py-px rounded ${
            level >= 4
              ? 'bg-accent-yellow/15 text-accent-yellow border border-accent-yellow/40'
              : level >= 3
                ? 'bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30'
                : 'bg-bg-light text-text-muted border border-border'
          }`}>
            Lv.{level} {name}
          </span>
        </div>
        {/* 升级进度（吃撑时进度条会跟着变胖卖萌） */}
        <div className={`h-1 mt-1 rounded-full bg-bg-deepest overflow-hidden transition-all ${fat ? 'scale-x-110 origin-left' : ''}`}>
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              level >= 4 ? 'bg-gradient-to-r from-accent-yellow to-accent-orange' : 'bg-accent-purple/70'
            }`}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>

      {/* 互动按钮（hover 出现）：喂食 + 变身 */}
      <div className="flex flex-col gap-1 shrink-0 opacity-0 group-hover/pet:opacity-100 transition-opacity">
        <button
          onClick={feed}
          className={`p-1 rounded-md transition-all ${
            fat
              ? 'text-text-dim/50 cursor-not-allowed'
              : 'text-text-dim hover:text-accent-red hover:bg-accent-purple/10'
          }`}
          title={fat ? '吃撑了，缓一会儿再喂…' : `喂${info.food}（心情会变好哦）`}
        >
          {FOOD_ICONS[species]}
        </button>
        <button
          onClick={cycle}
          className="p-1 rounded-md text-text-dim hover:text-accent-cyan hover:bg-accent-cyan/10 transition-all"
          title={`变身${SPECIES_INFO[SPECIES_INFO[species].next].name}（兔 → 猫 → 熊）`}
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
