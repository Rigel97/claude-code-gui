import { useState } from 'react';
import { AlertTriangle, DollarSign, FolderOpen, Shield, Trash2 } from 'lucide-react';
import { useStore } from '../../store';
import type { Conversation } from '../../types';
import { RuntimeSettings } from '../RuntimeSettings';
import {
  AUTOCOMPACT_OPTIONS,
  EFFORT_OPTIONS,
  PERMISSION_MODES,
  SESSION_LIMIT_OPTIONS,
  formatTokens,
  formatWindow,
  parseBudget,
  type Autocompact,
  type SettingsDraft,
} from './settingsMeta';
import {
  DangerZone,
  InfoNote,
  SectionIntro,
  Segmented,
  SettingRow,
  ToggleRow,
  UsageMeter,
} from './SettingsControls';
import { BUTTON, BUTTON_DANGER, BUTTON_GHOST, BUTTON_SM, BUTTON_SM_PRIMARY } from '../controls';

export interface SettingsViewProps {
  draft: SettingsDraft;
  patch: (patch: Partial<SettingsDraft>) => void;
  activeConversation: Conversation | undefined;
  actualModel: string;
  cliVersion: string;
  actualPermission: string;
  /** 已保存的预算上限；与草稿值分开展示，避免把未保存值当成生效值。 */
  savedBudget: number;
  saved: SettingsDraft;
}

function autocompactTokens(value: Autocompact): number | null {
  if (!value || value === 'auto') return null;
  const match = value.match(/^(\d+)([kKmM])$/);
  if (!match) return null;
  return Number(match[1]) * (/k/i.test(match[2]) ? 1_000 : 1_000_000);
}

export function ModelView({ draft, patch, actualModel, saved }: SettingsViewProps) {
  const preset = draft.effortLevel === 'low' && draft.autocompact === '200k'
    ? 'saver'
    : draft.effortLevel === 'medium' && draft.autocompact === ''
      ? 'balanced'
      : draft.effortLevel === 'max' && draft.autocompact === ''
        ? 'deep'
        : '';
  const presets = [
    { id: 'saver', label: '省钱', desc: '低思考深度 + 200k 压缩', run: () => patch({ effortLevel: 'low', autocompact: '200k' }) },
    { id: 'balanced', label: '平衡', desc: '中等思考 + CLI 默认压缩', run: () => patch({ effortLevel: 'medium', autocompact: '' }) },
    { id: 'deep', label: '深度', desc: '最大思考 + CLI 默认压缩', run: () => patch({ effortLevel: 'max', autocompact: '' }) },
  ];
  return (
    <div>
      <SectionIntro title="模型与推理" description="决定由哪个模型回答，以及它愿意思考多久。这里的选择会影响速度、深度和费用。" />
      <div className="mt-4 rounded-xl border border-border/50 bg-bg-light/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-text-secondary">
            当前实际使用：<span className="font-mono text-accent-green">{actualModel || '未连接'}</span>
          </div>
          <div className="flex gap-1">
            {presets.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={preset === item.id}
                title={item.desc}
                onClick={item.run}
                className={preset === item.id ? BUTTON_SM_PRIMARY : BUTTON_SM}
              >
                {item.label}
              </button>
            ))}
            {!preset && <span className="self-center px-1 text-2xs text-text-dim">自定义</span>}
          </div>
        </div>
      </div>

      <SettingRow
        id="model"
        title="模型"
        description="填写 CLI 的完整模型 ID。留空则跟随 CLI 默认配置；三方端点请填写实际 ID，不要使用 sonnet/opus 之类可能无效的别名。"
        technical="--model"
        apply="reconnect"
        savedValue={saved.model || 'CLI 默认'}
        draftValue={draft.model.trim() || 'CLI 默认'}
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={draft.model}
            onChange={(event) => patch({ model: event.target.value })}
            placeholder="填写模型 ID，如 glm-5.3-m17"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg-light px-2.5 text-xs text-text-primary placeholder-text-dim font-mono focus:border-accent-cyan/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => patch({ model: '' })}
            disabled={!draft.model}
            title="清空，跟随 CLI 默认模型"
            className={`${BUTTON} shrink-0`}
          >
            跟随默认
          </button>
        </div>
      </SettingRow>

      <SettingRow
        id="effort"
        title="思考深度"
        description="模型回答前愿意思考多久。越高越深入，也越慢、输出越多；简单任务选低更省钱。"
        technical="--effort"
        apply="reconnect"
        savedValue={EFFORT_OPTIONS.find((item) => item.id === saved.effortLevel)?.label || 'CLI 默认'}
        draftValue={EFFORT_OPTIONS.find((item) => item.id === draft.effortLevel)?.label || 'CLI 默认'}
      >
        <Segmented
          label="思考深度"
          value={draft.effortLevel}
          options={EFFORT_OPTIONS.map(({ id, label, desc }) => ({ id, label, desc }))}
          onChange={(effortLevel) => patch({ effortLevel })}
        />
        <p className="mt-2 text-2xs text-text-dim">
          草稿选择：{EFFORT_OPTIONS.find((item) => item.id === draft.effortLevel)?.desc || '由 CLI 决定'}
        </p>
      </SettingRow>
    </div>
  );
}

export function ContextView({ draft, patch, activeConversation, savedBudget, saved }: SettingsViewProps) {
  const limit = activeConversation?.contextUsage?.limit ?? null;
  const used = activeConversation?.contextUsage?.used ?? null;
  const selectedTokens = autocompactTokens(draft.autocompact);
  const exceeds = selectedTokens !== null && limit !== null && selectedTokens > limit;
  return (
    <div>
      <SectionIntro title="上下文与成本" description="控制历史什么时候被压缩，以及单个 CLI 进程最多花多少钱。这里的值不会扩大模型本身的上下文窗口。" />

      <div className="mt-4">
        <UsageMeter used={used} limit={limit} />
      </div>

      <SettingRow
        id="autocompact"
        title="自动压缩阈值"
        description="对话变长时，什么时候把旧内容总结掉。设得越小越省 token，但可用上下文越短；设得比模型窗口大不会生效。"
        technical="--autocompact"
        apply="reconnect"
        savedValue={AUTOCOMPACT_OPTIONS.find((item) => item.id === saved.autocompact)?.label || 'CLI 默认'}
        draftValue={AUTOCOMPACT_OPTIONS.find((item) => item.id === draft.autocompact)?.label || 'CLI 默认'}
        warning={exceeds ? (
          <span>
            当前模型窗口只有 {formatWindow(limit)}，{draft.autocompact} 不会生效。
            想真正使用更大窗口，请先把模型改为支持 1M 的模型（例如 <code className="font-mono">default</code> 或 <code className="font-mono">glm-5.3-m17[1m]</code>）。
          </span>
        ) : undefined}
      >
        <Segmented
          label="自动压缩阈值"
          value={draft.autocompact}
          options={AUTOCOMPACT_OPTIONS.map(({ id, label, desc }) => ({ id, label, desc }))}
          onChange={(autocompact) => patch({ autocompact })}
          columns={4}
        />
        <p className="mt-2 text-2xs text-text-dim">
          {limit ? `当前模型窗口：${formatWindow(limit)}。压缩阈值只是触发点，不会扩大窗口。` : '当前会话尚未连接，窗口大小未知。'}
        </p>
      </SettingRow>

      <SettingRow
        id="budget"
        title="单次连接花费上限"
        description="这一个 CLI 进程最多花多少美元。0 = 不限制；达到上限会停止；重新连接后重新计算，不是每轮预算。"
        technical="--max-budget-usd"
        apply="reconnect"
      >
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 shrink-0 text-accent-green" />
          <input
            type="number"
            min="0"
            step="0.5"
            value={draft.maxBudget}
            onChange={(event) => patch({ maxBudget: event.target.value })}
            placeholder="0 = 不限制"
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg-light px-2.5 text-xs text-text-primary placeholder-text-dim font-mono focus:border-accent-cyan/50 focus:outline-none"
          />
          <span className="shrink-0 text-xs text-text-dim">美元 / 本次连接</span>
        </div>
        <p className="mt-2 text-2xs text-text-secondary">
          当前保存值：{savedBudget > 0 ? `$${savedBudget}` : '不限制'}
          {parseBudget(draft.maxBudget) !== savedBudget && (
            <span className="ml-2 text-accent-yellow">待保存：{parseBudget(draft.maxBudget) > 0 ? `$${parseBudget(draft.maxBudget)}` : '不限制'}</span>
          )}
        </p>
      </SettingRow>
    </div>
  );
}

export function PermissionView({ draft, patch, actualPermission, saved }: SettingsViewProps) {
  const normal = PERMISSION_MODES.filter((mode) => !mode.danger);
  const danger = PERMISSION_MODES.find((mode) => mode.danger)!;
  const actualLabel = PERMISSION_MODES.find((mode) => mode.id === actualPermission)?.label || actualPermission || '未连接';
  return (
    <div>
      <SectionIntro title="权限与安全" description="决定模型执行命令、修改文件前是否需要你批准。权限越高越省事，但风险也越大。" />
      <div className="mt-4 flex items-center justify-between rounded-xl border border-border/50 bg-bg-light/40 px-3 py-2.5">
        <span className="text-xs text-text-secondary">当前会话实际权限</span>
        <span className="text-xs font-medium text-accent-green">{actualLabel}</span>
      </div>
      {actualPermission && draft.permissionMode !== actualPermission && (
        <div className="mt-2">
          <InfoNote tone="warning">
            已选择 {PERMISSION_MODES.find((mode) => mode.id === draft.permissionMode)?.label || draft.permissionMode}，当前会话实际仍为 {actualLabel}；
            点击“保存”会尝试在空闲时应用权限；也可显式“保存并重新连接”。以 CLI 实际回显为准。
          </InfoNote>
        </div>
      )}

      <SettingRow
        id="permission"
        title="工具执行权限"
        description="只影响当前与下一次连接；保存时会先尝试在空闲会话上立即切换，忙碌或未就绪时仅写入配置，并在保存后告知实际结果。"
        apply="save-try"
        savedValue={PERMISSION_MODES.find((mode) => mode.id === saved.permissionMode)?.label || saved.permissionMode}
        draftValue={PERMISSION_MODES.find((mode) => mode.id === draft.permissionMode)?.label || draft.permissionMode}
      >
        <div className="space-y-1.5" role="group" aria-label="工具执行权限">
          {normal.map((mode) => {
            const active = draft.permissionMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                aria-pressed={active}
                onClick={() => patch({ permissionMode: mode.id })}
                className={`min-h-8 w-full rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan ${
                  active ? 'border-accent-cyan/45 bg-accent-cyan/10' : 'border-border bg-bg-light hover:border-border-light'
                }`}
              >
                <span className="flex items-center gap-2 text-sm text-text-primary">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full border ${active ? 'border-accent-cyan bg-accent-cyan' : 'border-text-dim'}`} />
                  {mode.label}
                </span>
                <span className="mt-0.5 block pl-[18px] text-2xs leading-relaxed text-text-secondary">{mode.desc}</span>
              </button>
            );
          })}
        </div>
      </SettingRow>

      <DangerZone
        title="危险模式"
        description="全部放行会跳过权限检查，模型可以执行任意命令、修改任意文件。仅在完全信任当前任务时使用。"
      >
        <button
          type="button"
          aria-pressed={draft.permissionMode === danger.id}
          onClick={() => patch({ permissionMode: danger.id })}
          className={`min-h-8 w-full rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan ${
            draft.permissionMode === danger.id
              ? 'border-accent-red/60 bg-accent-red/15'
              : 'border-accent-red/25 bg-transparent hover:border-accent-red/45'
          }`}
        >
          <span className="flex items-center gap-2 text-sm font-medium text-accent-red">
            <AlertTriangle className="h-4 w-4" />
            {danger.label}
          </span>
          <span className="mt-0.5 block pl-6 text-2xs leading-relaxed text-text-secondary">{danger.desc}</span>
        </button>
        {draft.permissionMode === danger.id && (
          <div className="mt-2">
            <InfoNote tone="warning">保存时会再次弹出确认。确认后当前空闲会话会立即切换，忙碌会话在下次连接生效。</InfoNote>
          </div>
        )}
      </DangerZone>
    </div>
  );
}

export function VideoBgSettings() {
  const videoBg = useStore((state) => state.videoBg);
  const setVideoBg = useStore((state) => state.setVideoBg);
  const videoBgError = useStore((state) => state.videoBgError);
  const setVideoBgError = useStore((state) => state.setVideoBgError);
  const [hint, setHint] = useState('');
  const pickVideo = async () => {
    const api = (window as any).api?.videoBg;
    if (!api) return;
    const filePath: string | null = await api.pick();
    if (filePath) { setVideoBg({ path: filePath, enabled: true }); setVideoBgError(null); setHint(''); }
  };
  const fileName = videoBg.path ? videoBg.path.split(/[\\/]/).pop() : null;
  const effective = videoBg.enabled && !!videoBg.path && !videoBgError;
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-pressed={effective}
        disabled={!videoBg.path}
        title={videoBg.path ? (videoBgError || undefined) : '先选择一个视频文件，才能启用视频背景'}
        onClick={() => {
          if (!videoBg.path) { setHint('先选择一个视频文件，才能启用视频背景。'); return; }
          setVideoBgError(null);
          setVideoBg({ enabled: !videoBg.enabled });
        }}
        className={`flex min-h-8 w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan disabled:cursor-not-allowed disabled:opacity-60 ${
          effective ? 'border-accent-cyan/35 bg-accent-cyan/5' : 'border-border bg-bg-light/60'
        }`}
      >
        <span className="text-sm text-text-primary">启用视频背景</span>
        <span className={`relative h-5 w-9 shrink-0 rounded-full ${effective ? 'bg-accent-cyan/40' : 'bg-bg-lighter'}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-text-primary transition-all ${effective ? 'left-4' : 'left-0.5'}`} />
        </span>
      </button>
      <div className="flex gap-1.5">
        <button type="button" onClick={pickVideo} className={`${BUTTON} flex-1 justify-center`}>
          <FolderOpen className="h-3.5 w-3.5" />
          选择视频文件…
        </button>
        <button
          type="button"
          onClick={() => { setVideoBg({ path: null, enabled: false }); setVideoBgError(null); setHint(''); }}
          disabled={!videoBg.path}
          title="移除视频文件并恢复默认背景"
          className={`${BUTTON_GHOST} shrink-0`}
        >
          清除
        </button>
      </div>
      {videoBgError && <p role="alert" className="text-2xs leading-relaxed text-accent-red">{videoBgError}</p>}
      {hint && <p role="alert" className="text-2xs text-accent-yellow">{hint}</p>}
      {fileName && <div className="truncate font-mono text-2xs text-text-secondary" title={videoBg.path ?? undefined}>{fileName}</div>}
      <p className="text-2xs leading-relaxed text-text-secondary">
        支持 mp4 / webm / mov / m4v / ogv。视频经本机 bgmedia 协议直读，不联网，路径仅保存在本机。若文件失效或编码不支持，播放器会回退默认背景，请重新选择或清除。
      </p>
    </div>
  );
}

export function AppearanceView({ draft, patch, saved }: SettingsViewProps) {
  return (
    <div>
      <SectionIntro title="外观与通知" description="这些设置只影响界面和提醒，不会改变模型行为或费用。" />
      <SettingRow
        savedValue={saved.showThinking ? '开启' : '关闭'}
        draftValue={draft.showThinking ? '开启' : '关闭'}
        id="thinking"
        title="显示思考过程"
        description="只控制界面是否展示思考内容，不影响模型思考、token 预算或计费。"
        apply="save"
      >
        <ToggleRow
          label="显示 Claude 的思考过程"
          description="关闭后历史思考块仍保留，只是不再展开显示。"
          on={draft.showThinking}
          onChange={(showThinking) => patch({ showThinking })}
        />
      </SettingRow>
      <SettingRow
        savedValue={saved.notifyOnComplete ? '开启' : '关闭'}
        draftValue={draft.notifyOnComplete ? '开启' : '关闭'}
        id="notify"
        title="任务完成通知"
        description="窗口不在前台时，任务完成后发送系统通知，并附带最后一条用户消息摘要。"
        apply="save"
      >
        <ToggleRow
          label="任务完成时发送系统通知"
          description="只在本窗口不可见时触发，不会重复提醒当前正在看的任务。"
          on={draft.notifyOnComplete}
          onChange={(notifyOnComplete) => patch({ notifyOnComplete })}
        />
      </SettingRow>
      <SettingRow
        savedValue={saved.particlesEnabled ? '开启' : '关闭'}
        draftValue={draft.particlesEnabled ? '开启' : '关闭'}
        id="particles"
        title="动态装饰背景"
        description="粒子网格、噪点与扫描线属于装饰层；关闭后保留纯色深色底，恢复默认时一并回来。不影响任何功能。"
        apply="save"
      >
        <ToggleRow
          label="显示粒子网格与扫描线"
          description="关闭后同时移除噪点纹理和扫描线动画；系统开启“减少动态效果”时也会自动停止。"
          on={draft.particlesEnabled}
          onChange={(particlesEnabled) => patch({ particlesEnabled })}
        />
      </SettingRow>
      <SettingRow
        id="video"
        title="动态视频背景"
        description="用本地视频替换默认背景。选中或清除都会立即生效，不需要点击底部保存。"
        apply="immediate"
      >
        <VideoBgSettings />
      </SettingRow>
    </div>
  );
}

export function SessionsView({ draft, patch, saved }: SettingsViewProps) {
  const sessions = useStore((state) => state.sessions);
  const totalInputTokens = useStore((state) => state.totalInputTokens);
  const totalOutputTokens = useStore((state) => state.totalOutputTokens);
  const clearAllSessions = useStore((state) => state.clearAllSessions);
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <div>
      <SectionIntro title="会话与数据" description="控制侧栏保留多少历史记录，以及查看当前累计用量。清空历史不会删除磁盘上的 CLI 原始会话文件。" />
      <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-border/50 bg-bg-light/40 p-3">
        <div>
          <div className="text-2xs text-text-muted">历史会话</div>
          <div className="mt-0.5 text-lg font-semibold text-text-primary">{sessions.length}</div>
        </div>
        <div>
          <div className="text-2xs text-text-muted">累计输入</div>
          <div className="mt-0.5 text-lg font-semibold text-accent-cyan">{formatTokens(totalInputTokens)}</div>
        </div>
        <div>
          <div className="text-2xs text-text-muted">累计输出</div>
          <div className="mt-0.5 text-lg font-semibold text-accent-green">{formatTokens(totalOutputTokens)}</div>
        </div>
      </div>

      <SettingRow
        savedValue={`${saved.maxSessions} 条`}
        draftValue={`${draft.maxSessions} 条`}
        id="limit"
        title="保留会话数量"
        description="侧栏最多保留多少条归档会话。超出后自动丢弃最旧的记录；这不会删除磁盘上的 CLI JSONL。"
        apply="save"
      >
        <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="保留会话数量">
          {SESSION_LIMIT_OPTIONS.map((limit) => {
            const active = draft.maxSessions === limit;
            return (
              <button
                key={limit}
                type="button"
                aria-pressed={active}
                onClick={() => patch({ maxSessions: limit })}
                className={`${active ? BUTTON_SM_PRIMARY : BUTTON_SM} min-h-7 justify-center font-mono`}
              >
                {limit} 条
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-2xs text-text-dim">当前共 {sessions.length} 条。</p>
      </SettingRow>

      <div id="setting-clear">
        <DangerZone
          title="清空历史会话"
          description="只清空侧栏的归档记录，并把对应 token/费用从顶部累计统计中扣除；不会删除 ~/.claude/projects 里的原始 JSONL。操作不可恢复。"
        >
        {confirmClear ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent-red/40 bg-accent-red/10 px-3 py-2">
            <span className="text-xs text-accent-red">清空全部 {sessions.length} 条历史？不可恢复</span>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => { setConfirmClear(false); clearAllSessions(); }}
                className={BUTTON_DANGER}
              >
                确认清空
              </button>
              <button type="button" onClick={() => setConfirmClear(false)} className={BUTTON_GHOST}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={sessions.length === 0}
            className={`${BUTTON_DANGER} w-full justify-center bg-transparent`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            清空全部历史会话
          </button>
        )}
        </DangerZone>
      </div>
    </div>
  );
}

export function RuntimeView({ onChanged, onOpenNative }: Pick<SettingsViewProps, 'cliVersion' | 'actualModel'> & { onChanged: () => void; onOpenNative: () => void }) {
  return (
    <div>
      <SectionIntro title="运行环境" description="高级设置：决定 GUI 调用哪个 Claude Code CLI、带什么环境变量，以及原生功能入口。这里的操作会单独保存。" />
      <div className="mt-3 space-y-3">
        <p className="text-2xs leading-5 text-text-secondary">环境变量和密钥不会回显；修改后现有 CLI 不会热更新，请空闲时重新连接当前会话。</p>
        <RuntimeSettings onChanged={onChanged} onOpenNative={onOpenNative} />
      </div>
    </div>
  );
}

export function AboutView({ cliVersion, actualModel }: Pick<SettingsViewProps, 'cliVersion' | 'actualModel'>) {
  return (
    <div id="setting-about">
      <SectionIntro title="关于" description="Claude GUI 是 Claude Code CLI 的桌面图形界面，通过结构化 stream-json 与 CLI 通信。" />
      <div className="mt-4 space-y-2 rounded-xl border border-border/50 bg-bg-light/40 p-4 text-xs leading-relaxed text-text-secondary">
        <div className="flex items-center gap-2 text-text-primary"><Shield className="h-4 w-4 text-accent-cyan" />运行信息</div>
        <div className="font-mono text-2xs">CLI 版本：{cliVersion || '未读取'}</div>
        <div className="font-mono text-2xs">当前模型：{actualModel || '未连接'}</div>
        <div className="pt-2 text-text-dim">设置与会话索引保存在：</div>
        <code className="block break-all rounded-md bg-bg-deep/60 px-2 py-1.5 font-mono text-2xs">~/Library/Application Support/claude-gui/claude-gui-config.json</code>
        <div className="pt-1 text-text-dim">Claude Code 原始会话保存在：</div>
        <code className="block break-all rounded-md bg-bg-deep/60 px-2 py-1.5 font-mono text-2xs">~/.claude/projects/</code>
        <div className="pt-2 text-2xs text-text-dim">需要原生 TUI、MCP/Plugins 管理或登录时，请在“运行环境 → 原生功能管理”中打开原生终端。</div>
      </div>
    </div>
  );
}
