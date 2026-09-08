import { useStore } from '../store';

/**
 * 发送一条 prompt 给 CLI：写入 GUI 消息流（store.addUserMessage 会触发强制滚底
 * nonce）并拉起 CLI 进程。
 * 复用方：InputBar 正常发送/队列续发、失败消息的重试按钮——保证三条路径的
 * payload 组装（cwd/sessionId/resume/model/permissionMode）永远一致。
 */
export function sendPrompt(prompt: string): void {
  const s = useStore.getState();
  if (!s.cwd) return;
  s.addUserMessage(prompt);
  // 不 await：claude:send 的 Promise 在整轮对话完成后才 resolve
  void (window as any).api.claude.send({
    prompt,
    cwd: s.cwd,
    sessionId: s.currentSessionId || undefined,
    // 已有会话 ID 时必须用 --resume 续接，否则多轮上下文会丢失
    resume: !!s.currentSessionId,
    options: { ...(s.model ? { model: s.model } : {}), permissionMode: s.permissionMode },
  }).catch((err: unknown) => console.error('Send failed:', err));
}
