import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useTerminalStore, type TerminalMode } from '../terminalStore';
import { confirmAction } from './ConfirmDialog';
import { InfoNote, SettingRow } from './settings/SettingsControls';
import { BUTTON, BUTTON_PRIMARY, BUTTON_DANGER, BUTTON_GHOST, BUTTON_SM } from './controls';
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
const inputClass = 'mt-1 h-8 w-full min-w-0 rounded-lg border border-border bg-bg-light px-2.5 text-xs text-text-primary focus:border-accent-cyan/50 focus:outline-none';
const buttonClass = BUTTON;
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
  const openNative = async () => {
    setError('');
    if (!getSettingsAPI()?.terminal || typeof useTerminalStore.getState().show !== 'function') { setError('原生终端 API 不可用；请等待主进程接入。'); return; }
    const state = useStore.getState();
    const conv = state.conversations.find(c => c.id === state.activeConversationId);
    if (conv?.runtime?.busy || ['busy', 'starting', 'closing'].includes(conv?.runtime?.state ?? '')
      || ['starting', 'streaming'].includes(conv?.status ?? '') || conv?.pendingApprovals?.length
      || conv?.runtime?.pendingApprovals?.length || conv?.runtime?.pendingUserMessageIds?.length || conv?.queue?.length) {
      setError('当前对话忙碌或等待审批，不能移交原生功能；请等待空闲。'); return;
    }
    if (!await confirmAction({ title: '打开原生功能管理', message: '打开原生功能管理表单；同一会话的所有权移交仍由主进程确认，忙碌时会拒绝。不会自动执行命令。', confirmLabel: '打开' })) return;
    useTerminalStore.getState().show({ mode: nativeMode, cwd: conv?.cwd || state.cwd,
      ...(nativeMode === 'interactive' ? { options: { chrome, ide, ...(worktree.trim() ? { worktree: worktree.trim() } : {}) } } : {}) });
    onOpenNative?.();
  };

  return <section className="space-y-2 text-xs text-text-secondary" aria-label="Claude 运行时设置">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 pb-2">
      <h2 className="text-sm font-semibold text-text-primary">Claude 运行时配置</h2>
      <button className={BUTTON_SM} disabled={busy} onClick={refresh}>重新读取配置</button>
    </div>
    <p className="text-2xs leading-5">这些操作逐项提交，不受底部“保存”控制；忙碌会话不会被中断。</p>
    {error && <div role="alert" className="flex flex-wrap items-center gap-2 text-accent-red">{error}<button className={buttonClass} onClick={() => setError('')}>清除错误提示</button></div>}
    {note && <p role="status">{note}</p>}
    {!available && <InfoNote tone="warning">运行时 API 不可用；不提交配置。</InfoNote>}
    <fieldset disabled={busy || !available || !summary} className="mt-2 min-w-0 space-y-0">
      <legend className="sr-only">逐项保存运行配置</legend>
      <div className="space-y-1 border-b border-border/30 py-3">
        <label className="flex items-start gap-2"><input className="mt-0.5" type="checkbox" checked={persist} disabled={!canPersist} onChange={e => setPersist(e.target.checked)} />使用系统安全存储持久化环境配置（默认关闭）</label>
        <p className="text-2xs leading-5">{canPersist ? '不勾选：仅本次内存工作，发送 persist: false；退出应用后不保留。' : '系统安全加密不可用：禁止持久化环境配置；仍可仅本次内存工作，发送 persist: false。'}当前配置：{summary?.persisted ? '持久化' : '仅内存'}。</p>
        <p className="text-2xs text-text-dim">此选择用于下一次逐项提交；不会自动转换当前配置的存储方式。</p>
      </div>
      <SettingRow
        id="cli"
        title="CLI 可执行文件"
        description="决定 GUI 调用哪个 Claude Code CLI。必须是绝对路径，不是 shell 命令。"
        apply="save"
        savedValue={summary?.executable || '自动查找 CLI'}
        draftValue={executable === (summary?.executable ?? '') ? (summary?.executable || '自动查找 CLI') : executable || '空输入（不删除现有路径）'}
      >
        <label className="block text-xs text-text-secondary">CLI 可执行文件绝对路径
          <input aria-label="CLI 可执行文件绝对路径" className={inputClass} value={executable} onChange={e => setExecutable(e.target.value)} spellCheck={false} />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className={BUTTON_PRIMARY} onClick={() => {
            if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(executable) || executable.includes('\0')) { setError('CLI 可执行文件必须是绝对路径；不是 shell 命令。'); return; }
            void update({ executable });
          }}>保存 CLI 路径</button>
        </div>
        <InfoNote>留空不会删除现有路径；仅“重置”发送 executable: null。</InfoNote>
      </SettingRow>

      <SettingRow
        id="env"
        title="环境变量"
        description="覆盖或移除 CLI 子进程环境键。仅覆盖输入，不读取、显示或复制现有值。"
        apply="save"
      >
        <div className="space-y-2">
          <p className="break-all leading-5">已配置环境键：{summary?.environmentKeys.join(', ') || '无'}</p>
          <p className="break-all leading-5">已移除环境键：{summary?.removedKeys.join(', ') || '无'}</p>
          <label className="block">环境变量键<select aria-label="环境变量键" className={inputClass} value={key} onChange={e => setKey(e.target.value)}>{keys.map(k => <option key={k}>{k}</option>)}</select></label>
          <label className="block">环境变量值<input type="password" autoComplete="new-password" spellCheck={false} className={inputClass} value={value} onChange={e => setValue(e.target.value)} /></label>
          <p>明确空值 = 覆盖为空字符串，不是清除现有配置。</p>
          <div className="flex flex-wrap gap-2"><button className={BUTTON_PRIMARY} disabled={!keys.includes(key) || (persist && !canPersist)} onClick={() => void update({ environmentUpdates: [{ key, value }] })}>覆盖此环境变量</button>
            <button className={BUTTON_DANGER} disabled={!keys.includes(key) || (persist && !canPersist)} onClick={async () => { if (await confirmAction({ title: '移除环境变量', message: `确认移除环境变量 ${key}？这将显式屏蔽该键，而不是覆盖为空。`, confirmLabel: '移除', tone: 'danger' })) void update({ environmentUpdates: [{ key, remove: true }] }); }}>移除此环境变量</button></div>
          <p className="text-2xs text-text-dim">输入仅待逐项提交；成功后清空输入，失败保留。现有值不会回显。</p>
        </div>
      </SettingRow>
      <section aria-label="运行配置低频操作" className="space-y-3 border-t border-border/40 py-3">
        <h3 className="text-xs font-medium text-text-primary">重置与环境导入</h3>
        <div className="space-y-2">
          <p className="text-2xs leading-5">重置会移除显式 CLI 路径，恢复自动查找；不会自动启动或重新连接。</p>
          <button className={BUTTON_GHOST} onClick={() => void update({ executable: null })}>重置为自动查找 CLI</button>
        </div>
        <div className="space-y-2 border-t border-accent-yellow/20 pt-3">
          <InfoNote tone="warning">导入会运行 Shell 启动配置，并覆盖允许的环境键；不是只读检查。需要勾选并再次确认。</InfoNote>
          <label className="flex items-start gap-2"><input className="mt-0.5" type="checkbox" checked={importConsent} onChange={e => setImportConsent(e.target.checked)} />{SHELL_CONSENT}</label>
          <button className={buttonClass} disabled={!importConsent || (persist && !canPersist)} onClick={async () => { if (importConsent && await confirmAction({ title: '导入登录 Shell 环境', message: SHELL_CONSENT, confirmLabel: '导入', tone: 'danger' })) void update({ importLoginEnvironment: true }); }}>导入登录 Shell 环境</button>
        </div>
      </section>
    </fieldset>

    <h2 className="border-t border-border/40 pt-3 text-xs font-medium text-text-primary">诊断与原生工具</h2>
    <SettingRow
      id="diagnostics"
      title="运行时诊断"
      description="手动检查 CLI 版本与配置；只展示脱敏结果，不显示代理值或密钥。不会自动执行诊断。"
      apply="immediate"
    >
      <div className="space-y-1">
        <button className={buttonClass} disabled={busy} onClick={diagnose}>刷新运行时诊断</button>
        {diagnostics && <div className="mt-2 space-y-1 break-all leading-5" aria-label="运行时诊断">
          <p>CLI 版本：{diagnostics.version && /^\d+\.\d+\.\d+$/.test(diagnostics.version) ? diagnostics.version : '未获取'}</p>
          <p>CLI 路径：{diagnostics.executable ?? '未找到'}</p>
          <p>脱敏端点：{safeEndpoint(diagnostics.endpoint)}</p>
          <p>环境键：{diagnostics.environmentKeys.join(', ') || '无'}</p>
          <p>代理配置存在：{diagnostics.environmentKeys.some(k => /^(https?|all|no)_proxy$/i.test(k)) ? '是' : '否'}（仅检查配置键，不显示代理值）</p>
        </div>}
      </div>
    </SettingRow>

    <SettingRow
      id="native"
      title="原生功能管理"
      description="只打开下一个原生表单，不执行自动命令；不伪造 GUI 常驻进程预算。"
      apply="immediate"
    >
      <div className="space-y-2">
        <label className="block">原生功能<select aria-label="原生功能" className={inputClass} value={nativeMode} onChange={e => setNativeMode(e.target.value as TerminalMode)}>
          {([['interactive', '交互 CLI / Shell / Hooks / Config'], ['mcp', 'MCP'], ['plugins', 'Plugins'], ['agents', 'Agents'], ['auth', '登录 Auth'], ['doctor', 'Doctor']] as const).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
        </select></label>
        {nativeMode === 'interactive' && <div className="space-y-2">
          <label className="block"><input type="checkbox" checked={chrome} onChange={e => setChrome(e.target.checked)} />Chrome（原生交互终端）</label>
          <label className="block"><input type="checkbox" checked={ide} onChange={e => setIde(e.target.checked)} />IDE（原生交互终端）</label>
          <label className="block">Worktree 名称（原生交互终端，可选）<input className={inputClass} value={worktree} onChange={e => setWorktree(e.target.value)} /></label>
        </div>}
        <details className="rounded-lg border border-border/60 p-2 text-2xs leading-5">
          <summary className="min-h-7 cursor-pointer text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan">查看限制说明</summary>
          <div className="mt-2 space-y-1">
            <p>Shell / Hooks / Config 请进入交互 CLI 后手动输入 !、/hooks、/config。当前终端表单尚无 initialCommand 字段，不传未支持选项。</p>
            <p>主聊天 Chrome / IDE / additionalDirectories / worktree 暂无 store 启动选项字段，此处不伪造全局集成开关。</p>
          </div>
        </details>
        <button className={buttonClass} onClick={() => void openNative()}>原生功能管理</button>
      </div>
    </SettingRow>
  </section>;
}
