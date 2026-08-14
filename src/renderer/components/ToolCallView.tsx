import { useState } from 'react';
import type { UIBlock } from '../types';
import { DiffView } from './DiffView';
import {
  Terminal, FileEdit, FileSearch, FilePlus, FileMinus,
  ChevronDown, ChevronRight, Loader, CheckCircle, XCircle,
  Globe, Search, GitBranch, Wrench
} from 'lucide-react';

const TOOL_ICONS: Record<string, React.ReactNode> = {
  Bash: <Terminal className="w-4 h-4" />,
  Edit: <FileEdit className="w-4 h-4" />,
  Write: <FilePlus className="w-4 h-4" />,
  Read: <FileSearch className="w-4 h-4" />,
  NotebookEdit: <FileEdit className="w-4 h-4" />,
  WebFetch: <Globe className="w-4 h-4" />,
  WebSearch: <Search className="w-4 h-4" />,
  Task: <Wrench className="w-4 h-4" />,
};

const TOOL_COLORS: Record<string, string> = {
  Bash: 'text-accent-green border-accent-green/30 bg-accent-green/5',
  Edit: 'text-accent-orange border-accent-orange/30 bg-accent-orange/5',
  Write: 'text-accent-cyan border-accent-cyan/30 bg-accent-cyan/5',
  Read: 'text-accent-blue border-accent-blue/30 bg-accent-blue/5',
  WebFetch: 'text-accent-purple border-accent-purple/30 bg-accent-purple/5',
  WebSearch: 'text-accent-purple border-accent-purple/30 bg-accent-purple/5',
  Task: 'text-accent-yellow border-accent-yellow/30 bg-accent-yellow/5',
};

export function ToolCallView({ block }: { block: Extract<UIBlock, { kind: 'tool_use' }> }) {
  // Edit/Write 类工具默认展开 diff，一眼看到改动
  const [expanded, setExpanded] = useState(() => isEditTool(block.toolName));

  const icon = TOOL_ICONS[block.toolName] || <Wrench className="w-4 h-4" />;
  const colorClass = TOOL_COLORS[block.toolName] || 'text-text-secondary border-border bg-bg-light';

  // 摘要：根据工具类型生成简洁描述
  const summary = generateSummary(block.toolName, block.input);

  // 提取 diff 数据（Edit / Write / MultiEdit / NotebookEdit）
  const diffs = extractDiffs(block.toolName, block.input);

  return (
    <div className={`rounded-xl border overflow-hidden ${colorClass} animate-fade-in`}>
      {/* 头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        <span className="shrink-0">{icon}</span>
        <span className="text-xs font-mono font-semibold uppercase tracking-wider">{block.toolName}</span>
        <span className="text-xs text-text-secondary truncate flex-1 text-left font-mono">{summary}</span>

        {/* 状态指示器 */}
        {block.status === 'running' && <Loader className="w-3.5 h-3.5 animate-spin text-accent-yellow shrink-0" />}
        {block.status === 'done' && <CheckCircle className="w-3.5 h-3.5 text-accent-green shrink-0" />}
        {block.status === 'error' && <XCircle className="w-3.5 h-3.5 text-accent-red shrink-0" />}
      </button>

      {/* 展开内容 */}
      {expanded && (
        <div className="border-t border-border/30 px-3 py-2 space-y-2 bg-bg-deepest/50">
          {/* diff 视图（编辑类工具优先展示） */}
          {diffs ? (
            <div className="space-y-2">
              {diffs.map((d, i) => (
                <DiffView
                  key={i}
                  oldText={d.oldText}
                  newText={d.newText}
                  label={diffs.length > 1 ? `第 ${i + 1} 处修改` : (block.input.file_path as string) || undefined}
                />
              ))}
            </div>
          ) : (
            /* 输入参数 */
            <div>
              <div className="text-[10px] text-text-dim font-mono uppercase mb-1">INPUT</div>
              <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap overflow-x-auto">
                {JSON.stringify(block.input, null, 2)}
              </pre>
            </div>
          )}

          {/* 结果 */}
          {block.result && (
            <div>
              <div className="text-[10px] text-text-dim font-mono uppercase mb-1">RESULT</div>
              <ToolResult result={block.result} toolName={block.toolName} isError={block.status === 'error'} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolResult({ result, toolName, isError }: { result: string; toolName: string; isError: boolean }) {
  // Edit / Write 工具的结果可能包含 diff 信息
  if ((toolName === 'Edit' || toolName === 'Write') && result.includes('File updated')) {
    return (
      <div className="text-xs font-mono text-accent-green/80">
        ✓ {result}
      </div>
    );
  }

  // Bash 输出
  if (toolName === 'Bash') {
    return (
      <div className={`rounded-lg p-2 bg-bg-deep border border-border/50 ${isError ? 'border-accent-red/30' : ''}`}>
        <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto ${isError ? 'text-accent-red/80' : 'text-text-secondary'}`}>
          {result}
        </pre>
      </div>
    );
  }

  // Read 输出
  if (toolName === 'Read') {
    return (
      <div className="rounded-lg p-2 bg-bg-deep border border-border/50 max-h-64 overflow-y-auto">
        <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap">
          {result}
        </pre>
      </div>
    );
  }

  // 默认
  return (
    <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto ${isError ? 'text-accent-red/80' : 'text-text-secondary'}`}>
      {result}
    </pre>
  );
}

function isEditTool(toolName: string): boolean {
  return toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit';
}

/** 从工具入参中提取 diff 数据 */
function extractDiffs(
  toolName: string,
  input: Record<string, unknown>
): { oldText: string; newText: string }[] | null {
  if (toolName === 'Edit' && typeof input.old_string === 'string') {
    return [{ oldText: input.old_string, newText: typeof input.new_string === 'string' ? input.new_string : '' }];
  }
  if (toolName === 'NotebookEdit' && typeof input.new_source === 'string') {
    return [{ oldText: typeof input.old_source === 'string' ? input.old_source : '', newText: input.new_source }];
  }
  if (toolName === 'Write' && typeof input.content === 'string') {
    // Write 视场景而定：全部内容按新增展示
    return [{ oldText: '', newText: input.content }];
  }
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    const diffs = (input.edits as Record<string, unknown>[])
      .filter((e) => typeof e.old_string === 'string')
      .map((e) => ({
        oldText: e.old_string as string,
        newText: typeof e.new_string === 'string' ? (e.new_string as string) : '',
      }));
    return diffs.length > 0 ? diffs : null;
  }
  return null;
}

function generateSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return (input.command as string)?.slice(0, 80) || '';
    case 'Read':
      return (input.file_path as string) || '';
    case 'Write':
      return (input.file_path as string) || '';
    case 'Edit':
      return (input.file_path as string) || '';
    case 'WebSearch':
      return (input.query as string) || '';
    case 'WebFetch':
      return (input.url as string) || '';
    case 'Task':
      return (input.description as string) || '';
    default:
      return Object.values(input).map(String).join(' ').slice(0, 80);
  }
}
