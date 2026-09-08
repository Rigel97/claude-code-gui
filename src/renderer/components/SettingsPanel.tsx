import { useState } from 'react';
import { useStore } from '../store';
import { X, Cpu, Info, Shield, Bell, Archive, Trash2, RotateCcw } from 'lucide-react';

const PERMISSION_MODES = [
  {
    id: 'bypassPermissions' as const,
    label: '全部放行',
    desc: '所有工具调用自动通过（适合完全信任的本地项目）',
  },
  {
    id: 'acceptEdits' as const,
    label: '仅自动接受文件编辑',
    desc: '文件读写自动通过，命令执行等仍会被拒绝',
  },
];

const SESSION_LIMIT_OPTIONS = [20, 50, 100, 200];

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
  const currentModel = useStore((s) => s.currentModel);
  const permissionMode = useStore((s) => s.permissionMode);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const showThinking = useStore((s) => s.showThinking);
  const setShowThinking = useStore((s) => s.setShowThinking);
  const notifyOnComplete = useStore((s) => s.notifyOnComplete);
  const setNotifyOnComplete = useStore((s) => s.setNotifyOnComplete);
  const maxSessions = useStore((s) => s.maxSessions);
  const setMaxSessions = useStore((s) => s.setMaxSessions);
  const clearAllSessions = useStore((s) => s.clearAllSessions);
  const sessions = useStore((s) => s.sessions);

  // 模型 ID 直接作为 --model 传给 CLI；留空表示跟随 CLI 默认配置。
  // 不提供预设别名：非官方端点（如 GLM 中转）上 sonnet/opus/haiku 等别名无效
  const [localModel, setLocalModel] = useState(model);
  const [localPermissionMode, setLocalPermissionMode] = useState(permissionMode);
  const [localShowThinking, setLocalShowThinking] = useState(showThinking);
  const [localNotify, setLocalNotify] = useState(notifyOnComplete);
  const [localMaxSessions, setLocalMaxSessions] = useState(maxSessions);
  const [confirmClear, setConfirmClear] = useState(false);

  const handleSave = () => {
    setModel(localModel.trim());
    setPermissionMode(localPermissionMode);
    setShowThinking(localShowThinking);
    setNotifyOnComplete(localNotify);
    setMaxSessions(localMaxSessions);
    onClose();
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
              保存后下一次发送生效；留空则跟随 CLI 默认配置。
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
                  onClick={() => setLocalPermissionMode(m.id)}
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
            className="px-4 py-1.5 rounded-lg text-sm bg-accent-cyan/20 hover:bg-accent-cyan/30 border border-accent-cyan/40 text-accent-cyan transition-all"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
