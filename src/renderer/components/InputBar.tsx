import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../store';
import { Send, Square, Loader2, Sparkles } from 'lucide-react';

// ─── 斜杠命令定义 ──────────────────────────────────────
interface SlashCommand {
  cmd: string;
  desc: string;
  /** 内置动作（本地执行，不发送给 Claude） */
  action?: 'clear';
  /** 提示词模板（填入输入框，用户可补充后再发送） */
  prompt?: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/clear', desc: '清空当前对话，开始新会话', action: 'clear' },
  { cmd: '/commit', desc: '查看 git 改动并生成 commit message', prompt: '请查看当前的 git 改动（git status 和 git diff），然后为我生成一条规范的 commit message。' },
  { cmd: '/review', desc: '审查代码，指出问题与改进建议', prompt: '请审查以下代码，指出潜在问题、代码异味和改进建议：\n\n' },
  { cmd: '/explain', desc: '解释代码的工作原理', prompt: '请详细解释以下代码的工作原理：\n\n' },
  { cmd: '/fix', desc: '修复代码中的 bug', prompt: '请帮我修复以下代码中的问题：\n\n' },
  { cmd: '/test', desc: '为代码生成单元测试', prompt: '请为以下代码编写完善的单元测试：\n\n' },
  { cmd: '/doc', desc: '为代码生成文档注释', prompt: '请为以下代码生成清晰的文档注释：\n\n' },
  { cmd: '/refactor', desc: '重构代码，提升可读性', prompt: '请重构以下代码，提升可读性与可维护性，保持行为不变：\n\n' },
  { cmd: '/optimize', desc: '分析并优化性能', prompt: '请分析以下代码的性能瓶颈并给出优化方案：\n\n' },
];

export function InputBar({ onSend }: { onSend: (text: string) => void }) {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const cwd = useStore((s) => s.cwd);
  const sessionId = useStore((s) => s.currentSessionId);
  const status = useStore((s) => s.status);
  const model = useStore((s) => s.model);
  const currentModel = useStore((s) => s.currentModel);
  const permissionMode = useStore((s) => s.permissionMode);
  const injectedText = useStore((s) => s.injectedText);
  const newSession = useStore((s) => s.newSession);
  const displayModel = model || currentModel;

  const isStreaming = status === 'streaming' || status === 'starting';

  // 斜杠命令过滤（输入以 / 开头且单行时触发）
  const slashMatch = /^\/(\S*)$/.exec(input);
  const filteredCommands = slashMatch
    ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(`/${slashMatch[1]}`))
    : [];
  const showSlash = slashOpen && filteredCommands.length > 0;

  // 消费外部注入的文本（文件树 @引用）
  useEffect(() => {
    if (!injectedText) return;
    setInput((prev) => prev + injectedText.text);
    textareaRef.current?.focus();
  }, [injectedText]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming) return;

    const prompt = input.trim();
    setInput('');
    setSlashOpen(false);
    setIsLoading(true);

    // 通知 store 添加用户消息
    onSend(prompt);

    // 自动调整高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      await (window as any).api.claude.send({
        prompt,
        cwd,
        sessionId: sessionId || undefined,
        options: { ...(model ? { model } : {}), permissionMode },
      });
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, [input, isStreaming, cwd, sessionId, model, permissionMode, onSend]);

  const handleAbort = useCallback(() => {
    (window as any).api.claude.abort();
  }, []);

  // 选中斜杠命令
  const selectCommand = useCallback((cmd: SlashCommand) => {
    setSlashOpen(false);
    if (cmd.action === 'clear') {
      newSession();
      setInput('');
      return;
    }
    setInput(cmd.prompt || '');
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 200) + 'px';
      }
    });
  }, [newSession]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 斜杠面板打开时，优先响应面板导航
    if (showSlash) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectCommand(filteredCommands[slashIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }

    // ESC 中断生成
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      handleAbort();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 自动调整 textarea 高度 + 斜杠面板开关
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    setSlashOpen(/^\/\S*$/.test(value));
    setSlashIndex(0);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  return (
    <div className="px-6 py-4 border-t border-border/30 bg-bg-deep/50 backdrop-blur-sm">
      <div className="relative">
        {/* 斜杠命令面板 */}
        {showSlash && (
          <div className="absolute bottom-full left-0 right-0 mb-2 glass-panel rounded-xl border border-border overflow-hidden z-20 animate-fade-in">
            <div className="px-3 py-1.5 border-b border-border/30 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-accent-cyan" />
              <span className="text-[10px] text-text-dim font-mono uppercase tracking-wider">快捷命令</span>
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.cmd}
                  onClick={() => selectCommand(cmd)}
                  onMouseEnter={() => setSlashIndex(i)}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                    i === slashIndex ? 'bg-accent-cyan/10' : 'hover:bg-bg-light'
                  }`}
                >
                  <span className={`text-xs font-mono font-semibold shrink-0 ${
                    i === slashIndex ? 'text-accent-cyan' : 'text-text-secondary'
                  }`}>
                    {cmd.cmd}
                  </span>
                  <span className="text-xs text-text-muted truncate">{cmd.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 输入框容器 */}
        <div className={`relative rounded-2xl border transition-all input-focus-glow ${
          isStreaming
            ? 'border-accent-yellow/40 bg-accent-yellow/5'
            : 'border-border bg-bg-light hover:border-accent-cyan/30 focus-within:border-accent-cyan/50 focus-within:tech-glow-cyan'
        }`}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? 'Claude 正在生成中... (ESC 中断)' : '输入指令，/ 唤起快捷命令，Enter 发送'}
            disabled={isStreaming}
            rows={1}
            className="w-full bg-transparent text-sm text-text-primary placeholder-text-dim resize-none px-4 py-3 pr-28 max-h-48 overflow-y-auto font-sans disabled:cursor-not-allowed"
            style={{ minHeight: '44px' }}
          />

          {/* 按钮区域 */}
          <div className="absolute right-2 bottom-2 flex items-center gap-2">
            {/* 模型指示器 */}
            {displayModel && (
              <span className="text-[10px] font-mono text-text-dim px-2 py-1 rounded bg-bg-deeper/50">
                {displayModel}
              </span>
            )}

            {isStreaming ? (
              <button
                onClick={handleAbort}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-red/20 hover:bg-accent-red/30 border border-accent-red/40 text-accent-red transition-all"
              >
                <Square className="w-3.5 h-3.5" fill="currentColor" />
                <span className="text-xs font-medium">停止</span>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-gradient-to-r from-accent-cyan/20 to-accent-blue/20 hover:from-accent-cyan/30 hover:to-accent-blue/30 border border-accent-cyan/40 hover:border-accent-cyan/60 text-accent-cyan transition-all disabled:opacity-30 disabled:cursor-not-allowed group send-btn-glow"
              >
                {isLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                )}
                <span className="text-xs font-medium">发送</span>
              </button>
            )}
          </div>
        </div>

        {/* 底部提示 */}
        <div className="flex items-center justify-between mt-2 px-2">
          <div className="flex items-center gap-3 text-[10px] text-text-dim font-mono">
            <span>⏎ 发送</span>
            <span>⇧⏎ 换行</span>
            <span>/ 命令</span>
            {isStreaming && <span className="text-accent-red/70">ESC 中断</span>}
            <span className="text-accent-cyan/50">● {sessionId ? sessionId.slice(0, 8) : 'new session'}</span>
          </div>
          <div className="text-[10px] text-text-dim font-mono">
            {input.length > 0 && `${input.length} chars`}
          </div>
        </div>
      </div>
    </div>
  );
}
