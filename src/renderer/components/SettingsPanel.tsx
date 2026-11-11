import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, Bell, Boxes, ChevronRight, Cpu, Info, MoreHorizontal, Search, Shield, Terminal, X } from 'lucide-react';
import type { ConversationRuntime } from '../types';
import { useStore } from '../store';
import { getSettingsAPI } from './RuntimeSettings';
import { useDialogBehavior } from './useDialogBehavior';
import { confirmAction } from './ConfirmDialog';
import {
  SETTINGS_INDEX,
  VIEW_LABELS,
  parseBudget,
  type SettingsDraft,
  type ViewId,
} from './settings/settingsMeta';
import { StatusPill } from './settings/SettingsControls';
import { BUTTON_DANGER, BUTTON_GHOST, BUTTON_PRIMARY, ICON_BUTTON, POPOVER_PANEL } from './controls';
import {
  AboutView,
  AppearanceView,
  ContextView,
  ModelView,
  PermissionView,
  RuntimeView,
  SessionsView,
  type SettingsViewProps,
} from './settings/SettingsViews';

const NAV_ITEMS: { id: ViewId; label: string; icon: ReactNode }[] = [
  { id: 'model', label: '模型与推理', icon: <Cpu className="h-4 w-4" /> },
  { id: 'context', label: '上下文与成本', icon: <Boxes className="h-4 w-4" /> },
  { id: 'permission', label: '权限与安全', icon: <Shield className="h-4 w-4" /> },
  { id: 'appearance', label: '外观与通知', icon: <Bell className="h-4 w-4" /> },
  { id: 'sessions', label: '会话与数据', icon: <Archive className="h-4 w-4" /> },
];

const ADVANCED_ITEMS: { id: ViewId; label: string; icon: ReactNode }[] = [
  { id: 'runtime', label: '运行环境', icon: <Terminal className="h-4 w-4" /> },
];

const PERMISSION_LABELS: Record<string, string> = {
  default: '逐次审批',
  acceptEdits: '仅自动接受编辑',
  plan: '只读规划',
  auto: '自动审批',
  dontAsk: '仅规则、不弹问',
  bypassPermissions: '全部放行（危险）',
};

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const model = useStore((s) => s.model);
  const setModel = useStore((s) => s.setModel);
  const permissionMode = useStore((s) => s.permissionMode);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const showThinking = useStore((s) => s.showThinking);
  const setShowThinking = useStore((s) => s.setShowThinking);
  const notifyOnComplete = useStore((s) => s.notifyOnComplete);
  const setNotifyOnComplete = useStore((s) => s.setNotifyOnComplete);
  const particlesEnabled = useStore((s) => s.particlesEnabled);
  const setParticlesEnabled = useStore((s) => s.setParticlesEnabled);
  const maxSessions = useStore((s) => s.maxSessions);
  const setMaxSessions = useStore((s) => s.setMaxSessions);
  const effortLevel = useStore((s) => s.effortLevel);
  const setEffortLevel = useStore((s) => s.setEffortLevel);
  const autocompact = useStore((s) => s.autocompact);
  const setAutocompact = useStore((s) => s.setAutocompact);
  const maxBudgetUsd = useStore((s) => s.maxBudgetUsd);
  const setMaxBudgetUsd = useStore((s) => s.setMaxBudgetUsd);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const activeConversation = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId));

  const [view, setView] = useState<ViewId>('model');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<SettingsDraft>(() => ({
    model,
    permissionMode,
    showThinking,
    notifyOnComplete,
    particlesEnabled,
    maxSessions,
    effortLevel,
    autocompact,
    maxBudget: maxBudgetUsd > 0 ? String(maxBudgetUsd) : '',
  }));
  const [settingsError, setSettingsError] = useState('');
  const [settingsNote, setSettingsNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const settingsLock = useRef(false);
  const bypassConfirmed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const api = getSettingsAPI()?.claude;
    if (activeConversationId && typeof api?.runtimeState === 'function') {
      void api.runtimeState(activeConversationId).then((runtime) => {
        if (!cancelled) useStore.getState().setRuntime(activeConversationId, runtime);
      }).catch(() => {
        if (!cancelled) setSettingsError('当前对话运行状态读取失败；请重试，不会伪造本地状态。');
      });
    }
    return () => { cancelled = true; };
  }, [activeConversationId]);

  const runtimeInfo = activeConversation?.runtime?.info as Record<string, unknown> | null | undefined;
  const actualModel = activeConversation?.currentModel || (typeof runtimeInfo?.model === 'string' ? runtimeInfo.model : '') || '';
  const cliVersion = typeof runtimeInfo?.version === 'string' ? runtimeInfo.version : '';
  const actualPermission = String(runtimeInfo?.permissionMode || activeConversation?.permissionMode || permissionMode || '');
  const actualPermissionLabel = PERMISSION_LABELS[actualPermission] || actualPermission || '未连接';

  const normalizedModel = draft.model.trim();
  const budgetValue = parseBudget(draft.maxBudget);
  const dirty = {
    model: normalizedModel !== model,
    permission: draft.permissionMode !== permissionMode,
    showThinking: draft.showThinking !== showThinking,
    notify: draft.notifyOnComplete !== notifyOnComplete,
    particles: draft.particlesEnabled !== particlesEnabled,
    maxSessions: draft.maxSessions !== maxSessions,
    effort: draft.effortLevel !== effortLevel,
    autocompact: draft.autocompact !== autocompact,
    budget: budgetValue !== maxBudgetUsd,
  };
  const dirtyCount = Object.values(dirty).filter(Boolean).length;
  const dirtyByView: Record<ViewId, number> = {
    model: Number(dirty.model) + Number(dirty.effort),
    context: Number(dirty.autocompact) + Number(dirty.budget),
    permission: Number(dirty.permission),
    appearance: Number(dirty.showThinking) + Number(dirty.notify) + Number(dirty.particles),
    sessions: Number(dirty.maxSessions),
    runtime: 0,
    about: 0,
  };

  const patchDraft = (next: Partial<SettingsDraft>) => {
    if (next.permissionMode !== undefined && next.permissionMode !== 'bypassPermissions') bypassConfirmed.current = false;
    setDraft((current) => ({ ...current, ...next }));
  };

  const resetDraft = () => {
    bypassConfirmed.current = false;
    setDraft({
      model,
      permissionMode,
      showThinking,
      notifyOnComplete,
      particlesEnabled,
      maxSessions,
      effortLevel,
      autocompact,
      maxBudget: maxBudgetUsd > 0 ? String(maxBudgetUsd) : '',
    });
    setSettingsError('');
    setSettingsNote('');
  };

  const saveDraftToStore = () => {
    setModel(normalizedModel);
    setPermissionMode(draft.permissionMode);
    setShowThinking(draft.showThinking);
    setNotifyOnComplete(draft.notifyOnComplete);
    setParticlesEnabled(draft.particlesEnabled);
    setMaxSessions(draft.maxSessions);
    setEffortLevel(draft.effortLevel);
    setAutocompact(draft.autocompact);
    setMaxBudgetUsd(budgetValue);
  };

  const isBusy = (runtime: ConversationRuntime) => runtime.busy || runtime.state !== 'ready'
    || runtime.pendingApprovals?.length || runtime.pendingUserMessageIds?.length;
  const cannotReconnect = (runtime: ConversationRuntime) => runtime.busy
    || !['ready', 'closed'].includes(runtime.state ?? '')
    || runtime.pendingApprovals?.length || runtime.pendingUserMessageIds?.length;
  const locallyBusy = (id: string) => {
    const conv = useStore.getState().conversations.find((item) => item.id === id);
    return !conv || ['starting', 'streaming'].includes(conv.status) || conv.pendingApprovals?.length || conv.queue?.length;
  };
  const confirmBypass = async () => {
    if (draft.permissionMode !== 'bypassPermissions' || bypassConfirmed.current) return true;
    const accepted = await confirmAction({ title: '启用全部放行', message: '危险：全部放行将跳过权限检查，可能执行任意命令。确认启用 bypassPermissions？', confirmLabel: '启用全部放行', tone: 'danger' });
    if (accepted) bypassConfirmed.current = true;
    return accepted;
  };

  // 关闭、Esc、点击遮罩都走同一保护：有未保存更改时先确认，避免静默丢失。
  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirtyCount > 0) { setClosePrompt(true); return; }
    onClose();
  }, [dirtyCount, saving, onClose]);

  useDialogBehavior({
    open: true,
    dialogRef,
    onRequestClose: closePrompt ? () => setClosePrompt(false) : requestClose,
    initialFocusSelector: 'input[aria-label="搜索设置"]',
  });

  const handleSave = async (): Promise<boolean> => {
    if (settingsLock.current) return false;
    settingsLock.current = true;
    setSaving(true);
    setSettingsError('');
    let globalSaved = false;
    try {
      if (!(await confirmBypass())) return false;
      saveDraftToStore();
      globalSaved = true;
      setSettingsNote('已保存全局设置：模型、思考深度、压缩阈值、预算、权限模式、通知与会话保留数量。当前 CLI 不随保存热更新；运行环境（CLI 路径与环境变量）在“运行环境”中单独保存。');
      const state = useStore.getState();
      const conv = state.conversations.find((c) => c.id === state.activeConversationId);
      if (!conv || !(conv.protocolConnected || conv.runtime)) return true;
      const api = getSettingsAPI()?.claude;
      if (typeof api?.runtimeState !== 'function') {
        setSettingsError('全局已保存，但当前对话运行状态 API 不可用；权限模式未确认应用。');
        return false;
      }
      const runtime = await api.runtimeState(conv.id);
      state.setRuntime(conv.id, runtime);
      if (runtime.info?.permissionMode === draft.permissionMode || runtime.state === 'closed') return true;
      if (isBusy(runtime) || locallyBusy(conv.id)) {
        setSettingsNote('全局设置已保存；当前对话忙碌，权限模式也仅用于下次连接。不会自动关闭正在运行的任务。');
        return true;
      }
      if (typeof api.mode !== 'function') {
        setSettingsError('全局已保存，但权限模式 API 不可用；当前对话模式未改变。');
        return false;
      }
      const result = await api.mode({ conversationId: conv.id, mode: draft.permissionMode });
      if (result?.success !== true) {
        setSettingsError('权限模式更新失败；当前对话模式未确认改变。CLI 可能不支持该模式或要求显式重新连接。');
        return false;
      }
      const fresh = await api.runtimeState(conv.id);
      useStore.getState().setRuntime(conv.id, fresh);
      if (fresh.info?.permissionMode !== draft.permissionMode) {
        setSettingsError('权限模式请求已成功，但刷新状态未确认目标模式；保留 CLI 实际回显，请重试。');
        return false;
      }
      setSettingsNote('全局设置已保存，当前权限模式已由 CLI 确认；其余运行配置仍需下次连接或空闲时显式重新连接。');
      return true;
    } catch {
      setSettingsError(globalSaved
        ? '保存全局后当前 CLI 操作失败；未伪造权限模式。请重试或显式重新连接。'
        : '保存全局设置失败；请检查已保存值后重试，当前 CLI 未更新。');
      return false;
    } finally {
      settingsLock.current = false;
      setSaving(false);
    }
  };

  const handleReconnect = async () => {
    if (settingsLock.current) return;
    setSettingsError('');
    const state = useStore.getState();
    const conv = state.conversations.find((c) => c.id === state.activeConversationId);
    const api = getSettingsAPI()?.claude;
    if (!conv) { setSettingsError('没有当前对话可重新连接。'); return; }
    if (typeof api?.runtimeState !== 'function' || typeof api.close !== 'function' || typeof api.start !== 'function') {
      setSettingsError('重新连接 API 不可用；不会关闭当前对话。');
      return;
    }
    settingsLock.current = true;
    setSaving(true);
    try {
      const runtime = await api.runtimeState(conv.id);
      useStore.getState().setRuntime(conv.id, runtime);
      if (cannotReconnect(runtime) || locallyBusy(conv.id)) {
        setSettingsError('当前对话忙碌、等待审批或未就绪；不能重新连接，不会中断任务。');
        return;
      }
      if (!(await confirmBypass()) || !(await confirmAction({ title: '重新连接当前对话', message: '重新连接当前对话？将关闭空闲 CLI 并按当前设置重新启动；累计进程预算重新计。', confirmLabel: '重新连接', tone: 'danger' }))) return;
      if (locallyBusy(conv.id)) {
        setSettingsError('当前对话已变为忙碌；取消重新连接。');
        return;
      }
      const checked = await api.runtimeState(conv.id);
      if (cannotReconnect(checked) || locallyBusy(conv.id)) {
        setSettingsError('当前对话已变为忙碌；取消重新连接。');
        return;
      }
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
        if (closed?.success !== true) {
          setSettingsError('主进程拒绝关闭当前对话（可能忙碌或所有权冲突）；未启动新 CLI。');
          return;
        }
        useStore.getState().setRuntime(conv.id, { state: 'closed', busy: false });
      }
      const started = await api.start({ conversationId: conv.id, cwd: conv.cwd, options });
      if (started?.success !== true) {
        setSettingsError('旧 CLI 已关闭，但重新启动失败；请重试连接，不会显示虚假成功。');
        return;
      }
      const fresh = await api.runtimeState(conv.id);
      useStore.getState().setRuntime(conv.id, fresh);
      if (fresh.state !== 'ready' && fresh.state !== 'busy') {
        setSettingsError('启动请求已返回成功，但当前运行状态未确认连接；请重新读取状态后重试。');
        return;
      }
      setSettingsNote('当前对话已按配置快照重新连接；累计预算从新常驻进程重新计。');
    } catch {
      setSettingsError('重新连接失败；请检查当前 CLI 状态并重试。不会伪造连接成功。');
    } finally {
      settingsLock.current = false;
      setSaving(false);
    }
  };

  /** 保存并重连直接提交草稿；独立重连只使用已保存配置，不走权限热切换。 */
  const saveAndReconnect = async () => {
    if (settingsLock.current || !(await confirmBypass())) return;
    saveDraftToStore();
    await handleReconnect();
  };

  const searchResults = search.trim()
    ? SETTINGS_INDEX.filter((entry) => {
        const haystack = `${entry.label} ${entry.keywords.join(' ')} ${VIEW_LABELS[entry.view]}`.toLowerCase();
        return haystack.includes(search.trim().toLowerCase());
      })
    : [];

  const viewProps: SettingsViewProps = {
    draft,
    patch: patchDraft,
    activeConversation,
    actualModel,
    cliVersion,
    actualPermission,
    savedBudget: maxBudgetUsd,
    saved: { model, permissionMode, showThinking, notifyOnComplete, particlesEnabled, maxSessions, effortLevel, autocompact, maxBudget: maxBudgetUsd > 0 ? String(maxBudgetUsd) : '' },
  };

  const renderView = () => {
    switch (view) {
      case 'model': return <ModelView {...viewProps} />;
      case 'context': return <ContextView {...viewProps} />;
      case 'permission': return <PermissionView {...viewProps} />;
      case 'appearance': return <AppearanceView {...viewProps} />;
      case 'sessions': return <SessionsView {...viewProps} />;
      case 'runtime': return (
        <RuntimeView
          cliVersion={cliVersion}
          actualModel={actualModel}
          onChanged={() => setSettingsNote('运行时配置已改变；当前 CLI 不热更新，请空闲时显式重新连接当前对话。')}
          onOpenNative={onClose}
        />
      );
      case 'about': return <AboutView cliVersion={cliVersion} actualModel={actualModel} />;
      default: return <ModelView {...viewProps} />;
    }
  };

  const navButton = (item: { id: ViewId; label: string; icon: ReactNode }) => {
    const active = view === item.id;
    const count = dirtyByView[item.id];
    return (
      <button
        key={item.id}
        type="button"
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        onClick={() => { setView(item.id); setSearch(''); }}
        className={`flex min-h-8 w-auto items-center sm:w-full gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan ${
          active ? 'bg-bg-light text-text-primary' : 'text-text-secondary hover:bg-bg-light/60 hover:text-text-primary'
        }`}
      >
        <span className={active ? 'text-text-primary' : 'text-text-muted'}>{item.icon}</span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {count > 0 && (
          <span className="rounded-full border border-accent-yellow/30 bg-accent-yellow/10 px-1.5 py-0.5 text-2xs text-accent-yellow">
            {count}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-fade-in"
      onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="设置" className="flex h-[min(760px,calc(100dvh-32px))] w-[min(980px,96vw)] flex-col overflow-hidden rounded-2xl border border-border bg-bg-deep/95 shadow-2xl">
        <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-5 py-3">
          <h2 className="text-sm font-semibold gradient-text-cyan">设置</h2>
          <div className="relative ml-auto w-64 max-w-[45vw]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              aria-label="搜索设置"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索设置（模型、压缩、权限…）"
              className="h-8 w-full rounded-lg border border-border bg-bg-light pl-8 pr-2 text-xs text-text-primary placeholder-text-dim focus:border-accent-cyan/50 focus:outline-none"
            />
          </div>
          <button type="button" aria-label="关闭设置" onClick={requestClose} className={`${BUTTON_GHOST} h-8 w-8 shrink-0 justify-center !p-0`}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {closePrompt && (
          <div role="alertdialog" aria-label="有未保存的设置更改" className="shrink-0 border-b border-accent-yellow/30 bg-accent-yellow/5 px-5 py-3">
            <p className="text-xs text-accent-yellow">{dirtyCount > 0 ? `有 ${dirtyCount} 项更改尚未保存。直接关闭会丢失这些修改。` : '全局草稿已保存，但当前 CLI 应用尚未确认成功。请检查下方反馈后重试或继续编辑。'}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => { void handleSave().then((success) => { if (success) { setClosePrompt(false); onClose(); } }); }}
                className={BUTTON_PRIMARY}
              >
                保存并关闭
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => { setClosePrompt(false); onClose(); }}
                className={BUTTON_DANGER}
              >
                放弃更改并关闭
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => setClosePrompt(false)}
                className={BUTTON_GHOST}
              >
                继续编辑
              </button>
            </div>
          </div>
        )}

        {/* 运行状态默认折叠为一行，展开才显示详细值 */}
        <details className="group shrink-0 border-b border-border/40 bg-bg-light/20 px-5">
          <summary className="flex h-7 cursor-pointer list-none items-center gap-2 text-2xs text-text-secondary [&::-webkit-details-marker]:hidden">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${actualModel ? 'bg-accent-green' : 'bg-text-muted'}`} />
            <span className="shrink-0">{actualModel ? '已连接' : '未连接'}</span>
            <span className="shrink-0 text-text-dim">·</span>
            <span className="max-w-[200px] truncate">{actualModel || '模型未读取'}</span>
            <span className="shrink-0 text-text-dim">·</span>
            <span className="max-w-[140px] truncate">{actualPermissionLabel}</span>
            <ChevronRight className="ml-auto h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
          </summary>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 pb-2">
            <StatusPill label="实际模型" value={actualModel || '未连接'} />
            <StatusPill label="CLI" value={cliVersion || '未读取'} />
            <StatusPill label="实际权限" value={actualPermissionLabel} tone={actualPermission === 'bypassPermissions' ? 'warn' : 'neutral'} />
          </div>
        </details>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav aria-label="设置分类" className="flex max-h-32 shrink-0 flex-wrap gap-1 overflow-y-auto border-b border-border/40 p-2 sm:max-h-none sm:w-44 sm:flex-col sm:flex-nowrap sm:gap-0 sm:border-b-0 sm:border-r">
              <p className="hidden px-2.5 pb-2 text-2xs leading-5 text-text-dim sm:block">生效方式见每项徽章。</p>
            <div className="contents sm:block sm:space-y-0.5">{NAV_ITEMS.map(navButton)}</div>
            <div className="hidden sm:mt-4 sm:block sm:px-2.5 text-2xs font-medium text-text-dim">高级</div>
            <div className="contents sm:mt-1 sm:block sm:space-y-0.5">{ADVANCED_ITEMS.map(navButton)}</div>
            <div className="contents sm:mt-auto sm:block sm:pt-3">{navButton({ id: 'about', label: '关于', icon: <Info className="h-4 w-4" /> })}</div>
          </nav>

          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {settingsError && (
              <div role="alert" className="mb-3 flex items-start justify-between gap-2 rounded-lg border border-accent-red/35 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
                <span>{settingsError}</span>
                <button type="button" onClick={() => setSettingsError('')} className="shrink-0 underline">清除错误</button>
              </div>
            )}
            {settingsNote && <p role="status" className="mb-3 rounded-lg border border-border/40 bg-bg-light/40 px-3 py-2 text-2xs text-text-secondary">{settingsNote}</p>}

            {search.trim() ? (
              <div>
                <h1 className="text-xl font-semibold text-text-primary">搜索结果</h1>
                <p className="mt-1 text-sm text-text-secondary">找到 {searchResults.length} 项与“{search.trim()}”相关的设置。</p>
                <div className="mt-4 space-y-1">
                  {searchResults.map((entry) => (
                    <button
                      key={`${entry.view}:${entry.id}`}
                      type="button"
                      onClick={() => {
                        setView(entry.view);
                        setSearch('');
                        requestAnimationFrame(() => {
                          const target = document.getElementById(`setting-${entry.id}`);
                          if (!target) {
                            setSettingsNote(`已切换到“${VIEW_LABELS[entry.view]}”；该项没有独立锚点，请在当前分类中查看。`);
                            return;
                          }
                          target.scrollIntoView({ block: 'center' });
                          // 短暂高亮目标，避免用户误以为搜索没有生效。
                          target.classList.add('rounded-xl', 'ring-2', 'ring-accent-cyan/60');
                          window.setTimeout(() => target.classList.remove('rounded-xl', 'ring-2', 'ring-accent-cyan/60'), 1600);
                        });
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-bg-light/50 px-3 py-2 text-left hover:border-accent-cyan/35"
                    >
                      <span className="text-sm text-text-primary">{entry.label}</span>
                      <span className="text-2xs text-text-muted">{VIEW_LABELS[entry.view]}</span>
                    </button>
                  ))}
                  {searchResults.length === 0 && <p className="text-xs text-text-muted">没有匹配的设置，试试“模型”“压缩”“权限”或“通知”。</p>}
                </div>
              </div>
            ) : renderView()}
          </main>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/50 px-5 py-3">
          <div className="min-w-0 flex-1 basis-40">
            <span role="status" className={`text-xs ${dirtyCount ? 'text-accent-yellow' : 'text-text-muted'}`}>
              {dirtyCount ? `${dirtyCount} 项更改未保存` : '所有更改已保存'}
            </span>
            <p className="mt-0.5 text-2xs text-text-dim">保存只写入全局配置；当前 CLI 不热更新，重连使用已保存配置。</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <details data-popover className="relative">
              <summary aria-label="更多设置操作" title="更多设置操作" className={`${ICON_BUTTON} list-none cursor-pointer [&::-webkit-details-marker]:hidden`}><MoreHorizontal className="h-4 w-4" /></summary>
              <div className={`${POPOVER_PANEL} absolute bottom-full right-0 mb-2 w-60 space-y-0.5`} onClick={event => { if ((event.target as HTMLElement).closest('button')) event.currentTarget.closest('details')?.removeAttribute('open'); }}>
                <button type="button" onClick={resetDraft} disabled={!dirtyCount || saving} className="flex min-h-8 w-full items-center rounded-md px-3 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-bg-light hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40">
                  放弃更改
                </button>
                <button type="button" onClick={handleReconnect} disabled={saving} title="仅使用已保存配置重新连接当前对话；不保存草稿，累计预算重新计" className="flex min-h-8 w-full items-center rounded-md px-3 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-bg-light hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40">
                  重新连接当前对话
                </button>
                <button type="button" onClick={saveAndReconnect} disabled={saving} title="保存上方草稿并重新连接当前会话；累计预算从新进程重新计" className="flex min-h-8 w-full items-center rounded-md border-t border-border/40 px-3 py-1.5 text-left text-xs text-text-primary transition-colors hover:bg-bg-light">
                  保存并重新连接
                </button>
              </div>
            </details>
            <button type="button" onClick={() => void handleSave()} disabled={saving} className={BUTTON_PRIMARY}>
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
