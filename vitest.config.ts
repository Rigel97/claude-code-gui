import { defineConfig } from 'vitest/config';

// 独立于 vite.config.ts（那份的 root 指向 src/renderer，仅服务于应用构建）
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx,js}'],
    environment: 'node',
    // 每个浏览器用例都会独立拉起 Vite + Chromium。并行 worker 会在同一台
    // 机器上争抢 CPU/端口，导致 page.goto 与稳定性检查超时假失败；串行执行
    // 的实测总耗时更短（约 70s），因此固定单 worker。
    maxWorkers: 1,
    // runner 生命周期测试涉及真实子进程与 2s SIGKILL 兜底，放宽超时
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
