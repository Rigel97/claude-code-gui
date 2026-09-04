import type { Session, UIBlock } from '../types';

/** 将会话导出为 Markdown 文本 */
export function sessionToMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push(`# ${session.title}`, '');

  const meta = [
    `会话创建：${new Date(session.createdAt).toLocaleString()}`,
    `成本：$${session.cost.toFixed(4)}`,
    `Tokens：${(session.inputTokens + session.outputTokens).toLocaleString()}`,
  ];
  if (session.model) meta.push(`模型：${session.model}`);
  meta.push(`目录：\`${session.cwd}\``);
  lines.push(`> ${meta.join(' · ')}`, '', '---', '');

  for (const msg of session.messages) {
    if (msg.role === 'user') {
      lines.push('## 🧑 User', '');
      for (const b of msg.blocks) {
        if (b.kind === 'text') lines.push(b.text, '');
      }
    } else {
      lines.push('## 🤖 Claude', '');
      renderBlocks(msg.blocks, lines);
    }
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
        lines.push('<details><summary>💭 思考过程</summary>', '', b.text, '', '</details>', '');
        break;

      case 'tool_use': {
        const summary = toolSummary(b.toolName, b.input);
        const statusIcon = b.status === 'error' ? '❌' : '✅';
        lines.push(
          `<details><summary>${statusIcon} 🔧 ${b.toolName}${summary ? ` — ${escapeHtml(summary)}` : ''}</summary>`,
          '',
          '**输入**',
          '',
          '```json',
          JSON.stringify(b.input, null, 2),
          '```',
          ''
        );
        if (b.result) {
          lines.push('**结果**', '', '```', truncate(b.result, 3000), '```', '');
        }
        lines.push('</details>', '');
        if (b.children && b.children.length > 0) {
          lines.push('**子代理调用**', '');
          renderBlocks(b.children, lines);
        }
        break;
      }

      case 'stderr':
        lines.push('```', `STDERR: ${b.text}`, '```', '');
        break;

      case 'stats': {
        // 字段防御：CLI 版本间字段可能缺失，避免导出时 toFixed 抛错
        const d = b.data as Partial<{ duration_ms: number; total_cost_usd: number; num_turns: number }>;
        const dur = typeof d.duration_ms === 'number' ? (d.duration_ms / 1000).toFixed(1) : '-';
        const cst = typeof d.total_cost_usd === 'number' ? d.total_cost_usd.toFixed(4) : '0.0000';
        const turns = typeof d.num_turns === 'number' ? d.num_turns : '-';
        lines.push(`*⏱ 耗时 ${dur}s · 成本 $${cst} · ${turns} 轮*`, '');
        break;
      }
    }
  }
}

function toolSummary(toolName: string, input: Record<string, unknown>): string {
  const key =
    (input.command as string) ||
    (input.file_path as string) ||
    (input.description as string) ||
    (input.query as string) ||
    (input.url as string) ||
    '';
  return key.slice(0, 60);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\n… (已截断)' : text;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
