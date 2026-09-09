import { describe, it, expect, beforeAll } from 'vitest';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 真实 CLI 端到端验证（--include-partial-messages 全链路）：
 * 真实 claude 进程 → runner 事件流 → store 状态机 → 归档结果断言。
 * 验证：delta 逐字构建、完整事件去重（无双倍文本）、工具卡片即时创建+input 回填、
 *       activity 阶段流转、耗时字段。
 *
 * 门控：默认跳过（花真实 API 费用）。手动运行：
 *   RUN_E2E=1 npx vitest run tests/e2e-partial.test.ts
 */
const RUN_E2E = !!process.env.RUN_E2E;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// electron stub：webContents.send 直通（事件由本测试收集）
const captured: { stream: any[]; status: any[] } = { stream: [], status: [] };
const nodeRequire = createRequire(import.meta.url);
const ELECTRON_PATH = nodeRequire.resolve('electron');
const electronStub = {
  BrowserWindow: {
    getAllWindows: () => [{
      webContents: {
        send: (ch: string, data: any) => {
          if (ch === 'claude:stream') captured.stream.push(data);
          else if (ch === 'claude:status') captured.status.push(data);
        },
      },
    }],
  },
};
nodeRequire.cache[ELECTRON_PATH] = {
  id: ELECTRON_PATH,
  filename: ELECTRON_PATH,
  loaded: true,
  exports: electronStub,
} as any;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: any[]) {
  if (request === 'electron') return ELECTRON_PATH;
  return origResolve.call(this, request, ...args);
};

describe.skipIf(!RUN_E2E)('真实 CLI 端到端：partial messages 全链路', () => {
  let ClaudeRunner: any;
  let useStore: any;

  beforeAll(async () => {
    ({ ClaudeRunner } = await import('../src/main/runner.js'));
    ({ useStore } = await import('../src/renderer/store'));
  });

  it('工具循环场景：delta 流式 + 去重 + 卡片回填 + activity + 耗时', async () => {
    // 初始化 store 会话
    useStore.setState({ cwd: '/tmp' });
    const convId = useStore.getState().newConversation();
    // 模拟 sendPrompt 的本地副作用（user 消息 + 流式壳）；deliverPrompt 无 window.api 会静默
    useStore.getState().sendPrompt('用Bash执行 echo hi，然后告诉我输出', convId);
    expect(useStore.getState().conversations.find((c: any) => c.id === convId).streamingMessage).not.toBeNull();

    // 拉起真实 CLI 进程，事件直通 store
    const runner = new ClaudeRunner(convId);
    let streamEventCount = 0; // delta 流量统计（验证 --include-partial-messages 真的生效）
    const sendPromise = runner.send({
      prompt: '用Bash执行 echo hi，然后告诉我输出',
      cwd: '/tmp',
      conversationId: convId,
      options: { permissionMode: 'bypassPermissions' },
    });

    // 泵事件：runner emitStream → captured → store.handleStream
    const pump = () => {
      while (captured.stream.length > 0) {
        const ev = captured.stream.shift();
        if (ev.type === 'stream_event') streamEventCount++;
        useStore.getState().handleStream(ev);
      }
      while (captured.status.length > 0) {
        const st = captured.status.shift();
        useStore.getState().setStatus(st.status, st.conversationId);
      }
    };
    const pumpTimer = setInterval(pump, 20);

    try {
      const r = await sendPromise;
      expect(r.success).toBe(true);
    } finally {
      clearInterval(pumpTimer);
      pump(); // 清空尾部事件
      // 等待最后的 delta 节流 flush（40ms）
      await new Promise((res) => setTimeout(res, 100));
      pump();
    }

    // ── 验证 1：--include-partial-messages 真的生效（delta 流量显著）──
    // 工具循环场景实测 20+ 个 stream_event（input_json_delta + text_delta）
    expect(streamEventCount).toBeGreaterThanOrEqual(5);

    const conv = useStore.getState().conversations.find((c: any) => c.id === convId);
    expect(conv).toBeTruthy();

    // ── 验证 2：轮次完成、反馈条清空 ──
    expect(conv.status).toBe('completed');
    expect(conv.activity).toBeNull();

    // ── 验证 3：归档的 assistant 消息 ──
    const assistantMsgs = conv.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const allText = assistantMsgs.map((m: any) =>
      m.blocks.filter((b: any) => b.kind === 'text').map((b: any) => b.text).join('')
    ).join('\n');

    // ── 验证 4：去重（delta + 完整事件无双倍文本）──
    // CLI 的回复里应恰好包含一次 hi（echo hi 的结果转述）；
    // 若去重失败，'hi' 或整段文本会重复出现
    expect(allText).toContain('hi');
    // 整段文本长度合理性：去重失败时通常翻倍，这里宽松断言非异常膨胀
    // （回复本身不会超过 500 字符的量级）
    expect(allText.length).toBeLessThan(600);

    // ── 验证 5：工具卡片（即时创建 + input 回填 + 耗时）──
    const toolBlocks: any[] = [];
    for (const m of assistantMsgs) {
      for (const b of m.blocks) {
        if (b.kind === 'tool_use') toolBlocks.push(b);
      }
    }
    expect(toolBlocks.length).toBeGreaterThanOrEqual(1);
    const bash = toolBlocks.find((b) => b.toolName === 'Bash');
    expect(bash).toBeTruthy();
    expect(bash.input).toHaveProperty('command');
    expect(String(bash.input.command)).toContain('echo hi');
    expect(bash.status).toBe('done');
    expect(typeof bash.startedAt).toBe('number');
    expect(typeof bash.finishedAt).toBe('number');
    expect(bash.result).toContain('hi');

    // ── 验证 6：文本无双倍（对每个 text 块：内容不应是「X X」式重复）──
    for (const m of assistantMsgs) {
      for (const b of m.blocks) {
        if (b.kind === 'text' && b.text.length >= 4) {
          const half = Math.floor(b.text.length / 2);
          // 前半 === 后半 且长度 > 6 视为翻倍异常（普通文本几乎不可能前后完全一致）
          const doubled = b.text.length > 6 && b.text.slice(0, half) === b.text.slice(half);
          expect(doubled).toBe(false);
        }
      }
    }

    // ── 验证 7：sessions 归档（sessionId 已回填，含 stats 块）──
    expect(conv.sessionId).toBeTruthy();
    const statsBlocks = assistantMsgs.flatMap((m: any) => m.blocks.filter((b: any) => b.kind === 'stats'));
    expect(statsBlocks.length).toBeGreaterThanOrEqual(1);
  }, 60000);
});
