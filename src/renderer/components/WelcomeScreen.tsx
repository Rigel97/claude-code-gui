import { FolderOpen, Radio, Wrench, Layers } from 'lucide-react';
import { useStore } from '../store';

export function WelcomeScreen() {
  const setCwd = useStore((s) => s.setCwd);
  const newSession = useStore((s) => s.newSession);

  const handleOpenDir = async () => {
    const dir = await (window as any).api.openDirectory();
    if (dir) {
      setCwd(dir);
      newSession();
    }
  };

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-8">
      {/* 大 Logo */}
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-accent-cyan/20 blur-3xl rounded-full animate-pulse-glow" />
        <div className="relative w-24 h-24 rounded-3xl bg-gradient-to-br from-accent-cyan/20 to-accent-purple/20 border border-accent-cyan/30 flex items-center justify-center tech-glow-cyan">
          <svg className="w-12 h-12 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
      </div>

      <h1 className="text-3xl font-bold gradient-text-cyan mb-3 tracking-wide">
        Claude GUI
      </h1>

      <p className="text-text-muted text-center max-w-md mb-8 text-sm leading-relaxed">
        Claude Code 的图形界面，实时展示流式输出与工具调用，
        <br />
        支持多会话管理与成本统计。
      </p>

      {/* 选择目录按钮 */}
      <button
        onClick={handleOpenDir}
        className="group flex items-center gap-3 px-8 py-3.5 rounded-xl bg-gradient-to-r from-accent-cyan/10 to-accent-blue/10 hover:from-accent-cyan/20 hover:to-accent-blue/20 border border-accent-cyan/30 hover:border-accent-cyan/50 transition-all tech-glow-cyan"
      >
        <FolderOpen className="w-5 h-5 text-accent-cyan group-hover:scale-110 transition-transform" />
        <span className="text-sm text-accent-cyan font-medium">选择项目目录，开始使用</span>
      </button>

      {/* 特性卡片 */}
      <div className="grid grid-cols-3 gap-4 mt-12 max-w-2xl">
        <FeatureCard
          icon={<Radio className="w-5 h-5" />}
          title="流式输出"
          desc="回复逐字实时呈现，思考过程可展开查看"
        />
        <FeatureCard
          icon={<Wrench className="w-5 h-5" />}
          title="工具可视化"
          desc="文件读写、命令执行等调用过程清晰可见"
        />
        <FeatureCard
          icon={<Layers className="w-5 h-5" />}
          title="会话管理"
          desc="历史会话自动保存，成本与 Token 用量统计"
        />
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="glass-panel glass-panel-hover rounded-xl p-4 transition-all">
      <div className="text-accent-cyan mb-2">{icon}</div>
      <div className="text-sm font-semibold text-text-primary mb-1">{title}</div>
      <div className="text-xs text-text-muted">{desc}</div>
    </div>
  );
}
