// ─── 宠物共享模块：物种/台词/SVG 身体与装饰 ───────────
// 侧栏 TokenPet 与聊天区 PetStage 共用，保证两个舞台是「同一只宠物」
import type { PetSpecies } from '../types';

/** 等级按累计 token 用量演进 */
const LEVELS: { min: number; name: string }[] = [
  { min: 0, name: '幼崽' },
  { min: 100_000, name: '成长' },
  { min: 1_000_000, name: '进化' },
  { min: 5_000_000, name: '完全体' },
];

export function getPetLevel(totalTokens: number) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (totalTokens >= LEVELS[i].min) idx = i;
  }
  const next = LEVELS[idx + 1];
  const prev = LEVELS[idx];
  const progress = next
    ? Math.min(1, (totalTokens - prev.min) / (next.min - prev.min))
    : 1;
  return { level: idx + 1, name: LEVELS[idx].name, nextAt: next?.min ?? null, progress };
}

export const SPECIES_INFO: Record<
  PetSpecies,
  { name: string; next: PetSpecies; food: string }
> = {
  bunny: { name: '小兔', next: 'cat', food: '胡萝卜' },
  cat: { name: '小猫', next: 'bear', food: '小鱼干' },
  bear: { name: '小熊', next: 'bunny', food: '曲奇' },
};

/** 各物种配色：毛色/内耳/特征色 */
export const SPECIES_COLORS: Record<PetSpecies, { fur: string; furDark: string; inner: string; muzzle: string }> = {
  bunny: { fur: '#e6e1f0', furDark: '#c9bce8', inner: '#f7c8d8', muzzle: '#f1eef8' },
  cat: { fur: '#f5c78a', furDark: '#d99a55', inner: '#f7a8b8', muzzle: '#fbe4c4' },
  bear: { fur: '#c99b6e', furDark: '#a87d52', inner: '#e3b98c', muzzle: '#e8cba4' },
};

const EYE = '#3a3344';

// ─── 台词库 ─────────────────────────────────────
/** 日常闲聊（点击宠物随机说） */
export const CHATTER: Record<PetSpecies, string[]> = {
  bunny: [
    '今天的代码像胡萝卜一样甜！',
    '耳朵雷达已开启，随时接收需求~',
    '蹦蹦跳跳去改 bug！',
    '长耳朵能听见远处的报错声',
    '别看我在睡觉，token 涨了我就知道',
  ],
  cat: [
    '喵？终于来撩我了',
    '呼噜呼噜… 这个环境很舒服',
    '代码就是我的猫抓板',
    '午睡结束，开始营业',
    '有 bug？交给我这只夜行生物',
  ],
  bear: [
    '蜂蜜…想吃蜂蜜…',
    '熊熊抱抱！',
    '我的手掌能拍扁一切 bug',
    '冬眠是不可能冬眠的',
    '别看我胖，重构代码可灵活了',
  ],
};

export const BUSY_LINES = ['在忙！别戳！', 'token 火力全开中…', '马上就好啦，等我！', '让子弹再飞一会儿~'];
export const FEED_LINES: Record<PetSpecies, string[]> = {
  bunny: ['胡萝卜！我的最爱！', '咔嚓咔嚓，甜！'],
  cat: ['小鱼干，回味无穷~', '喵呜~ 还有吗？'],
  bear: ['曲奇配蜂蜜，绝了！', '唔姆唔姆…满足'],
};
export const LEVELUP_LINES = ['哇！我感觉变强了！', '叮——升级！', '又长大了一点点！'];
export const DONE_LINES = ['搞定收工！', '任务完成，快夸我！', '呼——跑完这一单了'];

// ─── 新增：情绪感知台词 ─────────────────────────
/** 深夜（0-6 点）被戳 */
export const NIGHT_LINES = ['都几点了还不睡…', '夜深了，代码明天再写嘛', '陪你熬，但眼睛快睁不开了', '凌晨的 bug 最狡猾，小心'];
/** 上下文占用过高 */
export const ANXIOUS_LINES = ['这个对话吃太撑了…', '上下文快满了，要不要 compact？', '水位好高，我有点慌'];
/** 生成中超时打盹 */
export const SLEEPY_LINES = ['跑这么久，我先眯会儿…', '呼啊——好长一单…', '你忙你的，我睡我的'];
/** 有标签页翻车 */
export const ERROR_LINES = ['咦？是不是翻车了？', '刚才那声 crash 你听见了吗', '别慌，先看看报错信息'];

// ─── 新增：物理互动台词 ─────────────────────────
/** 被拖拽扔出去 */
export const DRAG_FAR_LINES = ['好晕…下次轻点扔…', '啊——我飞得好远！'];
export const DRAG_NEAR_LINES = ['吓死我了！', '放我下来！', '飞出去又弹回来！'];
/** 挠痒痒打滚 */
export const ROLL_LINES = ['哈哈哈别挠了！', '痒痒痒痒痒！', '要笑死了哈哈哈哈'];
/** 连戳太多次不耐烦 */
export const ANGRY_LINES = ['戳够了没有！！', '再戳我要生气了！', '爪子给你，自己戳！'];
/** 撑到吃不下 */
export const FULL_LINES = ['吃不下了…明天再喂', '肚子要爆炸了！', '唔…胖得跳不动了'];

// ─── 新增：舞台台词 ─────────────────────────────
/** 搬到大舞台登场 */
export const STAGE_LINES = ['哇，好大的地方！', '终于不用挤在小栏里了', '这里可以撒欢跑圈！'];

/** 随机台词挑选器（避免连续重复同一句） */
export function makePicker() {
  let last = '';
  return (lines: string[]) => {
    if (lines.length === 1) return lines[0];
    let t = lines[Math.floor(Math.random() * lines.length)];
    let guard = 0;
    while (t === last && guard++ < 8) {
      t = lines[Math.floor(Math.random() * lines.length)];
    }
    last = t;
    return t;
  };
}

/** 当前是否深夜（0:00 - 6:00） */
export function isNightNow(): boolean {
  const h = new Date().getHours();
  return h >= 0 && h < 6;
}

// ─── SVG 装饰系统 ───────────────────────────────

/** 情绪装饰（叠加渲染，互不冲突） */
export interface PetDecor {
  /** 深夜：睡帽 + 黑眼圈 */
  night?: boolean;
  /** 上下文焦虑：冒冷汗 */
  anxious?: boolean;
  /** 困惑：头顶问号（歪头在外层容器处理） */
  confused?: boolean;
  /** 生气：V 形眉 */
  angry?: boolean;
  /** 吃太饱：横向变胖（以底部中心放大） */
  fat?: boolean;
  /** 笑到打滚：大笑嘴 + 笑泪 */
  laughing?: boolean;
}

/** 嘴型 */
export type PetMouth = 'smile' | 'yawn' | 'frown';

/** 宠物 SVG（64×64 视口，物种 + 眼睛/嘴型 + 等级饰品 + 情绪装饰） */
export function PetSVG({
  species,
  eyeOpen,
  level,
  blink,
  decor = {},
  mouth = 'smile',
}: {
  species: PetSpecies;
  eyeOpen: boolean;
  level: number;
  blink: boolean;
  decor?: PetDecor;
  mouth?: PetMouth;
}) {
  const c = SPECIES_COLORS[species];
  const body = (
    <>
      {species === 'bunny' && <BunnyBody c={c} />}
      {species === 'cat' && <CatBody c={c} />}
      {species === 'bear' && <BearBody c={c} />}

      {/* 眼睛（笑到打滚时眯成 ^^） */}
      <g className={blink ? 'pet-blink' : undefined}>
        {eyeOpen ? (
          decor.laughing ? (
            <>
              <path d="M24.5 33.5 q2 -2.6 4 0" stroke={EYE} strokeWidth="1.6" strokeLinecap="round" fill="none" />
              <path d="M35.5 33.5 q2 -2.6 4 0" stroke={EYE} strokeWidth="1.6" strokeLinecap="round" fill="none" />
            </>
          ) : (
            <>
              <circle cx="26.5" cy="33" r="2" fill={EYE} />
              <circle cx="37.5" cy="33" r="2" fill={EYE} />
              <circle cx="27.2" cy="32.3" r="0.65" fill="#fff" />
              <circle cx="38.2" cy="32.3" r="0.65" fill="#fff" />
            </>
          )
        ) : (
          <>
            <path d="M24.5 33.5 q2 2.2 4 0" stroke={EYE} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M35.5 33.5 q2 2.2 4 0" stroke={EYE} strokeWidth="1.6" strokeLinecap="round" />
          </>
        )}
      </g>

      {/* 深夜黑眼圈（眼下淡淡阴影） */}
      {decor.night && (
        <>
          <ellipse cx="26.5" cy="35.6" rx="2.4" ry="1" fill="#5b5470" opacity="0.4" />
          <ellipse cx="37.5" cy="35.6" rx="2.4" ry="1" fill="#5b5470" opacity="0.4" />
        </>
      )}

      {/* 生气眉（V 形） */}
      {decor.angry && (
        <>
          <path d="M23.5 28.5 L28.5 30.5" stroke={EYE} strokeWidth="1.6" strokeLinecap="round" />
          <path d="M40.5 28.5 L35.5 30.5" stroke={EYE} strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}

      {/* 鼻子 */}
      <ellipse cx="32" cy="37" rx="1.5" ry="1.1" fill="#e88aa0" />

      {/* 嘴（按情绪） */}
      {mouth === 'smile' && (
        <path d="M32 38.2 q-1.6 2 -3.2 0 M32 38.2 q1.6 2 3.2 0" stroke={EYE} strokeWidth="1.1" strokeLinecap="round" fill="none" />
      )}
      {mouth === 'yawn' && <ellipse cx="32" cy="39.2" rx="2.2" ry="2.6" fill="#7a5c68" />}
      {mouth === 'frown' && (
        <path d="M29 40.2 q3 -2.2 6 0" stroke={EYE} strokeWidth="1.2" strokeLinecap="round" fill="none" />
      )}

      {/* 腮红 */}
      <ellipse cx="21.5" cy="38" rx="2.4" ry="1.5" fill="#f49bb3" opacity="0.45" />
      <ellipse cx="42.5" cy="38" rx="2.4" ry="1.5" fill="#f49bb3" opacity="0.45" />

      {/* 笑泪（打滚时眼角水滴） */}
      {decor.laughing && (
        <>
          <ellipse cx="22.5" cy="35" rx="1" ry="1.4" fill="#7dd3fc" opacity="0.85" />
          <ellipse cx="41.5" cy="35" rx="1" ry="1.4" fill="#7dd3fc" opacity="0.85" />
        </>
      )}

      {/* 焦虑冷汗滴（右上角，闪烁动画） */}
      {decor.anxious && (
        <path
          className="pet-sweat"
          d="M48 22 q2.2 3.4 0 5 q-2.2 -1.6 0 -5 Z"
          fill="#7dd3fc"
          opacity="0.9"
        />
      )}

      {/* 困惑问号（头顶，浮动动画） */}
      {decor.confused && (
        <text
          className="pet-question"
          x="49"
          y="20"
          fontSize="11"
          fontWeight="700"
          fill="#fbbf24"
          fontFamily="JetBrains Mono, monospace"
        >
          ?
        </text>
      )}

      {/* 深夜睡帽（圆锥 + 绒球） */}
      {decor.night && (
        <g>
          <path d="M22 20 Q32 4 42 20 Q32 16 22 20 Z" fill="#5b6ee8" opacity="0.92" />
          <path d="M21 20.5 Q32 17 43 20.5 Q32 23.5 21 20.5 Z" fill="#4857c9" />
          <circle cx="32" cy="6.5" r="3" fill="#eef1ff" />
          {level >= 4 && <circle cx="38.5" cy="9.5" r="1.8" fill="#fbbf24" opacity="0.9" />}
        </g>
      )}

      {/* Lv2+ 小围巾 */}
      {level >= 2 && (
        <g>
          <rect x="24" y="45" width="16" height="4" rx="2" fill={species === 'bunny' ? '#00e5ff' : species === 'cat' ? '#ff8c42' : '#a855f7'} opacity="0.85" />
          <rect x="34" y="47" width="4" height="6" rx="1.5" fill={species === 'bunny' ? '#00e5ff' : species === 'cat' ? '#ff8c42' : '#a855f7'} opacity="0.7" />
        </g>
      )}

      {/* Lv4 皇冠（深夜戴睡帽时不叠加，避免穿模） */}
      {level >= 4 && !decor.night && (
        <path
          d="M26 16.5 L28.5 12.5 L32 15.5 L35.5 12.5 L38 16.5 Z"
          fill="#fbbf24" stroke="#d97706" strokeWidth="0.8"
        />
      )}
    </>
  );

  return (
    <svg width="44" height="44" viewBox="0 0 64 64" fill="none">
      {/* Lv3+ 进化光环 */}
      {level >= 3 && (
        <circle
          className="pet-ring"
          cx="32" cy="34" r="28"
          stroke={level >= 4 ? '#fbbf24' : '#00e5ff'}
          strokeWidth="1.5"
          strokeDasharray="6 8"
          opacity="0.55"
        />
      )}

      {/* 变胖：以底部中心横向放大 */}
      {decor.fat ? (
        <g transform="translate(32 62) scale(1.22 1) translate(-32 -62)">{body}</g>
      ) : (
        body
      )}
    </svg>
  );
}

/** 兔子身体：长耳朵 + 圆头 + 身体 + 尾巴 */
function BunnyBody({ c }: { c: typeof SPECIES_COLORS.bunny }) {
  return (
    <g>
      <ellipse cx="25.5" cy="13" rx="4.2" ry="11" fill={c.fur} transform="rotate(-9 25.5 13)" />
      <ellipse cx="38.5" cy="13" rx="4.2" ry="11" fill={c.fur} transform="rotate(9 38.5 13)" />
      <ellipse cx="25.5" cy="14" rx="2" ry="7.5" fill={c.inner} transform="rotate(-9 25.5 14)" />
      <ellipse cx="38.5" cy="14" rx="2" ry="7.5" fill={c.inner} transform="rotate(9 38.5 14)" />
      <ellipse cx="32" cy="53" rx="11" ry="8" fill={c.fur} />
      <circle cx="32" cy="34" r="14" fill={c.fur} />
      <circle cx="43.5" cy="53" r="3.2" fill="#ffffff" opacity="0.9" />
      <ellipse cx="26" cy="59.5" rx="4" ry="2.4" fill={c.muzzle} />
      <ellipse cx="38" cy="59.5" rx="4" ry="2.4" fill={c.muzzle} />
    </g>
  );
}

/** 猫身体：三角耳 + 条纹 + 胡须 + 尾巴 */
function CatBody({ c }: { c: typeof SPECIES_COLORS.bunny }) {
  return (
    <g>
      <path
        d="M42 52 q9 -2 8 -11 q-0.5 -4 -4.5 -4"
        stroke={c.fur} strokeWidth="4.5" strokeLinecap="round" fill="none"
      />
      <path d="M43 52 q7 -2 6.2 -9" stroke={c.furDark} strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.6" />
      <ellipse cx="32" cy="53" rx="10.5" ry="8" fill={c.fur} />
      <path d="M19.5 25 L21.5 10.5 L30 18.5 Z" fill={c.fur} />
      <path d="M44.5 25 L42.5 10.5 L34 18.5 Z" fill={c.fur} />
      <path d="M22 22.5 L23 14.5 L28 19 Z" fill={c.inner} />
      <path d="M42 22.5 L41 14.5 L36 19 Z" fill={c.inner} />
      <circle cx="32" cy="34" r="14" fill={c.fur} />
      <path d="M28.5 21.5 q1 3 0.5 5 M32 20.5 q0.8 3 0.3 5.5 M35.5 21.5 q-0.6 3 -0.9 5" stroke={c.furDark} strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.75" />
      <path d="M18 34 h-6 M18.5 37.5 l-5.5 2 M46 34 h6 M45.5 37.5 l5.5 2" stroke="#ffffffcc" strokeWidth="1" strokeLinecap="round" />
      <ellipse cx="26" cy="59.5" rx="3.8" ry="2.3" fill={c.inner} />
      <ellipse cx="38" cy="59.5" rx="3.8" ry="2.3" fill={c.inner} />
    </g>
  );
}

/** 熊身体：圆耳 + 口鼻 */
function BearBody({ c }: { c: typeof SPECIES_COLORS.bunny }) {
  return (
    <g>
      <ellipse cx="32" cy="53" rx="11.5" ry="8.5" fill={c.fur} />
      <circle cx="21" cy="22.5" r="5.5" fill={c.fur} />
      <circle cx="43" cy="22.5" r="5.5" fill={c.fur} />
      <circle cx="21" cy="22.5" r="2.6" fill={c.inner} />
      <circle cx="43" cy="22.5" r="2.6" fill={c.inner} />
      <circle cx="32" cy="34" r="14.5" fill={c.fur} />
      <ellipse cx="32" cy="39" rx="6.5" ry="5" fill={c.muzzle} />
      <ellipse cx="26" cy="59.5" rx="4.2" ry="2.5" fill={c.muzzle} />
      <ellipse cx="38" cy="59.5" rx="4.2" ry="2.5" fill={c.muzzle} />
    </g>
  );
}
