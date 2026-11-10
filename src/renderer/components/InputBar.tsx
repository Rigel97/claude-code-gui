import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../store';
import { useProjectsStore } from '../projectStore';
import { Send, Square, Sparkles, X, ListOrdered, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { abortConversation } from '../utils/deliver';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SM_GHOST, SELECT, POPOVER_PANEL } from './controls';
import { usePopoverBehavior } from './useDialogBehavior';
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

/** 按平台显示快捷键，避免在 Windows/Linux 上仍然提示 ⌘ */
const modKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

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
  const inputBarRef = useRef<HTMLDivElement>(null);
  usePopoverBehavior(inputBarRef);
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
  const activeProject = useProjectsStore((s) => s.projects.find(project => project.conversations?.some(link => link.conversationId === (conv?.id ?? ''))));
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

  const sendLabel = sending ? '发送中…' : isStreaming ? ({ queue: '排队发送', insert: '立即插话', interrupt: '停止并发送' }[sendMode]) : '发送';

  return (
    <div ref={inputBarRef} className="relative flex min-h-0 shrink flex-col border-t border-border/30 bg-bg-deep/50 px-4 py-2 backdrop-blur-sm md:px-6" style={{ maxHeight: 'min(360px, 100%)' }}>
      <div className="relative mx-auto flex min-h-0 w-full max-w-[920px] flex-col">
        {/* 斜杠命令面板 */}
        {showSlash && (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-border glass-panel animate-fade-in">
            <div className="flex items-center gap-1.5 border-b border-border/30 px-3 py-1.5">
              <Sparkles className="h-3 w-3 text-accent-cyan" />
              <span className="font-mono text-2xs uppercase tracking-wider text-text-muted">快捷命令</span>
            </div>
            <div className="px-3 py-2 text-xs text-text-secondary">
              <button type="button" aria-label={readingCommands ? '读取中…' : '读取CLI命令（加载项目配置，不发送提示词）'} title="仅握手读取命令；可能执行项目 hooks，副作用及费用未知，不自动发送提示词" onClick={() => void readCommands()} disabled={readingCommands} className={BUTTON_SM_GHOST}>
                <RefreshCw className={`h-3.5 w-3.5 ${readingCommands ? 'animate-spin' : ''}`} />{readingCommands ? '读取中…' : '读取 CLI 命令'}
              </button>
              {filteredCommands.length === 0 && <div>无已知匹配命令；未知 /命令可按原样发送。</div>}
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.name}
                  onClick={() => selectCommand(cmd)}
                  onMouseEnter={() => setSlashIndex(i)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                    i === slashIndex ? 'bg-accent-cyan/10' : 'hover:bg-bg-light'
                  }`}
                >
                  <span className={`shrink-0 font-mono text-xs font-semibold ${
                    i === slashIndex ? 'text-accent-cyan' : 'text-text-secondary'
                  }`}>
                    /{cmd.name}
                  </span>
                  <span className="truncate text-xs text-text-secondary">{cmd.description} {cmd.argumentHint}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 输入框容器：文本区与操作栏分行，按钮不再覆盖正文 */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative flex min-h-[120px] shrink flex-col overflow-hidden rounded-xl border transition-all input-focus-glow ${
            dragOver
              ? 'border-accent-cyan/70 bg-accent-cyan/10 tech-glow-cyan'
              : isStreaming
                ? 'border-accent-yellow/40 bg-accent-yellow/5'
                : 'border-border bg-bg-light hover:border-accent-cyan/30 focus-within:border-accent-cyan/50'
          }`}
        >
          {/* 拖放提示层 */}
          {dragOver && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl">
              <span className="font-mono text-xs text-accent-cyan">松开即可插入 @文件引用</span>
            </div>
          )}
          {/* 作用域摘要：发送前可确认自己在哪个项目、哪个目录下工作 */}
          <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/30 px-3 text-xs text-text-secondary">
            <span className="shrink-0 rounded bg-bg-deepest/60 px-1.5 py-0.5 text-text-dim">作用域</span>
            <span className="min-w-0 truncate" title={activeProject ? `项目：${activeProject.name}` : `对话：${conv?.title || '新对话'}`}>
              {activeProject ? `项目：${activeProject.name}` : `对话：${conv?.title || '新对话'}`}
            </span>
            <span className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-text-dim" title={cwd || '未设置工作目录'}>
              目录：{cwd ? cwd.split('/').pop() : '未设置'}
            </span>
          </div>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            aria-label="消息输入"
            placeholder={argumentHint || (isStreaming ? '生成中仍可输入，Enter 加入队列… (Esc 中断)' : '输入指令，/ 唤起快捷命令，Enter 发送')}
            rows={1}
            className="max-h-48 min-h-[44px] w-full shrink resize-none overflow-y-auto bg-transparent px-4 py-2 font-sans text-sm text-text-primary placeholder-text-dim"
            style={{ minHeight: '44px' }}
          />

          {/* 操作栏：模型、发送方式、停止与发送都在文本区之外 */}
          <div className="flex shrink-0 items-center gap-2 border-t border-border/40 px-2.5 py-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {displayModel && (
                <span className="hidden min-w-0 max-w-[180px] truncate font-mono text-xs text-text-muted sm:inline" title={displayModel}>
                  {displayModel}
                </span>
              )}
              <span className="flex-1" />
              {isStreaming && (
                <select
                  aria-label="发送方式"
                  value={sendMode}
                  onChange={e => setSendMode(e.target.value as SendMode)}
                  title="Ctrl+Enter 立即插话（不停止当前生成）"
                  className={`${SELECT} max-w-[132px]`}
                >
                  <option value="queue">轮后排队</option>
                  <option value="insert">立即插话</option>
                  <option value="interrupt">停止并发送</option>
                </select>
              )}
              {isStreaming && (
                <button
                  onClick={handleAbort}
                  className={`${BUTTON_DANGER} shrink-0`}
                >
                  <Square className="h-3.5 w-3.5" fill="currentColor" />
                  <span>停止</span>
                </button>
              )}
              <button
                onClick={() => void handleSend(isStreaming ? sendMode : 'insert')}
                disabled={!input.trim() || sending}
                className={`${BUTTON_PRIMARY} send-btn-glow group shrink-0 font-medium`}
              >
                <Send className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                <span>{sendLabel}</span>
              </button>
            </div>
          </div>
        </div>

        {/* 帮助是弹出层，不再随展开挤压输入和发送操作。 */}
        <div className="mt-1 flex h-7 shrink-0 items-center gap-3 text-xs text-text-muted">
          {!showSlash && <button type="button" aria-label={readingCommands ? '读取中…' : '读取CLI命令（加载项目配置，不发送提示词）'} title="读取 CLI 命令，不发送提示词；可能执行项目 hooks，副作用及费用未知" onClick={() => void readCommands()} disabled={readingCommands} className={`${BUTTON_SM_GHOST} px-1`}><RefreshCw className={`h-3.5 w-3.5 ${readingCommands ? 'animate-spin' : ''}`} />{readingCommands ? '读取中…' : '读取命令'}</button>}
          {queue.length > 0 && <details data-popover data-popover-anchor="container" className="text-accent-yellow">
            <summary className={`${BUTTON_SM_GHOST} list-none cursor-pointer px-1 text-accent-yellow [&::-webkit-details-marker]:hidden`}><ListOrdered className="h-3.5 w-3.5" />排队中 · {queue.length} 条</summary>
            <div className={`${POPOVER_PANEL} absolute bottom-full left-0 mb-2 max-h-[40vh] w-80 max-w-[70vw] overflow-y-auto p-2 text-xs`} aria-label="待发队列">
              <p className="mb-2 px-1 text-text-secondary">轮后按顺序发送，可移除尚未发送的消息。</p>
              {queue.map((text, i) => <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5"><span className="text-text-muted">#{i + 1}</span><span className="min-w-0 flex-1 truncate text-text-primary" title={text}>{text}</span><button onClick={() => removeQueuedMessage(i)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-bg-lighter hover:text-accent-red" title="移出队列" aria-label={`移出队列 ${i + 1}`}><X className="h-3.5 w-3.5" /></button></div>)}
            </div>
          </details>}
          <span className="hidden whitespace-nowrap sm:inline">Enter {isStreaming ? '排队' : '发送'}</span>
          <span className="hidden whitespace-nowrap lg:inline">Shift+Enter 换行</span>
          {isStreaming && <span className="hidden text-accent-red/80 md:inline">Esc 停止</span>}
          <details data-popover data-popover-anchor="container" className="ml-auto">
            <summary className={`${BUTTON_SM_GHOST} list-none cursor-pointer px-1 [&::-webkit-details-marker]:hidden`}><SlidersHorizontal className="h-3.5 w-3.5" />说明与参数</summary>
            <div className={`${POPOVER_PANEL} absolute bottom-full right-0 mb-2 max-h-[45vh] w-80 max-w-[70vw] space-y-2 overflow-y-auto p-3 text-xs leading-5 text-text-secondary`}>
              <p>“读取 CLI 命令”仅 SDK 握手读取；可能执行项目配置 hooks，副作用及费用未知，不自动发送模型探测请求。</p>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1"><span>Enter</span><span>{isStreaming ? '轮后排队' : '发送消息'}</span><span>Shift+Enter</span><span>换行</span><span>Ctrl+Enter</span><span>立即插话，不停止生成</span><span>{modKey}F</span><span>搜索会话</span></div>
              {argumentHint && <p>参数：{argumentHint}</p>}
              <p className="border-t border-border/40 pt-2 font-mono text-text-muted">会话 {sessionId ? sessionId.slice(0, 8) : 'new session'} · {input.length} chars</p>
            </div>
          </details>
        </div>
        {/* 高危命令的行为提示必须在发送前可见，不能折叠进说明 */}
        {/^\/clear(?:\s|$)/.test(input) && <div role="status" className="mt-1 px-1 text-2xs leading-5 text-accent-yellow">/clear 将原样交给 CLI，不会新建 GUI 标签页；若 SDK 不支持，请在原生终端显式执行。</div>}
        {pendingModel && <div className="mt-1 px-1 text-2xs leading-5 text-text-secondary">待下次启动模型：<span className="font-mono text-accent-yellow">{pendingModel}</span>（非当前运行模型）</div>}
        {(commandsError || sendError) && <div className="mt-1 max-h-16 min-h-0 shrink overflow-y-auto px-1 text-xs text-accent-red">
          {commandsError && <p role="alert">{commandsError}</p>}
          {sendError && <p role="alert">{sendError}</p>}
        </div>}
      </div>
    </div>
  );
}
