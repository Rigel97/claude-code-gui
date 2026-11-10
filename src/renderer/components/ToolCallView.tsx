import { useState, useEffect, useSyncExternalStore } from 'react';
import { useStore } from '../store';
import { ThinkingView } from './ThinkingView';
import type { UIBlock } from '../types';
import { DiffView } from './DiffView';
import {
  Terminal, FileEdit, FileSearch, FilePlus, FileMinus,
  ChevronDown, ChevronRight, Loader, CheckCircle, XCircle,
  Globe, Search, GitBranch, Wrench, Bot, ListTodo
} from 'lucide-react';

function formatElapsed(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** 运行中工具的耗时（每秒 tick）；完成后显示总耗时（静态） */
function ToolElapsed({ startedAt, finishedAt }: { startedAt?: number; finishedAt?: number }) {
  const [, setTick] = useState(0);
  const running = !finishedAt;

  useEffect(() => {
    if (!running || !startedAt) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  if (!startedAt) return null;
  const end = finishedAt ?? Date.now();
  return (
    <span className="text-2xs font-mono text-text-dim shrink-0" title={finishedAt ? '总耗时' : '已运行'}>
      {formatElapsed(end - startedAt)}
    </span>
  );
}

const TOOL_ICONS: Record<string, React.ReactNode> = {
  Bash: <Terminal className="w-4 h-4" />,
  Edit: <FileEdit className="w-4 h-4" />,
  Write: <FilePlus className="w-4 h-4" />,
  Read: <FileSearch className="w-4 h-4" />,
  NotebookEdit: <FileEdit className="w-4 h-4" />,
  WebFetch: <Globe className="w-4 h-4" />,
  WebSearch: <Search className="w-4 h-4" />,
  Task: <Wrench className="w-4 h-4" />,
  // CLI 2.x 子代理工具已从 Task 改名为 Agent（实测 2.1.229）
  Agent: <Bot className="w-4 h-4" />,
  TodoWrite: <ListTodo className="w-4 h-4" />,
};

const TOOL_COLORS: Record<string, string> = {
  Bash: 'text-accent-green border-accent-green/30 bg-accent-green/5',
  Edit: 'text-accent-orange border-accent-orange/30 bg-accent-orange/5',
  Write: 'text-accent-cyan border-accent-cyan/30 bg-accent-cyan/5',
  Read: 'text-accent-blue border-accent-blue/30 bg-accent-blue/5',
  WebFetch: 'text-accent-purple border-accent-purple/30 bg-accent-purple/5',
  WebSearch: 'text-accent-purple border-accent-purple/30 bg-accent-purple/5',
  Task: 'text-accent-yellow border-accent-yellow/30 bg-accent-yellow/5',
  Agent: 'text-accent-yellow border-accent-yellow/30 bg-accent-yellow/5',
  TodoWrite: 'text-accent-purple border-accent-purple/30 bg-accent-purple/5',
};

export function ToolCallView({ block, depth = 0 }: { block: Extract<UIBlock, { kind: 'tool_use' }>; depth?: number }) {
  // Edit/Write 类工具与含子调用的 Task 默认展开，一眼看到改动/子代理活动
  const [expanded, setExpanded] = useState(() => isEditTool(block.toolName) || !!block.children?.length);
  const showThinking = useSyncExternalStore(
    useStore.subscribe,
    () => useStore.getState().showThinking,
    () => useStore.getState().showThinking,
  );
  // 保持现有类型不变；后续 store 的结构化结果（包括附件）以 unknown 安全读取。
  const extra: unknown = (block as unknown as Record<string, unknown>).resultContent;
  const structuredResult = extra == null ? undefined : typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2);
  const result = [block.result, structuredResult].filter((value): value is string => typeof value === 'string').join('\n\n');
  const hasResult = typeof block.result === 'string' || structuredResult !== undefined;

  const icon = TOOL_ICONS[block.toolName] || <Wrench className="w-4 h-4" />;
  const colorClass = TOOL_COLORS[block.toolName] || 'text-text-secondary border-border bg-bg-light';

  // 摘要：根据工具类型生成简洁描述
  const summary = generateSummary(block.toolName, block.input);

  // 提取 diff 数据（Edit / Write / MultiEdit / NotebookEdit）
  const diffs = extractDiffs(block.toolName, block.input);

  // 子代理（Task）的嵌套调用
  const children = block.children;
  const childToolCount = children?.filter((c) => c.kind === 'tool_use').length ?? 0;

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

        {/* 子代理调用计数徽标 */}
        {childToolCount > 0 && (
          <span className="text-2xs font-mono px-1.5 py-0.5 rounded bg-accent-yellow/10 border border-accent-yellow/30 text-accent-yellow shrink-0">
            {childToolCount} 子调用
          </span>
        )}

        {/* 状态指示器 + 耗时 */}
        {block.status === 'running' && <Loader className="w-3.5 h-3.5 animate-spin text-accent-yellow shrink-0" />}
        {block.status === 'done' && <CheckCircle className="w-3.5 h-3.5 text-accent-green shrink-0" />}
        {block.status === 'error' && <XCircle className="w-3.5 h-3.5 text-accent-red shrink-0" />}
        <ToolElapsed startedAt={block.startedAt} finishedAt={block.finishedAt} />
      </button>

      {hasResult && <div className="px-3 pb-2"><CopyText text={result} label="复制完整结果" /></div>}

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
              <div className="text-2xs text-text-dim font-mono uppercase mb-1">INPUT</div>
              <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap overflow-x-auto selectable-text">
                {JSON.stringify(block.input, null, 2)}
              </pre>
            </div>
          )}

          {/* 结果 */}
          {hasResult && (
            <div>
              <div className="text-2xs text-text-dim font-mono uppercase mb-1">RESULT</div>
              <ToolResult result={result} isError={block.status === 'error'} />
            </div>
          )}

          {/* 子代理调用树（Task 嵌套的子调用） */}
          {children && children.length > 0 && (
            <div>
              <div className="text-2xs text-text-dim font-mono uppercase mb-1">SUBAGENT</div>
              <div className="space-y-1.5 border-l-2 border-accent-yellow/30 pl-2.5">
                {children.map((child, i) =>
                  child.kind === 'tool_use' ? (
                    <ToolCallView key={i} block={child} depth={depth + 1} />
                  ) : child.kind === 'text' ? (
                    <div key={i}>
                      <CopyText text={child.text} label="复制完整文本" />
                      <div className="text-xs text-text-muted font-mono whitespace-pre-wrap leading-relaxed px-1 py-0.5 selectable-text max-h-64 overflow-y-auto">
                        {child.text}
                      </div>
                    </div>
                  ) : child.kind === 'thinking' && showThinking ? (
                    <ThinkingView key={i} text={child.text} />
                  ) : null
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CopyText({ text, label }: { text: string; label: string }) {
  const [feedback, setFeedback] = useState('');
  return (
    <button
      type="button"
      aria-label={label}
      className="text-2xs font-mono text-text-secondary hover:text-text-primary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setFeedback('已复制');
        } catch {
          setFeedback('复制失败，请展开后选择文本复制');
        }
      }}
    >
      {label}{feedback ? ` · ${feedback}` : ''}
    </button>
  );
}

function ToolResult({ result, isError }: { result: string; isError: boolean }) {
  // 大结果只使用原文 pre，不送入语法高亮；滚动限制高度而非截断数据。
  return (
    <div className="rounded-lg p-2 bg-bg-deep border border-border/50 max-h-64 overflow-y-auto">
      <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto selectable-text ${isError ? 'text-accent-red/80' : 'text-text-secondary'}`}>
        {result}
      </pre>
    </div>
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
    case 'Agent':
      return (input.description as string) || '';
    case 'TodoWrite': {
      // 摘要显示任务进度（如「3/7 已完成」）
      const todos = Array.isArray(input.todos) ? (input.todos as { status?: string }[]) : [];
      if (todos.length === 0) return '';
      const done = todos.filter((t) => t.status === 'completed').length;
      return `${done}/${todos.length} 已完成`;
    }
    default:
      return Object.values(input).map(String).join(' ').slice(0, 80);
  }
}
