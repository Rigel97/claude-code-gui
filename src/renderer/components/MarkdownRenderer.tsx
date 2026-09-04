import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// PrismLight + 按需注册语言：全量 Prism 会打包所有语言定义（约占 bundle 一半体积）
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
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import { useState, memo } from 'react';
import { Copy, Check } from 'lucide-react';

// 一个语言定义注册到多个常用别名，未注册的语言退化为无高亮纯文本（不报错）
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('zsh', bash);
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
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('md', markdown);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('yml', yaml);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('diff', diff);

// memo：相同 content 跳过重新解析 AST/高亮，流式期间只有活跃块变化
export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: { content: string }) {
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
          // 链接一律不允许窗口内导航：外链交给系统浏览器
          // （主进程 setWindowOpenHandler → openExternal），双保险见 will-navigate 拦截
          a({ node, href, children, ...props }: any) {
            const isExternal = /^https?:\/\//i.test(href || '');
            return (
              <a
                {...props}
                href={isExternal ? href : undefined}
                target={isExternal ? '_blank' : undefined}
                rel="noreferrer"
                onClick={(e) => {
                  if (!isExternal) return;
                  e.preventDefault();
                  window.open(href, '_blank');
                }}
              >
                {children}
              </a>
            );
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
});

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
