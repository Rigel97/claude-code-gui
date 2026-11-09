export interface DeliverPayload {
  prompt: string;
  cwd?: string;
  sessionId?: string;
  userMessageId: string;
  resume: boolean;
  interrupt?: boolean;
  options?: Record<string, unknown>;
  conversationId: string;
}
export interface StopResult {
  success: boolean;
  closed?: boolean;
  error?: string;
  stillQueued?: string[];
}
let reportStop: (id: string, result: StopResult) => void = () => {};
export function registerStopHandler(handler: typeof reportStop): void { reportStop = handler; }

export interface DeliverResult {
  success: boolean;
  sessionId?: string;
  userMessageId?: string;
  runId?: string;
  error?: string;
}

/** Browser and Node expose Web Crypto; the fallback still produces RFC 4122 UUIDs. */
export function generateUserMessageId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type ClaudeAPI = {
  send?: (p: DeliverPayload) => Promise<DeliverResult>;
  interrupt?: (id: string) => Promise<StopResult>;
  abort?: (id: string) => Promise<StopResult>;
  close?: (id: string) => Promise<StopResult>;
};
const api = () => (globalThis as { window?: { api?: { claude?: ClaudeAPI } } }).window?.api?.claude;

export async function deliverPrompt(payload: DeliverPayload, onInterrupted?: () => void): Promise<DeliverResult> {
  const claude = api();
  // No host in state-only tests; production has the preload bridge.
  if (!claude?.send) return { success: false, error: 'no-api' };
  try {
    if (payload.interrupt) {
      const stop = claude.interrupt ?? claude.abort;
      if (!stop) throw new Error('Interrupt API unavailable; stop cannot be confirmed');
      const result = await stop(payload.conversationId);
      if (result?.closed) reportStop(payload.conversationId, result);
      if (result?.success !== true) throw new Error(result?.error || 'Interrupt failed; stop cannot be confirmed');
      onInterrupted?.();
    }
    return await claude.send(payload);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function abortConversation(conversationId: string): Promise<StopResult> {
  const claude = api();
  let result: StopResult;
  try {
    const stop = claude?.interrupt ?? claude?.abort;
    result = stop ? await stop(conversationId) : { success: false, error: 'Interrupt API unavailable' };
    if (!result || typeof result.success !== 'boolean') result = { success: false, error: 'Interrupt returned no confirmation' };
  } catch (error) { result = { success: false, error: error instanceof Error ? error.message : String(error) }; }
  reportStop(conversationId, result);
  if (!result.success && !result.closed && claude?.close) {
    try {
      const closed = await claude.close(conversationId);
      result = closed?.success === true ? { success: true, closed: true }
        : { success: false, error: closed?.error || 'Close returned no confirmation' };
    } catch (error) { result = { success: false, error: error instanceof Error ? error.message : String(error) }; }
    reportStop(conversationId, result);
  }
  return result;
}
export function closeRuntime(conversationId: string): void {
  void api()?.close?.(conversationId).catch(() => {});
}
