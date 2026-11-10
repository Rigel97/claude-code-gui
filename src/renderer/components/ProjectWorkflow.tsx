import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Ban, CheckCircle2, Circle, CircleDot, LocateFixed, Maximize2, Minus, Plus, Search, X } from 'lucide-react';
import { usePopoverBehavior } from './useDialogBehavior';
import { layoutWorkflow, nodeInViewport, NODE_HEIGHT, NODE_WIDTH, TASK_LABELS, TASK_STATUSES } from '../projectModel';
import type { ManagedProject, TaskStatus } from '../projectTypes';

export interface ProjectWorkflowProps {
  project: ManagedProject;
  onSelectTask: (id: string) => void;
  selectedTaskId?: string | null;
}

const STATUS_STYLE: Record<TaskStatus, string> = {
  pending: 'text-text-secondary border-border',
  in_progress: 'text-accent-blue border-accent-blue/40',
  completed: 'text-accent-green border-accent-green/30',
  cancelled: 'text-text-secondary border-border',
};
const STATUS_ICON = { pending: Circle, in_progress: CircleDot, completed: CheckCircle2, cancelled: Ban };
const CONTROL = 'inline-flex shrink-0 items-center justify-center rounded-lg border border-border-light text-text-secondary hover:bg-white/5 hover:text-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan disabled:opacity-40 disabled:cursor-not-allowed';
const ICON_CONTROL = `${CONTROL} h-8 w-8`;
const SMALL_CONTROL = `${CONTROL} h-7 gap-1.5 px-2 text-xs`;
const STATUS_FILL: Record<TaskStatus, string> = {
  pending: 'fill-text-secondary',
  in_progress: 'fill-accent-blue',
  completed: 'fill-accent-green',
  cancelled: 'fill-text-secondary',
};
// 关系标记独立于状态色：不会把依赖关系误读成执行状态。
const RELATION_STYLE = {
  selected: 'ring-2 ring-accent-cyan ring-offset-2 ring-offset-bg-deep',
  upstream: 'ring-2 ring-accent-blue ring-offset-2 ring-offset-bg-deep',
  downstream: 'ring-2 ring-accent-cyan ring-offset-2 ring-offset-bg-deep',
};
const MAP_WIDTH = 208;
const MAP_HEIGHT = 72;
const PAGE_SIZE = 20;
// 可读下限：更小的缩放会让节点文字失去意义，改用“适应窗口”后仍保留放大入口。
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

function summarize(items: string[]) {
  const known = items.filter(item => item.trim());
  return known.length ? known.join(' · ') : '待确认';
}

export function ProjectWorkflow({ project, onSelectTask, selectedTaskId }: ProjectWorkflowProps) {
  const workflowRef = useRef<HTMLElement>(null);
  usePopoverBehavior(workflowRef);
  const layout = useMemo(() => layoutWorkflow(project.tasks), [project.tasks]);
  const connectedIds = useMemo(() => new Set(layout.edges.flatMap(edge => [edge.from, edge.to])), [layout.edges]);
  const tasksById = useMemo(() => new Map(project.tasks.map(task => [task.id, task])), [project.tasks]);
  const nodesById = useMemo(() => new Map(layout.nodes.map(node => [node.taskId, node])), [layout.nodes]);
  const relations = useMemo(() => {
    const upstream = new Set<string>();
    const downstream = new Set<string>();
    for (const edge of layout.edges) {
      if (edge.to === selectedTaskId) upstream.add(edge.from);
      if (edge.from === selectedTaskId) downstream.add(edge.to);
    }
    return { upstream, downstream };
  }, [layout.edges, selectedTaskId]);
  const hasSelection = !!selectedTaskId && nodesById.has(selectedTaskId);
  const relationFor = (id: string) => id === selectedTaskId ? 'selected'
    : relations.upstream.has(id) ? 'upstream' : relations.downstream.has(id) ? 'downstream' : null;
  const scroller = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const searchPanel = useRef<HTMLDivElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{ element: HTMLDivElement; pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const nodeButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewNotice, setViewNotice] = useState('');
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const searchPanelId = useId();
  const [page, setPage] = useState(0);
  const searchId = useId();
  const helpId = useId();
  const markerId = `workflow-arrow-${useId().replace(/:/g, '')}`;

  const readViewport = useCallback(() => {
    const element = scroller.current;
    if (element) setViewport({ left: element.scrollLeft / zoom, top: element.scrollTop / zoom,
      width: element.clientWidth / zoom, height: element.clientHeight / zoom });
  }, [zoom]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (zoomAnchor.current) {
      element.scrollLeft = zoomAnchor.current.x * zoom - element.clientWidth / 2;
      element.scrollTop = zoomAnchor.current.y * zoom - element.clientHeight / 2;
      zoomAnchor.current = null;
    }
    readViewport();
    const measure = () => {
      readViewport();
      // 底栏最多占 89px；工作区低于 360px 时让空间回到画布。
      const area = workspace.current;
      setShowMap(!!area && area.clientHeight >= 360 && area.clientWidth >= 320);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace.current || element);
    observer.observe(element);
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(readViewport);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [readViewport, zoom, layout.width, layout.height]);

  const centerTask = useCallback((id: string, focus = false) => {
    const element = scroller.current;
    const node = nodesById.get(id);
    if (!element || !node) return;
    if (focus) pendingFocus.current = id;
    element.scrollLeft = (node.x + NODE_WIDTH / 2) * zoom - element.clientWidth / 2;
    element.scrollTop = (node.y + NODE_HEIGHT / 2) * zoom - element.clientHeight / 2;
    readViewport();
  }, [nodesById, zoom, readViewport]);

  const centerTaskRef = useRef(centerTask);
  centerTaskRef.current = centerTask;
  useLayoutEffect(() => {
    if (selectedTaskId) centerTaskRef.current(selectedTaskId);
  }, [selectedTaskId, nodesById, project.id]);

  useEffect(() => {
    setSearch(''); setPage(0); setSearchOpen(false); setViewNotice(''); setFocusedTaskId(null); pendingFocus.current = null;
  }, [project.id]);

  const closeSearch = useCallback((restoreFocus = false) => {
    setSearchOpen(false);
    if (restoreFocus) searchButton.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!searchOpen) return;
    searchInput.current?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!searchPanel.current?.contains(target) && !searchButton.current?.contains(target)) closeSearch();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(true); }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [searchOpen, closeSearch]);

  const endDrag = useCallback(() => {
    const active = drag.current;
    drag.current = null;
    if (active?.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    setDragging(false);
  }, []);
  useEffect(() => {
    endDrag();
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('blur', endDrag);
      const active = drag.current;
      drag.current = null;
      if (active?.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    };
  }, [project.id, zoom, endDrag]);
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    const button = id ? nodeButtons.current.get(id) : undefined;
    if (button) { pendingFocus.current = null; button.focus({ preventScroll: true }); }
  }, [viewport]);

  const changeZoom = (next: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next.toFixed(2))));
    const element = scroller.current;
    if (clamped === zoom || !element) return;
    zoomAnchor.current = { x: (element.scrollLeft + element.clientWidth / 2) / zoom,
      y: (element.scrollTop + element.clientHeight / 2) / zoom };
    setZoom(clamped);
  };

  /** 适应窗口：让全部节点进入可视区域；仍保留百分比与手动缩放。 */
  const fitToView = () => {
    const element = scroller.current;
    if (!element || layout.width <= 0 || layout.height <= 0) return;
    const next = Math.min(1, element.clientWidth / layout.width, element.clientHeight / layout.height);
    const clamped = Math.max(MIN_ZOOM, Math.floor(next * 100) / 100);
    setViewNotice(next < MIN_ZOOM ? '已到最小缩放 40%；部分任务仍在画布外，可用搜索或全图导航定位。' : '已适应窗口显示全部节点。');
    zoomAnchor.current = null;
    setZoom(clamped);
    element.scrollLeft = 0;
    element.scrollTop = 0;
    readViewport();
  };

  const results = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return project.tasks.filter(task => !query || `${task.name} ${task.description} ${task.id}`.toLocaleLowerCase().includes(query));
  }, [project.tasks, search]);
  const lastPage = Math.max(0, Math.ceil(results.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visibleNodes = layout.nodes.filter(node => node.taskId === focusedTaskId || nodeInViewport(node, viewport));
  const visibleEdges = layout.edges.filter(edge => {
    const left = Math.min(edge.x1, edge.x2), right = Math.max(edge.x1, edge.x2);
    const top = Math.min(edge.y1, edge.y2), bottom = Math.max(edge.y1, edge.y2);
    return right >= viewport.left - 240 && left <= viewport.left + viewport.width + 240 &&
      bottom >= viewport.top - 240 && top <= viewport.top + viewport.height + 240;
  });

  const mapScale = Math.min((MAP_WIDTH - 8) / Math.max(1, layout.width), (MAP_HEIGHT - 8) / Math.max(1, layout.height));
  const mapOffsetX = (MAP_WIDTH - layout.width * mapScale) / 2;
  const mapOffsetY = (MAP_HEIGHT - layout.height * mapScale) / 2;
  const mapViewportWidth = Math.min(viewport.width, Math.max(0, layout.width - viewport.left));
  const mapViewportHeight = Math.min(viewport.height, Math.max(0, layout.height - viewport.top));

  return (
    <section ref={workflowRef} aria-label="项目任务工作流" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-bg-deep">
      <div className="relative z-20 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        <h3 className="shrink-0 text-sm font-medium text-text-primary">任务工作流 <span className="ml-1 font-mono text-xs text-text-muted">{project.tasks.length} 项</span></h3>
        <div className="hidden flex-wrap items-center gap-x-3 gap-y-1 text-xs xl:flex" aria-label="任务状态图例">
          {TASK_STATUSES.map(status => {
            const Icon = STATUS_ICON[status];
            return <span key={status} className={`flex items-center gap-1 ${STATUS_STYLE[status]}`}><Icon size={12} aria-hidden="true" />{TASK_LABELS[status]}</span>;
          })}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button ref={searchButton} type="button" className={`${CONTROL} h-8 gap-1.5 px-2 text-xs`} aria-label="搜索并选择任务（含视野外任务）" aria-expanded={searchOpen} aria-controls={searchPanelId} onClick={() => searchOpen ? closeSearch(true) : setSearchOpen(true)}><Search size={16} aria-hidden="true" />搜索任务</button>
          <details data-popover className="relative text-2xs text-text-secondary">
            <summary className="flex h-8 cursor-pointer list-none items-center rounded-lg px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan">说明</summary>
            <div id={helpId} className="absolute right-0 top-full z-20 mt-1 w-80 max-w-[70vw] rounded-lg border border-border bg-bg-deep p-3 text-xs leading-5 shadow-xl"><p>连线仅表示已记录的前置依赖；未知关系不连线。孤立节点只表示没有已记录连线。仅作查看与定位，不自动执行或调度任务。可拖动画布空白处平移，也可用滚动条或键盘滚动。</p><div className="mt-2 grid grid-cols-2 gap-2">{TASK_STATUSES.map(status => { const Icon = STATUS_ICON[status]; return <span key={status} className={`flex items-center gap-1.5 ${STATUS_STYLE[status]}`}><Icon size={14} />{TASK_LABELS[status]}</span>; })}</div></div>
          </details>
          <div className="flex items-center gap-2" role="group" aria-label="工作流视图控制">
            <div className="flex items-center gap-1" role="group" aria-label="工作流缩放">
              <button type="button" className={ICON_CONTROL} aria-label="缩小工作流" disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(zoom - 0.15)}><Minus size={16} aria-hidden="true" /></button>
              <button type="button" className={`${CONTROL} h-8 min-w-[54px] px-2 text-xs font-mono tabular-nums`} aria-label="重置缩放至百分之百" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button type="button" className={ICON_CONTROL} aria-label="放大工作流" disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom + 0.15)}><Plus size={16} aria-hidden="true" /></button>
            </div>
            <div className="flex items-center gap-1 border-l border-border-light pl-2" role="group" aria-label="工作流定位">
              <button type="button" className={ICON_CONTROL} aria-label="适应窗口显示全部节点" title="适应窗口；最小缩放40%，大图可通过搜索或全图导航定位" onClick={fitToView}><Maximize2 size={16} aria-hidden="true" /></button>
              <button type="button" className={ICON_CONTROL} aria-label="居中定位选中任务" disabled={!hasSelection} onClick={() => selectedTaskId && centerTask(selectedTaskId, true)}><LocateFixed size={16} aria-hidden="true" /></button>
            </div>
          </div>
        </div>
        {searchOpen && <div ref={searchPanel} id={searchPanelId} role="region" aria-label="搜索任务列表" className="absolute right-2 top-full z-30 mt-1 flex max-h-[min(420px,55vh)] w-[380px] max-w-[calc(100%-16px)] flex-col overflow-hidden rounded-xl border border-border-light bg-bg-deep p-3 text-xs text-text-secondary shadow-xl" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== searchButton.current) closeSearch(); }}>
          <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
            <span className="font-medium text-text-primary">搜索并选择任务（含视野外任务）</span>
            <button type="button" className={ICON_CONTROL} aria-label="关闭任务搜索" onClick={() => closeSearch(true)}><X size={16} aria-hidden="true" /></button>
          </div>
          <label htmlFor={searchId} className="mb-1 block shrink-0">任务名称、说明或标识</label>
          <div className="relative shrink-0">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-text-muted" aria-hidden="true" />
            <input ref={searchInput} id={searchId} type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} className="w-full rounded-lg border border-border-light bg-bg-deepest py-2 pl-8 pr-3 text-text-primary outline-none focus:border-accent-cyan" placeholder="搜索任务" />
          </div>
          <div className="mt-2 grid min-h-0 max-h-60 gap-1 overflow-auto overscroll-contain">
            {results.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(task => (
              <button key={task.id} type="button" aria-pressed={selectedTaskId === task.id} className="flex min-w-0 items-center justify-between gap-2 rounded px-2 py-2 text-left hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan" onClick={() => { closeSearch(); centerTask(task.id, true); onSelectTask(task.id); }}>
                <span className="truncate text-text-primary" title={task.name}>{task.name || '未命名任务'}</span><span className={`shrink-0 text-2xs ${STATUS_STYLE[task.status]}`}>{TASK_LABELS[task.status]}</span>
              </button>
            ))}
            {!results.length && <p className="py-2">没有匹配的任务</p>}
          </div>
          <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
            <span role="status">{results.length} 项 · 第 {currentPage + 1} / {lastPage + 1} 页</span>
            <div className="flex gap-2"><button type="button" className={SMALL_CONTROL} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button type="button" className={SMALL_CONTROL} disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
          </div>
        </div>}
      </div>
      {hasSelection && <div aria-label="任务关系图例" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-1.5 text-2xs text-text-secondary">
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm border-2 border-accent-cyan" />选中任务</span>
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-0.5 w-4 bg-accent-blue" />直接上游 {relations.upstream.size}</span>
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-0.5 w-4 bg-accent-cyan" />直接下游 {relations.downstream.size}</span>
        <span>{layout.error ? '依赖无效，关系已隐藏' : '箭头：前置 → 后续 · 无关任务淡化'}</span>
      </div>}
      {viewNotice && <p role="status" className="shrink-0 border-b border-border/40 px-3 py-1.5 text-xs text-text-muted">{viewNotice}</p>}
      {layout.error && <p role="alert" className="shrink-0 border-b border-accent-red/20 bg-accent-red/5 px-3 py-1.5 text-xs text-accent-red">{layout.error}。已隐藏依赖连线，请在任务详情中修正。</p>}
      <div ref={workspace} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!project.tasks.length ? <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-text-secondary">暂无任务，工作流待确认。</div> : (
          <div ref={scroller} tabIndex={0} role="region" aria-label="可滚动工作流画布" aria-describedby={helpId} className={`relative min-h-0 flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan ${dragging ? 'cursor-grabbing select-none' : 'cursor-grab'}`}
            onPointerDown={event => {
              if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch' || drag.current || (event.target as Element).closest('button, input, textarea, select, a, summary, [role="button"], [contenteditable="true"]')) return;
              const element = event.currentTarget;
              const bounds = element.getBoundingClientRect();
              if (event.clientX >= bounds.left + element.clientWidth || event.clientY >= bounds.top + element.clientHeight) return;
              event.preventDefault();
              element.focus({ preventScroll: true });
              element.setPointerCapture(event.pointerId);
              drag.current = { element, pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
              setDragging(true);
            }}
            onPointerMove={event => {
              const active = drag.current;
              if (!active || active.pointerId !== event.pointerId) return;
              if (!(event.buttons & 1)) { endDrag(); return; }
              active.element.scrollLeft = active.left - (event.clientX - active.x);
              active.element.scrollTop = active.top - (event.clientY - active.y);
            }}
            onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) endDrag(); }}
            onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) endDrag(); }}
            onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) endDrag(); }}
            style={{ backgroundImage: 'radial-gradient(#2a3349 1px, transparent 1px)', backgroundSize: '24px 24px' }}>
            <div className="relative" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
              <div className="absolute left-0 top-0 origin-top-left" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
                <svg aria-hidden="true" className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height}>
                  <defs>{['default', 'upstream', 'downstream'].map(kind => <marker key={kind} id={`${markerId}-${kind}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" className={kind === 'upstream' ? 'fill-accent-blue' : 'fill-accent-cyan'} /></marker>)}</defs>
                  {visibleEdges.map(edge => {
                    const kind = edge.to === selectedTaskId ? 'upstream' : edge.from === selectedTaskId ? 'downstream' : 'default';
                    return <path key={`${edge.from}:${edge.to}`} d={edge.path} fill="none" stroke="currentColor" strokeWidth={kind === 'default' ? 1.5 : 2.5} opacity={kind === 'default' ? hasSelection ? 0.2 : 0.35 : 1} className={kind === 'upstream' ? 'text-accent-blue' : 'text-accent-cyan'} markerEnd={`url(#${markerId}-${kind})`} />;
                  })}
                </svg>
                {visibleNodes.map(node => {
                  const task = tasksById.get(node.taskId)!;
                  const Icon = STATUS_ICON[task.status];
                  const relation = relationFor(task.id);
                  const inputCount = task.inputs.filter(item => item.trim()).length;
                  const outputCount = task.outputs.filter(item => item.trim()).length;
                  return (
                    <button key={node.taskId} type="button" ref={element => { if (element) nodeButtons.current.set(node.taskId, element); else nodeButtons.current.delete(node.taskId); }} onFocus={() => setFocusedTaskId(task.id)} onBlur={() => setFocusedTaskId(null)} onClick={() => onSelectTask(task.id)} aria-pressed={selectedTaskId === task.id} aria-label={`${task.name || '未命名任务'}，${TASK_LABELS[task.status]}，输入：${summarize(task.inputs)}，输出：${summarize(task.outputs)}`} className={`absolute flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-bg-light p-4 text-left shadow-lg transition-colors hover:bg-bg-lighter focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan ${STATUS_STYLE[task.status]} ${relation ? RELATION_STYLE[relation] : hasSelection ? 'opacity-[0.65] hover:opacity-100 focus-visible:opacity-100' : ''}`} data-workflow-relation={relation || 'unrelated'} style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}>
                      <span className="mb-2 flex w-full items-center justify-between gap-2 text-2xs"><span className="flex items-center gap-1.5"><Icon size={14} aria-hidden="true" />{TASK_LABELS[task.status]}</span><span className="text-text-muted">{relation === 'upstream' ? '直接上游' : relation === 'downstream' ? '直接下游' : layout.error ? '连线已隐藏，待修正' : !connectedIds.has(task.id) ? '孤立（无已记录连线）' : `前置 ${task.dependsOn.length}`}</span></span>
                      <span className="line-clamp-2 w-full text-sm font-medium leading-5 text-text-primary" title={task.name}>{task.name || '未命名任务'}</span>
                      <span className="mt-0.5 line-clamp-1 min-h-[16px] w-full text-2xs leading-4 text-text-secondary" title={task.description}>{task.description.trim() || '任务说明待确认'}</span>
                      <span className="mt-2 block w-full border-t border-border-light pt-2 text-2xs text-text-secondary"><span className="block truncate">输入 {inputCount ? `${inputCount} 项` : '待确认'} · 输出 {outputCount ? `${outputCount} 项` : '待确认'}</span></span>
                      <span className="mt-auto block w-full truncate pt-1 text-2xs text-text-secondary" title={task.dependencyNote}>{task.dependencyNote.trim() || (task.dependsOn.length ? '依赖说明待确认' : '依赖关系待确认，不推定为无依赖')}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        {showMap && project.tasks.length > 0 && <div aria-label="工作流全图导航" className="flex h-[89px] shrink-0 items-center gap-3 border-t border-border px-3 py-2">
          <svg role="group" aria-label="工作流缩略图" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} width={MAP_WIDTH} height={MAP_HEIGHT} className="shrink-0 overflow-hidden rounded border border-border-light bg-bg-deepest">
            <g transform={`translate(${mapOffsetX}, ${mapOffsetY}) scale(${mapScale})`}>
              {layout.edges.map(edge => <path key={`${edge.from}:${edge.to}`} d={edge.path} fill="none" stroke="currentColor" strokeWidth={1 / mapScale} className={edge.to === selectedTaskId ? 'text-accent-blue' : 'text-accent-cyan'} opacity={edge.from === selectedTaskId || edge.to === selectedTaskId ? 1 : 0.3} />)}
              {layout.nodes.map(node => {
                const task = tasksById.get(node.taskId)!;
                const relation = relationFor(task.id);
                return <g key={task.id} role="button" tabIndex={0} aria-label={`在缩略图定位任务：${task.name || '未命名任务'}，${TASK_LABELS[task.status]}`} aria-pressed={selectedTaskId === task.id} className="group cursor-pointer outline-none" onClick={() => centerTask(task.id, true)} onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); centerTask(task.id, true); }
                }}>
                  <title>{task.name || '未命名任务'} · {TASK_LABELS[task.status]}</title>
                  <rect x={node.x} y={node.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx={12} className={`${STATUS_FILL[task.status]} ${relation === 'upstream' ? 'stroke-accent-blue' : relation ? 'stroke-accent-cyan' : 'stroke-border-light'}`} fillOpacity={task.status === 'cancelled' ? 0.3 : 0.8} strokeWidth={(relation ? 1.5 : 0.5) / mapScale} strokeDasharray={task.status === 'cancelled' ? `${2 / mapScale} ${1 / mapScale}` : undefined} />
                  <rect x={node.x} y={node.y} width={NODE_WIDTH} height={NODE_HEIGHT} fill="none" className="stroke-text-primary opacity-0 group-focus-visible:opacity-100 group-hover:opacity-100" strokeWidth={2 / mapScale} />
                </g>;
              })}
              <rect aria-label="当前画布视口" x={viewport.left} y={viewport.top} width={mapViewportWidth} height={mapViewportHeight} fill="currentColor" fillOpacity={0.08} stroke="currentColor" strokeWidth={1.5 / mapScale} className="pointer-events-none text-accent-cyan" />
            </g>
          </svg>
          <div className="min-w-0 text-2xs leading-5 text-text-secondary"><p className="truncate font-medium text-text-primary">全图导航 <span className="font-mono text-text-muted">{layout.nodes.length} 项</span></p><p className="truncate" title="点击节点或 Tab + Enter 定位">点击节点或 Tab + Enter 定位</p><p className="truncate text-text-muted">框线为当前视口 · 空白处拖拽平移</p></div>
        </div>}
      </div>
    </section>
  );
}
