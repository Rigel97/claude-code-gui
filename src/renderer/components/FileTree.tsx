import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store';
import {
  Folder, FolderOpen, File, ChevronRight, ChevronDown, RefreshCw, Loader2, Eye,
} from 'lucide-react';
import { FilePreview } from './FilePreview';

interface FsItem {
  name: string;
  path: string;
  isDir: boolean;
}

/** 文件图标颜色（按扩展名） */
function fileIconColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'text-accent-blue', tsx: 'text-accent-blue', js: 'text-accent-yellow',
    jsx: 'text-accent-yellow', json: 'text-accent-orange', md: 'text-accent-purple',
    css: 'text-accent-cyan', html: 'text-accent-red', py: 'text-accent-green',
    go: 'text-accent-cyan', rs: 'text-accent-orange', java: 'text-accent-red',
  };
  return map[ext] || 'text-text-muted';
}

export function FileTree({ root }: { root: string }) {
  const [items, setItems] = useState<FsItem[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    (window as any).api.fs.readDir(root).then((result: FsItem[]) => {
      if (!cancelled) setItems(result);
    });
    return () => { cancelled = true; };
  }, [root, refreshKey]);

  return (
    <div className="px-2 pb-2">
      {/* 标题栏 + 刷新 */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[10px] text-text-dim font-mono uppercase tracking-wider">项目文件</span>
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          className="text-text-dim hover:text-accent-cyan transition-colors"
          title="刷新文件树"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {items === null ? (
        <div className="flex items-center justify-center py-6 text-text-dim">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-xs text-text-dim px-3 py-4 text-center">空目录</div>
      ) : (
        <div className="space-y-px">
          {items.map((item) => (
            <TreeNode key={item.path} item={item} root={root} depth={0} />
          ))}
        </div>
      )}

      <div className="text-[10px] text-text-dim/60 font-mono px-2 pt-2 leading-relaxed">
        点击文件插入 @引用 · 悬停出现 👁 可预览
      </div>
    </div>
  );
}

function TreeNode({ item, root, depth }: { item: FsItem; root: string; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsItem[] | null>(null);
  // 文件预览弹层（仅本行使用，同一时刻最多一个）
  const [preview, setPreview] = useState<string | null>(null);
  const injectText = useStore((s) => s.injectText);

  const toggle = useCallback(async () => {
    if (!item.isDir) {
      // 点击文件 → 插入 @相对路径 到输入框
      const rel = item.path.startsWith(root + '/') ? item.path.slice(root.length + 1) : item.path;
      injectText(`@${rel} `);
      return;
    }
    if (!expanded && children === null) {
      const result = await (window as any).api.fs.readDir(item.path);
      setChildren(result);
    }
    setExpanded(!expanded);
  }, [item, expanded, children, root, injectText]);

  return (
    <div className="relative group/row">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1 px-1.5 py-1 rounded hover:bg-bg-light transition-colors group pr-6"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {item.isDir ? (
          <>
            {expanded
              ? <ChevronDown className="w-3 h-3 text-text-dim shrink-0" />
              : <ChevronRight className="w-3 h-3 text-text-dim shrink-0" />}
            {expanded
              ? <FolderOpen className="w-3.5 h-3.5 text-accent-cyan shrink-0" />
              : <Folder className="w-3.5 h-3.5 text-accent-cyan/70 shrink-0" />}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <File className={`w-3.5 h-3.5 shrink-0 ${fileIconColor(item.name)}`} />
          </>
        )}
        <span className={`text-xs truncate font-mono ${
          item.isDir ? 'text-text-secondary' : 'text-text-muted group-hover:text-text-primary'
        }`}>
          {item.name}
        </span>
      </button>

      {/* 预览按钮（hover 显示；不阻断点击行插入 @引用） */}
      {!item.isDir && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setPreview(item.path);
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-dim hover:text-accent-cyan opacity-0 group-hover/row:opacity-100 focus:opacity-100 transition-all"
          title="预览文件"
        >
          <Eye className="w-3 h-3" />
        </button>
      )}

      {item.isDir && expanded && children && (
        <div>
          {children.map((child) => (
            <TreeNode key={child.path} item={child} root={root} depth={depth + 1} />
          ))}
        </div>
      )}

      {preview && <FilePreview path={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
