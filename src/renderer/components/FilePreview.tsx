import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, FileText, Loader2, AlertCircle } from 'lucide-react';
import { useDialogBehavior } from './useDialogBehavior';
// PrismLight + 按需注册：与 MarkdownRenderer 同款策略，避免全量语言打包
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';

SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('js', javascript);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('ts', typescript);
SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('py', python);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('html', markup);
SyntaxHighlighter.registerLanguage('xml', markup);
SyntaxHighlighter.registerLanguage('svg', markup);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('md', markdown);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('yml', yaml);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('java', java);

/** 扩展名 → Prism 语言 */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'css', less: 'css',
  html: 'html', xml: 'xml', svg: 'svg',
  md: 'markdown', markdown: 'markdown',
  py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', go: 'go', rs: 'rust', java: 'java',
};

function formatSize(n: number): string {
  if (n >= 1024 * 1024) return `${+(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

interface PreviewData {
  ok: boolean;
  error?: string;
  kind?: 'text' | 'image' | 'binary';
  offset?: number;
  nextOffset?: number | null;
  version?: string;
  content?: string;
  dataUrl?: string;
  size?: number;
  truncated?: boolean;
}

const PAGE_BYTES = 512 * 1024;
// Defense in depth: the main-process bridge must also enforce file type and executable restrictions.
function safeExternalPath(filePath: string): boolean {
  const local = (filePath.startsWith('/') && !filePath.startsWith('//')) || /^[A-Za-z]:[\\/]/.test(filePath);
  if (!local || filePath.includes('\0') || /(?:^|[\\/])[^\\/]+\.app(?:[\\/]|$)/i.test(filePath)) return false;
  return /\.(?:txt|md|markdown|json|jsonl|csv|tsv|log|yaml|yml|toml|ini|cfg|conf|css|scss|less|html|htm|xml|svg|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|h|cpp|hpp|sql|png|jpe?g|gif|webp|bmp|ico)$/i.test(filePath);
}

/** Local file preview, retaining only the current text page. */
export function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [externalError, setExternalError] = useState('');
  const [opening, setOpening] = useState(false);
  const [history, setHistory] = useState<number[]>([0]);
  const [pageIndex, setPageIndex] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const current = useRef<PreviewData | null>(null);
  const pending = useRef({ offset: 0, index: 0, reset: true });
  const load = useCallback(async (offset: number, index: number, reset = false) => {
    if (busy.current) return;
    busy.current = true;
    const token = generation.current;
    pending.current = { offset, index, reset };
    setLoading(true);
    setError('');
    try {
      const result: PreviewData = await (window as any).api.fs.readFile(path, { offset, limit: PAGE_BYTES });
      if (token !== generation.current) return;
      if (!result || !result.ok) {
        if (!current.current) setData(result || { ok: false });
        throw new Error(result?.error || '无法读取文件');
      }
      const paged = typeof result.offset === 'number' && result.nextOffset !== undefined;
      if (offset > 0 && !paged) throw new Error('当前连接不支持分页，请回到首页');
      if (paged && (result.offset !== offset || (result.nextOffset !== null && (!Number.isSafeInteger(result.nextOffset) || result.nextOffset! <= offset || result.nextOffset! > (result.size ?? 0))))) throw new Error('分页偏移无效，请回到首页');
      if (!reset && current.current && ((result.version && current.current.version && result.version !== current.current.version) || result.size !== current.current.size)) throw new Error('文件已变化，请回到首页重新读取（当前仍为旧页）');
      if (result.kind === 'text' && new TextEncoder().encode(result.content || '').length > PAGE_BYTES) throw new Error('返回文本超过单页 512KB 限制');
      current.current = result;
      setData(result);
      setPageIndex(index);
      setHistory(previous => reset ? [0] : [...previous.slice(0, index), offset]);
    } catch (reason) {
      if (token === generation.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
        if (!current.current) setData(previous => previous?.ok === false ? previous : { ok: false });
      }
    } finally {
      if (token === generation.current) { busy.current = false; setLoading(false); }
    }
  }, [path]);
  useEffect(() => {
    generation.current++;
    busy.current = false;
    current.current = null;
    setData(null);
    setHistory([0]);
    setPageIndex(0);
    setExternalError('');
    setOpening(false);
    void load(0, 0, true);
    return () => { generation.current++; busy.current = false; };
  }, [load]);
  const openExternal = async () => {
    if (!safeExternalPath(path) || opening) return;
    const token = generation.current;
    setOpening(true);
    setExternalError('');
    try {
      const bridge = (window as any).api.fs;
      if (typeof bridge.openExternal !== 'function') throw new Error('当前连接不支持外部打开');
      const result = await bridge.openExternal(path);
      if (result === false || (typeof result === 'string' && result) || result?.ok === false || result?.error) throw new Error(result?.error || (typeof result === 'string' ? result : '外部打开失败'));
    } catch (reason) {
      if (token === generation.current) setExternalError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (token === generation.current) setOpening(false); }
  };

  // Esc 关闭（统一弹层契约：只关闭最上层，并管理焦点陷阱与归还）
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogBehavior({ open: true, dialogRef, onRequestClose: onClose, initialFocusSelector: '[aria-label="关闭文件预览"]' });

  const fileName = path.split(/[\\/]/).pop() || path;
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  const lang = useMemo(() => EXT_LANG[ext], [ext]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      data-file-preview="true"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="文件预览"
        className="w-[85vw] max-w-4xl h-[80vh] glass-panel rounded-2xl border border-border light overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 shrink-0">
          <FileText className="w-4 h-4 text-accent-cyan shrink-0" />
          <span className="text-sm font-mono text-text-primary truncate flex-1" title={path}>
            {fileName}
          </span>
          <span className="text-2xs font-mono text-text-dim shrink-0">
            {typeof data?.size === 'number' ? formatSize(data.size) : ''}
          </span>
          <button disabled={!safeExternalPath(path) || opening} onClick={() => void openExternal()} title={safeExternalPath(path) ? '使用本地默认应用打开' : '仅允许安全的本地文本或图片路径，主进程还会校验文件类型'} className="text-xs text-accent-cyan disabled:opacity-40">在外部打开</button>
          <button onClick={onClose} aria-label="关闭文件预览" className="text-text-muted hover:text-text-primary shrink-0 ml-1" title="关闭 (Esc)">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && <div role="alert" className="px-4 py-2 text-xs text-accent-orange">{error} <button disabled={loading} onClick={() => void load(pending.current.offset, pending.current.index, pending.current.reset)} className="underline">重试</button> <button disabled={loading} onClick={() => void load(0, 0, true)} className="underline">回到首页</button></div>}
        {externalError && <div role="alert" className="px-4 py-2 text-xs text-accent-orange">{externalError}</div>}
        {loading && data !== null && <div role="status" className="text-xs px-4">正在读取，当前显示仍为已加载页</div>}
        {/* 内容 */}
        <div key={`${path}:${pageIndex}`} className="flex-1 overflow-auto">
          {data === null ? (
            <div className="flex items-center justify-center h-full text-text-dim">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : !data.ok || data.kind === 'binary' ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
              <AlertCircle className="w-6 h-6 text-accent-orange/70" />
              <div className="text-xs text-text-muted">{error ? '无法预览；可重试或请求在外部打开（由安全策略校验）' : data.error || '无法读取文件'}</div>
            </div>
          ) : data.kind === 'image' ? (
            <div className="flex items-center justify-center h-full p-4">
              <img
                src={data.dataUrl}
                alt={fileName}
                className="max-w-full max-h-full object-contain rounded-lg"
              />
            </div>
          ) : (
            <div className="relative">
              {(data.content || '').length > 32 * 1024 ? <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-words">{data.content || ''}</pre> : <SyntaxHighlighter
                language={lang || 'text'}
                style={oneDark}
                showLineNumbers
                customStyle={{
                  margin: 0,
                  padding: '12px 0',
                  background: 'transparent',
                  fontSize: '12px',
                }}
                codeTagProps={{ style: { fontFamily: 'JetBrains Mono, Fira Code, monospace' } }}
              >
                {data.content || ''}
              </SyntaxHighlighter>}
            </div>
          )}
        </div>
        {data?.ok && data.kind === 'text' && <div className="shrink-0 border-t border-border/50 px-4 py-2 text-xs text-text-muted">
          {typeof data.offset === 'number' && data.nextOffset !== undefined ? <div className="flex flex-wrap items-center gap-3">
            <button disabled={loading || pageIndex === 0} onClick={() => void load(history[pageIndex - 1], pageIndex - 1)}>上一页</button>
            <span>第 {pageIndex + 1} 页 · 字节 {data.offset}–{data.offset + new TextEncoder().encode(data.content || '').length} / {data.size} · 每页最多 512KB{data.nextOffset === null ? ' · 已到末尾' : ''}</span>
            <button disabled={loading || data.nextOffset === null} onClick={() => data.nextOffset != null && void load(data.nextOffset, pageIndex + 1)}>下一页</button>
            <button disabled={loading} onClick={() => void load(0, 0, true)}>回到首页</button>
          </div> : <span>{data.truncated ? '当前连接不支持分页，仅显示已返回的部分文本；可在外部打开' : '当前连接返回的文本预览（不支持分页）'}</span>}
        </div>}
      </div>
    </div>
  );
}
