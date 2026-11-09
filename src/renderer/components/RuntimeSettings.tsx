import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useTerminalStore, type TerminalMode } from '../terminalStore';
import type { ConversationRuntime, PermissionMode } from '../types';

interface RuntimeSummary {
  executable: string | null;
  environmentKeys: string[];
  removedKeys: string[];
  encryptionAvailable: boolean;
  persisted: boolean;
  endpoint?: string | null;
  allowedKeys?: string[];
}
interface RuntimeUpdate {
  executable?: string | null;
  environmentUpdates?: ({ key: string; value: string } | { key: string; remove: true })[];
  importLoginEnvironment?: boolean;
}
interface RuntimeAPI {
  get(): Promise<RuntimeSummary>;
  set(options: RuntimeUpdate, storage: { persist: boolean }): Promise<RuntimeSummary>;
  diagnostics(): Promise<RuntimeSummary & { version: string | null; error?: string | null }>;
}
interface Result { success: boolean; error?: string }
export interface SettingsClaudeAPI {
  runtimeState?: (conversationId: string) => Promise<ConversationRuntime>;
  mode?: (payload: { conversationId: string; mode: PermissionMode }) => Promise<Result>;
  close?: (conversationId: string) => Promise<Result>;
  start?: (payload: { conversationId: string; cwd: string; options: Record<string, unknown> }) => Promise<ConversationRuntime & Result>;
}
export function getSettingsAPI() {
  return (window as unknown as { api?: { runtime?: RuntimeAPI; claude?: SettingsClaudeAPI; terminal?: unknown } }).api;
}

// Same base allowlist as ClaudeRuntime; no arbitrary environment names or values are read back.
const BASE_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION',
  'AWS_DEFAULT_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CA_BUNDLE',
  'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_SDK_LOAD_CONFIG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_AUTOUPDATE', 'CLAUDE_CODE_DISABLE_TELEMETRY',
  'CLAUDE_BASH_NO_LOGIN', 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
];
const SHELL_CONSENT = '将运行shell启动配置并仅导入允许的环境变量';
const inputClass = 'w-full mt-1 px-2 py-1.5 rounded-lg bg-bg-light border border-border text-text-primary';
const buttonClass = 'px-3 py-2 rounded-lg bg-bg-light border border-border text-xs text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed';
function safeEndpoint(value?: string | null) {
  try {
    const url = new URL(value || '');
    return ['http:', 'https:'].includes(url.protocol) ? `${url.protocol}//${url.host}${url.pathname}` : '未配置';
  } catch { return '未配置'; }
}
function safeRuntimeError(error: unknown) {
  // IPC failures can contain subprocess output. Never echo that output (or secret input) into the DOM.
  const message = error instanceof Error ? error.message : '';
  if (/decrypt|could not be read/i.test(message)) return '运行时配置读取或解密失败；现有配置未改变。请检查系统安全存储权限后重试。';
  if (/permission|denied|EACCES/i.test(message)) return '运行时配置权限不足；现有配置未改变。请检查权限后重试。';
  if (/encrypt|Secure encryption/i.test(message)) return '安全加密或保存失败；现有配置未改变。可显式选择仅本次内存配置后重试。';
  return '运行时操作失败；未确认成功，不会清除现有配置。请检查 CLI 和权限后重试。';
}

export function RuntimeSettings({ onChanged, onOpenNative }: { onChanged?: () => void; onOpenNative?: () => void }) {
  const [summary, setSummary] = useState<RuntimeSummary | null>(null);
  const [executable, setExecutable] = useState('');
  const [key, setKey] = useState('ANTHROPIC_API_KEY');
  const [value, setValue] = useState('');
  const [persist, setPersist] = useState(false);
  const [importConsent, setImportConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [diagnostics, setDiagnostics] = useState<(RuntimeSummary & { version: string | null }) | null>(null);
  const [nativeMode, setNativeMode] = useState<TerminalMode>('interactive');
  const [chrome, setChrome] = useState(false);
  const [ide, setIde] = useState(false);
  const [worktree, setWorktree] = useState('');
  const lock = useRef(false);
  const mounted = useRef(false);
  const api = getSettingsAPI()?.runtime;
  const available = typeof api?.get === 'function' && typeof api?.set === 'function';
  const keys = [...new Set(summary?.allowedKeys ?? BASE_KEYS)].filter(k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  const canPersist = summary?.encryptionAvailable === true;

  const refresh = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setDiagnostics(null);
    try {
      const runtime = getSettingsAPI()?.runtime;
      if (typeof runtime?.get !== 'function') { setSummary(null); setError('运行时 API 不可用；请等待主进程接入。'); return; }
      const result = await runtime.get();
      if (!mounted.current) return;
      setSummary(result); setExecutable(result.executable ?? '');
      if (!result.encryptionAvailable) setPersist(false);
    } catch (error) { if (mounted.current) { setSummary(null); setError(safeRuntimeError(error)); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);

  const update = async (options: RuntimeUpdate) => {
    if (lock.current || !summary) return;
    lock.current = true; setBusy(true); setError(''); setNote('');
    try {
      const runtime = getSettingsAPI()?.runtime;
      if (typeof runtime?.set !== 'function') throw new Error('No runtime API');
      const result = await runtime.set(options, { persist });
      if (!mounted.current) return;
      setSummary(result); setExecutable(result.executable ?? ''); setDiagnostics(null);
      if (!result.encryptionAvailable) setPersist(false);
      setValue(''); setImportConsent(false);
      setNote('运行时配置已保存；现有 CLI 不会热更新，请空闲时显式重新连接，或用于下次新连接。');
      onChanged?.();
    } catch (error) { if (mounted.current) setError(safeRuntimeError(error)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const diagnose = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setDiagnostics(null);
    try {
      const runtime = getSettingsAPI()?.runtime;
      if (typeof runtime?.diagnostics !== 'function') { setError('运行时诊断 API 不可用。'); return; }
      const result = await runtime.diagnostics();
      if (!mounted.current) return;
      setDiagnostics(result);
      if (result.error) setError('CLI 诊断失败：可执行文件不存在、不可执行或版本检查失败，请检查后重试。');
    } catch (error) { if (mounted.current) setError(safeRuntimeError(error)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const openNative = () => {
    setError('');
    if (!getSettingsAPI()?.terminal || typeof useTerminalStore.getState().show !== 'function') { setError('原生终端 API 不可用；请等待主进程接入。'); return; }
    const state = useStore.getState();
    const conv = state.conversations.find(c => c.id === state.activeConversationId);
    if (conv?.runtime?.busy || ['busy', 'starting', 'closing'].includes(conv?.runtime?.state ?? '')
      || ['starting', 'streaming'].includes(conv?.status ?? '') || conv?.pendingApprovals?.length
      || conv?.runtime?.pendingApprovals?.length || conv?.runtime?.pendingUserMessageIds?.length || conv?.queue?.length) {
      setError('当前对话忙碌或等待审批，不能移交原生功能；请等待空闲。'); return;
    }
    if (!window.confirm('打开原生功能管理表单；同一会话的所有权移交仍由主进程确认，忙碌时会拒绝。不会自动执行命令。')) return;
    useTerminalStore.getState().show({ mode: nativeMode, cwd: conv?.cwd || state.cwd,
      ...(nativeMode === 'interactive' ? { options: { chrome, ide, ...(worktree.trim() ? { worktree: worktree.trim() } : {}) } } : {}) });
    onOpenNative?.();
  };

  return <section className="space-y-3 text-xs text-text-secondary" aria-label="Claude 运行时设置">
    <h3 className="font-semibold">Claude 运行时配置</h3>
    {error && <div role="alert" className="text-red-400">{error}<button className={buttonClass} onClick={() => setError('')}>清除错误提示</button></div>}
    {note && <p role="status">{note}</p>}
    <button className={buttonClass} disabled={busy} onClick={refresh}>重新读取配置</button>
    {!available && <p>运行时 API 不可用；不提交配置。</p>}
    <fieldset disabled={busy || !available || !summary} className="space-y-2">
      <label className="block">CLI 可执行文件绝对路径<input className={inputClass} value={executable} onChange={e => setExecutable(e.target.value)} spellCheck={false} /></label>
      <div className="flex gap-2"><button className={buttonClass} onClick={() => {
        if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(executable) || executable.includes('\0')) { setError('CLI 可执行文件必须是绝对路径；不是 shell 命令。'); return; }
        void update({ executable });
      }}>保存 CLI 路径</button><button className={buttonClass} onClick={() => void update({ executable: null })}>重置为自动查找 CLI</button></div>
      <p>留空不会删除现有路径；仅“重置”发送 executable: null。</p>
      <p>已配置环境键：{summary?.environmentKeys.join(', ') || '无'}</p>
      <p>已移除环境键：{summary?.removedKeys.join(', ') || '无'}</p>
      <label className="block">环境变量键<select aria-label="环境变量键" className={inputClass} value={key} onChange={e => setKey(e.target.value)}>{keys.map(k => <option key={k}>{k}</option>)}</select></label>
      <label className="block">环境变量值<input type="password" autoComplete="new-password" spellCheck={false} className={inputClass} value={value} onChange={e => setValue(e.target.value)} /></label>
      <p>仅覆盖输入，不读取、显示或复制现有值。明确空值 = 覆盖为空字符串，不是清除现有配置。</p>
      <div className="flex gap-2"><button className={buttonClass} disabled={!keys.includes(key) || (persist && !canPersist)} onClick={() => void update({ environmentUpdates: [{ key, value }] })}>覆盖此环境变量</button>
        <button className={buttonClass} disabled={!keys.includes(key) || (persist && !canPersist)} onClick={() => { if (window.confirm(`确认移除环境变量 ${key}？这将显式屏蔽该键，而不是覆盖为空。`)) void update({ environmentUpdates: [{ key, remove: true }] }); }}>移除此环境变量</button></div>
      <label className="block"><input type="checkbox" checked={persist} disabled={!canPersist} onChange={e => setPersist(e.target.checked)} />使用系统安全存储持久化环境配置（默认关闭）</label>
      <p>{canPersist ? '不勾选：仅本次内存工作，发送 persist: false；退出应用后不保留。' : '系统安全加密不可用：禁止持久化环境配置；仍可仅本次内存工作，发送 persist: false。'}当前配置：{summary?.persisted ? '持久化' : '仅内存'}。</p>
      <label className="block"><input type="checkbox" checked={importConsent} onChange={e => setImportConsent(e.target.checked)} />{SHELL_CONSENT}</label>
      <button className={buttonClass} disabled={!importConsent || (persist && !canPersist)} onClick={() => { if (importConsent && window.confirm(SHELL_CONSENT)) void update({ importLoginEnvironment: true }); }}>导入登录 Shell 环境</button>
    </fieldset>
    <button className={buttonClass} disabled={busy} onClick={diagnose}>刷新运行时诊断</button>
    {diagnostics && <div className="space-y-1" aria-label="运行时诊断">
      <p>CLI 版本：{diagnostics.version && /^\d+\.\d+\.\d+$/.test(diagnostics.version) ? diagnostics.version : '未获取'}</p>
      <p>CLI 路径：{diagnostics.executable ?? '未找到'}</p>
      <p>脱敏端点：{safeEndpoint(diagnostics.endpoint)}</p>
      <p>环境键：{diagnostics.environmentKeys.join(', ') || '无'}</p>
      <p>代理配置存在：{diagnostics.environmentKeys.some(k => /^(https?|all|no)_proxy$/i.test(k)) ? '是' : '否'}（仅检查配置键，不显示代理值）</p>
    </div>}
    <h3 className="font-semibold">原生功能管理</h3>
    <label className="block">原生功能<select aria-label="原生功能" className={inputClass} value={nativeMode} onChange={e => setNativeMode(e.target.value as TerminalMode)}>
      {([['interactive', '交互 CLI / Shell / Hooks / Config'], ['mcp', 'MCP'], ['plugins', 'Plugins'], ['agents', 'Agents'], ['auth', '登录 Auth'], ['doctor', 'Doctor']] as const).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
    </select></label>
    {nativeMode === 'interactive' && <div className="space-y-2">
      <label className="block"><input type="checkbox" checked={chrome} onChange={e => setChrome(e.target.checked)} />Chrome（原生交互终端）</label>
      <label className="block"><input type="checkbox" checked={ide} onChange={e => setIde(e.target.checked)} />IDE（原生交互终端）</label>
      <label className="block">Worktree 名称（原生交互终端，可选）<input className={inputClass} value={worktree} onChange={e => setWorktree(e.target.value)} /></label>
    </div>}
    <p>仅打开下一个原生表单，不执行自动命令；Shell / Hooks / Config 请进入交互 CLI 后手动输入 !、/hooks、/config。当前终端表单尚无 initialCommand 字段，不传未支持选项。</p>
    <p>主聊天 Chrome / IDE / additionalDirectories / worktree 暂无 store 启动选项字段，此处不伪造全局集成开关。原生交互 CLI 不支持该 GUI 常驻进程预算，不是“每轮预算”。</p>
    <button className={buttonClass} onClick={openNative}>原生功能管理</button>
  </section>;
}
