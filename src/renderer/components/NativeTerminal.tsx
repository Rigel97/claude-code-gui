import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useDialogBehavior } from './useDialogBehavior';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '../store';
import { getTerminalAPI, terminalError, updateTerminal, useTerminalStore, type TerminalDataEvent, type TerminalInitialCommand, type TerminalMode, type TerminalSpec } from '../terminalStore';

const modes: TerminalMode[] = ['interactive', 'teams', 'remote', 'cloud', 'mcp', 'plugins', 'agents', 'auth', 'doctor', 'shell'];
/** 面向用户的任务名；内部模式名只保留在 value 与说明中。 */
const MODE_LABELS: Record<TerminalMode, string> = {
  interactive: '交互式 CLI',
  teams: 'Teams 协作',
  remote: '远程会话',
  cloud: 'Cloud 会话',
  mcp: 'MCP 管理',
  plugins: '插件管理',
  agents: 'Agents 管理',
  auth: '登录认证',
  doctor: '运行诊断',
  shell: '完整 Shell',
};
const initialCommands: TerminalInitialCommand[] = ['/mcp', '/plugin', '/hooks', '/config', '/resume'];
const managementCommands: Partial<Record<TerminalMode, string>> = { mcp: 'claude mcp --help', plugins: 'claude plugin --help', agents: 'claude agents --help' };
// 终端是隔离的自包含区域：视觉值直接对齐主题 token（圆角 6px、12px 字号、border/bg-light），
// 但仍用内联样式，保证在没有主样式表的原生终端测试宿主中也能保持布局与尺寸。
const field: CSSProperties = { background: '#161c2e', color: '#e2e8f0', border: '1px solid #2a3349', borderRadius: 6, padding: '5px 8px', minWidth: 0, fontSize: 12 };
const button: CSSProperties = { ...field, cursor: 'pointer' };
const primaryButton: CSSProperties = { ...button, background: '#00e5ff20', border: '1px solid #00e5ff66', color: '#00e5ff' };

const headerControl: CSSProperties = { ...button, height: 28, boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0 };
const labelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 };
const inputStyle: CSSProperties = { ...field, width: '100%', height: 32, boxSizing: 'border-box' };

function NewTerminalForm({ onCollapse }: { onCollapse: () => void }) {
  const draft = useTerminalStore(s => s.formSpec);
  const loading = useTerminalStore(s => s.loading);
  const available = useTerminalStore(s => s.available);
  const error = useTerminalStore(s => s.error);
  const dialogRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const requestClose = () => { if (!loading) onCollapse(); };
  useDialogBehavior({ open: true, dialogRef, onRequestClose: requestClose, initialFocusSelector: '[aria-label="模式"]' });
  const cwdDefault = useStore(s => s.conversations.find(c => c.id === s.activeConversationId)?.cwd || s.cwd);
  const sessions = useStore(s => s.sessions);
  const [mode, setMode] = useState<TerminalMode>(draft?.mode || 'interactive');
  const [cwd, setCwd] = useState(draft?.cwd || cwdDefault);
  const [sessionId, setSessionId] = useState(draft?.sessionId || '');
  const [chrome, setChrome] = useState(draft?.options?.chrome === undefined ? 'default' : draft.options.chrome ? 'enabled' : 'disabled');
  const [ide, setIde] = useState(draft?.options?.ide || false);
  const [worktree, setWorktree] = useState(draft?.options?.worktree || '');
  const [cloudSession, setCloudSession] = useState(draft?.options?.cloudSession || '');
  const [initialCommand, setInitialCommand] = useState<TerminalInitialCommand | ''>(draft?.initialCommand || '');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const sessionMode = ['interactive', 'teams', 'remote'].includes(mode);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (useTerminalStore.getState().loading) return;
    const spec: TerminalSpec = { mode, cwd: cwd.trim() };
    if (sessionMode) {
      const options = { ...(chrome !== 'default' ? { chrome: chrome === 'enabled' } : {}), ...(ide ? { ide: true } : {}), ...(worktree.trim() ? { worktree: worktree.trim() } : {}) };
      if (Object.keys(options).length) spec.options = options;
      if (sessionId) { spec.sessionId = sessionId; spec.resume = true; }
    }
    if (mode === 'interactive' && initialCommand) spec.initialCommand = initialCommand;
    if (mode === 'cloud') spec.options = { cloudSession: cloudSession.trim() };
    try { await useTerminalStore.getState().create(spec); if (mounted.current) onCollapse(); } catch { /* store renders the error without losing fields */ }
  }
  return createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#020617aa', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box', font: '12px system-ui', color: '#e2e8f0' }}>
    <form ref={dialogRef} role="dialog" aria-modal="true" aria-label="新终端" data-block-global-shortcuts="true" onSubmit={submit} style={{ width: 560, maxWidth: '100%', maxHeight: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column', background: '#0f172a', border: '1px solid #2a3349', borderRadius: 12, boxShadow: '0 20px 80px #0008', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #2a3349', flexShrink: 0 }}>
        <strong style={{ fontSize: 14 }}>新终端</strong>
        <button type="button" aria-label="收起表单" title="收起表单（Esc）" style={headerControl} disabled={loading} onClick={requestClose}><X size={14} /></button>
      </header>
      <div style={{ overflowY: 'auto', minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, color: '#a7b4c6', lineHeight: 1.5 }}>仅创建原生会话，不自动发送命令；默认不占用当前聊天 session。</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 12 }}>
          <label style={labelStyle}>模式 <select aria-label="模式" style={inputStyle} value={mode} onChange={e => setMode(e.target.value as TerminalMode)}>{modes.map(value => <option key={value} value={value}>{MODE_LABELS[value]}</option>)}</select></label>
          <label style={labelStyle}>工作目录 <input style={inputStyle} required value={cwd} onChange={e => setCwd(e.target.value)} /></label>
        </div>
        {sessionMode && <label style={labelStyle}>恢复会话 <select aria-label="恢复会话" style={inputStyle} value={sessionId} onChange={e => setSessionId(e.target.value)}>
          <option value="">新 session（默认，不占用当前聊天）</option>
          {draft?.sessionId && !sessions.some(s => s.sessionId === draft.sessionId) && <option value={draft.sessionId}>{draft.sessionId}</option>}
          {sessions.map(s => <option key={s.sessionId} value={s.sessionId}>{s.title} · {s.sessionId}</option>)}
        </select></label>}
        {sessionMode && <div>
          <button type="button" style={button} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(value => !value)}>高级选项</button>
          {advancedOpen && <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 12, borderRadius: 8, border: '1px solid #2a3349', background: '#0a0e17', padding: 12 }}>
            <label style={labelStyle}>Chrome <select aria-label="Chrome" style={inputStyle} value={chrome} onChange={e => setChrome(e.target.value)}><option value="default">CLI 默认</option><option value="enabled">启用</option><option value="disabled">禁用</option></select></label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={ide} onChange={e => setIde(e.target.checked)} /> IDE</label>
            <label style={labelStyle}>Worktree 名称（可选） <input style={inputStyle} value={worktree} onChange={e => setWorktree(e.target.value)} /></label>
            {mode === 'interactive' && <label style={labelStyle}>交互预设 <select aria-label="交互预设" style={inputStyle} value={initialCommand} onChange={e => setInitialCommand(e.target.value as TerminalInitialCommand | '')}><option value="">无（创建不写命令）</option>{initialCommands.map(command => <option key={command} value={command}>{command}</option>)}</select></label>}
          </div>}
        </div>}
        {mode === 'cloud' && <label style={labelStyle}>已有 Cloud session ID 或 URL <input style={inputStyle} required value={cloudSession} onChange={e => setCloudSession(e.target.value)} placeholder="已有 ID 或 https://claude.ai/code/…" /></label>}
      </div>
      <footer style={{ flexShrink: 0, padding: '12px 16px', borderTop: '1px solid #2a3349', background: '#111b30' }}>
        {loading && <p role="status" style={{ margin: '0 0 8px', color: '#a7b4c6' }}>正在创建终端，请等待结果；不会重复创建或关闭当前表单。</p>}
        {error && <div role="alert" style={{ marginBottom: 10, color: '#ff6b7a', overflowWrap: 'anywhere' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={button} disabled={loading} onClick={() => void useTerminalStore.getState().refresh()}>刷新列表</button>
          <button type="button" style={button} disabled={loading} onClick={requestClose}>取消</button>
          <button style={primaryButton} aria-label="创建终端" disabled={loading || !available || !cwd.trim()} type="submit">{loading ? '创建终端…' : '创建终端'}</button>
        </div>
      </footer>
    </form>
  </div>, document.body);
}

function TerminalViewport({ id, visible }: { id: string; visible: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const fitVisible = useRef<() => void>(() => {});
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const explicitWrite = useRef<(data: string) => void>(() => {});
  const meta = useTerminalStore(state => state.terminals.find(term => term.id === id));
  const management = meta && managementCommands[meta.mode] === meta.suggestedCommand ? meta.suggestedCommand : undefined;
  const preset = meta?.mode === 'interactive' && initialCommands.includes(meta.initialCommand!) ? meta.initialCommand : undefined;
  const shell = meta && ['shell', 'mcp', 'plugins', 'agents'].includes(meta.mode);
  const canWrite = ready && !sending && meta?.status === 'running';
  useEffect(() => {
    const element = container.current;
    const api = getTerminalAPI();
    if (!element || !api) { setError('原生终端 IPC 不可用'); return; }
    let disposed = false;
    let terminal: Terminal | undefined;
    let attached = false;
    let lastSeq = -1;
    let lostThrough = -1;
    let bytes = 0;
    let lastDimensions = '';
    let frame = 0;
    const limit = 4 * 1024 * 1024;
    const encoder = new TextEncoder();
    const queue = new Map<number, TerminalDataEvent>();
    const cleanups: (() => void)[] = [];
    const fail = (reason: unknown) => { if (!disposed) setError(terminalError(reason)); };
    const write = (data: string) => {
      // Bound individual xterm parser work; use the official renderer, never a trace/pre.
      const follow = terminal ? terminal.buffer.active.viewportY === terminal.buffer.active.baseY : false;
      for (let offset = 0; offset < data.length; offset += 65536) {
        const last = offset + 65536 >= data.length;
        terminal?.write(data.slice(offset, offset + 65536), last && follow ? () => {
          if (!disposed) terminal?.scrollToBottom();
        } : undefined);
      }
    };
    const drain = () => {
      if (!attached || !terminal || disposed) return;
      lastSeq = Math.max(lastSeq, lostThrough);
      for (const [seq, event] of queue) {
        if (seq <= lastSeq) { bytes -= encoder.encode(event.data).length; queue.delete(seq); }
      }
      while (queue.has(lastSeq + 1)) {
        const event = queue.get(lastSeq + 1)!;
        queue.delete(++lastSeq);
        bytes -= encoder.encode(event.data).length;
        write(event.data);
      }
    };
    const receive = (event: TerminalDataEvent) => {
      if (disposed || event.id !== id || !Number.isSafeInteger(event.seq) || typeof event.data !== 'string') return;
      if (event.truncated) setTruncated(true);
      if (event.seq <= lastSeq || queue.has(event.seq)) return;
      let data = event.data;
      let encoded = encoder.encode(data);
      if (encoded.length > limit) {
        let start = encoded.length - limit;
        while ((encoded[start] & 0xc0) === 0x80) start++;
        data = new TextDecoder().decode(encoded.subarray(start));
        encoded = encoder.encode(data);
        setTruncated(true);
      }
      queue.set(event.seq, { ...event, data });
      bytes += encoded.length;
      while (bytes > limit || queue.size > 8192) {
        const oldest = Math.min(...queue.keys());
        bytes -= encoder.encode(queue.get(oldest)!.data).length;
        queue.delete(oldest);
        lostThrough = Math.max(lostThrough, oldest);
        setTruncated(true);
      }
      drain();
    };
    setError(null); setTruncated(false); setReady(false); setSending(false);
    explicitWrite.current = data => {
      if (disposed || !attached || useTerminalStore.getState().terminals.find(term => term.id === id)?.status !== 'running') return;
      setSending(true);
      void Promise.resolve().then(() => api.write(id, data)).then(() => {
        if (!disposed) terminal?.focus();
      }).catch(fail).finally(() => { if (!disposed) setSending(false); });
    };
    // Register BOTH event boundaries before awaiting modules or attach.
    try {
      cleanups.push(api.onData(receive));
      cleanups.push(api.onExit(event => {
        if (disposed || event.id !== id) return;
        updateTerminal(id, { status: 'exited', exitCode: event.exitCode });
        if (event.truncated) setTruncated(true);
        // Do not dispose here: queued and in-flight tail output must still render.
      }));
    } catch (reason) { fail(reason); }
    void (async () => {
      try {
        const [{ Terminal: Xterm }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
        if (disposed) return;
        terminal = new Xterm({ cursorBlink: true, fontSize: 13, scrollback: 5000, theme: { background: '#0f172a', foreground: '#e2e8f0' } });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(element);
        const input = terminal.onData(data => {
          const status = useTerminalStore.getState().terminals.find(term => term.id === id)?.status;
          if (status !== 'running') return;
          void Promise.resolve().then(() => api.write(id, data)).catch(fail);
        });
        cleanups.push(() => input.dispose());
        fitVisible.current = () => {
          if (disposed || !element.isConnected || element.clientWidth <= 0 || element.clientHeight <= 0) return;
          try {
            fit.fit();
            const cols = terminal!.cols; const rows = terminal!.rows;
            const dimensions = `${cols}:${rows}`;
            if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000 || dimensions === lastDimensions) return;
            if (useTerminalStore.getState().terminals.find(term => term.id === id)?.status !== 'running') return;
            lastDimensions = dimensions;
            void Promise.resolve().then(() => api.resize(id, cols, rows)).catch(reason => { lastDimensions = ''; fail(reason); });
          } catch (reason) { fail(reason); }
        };
        const observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => fitVisible.current());
        });
        observer.observe(element);
        cleanups.push(() => { observer.disconnect(); cancelAnimationFrame(frame); });
        const snapshot = await api.attach(id);
        if (disposed) return;
        lastSeq = snapshot.lastSeq;
        setTruncated(value => value || snapshot.truncated);
        updateTerminal(id, { status: snapshot.status, exitCode: snapshot.exitCode });
        write(snapshot.snapshot);
        attached = true;
        setReady(true);
        drain();
        fitVisible.current();
      } catch (reason) { fail(reason); }
    })();
    return () => {
      disposed = true;
      explicitWrite.current = () => {};
      fitVisible.current = () => {};
      for (const cleanup of cleanups) { try { cleanup(); } catch { /* detached adapter */ } }
      queue.clear();
      terminal?.dispose();
      // Ownership belongs to the explicit close action, never to React unmount.
    };
  }, [id, attempt]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => fitVisible.current());
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  return <div role="tabpanel" aria-label="终端输出" hidden={!visible} style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
    {truncated && <div role="status" style={{ padding: '4px 12px', color: '#fbbf24', fontSize: 11 }}>终端历史已截断（最多保留 4 MiB）；这里不是完整聊天 trace。</div>}
    <div style={{ padding: '0 12px 4px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, color: '#a7b4c6' }}>
      <button style={button} onClick={() => setAttempt(value => value + 1)}>重新连接</button>
      {shell && <span>完整 shell：可输入管理、安装、配置等命令；建议 help 仅供起步，不代表管理功能已执行。</span>}
      {management && <><code style={{ background: '#161c2e', borderRadius: 4, padding: '1px 4px', color: '#e2e8f0' }}>{management}</code><button style={button} disabled={!canWrite} onClick={() => explicitWrite.current(management)}>插入管理命令</button></>}
      {preset && <><span>可信预设写入当前 TUI；请确认输入位置，插入后自行回车，不自动执行。</span><button style={button} disabled={!canWrite} onClick={() => explicitWrite.current(preset)}>执行 {preset}</button></>}
      {(management || preset) && <button style={button} disabled={!canWrite} onClick={() => explicitWrite.current('\r')}>发送回车</button>}
    </div>
    {error && <div role="alert" style={{ padding: '4px 12px', color: '#ff4757', fontSize: 11 }}>{error}</div>}
    <div ref={container} style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '0 12px' }} />
  </div>;
}

/** Mount once beside the chat area, not inside its keyed conversation subtree. */
export function NativeTerminalHost() {
  const state = useTerminalStore();
  const hostRef = useRef<HTMLElement>(null);
  const [size, setSize] = useState('standard');
  const [formOpen, setFormOpen] = useState(false);
  useLayoutEffect(() => {
    const current = useTerminalStore.getState();
    setFormOpen(current.open && (!!current.formSpec || (!current.terminals.length && window.innerWidth >= 1100 && window.innerHeight >= 700)));
  }, [state.open, state.formVersion]);
  const [parentHeight, setParentHeight] = useState(() => Math.max(0, window.innerHeight - 68));
  const [draggedHeight, setDraggedHeight] = useState<number | null>(null);
  const stopDrag = useRef<() => void>(() => {});
  useEffect(() => { if (useTerminalStore.getState().open) void useTerminalStore.getState().refresh(); }, []);
  useEffect(() => {
    const parent = hostRef.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      // Typed OM distinguishes an auto-height standalone fixture from a constrained
      // flex workspace; computedStyle.height alone resolves auto to misleading pixels.
      const typedParent = parent as HTMLElement & { computedStyleMap?: () => { get: (key: string) => { toString(): string } | undefined } };
      const declaredHeight = typedParent.computedStyleMap?.().get('height')?.toString();
      const autoHeight = declaredHeight === 'auto' && getComputedStyle(parent).flexGrow === '0';
      const actual = parent.clientHeight;
      setParentHeight(actual > 0 && !autoHeight ? actual : Math.max(0, window.innerHeight - 68));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  // 为对话的输入、活动和审批保留空间；独立宿主继续使用相同的像素预算。
  const maxHeight = Math.max(0, Math.floor(parentHeight - 300));
  const minHeight = Math.min(140, maxHeight);
  const clampHeight = (value: number) => Math.min(maxHeight, Math.max(minHeight, Math.round(value)));
  const presetHeight = size === 'compact' ? Math.min(300, parentHeight * 0.26) : size === 'large' ? Math.min(520, parentHeight * 0.44) : Math.min(420, parentHeight * 0.36);
  const height = clampHeight(draggedHeight ?? presetHeight);
  const boundsRef = useRef({ minHeight, maxHeight });
  boundsRef.current = { minHeight, maxHeight };
  useEffect(() => { if (!state.open) stopDrag.current(); return () => stopDrag.current(); }, [state.open]);
  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    stopDrag.current();
    const startY = event.clientY;
    const startHeight = hostRef.current?.getBoundingClientRect().height ?? height;
    const onMove = (move: MouseEvent) => {
      const bounds = boundsRef.current;
      setDraggedHeight(Math.min(bounds.maxHeight, Math.max(bounds.minHeight, Math.round(startHeight + startY - move.clientY))));
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', cleanup);
      window.removeEventListener('blur', cleanup);
      stopDrag.current = () => {};
    };
    stopDrag.current = cleanup;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', cleanup);
    window.addEventListener('blur', cleanup);
  };
  const modalOpen = state.open && formOpen;
  return <section ref={hostRef} aria-label="官方原生终端" hidden={!state.open} style={{
    display: state.open ? 'flex' : 'none', flexDirection: 'column', flexShrink: 0, minWidth: 0,
    height, maxHeight, minHeight, boxSizing: 'border-box',
    background: '#0a0e17', color: '#e2e8f0', borderTop: '1px solid #1e2538', font: '12px system-ui', overflowY: 'auto', overflowX: 'hidden',
  }}>
    <div role="separator" tabIndex={0} aria-orientation="horizontal" aria-valuemin={minHeight} aria-valuemax={maxHeight} aria-valuenow={height} aria-label="拖拽调整终端高度" title="拖拽或方向键调整终端高度" onMouseDown={startResize} onKeyDown={event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      stopDrag.current();
      setDraggedHeight(event.key === 'Home' ? minHeight : event.key === 'End' ? maxHeight : clampHeight(height + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 40 : 20)));
    }} style={{ height: 6, flexShrink: 0, cursor: 'row-resize', background: draggedHeight !== null ? 'rgba(0,229,255,0.4)' : 'rgba(103,232,249,0.18)' }} />
    <header aria-hidden={modalOpen || undefined} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 12px', flexShrink: 0 }}>
      <strong title="官方 Claude Code · 原生终端" style={{ marginRight: 'auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>官方 Claude Code · 原生终端</strong>
      <label title="面板高度" style={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
        <SlidersHorizontal size={14} aria-hidden="true" style={{ position: 'absolute', left: 7, top: 7, pointerEvents: 'none' }} />
        <select aria-label="面板高度" style={{ ...headerControl, paddingLeft: 24, width: 82 }} value={size} onChange={e => { setSize(e.target.value); setDraggedHeight(null); }}><option value="compact">紧凑</option><option value="standard">标准</option><option value="large">较大</option></select>
      </label>
      <button aria-label="刷新列表" title="刷新列表" style={{ ...headerControl, width: 28 }} disabled={state.loading} onClick={() => void state.refresh()}><RefreshCw size={14} /></button>
      <button style={{ ...headerControl, ...primaryButton, height: 28 }} onClick={() => setFormOpen(true)}><Plus size={14} />新终端</button>
      <button aria-label="隐藏终端" title="隐藏终端（保留进程）" style={{ ...headerControl, width: 28 }} onClick={state.hide}><X size={14} /></button>
    </header>
    {state.terminals.some(term => term.status === 'closing') && <div style={{ padding: '4px 12px', color: '#fbbf24', fontSize: 12 }}>关闭中不代表已退出；进程仍可能存活，session 锁保留。失败后可再次点击关闭或刷新真实状态。</div>}
    {state.error && !modalOpen && <div role="alert" style={{ margin: '4px 12px', padding: '6px 8px', borderRadius: 6, border: '1px solid #ff475766', background: '#ff47571a', color: '#ff4757', fontSize: 12 }}>{state.error}</div>}
    {modalOpen && <NewTerminalForm key={state.formVersion} onCollapse={() => setFormOpen(false)} />}
    {!formOpen && <div style={{ padding: state.terminals.length ? '0 12px' : '8px 12px', flexShrink: 0 }}>
      {!state.terminals.length && <span style={{ color: '#a7b4c6', marginRight: 8 }}>尚无终端。</span>}
      <button type="button" style={{ ...button, padding: '2px 6px', fontSize: 12 }} onClick={() => setFormOpen(true)}>展开新建表单</button>
    </div>}
    <div role="tablist" aria-label="终端标签" style={{ display: 'flex', gap: 6, padding: state.terminals.length ? '6px 12px' : 0, overflowX: 'auto', flexShrink: 0 }}>
      {state.terminals.map(term => <div key={term.id} style={{ display: 'flex', flexShrink: 0, border: `1px solid ${term.id === state.activeTerminalId ? '#00e5ff66' : '#2a3349'}`, borderRadius: 6, overflow: 'hidden' }}>
        <button role="tab" aria-selected={term.id === state.activeTerminalId} style={{ ...headerControl, border: 0, borderRadius: 0, background: term.id === state.activeTerminalId ? '#00e5ff16' : '#161c2e', maxWidth: 260, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} onClick={() => state.select(term.id)}>{term.title} · {term.status === 'exited' ? `已退出 (${term.exitCode ?? '未知'})` : term.status === 'closing' ? '关闭中' : '运行中'}</button>
        <button style={{ ...headerControl, width: 26, border: 0, borderLeft: '1px solid #2a3349', borderRadius: 0 }} disabled={state.loading} aria-label={`关闭 ${term.title}`} title={`关闭 ${term.title}（结束进程）`} onClick={() => { void state.close(term.id).catch(() => {}); }}><X size={12} /></button>
      </div>)}
    </div>
    {(state.loading || state.terminals.some(term => term.id === state.activeTerminalId && term.status !== 'exited')) && <div style={{ display: 'flex', gap: 8, padding: '0 12px 4px', color: '#7d8b9f', flexShrink: 0, fontSize: 12, minWidth: 0 }}>
      {state.terminals.some(term => term.id === state.activeTerminalId && term.status !== 'exited') && <span role="status" title={`原生 PTY 占用 · ${state.activeTerminalId}；隐藏面板不会结束进程`} style={{ color: '#67e8f9', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>原生 PTY 占用 · {state.activeTerminalId}</span>}
      {state.loading && <span role="status">终端 IPC 处理中…</span>}
    </div>}
    {state.terminals.map(term => <TerminalViewport key={term.id} id={term.id} visible={state.open && term.id === state.activeTerminalId} />)}
  </section>;
}
export default NativeTerminalHost;
