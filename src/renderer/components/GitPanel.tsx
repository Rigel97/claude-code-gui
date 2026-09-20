import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../store';
import {
  GitBranch, RefreshCw, Loader2, FileEdit, FilePlus, FileMinus, FileQuestion,
  ChevronDown, ChevronRight, Undo2, Sparkles,
} from 'lucide-react';
import type { UIBlock } from '../types';

interface GitChange {
  path: string;
  change: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
}

interface GitStatusResult {
  repo: boolean;
  branch?: string;
  changes?: GitChange[];
}

const CHANGE_META: Record<GitChange['change'], { label: string; icon: React.ReactNode; cls: string }> = {
  modified: { label: 'M', icon: <FileEdit className="w-3 h-3" />, cls: 'text-accent-orange' },
  added: { label: 'A', icon: <FilePlus className="w-3 h-3" />, cls: 'text-accent-green' },
  deleted: { label: 'D', icon: <FileMinus className="w-3 h-3" />, cls: 'text-accent-red' },
  renamed: { label: 'R', icon: <FileEdit className="w-3 h-3" />, cls: 'text-accent-purple' },
  untracked: { label: '?', icon: <FileQuestion className="w-3 h-3" />, cls: 'text-text-dim' },
};

/** 回滚仅对已跟踪文件有意义（untracked/added 无工作区基线可恢复） */
const canRevert = (c: GitChange) =>
  c.change === 'modified' || c.change === 'deleted';

/**
 * Git 变更面板：项目工作区状态 + Claude 本次会话改动标记。
 * 点击条目展开单文件 unified diff；modified/deleted 可单文件回滚（二次确认）。
 */
export function GitPanel({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  // 活跃标签页状态：轮次结束后自动刷新（Claude 刚改完文件立即可见）
  const convStatus = useStore((s) => {
    const c = s.conversations.find((x) => x.id === s.activeConversationId);
    return c?.status ?? 'idle';
  });

  // Claude 本次会话触碰过的文件（相对 cwd）
  const touchedFiles = useTouchedFiles(cwd);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await (window as any).api.git.status(cwd);
      setStatus(r);
    } catch {
      setStatus({ repo: false });
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
    setExpandedPath(null);
    setConfirmRevert(null);
    setRevertError(null);
  }, [refresh, convStatus]);

  const toggleDiff = async (path: string) => {
    if (expandedPath === path) {
      setExpandedPath(null);
      return;
    }
    setExpandedPath(path);
    if (diffs[path] === undefined) {
      const d = await (window as any).api.git.diff(cwd, path);
      setDiffs((prev) => ({ ...prev, [path]: typeof d === 'string' ? d : '' }));
    }
  };

  const handleRevert = async (path: string) => {
    setConfirmRevert(null);
    setRevertError(null);
    const r = await (window as any).api.git.checkoutFile(cwd, path);
    if (r?.ok) {
      // 回滚成功：刷新状态并收起该行 diff
      setExpandedPath(null);
      setDiffs((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
      void refresh();
    } else {
      setRevertError(r?.error || '回滚失败');
    }
  };

  const changes = status?.changes ?? [];

  return (
    <div className="px-2 pb-2">
      {/* 标题栏：分支 + 刷新 */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 text-[10px] text-text-dim font-mono uppercase tracking-wider">
          <GitBranch className="w-3 h-3 text-accent-cyan" />
          {status?.repo && status.branch ? status.branch : 'Git'}
        </span>
        <button
          onClick={() => void refresh()}
          className="text-text-dim hover:text-accent-cyan transition-colors"
          title="刷新 Git 状态"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </button>
      </div>

      {status === null ? (
        <div className="flex items-center justify-center py-6 text-text-dim">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : !status.repo ? (
        <div className="text-xs text-text-dim px-3 py-4 text-center leading-relaxed">
          当前目录不是 Git 仓库
        </div>
      ) : changes.length === 0 ? (
        <div className="text-xs text-text-dim px-3 py-4 text-center">工作区干净，无变更</div>
      ) : (
        <div className="space-y-px">
          {changes.map((c) => {
            const meta = CHANGE_META[c.change];
            const touched = touchedFiles.has(c.path);
            const expanded = expandedPath === c.path;
            const confirming = confirmRevert === c.path;
            return (
              <div key={c.path}>
                <div
                  onClick={() => void toggleDiff(c.path)}
                  className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer transition-colors group ${
                    confirming ? 'bg-red-500/10 border border-red-500/40' : 'hover:bg-bg-light'
                  }`}
                  title={c.path}
                >
                  {expanded
                    ? <ChevronDown className="w-3 h-3 text-text-dim shrink-0" />
                    : <ChevronRight className="w-3 h-3 text-text-dim shrink-0" />}
                  <span className={`shrink-0 ${meta.cls}`}>{meta.icon}</span>
                  <span className="text-xs truncate font-mono text-text-muted group-hover:text-text-primary flex-1 text-left">
                    {c.path.split('/').pop()}
                    {c.path.includes('/') && (
                      <span className="text-text-dim/70"> · {c.path.split('/').slice(0, -1).join('/')}</span>
                    )}
                  </span>
                  {/* Claude 本次会话改过 */}
                  {touched && (
                    <span
                      className="flex items-center gap-0.5 text-[9px] font-mono text-accent-cyan/90 px-1 py-0.5 rounded bg-accent-cyan/10 border border-accent-cyan/20 shrink-0"
                      title="Claude 在本次会话中修改过此文件"
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      AI
                    </span>
                  )}
                  {c.staged && (
                    <span className="text-[9px] font-mono text-text-dim px-1 py-0.5 rounded border border-border shrink-0" title="已暂存">
                      staged
                    </span>
                  )}
                  {/* 回滚（hover 显示；仅已跟踪的修改/删除） */}
                  {confirming ? (
                    <span className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => void handleRevert(c.path)}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 border border-red-500/50 text-red-300 transition-all"
                        title="确认回滚此文件的改动"
                      >
                        回滚?
                      </button>
                      <button
                        onClick={() => setConfirmRevert(null)}
                        className="text-[10px] text-text-muted hover:text-text-primary px-1"
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    canRevert(c) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setRevertError(null);
                          setConfirmRevert(c.path);
                        }}
                        className="text-text-dim hover:text-accent-orange opacity-0 group-hover:opacity-100 transition-all shrink-0"
                        title="回滚此文件的工作区改动（不可恢复）"
                      >
                        <Undo2 className="w-3.5 h-3.5" />
                      </button>
                    )
                  )}
                </div>

                {/* 展开的 unified diff */}
                {expanded && (
                  <div className="mx-1 mb-1 rounded-lg border border-border/50 bg-bg-deepest/70 overflow-hidden">
                    {diffs[c.path] === undefined ? (
                      <div className="flex items-center justify-center py-3 text-text-dim">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      </div>
                    ) : diffs[c.path] === '' ? (
                      <div className="text-[11px] text-text-dim font-mono px-3 py-2.5">
                        {c.change === 'untracked' ? '未跟踪的新文件，无 diff' : '暂无可展示的差异'}
                      </div>
                    ) : (
                      <UnifiedDiff text={diffs[c.path]} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {revertError && (
            <div className="text-[10px] text-accent-red/90 font-mono px-2 pt-1 truncate" title={revertError}>
              {revertError}
            </div>
          )}
        </div>
      )}

      <div className="text-[10px] text-text-dim/60 font-mono px-2 pt-2 leading-relaxed">
        点击条目查看 diff · AI 标记 = Claude 本次会话修改
      </div>
    </div>
  );
}

/** unified diff 渲染（git diff 原文按行着色） */
function UnifiedDiff({ text }: { text: string }) {
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  return (
    <pre className="text-[11px] font-mono leading-relaxed overflow-x-auto max-h-72 overflow-y-auto px-2 py-1.5 selectable-text">
      {lines.map((line, i) => {
        let cls = 'text-text-muted';
        let bg = '';
        if (line.startsWith('@@')) {
          cls = 'text-accent-cyan';
        } else if (line.startsWith('+')) {
          cls = 'text-accent-green';
          bg = 'bg-accent-green/5';
        } else if (line.startsWith('-')) {
          cls = 'text-accent-red/90';
          bg = 'bg-accent-red/5';
        } else if (line.startsWith('diff ') || line.startsWith('index ')) {
          cls = 'text-text-dim';
        }
        return (
          <div key={i} className={`${cls} ${bg} whitespace-pre px-1`}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

/** 从活跃会话消息中收集 Claude 触碰过的文件（相对 cwd 的路径集合）。
 *  选择器返回稳定引用（数组/对象引用仅在对应会话变化时更新），避免无关 store 更新触发重渲染 */
function useTouchedFiles(cwd: string): Set<string> {
  const convCwd = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.cwd);
  const messages = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.messages);
  const streaming = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.streamingMessage);

  return useMemo(() => {
    const out = new Set<string>();
    if (!messages || convCwd !== cwd) return out;
    const walk = (blocks: UIBlock[]) => {
      for (const b of blocks) {
        if (b.kind !== 'tool_use') continue;
        if (
          b.toolName === 'Edit' || b.toolName === 'Write' ||
          b.toolName === 'MultiEdit' || b.toolName === 'NotebookEdit'
        ) {
          const fp = b.input?.file_path;
          if (typeof fp === 'string' && fp) {
            const rel = fp.startsWith(cwd + '/') ? fp.slice(cwd.length + 1) : fp;
            out.add(rel);
          }
        }
        if (b.children) walk(b.children);
      }
    };
    for (const m of messages) walk(m.blocks);
    if (streaming) walk(streaming.blocks);
    return out;
  }, [messages, streaming, convCwd, cwd]);
}
