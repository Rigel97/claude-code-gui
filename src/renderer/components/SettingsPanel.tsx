import { useState, useEffect, useRef } from 'react';
import type { ConversationRuntime, PermissionMode } from '../types';
import { useStore } from '../store';
import { RuntimeSettings, getSettingsAPI } from './RuntimeSettings';
import { X, Cpu, Info, Shield, Bell, Archive, Trash2, RotateCcw, Gauge, Boxes, DollarSign, Film, FolderOpen } from 'lucide-react';

type EffortLevel = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type Autocompact = '' | 'auto' | '100k' | '200k' | '400k' | '800k' | '1M';

const EFFORT_OPTIONS: { id: EffortLevel; label: string; desc: string }[] = [
  { id: '', label: '默认', desc: 'CLI 自动决定' },
  { id: 'low', label: '低', desc: '快速响应' },
  { id: 'medium', label: '中', desc: '均衡' },
  { id: 'high', label: '高', desc: '更多思考' },
  { id: 'xhigh', label: '超高', desc: '深度推理' },
  { id: 'max', label: '最大', desc: '最强思考预算' },
];

const AUTOCOMPACT_OPTIONS: { id: Autocompact; label: string; desc: string }[] = [
  { id: '', label: '默认', desc: 'CLI 自动管理' },
  { id: 'auto', label: 'Auto', desc: '自动选时机' },
  { id: '200k', label: '200k', desc: '更早压缩' },
  { id: '400k', label: '400k', desc: '中等' },
  { id: '800k', label: '800k', desc: '尽量保留' },
  { id: '1M', label: '1M', desc: '压缩阈值，不扩大模型上下文窗口' },
];

const PERMISSION_MODES: { id: PermissionMode; label: string; desc: string }[] = [
  { id: 'default', label: '逐次审批', desc: '默认模式：需要权限的工具调用逐次审批，已有允许规则仍适用。' },
  { id: 'acceptEdits', label: '仅自动接受文件编辑', desc: '自动接受文件编辑，命令执行等其他工具仍按规则请求审批。' },
  { id: 'plan', label: '只读规划', desc: '只读分析和规划，不执行修改。' },
  { id: 'auto', label: '自动审批（依赖 CLI 可用）', desc: '由 CLI 自动判断审批；依赖安装的 CLI 支持，失败会明确提示。' },
  { id: 'dontAsk', label: '仅规则、不弹问', desc: '只遵循允许规则，不弹出权限询问；未获允许的操作拒绝。' },
  { id: 'bypassPermissions', label: '全部放行（危险）', desc: '跳过权限检查，可能执行危险命令；必须明确确认，CLI 可能要求重新连接。' },
];

const SESSION_LIMIT_OPTIONS = [20, 50, 100, 200];
function VideoBgSettings() {
  const videoBg = useStore((s) => s.videoBg);
  const setVideoBg = useStore((s) => s.setVideoBg);

  // 选择本机视频文件：主进程弹原生选框并登记 bgmedia:// 白名单，选中即生效
  const pickVideo = async () => {
    const api = (window as any).api?.videoBg;
    if (!api) return;
    const filePath: string | null = await api.pick();
    if (filePath) setVideoBg({ path: filePath, enabled: true });
  };

  const fileName = videoBg.path ? videoBg.path.split(/[\\/]/).pop() : null;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-text-secondary font-mono uppercase tracking-wider">
        <Film className="w-3.5 h-3.5" />
        动态视频背景
      </div>
      <Toggle
        on={videoBg.enabled && !!videoBg.path}
        color="purple"
        label="启用视频背景"
        onClick={() => {
          // 未选视频时开关无效（需先选择文件）
          if (!videoBg.path) return;
          setVideoBg({ enabled: !videoBg.enabled });
        }}
      />
      <div className="flex gap-1.5">
        <button
          onClick={pickVideo}
          className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-xs text-text-muted hover:text-accent-cyan bg-bg-light border border-border hover:border-accent-cyan/40 transition-all"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          选择视频文件…
        </button>
        <button
          onClick={() => setVideoBg({ path: null, enabled: false })}
          disabled={!videoBg.path}
          title="移除视频文件并恢复默认背景"
          className="px-2.5 py-2 rounded-lg text-xs text-text-muted hover:text-red-400 bg-bg-light border border-border hover:border-red-500/30 transition-all disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        >
          清除
        </button>
      </div>
      {fileName && (
        <div
          className="text-[10px] text-text-dim truncate font-mono"
          title={videoBg.path ?? undefined}
        >
          {fileName}
        </div>
      )}
      <p className="text-[10px] text-text-dim leading-relaxed">
        支持 mp4 / webm / mov / m4v / ogv。建议选择低码率、可无缝循环的短视频以降低功耗；
        视频经本机 bgmedia 协议直读，不联网，路径仅保存在本机。
      </p>
    </section>
  );
}

function Toggle({ on, color, label, onClick }: {
  on: boolean;
  color: 'purple' | 'blue';
  label: string;
  onClick: () => void;
}) {
  const active = color === 'purple'
    ? 'bg-accent-purple/10 border border-accent-purple/40 text-accent-purple'
    : 'bg-accent-blue/10 border border-accent-blue/40 text-accent-blue';
  const knob = color === 'purple' ? 'bg-accent-purple/40' : 'bg-accent-blue/40';
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-all ${
        on ? active : 'bg-bg-light border border-border text-text-secondary'
      }`}
    >
      <span>{label}</span>
      <div className={`w-9 h-5 rounded-full relative transition-colors ${on ? knob : 'bg-bg-lighter'}`}>
        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-text-primary transition-all ${on ? 'left-4' : 'left-0.5'}`} />
      </div>
    </button>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const model = useStore((s) => s.model);
  const setModel = useStore((s) => s.setModel);
  // 当前实际使用：活跃标签页的 CLI init 回显（各标签页可能不同）
  const currentModel = useStore(
    (s) => s.conversations.find((c) => c.id === s.activeConversationId)?.currentModel || ''
  );
  const permissionMode = useStore((s) => s.permissionMode);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const showThinking = useStore((s) => s.showThinking);
  const setShowThinking = useStore((s) => s.setShowThinking);
  const notifyOnComplete = useStore((s) => s.notifyOnComplete);
  const setNotifyOnComplete = useStore((s) => s.setNotifyOnComplete);
  const maxSessions = useStore((s) => s.maxSessions);
  const setMaxSessions = useStore((s) => s.setMaxSessions);
  const effortLevel = useStore((s) => s.effortLevel);
  const setEffortLevel = useStore((s) => s.setEffortLevel);
  const autocompact = useStore((s) => s.autocompact);
  const setAutocompact = useStore((s) => s.setAutocompact);
  const maxBudgetUsd = useStore((s) => s.maxBudgetUsd);
  const setMaxBudgetUsd = useStore((s) => s.setMaxBudgetUsd);
  const clearAllSessions = useStore((s) => s.clearAllSessions);
  const sessions = useStore((s) => s.sessions);

  // 模型 ID 直接作为 --model 传给 CLI；留空表示跟随 CLI 默认配置。
  // 不提供预设别名：非官方端点（如 GLM 中转）上 sonnet/opus/haiku 等别名无效
  const [localModel, setLocalModel] = useState(model);
  const [localPermissionMode, setLocalPermissionMode] = useState(permissionMode);
  const [localShowThinking, setLocalShowThinking] = useState(showThinking);
  const [localNotify, setLocalNotify] = useState(notifyOnComplete);
  const [localMaxSessions, setLocalMaxSessions] = useState(maxSessions);
  const [localEffort, setLocalEffort] = useState<EffortLevel>(effortLevel);
  const [localAutocompact, setLocalAutocompact] = useState<Autocompact>(autocompact);
  const [localBudget, setLocalBudget] = useState(maxBudgetUsd > 0 ? String(maxBudgetUsd) : '');
  const [confirmClear, setConfirmClear] = useState(false);
  const activeConversationId = useStore(s => s.activeConversationId);
  const activeConversation = useStore(s => s.conversations.find(c => c.id === s.activeConversationId));
  const [settingsError, setSettingsError] = useState('');
  const [settingsNote, setSettingsNote] = useState('');
  const [saving, setSaving] = useState(false);
  const settingsLock = useRef(false);
  const bypassConfirmed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const api = getSettingsAPI()?.claude;
    if (activeConversationId && typeof api?.runtimeState === 'function') {
      void api.runtimeState(activeConversationId).then(runtime => {
        if (!cancelled) useStore.getState().setRuntime(activeConversationId, runtime);
      }).catch(() => { if (!cancelled) setSettingsError('当前对话运行状态读取失败；请重试，不会伪造本地状态。'); });
    }
    return () => { cancelled = true; };
  }, [activeConversationId]);

  const saveGlobal = () => {
    setModel(localModel.trim());
    setPermissionMode(localPermissionMode);
    setShowThinking(localShowThinking);
    setNotifyOnComplete(localNotify);
    setMaxSessions(localMaxSessions);
    setEffortLevel(localEffort);
    setAutocompact(localAutocompact);
    const budget = parseFloat(localBudget);
    setMaxBudgetUsd(Number.isFinite(budget) && budget > 0 ? budget : 0);
  };
  const isBusy = (runtime: ConversationRuntime) => runtime.busy || runtime.state !== 'ready'
    || runtime.pendingApprovals?.length || runtime.pendingUserMessageIds?.length;
  const cannotReconnect = (runtime: ConversationRuntime) => runtime.busy
    || !['ready', 'closed'].includes(runtime.state ?? '')
    || runtime.pendingApprovals?.length || runtime.pendingUserMessageIds?.length;
  const locallyBusy = (id: string) => {
    const conv = useStore.getState().conversations.find(c => c.id === id);
    return !conv || ['starting', 'streaming'].includes(conv.status) || conv.pendingApprovals?.length || conv.queue?.length;
  };
  const confirmBypass = () => localPermissionMode !== 'bypassPermissions' || bypassConfirmed.current
    || (bypassConfirmed.current = window.confirm('危险：全部放行将跳过权限检查，可能执行任意命令。确认启用 bypassPermissions？'));

  const handleSave = async () => {
    if (settingsLock.current || !confirmBypass()) return;
    settingsLock.current = true; setSaving(true); setSettingsError('');
    saveGlobal();
    setSettingsNote('全局设置已保存；现有 CLI 不随全局设置热更新。模型、思考深度、压缩阈值、预算及运行时配置应用于下次连接；请空闲时显式重新连接当前对话。');
    try {
      const state = useStore.getState();
      const conv = state.conversations.find(c => c.id === state.activeConversationId);
      if (!conv || !(conv.protocolConnected || conv.runtime)) return;
      const api = getSettingsAPI()?.claude;
      if (typeof api?.runtimeState !== 'function') { setSettingsError('全局已保存，但当前对话运行状态 API 不可用；权限模式未确认应用。'); return; }
      const runtime = await api.runtimeState(conv.id);
      state.setRuntime(conv.id, runtime);
      if (runtime.info?.permissionMode === localPermissionMode || runtime.state === 'closed') return;
      if (isBusy(runtime) || locallyBusy(conv.id)) { setSettingsNote('全局设置已保存；当前对话忙碌，权限模式也仅用于下次连接。不会自动关闭正在运行的任务。'); return; }
      if (typeof api.mode !== 'function') { setSettingsError('全局已保存，但权限模式 API 不可用；当前对话模式未改变。'); return; }
      const result = await api.mode({ conversationId: conv.id, mode: localPermissionMode });
      if (result?.success !== true) { setSettingsError('权限模式更新失败；当前对话模式未确认改变。CLI 可能不支持该模式或要求显式重新连接。'); return; }
      const fresh = await api.runtimeState(conv.id);
      useStore.getState().setRuntime(conv.id, fresh);
      if (fresh.info?.permissionMode !== localPermissionMode) {
        setSettingsError('权限模式请求已成功，但刷新状态未确认目标模式；保留 CLI 实际回显，请重试。'); return;
      }
      setSettingsNote('全局设置已保存，当前权限模式已由 CLI 确认；其余运行配置仍需下次连接或空闲时显式重新连接。');
    } catch { setSettingsError('保存全局后当前 CLI 操作失败；未伪造权限模式。请重试或显式重新连接。'); }
    finally { settingsLock.current = false; setSaving(false); }
  };

  const reconnect = async () => {
    if (settingsLock.current) return;
    setSettingsError('');
    const state = useStore.getState();
    const conv = state.conversations.find(c => c.id === state.activeConversationId);
    const api = getSettingsAPI()?.claude;
    if (!conv) { setSettingsError('没有当前对话可重新连接。'); return; }
    if (typeof api?.runtimeState !== 'function' || typeof api.close !== 'function' || typeof api.start !== 'function') {
      setSettingsError('重新连接 API 不可用；不会关闭当前对话。'); return;
    }
    settingsLock.current = true; setSaving(true);
    try {
      const runtime = await api.runtimeState(conv.id);
      useStore.getState().setRuntime(conv.id, runtime);
      if (cannotReconnect(runtime) || locallyBusy(conv.id)) { setSettingsError('当前对话忙碌、等待审批或未就绪；不能重新连接，不会中断任务。'); return; }
      if (!confirmBypass() || !window.confirm('重新连接当前对话？将关闭空闲 CLI 并按当前设置重新启动；累计进程预算重新计。')) return;
      if (locallyBusy(conv.id)) { setSettingsError('当前对话已变为忙碌；取消重新连接。'); return; }
      const checked = await api.runtimeState(conv.id);
      if (cannotReconnect(checked) || locallyBusy(conv.id)) { setSettingsError('当前对话已变为忙碌；取消重新连接。'); return; }
      saveGlobal();
      const saved = useStore.getState();
      const options = {
        ...((checked.sessionId || conv.sessionId) ? { sessionId: checked.sessionId || conv.sessionId } : {}),
        permissionMode: saved.permissionMode,
        ...(saved.model ? { model: saved.model } : {}),
        ...(saved.effortLevel ? { effortLevel: saved.effortLevel } : {}),
        ...(saved.autocompact ? { autocompact: saved.autocompact } : {}),
        ...(saved.maxBudgetUsd > 0 ? { maxBudgetUsd: saved.maxBudgetUsd } : {}),
      };
      if (checked.state !== 'closed') {
        const closed = await api.close(conv.id);
        if (closed?.success !== true) { setSettingsError('主进程拒绝关闭当前对话（可能忙碌或所有权冲突）；未启动新 CLI。'); return; }
        useStore.getState().setRuntime(conv.id, { state: 'closed', busy: false });
      }
      const started = await api.start({ conversationId: conv.id, cwd: conv.cwd, options });
      if (started?.success !== true) { setSettingsError('旧 CLI 已关闭，但重新启动失败；请重试连接，不会显示虚假成功。'); return; }
      // The returned runtime is authoritative; no locally invented mode/runId.
      const fresh = await api.runtimeState(conv.id);
      useStore.getState().setRuntime(conv.id, fresh);
      if (fresh.state !== 'ready' && fresh.state !== 'busy') {
        setSettingsError('启动请求已返回成功，但当前运行状态未确认连接；请重新读取状态后重试。'); return;
      }
      setSettingsNote('当前对话已按配置快照重新连接；累计预算从新常驻进程重新计。');
    } catch { setSettingsError('重新连接失败；请检查当前 CLI 状态并重试。不会伪造连接成功。'); }
    finally { settingsLock.current = false; setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md glass-panel rounded-2xl border border-border light overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
          <h2 className="text-sm font-semibold gradient-text-cyan">设置</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容（滚动区） */}
        <div className="p-5 space-y-5 max-h-[65vh] overflow-y-auto">
          {settingsError && <div role="alert" className="text-xs text-red-400">{settingsError}<button onClick={() => setSettingsError('')} className="ml-2 underline">清除错误</button></div>}
          {settingsNote && <p role="status" className="text-xs text-text-secondary">{settingsNote}</p>}
          <p className="text-xs text-text-muted">当前对话权限：{activeConversation?.runtime?.info?.permissionMode || activeConversation?.permissionMode || '未连接'}。保存不会自动关闭任务；继续发送不保证改变现有 CLI 配置。</p>
          <button disabled={saving} onClick={reconnect} className="px-3 py-2 rounded-lg text-xs border border-border disabled:opacity-40">重新连接当前对话</button>
          <RuntimeSettings onChanged={() => setSettingsNote('运行时配置已改变；当前 CLI 不热更新，请空闲时显式重新连接当前对话。')} onOpenNative={onClose} />
          {/* 模型设置 */}
          <div>
            <label className="flex items-center gap-2 text-xs text-text-secondary font-mono uppercase tracking-wider mb-2">
              <Cpu className="w-3.5 h-3.5" />
              模型
            </label>
            {currentModel && (
              <div className="mb-2 px-3 py-1.5 rounded-lg bg-accent-green/5 border border-accent-green/20 text-xs text-accent-green font-mono">
                当前实际使用：{currentModel}
              </div>
            )}
            <div className="flex gap-1.5">
              <input
                type="text"
                value={localModel}
                onChange={(e) => setLocalModel(e.target.value)}
                placeholder="填写模型 ID，如 glm-5.3-m17"
                spellCheck={false}
                className="flex-1 px-3 py-2 rounded-lg bg-bg-light border border-border text-sm text-text-primary placeholder-text-dim font-mono focus:border-accent-cyan/50 transition-colors"
              />
              <button
                onClick={() => setLocalModel('')}
                disabled={!localModel}
                title="清空，跟随 CLI 默认模型"
                className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs text-text-muted hover:text-accent-cyan bg-bg-light border border-border hover:border-accent-cyan/40 transition-all disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                默认
              </button>
            </div>
            <div className="text-[10px] text-text-dim mt-1.5 leading-relaxed">
              填写完整模型 ID，作为 <code className="text-accent-cyan">--model</code> 传给 claude CLI，
              保存后用于下次连接；当前常驻 CLI 需空闲时显式重新连接。留空则跟随 CLI 默认配置。
            </div>
          </div>

          {/* 思考深度 */}
          <div>
            <label className="flex items-center gap-2 text-xs text-text-secondary font-mono uppercase tracking-wider mb-2">
              <Gauge className="w-3.5 h-3.5" />
              思考深度
            </label>
            <div className="grid grid-cols-6 gap-1">
              {EFFORT_OPTIONS.map((o) => (
                <button
                  key={o.id || 'default'}
                  onClick={() => setLocalEffort(o.id)}
                  title={o.desc}
                  className={`px-1 py-1.5 rounded-lg text-xs font-mono transition-all ${
                    localEffort === o.id
                      ? 'bg-accent-purple/10 border border-accent-purple/40 text-accent-purple'
                      : 'bg-bg-light border border-border text-text-secondary hover:bg-bg-lighter'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-text-dim mt-1.5 leading-relaxed">
              作为 <code className="text-accent-cyan">--effort</code> 传给 CLI，控制思考 token 预算。
              简单任务选低更省钱，复杂任务选高/超高。
            </div>
          </div>

          {/* 上下文压缩窗口与预算 */}
          <div>
            <label className="flex items-center gap-2 text-xs text-text-secondary font-mono uppercase tracking-wider mb-2">
              <Boxes className="w-3.5 h-3.5" />
              上下文与预算
            </label>
            <div className="grid grid-cols-6 gap-1 mb-2">
              {AUTOCOMPACT_OPTIONS.map((o) => (
                <button
                  key={o.id || 'default'}
                  onClick={() => setLocalAutocompact(o.id)}
                  title={o.desc}
                  className={`px-1 py-1.5 rounded-lg text-xs font-mono transition-all ${
                    localAutocompact === o.id
                      ? 'bg-accent-cyan/10 border border-accent-cyan/40 text-accent-cyan'
                      : 'bg-bg-light border border-border text-text-secondary hover:bg-bg-lighter'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-text-dim mb-2 leading-relaxed">
              自动压缩阈值（<code className="text-accent-cyan">--autocompact</code>）：上下文达到阈值时
              CLI 自动把历史总结折叠。1M 也只是阈值，不会扩大模型上下文窗口；具体支持依赖 CLI。
            </div>
            <div className="flex items-center gap-1.5">
              <DollarSign className="w-4 h-4 text-accent-green shrink-0" />
              <input
                type="number"
                min="0"
                step="0.5"
                value={localBudget}
                onChange={(e) => setLocalBudget(e.target.value)}
                placeholder="0 = 不限制"
                className="flex-1 px-3 py-1.5 rounded-lg bg-bg-light border border-border text-sm text-text-primary placeholder-text-dim font-mono focus:border-accent-cyan/50 transition-colors"
              />
              <span className="text-xs text-text-dim shrink-0">美元 / 常驻进程</span>
            </div>
            <div className="text-[10px] text-text-dim mt-1.5 leading-relaxed">
              预算上限（<code className="text-accent-cyan">--max-budget-usd</code>）：单个常驻运行进程的累计预算；重连后重新计，不是会话总额。达到上限后停止，不是每轮预算。
            </div>
          </div>

          {/* 权限模式 */}
          <div>
            <label className="flex items-center gap-2 text-xs text-text-secondary font-mono uppercase tracking-wider mb-2">
              <Shield className="w-3.5 h-3.5" />
              权限模式
            </label>
            <div className="space-y-1.5">
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    if (m.id === 'bypassPermissions') {
                      if (!window.confirm('危险：全部放行将跳过权限检查，可能执行任意命令。确认启用 bypassPermissions？')) return;
                      bypassConfirmed.current = true;
                    } else bypassConfirmed.current = false;
                    setLocalPermissionMode(m.id);
                  }}
                  className={`w-full flex items-start gap-2 px-3 py-2 rounded-lg text-sm transition-all text-left ${
                    localPermissionMode === m.id
                      ? 'bg-accent-orange/10 border border-accent-orange/40 text-accent-orange'
                      : 'bg-bg-light border border-border text-text-secondary hover:bg-bg-lighter'
                  }`}
                >
                  <div className={`w-3 h-3 rounded-full border-2 mt-1 shrink-0 ${
                    localPermissionMode === m.id ? 'border-accent-orange bg-accent-orange' : 'border-text-dim'
                  }`} />
                  <div>
                    <div>{m.label}</div>
                    <div className="text-[10px] text-text-dim mt-0.5">{m.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 显示与通知 */}
          <div>
            <label className="flex items-center gap-2 text-xs text-text-secondary font-mono uppercase tracking-wider mb-2">
              <Bell className="w-3.5 h-3.5" />
              显示与通知
            </label>
            <div className="space-y-1.5">
              <Toggle
                on={localShowThinking}
                color="purple"
                label="显示 Claude 的思考过程"
                onClick={() => setLocalShowThinking(!localShowThinking)}
              />
              <Toggle
                on={localNotify}
                color="blue"
                label="任务完成时发送系统通知"
                onClick={() => setLocalNotify(!localNotify)}
              />
            </div>
          </div>

          <p className="text-[10px] text-text-dim">显示思考过程仅控制界面显示，不影响模型思考、token 预算或计费。</p>
          <VideoBgSettings />

          {/* 历史会话 */}
          <div>
            <label className="flex items-center gap-2 text-xs text-text-secondary font-mono uppercase tracking-wider mb-2">
              <Archive className="w-3.5 h-3.5" />
              历史会话
            </label>
            <div className="flex gap-1">
              {SESSION_LIMIT_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => setLocalMaxSessions(n)}
                  className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-mono transition-all ${
                    localMaxSessions === n
                      ? 'bg-accent-green/10 border border-accent-green/40 text-accent-green'
                      : 'bg-bg-light border border-border text-text-secondary hover:bg-bg-lighter'
                  }`}
                >
                  {n} 条
                </button>
              ))}
            </div>
            <div className="text-[10px] text-text-dim mt-1.5 leading-relaxed">
              历史会话超出上限时自动丢弃最旧的（当前共 {sessions.length} 条）。
            </div>

            {/* 清空历史（危险操作，行内二次确认） */}
            {confirmClear ? (
              <div className="mt-2 flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/40">
                <span className="text-xs text-red-300">清空全部 {sessions.length} 条历史？不可恢复</span>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => { setConfirmClear(false); clearAllSessions(); }}
                    className="px-2.5 py-1 rounded-md text-[11px] bg-red-500/20 hover:bg-red-500/30 border border-red-500/50 text-red-300 transition-all"
                  >
                    确认清空
                  </button>
                  <button
                    onClick={() => setConfirmClear(false)}
                    className="px-2.5 py-1 rounded-md text-[11px] text-text-muted hover:text-text-primary transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmClear(true)}
                disabled={sessions.length === 0}
                className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs text-text-muted hover:text-red-400 bg-bg-light border border-border hover:border-red-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-3.5 h-3.5" />
                清空全部历史会话
              </button>
            )}
          </div>

          {/* 关于 */}
          <div className="rounded-lg bg-bg-deep/50 border border-border/30 p-3">
            <div className="flex items-start gap-2">
              <Info className="w-3.5 h-3.5 text-accent-blue shrink-0 mt-0.5" />
              <div className="text-[11px] text-text-muted leading-relaxed">
                Claude GUI 通过套壳 Claude Code CLI 实现，
                使用 <code className="text-accent-cyan">stream-json</code> 输出格式进行结构化通信。
                确保 <code className="text-accent-cyan">claude</code> 命令已在 PATH 中。
              </div>
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border/50">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-sm text-text-muted hover:text-text-primary hover:bg-bg-lighter transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg text-sm bg-accent-cyan/20 hover:bg-accent-cyan/30 border border-accent-cyan/40 text-accent-cyan transition-all"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
