import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';

export function ThinkingView({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  if (!text.trim()) return null;

  return (
    <div className="rounded-xl border border-accent-purple/20 bg-accent-purple/5 overflow-hidden animate-fade-in">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent-purple/10 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-accent-purple" /> : <ChevronRight className="w-3.5 h-3.5 text-accent-purple" />}
        <Brain className="w-4 h-4 text-accent-purple" />
        <span className="text-xs font-mono text-accent-purple uppercase tracking-wider">思考过程</span>
        <span className="text-[10px] text-text-dim ml-auto font-mono">{text.length} chars</span>
      </button>

      {expanded && (
        <div className="border-t border-accent-purple/20 px-3 py-2 bg-bg-deepest/50">
          <pre className="text-xs font-mono text-accent-purple/70 whitespace-pre-wrap leading-relaxed">
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}
