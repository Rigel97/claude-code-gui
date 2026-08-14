import { useState } from 'react';
import { useStore } from '../store';
import { X, Cpu, Brain, Info, Shield } from 'lucide-react';

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

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const model = useStore((s) => s.model);
  const setModel = useStore((s) => s.setModel);
  const currentModel = useStore((s) => s.currentModel);
  const permissionMode = useStore((s) => s.permissionMode);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const showThinking = useStore((s) => s.showThinking);
  const setShowThinking = useStore((s) => s.setShowThinking);

  const [localModel, setLocalModel] = useState(model);
  const [localPermissionMode, setLocalPermissionMode] = useState(permissionMode);
  const [localShowThinking, setLocalShowThinking] = useState(showThinking);

  const handleSave = () => {
    setModel(localModel);
    setPermissionMode(localPermissionMode);
    setShowThinking(localShowThinking);
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

        {/* 内容 */}
        <div className="p-5 space-y-5">
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
            <input
              type="text"
              value={localModel}
              onChange={(e) => setLocalModel(e.target.value)}
              placeholder="留空则使用 CLI 默认模型"
              className="w-full px-3 py-2 rounded-lg bg-bg-light border border-border text-sm text-text-primary placeholder-text-dim font-mono focus:border-accent-cyan/50 transition-colors"
            />
            <div className="text-[10px] text-text-dim mt-1.5 leading-relaxed">
              会作为 <code className="text-accent-cyan">--model</code> 参数传给 claude CLI。
              可用值取决于你的 CLI 配置，留空最安全。
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

          {/* 思考过程 */}
          <div>
            <label className="flex items-center gap-2 text-xs text-text-secondary font-mono uppercase tracking-wider mb-2">
              <Brain className="w-3.5 h-3.5" />
              思考过程
            </label>
            <button
              onClick={() => setLocalShowThinking(!localShowThinking)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-all ${
                localShowThinking
                  ? 'bg-accent-purple/10 border border-accent-purple/40 text-accent-purple'
                  : 'bg-bg-light border border-border text-text-secondary'
              }`}
            >
              <span>显示 Claude 的思考过程</span>
              <div className={`w-9 h-5 rounded-full relative transition-colors ${localShowThinking ? 'bg-accent-purple/40' : 'bg-bg-lighter'}`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-text-primary transition-all ${localShowThinking ? 'left-4' : 'left-0.5'}`} />
              </div>
            </button>
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
