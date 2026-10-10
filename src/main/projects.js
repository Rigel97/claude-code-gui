const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { scanProjects, DEFAULT_LIMITS, identity, normalize, acyclic, sameGoal, similarGoal, projectScope } = require('./projects-scan');
const { prepareAnalysis, analyzeProjects } = require('./projects-llm');
const { analyzeWithClaude } = require('./projects-analyzer');

const PROJECT_FIELDS = ['id', 'identityKey', 'name', 'description', 'goal', 'background', 'constraints', 'decisions', 'deliverables', 'goalConfirmed', 'tasks', 'files', 'sources', 'uncertainties', 'createdAt', 'updatedAt'];
const EDITABLE_TASK_FIELDS = ['status', 'name', 'description', 'inputs', 'outputs', 'dependsOn', 'dependencyNote'];
const TASK_FIELDS = ['id', 'name', 'description', 'status', 'inputs', 'outputs', 'dependsOn', 'dependencyNote', 'sourceIds', 'records', 'editedFields'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const clone = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是对象`);
};
const fields = (value, allowed, label) => {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} 含不支持字段`);
};
const string = (value, label, required = false) => {
  if (typeof value !== 'string' || value.length > 200000 || value.includes('\0') || (required && !value.trim())) fail(`${label} 必须是${required ? '非空' : ''}字符串且长度不超过 200000`);
};
const strings = (value, label) => {
  if (!Array.isArray(value) || value.length > 50000) fail(`${label} 必须是有限字符串数组`);
  for (const item of value) string(item, label);
};
const absolute = (value, label) => {
  string(value, label, true);
  if (!path.isAbsolute(value)) fail(`${label} 必须是绝对路径`);
};
function validateProject(project) {
  fields(project, PROJECT_FIELDS, '项目');
  for (const key of ['id', 'identityKey', 'name', 'goal']) string(project[key], key, true);
  for (const key of ['description', 'background', 'constraints', 'decisions', 'deliverables']) string(project[key], key);
  for (const key of ['createdAt', 'updatedAt']) if (!Number.isFinite(project[key]) || project[key] < 0) fail(`${key} 必须是有效时间戳`);
  if (typeof project.goalConfirmed !== 'boolean') fail('goalConfirmed 必须是布尔值');
  strings(project.uncertainties, 'uncertainties');
  for (const key of ['tasks', 'files', 'sources']) if (!Array.isArray(project[key]) || project[key].length > 50000) fail(`${key} 必须是有限数组`);
  const sourceIds = new Set();
  for (const source of project.sources) {
    fields(source, ['id', 'kind', 'sessionId', 'title', 'cwd', 'path', 'messageId', 'excerpt'], 'source');
    for (const key of ['id', 'sessionId']) string(source[key], `source.${key}`, true);
    for (const key of ['title', 'cwd', 'excerpt']) string(source[key], `source.${key}`);
    if (!['gui', 'claude'].includes(source.kind)) fail('source.kind 无效');
    if (source.path !== undefined) absolute(source.path, 'source.path');
    if (source.messageId !== undefined) string(source.messageId, 'source.messageId');
    if (sourceIds.has(source.id)) fail('source.id 重复');
    sourceIds.add(source.id);
  }
  const taskIds = new Set();
  for (const task of project.tasks) {
    fields(task, TASK_FIELDS, '任务');
    for (const key of ['id', 'name']) string(task[key], `任务.${key}`, true);
    for (const key of ['description', 'dependencyNote']) string(task[key], `任务.${key}`);
    if (!['pending', 'in_progress', 'completed'].includes(task.status)) fail('任务 status 无效');
    for (const key of ['inputs', 'outputs', 'dependsOn', 'sourceIds', 'records']) strings(task[key], `任务.${key}`);
    if (task.editedFields !== undefined) {
      strings(task.editedFields, '任务.editedFields');
      if (task.editedFields.some(field => !EDITABLE_TASK_FIELDS.includes(field)) || new Set(task.editedFields).size !== task.editedFields.length) fail('任务 editedFields 含不支持或重复字段');
    }
    if (taskIds.has(task.id)) fail('任务 id 重复');
    if (new Set(task.dependsOn).size !== task.dependsOn.length) fail('任务依赖引用重复');
    taskIds.add(task.id);
    if (task.sourceIds.some(id => !sourceIds.has(id))) fail('任务 sourceIds 引用不存在');
  }
  for (const task of project.tasks) {
    if (task.dependsOn.includes(task.id)) fail('任务依赖不能自环');
    if (task.dependsOn.some(id => !taskIds.has(id))) fail('任务依赖引用不存在');
  }
  if (!acyclic(project.tasks)) fail('任务依赖存在循环');
  if (project.goalConfirmed && (!project.tasks.length || project.tasks.some(t => t.status !== 'completed'))) fail('goalConfirmed 只允许所有必要任务 completed 后确认');
  for (const file of project.files) {
    fields(file, ['path', 'purpose', 'sourceId'], '文件');
    absolute(file.path, '文件.path'); string(file.purpose, '文件.purpose');
    if (!sourceIds.has(file.sourceId)) fail('文件 sourceId 引用不存在');
  }
  return project;
}
function validateStore(value) {
  fields(value, ['version', 'projects'], '项目存储');
  if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 10000) fail('项目存储版本或结构不受支持');
  const ids = new Set();
  for (const project of value.projects) {
    validateProject(project);
    if (ids.has(project.id)) fail('项目存储 id 重复');
    ids.add(project.id);
  }
}
function mergeEvidence(existing, candidate, scannedTasks = new Set()) {
  const result = clone(existing);
  const sourceMap = new Map(result.sources.map(s => [s.id, s]));
  for (const source of candidate.sources) sourceMap.set(source.id, source);
  result.sources = [...sourceMap.values()];
  const files = new Map(result.files.map(f => [`${f.path}:${f.sourceId}`, f]));
  candidate.files.forEach(f => files.set(`${f.path}:${f.sourceId}`, clone(f)));
  result.files = [...files.values()];
  result.uncertainties = [...new Set([...result.uncertainties, ...candidate.uncertainties])];
  for (const field of ['background', 'constraints', 'decisions', 'deliverables']) {
    if (!candidate[field].trim()) continue;
    if (!result[field].trim()) result[field] = candidate[field];
    else if (result[field] !== candidate[field]) {
      const sourceIds = candidate.sources.filter(source => source.kind === 'gui' || source.kind === 'claude').map(source => source.id);
      result.uncertainties.push(`${field} 新扫描提供不同/补充原文，关联 unknown，需确认；保留已有非空内容，不自动覆盖。新原文：${candidate[field]}（sources ${sourceIds.join(', ')}）`);
    }
  }
  const mapping = new Map(), pairs = [], claimed = new Set();
  for (const task of candidate.tasks) {
    // Structured task ids are meaningful; only an unambiguous non-structured name can be mapped.
    const byName = result.tasks.filter(t => normalize(t.name) === normalize(task.name));
    const old = result.tasks.find(t => t.id === task.id) || (!task.id.startsWith('task:claude:') && byName.length === 1 &&
      (!task.id.startsWith('task:llm:') || byName[0].sourceIds.some(id => task.sourceIds.includes(id))) ? byName[0] : undefined);
    if (!old && scannedTasks.has(task.id)) continue;
    if (old && claimed.has(old.id)) {
      result.uncertainties.push(`任务「${task.name}」扫描映射冲突 unknown，未覆盖该任务。`);
      continue;
    }
    const target = old || { ...clone(task), dependsOn: [], editedFields: [] };
    if (!old) result.tasks.push(target);
    claimed.add(target.id);
    mapping.set(task.id, target.id);
    pairs.push({ task, target });
    target.sourceIds = [...new Set([...target.sourceIds, ...task.sourceIds])];
    target.records = [...new Set([...target.records, ...task.records])];
    for (const field of EDITABLE_TASK_FIELDS.filter(field => field !== 'dependsOn')) {
      if (!target.editedFields?.includes(field)) target[field] = clone(task[field]);
      else if (!equal(target[field], task[field])) result.uncertainties.push(`任务「${target.name}」${field} 用户编辑与扫描冲突 unknown，保留用户编辑。`);
    }
  }
  // Validate the whole proposed graph, avoiding transient cycles while replacing old edges.
  const originalDependencies = new Map(result.tasks.map(task => [task.id, [...task.dependsOn]]));
  const changedDependencies = [];
  // Resolve references only after every retained/new task has an established project id.
  for (const { task, target } of pairs) {
    const dependencies = task.dependsOn.map(id => mapping.get(id));
    if (dependencies.some(id => !id || id === target.id)) {
      result.uncertainties.push(`任务「${target.name}」扫描依赖引用已删除、冲突或未知任务 unknown，保留原依赖待审核。`);
      if (!target.editedFields?.includes('dependencyNote')) target.dependencyNote = '扫描依赖 unknown：无法映射有效任务，待审核。';
      continue;
    }
    const proposed = [...new Set(dependencies)];
    if (target.editedFields?.includes('dependsOn')) {
      if (!equal(target.dependsOn, proposed)) {
        result.uncertainties.push(`任务「${target.name}」dependsOn 用户编辑与扫描冲突 unknown，保留用户依赖。`);
        if (!target.editedFields?.includes('dependencyNote')) target.dependencyNote = '用户依赖与扫描冲突 unknown：保留用户依赖，待审核。';
      }
      continue;
    }
    if (!equal(target.dependsOn, proposed)) changedDependencies.push(target);
    target.dependsOn = proposed;
  }
  if (!acyclic(result.tasks)) {
    // Keep the last valid graph, including all user edges; never partially accept an invalid graph.
    for (const target of changedDependencies) {
      target.dependsOn = originalDependencies.get(target.id);
      result.uncertainties.push(`任务「${target.name}」扫描依赖与现有依赖产生循环冲突 unknown，保留原依赖。`);
      if (!target.editedFields?.includes('dependencyNote')) target.dependencyNote = '扫描依赖循环冲突 unknown：保留原依赖，待审核。';
    }
  }
  if (result.tasks.some(t => t.status !== 'completed')) result.goalConfirmed = false;
  return result;
}

class ProjectsBackend {
  constructor({ home, userData, env = process.env, revealFile, limits = {}, analyzer = analyzeWithClaude }) {
    absolute(home, 'home'); absolute(userData, 'userData');
    this.filePath = path.join(userData, 'claude-gui-projects.json');
    const config = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    this.root = path.join(path.resolve(home, config), 'projects');
    this.revealFile = revealFile;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!(key in DEFAULT_LIMITS) || !Number.isSafeInteger(value) || value < 1) fail(`扫描限制 ${key} 无效`);
    }
    this.projects = null;
    this.loadPromise = null;
    this.loadError = null;
    this.diskSnapshot = null;
    this.scans = new Map();
    this.scanBusy = false;
    this.plans = new Map();
    this.activeScan = null;
    this.analyzer = analyzer;
    this.writeQueue = Promise.resolve();
  }
  async readSnapshot() {
    try {
      const stat = await fs.promises.lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('项目存储必须是常规文件，不能是目录或符号链接');
      if (stat.size > MAX_STORE_BYTES) fail(`项目存储过大，上限 ${MAX_STORE_BYTES} bytes`);
      return await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async load() {
    if (this.projects) return;
    if (!this.loadPromise) this.loadPromise = (async () => {
      let raw;
      try { raw = await this.readSnapshot(); }
      catch (error) {
        throw new Error(`项目存储读取失败 ${this.filePath}: ${error.code || 'ERROR'} ${error.message}`);
      }
      if (raw === null) { this.projects = []; this.diskSnapshot = null; this.loadError = null; return; }
      try {
        const saved = JSON.parse(raw);
        validateStore(saved);
        this.projects = saved.projects;
        this.diskSnapshot = raw;
        this.loadError = null;
      } catch (error) {
        throw new Error(`项目存储损坏或版本无效，禁止覆盖 ${this.filePath}: ${error.message}`);
      }
    })().catch(error => { this.loadError = error; this.loadPromise = null; throw error; });
    return this.loadPromise;
  }
  async list() { await this.writeQueue; await this.load(); return clone(this.projects); }
  async prepare(data) {
    if (this.scanBusy) fail('Projects scan busy：识别准备或分析中，请稍后重试');
    this.scanBusy = true;
    try {
      fields(data, ['sessions', 'conversations'], 'prepare 输入');
      if (!Array.isArray(data.sessions) || !Array.isArray(data.conversations)) fail('prepare sessions/conversations 必须是数组');
      await this.writeQueue;
      await this.load();
      for (const [id, entry] of this.plans) if (entry.expiresAt <= Date.now()) this.plans.delete(id);
      const prepared = await prepareAnalysis(data, this.root, this.limits, clone(this.projects));
      const planId = randomUUID(), expiresAt = Date.now() + 10 * 60 * 1000;
      this.plans.set(planId, { ...prepared, expiresAt });
      while (this.plans.size > 3) this.plans.delete(this.plans.keys().next().value);
      return { planId, expiresAt, ...clone(prepared.plan) };
    } finally { this.scanBusy = false; }
  }
  cancelScan(requestId) {
    if (typeof requestId !== 'string' || this.activeScan?.requestId !== requestId) return false;
    this.activeScan.controller.abort();
    return true;
  }
  async scan(data, reportProgress) {
    if (this.scanBusy) fail('Projects scan busy：扫描中，请稍后重试');
    this.scanBusy = true;
    try {
      fields(data, ['sessions', 'conversations', 'mode', 'planId', 'consent', 'model', 'maxBudgetUsd', 'requestId'], 'scan 输入');
      if (!Array.isArray(data.sessions) || !Array.isArray(data.conversations)) fail('scan sessions/conversations 必须是数组');
      const mode = data.mode || 'rules';
      if (!['rules', 'llm'].includes(mode)) fail('未知项目识别模式');
      if (mode === 'llm') {
        string(data.requestId, 'requestId', true);
        this.activeScan = { requestId: data.requestId, controller: new AbortController() };
      }
      await this.load();
      if (this.activeScan?.controller.signal.aborted) fail('项目识别已取消，未发送历史');
      let result;
      if (mode === 'llm') {
        string(data.planId, 'planId', true); string(data.requestId, 'requestId', true);
        if (data.consent !== true) fail('LLM 识别需要用户确认发送历史与费用');
        if (!Number.isFinite(data.maxBudgetUsd) || data.maxBudgetUsd <= 0 || data.maxBudgetUsd > 100) fail('LLM 识别总预算必须大于 0 且不超过 100 美元');
        if (data.model !== undefined) { string(data.model, 'model'); if (data.model.length > 200 || data.model.startsWith('-')) fail('模型名称无效'); }
        const plan = this.plans.get(data.planId);
        if (!plan || plan.expiresAt <= Date.now()) { this.plans.delete(data.planId); fail('发送计划不存在或已过期，请重新准备并确认'); }
        // Single-use frozen history snapshot: nothing new is silently scanned/sent after consent.
        this.plans.delete(data.planId);
        const controller = this.activeScan.controller;
        result = await analyzeProjects(plan.payload, {
          analyze: this.analyzer, model: data.model || undefined, maxBudgetUsd: data.maxBudgetUsd, signal: controller.signal,
          onProgress: progress => reportProgress?.({ ...progress, requestId: data.requestId }),
        });
        if (controller.signal.aborted) fail('项目识别已取消，未保存候选');
      } else {
        result = await scanProjects({ sessions: data.sessions, conversations: data.conversations }, this.root, this.limits);
        result.analysis = { mode: 'rules' };
      }
      await this.writeQueue;
      if (this.activeScan?.controller.signal.aborted) fail('项目识别已取消，未保存候选');
      for (const candidate of result.candidates) {
        const groundedSuggestion = candidate.existingProjectId && this.projects.find(project => project.id === candidate.existingProjectId &&
          projectScope(project) && projectScope(project) === projectScope(candidate) &&
          candidate.sources.some(source => project.sources.some(old => old.id === source.id)));
        delete candidate.existingProjectId;
        const matches = this.projects.filter(p => p === groundedSuggestion || sameGoal(p, candidate) ||
          (projectScope(p) && projectScope(p) === projectScope(candidate) && p.identityKey === candidate.identityKey));
        for (const project of this.projects) if (!matches.includes(project) && similarGoal(project, candidate)) {
          candidate.uncertainties.push(`同工作目录已有项目目标主体相似，需人工关联（未自动选择）：${project.name}（${project.id}）`);
        }
        if (matches.length === 1) candidate.existingProjectId = matches[0].id;
        if (matches.length > 1) candidate.uncertainties.push('证据关联到多个已有项目，请在审核时明确选择；未自动关联。');
        validateProject(this.asProject(candidate));
      }
      const scanId = randomUUID();
      this.scans.set(scanId, {
        candidates: clone(result.candidates), confirmed: new Map(),
        projectTasks: new Map(this.projects.map(project => [project.id, new Set(project.tasks.map(task => task.id))])),
      });
      // Keep only bounded temporary scans; old scan ids explicitly become invalid.
      while (this.scans.size > 20) this.scans.delete(this.scans.keys().next().value);
      result.coverage.warnings.push('scanId 仅在本次应用运行有效，最多保留最近 20 次扫描；未确认候选不会写盘。');
      return { scanId, ...clone(result) };
    } finally { this.scanBusy = false; this.activeScan = null; }
  }
  asProject(candidate) {
    return Object.fromEntries(PROJECT_FIELDS.map(key => [key, clone(candidate[key])]));
  }
  enqueue(fn) {
    const result = this.writeQueue.then(fn);
    // Recover the queue only; the caller still receives the original rejection.
    this.writeQueue = result.catch(() => {});
    return result;
  }
  async persist(projects) {
    validateStore({ version: 1, projects });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    let handle;
    let failure;
    const serialized = JSON.stringify({ version: 1, projects }, null, 2);
    try {
      if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) fail(`项目存储写入过大，上限 ${MAX_STORE_BYTES} bytes`);
      if (await this.readSnapshot() !== this.diskSnapshot) fail('项目存储已被外部修改，禁止覆盖，请重启后检查文件');
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      handle = await fs.promises.open(temp, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      if (await this.readSnapshot() !== this.diskSnapshot) fail('项目存储在写入期间被外部修改，禁止覆盖');
      await fs.promises.rename(temp, this.filePath);
    } catch (error) {
      failure = error;
    } finally {
      if (handle) {
        try { await handle.close(); } catch (error) { failure = failure || error; }
      }
      if (failure) {
        try { await fs.promises.unlink(temp); }
        catch (error) { if (error.code !== 'ENOENT') failure = new Error(`${failure.message}; 临时文件清理失败 ${error.code}: ${error.message}`, { cause: failure }); }
      }
    }
    if (failure) throw new Error(`项目存储原子写入失败 ${this.filePath}（${failure.code || failure.cause?.code || 'ERROR'}）：${failure.message}`);
    // Commit memory only after the atomic replacement succeeds.
    this.projects = projects;
    this.diskSnapshot = serialized;
  }
  async confirm(scanId, reviews) {
    // Capture IPC payload now, before queued operations can run.
    const input = clone(reviews);
    return this.enqueue(async () => {
      await this.load();
      const scan = this.scans.get(scanId);
      if (!scan) fail('scanId 不存在或已失效，请重新扫描后确认');
      if (!Array.isArray(input) || input.length > scan.candidates.length) fail('确认 reviews 必须是候选审核数组');
      const ids = new Set();
      for (const review of input) {
        fields(review, ['candidateId', 'name', 'goal', 'description', 'existingProjectId', 'allowDuplicate'], '候选审核');
        for (const key of ['candidateId', 'name', 'goal']) string(review[key], key, true);
        string(review.description, 'description');
        if (review.allowDuplicate !== undefined && typeof review.allowDuplicate !== 'boolean') fail('allowDuplicate 必须是布尔值');
        if (review.existingProjectId !== undefined) string(review.existingProjectId, 'existingProjectId', true);
        if (ids.has(review.candidateId)) fail('候选审核 id 重复');
        ids.add(review.candidateId);
        if (!scan.candidates.some(c => c.id === review.candidateId)) fail('候选 id 不属于该 scanId');
        if (review.existingProjectId !== undefined && !this.projects.some(p => p.id === review.existingProjectId)) fail('关联已有项目不存在');
      }
      const next = clone(this.projects), confirmations = new Map(scan.confirmed);
      let changed = false;
      const batchGoals = new Map();
      for (const review of input) {
        if (confirmations.has(review.candidateId)) continue;
        const candidate = scan.candidates.find(c => c.id === review.candidateId);
        const key = identity(review.goal, projectScope(candidate) || candidate.identityKey);
        const previous = batchGoals.get(key);
        if (previous && (!review.existingProjectId || review.existingProjectId !== previous.existingProjectId)) fail('同批次目标重复：请改名（修改目标）、取消重复候选，或显式关联同一个已有项目；allowDuplicate 不允许同批次重复创建');
        batchGoals.set(key, review);
      }
      for (const review of input) {
        if (confirmations.has(review.candidateId)) continue;
        const candidate = scan.candidates.find(c => c.id === review.candidateId);
        const scope = projectScope(candidate);
        const reviewedKey = !scope && identity(review.goal) === identity(candidate.goal) ? candidate.identityKey : identity(review.goal, scope || candidate.identityKey);
        // Independent creation is explicit when the reviewed goal already exists in this scope.
        if (!review.existingProjectId && scope && next.some(p => projectScope(p) === scope &&
          (sameGoal(p, { ...candidate, goal: review.goal }) || p.identityKey === reviewedKey || p.identityKey === candidate.identityKey ||
            (candidate.existingProjectId === p.id && candidate.sources.some(source => p.sources.some(old => old.id === source.id))))) && !review.allowDuplicate) {
          fail('同目录已有相同目标：请改名（修改目标）、取消，或传 existingProjectId 关联已有项目；独立创建须显式 allowDuplicate: true');
        }
        const existing = review.existingProjectId ? next.find(p => p.id === review.existingProjectId) : undefined;
        let project;
        if (existing) {
          project = mergeEvidence(existing, candidate, scan.projectTasks.get(existing.id));
          Object.assign(project, { name: review.name, goal: review.goal, description: review.description, updatedAt: Date.now() });
          if (identity(review.goal) !== identity(existing.goal)) project.goalConfirmed = false;
          // Explicit association retains the established identity; edited text is not a new project.
          next[next.findIndex(p => p.id === existing.id)] = project;
        } else {
          project = this.asProject(candidate);
          Object.assign(project, { id: randomUUID(), identityKey: reviewedKey, name: review.name, goal: review.goal, description: review.description, createdAt: Date.now(), updatedAt: Date.now() });
          next.push(project);
        }
        validateProject(project);
        confirmations.set(review.candidateId, project.id);
        changed = true;
      }
      if (changed) await this.persist(next);
      scan.confirmed = confirmations;
      return clone(this.projects);
    });
  }
  async update(project) {
    const input = clone(project);
    return this.enqueue(async () => {
      await this.load();
      validateProject(input);
      const index = this.projects.findIndex(p => p.id === input.id);
      if (index < 0) fail('项目未确认或不存在，不能 update');
      if (input.identityKey !== this.projects[index].identityKey || input.createdAt !== this.projects[index].createdAt) fail('项目 identityKey/createdAt 不可修改');
      const previous = this.projects[index];
      for (const task of input.tasks) {
        const old = previous.tasks.find(value => value.id === task.id);
        // Metadata is server-owned: incoming omission, clearing or fabrication cannot change it.
        task.editedFields = [...new Set([...(old?.editedFields || []), ...EDITABLE_TASK_FIELDS.filter(field => !old || !equal(old[field], task[field]))])];
      }
      const next = clone(this.projects);
      next[index] = { ...input, updatedAt: Date.now() };
      await this.persist(next);
      return clone(this.projects);
    });
  }
  async reveal(filePath) {
    try {
      absolute(filePath, 'reveal path');
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('reveal 只允许已有常规文件，不允许目录或符号链接');
      if (typeof this.revealFile !== 'function') fail('文件定位功能不可用');
      await this.revealFile(filePath);
      return { ok: true };
    } catch (error) { return { ok: false, error: `无法定位文件：${error.code || 'ERROR'} ${error.message}` }; }
  }
}

module.exports = { ProjectsBackend };
