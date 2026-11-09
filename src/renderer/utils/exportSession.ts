import type { Session, UIBlock, ResultMessage } from '../types';

/** 序列化当前保存的完整会话，包括嵌套 blocks 和实际存在的附件字段。 */
export function sessionToJson(session: Session): string {
  return JSON.stringify(session, null, 2);
}

/** 将会话导出为 Markdown 文本 */
export function sessionToMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push(`# ${session.title}`, '');

  const meta = [
    `会话创建：${new Date(session.createdAt).toLocaleString()}`,
    `Tokens：${(session.inputTokens + session.outputTokens).toLocaleString()}（in ${session.inputTokens.toLocaleString()} / out ${session.outputTokens.toLocaleString()}）`,
  ];
  if (session.model) meta.push(`模型：${session.model}`);
  meta.push(`目录：\`${session.cwd}\``);
  lines.push(`> ${meta.join(' · ')}`, '', '---', '');

  for (const msg of session.messages) {
    lines.push(`## ${msg.role === 'user' ? 'User' : msg.role === 'system' ? 'System' : 'Claude'}`, '');
    renderBlocks(msg.blocks, lines);
  }

  lines.push('---', '', `*导出于 Claude GUI · ${new Date().toLocaleString()}*`);
  return lines.join('\n');
}

function renderBlocks(blocks: UIBlock[], lines: string[]): void {
  for (const b of blocks) {
    switch (b.kind) {
      case 'text':
        lines.push(b.text, '');
        break;
      case 'thinking':
        lines.push('<details><summary>思考过程</summary>', '', b.text, '', '</details>', '');
        break;
      case 'tool_use': {
        const summary = toolSummary(b.input);
        const status = b.status === 'done' ? '已完成' : b.status === 'error' ? '错误' : b.status === 'running' ? '运行中' : '未知状态';
        lines.push(
          `<details><summary>${status} ${escapeHtml(b.toolName)}${summary ? ` — ${escapeHtml(summary)}` : ''}</summary>`,
          '', '**输入**', '',
        );
        appendFence(lines, JSON.stringify(b.input, null, 2), 'json');
        if (typeof b.result === 'string') {
          lines.push('**结果**', '');
          appendFence(lines, b.result);
        }
        const extra: unknown = (b as unknown as Record<string, unknown>).resultContent;
        if (extra != null) {
          lines.push('**结构化结果 / 附件**', '');
          appendFence(lines, typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2), typeof extra === 'string' ? '' : 'json');
        }
        lines.push('</details>', '');
        if (b.children?.length) {
          lines.push('**子代理调用**', '');
          renderBlocks(b.children, lines);
        }
        break;
      }
      case 'notice':
        lines.push(`**CLI 事件：${escapeHtml(b.text)}**`, '');
        appendFence(lines, JSON.stringify(b.raw, null, 2), 'json');
        break;
      case 'stderr':
        appendFence(lines, `STDERR: ${b.text}`);
        break;
      case 'stats': {
        const d: Partial<ResultMessage> = b.data;
        const dur = validMetric(d.duration_ms) ? `${(d.duration_ms / 1000).toFixed(1)}s` : '—';
        const turns = metric(d.num_turns);
        lines.push(`*耗时 ${dur} · ${turns} 轮 · in ${metric(d.usage?.input_tokens)} / out ${metric(d.usage?.output_tokens)} tokens*`, '');
        break;
      }
    }
  }
}

function toolSummary(input: Record<string, unknown>): string {
  const key = [input.command, input.file_path, input.description, input.query, input.url]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  return key?.slice(0, 60) ?? '';
}

function appendFence(lines: string[], text: string, language = ''): void {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  lines.push(fence + language, text, fence, '');
}

function validMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function metric(value: unknown): string {
  return validMetric(value) ? value.toLocaleString() : '—';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
