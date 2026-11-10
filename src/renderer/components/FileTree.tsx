import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../store';
import { Folder, FolderOpen, File, ChevronRight, ChevronDown, RefreshCw, Loader2, Eye, Settings2 } from 'lucide-react';
import { FilePreview } from './FilePreview';
import { ICON_BUTTON, ICON_BUTTON_SM, MENU_ITEM, POPOVER_PANEL } from './controls';
import { usePopoverBehavior } from './useDialogBehavior';

interface FsItem { name: string; path: string; isDir: boolean; isSymlink?: boolean }
interface Filters { showHidden: boolean; showIgnored: boolean }
interface DirectoryPage { items: FsItem[]; total: number; offset: number; nextOffset: number | null; error?: string }
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const filters = { showHidden, showIgnored };
  const containerRef = useRef<HTMLDivElement>(null);
  usePopoverBehavior(containerRef);
  return (
    <div ref={containerRef} className="px-2 pb-2">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="font-mono text-2xs uppercase tracking-wider text-text-dim">项目文件</span>
        <div className="flex shrink-0 items-center gap-1">
          <details data-popover className="relative">
            <summary className={`${ICON_BUTTON} list-none cursor-pointer [&::-webkit-details-marker]:hidden`} aria-label="文件显示选项" title="文件显示选项">
              <Settings2 className="h-3.5 w-3.5" />
            </summary>
            <div className={`${POPOVER_PANEL} absolute right-0 top-full mt-1 w-52 max-w-[80vw]`}>
              <div className="px-3 py-1.5 text-xs font-medium text-text-primary">文件显示选项</div>
              <label className={`${MENU_ITEM} cursor-pointer`}><input className="h-3.5 w-3.5 shrink-0 accent-accent-cyan" type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} /> 显示隐藏文件</label>
              <label className={`${MENU_ITEM} cursor-pointer`}><input className="h-3.5 w-3.5 shrink-0 accent-accent-cyan" type="checkbox" checked={showIgnored} onChange={e => setShowIgnored(e.target.checked)} /> 显示忽略目录</label>
            </div>
          </details>
          <button onClick={() => setRefreshKey(k => k + 1)} className={ICON_BUTTON} title="刷新文件树"><RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <DirectoryList key={`${root}:${showHidden}:${showIgnored}`} dirPath={root} root={root} depth={0} filters={filters} refreshKey={refreshKey} />
      <div className="px-2 pt-2 font-mono text-2xs leading-relaxed text-text-dim">点击文件插入 @引用 · 预览按钮仅打开预览，不发送模型</div>
    </div>
  );
}

function DirectoryList({ dirPath, root, depth, filters, refreshKey }: { dirPath: string; root: string; depth: number; filters: Filters; refreshKey: number }) {
  const [items, setItems] = useState<FsItem[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [legacy, setLegacy] = useState(false);
  const retryOffset = useRef(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const { showHidden, showIgnored } = filters;
  const load = useCallback(async (offset: number) => {
    if (busy.current) return;
    busy.current = true;
    const token = generation.current;
    retryOffset.current = offset;
    setLoading(true);
    setError('');
    try {
      const result: DirectoryPage | FsItem[] = await (window as any).api.fs.readDir(dirPath, { showHidden, showIgnored, offset, limit: 200 });
      if (token !== generation.current) return;
      const oldBridge = Array.isArray(result);
      const page: DirectoryPage = oldBridge ? { items: result, total: result.length, offset: 0, nextOffset: null } : result;
      if (!page || page.error) throw new Error(page?.error || '目录返回数据无效');
      if (!Array.isArray(page.items) || page.offset !== offset || (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset))) throw new Error('目录分页偏移无效，请刷新');
      setItems(previous => offset === 0 ? page.items : [...new Map([...previous, ...page.items].map(item => [item.path, item])).values()]);
      setTotal(page.total);
      setNextOffset(page.nextOffset);
      setLegacy(oldBridge);
    } catch (reason) {
      if (token === generation.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (token === generation.current) { busy.current = false; setLoading(false); }
    }
  }, [dirPath, showHidden, showIgnored]);
  useEffect(() => {
    generation.current++;
    busy.current = false;
    void load(0);
    return () => { generation.current++; busy.current = false; };
  }, [load, refreshKey]);
  return (
    <div className="space-y-px" aria-busy={loading}>
      {items.map(item => <TreeNode key={item.path} item={item} root={root} depth={depth} filters={filters} refreshKey={refreshKey} />)}
      {loading && <div role="status" className="flex justify-center py-3"><Loader2 className="w-4 h-4 animate-spin" /><span className="sr-only">加载目录</span></div>}
      {error && <div role="alert" className="text-xs text-accent-orange px-2 py-2">{error} <button disabled={loading} onClick={() => void load(retryOffset.current)} className="underline">重试</button></div>}
      {!loading && !error && items.length === 0 && <div className="text-xs text-text-dim px-3 py-3">空目录</div>}
      {nextOffset !== null && !error && <button disabled={loading} onClick={() => void load(nextOffset)} className="text-xs text-accent-cyan px-3 py-2">加载更多（{items.length}/{total}）</button>}
      {legacy && <div className="px-2 text-2xs text-text-dim">当前连接不支持筛选和分页，结果可能不完整</div>}
    </div>
  );
}

function TreeNode({ item, root, depth, filters, refreshKey }: { item: FsItem; root: string; depth: number; filters: Filters; refreshKey: number }) {
  const [expanded, setExpanded] = useState(false);
  const [visited, setVisited] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const injectText = useStore(s => s.injectText);
  const isDir = item.isDir && !item.isSymlink;
  const toggle = () => {
    if (isDir) { setVisited(true); setExpanded(value => !value); }
    else {
      const rel = item.path.startsWith(root + '/') ? item.path.slice(root.length + 1) : item.path;
      injectText(`@${rel} `);
    }
  };
  return (
    <div>
      <div className="relative group/row">
        <button onClick={toggle} aria-expanded={isDir ? expanded : undefined} className="w-full min-h-8 flex items-center gap-1 px-1.5 py-1 rounded hover:bg-bg-light group pr-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan" style={{ paddingLeft: `${depth * 12 + 6}px` }}>
          {isDir ? <>{expanded ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}{expanded ? <FolderOpen className="w-3.5 h-3.5 text-accent-cyan shrink-0" /> : <Folder className="w-3.5 h-3.5 text-accent-cyan shrink-0" />}</> : <><span className="w-3 shrink-0" /><File className={`w-3.5 h-3.5 shrink-0 ${fileIconColor(item.name)}`} /></>}
          <span className="min-w-0 text-xs truncate font-mono text-text-muted" title={item.name}>{item.name}</span>
          {item.isSymlink && <span className="shrink-0 text-2xs text-text-dim">（符号链接）</span>}
        </button>
        {!isDir && <button onClick={() => setPreview(item.path)} aria-label={`预览 ${item.name}`} className={`${ICON_BUTTON_SM} absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus:opacity-100`} title="预览文件"><Eye className="w-3 h-3" /></button>}
      </div>
      {isDir && visited && <div hidden={!expanded}><DirectoryList dirPath={item.path} root={root} depth={depth + 1} filters={filters} refreshKey={refreshKey} /></div>}
      {preview && <FilePreview path={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
