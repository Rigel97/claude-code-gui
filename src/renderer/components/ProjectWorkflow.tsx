import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Circle, CircleDot, LocateFixed, Minus, Plus, Search } from 'lucide-react';
import { layoutWorkflow, nodeInViewport, NODE_HEIGHT, NODE_WIDTH, TASK_LABELS, TASK_STATUSES } from '../projectModel';
import type { ManagedProject, TaskStatus } from '../projectTypes';

export interface ProjectWorkflowProps {
  project: ManagedProject;
  onSelectTask: (id: string) => void;
  selectedTaskId?: string | null;
}

const STATUS_STYLE: Record<TaskStatus, string> = {
  pending: 'text-accent-orange border-accent-orange/30',
  in_progress: 'text-accent-cyan border-accent-cyan/40',
  completed: 'text-accent-green border-accent-green/30',
};
const STATUS_ICON = { pending: Circle, in_progress: CircleDot, completed: CheckCircle2 };
const CONTROL = 'rounded-lg border border-border-light p-1.5 text-text-secondary hover:bg-white/5 hover:text-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan disabled:opacity-40 disabled:cursor-not-allowed';
const PAGE_SIZE = 20;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

function summarize(items: string[]) {
  const known = items.filter(item => item.trim());
  return known.length ? known.join(' · ') : '待确认';
}

export function ProjectWorkflow({ project, onSelectTask, selectedTaskId }: ProjectWorkflowProps) {
  const layout = useMemo(() => layoutWorkflow(project.tasks), [project.tasks]);
  const tasksById = useMemo(() => new Map(project.tasks.map(task => [task.id, task])), [project.tasks]);
  const nodesById = useMemo(() => new Map(layout.nodes.map(node => [node.taskId, node])), [layout.nodes]);
  const scroller = useRef<HTMLDivElement>(null);
  const nodeButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
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
    const observer = new ResizeObserver(readViewport);
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

  useEffect(() => { setSearch(''); setPage(0); setFocusedTaskId(null); pendingFocus.current = null; }, [project.id]);
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

  return (
    <section aria-label="项目任务工作流" className="flex min-h-[400px] min-w-0 shrink-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-bg-deep">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-text-primary">任务工作流 <span className="ml-2 font-mono text-xs text-text-muted">{project.tasks.length} 项</span></h2>
          <p id={helpId} className="mt-1 text-[11px] text-text-secondary">连线仅表示已记录的前置依赖；未知关系不连线。滚动查看，Tab 选择可见节点。</p>
        </div>
        <div className="flex items-center gap-2" role="group" aria-label="工作流视图控制">
          <button type="button" className={CONTROL} aria-label="缩小工作流" disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(zoom - 0.15)}><Minus size={15} /></button>
          <button type="button" className={`${CONTROL} min-w-[58px] text-xs font-mono`} aria-label="重置缩放至百分之百" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" className={CONTROL} aria-label="放大工作流" disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom + 0.15)}><Plus size={15} /></button>
          <button type="button" className={CONTROL} aria-label="居中定位选中任务" disabled={!selectedTaskId || !nodesById.has(selectedTaskId)} onClick={() => selectedTaskId && centerTask(selectedTaskId, true)}><LocateFixed size={15} /></button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border/60 px-4 py-2 text-xs" aria-label="任务状态图例">
        {TASK_STATUSES.map(status => {
          const Icon = STATUS_ICON[status];
          return <span key={status} className={`flex items-center gap-1.5 ${STATUS_STYLE[status]}`}><Icon size={13} aria-hidden="true" />{TASK_LABELS[status]}</span>;
        })}
        <span className="text-text-secondary">输入 / 输出为空：待确认</span>
      </div>
      <details className="border-b border-border px-4 py-2 text-xs text-text-secondary">
        <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan">搜索并选择任务（含视野外任务）</summary>
        <div className="pt-3">
          <label htmlFor={searchId} className="mb-1 block">任务名称、说明或标识</label>
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-text-muted" />
            <input id={searchId} type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} className="w-full rounded-lg border border-border-light bg-bg-deepest py-2 pl-8 pr-3 text-text-primary outline-none focus:border-accent-cyan" placeholder="搜索任务" />
          </div>
          <div className="mt-2 grid max-h-48 gap-1 overflow-auto sm:grid-cols-2">
            {results.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(task => (
              <button key={task.id} type="button" aria-pressed={selectedTaskId === task.id} className="flex min-w-0 items-center justify-between gap-2 rounded px-2 py-2 text-left hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan" onClick={() => { centerTask(task.id, true); onSelectTask(task.id); }}>
                <span className="truncate text-text-primary" title={task.name}>{task.name || '未命名任务'}</span><span className={`shrink-0 text-[10px] ${STATUS_STYLE[task.status]}`}>{TASK_LABELS[task.status]}</span>
              </button>
            ))}
            {!results.length && <p className="py-2">没有匹配的任务</p>}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span role="status">{results.length} 项 · 第 {currentPage + 1} / {lastPage + 1} 页</span>
            <div className="flex gap-2"><button type="button" className={CONTROL} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button type="button" className={CONTROL} disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
          </div>
        </div>
      </details>
      {layout.error && <p role="alert" className="border-b border-accent-orange/20 bg-accent-orange/5 px-4 py-2 text-xs text-accent-orange">{layout.error}。已隐藏依赖连线，请在任务详情中修正。</p>}
      {!project.tasks.length ? <div className="flex min-h-[300px] flex-1 items-center justify-center p-6 text-sm text-text-secondary">暂无任务，工作流待确认。</div> : (
        <div ref={scroller} tabIndex={0} role="region" aria-label="可滚动工作流画布" aria-describedby={helpId} className="relative min-h-[220px] flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan" style={{ backgroundImage: 'radial-gradient(#2a3349 1px, transparent 1px)', backgroundSize: '24px 24px' }}>
          <div className="relative" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
            <div className="absolute left-0 top-0 origin-top-left" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
              <svg aria-hidden="true" className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height}>
                <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="currentColor" className="text-accent-cyan/60" /></marker></defs>
                {visibleEdges.map(edge => <path key={`${edge.from}:${edge.to}`} d={edge.path} fill="none" stroke="currentColor" strokeWidth={edge.from === selectedTaskId || edge.to === selectedTaskId ? 2.5 : 1.5} className={edge.from === selectedTaskId || edge.to === selectedTaskId ? 'text-accent-cyan' : 'text-accent-cyan/35'} markerEnd={`url(#${markerId})`} />)}
              </svg>
              {visibleNodes.map(node => {
                const task = tasksById.get(node.taskId)!;
                const Icon = STATUS_ICON[task.status];
                return (
                  <button key={node.taskId} type="button" ref={element => { if (element) nodeButtons.current.set(node.taskId, element); else nodeButtons.current.delete(node.taskId); }} onFocus={() => setFocusedTaskId(task.id)} onBlur={() => setFocusedTaskId(null)} onClick={() => onSelectTask(task.id)} aria-pressed={selectedTaskId === task.id} aria-label={`${task.name || '未命名任务'}，${TASK_LABELS[task.status]}，输入：${summarize(task.inputs)}，输出：${summarize(task.outputs)}`} className={`absolute flex flex-col overflow-hidden rounded-xl border bg-bg-light p-4 text-left shadow-lg transition-colors hover:bg-bg-lighter focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan ${STATUS_STYLE[task.status]} ${selectedTaskId === task.id ? 'ring-2 ring-accent-cyan ring-offset-2 ring-offset-bg-deep' : ''}`} style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}>
                    <span className="mb-2 flex w-full items-center justify-between gap-2 text-[11px]"><span className="flex items-center gap-1.5"><Icon size={14} aria-hidden="true" />{TASK_LABELS[task.status]}</span><span className="text-text-muted">前置 {task.dependsOn.length}</span></span>
                    <span className="line-clamp-1 w-full text-sm font-medium text-text-primary" title={task.name}>{task.name || '未命名任务'}</span>
                    <span className="mt-1 line-clamp-2 min-h-[32px] w-full text-[11px] leading-4 text-text-secondary" title={task.description}>{task.description.trim() || '任务说明待确认'}</span>
                    <span className="mt-2 block w-full border-t border-border-light pt-2 text-[11px] text-text-secondary"><span className="block truncate" title={summarize(task.inputs)}>输入 · {summarize(task.inputs)}</span><span className="mt-1 block truncate" title={summarize(task.outputs)}>输出 · {summarize(task.outputs)}</span></span>
                    <span className="mt-auto block w-full truncate pt-1 text-[10px] text-text-secondary" title={task.dependencyNote}>{task.dependencyNote.trim() || (task.dependsOn.length ? '依赖说明待确认' : '依赖关系待确认，不推定为无依赖')}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
