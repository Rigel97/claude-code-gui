import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCallView } from '../src/renderer/components/ToolCallView';
import { StatsView } from '../src/renderer/components/StatsView';
import { useStore } from '../src/renderer/store';
import type { UIBlock, Session, ResultMessage } from '../src/renderer/types';
import * as exports from '../src/renderer/utils/exportSession';

type Tool = Extract<UIBlock, { kind: 'tool_use' }>;
const longText = '完整文本'.repeat(1500) + 'LONG_TEXT_END';
const thinking = '推理'.repeat(500) + 'THINKING_END';
const tool = (overrides: Partial<Tool> = {}): Tool => ({
  kind: 'tool_use', toolName: 'Task', toolId: 'parent-id', input: {}, status: 'running', ...overrides,
});
const session = (blocks: UIBlock[], role: 'user' | 'assistant' | 'system' = 'assistant'): Session => ({
  sessionId: 'session-id', cwd: '/project', title: 'Audit', createdAt: 1,
  cost: 1, inputTokens: 2, outputTokens: 3, model: 'model', events: [{ t: 1, cost: 1, input: 2, output: 3 }],
  messages: [{ id: 'message-id', role, timestamp: 2, status: 'completed', blocks }],
});

// 标准 JSON 仅承诺序列化实际 Session，不宣称导出尚未保存的 raw 事件。
describe('会话无损导出', () => {
  it('完整长结果、嵌套结果、输入和 stderr 用足够长的动态 fence', () => {
    const result = longText + '\n```js\ncode\n```\n``````\nRESULT_END';
    const markdown = exports.sessionToMarkdown(session([tool({
      input: { command: 'literal ````` input' }, result,
      children: [tool({ toolId: 'deep-id', result }), { kind: 'thinking', text: thinking }],
    }), { kind: 'stderr', text: 'oops\n````\nSTDERR_END' }]));
    expect(markdown.split(result).length - 1).toBe(2);
    expect(markdown).toContain('```````\n' + result + '\n```````');
    expect(markdown).toContain('``````json\n');
    expect(markdown).toContain('`````\nSTDERR: oops\n````\nSTDERR_END\n`````');
    expect(markdown).toContain(thinking);
    expect(markdown).not.toContain('已截断');
  });

  it.each(['running', 'done', 'error', 'unknown'])('准确输出 %s 状态且 summary 防注入、无装饰 emoji', (status) => {
    const block = { ...tool({ toolName: '<img src=x onerror=alert(1)>', input: { description: '</summary><script>bad</script>' } }), status } as Tool;
    const markdown = exports.sessionToMarkdown(session([block]));
    expect(markdown).toContain({ running: '运行中', done: '已完成', error: '错误', unknown: '未知状态' }[status]!);
    expect(markdown).not.toMatch(/✅|❌|🔧|🤖|🧑|💭|⏱/u);
    const summary = markdown.match(/<summary>(.*?)<\/summary>/)?.[1];
    expect(summary).not.toContain('<img');
    expect(summary).not.toContain('<script>');
    expect(summary).toContain('&lt;img');
    expect(summary).toContain('&lt;/summary&gt;&lt;script&gt;bad&lt;/script&gt;');
    if (status !== 'done') expect(markdown).not.toContain('已完成');
  });

  it('JSON 完整保留 ID、所有 blocks 和已有附件，且不修改输入', () => {
    const attachment = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } };
    const block = { ...tool({ result: longText, children: [{ kind: 'thinking', text: thinking }, tool({ toolId: 'leaf-id', result: longText })] }), resultContent: [attachment] };
    const value = session([{ kind: 'text', text: longText, msgId: 'source-id' }, block, { kind: 'stderr', text: 'stderr' }, { kind: 'stats', data: {} as ResultMessage }], 'user');
    const before = JSON.stringify(value);
    const jsonExporter = (exports as unknown as { sessionToJson: (s: Session) => string }).sessionToJson;
    expect(typeof jsonExporter).toBe('function');
    const json = jsonExporter(value);
    expect(JSON.parse(json)).toEqual(value);
    expect(JSON.parse(json).messages[0].blocks[1].resultContent[0]).toEqual(attachment);
    expect(json).not.toContain('raw');
    expect(JSON.stringify(value)).toBe(before);
    const markdown = exports.sessionToMarkdown(value);
    expect(markdown).toContain('aW1hZ2U=');
    expect(markdown).toContain('LONG_TEXT_END');
    expect(markdown).toContain('THINKING_END');
  });
});

const completeStats: Partial<ResultMessage> = {
  usage: { input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 33, cache_read_input_tokens: 44 },
  duration_ms: 1500, ttft_ms: 25, num_turns: 2,
};
function statsValues(data: unknown): string[] {
  const html = renderToStaticMarkup(<StatsView data={data as ResultMessage} />);
  return [...html.matchAll(/<span class="text-xs font-mono font-semibold [^"]*">(.*?)<\/span>/g)].map(match => match[1]);
}

describe('Stats 指标防御（真实 SSR）', () => {
  it('Total 包含四种 token 用量', () => {
    expect(statsValues(completeStats)).toEqual(['110', '11', '22', '1.5s', '2', '25ms']);
  });

  it.each([undefined, null, {}])('usage %s 不崩溃且缺失值不冒充零', (usage) => {
    expect(statsValues({ usage })).toEqual(['—', '—', '—', '—', '—', '—']);
  });

  it.each([undefined, null, NaN, -1, Infinity, '12'])('指标 %s 无效时一律显示 —', (invalid) => {
    expect(statsValues({ usage: { input_tokens: invalid, output_tokens: invalid, cache_creation_input_tokens: invalid, cache_read_input_tokens: invalid }, duration_ms: invalid, ttft_ms: invalid, num_turns: invalid }))
      .toEqual(['—', '—', '—', '—', '—', '—']);
  });

  it.each(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'])('任一 %s 缺失不得显示不完整 Total', (key) => {
    const usage = { ...completeStats.usage };
    delete usage[key as keyof typeof usage];
    expect(statsValues({ ...completeStats, usage })[0]).toBe('—');
  });

  it('真实零指标保留零；求和溢出不能输出 Infinity', () => {
    expect(statsValues({ usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, duration_ms: 0, ttft_ms: 0, num_turns: 0 }))
      .toEqual(['0', '0', '0', '0.0s', '0', '0ms']);
    expect(statsValues({ ...completeStats, usage: { ...completeStats.usage, input_tokens: Number.MAX_VALUE, output_tokens: Number.MAX_VALUE } })[0]).toBe('—');
  });
});

const initialThinking = useStore.getState().showThinking;
afterEach(() => useStore.getState().setShowThinking(initialThinking));

describe('工具调用可观测性（真实 React）', () => {
  it.each(['Task', 'Agent'])('%s 深嵌套文本和结果保持完整且可复制', (toolName) => {
    const block = tool({ toolName, children: [tool({ toolName: 'Agent', toolId: 'child-id', children: [
      { kind: 'text', text: longText },
      tool({ toolName: 'Write', toolId: 'leaf-id', result: longText }),
    ] })] });
    const html = renderToStaticMarkup(<ToolCallView block={block} />);
    expect(html.split(longText).length - 1).toBe(2);
    expect(html).toContain('复制完整文本');
    expect(html).toContain('复制完整结果');
    expect(html).toContain('overflow-y-auto');
  });

  it('嵌套 thinking 使用折叠思考视图并响应全局开关', () => {
    const block = tool({ children: [tool({ children: [{ kind: 'thinking', text: thinking }] })] });
    useStore.getState().setShowThinking(true);
    const shown = renderToStaticMarkup(<ToolCallView block={block} />);
    expect(shown).toContain('思考过程');
    expect(shown).toContain(`${thinking.length} chars`);
    expect(shown).not.toContain('THINKING_END'); // ThinkingView 初始折叠
    useStore.getState().setShowThinking(false);
    expect(renderToStaticMarkup(<ToolCallView block={block} />)).not.toContain('思考过程');
  });

  it('收起结果时仍有完整复制入口；running 不显示成功标记', () => {
    const html = renderToStaticMarkup(<ToolCallView block={tool({ toolName: 'Bash', result: longText })} />);
    expect(html).toContain('复制完整结果');
    expect(html).not.toContain('lucide-circle-check');
    const runningEdit = renderToStaticMarkup(<ToolCallView block={tool({ toolName: 'Edit', result: 'pending' })} />);
    expect(runningEdit).not.toContain('✓');
  });

  it('可选结构化结果安全读取，附件仍可完整查看/复制', () => {
    const block = { ...tool({ toolName: 'Write' }), resultContent: [
      { type: 'text', text: longText },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    ] };
    const html = renderToStaticMarkup(<ToolCallView block={block} />);
    expect(html).toContain('LONG_TEXT_END');
    expect(html).toContain('image/png');
    expect(html).toContain('aW1hZ2U=');
    expect(html).toContain('复制完整结果');
    const withoutContent = { ...tool(), resultContent: null };
    expect(() => renderToStaticMarkup(<ToolCallView block={withoutContent} />)).not.toThrow();
  });
});
