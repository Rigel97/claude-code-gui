/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,tsx,ts}'],
  theme: {
    extend: {
      colors: {
        // 科技感深色主题
        bg: {
          deepest: '#05070d',
          deep: '#0a0e17',
          DEFAULT: '#0f1420',
          light: '#161c2e',
          lighter: '#1e2538',
        },
        accent: {
          cyan: '#00e5ff',
          blue: '#3b82f6',
          purple: '#a855f7',
          green: '#10f0a0',
          orange: '#ff8c42',
          red: '#ff4757',
          yellow: '#fbbf24',
        },
        border: {
          DEFAULT: '#1e2538',
          light: '#2a3349',
          glow: '#00e5ff33',
        },
        text: {
          primary: '#e2e8f0',
          secondary: '#a7b4c6',
          muted: '#8290a6',
          // 辅助文字仍需达到 4.5:1；更暗的颜色只用于装饰。
          dim: '#7d8b9f',
        },
      },
      fontSize: {
        // 元数据/角标专用下限；正文最低使用 text-xs，不得再新增 <11px 的文本。
        '2xs': '11px',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'SF Mono', 'Consolas', 'monospace'],
        sans: ['Inter', 'SF Pro Display', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'fade-in': 'fade-in 0.3s ease-out',
        'slide-up': 'slide-up 0.3s ease-out',
        'scan-line': 'scan-line 3s linear infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'blink': 'blink 1s step-end infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 20px #00e5ff44' },
          '50%': { opacity: '0.7', boxShadow: '0 0 40px #00e5ff88' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scan-line': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};
