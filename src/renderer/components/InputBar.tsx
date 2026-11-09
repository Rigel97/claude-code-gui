import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../store';
import { Send, Square, Sparkles, X, ListOrdered } from 'lucide-react';
import { abortConversation } from '../utils/deliver';
import type { Conversation } from '../types';

interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

// Accept literal CLI heads, including multilingual and plugin/namespaced commands.
// Metadata is not a prompt template and must never become message text.
function cliCommands(values: unknown[]): SlashCommand[] {
  const commands = new Map<string, SlashCommand>();
  for (const value of values) {
    const item = typeof value === 'string' ? { name: value } : value;
    if (!item || typeof item !== 'object' || !('name' in item) || typeof item.name !== 'string') continue;
    const name = item.name.replace(/^\//, '');
    if (!/^[\p{L}\p{N}_-]+(?:[:/][\p{L}\p{N}_-]+)*$/u.test(name) || commands.has(name)) continue;
    commands.set(name, {
      name,
      description: 'description' in item && typeof item.description === 'string' ? item.description : '',
      argumentHint: 'argumentHint' in item && typeof item.argumentHint === 'string' ? item.argumentHint : '',
    });
  }
  return [...commands.values()];
}

type SendMode = 'queue' | 'insert' | 'interrupt';

export function InputBar({ initialDraft }: { initialDraft: string }) {
  const [input, setInput] = useState(initialDraft);
  const [sendError, setSendError] = useState<string | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [argumentHint, setArgumentHint] = useState('');
  const [commandsError, setCommandsError] = useState<string | null>(null);
  const [readingCommands, setReadingCommands] = useState(false);
  const commandRequestRef = useRef(false);
  const [discovered, setDiscovered] = useState<{ id: string; cwd: string; commands: unknown[] } | null>(null);
  const [sendMode, setSendMode] = useState<SendMode>('queue');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 文件拖入高亮态（从访达/文件管理器拖文件到输入框上时置真）
  const [dragOver, setDragOver] = useState(false);
  // 输入法组合状态（中文输入法打字中），组合期间的按键属于输入法而非发送动作
  const isComposingRef = useRef(false);
  // 草稿镜像：卸载时回写到对应标签页（切 tab 保留草稿）
  const inputRef = useRef(input);
  inputRef.current = input;

  const conv = useStore((s): Conversation | undefined =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  );
  const globalCwd = useStore((s) => s.cwd);
  const cwd = conv ? conv.cwd : globalCwd;
  const model = useStore((s) => s.model);
  const injectedText = useStore((s) => s.injectedText);
  const injectText = useStore((s) => s.injectText);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);

  const conversationId = conv?.id ?? '';
  const mountedIdRef = useRef(conversationId);
  const updateInput = useCallback((text: string) => {
    inputRef.current = text;
    setInput(text);
    setSendError(null);
    if (mountedIdRef.current) useStore.getState().setDraft(text, mountedIdRef.current);
  }, []);
  const queue = conv?.queue ?? [];
  const sessionId = conv?.sessionId ?? null;
  const displayModel = conv?.currentModel || conv?.runtime?.info?.model || '';
  const pendingModel = model && model !== displayModel ? model : '';

  const isStreaming = conv?.status === 'streaming' || conv?.status === 'starting' || conv?.runtime?.busy === true;

  // No mount/typing probe: even SDK discovery may run project configuration hooks.
  const readCommands = async () => {
    if (commandRequestRef.current || !conversationId) return;
    const state = useStore.getState();
    const target = state.conversations.find(item => item.id === conversationId);
    if (!target?.cwd) {
      setCommandsError('当前对话未设置工作目录，无法读取 CLI 命令。');
      return;
    }
    commandRequestRef.current = true;
    setReadingCommands(true);
    setCommandsError(null);
    try {
      const claude = (window as any).api?.claude;
      if (typeof claude?.commands !== 'function') throw new Error('CLI 命令读取 IPC 不可用');
      const commands: unknown = await claude.commands({
        conversationId: target.id,
        cwd: target.cwd,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        options: {
          ...(state.model ? { model: state.model } : {}),
          permissionMode: target.permissionMode ?? state.permissionMode,
          ...(state.effortLevel ? { effortLevel: state.effortLevel } : {}),
          ...(state.autocompact ? { autocompact: state.autocompact } : {}),
          ...(state.maxBudgetUsd > 0 ? { maxBudgetUsd: state.maxBudgetUsd } : {}),
        },
      });
      if (!Array.isArray(commands)) throw new Error('CLI 返回的命令列表无效');
      const current = useStore.getState().conversations.find(item => item.id === target.id);
      if (!current || current.cwd !== target.cwd) return;
      // Bind actual bootstrap state, never claim connection from commands alone.
      if (typeof claude.runtimeState === 'function') {
        const runtime = await claude.runtimeState({ conversationId: target.id });
        const fresh = useStore.getState().conversations.find(item => item.id === target.id);
        if (runtime && fresh?.cwd === target.cwd) useStore.getState().setRuntime(target.id, { ...runtime, commands });
      }
      if (mountedRef.current) setDiscovered({ id: target.id, cwd: target.cwd, commands });
    } catch (error) {
      if (mountedRef.current) setCommandsError(error instanceof Error ? error.message : String(error));
    } finally {
      commandRequestRef.current = false;
      if (mountedRef.current) setReadingCommands(false);
    }
  };

  // 卸载时把草稿写回标签页（组件按 conversationId 重新挂载）
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (mountedIdRef.current) useStore.getState().setDraft(inputRef.current, mountedIdRef.current);
    };
  }, []);

  // Accept store-side draft restoration without overwriting a newer local edit.
  const previousDraftRef = useRef(initialDraft);
  useEffect(() => {
    const draft = conv?.draft ?? '';
    if (draft !== inputRef.current && (inputRef.current === previousDraftRef.current || inputRef.current === '')) {
      inputRef.current = draft;
      setInput(draft);
    }
    previousDraftRef.current = draft;
  }, [conv?.draft]);

  // 初始草稿高度适配（切 tab 恢复长草稿时撑开输入框）
  useEffect(() => {
    const el = textareaRef.current;
    if (el && initialDraft) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 斜杠命令过滤（输入以 / 开头且单行时触发）
  const slashMatch = /^\/(\S*)$/.exec(input);
  const commands = cliCommands([
    ...(conv?.commands?.length ? conv.commands
      : discovered?.id === conversationId && discovered.cwd === cwd && conv?.runtime?.state !== 'closed' && conv?.runtime?.state !== 'closing'
        ? discovered.commands : []),
  ]);
  const filteredCommands = slashMatch
    ? commands.filter((c) => c.name.startsWith(slashMatch[1]))
    : [];
  const showSlash = slashOpen && !!slashMatch;

  // 消费外部注入的文本（文件树 @引用 / 粘贴图片路径）。
  // 只消费目标为当前标签页的注入，且消费后立即清除：
  // 若不清除，InputBar 每次重挂载（切 tab / 新开 / 关闭标签页）时本 effect
  // 都会随挂载重新执行，把残留的路径一遍遍追加进输入框并抢走焦点
  useEffect(() => {
    if (!injectedText || injectedText.convId !== conversationId) return;
    updateInput(inputRef.current + injectedText.text);
    useStore.getState().clearInjectedText();
    textareaRef.current?.focus();
  }, [injectedText, conversationId, updateInput]);

  /** 粘贴图片（截图等）→ 存临时文件 → 插入 @ 引用，可继续补文字后发送；
   *  纯文本粘贴不受影响，走浏览器默认行为 */
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find((i) => i.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const saved = await (window as any).api.fs.saveImage(dataUrl);
      if (saved) injectText(`@${saved} `);
      else setSendError('粘贴图片保存失败，输入内容已保留。');
    } catch (error) {
      setSendError(`粘贴图片失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [injectText]);

  const handleSend = useCallback(async (mode: SendMode = 'queue') => {
    const draft = inputRef.current;
    if (!draft.trim() || !conversationId || sendingRef.current) return;
    const current = useStore.getState().conversations.find(item => item.id === conversationId);
    if (!current) return;
    if (!current.cwd) {
      setSendError('当前对话未设置工作目录，请先选择项目目录；输入内容已保留。');
      return;
    }
    const busy = current.status === 'streaming' || current.status === 'starting' || current.runtime?.busy === true;
    if (busy && mode === 'queue') {
      enqueueMessage(draft.trim());
      updateInput('');
      setSlashOpen(false);
      return;
    }
    if (typeof (window as any).api?.claude?.send !== 'function') {
      setSendError('发送 IPC 不可用，输入内容已保留。');
      return;
    }
    const oldMessages = new Set(current.messages.map(message => message.id));
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      await Promise.resolve(sendPrompt(draft.trim(), conversationId, { interrupt: mode === 'interrupt' }));
      const target = useStore.getState().conversations.find(item => item.id === conversationId);
      const errorMessage = target?.messages.find(message => !oldMessages.has(message.id) && message.status === 'error');
      // Promise<void> exposes no transport receipt. Only explicit store failure
      // states count here; streaming stderr may be a CLI warning on an accepted send.
      const errorBlock = errorMessage?.blocks.find(b => b.kind === 'stderr');
      if (errorMessage || target?.status === 'error') {
        throw new Error(errorBlock?.kind === 'stderr' ? errorBlock.text : '发送失败，输入内容已保留。');
      }
      // Preserve typing while IPC is pending, also after switching away.
      if (target && inputRef.current === draft && (!target.draft || target.draft === draft)) {
        inputRef.current = '';
        useStore.getState().setDraft('', conversationId);
        if (mountedRef.current) {
          setInput('');
          setSlashOpen(false);
          setArgumentHint('');
          if (textareaRef.current) textareaRef.current.style.height = 'auto';
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        useStore.getState().setDraft(inputRef.current, conversationId);
        setSendError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setSending(false);
    }
  }, [enqueueMessage, sendPrompt, conversationId, updateInput]);

  const handleAbort = useCallback(() => {
    if (conversationId) abortConversation(conversationId);
  }, [conversationId]);

  // 选中斜杠命令
  const selectCommand = useCallback((cmd: SlashCommand) => {
    setSlashOpen(false);
    updateInput(`/${cmd.name} `);
    setArgumentHint(cmd.argumentHint);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 200) + 'px';
      }
    });
  }, [updateInput]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 输入法组合中：Enter 是确认候选词上屏，方向键是候选词导航，
    // 均不触发发送/中断/斜杠面板（否则中文输入法打英文按回车会误发消息）
    if (isComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
      return;
    }

    // 斜杠面板打开时，优先响应面板导航
    if (showSlash && filteredCommands.length > 0) {
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
      if ((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        e.preventDefault();
        selectCommand(filteredCommands[Math.min(slashIndex, filteredCommands.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }

    if (e.key === 'Escape' && showSlash) {
      e.preventDefault();
      setSlashOpen(false);
      return;
    }

    // ESC 中断当前标签页的生成（其他标签页不受影响）
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      handleAbort();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend(e.ctrlKey ? 'insert' : 'queue');
    }
  };

  /** 拖放文件 → 转为 @路径 引用注入输入框（与文件树点击的行为一致） */
  const handleDragOver = (e: React.DragEvent) => {
    // 仅文件拖动时才允许放置（拖动的是文字/链接则不改样式）
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // 进入子元素也会触发 dragleave，仅在真正离开容器时复位
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const refs = files
      .map((f) => (window as any).api.getFilePath(f) as string)
      .filter((p) => !!p)
      // 位于项目目录内的引用转为相对路径（与文件树一致），外部的保留绝对路径
      .map((p) => (cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p))
      .map((p) => `@${p} `)
      .join('');
    if (refs) injectText(refs);
  };

  // 自动调整 textarea 高度 + 斜杠面板开关
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    updateInput(value);
    setArgumentHint('');
    setSlashOpen(/^\/\S*$/.test(value));
    setSlashIndex(0);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  return (
    <div className="px-6 py-4 border-t border-border/30 bg-bg-deep/50 backdrop-blur-sm">
      <div className="relative">
        {/* 待发队列（当前标签页的） */}
        {queue.length > 0 && (
          <div className="mb-2 space-y-1 animate-fade-in">
            <div className="flex items-center gap-1.5 px-1 text-[10px] text-text-dim font-mono uppercase tracking-wider">
              <ListOrdered className="w-3 h-3" />
              排队中 · {queue.length} 条
            </div>
            {queue.map((text, i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent-yellow/5 border border-accent-yellow/20"
              >
                <span className="text-[10px] font-mono text-accent-yellow/70 shrink-0">#{i + 1}</span>
                <span className="flex-1 text-xs text-text-secondary truncate">{text}</span>
                <button
                  onClick={() => removeQueuedMessage(i)}
                  className="text-text-dim hover:text-accent-red transition-colors shrink-0"
                  title="移出队列"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 斜杠命令面板 */}
        {showSlash && (
          <div className="absolute bottom-full left-0 right-0 mb-2 glass-panel rounded-xl border border-border overflow-hidden z-20 animate-fade-in">
            <div className="px-3 py-1.5 border-b border-border/30 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-accent-cyan" />
              <span className="text-[10px] text-text-dim font-mono uppercase tracking-wider">快捷命令</span>
            </div>
            <div className="px-3 py-2 text-xs text-text-muted">
              <button type="button" onClick={() => void readCommands()} disabled={readingCommands} className="text-accent-cyan disabled:opacity-40">
                {readingCommands ? '读取中…' : '读取CLI命令（加载项目配置，不发送提示词）'}
              </button>
              {filteredCommands.length === 0 && <div>无已知匹配命令；未知 /命令可按原样发送。</div>}
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.name}
                  onClick={() => selectCommand(cmd)}
                  onMouseEnter={() => setSlashIndex(i)}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                    i === slashIndex ? 'bg-accent-cyan/10' : 'hover:bg-bg-light'
                  }`}
                >
                  <span className={`text-xs font-mono font-semibold shrink-0 ${
                    i === slashIndex ? 'text-accent-cyan' : 'text-text-secondary'
                  }`}>
                    /{cmd.name}
                  </span>
                  <span className="text-xs text-text-muted truncate">{cmd.description} {cmd.argumentHint}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 输入框容器 */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative rounded-2xl border transition-all input-focus-glow ${
            dragOver
              ? 'border-accent-cyan/70 bg-accent-cyan/10 tech-glow-cyan'
              : isStreaming
                ? 'border-accent-yellow/40 bg-accent-yellow/5'
                : 'border-border bg-bg-light hover:border-accent-cyan/30 focus-within:border-accent-cyan/50 focus-within:tech-glow-cyan'
          }`}
        >
          {/* 拖放提示层 */}
          {dragOver && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl pointer-events-none">
              <span className="text-xs font-mono text-accent-cyan">松开即可插入 @文件引用</span>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            aria-label="消息输入"
            placeholder={argumentHint || (isStreaming ? '生成中仍可输入，Enter 加入队列… (ESC 中断)' : '输入指令，/ 唤起快捷命令，Enter 发送')}
            rows={1}
            className="w-full bg-transparent text-sm text-text-primary placeholder-text-dim resize-none px-4 py-3 pr-28 max-h-48 overflow-y-auto font-sans"
            style={{ minHeight: '44px' }}
          />

          {/* 按钮区域 */}
          <div className="absolute right-2 bottom-2 flex items-center gap-2">
            {/* 模型指示器 */}
            {displayModel && (
              <span className="text-[10px] font-mono text-text-dim px-2 py-1 rounded bg-bg-deepest/50">
                {displayModel}
              </span>
            )}

            {isStreaming && (
              <button
                onClick={handleAbort}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-red/20 hover:bg-accent-red/30 border border-accent-red/40 text-accent-red transition-all"
              >
                <Square className="w-3.5 h-3.5" fill="currentColor" />
                <span className="text-xs font-medium">停止</span>
              </button>
            )}
              <button
                onClick={() => void handleSend(isStreaming ? sendMode : 'insert')}
                disabled={!input.trim() || sending}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-gradient-to-r from-accent-cyan/20 to-accent-blue/20 hover:from-accent-cyan/30 hover:to-accent-blue/30 border border-accent-cyan/40 hover:border-accent-cyan/60 text-accent-cyan transition-all disabled:opacity-30 disabled:cursor-not-allowed group send-btn-glow"
              >
                <Send className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                <span className="text-xs font-medium">{sending ? '发送中…' : isStreaming ? ({ queue: '排队发送', insert: '立即插话', interrupt: '停止并发送' }[sendMode]) : '发送'}</span>
              </button>
          </div>
        </div>

        <div className="mt-2 px-2 text-[10px] text-text-dim space-y-1">
          {!showSlash && <button type="button" onClick={() => void readCommands()} disabled={readingCommands} className="text-accent-cyan disabled:opacity-40">
            {readingCommands ? '读取中…' : '读取CLI命令（加载项目配置，不发送提示词）'}
          </button>}
          <div>仅 SDK 握手读取；可能执行项目配置 hooks，副作用及费用未知，不自动发送模型探测请求。</div>
          {isStreaming && <label>发送方式 <select aria-label="发送方式" value={sendMode} onChange={e => setSendMode(e.target.value as SendMode)} className="bg-bg-deep">
            <option value="queue">轮后排队</option><option value="insert">立即插话</option><option value="interrupt">停止并发送</option>
          </select> · Ctrl+Enter 立即插话（不停止）</label>}
          {argumentHint && <div>参数：{argumentHint}</div>}
          {pendingModel && <div>待下次启动模型：{pendingModel}（非当前运行模型）</div>}
          {/^\/clear(?:\s|$)/.test(input) && <div>/clear 将原样交给 CLI，不会新建 GUI 标签页；若 SDK 不支持，请在原生终端显式执行。</div>}
        </div>
        {commandsError && <div role="alert" className="mt-2 px-2 text-xs text-accent-red">{commandsError}</div>}
        {sendError && <div role="alert" className="mt-2 px-2 text-xs text-accent-red">{sendError}</div>}

        {/* 底部提示 */}
        <div className="flex items-center justify-between mt-2 px-2">
          <div className="flex items-center gap-3 text-[10px] text-text-dim font-mono">
            <span>⏎ {isStreaming ? '排队' : '发送'}</span>
            <span>⇧⏎ 换行</span>
            <span>/ 命令</span>
            <span>拖文件 @引用</span>
            <span>⌘F 搜索</span>
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
