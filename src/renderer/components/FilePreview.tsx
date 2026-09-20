import { useState, useEffect, useMemo } from 'react';
import { X, FileText, Loader2, AlertCircle } from 'lucide-react';
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
  kind?: 'text' | 'image';
  content?: string;
  dataUrl?: string;
  size?: number;
  truncated?: boolean;
}

/**
 * 文件预览弹层：文本（语法高亮，512KB 截断）/ 图片（dataURL）。
 * Esc 或点击遮罩关闭。
 */
export function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [data, setData] = useState<PreviewData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    (window as any).api.fs.readFile(path).then((r: PreviewData) => {
      if (!cancelled) setData(r);
    });
    return () => { cancelled = true; };
  }, [path]);

  // Esc 关闭（capture 阶段拦截：避免同时触发输入框的「Esc 中断生成」）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const fileName = path.split('/').pop() || path;
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  const lang = useMemo(() => EXT_LANG[ext], [ext]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[85vw] max-w-4xl h-[80vh] glass-panel rounded-2xl border border-border light overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 shrink-0">
          <FileText className="w-4 h-4 text-accent-cyan shrink-0" />
          <span className="text-sm font-mono text-text-primary truncate flex-1" title={path}>
            {fileName}
          </span>
          <span className="text-[10px] font-mono text-text-dim shrink-0">
            {typeof data?.size === 'number' ? formatSize(data.size) : ''}
          </span>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary shrink-0 ml-1" title="关闭 (Esc)">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-auto">
          {data === null ? (
            <div className="flex items-center justify-center h-full text-text-dim">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : !data.ok ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
              <AlertCircle className="w-6 h-6 text-accent-orange/70" />
              <div className="text-xs text-text-muted">{data.error || '无法读取文件'}</div>
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
              <SyntaxHighlighter
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
              </SyntaxHighlighter>
              {data.truncated && (
                <div className="sticky bottom-0 bg-bg-deep/95 border-t border-accent-orange/30 px-4 py-1.5 text-[10px] font-mono text-accent-orange/90">
                  文件超过 512KB，仅显示前 512KB 内容
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
