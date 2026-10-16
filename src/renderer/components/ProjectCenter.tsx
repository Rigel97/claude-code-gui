import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, FolderKanban, Loader2, ScanSearch, Search, X, AlertTriangle, RefreshCw, Pencil } from 'lucide-react';
import { useStore } from '../store';
import { useProjectsStore } from '../projectStore';
import { PROJECT_LABELS, projectCounts, projectSummary, TASK_LABELS } from '../projectModel';
import type { ProjectSource, ProjectStatus, RecognitionMode } from '../projectTypes';
import { ProjectDetail } from './ProjectDetail';
import { FilePreview } from './FilePreview';

const button = 'inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-xs text-text-secondary hover:bg-bg-light hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const input = 'w-full rounded-lg border border-border bg-bg-deepest px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-cyan/50';
const PAGE_SIZE = 24;

export function ProjectCenter() {
  const { projects, loading, loaded, operation, error, notice, scanResult, selectedProjectId,
    recognitionMode, scanPlan, scanProgress, cancelling, setRecognitionMode, prepare, cancelScan,
    load, scan, clearError, selectProject, showChat } = useProjectsStore();
  const [filter, setFilter] = useState<ProjectStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [source, setSource] = useState<ProjectSource | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (operation !== 'scan' && operation !== 'prepare') { setElapsed(0); return; }
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [operation]);
  useEffect(() => { if (!useProjectsStore.getState().loaded) void load(); }, [load]);
  useEffect(() => { setPage(0); }, [filter, search]);

  const counts = useMemo(() => projectCounts(projects), [projects]);
  const filtered = useMemo(() => projects.filter(project => {
    if (filter !== 'all' && projectSummary(project).status !== filter) return false;
    return `${project.name}\n${project.goal}\n${project.description}`.toLowerCase().includes(search.toLowerCase());
  }).sort((a, b) => b.updatedAt - a.updatedAt), [projects, filter, search]);
  const safePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const selected = projects.find(project => project.id === selectedProjectId);
  const busy = loading || operation !== null;

  const recognize = () => {
    const state = useStore.getState();
    if (recognitionMode === 'llm') void prepare(state.sessions, state.conversations);
    else void scan(state.sessions, state.conversations, { mode: 'rules' });
  };
  const reveal = async (path: string) => {
    setLocalError(null);
    try {
      const result = await (window as unknown as { api: { projects: { reveal: (path: string) => Promise<{ ok: boolean; error?: string }> } } }).api.projects.reveal(path);
      if (!result.ok) setLocalError(result.error || '文件不可访问。');
    } catch (failure) { setLocalError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const openSource = (item: ProjectSource) => {
    setLocalError(null);
    const state = useStore.getState();
    const session = state.sessions.find(session => session.sessionId === item.sessionId);
    const conversation = state.conversations.find(conversation => conversation.sessionId === item.sessionId || `gui:${conversation.id}` === item.sessionId);
    if (session || conversation) {
      if (conversation) state.setActiveConversation(conversation.id);
      else state.openSessionTab(item.sessionId);
      state.setCwd(conversation?.cwd || session?.cwd || item.cwd);
      // CLI UUIDs are different from GUI message ids; never highlight a non-existent message.
      const active = useStore.getState().conversations.find(conversation => conversation.id === useStore.getState().activeConversationId);
      if (item.messageId && active?.messages.some(message => message.id === item.messageId)) state.setHighlightMessage(item.messageId);
      showChat();
    } else {
      // CLI-only sessions are not fabricated into GUI conversations: inspect retained source evidence.
      setSource(item);
    }
  };

  return (
    <main className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden bg-bg-deepest/80" aria-label="项目管理中心">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-6 py-3 border-b border-border/60 bg-bg-deep/70">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl border border-accent-cyan/30 bg-accent-cyan/10 flex items-center justify-center shrink-0"><FolderKanban className="w-5 h-5 text-accent-cyan" /></div>
          <div className="min-w-0"><h1 className="text-lg font-semibold text-text-primary">项目管理中心</h1><p className="text-xs text-text-secondary mt-1">从真实历史整理长期工作 · 审核后创建 · 任务与工作流同步</p></div>
        </div>
        <div className="flex gap-2 items-center">
          <button className={button} onClick={showChat}><ArrowLeft className="w-3.5 h-3.5" />返回对话</button>
          <select aria-label="项目识别方式" value={recognitionMode} onChange={event => setRecognitionMode(event.target.value as RecognitionMode)} disabled={busy || !!scanResult || !!scanPlan} className={`${button} bg-bg-deepest`}>
            <option value="llm">LLM 语义识别</option><option value="rules">本地规则（不上传）</option>
          </select>
          <button className={`${button} border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20`} onClick={recognize} disabled={busy || !loaded || !!scanResult || !!scanPlan}>
            {operation === 'scan' || operation === 'prepare' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4" />}{operation === 'prepare' ? '准备历史…' : operation === 'scan' ? '识别中…' : '识别项目'}
          </button>
        </div>
      </header>
      {(error || localError) && <div role="alert" className="mx-6 mt-3 px-3 py-2 rounded-lg border border-accent-red/30 bg-accent-red/10 text-xs text-accent-red flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0" /><span className="flex-1 break-words selectable-text">{localError || error}</span><button onClick={() => { clearError(); setLocalError(null); }} aria-label="关闭错误"><X className="w-4 h-4" /></button>
      </div>}
      {notice && <div role="status" className="mx-6 mt-3 px-3 py-2 rounded-lg border border-accent-green/20 bg-accent-green/5 text-xs text-accent-green flex gap-2"><Check className="w-4 h-4" />{notice}</div>}
      {(operation === 'scan' || operation === 'prepare') && <div role="status" className="shrink-0 mx-6 mt-3 p-3 rounded-lg border border-accent-cyan/20 bg-accent-cyan/5 flex gap-3 items-center text-xs text-text-secondary">
        <Loader2 className="w-4 h-4 animate-spin text-accent-cyan shrink-0" /><div className="flex-1 min-w-0"><p>{operation === 'prepare' ? '只读准备历史范围，尚未发送给模型…' : cancelling ? '正在取消，未保存候选…' : scanProgress?.message || '正在识别历史，等待模型响应…'}</p>{operation === 'scan' && <p className="mt-1 font-mono">已等待 {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}{scanProgress ? ` · 批次 ${scanProgress.completed}/${scanProgress.total}` : ''}{typeof scanProgress?.costUsd === 'number' ? ` · 已报告费用 $${scanProgress.costUsd.toFixed(4)}` : ''}</p>}</div>
        {operation === 'scan' && recognitionMode === 'llm' && <button className={button} onClick={() => void cancelScan()} disabled={cancelling}>取消识别</button>}
      </div>}
      {loading ? <div className="flex-1 flex items-center justify-center gap-2 text-sm text-text-secondary"><Loader2 className="w-5 h-5 animate-spin text-accent-cyan" />恢复项目数据…</div>
        : !loaded ? <div className="flex-1 flex flex-col items-center justify-center gap-4 text-sm text-text-secondary"><p>项目数据尚未加载。请检查上方错误并重试，不会覆盖已有文件。</p><button className={button} onClick={() => void load()}><RefreshCw className="w-4 h-4" />重新加载</button></div>
        : selected ? <ProjectDetail key={selected.id} project={selected} onBack={() => selectProject(null)} onSource={openSource} onPreview={setPreview} onReveal={reveal} />
        : <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3" role="group" aria-label="项目状态筛选">
            {(['all', 'not_started', 'in_progress', 'completed'] as const).map(status => (
              <button key={status} aria-pressed={filter === status} onClick={() => setFilter(status)} className={`text-left px-4 py-3 rounded-xl border transition-colors ${filter === status ? 'bg-accent-cyan/10 border-accent-cyan/40' : 'bg-bg-light/40 border-border hover:border-border-light'}`}>
                <div className="text-xs text-text-secondary">{status === 'all' ? '全部项目' : PROJECT_LABELS[status]}</div><div className={`text-2xl font-mono mt-2 ${filter === status ? 'text-accent-cyan' : 'text-text-primary'}`}>{counts[status]}</div>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-md"><Search className="absolute left-3 top-2.5 w-4 h-4 text-text-muted" /><input aria-label="搜索项目" placeholder="搜索名称、目标或简述" value={search} onChange={event => setSearch(event.target.value)} className={`${input} pl-9`} /></div>
            <span className="text-xs text-text-secondary">{filtered.length} 个项目</span>
          </div>
          {filtered.length === 0 ? <section className="py-16 px-6 rounded-xl border border-dashed border-border text-center">
            <FolderKanban className="w-10 h-10 text-accent-cyan/60 mx-auto mb-4" /><h2 className="text-base text-text-primary mb-2">{projects.length ? '没有匹配的项目' : '把零散工作整理成可追踪的项目'}</h2><p className="text-sm text-text-secondary max-w-xl mx-auto leading-6">{projects.length ? '调整状态筛选或搜索关键词。' : '点击「识别项目」读取本应用会话及可访问的 Claude Code 本地历史。仅将明确目标与多步骤工作列为候选，所有结果都需你审核；短问答不会默认创建项目。'}</p>
            {!projects.length && <button className={`${button} mt-5 text-accent-cyan border-accent-cyan/30`} onClick={recognize} disabled={busy || !!scanResult || !!scanPlan}><ScanSearch className="w-4 h-4" />开始识别</button>}
          </section> : <div className="space-y-3">
            {filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).map(project => {
              const summary = projectSummary(project);
              return <button key={project.id} onClick={() => selectProject(project.id)} className="w-full text-left glass-panel glass-panel-hover rounded-xl p-5 transition-colors group">
                <div className="flex items-start justify-between gap-4"><h2 className="text-base font-medium text-text-primary group-hover:text-accent-cyan break-words">{project.name}</h2><span className={`shrink-0 text-xs rounded-md px-2 py-1 ${summary.status === 'completed' ? 'bg-accent-green/10 text-accent-green' : summary.status === 'in_progress' ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-bg-lighter text-text-secondary'}`}>{PROJECT_LABELS[summary.status]}</span></div>
                <p className="text-sm text-text-secondary mt-2 line-clamp-2 leading-6">{project.description || project.goal}</p>
                <div className="flex items-center gap-4 mt-4"><div className="h-1.5 rounded-full bg-bg-lighter flex-1 overflow-hidden"><div className="h-full rounded-full bg-accent-cyan" style={{ width: `${summary.progress}%` }} /></div><span className="text-xs font-mono text-text-secondary">{summary.counts.completed}/{summary.total} · {summary.progress}%</span></div>
                <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-[11px] text-text-secondary"><span>{project.sources.length} 条来源 · {project.files.length} 个文件{summary.allTasksComplete && !project.goalConfirmed ? ' · 等待目标验收' : ''}</span><span>更新于 {new Date(project.updatedAt).toLocaleDateString()}</span></div>
              </button>;
            })}
            <Pagination page={safePage} total={filtered.length} size={PAGE_SIZE} onChange={setPage} />
          </div>}
          <p className="text-xs text-text-secondary leading-6">{recognitionMode === 'llm' ? 'LLM 会语义整理历史中的长期目标、跨会话关联与时间连续性。发送前会确认范围及总预算；模型解释仍需审核，本地核查来源与执行事实。' : '本地规则识别，不调用模型或上传历史。'} 缺失的背景、输入输出与依赖均保留待确认；“任务完成”与“项目目标已验收”分别记录。</p>
        </div>}
      {scanPlan && <LLMConsent />}
      {scanResult && <CandidateReview onSource={setSource} />}
      {preview && <FilePreview path={preview} onClose={() => setPreview(null)} />}
      {source && <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6" onClick={() => setSource(null)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSource(null); } }}><section role="dialog" aria-modal="true" aria-label="历史来源详情" className="glass-panel rounded-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto p-5" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between mb-4"><h2 className="text-base text-text-primary">历史来源详情</h2><button autoFocus aria-label="关闭来源详情" onClick={() => setSource(null)}><X className="w-5 h-5 text-text-secondary" /></button></div>
        <p className="text-sm text-text-secondary mb-3">{source.title || source.sessionId}</p><pre className="whitespace-pre-wrap break-words text-xs text-text-primary selectable-text bg-bg-deepest p-4 rounded-lg leading-6">{source.excerpt || '该消息没有文本摘要。'}</pre>
        <p className="text-xs text-text-secondary mt-4">此处展示保存的真实来源摘录（最多 1000 字），不伪造可恢复的对话；若记录文件仍存在，可查看完整内容。</p>
        {localError && <p role="alert" className="text-xs text-accent-red mt-3 break-words">{localError}</p>}
        {source.path && <div className="mt-3"><p className="font-mono text-xs text-text-secondary break-all selectable-text">{source.path}</p><div className="flex gap-2 mt-2"><button className={button} onClick={() => { setPreview(source.path!); setSource(null); }}>预览原始记录</button><button className={button} onClick={() => void reveal(source.path!)}>定位记录文件</button></div></div>}
      </section></div>}
    </main>
  );
}

function LLMConsent() {
  const { scanPlan, operation, error, scan, discardPlan } = useProjectsStore();
  const configuredModel = useStore(state => state.model);
  const configuredBudget = useStore(state => state.maxBudgetUsd);
  const [model, setModel] = useState(configuredModel);
  const [budget, setBudget] = useState(String(configuredBudget > 0 ? Math.min(configuredBudget, 100) : 2));
  const [consent, setConsent] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (useStore.getState().searchOpen) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); discardPlan(); }
      if (event.key === 'Tab' && dialog.current) {
        const elements = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary')].filter(element => element.getClientRects().length > 0);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', keyboard, true);
    return () => { window.removeEventListener('keydown', keyboard, true); previousFocus?.focus(); };
  }, [discardPlan]);
  if (!scanPlan) return null;
  const amount = Number(budget);
  const validBudget = Number.isFinite(amount) && amount > 0 && amount <= 100;
  const busy = operation !== null;
  return <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="llm-consent-title" className="flex flex-col w-full max-w-2xl max-h-[90vh] rounded-xl bg-bg-deep border border-border-light overflow-hidden shadow-2xl">
      <header className="flex items-start justify-between gap-4 p-5 border-b border-border"><div><h2 id="llm-consent-title" className="text-lg text-text-primary">确认 LLM 识别范围与费用</h2><p className="text-xs text-text-secondary mt-2">本次仅准备了本地快照，尚未发送模型。</p></div><button className={button} aria-label="取消模型发送" disabled={busy} onClick={discardPlan}><X className="w-4 h-4" /></button></header>
      <div className="overflow-y-auto p-5 space-y-4">
        {error && <p role="alert" className="text-xs text-accent-red break-words">{error}</p>}
        <div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-bg-light p-3"><span className="text-text-secondary text-xs">会话 / 摘录段</span><p className="font-mono text-accent-cyan mt-1">{scanPlan.sessions} / {scanPlan.messages}</p></div><div className="rounded-lg bg-bg-light p-3"><span className="text-text-secondary text-xs">数据字符 / 最多调用</span><p className="font-mono text-accent-cyan mt-1">{scanPlan.inputChars.toLocaleString()} / {scanPlan.maxCalls}</p></div></div>
        <p className="text-xs text-text-secondary leading-6">将发送用户与助手对话摘录、工作目录、时间、任务与文件工具的受限摘要，以及已有项目简述。不会发送思考块、图片二进制、完整工具输出或文件正文；但对话文本本身可能包含敏感信息，请确认有权发送。</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label className="text-xs text-text-secondary">模型（沿用当前配置）<input aria-label="项目识别模型" className={`${input} mt-1`} value={model} maxLength={200} disabled={busy} onChange={event => setModel(event.target.value)} placeholder="留空使用 Claude Code 默认模型" /></label><label className="text-xs text-text-secondary">本次总预算上限（美元）<input aria-label="项目识别总预算" type="number" className={`${input} mt-1`} value={budget} min="0.01" max="100" step="0.01" disabled={busy} onChange={event => setBudget(event.target.value)} /></label></div>
        <p className="text-xs text-accent-orange leading-6">通过 Claude Code 已配置的认证与模型服务调用，不是纯本地计算。预算为本次多批调用共享上限，不是费用报价；取消、超时或调用失败也可能已经产生费用。单次模型调用最长等待 5 分钟，失败不会悄悄改用规则结果。</p>
        <details className="rounded-lg border border-border p-3 text-xs text-text-secondary"><summary className="cursor-pointer">查看发送摘录样例（{scanPlan.sampleSources.length} 条）</summary><div className="mt-3 space-y-3 selectable-text">{scanPlan.sampleSources.map(source => <div className="border-t border-border pt-2" key={source.id}><p className="text-accent-cyan">{source.title || source.sessionId}</p><p className="font-mono text-[11px] break-all mt-1">{source.cwd || '目录未知'}</p><pre className="whitespace-pre-wrap break-words text-xs leading-5 mt-2">{source.excerpt || '工具摘要，无正文'}</pre></div>)}</div></details>
        <details className="text-xs text-text-secondary"><summary className="cursor-pointer">覆盖范围与截取说明</summary><div className="space-y-2 mt-2">{scanPlan.coverage.warnings.map((warning, index) => <p className="leading-5 break-words" key={index}>{warning}</p>)}</div></details>
        {!scanPlan.messages && <p className="text-xs text-accent-orange">没有可分析的历史摘录。请取消并检查数据源权限。</p>}
        <label className="flex items-start gap-2 text-xs text-text-primary leading-6"><input className="accent-accent-cyan mt-1.5" type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />我确认可以将上述历史摘录发送给当前模型服务，并同意本次调用可能产生费用。</label>
      </div>
      <footer className="border-t border-border p-4 flex items-center justify-between gap-3"><span className="text-xs text-text-secondary">快照有效期至 {new Date(scanPlan.expiresAt).toLocaleTimeString()}</span><div className="flex gap-2"><button className={button} disabled={busy} onClick={discardPlan}>取消，不发送</button><button className={`${button} text-accent-cyan border-accent-cyan/40 bg-accent-cyan/10`} disabled={busy || !consent || !validBudget || !scanPlan.messages} onClick={() => void scan([], [], { mode: 'llm', planId: scanPlan.planId, consent: true, model: model.trim(), maxBudgetUsd: amount })}>同意并开始 LLM 识别</button></div></footer>
    </section>
  </div>;
}

function CandidateReview({ onSource }: { onSource: (source: ProjectSource) => void }) {
  const { scanResult, reviews, operation, projects, error, clearError, review, associate, cancelReview, confirm } = useProjectsStore();
  const dialog = useRef<HTMLElement>(null);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => { setPage(0); setDetail(null); setEditing(null); }, [scanResult?.scanId]);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const escape = (event: KeyboardEvent) => {
      // Nested source and file dialogs handle their own keyboard events.
      if (useStore.getState().searchOpen || document.querySelector('[data-search-panel], [aria-label="历史来源详情"], [data-file-preview]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelReview(); }
      if (event.key === 'Tab' && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')].filter(element => element.getClientRects().length > 0);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('keydown', escape, true); previousFocus?.focus(); };
  }, [cancelReview]);
  if (!scanResult) return null;
  const busy = operation === 'confirm';
  const selected = Object.values(reviews).filter(review => review.selected).length;
  return <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="review-title" className="flex flex-col w-full max-w-4xl max-h-[90vh] rounded-xl bg-bg-deep border border-border-light shadow-2xl overflow-hidden">
      <header className="flex items-center justify-between gap-4 px-5 py-4 border-b border-border">
        <div className="min-w-0">
          <h2 id="review-title" className="text-lg text-text-primary">审核识别结果</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span>{scanResult.candidates.length} 个候选</span>
            {scanResult.analysis?.mode === 'llm'
              ? <span className="inline-flex items-center rounded-md px-1.5 py-0.5 bg-accent-cyan/10 text-accent-cyan">LLM 识别 · {scanResult.analysis.model || '默认模型'} · ${Number(scanResult.analysis.costUsd || 0).toFixed(4)}</span>
              : <span className="inline-flex items-center rounded-md px-1.5 py-0.5 bg-bg-lighter/70 text-text-secondary">本地规则 · 未上传</span>}
          </div>
        </div>
        <button className={button} onClick={cancelReview} disabled={busy} aria-label="取消审核"><X className="w-4 h-4" /></button>
      </header>
      {error && <div role="alert" className="mx-5 mt-3 p-3 rounded-lg border border-accent-red/30 bg-accent-red/10 text-xs text-accent-red flex gap-2"><span className="flex-1 break-words">{error}</span><button aria-label="关闭审核错误" onClick={clearError}><X className="w-4 h-4" /></button></div>}
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
        <p className="text-xs text-text-dim leading-5">勾选要保存的项目；点 ✎ 修改名称与目标，点击卡片也可勾选。默认关联已有项目，未确认前不会写入。</p>
        {!scanResult.candidates.length && <div className="py-12 text-center text-sm text-text-secondary leading-6">未发现值得长期跟踪的项目。<br />短问答与小改动不会成为项目；数据范围与限制见底部说明。</div>}
        {scanResult.candidates.slice(page * 10, (page + 1) * 10).map(candidate => {
          const current = reviews[candidate.id];
          if (!current) return null;
          const sessions = new Set(candidate.sources.map(source => source.sessionId)).size;
          const dependencies = candidate.tasks.reduce((total, task) => total + task.dependsOn.length, 0);
          const linked = current.existingProjectId ? projects.find(project => project.id === current.existingProjectId) : undefined;
          const chip = 'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] leading-4';
          return <article key={candidate.id} className={`rounded-xl border overflow-hidden transition-colors ${current.selected ? 'border-accent-cyan/40 bg-accent-cyan/[0.04]' : 'border-border bg-bg-light/30'}`}>
            <div className="p-4 flex items-start gap-3">
              <input type="checkbox" className="mt-1 accent-accent-cyan shrink-0" checked={current.selected} disabled={busy} onChange={event => review(candidate.id, { selected: event.target.checked })} aria-label={`选择项目 ${current.name}`} />
              <div className="flex-1 min-w-0">
                {editing === candidate.id ? (
                  <div className="space-y-2">
                    <input aria-label={`项目名称 ${current.name}`} className={input} value={current.name} maxLength={500} disabled={busy} onChange={event => review(candidate.id, { name: event.target.value })} placeholder="项目名称" />
                    <textarea aria-label={`项目目标 ${current.name}`} className={`${input} resize-y`} value={current.goal} rows={2} maxLength={20000} disabled={busy} onChange={event => review(candidate.id, { goal: event.target.value })} placeholder="目标（必填）" />
                    <textarea aria-label={`项目简述 ${current.name}`} className={`${input} resize-y`} value={current.description} rows={2} maxLength={20000} disabled={busy} onChange={event => review(candidate.id, { description: event.target.value })} placeholder="简述（可选，确认后可再补）" />
                    <button className={button} onClick={() => setEditing(null)}>完成编辑</button>
                  </div>
                ) : (
                  <div className="cursor-pointer group" onClick={() => { if (!busy) review(candidate.id, { selected: !current.selected }); }}>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-medium text-text-primary break-words leading-6 group-hover:text-accent-cyan transition-colors">{current.name}</h3>
                      <button className="text-text-dim hover:text-accent-cyan shrink-0" aria-label={`编辑 ${current.name}`} disabled={busy} onClick={event => { event.stopPropagation(); setEditing(candidate.id); }}><Pencil className="w-3.5 h-3.5" /></button>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary leading-5 line-clamp-2 break-words">{current.goal}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <span className={`${chip} bg-bg-lighter/70 text-text-secondary`}>{candidate.tasks.length} 任务</span>
                      <span className={`${chip} bg-bg-lighter/70 text-text-secondary`}>{sessions} 会话</span>
                      {dependencies > 0 && <span className={`${chip} bg-bg-lighter/70 text-text-secondary`}>{dependencies} 依赖</span>}
                      {linked ? <span className={`${chip} bg-accent-cyan/10 text-accent-cyan`}>关联：{linked.name}</span> : <span className={`${chip} bg-bg-lighter/70 text-text-secondary`}>新项目</span>}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="px-4 pb-3 flex items-center justify-between gap-2 flex-wrap">
              <select aria-label={`创建方式 ${current.name}`} className="rounded-lg bg-bg-deepest border border-border px-2 py-1.5 text-xs text-text-secondary max-w-[220px]" value={current.existingProjectId || ''} disabled={busy} onChange={event => associate(candidate.id, event.target.value)}>
                <option value="">创建为新项目</option>
                {projects.map(project => <option key={project.id} value={project.id}>关联已有：{project.name}</option>)}
              </select>
              <button className="text-xs text-text-secondary hover:text-accent-cyan transition-colors" onClick={() => setDetail(detail === candidate.id ? null : candidate.id)} aria-expanded={detail === candidate.id}>{detail === candidate.id ? '收起详情' : `详情 · ${candidate.tasks.length} 任务`}</button>
            </div>
            {candidate.existingProjectId && !current.existingProjectId && <label className="px-4 pb-3 flex gap-2 items-start text-[11px] text-accent-orange leading-5"><input className="accent-accent-orange mt-1" type="checkbox" checked={!!current.allowDuplicate} disabled={busy} onChange={event => review(candidate.id, { allowDuplicate: event.target.checked })} />另建为独立项目（与相同历史目标重复时需勾选确认）</label>}
            {detail === candidate.id && <div className="border-t border-border/60 bg-bg-deepest/40 px-4 py-3 space-y-3 text-xs">
              <section>
                <h4 className="text-text-primary font-medium mb-1">任务（{candidate.tasks.length}）</h4>
                {candidate.tasks.slice(0, 6).map(task => <div key={task.id} className="flex items-center justify-between gap-3 py-0.5"><span className="truncate text-text-secondary">{task.name}</span><span className="shrink-0 text-text-dim">{TASK_LABELS[task.status]}{task.dependsOn.length ? ` · ${task.dependsOn.length} 依赖` : ''}</span></div>)}
                {candidate.tasks.length > 6 && <p className="text-text-dim mt-1">确认后在项目详情查看全部 {candidate.tasks.length} 个任务。</p>}
              </section>
              {candidate.evidence.length > 0 && <section><h4 className="text-text-primary font-medium mb-1">识别依据（{candidate.evidence.length}）</h4>{candidate.evidence.slice(0, 2).map((evidence, index) => <p key={index} className="text-text-secondary leading-5 break-words line-clamp-2 selectable-text">{evidence}</p>)}</section>}
              {candidate.uncertainties.length > 0 && <section><h4 className="text-accent-orange/90 font-medium mb-1">待确认（{candidate.uncertainties.length}）</h4>{candidate.uncertainties.slice(0, 2).map((uncertainty, index) => <p key={index} className="text-text-secondary leading-5 break-words line-clamp-2">{uncertainty}</p>)}</section>}
              {candidate.sources.length > 0 && <section><h4 className="text-text-primary font-medium mb-1">来源（{candidate.sources.length}）</h4><div className="flex flex-wrap gap-1.5">{candidate.sources.slice(0, 4).map(item => <button key={item.id} className={`${chip} border border-border hover:border-accent-cyan/40 text-text-secondary transition-colors`} onClick={() => onSource(item)} title={item.excerpt.slice(0, 120)}>{item.kind === 'gui' ? 'GUI' : 'Claude Code'} · {item.title || item.sessionId}</button>)}</div></section>}
            </div>}
          </article>;
        })}
        <Pagination page={page} total={scanResult.candidates.length} size={10} onChange={setPage} />
        {scanResult.coverage.warnings.length > 0 && <details className="text-xs text-text-dim"><summary className="cursor-pointer">覆盖范围与限制（{scanResult.coverage.warnings.length}）</summary><div className="mt-2 space-y-1.5 selectable-text"><p className="break-all">{scanResult.coverage.roots.join('\n')}</p>{scanResult.coverage.warnings.map((warning, index) => <p key={index} className="leading-5 break-words">{warning}</p>)}</div></details>}
      </div>
      <footer className="flex justify-between items-center gap-3 px-5 py-4 border-t border-border bg-bg-deepest/50"><span className="text-xs text-text-secondary">已选 {selected} 个 · 未确认不保存</span><div className="flex gap-2"><button className={button} onClick={cancelReview} disabled={busy}>取消，不创建</button><button className={`${button} bg-accent-cyan/10 border-accent-cyan/40 text-accent-cyan`} onClick={() => void confirm()} disabled={busy || !selected}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}确认创建 / 关联</button></div></footer>
    </section>
  </div>;
}

export function Pagination({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (page: number) => void }) {
  const pages = Math.ceil(total / size);
  if (pages <= 1) return null;
  return <nav aria-label="分页" className="flex items-center justify-center gap-3 py-2"><button className={button} onClick={() => onChange(page - 1)} disabled={page <= 0}>上一页</button><span className="text-xs font-mono text-text-secondary">{page + 1} / {pages}</span><button className={button} onClick={() => onChange(page + 1)} disabled={page + 1 >= pages}>下一页</button></nav>;
}
