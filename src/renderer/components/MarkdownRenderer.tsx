import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const codeStr = String(children).replace(/\n$/, '');

            if (!match && !codeStr.includes('\n')) {
              // 行内代码
              return <code className={className} {...props}>{children}</code>;
            }

            return <CodeBlock code={codeStr} lang={match?.[1] || 'text'} />;
          },
          // 表格包裹
          table({ children }: any) {
            return (
              <div className="overflow-x-auto rounded-lg border border-border/50">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group rounded-lg overflow-hidden border border-border/50 mb-3">
      {/* 代码块头部 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-deep border-b border-border/50">
        <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
          {lang}
        </span>
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-accent-cyan"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-accent-green" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* 代码内容 */}
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: '12px 16px',
          background: '#0a0e17',
          fontSize: '13px',
          fontFamily: "'JetBrains Mono', monospace",
        }}
        codeTagProps={{
          style: { fontFamily: "'JetBrains Mono', monospace" }
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
