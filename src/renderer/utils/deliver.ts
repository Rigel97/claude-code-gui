/**
 * 底层 IPC 发送（不依赖 store，避免循环引用；store 的 sendPrompt 动作基于此）。
 * 测试环境下 window.api 不存在时静默跳过（单测只验证状态机，不验证 IPC）。
 */
export interface DeliverPayload {
  prompt: string;
  cwd: string;
  sessionId?: string;
  resume: boolean;
  options: Record<string, unknown>;
  conversationId: string;
}

export function deliverPrompt(payload: DeliverPayload): Promise<unknown> {
  const api = (globalThis as { window?: { api?: { claude?: { send?: (p: unknown) => Promise<unknown> } } } })?.window?.api;
  if (typeof api?.claude?.send === 'function') {
    // 不 await：claude:send 的 Promise 在整轮对话完成后才 resolve
    return api.claude.send(payload).catch((err: unknown) => {
      console.error('Send failed:', err);
      return { success: false, error: String(err) };
    });
  }
  return Promise.resolve({ success: false, error: 'no-api' });
}

/** 中断指定对话的生成（多标签页各自的 runner） */
export function abortConversation(conversationId: string): void {
  const api = (globalThis as { window?: { api?: { claude?: { abort?: (id: string) => Promise<unknown> } } } })?.window?.api;
  if (typeof api?.claude?.abort === 'function') {
    void api.claude.abort(conversationId).catch(() => { /* 中断失败静默 */ });
  }
}
