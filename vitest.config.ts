import { defineConfig } from 'vitest/config';

// 独立于 vite.config.ts（那份的 root 指向 src/renderer，仅服务于应用构建）
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx,js}'],
    environment: 'node',
    // runner 生命周期测试涉及真实子进程与 2s SIGKILL 兜底，放宽超时
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
