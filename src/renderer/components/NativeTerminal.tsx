import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '../store';
import { getTerminalAPI, terminalError, updateTerminal, useTerminalStore, type TerminalDataEvent, type TerminalInitialCommand, type TerminalMode, type TerminalSpec } from '../terminalStore';

const modes: TerminalMode[] = ['interactive', 'teams', 'remote', 'cloud', 'mcp', 'plugins', 'agents', 'auth', 'doctor', 'shell'];
const initialCommands: TerminalInitialCommand[] = ['/mcp', '/plugin', '/hooks', '/config', '/resume'];
const managementCommands: Partial<Record<TerminalMode, string>> = { mcp: 'claude mcp --help', plugins: 'claude plugin --help', agents: 'claude agents --help' };
const field: CSSProperties = { background: '#111827', color: '#e2e8f0', border: '1px solid #475569', borderRadius: 5, padding: '6px 8px', minWidth: 0 };
const button: CSSProperties = { ...field, cursor: 'pointer' };

function NewTerminalForm() {
  const draft = useTerminalStore(s => s.formSpec);
  const loading = useTerminalStore(s => s.loading);
  const available = useTerminalStore(s => s.available);
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
  const sessionMode = ['interactive', 'teams', 'remote'].includes(mode);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const spec: TerminalSpec = { mode, cwd: cwd.trim() };
    if (sessionMode) {
      const options = { ...(chrome !== 'default' ? { chrome: chrome === 'enabled' } : {}), ...(ide ? { ide: true } : {}), ...(worktree.trim() ? { worktree: worktree.trim() } : {}) };
      if (Object.keys(options).length) spec.options = options;
      if (sessionId) { spec.sessionId = sessionId; spec.resume = true; }
    }
    if (mode === 'interactive' && initialCommand) spec.initialCommand = initialCommand;
    if (mode === 'cloud') spec.options = { cloudSession: cloudSession.trim() };
    try { await useTerminalStore.getState().create(spec); } catch { /* store renders the error */ }
  }
  return <form onSubmit={submit} aria-label="新终端" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', padding: 12, borderBottom: '1px solid #334155' }}>
    <label>模式 <select aria-label="模式" style={field} value={mode} onChange={e => setMode(e.target.value as TerminalMode)}>{modes.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    <label>工作目录 <input style={field} required value={cwd} onChange={e => setCwd(e.target.value)} /></label>
    {sessionMode && <>
      <label>恢复会话 <select aria-label="恢复会话" style={field} value={sessionId} onChange={e => setSessionId(e.target.value)}>
        <option value="">新 session（默认，不占用当前聊天）</option>
        {draft?.sessionId && !sessions.some(s => s.sessionId === draft.sessionId) && <option value={draft.sessionId}>{draft.sessionId}</option>}
        {sessions.map(s => <option key={s.sessionId} value={s.sessionId}>{s.title} · {s.sessionId}</option>)}
      </select></label>
      <label>Chrome <select aria-label="Chrome" style={field} value={chrome} onChange={e => setChrome(e.target.value)}><option value="default">CLI 默认</option><option value="enabled">启用</option><option value="disabled">禁用</option></select></label>
      <label><input type="checkbox" checked={ide} onChange={e => setIde(e.target.checked)} /> IDE</label>
      <label>Worktree 名称（可选） <input style={field} value={worktree} onChange={e => setWorktree(e.target.value)} /></label>
    </>}
    {mode === 'interactive' && <label>交互预设 <select aria-label="交互预设" style={field} value={initialCommand} onChange={e => setInitialCommand(e.target.value as TerminalInitialCommand | '')}><option value="">无（创建不写命令）</option>{initialCommands.map(command => <option key={command} value={command}>{command}</option>)}</select></label>}
    {mode === 'cloud' && <label>已有 Cloud session ID 或 URL <input style={field} required value={cloudSession} onChange={e => setCloudSession(e.target.value)} placeholder="已有 ID 或 https://claude.ai/code/…" /></label>}
    <button style={{ ...button, background: '#0e7490' }} disabled={loading || !available || !cwd.trim()} type="submit">创建终端</button>
  </form>;
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
    {truncated && <div role="status" style={{ padding: '4px 12px', color: '#fbbf24' }}>终端历史已截断（最多保留 4 MiB）；这里不是完整聊天 trace。</div>}
    <div style={{ padding: '0 12px 4px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <button style={button} onClick={() => setAttempt(value => value + 1)}>重新连接</button>
      {shell && <span>完整 shell：可输入管理、安装、配置等命令；建议 help 仅供起步，不代表管理功能已执行。</span>}
      {management && <><code>{management}</code><button style={button} disabled={!canWrite} onClick={() => explicitWrite.current(management)}>插入管理命令</button></>}
      {preset && <><span>可信预设写入当前 TUI；请确认输入位置，插入后自行回车，不自动执行。</span><button style={button} disabled={!canWrite} onClick={() => explicitWrite.current(preset)}>执行 {preset}</button></>}
      {(management || preset) && <button style={button} disabled={!canWrite} onClick={() => explicitWrite.current('\r')}>发送回车</button>}
    </div>
    {error && <div role="alert" style={{ padding: '4px 12px', color: '#fda4af' }}>{error}</div>}
    <div ref={container} style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '0 12px' }} />
  </div>;
}

/** Mount once beside the chat area, not inside its keyed conversation subtree. */
export function NativeTerminalHost() {
  const state = useTerminalStore();
  const [size, setSize] = useState('standard');
  useEffect(() => { if (useTerminalStore.getState().open) void useTerminalStore.getState().refresh(); }, []);
  return <section aria-label="官方原生终端" hidden={!state.open} style={{
    display: state.open ? 'flex' : 'none', flexDirection: 'column', minHeight: 300,
    height: size === 'compact' ? 300 : size === 'large' ? '45vh' : '38vh', maxHeight: 'max(300px, 45vh)',
    background: '#0f172a', color: '#e2e8f0', borderTop: '1px solid #475569', font: '13px system-ui', overflow: 'hidden',
  }}>
    <header style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px' }}>
      <strong style={{ marginRight: 'auto' }}>官方 Claude Code · 原生终端</strong>
      {state.terminals.some(term => term.id === state.activeTerminalId && term.status !== 'exited') && <span role="status" style={{ color: '#67e8f9', overflowWrap: 'anywhere' }}>原生 PTY 占用 · {state.activeTerminalId}</span>}
      {state.loading && <span role="status">终端 IPC 处理中…</span>}
      <label>面板高度 <select aria-label="面板高度" style={field} value={size} onChange={e => setSize(e.target.value)}><option value="compact">紧凑</option><option value="standard">标准</option><option value="large">较大</option></select></label>
      <button style={button} disabled={state.loading} onClick={() => void state.refresh()}>刷新列表</button>
      <button style={button} onClick={() => state.show()}>新终端</button>
      <button style={button} onClick={state.hide}>隐藏终端</button>
    </header>
    {state.terminals.some(term => term.status === 'closing') && <div style={{ padding: '4px 12px', color: '#fbbf24' }}>关闭中不代表已退出；进程仍可能存活，session 锁保留。失败后可再次点击关闭或刷新真实状态。</div>}
    {state.error && <div role="alert" style={{ padding: '8px 12px', background: '#451a23' }}>{state.error}</div>}
    {state.open && <NewTerminalForm key={state.formVersion} />}
    <div role="tablist" aria-label="终端标签" style={{ display: 'flex', gap: 8, padding: '6px 12px', overflowX: 'auto' }}>
      {state.terminals.map(term => <div key={term.id} style={{ display: 'flex', flexShrink: 0, gap: 4 }}>
        <button role="tab" aria-selected={term.id === state.activeTerminalId} style={button} onClick={() => state.select(term.id)}>{term.title} · {term.status === 'exited' ? `已退出 (${term.exitCode ?? '未知'})` : term.status === 'closing' ? '关闭中' : '运行中'}</button>
        <button style={button} disabled={state.loading} aria-label={`关闭 ${term.title}`} onClick={() => { void state.close(term.id).catch(() => {}); }}>×</button>
      </div>)}
    </div>
    <div style={{ padding: '0 12px 8px', color: '#94a3b8' }}>官方终端不是聊天 trace；仅键盘输入发送至 PTY。隐藏面板不会结束进程。</div>
    {state.terminals.map(term => <TerminalViewport key={term.id} id={term.id} visible={state.open && term.id === state.activeTerminalId} />)}
  </section>;
}
export default NativeTerminalHost;
