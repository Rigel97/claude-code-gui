const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { scanProjects, DEFAULT_LIMITS, identity, normalize, acyclic, sameGoal, similarGoal, projectScope } = require('./projects-scan');
const { prepareAnalysis, analyzeProjects } = require('./projects-llm');
const { analyzeWithClaude } = require('./projects-analyzer');

const PROJECT_FIELDS = ['id', 'identityKey', 'name', 'description', 'goal', 'background', 'constraints', 'decisions', 'deliverables', 'goalConfirmed', 'tasks', 'files', 'sources', 'uncertainties', 'createdAt', 'updatedAt', 'archivedAt', 'deletedAt', 'mergedInto', 'audit', 'auditHistory', 'pinned', 'tags', 'retrospective', 'fieldProvenance', 'resolvedUncertainties', 'recognitionNotes', 'fieldEvidence', 'revision', 'workingDirectory', 'conversations', 'acceptance', 'acceptanceInvalidatedReason'];
const PROJECT_AUDIT_FIELDS = ['mode', 'model', 'batches', 'calls', 'costUsd', 'inputChars', 'scannedAt', 'coverage', 'evidence'];
const PROVENANCE_FIELDS = ['name', 'goal', 'description', 'background', 'constraints', 'decisions', 'deliverables'];
const PROVENANCE_VALUES = ['quoted', 'model', 'user', 'unknown'];
const EVIDENCE_FIELDS = ['background', 'constraints', 'decisions', 'deliverables'];
const PATCH_FIELDS = [...PROVENANCE_FIELDS, 'tasks', 'tags', 'pinned', 'retrospective', 'resolvedUncertainties', 'goalConfirmed', 'workingDirectory', 'conversations'];
const active = project => project.archivedAt === undefined && project.deletedAt === undefined && project.mergedInto === undefined;
const requiredTasks = tasks => tasks.filter(task => task.optional !== true && task.status !== 'cancelled');
const bump = project => { project.revision = (project.revision ?? 0) + 1; };
function checkRevision(project, revision, required = false) {
  if (revision === undefined && !required) return;
  if (!Number.isSafeInteger(revision) || revision < 0) fail('expectedRevision/revision 必须是非负整数');
  if (revision !== (project.revision ?? 0)) fail('项目版本已变化（revision），请重新读取后审核');
}
function acceptanceReason(previous, next) {
  if (next.goal !== previous.goal) return '项目目标已修改';
  if (next.deliverables !== previous.deliverables) return '交付标准已修改';
  const required = requiredTasks(next.tasks);
  if (!required.length) return '当前没有必要任务，不能以取消或可选任务代替交付';
  if (required.some(task => task.status !== 'completed')) return '存在未完成的必要任务';
  if (requiredTasks(previous.tasks).some(task => !required.some(item => item.id === task.id))) return '必要任务验收范围已缩减';
  if (required.some(task => !requiredTasks(previous.tasks).some(item => item.id === task.id))) return '必要任务验收范围已变化';
  return null;
}
function applyAcceptance(previous, next) {
  const reason = acceptanceReason(previous, next);
  if (previous.goalConfirmed && reason) {
    next.goalConfirmed = false;
    next.acceptanceInvalidatedReason = reason;
  }
  if (next.goalConfirmed) {
    next.acceptance = previous.goalConfirmed && previous.acceptance ? clone(previous.acceptance) : {
      confirmedAt: Date.now(), goal: next.goal, deliverables: next.deliverables,
      requiredTaskIds: requiredTasks(next.tasks).map(task => task.id),
    };
    delete next.acceptanceInvalidatedReason;
  } else {
    delete next.acceptance;
    if (previous.goalConfirmed && !reason) next.acceptanceInvalidatedReason = '用户手动撤销验收';
  }
}
const isGuidance = item => /^(?:助手宣称完成不等于项目完成|目标及项目字段仅保留用户显式原文|LLM 语义识别与项目字段待确认；引用仅证明原文存在)/.test(item);
const RETROSPECTIVE_FIELDS = ['goal', 'outcome', 'wentWell', 'wentPoorly', 'surprises', 'nextSteps', 'updatedAt'];
const EDITABLE_TASK_FIELDS = ['status', 'name', 'description', 'inputs', 'outputs', 'dependsOn', 'dependencyNote', 'optional'];
const TASK_FIELDS = ['id', 'name', 'description', 'status', 'inputs', 'outputs', 'dependsOn', 'dependencyNote', 'sourceIds', 'records', 'editedFields', 'optional', 'statusChangedAt'];
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
function validateAudit(audit) {
  fields(audit, PROJECT_AUDIT_FIELDS, '审计');
  if (!['rules', 'llm'].includes(audit.mode)) fail('审计 mode 无效');
  if (audit.model !== undefined) string(audit.model, '审计.model');
  for (const key of ['batches', 'calls', 'inputChars']) if (audit[key] !== undefined && (!Number.isSafeInteger(audit[key]) || audit[key] < 0)) fail(`审计.${key} 必须是非负整数`);
  if (audit.costUsd !== undefined && (!Number.isFinite(audit.costUsd) || audit.costUsd < 0)) fail('审计.costUsd 必须是非负数字');
  if (!Number.isFinite(audit.scannedAt) || audit.scannedAt < 0) fail('审计.scannedAt 必须是有效时间戳');
  fields(audit.coverage, ['guiSessions', 'claudeSessions', 'skipped', 'warnings', 'roots', 'incomplete'], '审计.coverage');
  for (const key of ['guiSessions', 'claudeSessions', 'skipped']) if (!Number.isSafeInteger(audit.coverage[key]) || audit.coverage[key] < 0) fail(`审计.coverage.${key} 必须是非负整数`);
  if (audit.coverage.incomplete !== undefined && typeof audit.coverage.incomplete !== 'boolean') fail('审计.coverage.incomplete 必须是布尔值');
  strings(audit.coverage.warnings, '审计.coverage.warnings');
  strings(audit.coverage.roots, '审计.coverage.roots');
  if (audit.evidence !== undefined) strings(audit.evidence, '审计.evidence');
}
function validateScope(scope) {
  if (scope === undefined) return;
  fields(scope, ['cwd', 'sinceDays'], '扫描范围');
  if (scope.cwd !== undefined) absolute(scope.cwd, '扫描范围.cwd');
  if (scope.sinceDays !== undefined && (!Number.isSafeInteger(scope.sinceDays) || scope.sinceDays < 1 || scope.sinceDays > 3650)) fail('扫描范围.sinceDays 必须是 1-3650 的整数');
}
function validateRetrospective(retrospective) {
  fields(retrospective, RETROSPECTIVE_FIELDS, '复盘');
  for (const key of ['goal', 'outcome', 'wentWell', 'wentPoorly', 'surprises', 'nextSteps']) string(retrospective[key] ?? '', `复盘.${key}`);
  if (!Number.isFinite(retrospective.updatedAt) || retrospective.updatedAt < 0) fail('复盘.updatedAt 必须是有效时间戳');
}
function validateProvenance(provenance) {
  object(provenance, '字段来源');
  for (const [key, value] of Object.entries(provenance)) {
    if (!PROVENANCE_FIELDS.includes(key)) fail(`字段来源含不支持字段 ${key}`);
    if (!PROVENANCE_VALUES.includes(value)) fail(`字段来源 ${key} 的值无效`);
  }
}
function validateProject(project) {
  fields(project, PROJECT_FIELDS, '项目');
  for (const key of ['id', 'identityKey', 'name', 'goal']) string(project[key], key, true);
  for (const key of ['description', 'background', 'constraints', 'decisions', 'deliverables']) string(project[key], key);
  for (const key of ['createdAt', 'updatedAt']) if (!Number.isFinite(project[key]) || project[key] < 0) fail(`${key} 必须是有效时间戳`);
  for (const key of ['archivedAt', 'deletedAt']) if (project[key] !== undefined && (!Number.isFinite(project[key]) || project[key] < 0)) fail(`${key} 必须是有效时间戳`);
  if (project.mergedInto !== undefined) string(project.mergedInto, 'mergedInto', true);
  if (project.audit !== undefined) validateAudit(project.audit);
  if (project.auditHistory !== undefined) {
    if (!Array.isArray(project.auditHistory) || project.auditHistory.length > 50) fail('auditHistory 必须是有限数组');
    project.auditHistory.forEach(validateAudit);
  }
  if (project.pinned !== undefined && typeof project.pinned !== 'boolean') fail('pinned 必须是布尔值');
  if (project.tags !== undefined) strings(project.tags, 'tags');
  if (project.retrospective !== undefined) validateRetrospective(project.retrospective);
  if (project.fieldProvenance !== undefined) validateProvenance(project.fieldProvenance);
  if (project.resolvedUncertainties !== undefined) strings(project.resolvedUncertainties, 'resolvedUncertainties');
  if (project.recognitionNotes !== undefined) strings(project.recognitionNotes, 'recognitionNotes');
  if (project.revision !== undefined && (!Number.isSafeInteger(project.revision) || project.revision < 0)) fail('revision 必须是非负整数');
  if (project.workingDirectory !== undefined && project.workingDirectory !== '') absolute(project.workingDirectory, 'workingDirectory');
  if (project.acceptanceInvalidatedReason !== undefined) string(project.acceptanceInvalidatedReason, '验收失效原因');
  if (project.acceptance !== undefined) {
    fields(project.acceptance, ['confirmedAt', 'goal', 'deliverables', 'requiredTaskIds'], '验收');
    if (!Number.isFinite(project.acceptance.confirmedAt) || project.acceptance.confirmedAt < 0) fail('验收时间无效');
    string(project.acceptance.goal, '验收目标'); string(project.acceptance.deliverables, '验收交付标准');
    strings(project.acceptance.requiredTaskIds, '验收任务');
  }
  if (project.conversations !== undefined) {
    if (!Array.isArray(project.conversations) || project.conversations.length > 1000) fail('关联对话必须是有限数组');
    const ids = new Set();
    for (const link of project.conversations) {
      fields(link, ['conversationId', 'sessionId', 'cwd', 'title', 'taskId', 'linkedAt', 'lastRun', 'reviewedAt'], '关联对话');
      string(link.conversationId, 'conversationId', true); absolute(link.cwd, '关联对话.cwd'); string(link.title, '对话标题');
      if (ids.has(link.conversationId)) fail('关联对话重复'); ids.add(link.conversationId);
      if (link.sessionId !== undefined) string(link.sessionId, 'sessionId', true);
      if (link.taskId !== undefined) string(link.taskId, '关联任务', true);
      if (!Number.isFinite(link.linkedAt) || link.linkedAt < 0) fail('对话关联时间无效');
      if (link.reviewedAt !== undefined && (!Number.isFinite(link.reviewedAt) || link.reviewedAt < 0)) fail('对话核对时间无效');
      if (link.lastRun !== undefined) {
        fields(link.lastRun, ['status', 'recordedAt', 'messageId', 'excerpt', 'verified'], '对话执行记录');
        if (link.lastRun.verified !== undefined && link.lastRun.verified !== false) fail('对话摘要不能标记为已验证');
        if (!['completed', 'failed', 'aborted'].includes(link.lastRun.status)) fail('执行状态无效');
        if (!Number.isFinite(link.lastRun.recordedAt) || link.lastRun.recordedAt < 0) fail('执行时间无效');
        if (link.lastRun.messageId !== undefined) string(link.lastRun.messageId, '执行消息');
        string(link.lastRun.excerpt, '执行摘要');
      }
    }
  }
  if (typeof project.goalConfirmed !== 'boolean') fail('goalConfirmed 必须是布尔值');
  strings(project.uncertainties, 'uncertainties');
  for (const key of ['tasks', 'files', 'sources']) if (!Array.isArray(project[key]) || project[key].length > 50000) fail(`${key} 必须是有限数组`);
  const sourceIds = new Set();
  for (const source of project.sources) {
    fields(source, ['id', 'kind', 'sessionId', 'title', 'cwd', 'path', 'messageId', 'excerpt', 'timestamp'], 'source');
    for (const key of ['id', 'sessionId']) string(source[key], `source.${key}`, true);
    for (const key of ['title', 'cwd', 'excerpt']) string(source[key], `source.${key}`);
    if (!['gui', 'claude'].includes(source.kind)) fail('source.kind 无效');
    if (source.path !== undefined) absolute(source.path, 'source.path');
    if (source.messageId !== undefined) string(source.messageId, 'source.messageId');
    if (source.timestamp !== undefined && (!Number.isFinite(source.timestamp) || source.timestamp < 0)) fail('source.timestamp 必须是有效时间戳');
    if (sourceIds.has(source.id)) fail('source.id 重复');
    sourceIds.add(source.id);
  }
  const taskIds = new Set();
  for (const task of project.tasks) {
    fields(task, TASK_FIELDS, '任务');
    for (const key of ['id', 'name']) string(task[key], `任务.${key}`, true);
    for (const key of ['description', 'dependencyNote']) string(task[key], `任务.${key}`);
    if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(task.status)) fail('任务 status 无效');
    if (task.optional !== undefined && typeof task.optional !== 'boolean') fail('任务 optional 必须是布尔值');
    if (task.statusChangedAt !== undefined && (!Number.isFinite(task.statusChangedAt) || task.statusChangedAt < 0)) fail('任务 statusChangedAt 必须是有效时间戳');
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
  if (project.fieldEvidence !== undefined) {
    fields(project.fieldEvidence, EVIDENCE_FIELDS, '字段证据');
    for (const evidence of Object.values(project.fieldEvidence)) {
      fields(evidence, ['kind', 'refs', 'reviewedAt'], '字段证据项');
      if (!['quoted', 'model', 'unknown'].includes(evidence.kind) || !Array.isArray(evidence.refs) || evidence.refs.length > 100) fail('字段证据结构无效');
      if (evidence.reviewedAt !== undefined && (!Number.isFinite(evidence.reviewedAt) || evidence.reviewedAt < 0)) fail('字段审核时间无效');
      for (const ref of evidence.refs) {
        fields(ref, ['sourceId', 'quote'], '字段引用'); string(ref.sourceId, '字段来源', true); string(ref.quote, '字段引用', true);
        if (!sourceIds.has(ref.sourceId)) fail('字段引用来源不存在');
      }
    }
  }
  if (project.goalConfirmed && (!requiredTasks(project.tasks).length || requiredTasks(project.tasks).some(t => t.status !== 'completed'))) fail('goalConfirmed 只允许至少一项必要任务且所有必要任务 completed 后确认');
  for (const file of project.files) {
    fields(file, ['path', 'purpose', 'sourceId'], '文件');
    absolute(file.path, '文件.path'); string(file.purpose, '文件.purpose');
    if (!sourceIds.has(file.sourceId)) fail('文件 sourceId 引用不存在');
  }
  return project;
}
function normalizeProject(project) {
  fields(project, PROJECT_FIELDS, '项目');
  const next = clone(project);
  // Additive compatibility for files written before archive/retrospective/provenance fields existed.
  for (const field of ['description', ...EVIDENCE_FIELDS]) if (next[field] === undefined) next[field] = '';
  if (next.pinned === undefined) next.pinned = false;
  if (next.tags === undefined) next.tags = [];
  if (next.resolvedUncertainties === undefined) next.resolvedUncertainties = [];
  if (next.auditHistory === undefined) next.auditHistory = [];
  if (next.fieldProvenance === undefined) {
    next.fieldProvenance = Object.fromEntries(PROVENANCE_FIELDS.filter(field => next[field]).map(field => [field, 'unknown']));
  }
  if (next.revision === undefined) next.revision = 0;
  strings(next.uncertainties, 'uncertainties');
  if (next.recognitionNotes !== undefined) strings(next.recognitionNotes, 'recognitionNotes');
  if (!Array.isArray(next.tasks)) fail('tasks 必须是数组');
  next.recognitionNotes = [...new Set([...(next.recognitionNotes || []), ...next.uncertainties.filter(isGuidance)])];
  next.uncertainties = [...new Set(next.uncertainties)].filter(item => !isGuidance(item));
  if (next.goalConfirmed && !requiredTasks(next.tasks).length) {
    next.goalConfirmed = false; next.acceptanceInvalidatedReason = '旧验收没有必要任务，需重新核对交付范围';
    delete next.acceptance;
  }
  return next;
}
function validateStore(value) {
  fields(value, ['version', 'projects'], '项目存储');
  if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 10000) fail('项目存储版本或结构不受支持');
  const ids = new Set(), conversationIds = new Set();
  for (const project of value.projects) {
    for (const link of project.conversations || []) {
      if (conversationIds.has(link.conversationId)) fail('关联对话不能属于多个项目');
      conversationIds.add(link.conversationId);
    }
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
  result.recognitionNotes = [...new Set([...(result.recognitionNotes || []), ...(candidate.recognitionNotes || [])])];
  result.fieldEvidence = { ...(result.fieldEvidence || {}) };
  for (const field of ['background', 'constraints', 'decisions', 'deliverables']) {
    if (!candidate[field].trim()) continue;
    if (!result[field].trim()) {
      result[field] = candidate[field];
      if (candidate.fieldEvidence?.[field]) result.fieldEvidence[field] = clone(candidate.fieldEvidence[field]);
    }
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
    const previousStatus = target.status;
    for (const field of EDITABLE_TASK_FIELDS.filter(field => field !== 'dependsOn')) {
      if (!target.editedFields?.includes(field)) target[field] = clone(task[field]);
      else if (!equal(target[field], task[field])) result.uncertainties.push(`任务「${target.name}」${field} 用户编辑与扫描冲突 unknown，保留用户编辑。`);
    }
    if (!target.editedFields?.includes('status') && previousStatus !== task.status) {
      target.statusChangedAt = task.statusChangedAt || Date.now();
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
  result.uncertainties = [...new Set(result.uncertainties)].filter(item => !isGuidance(item));
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
    this.loadGeneration = 0;
    this.loadError = null;
    this.diskSnapshot = null;
    this.scans = new Map();
    this.scanBusy = false;
    this.plans = new Map();
    this.activeScan = null;
    this.analyzer = analyzer;
    this.writeQueue = Promise.resolve();
    this.lastJob = null;
    this.reviewPath = path.join(userData, 'claude-gui-projects-review.json');
    this.reviewQueue = Promise.resolve();
    this.reviewLoaded = false;
    this.reviewError = null;
    this.reviewData = null;
  }
  async readSnapshot() {
    try {
      const stat = await fs.promises.lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('项目存储必须是常规文件，不能是目录或符号链接');
      if (stat.size > MAX_STORE_BYTES) fail(`项目存储过大，上限 ${MAX_STORE_BYTES} bytes`);
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      if (Buffer.byteLength(raw) > MAX_STORE_BYTES) fail(`项目存储过大，上限 ${MAX_STORE_BYTES} bytes`);
      return raw;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async load() {
    if (this.projects) return;
    if (!this.loadPromise) {
      const generation = this.loadGeneration;
      this.loadPromise = (async () => {
        let raw;
        try { raw = await this.readSnapshot(); }
        catch (error) {
          throw new Error(`项目存储读取失败 ${this.filePath}: ${error.code || 'ERROR'} ${error.message}`);
        }
        if (generation !== this.loadGeneration) return this.load();
        if (raw === null) { this.projects = []; this.diskSnapshot = null; this.loadError = null; return; }
        try {
          const projects = this.parseStore(raw);
          this.projects = projects;
          this.diskSnapshot = raw;
          this.loadError = null;
        } catch (error) {
          throw new Error(`项目存储损坏或版本无效，禁止覆盖 ${this.filePath}: ${error.message}`);
        }
      })().catch(error => {
        if (generation !== this.loadGeneration) return this.load();
        this.loadError = error; this.loadPromise = null; throw error;
      });
    }
    return this.loadPromise;
  }
  async list() { await this.writeQueue; await this.load(); return clone(this.projects); }
  startJob(data, operation, callback) {
    if (this.scanBusy) fail('Projects scan busy：识别准备或分析中，请稍后重试');
    object(data, '作业输入');
    const requestId = data.requestId ?? randomUUID(); string(requestId, 'requestId', true);
    const job = { requestId, operation, state: 'running', controller: new AbortController() };
    this.scanBusy = true; this.activeScan = job; this.lastJob = null;
    job.report = progress => {
      const snapshot = clone({ ...progress, requestId });
      // Large histories emit hundreds of same-phase updates; coalescing keeps IPC
      // and renderer work bounded while phase changes and the terminal update pass.
      if (job.progress && snapshot.phase === job.progress.phase && Date.now() - (job.reportedAt || 0) < 250) return;
      job.reportedAt = Date.now(); job.progress = snapshot;
      try { const pending = callback?.(clone(snapshot)); pending?.catch?.(() => {}); } catch { /* Reloaded renderer must not fail the job. */ }
    };
    return job;
  }
  finishJob(job, error) {
    job.state = job.controller.signal.aborted ? 'cancelled' : error ? 'failed' : 'completed';
    if (error) job.error = error.message;
    this.lastJob = this.jobSnapshot(job);
    this.scanBusy = false; this.activeScan = null;
  }
  jobSnapshot(job) {
    if (!job) return null;
    return clone(Object.fromEntries(['requestId', 'operation', 'state', 'progress', 'plan', 'result', 'error'].filter(key => job[key] !== undefined).map(key => [key, job[key]])));
  }
  activeJob() { return this.jobSnapshot(this.activeScan || this.lastJob); }
  discardPlan(planId) {
    string(planId, 'planId', true);
    const removed = this.plans.delete(planId);
    if (this.lastJob?.plan?.planId === planId) this.lastJob = null;
    return removed;
  }
  async prepare(data, reportProgress) {
    const job = this.startJob(data, 'prepare', reportProgress);
    let failure;
    try {
      fields(data, ['sessions', 'conversations', 'scope', 'requestId'], 'prepare 输入');
      if (!Array.isArray(data.sessions) || !Array.isArray(data.conversations)) fail('prepare sessions/conversations 必须是数组');
      validateScope(data.scope);
      await this.writeQueue;
      await this.load();
      for (const [id, entry] of this.plans) if (entry.expiresAt <= Date.now()) this.plans.delete(id);
      if (job.controller.signal.aborted) fail('项目识别准备已取消');
      const prepared = await prepareAnalysis(data, this.root, this.limits, clone(this.projects.filter(active)), job.controller.signal, job.report);
      if (job.controller.signal.aborted) fail('项目识别准备已取消，未保存计划');
      const planId = randomUUID(), expiresAt = Date.now() + 10 * 60 * 1000;
      this.plans.set(planId, { ...prepared, expiresAt });
      while (this.plans.size > 3) this.plans.delete(this.plans.keys().next().value);
      job.plan = { planId, expiresAt, ...clone(prepared.plan) };
      return clone(job.plan);
    } catch (error) { failure = error; throw error; }
    finally { this.finishJob(job, failure); }
  }
  cancelScan(requestId) {
    if (typeof requestId !== 'string' || this.activeScan?.requestId !== requestId || this.activeScan.state !== 'running') return false;
    this.activeScan.controller.abort();
    return true;
  }
  async scan(data, reportProgress) {
    const job = this.startJob(data, 'scan', reportProgress);
    let failure;
    try {
      fields(data, ['sessions', 'conversations', 'mode', 'planId', 'consent', 'model', 'maxBudgetUsd', 'requestId', 'scope'], 'scan 输入');
      if (!Array.isArray(data.sessions) || !Array.isArray(data.conversations)) fail('scan sessions/conversations 必须是数组');
      validateScope(data.scope);
      const mode = data.mode || 'rules';
      if (!['rules', 'llm'].includes(mode)) fail('未知项目识别模式');
      await this.writeQueue;
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
          onProgress: job.report,
        });
        if (controller.signal.aborted) fail('项目识别已取消，未保存候选');
      } else {
        result = await scanProjects({ sessions: data.sessions, conversations: data.conversations, scope: data.scope }, this.root, this.limits, job.controller.signal, job.report);
        result.analysis = { mode: 'rules' };
      }
      await this.writeQueue;
      if (this.activeScan?.controller.signal.aborted) fail('项目识别已取消，未保存候选');
      for (const candidate of result.candidates) {
        const groundedSuggestion = candidate.existingProjectId && this.projects.find(project => project.id === candidate.existingProjectId &&
          active(project) && projectScope(project) && projectScope(project) === projectScope(candidate) &&
          candidate.sources.some(source => project.sources.some(old => old.id === source.id)));
        delete candidate.existingProjectId;
        const matches = this.projects.filter(p => active(p) && (p === groundedSuggestion || sameGoal(p, candidate) ||
          (projectScope(p) && projectScope(p) === projectScope(candidate) && p.identityKey === candidate.identityKey)));
        const matchSet = new Set(matches);
        for (const project of this.projects) if (active(project) && !matchSet.has(project) && similarGoal(project, candidate)) {
          candidate.uncertainties.push(`同工作目录已有项目目标主体相似，需人工关联（未自动选择）：${project.name}（${project.id}）`);
        }
        if (matches.length === 1) candidate.existingProjectId = matches[0].id;
        if (matches.length > 1) candidate.uncertainties.push('证据关联到多个已有项目，请在审核时明确选择；未自动关联。');
        validateProject(this.asProject(candidate));
      }
      const scanId = randomUUID();
      this.scans.set(scanId, {
        candidates: clone(result.candidates), analysis: clone(result.analysis), coverage: clone(result.coverage),
        confirmed: new Map(),
        projectTasks: new Map(this.projects.map(project => [project.id, new Set(project.tasks.map(task => task.id))])),
      });
      // Keep only bounded temporary scans; old scan ids explicitly become invalid.
      while (this.scans.size > 20) {
        const disposable = [...this.scans.keys()].find(id => id !== this.reviewData?.scanId);
        if (!disposable) break;
        this.scans.delete(disposable);
      }
      result.coverage.warnings.push('临时扫描最多保留最近 20 次；审核草稿显式保存到本地后可跨重启恢复，未确认候选不会进入项目档案。');
      job.result = { scanId, ...clone(result) };
      return clone(job.result);
    } catch (error) { failure = error; throw error; }
    finally { this.finishJob(job, failure); }
  }
  asProject(candidate) {
    return normalizeProject(Object.fromEntries(PROJECT_FIELDS.filter(key => candidate[key] !== undefined).map(key => [key, clone(candidate[key])])));
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
      if (this.diskSnapshot !== null) {
        this.parseStore(this.diskSnapshot);
        await this.atomicWrite(`${this.filePath}.bak`, this.diskSnapshot);
        if (await this.readSnapshot() !== this.diskSnapshot) fail('备份期间项目存储已被外部修改，禁止覆盖');
      }
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
    this.loadGeneration++; this.loadPromise = null; this.loadError = null;
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
        this.validateReview(review);
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
        if (!review.existingProjectId && scope && next.some(p => active(p) && projectScope(p) === scope &&
          (sameGoal(p, { ...candidate, goal: review.goal }) || p.identityKey === reviewedKey || p.identityKey === candidate.identityKey ||
            (candidate.existingProjectId === p.id && candidate.sources.some(source => p.sources.some(old => old.id === source.id))))) && !review.allowDuplicate) {
          fail('同目录已有相同目标：请改名（修改目标）、取消，或传 existingProjectId 关联已有项目；独立创建须显式 allowDuplicate: true');
        }
        const existing = review.existingProjectId ? next.find(p => p.id === review.existingProjectId) : undefined;
        if (existing) {
          checkRevision(this.projects.find(project => project.id === existing.id), review.expectedRevision);
          if (!active(existing) && review.restoreExisting !== true) fail('关联归档/删除项目需要显式 restoreExisting: true');
        }
        const reviewed = clone(candidate);
        for (const field of EVIDENCE_FIELDS) {
          const value = review.fields?.[field] ?? candidate[field];
          const novel = review.fields && Object.hasOwn(review.fields, field) && value !== candidate[field];
          if (value.trim() && (novel || (candidate.fieldEvidence?.[field]?.kind !== 'quoted' &&
              (scan.analysis?.mode === 'llm' || candidate.fieldEvidence?.[field]))) && !review.reviewedFields?.includes(field)) {
            fail(`字段 ${field} 是新增审核值或 model/unknown，必须列入 reviewedFields 后确认`);
          }
          if (review.fields && Object.hasOwn(review.fields, field)) reviewed[field] = review.fields[field];
        }
        const expectedMode = scan.analysis?.mode === 'llm' ? 'model' : 'quoted';
        const audit = { ...(scan.analysis || { mode: 'rules' }), scannedAt: Date.now(), coverage: clone(scan.coverage), evidence: clone(candidate.evidence || []) };
        let project;
        if (existing) {
          project = mergeEvidence(existing, candidate, scan.projectTasks.get(existing.id));
          delete project.archivedAt; delete project.deletedAt; delete project.mergedInto;
          const provenance = { ...(existing.fieldProvenance || {}) };
          for (const field of PROVENANCE_FIELDS) if (!existing[field] && candidate[field]) provenance[field] = expectedMode;
          for (const field of ['name', 'goal', 'description']) if (!equal(existing[field], review[field])) provenance[field] = 'user';
          const auditHistory = [...(existing.auditHistory || []), ...(existing.audit ? [existing.audit] : [])].slice(-50);
          Object.assign(project, { name: review.name, goal: review.goal, description: review.description, updatedAt: Date.now(), audit, auditHistory, fieldProvenance: provenance });
          bump(project);
          // Explicit association retains the established identity; edited text is not a new project.
          next[next.findIndex(p => p.id === existing.id)] = project;
        } else {
          project = this.asProject(candidate);
          const provenance = Object.fromEntries(PROVENANCE_FIELDS.filter(field => candidate[field]).map(field => [field, expectedMode]));
          for (const field of ['name', 'goal', 'description']) if (!equal(candidate[field], review[field])) provenance[field] = 'user';
          Object.assign(project, {
            id: randomUUID(), identityKey: reviewedKey, name: review.name, goal: review.goal, description: review.description,
            createdAt: Date.now(), updatedAt: Date.now(), audit, auditHistory: [], pinned: false, tags: [],
            fieldProvenance: provenance, resolvedUncertainties: [], revision: 1,
            ...(scope ? { workingDirectory: scope } : {}),
          });
          next.push(project);
        }
        for (const field of EVIDENCE_FIELDS) {
          const explicit = review.fields && Object.hasOwn(review.fields, field);
          const value = reviewed[field];
          const changedValue = value !== candidate[field];
          const edited = explicit && (!existing || value !== existing[field]);
          if (edited) project[field] = value;
          if (!existing || (!existing[field] && project[field] === value)) {
            project.fieldProvenance[field] = candidate.fieldProvenance?.[field] || candidate.fieldEvidence?.[field]?.kind || expectedMode;
          }
          if (explicit && existing && value !== existing[field] && !changedValue) {
            project.fieldProvenance[field] = candidate.fieldProvenance?.[field] || candidate.fieldEvidence?.[field]?.kind || expectedMode;
            if (candidate.fieldEvidence?.[field]) project.fieldEvidence = { ...project.fieldEvidence, [field]: clone(candidate.fieldEvidence[field]) };
          }
          if (edited && changedValue) {
            project.fieldProvenance[field] = 'user';
            project.fieldEvidence = { ...project.fieldEvidence, [field]: { kind: value ? 'model' : 'unknown', refs: [], reviewedAt: Date.now() } };
          }
          if (review.reviewedFields?.includes(field) && project[field] === value) {
            project.fieldEvidence = { ...project.fieldEvidence, [field]: {
              ...(changedValue ? { kind: value ? 'model' : 'unknown', refs: [] } : clone(candidate.fieldEvidence?.[field] || { kind: 'unknown', refs: [] })), reviewedAt: Date.now(),
            } };
            const resolved = candidate.uncertainties.filter(note => note.startsWith(`字段 ${field} `) && !/冲突|conflict/i.test(note));
            project.resolvedUncertainties = [...new Set([...(project.resolvedUncertainties || []), ...resolved])];
          }
        }
        if (existing) applyAcceptance(existing, project);
        validateProject(project);
        confirmations.set(review.candidateId, project.id);
        changed = true;
      }
      if (changed) await this.persist(next);
      scan.confirmed = confirmations;
      if (this.lastJob?.result?.scanId === scanId) this.lastJob = null;
      return clone(this.projects);
    });
  }
  validateReview(review, draft = false) {
    const allowed = ['candidateId', 'name', 'goal', 'description', 'existingProjectId', 'allowDuplicate', 'restoreExisting', 'fields', 'reviewedFields', 'expectedRevision'];
    fields(review, draft ? [...allowed, 'selected'] : allowed, '候选审核');
    string(review.candidateId, 'candidateId', true);
    for (const field of ['name', 'goal', 'description']) if (!draft || review[field] !== undefined) string(review[field], field, field !== 'description');
    for (const field of ['allowDuplicate', 'restoreExisting', 'selected']) if (review[field] !== undefined && typeof review[field] !== 'boolean') fail(`${field} 必须是布尔值`);
    if (review.existingProjectId !== undefined && review.existingProjectId !== '') string(review.existingProjectId, 'existingProjectId', true);
    if (review.fields !== undefined) {
      fields(review.fields, EVIDENCE_FIELDS, '审核字段');
      for (const [field, value] of Object.entries(review.fields)) string(value, field);
    }
    if (review.reviewedFields !== undefined) {
      strings(review.reviewedFields, 'reviewedFields');
      if (review.reviewedFields.some(field => !EVIDENCE_FIELDS.includes(field)) || new Set(review.reviewedFields).size !== review.reviewedFields.length) fail('reviewedFields 无效');
    }
    if (review.expectedRevision !== undefined && (!Number.isSafeInteger(review.expectedRevision) || review.expectedRevision < 0)) fail('expectedRevision 无效');
  }
  async patch(request) {
    const input = clone(request);
    return this.enqueue(async () => {
      fields(input, ['id', 'expectedRevision', 'changes'], 'patch');
      string(input.id, 'id', true); fields(input.changes, PATCH_FIELDS, 'patch changes');
      await this.load();
      const previous = this.projects.find(project => project.id === input.id);
      if (!previous) fail('项目不存在');
      checkRevision(previous, input.expectedRevision, true);
      const next = { ...clone(previous), ...input.changes };
      if (Array.isArray(input.changes.tasks)) for (const task of next.tasks) {
        const old = previous.tasks.find(value => value.id === task.id);
        for (const field of ['sourceIds', 'records']) {
          if (!equal(task[field] || [], old?.[field] || [])) fail(`patch 不能修改任务 ${field}`);
        }
      }
      if (input.changes.conversations !== undefined) {
        if (!Array.isArray(input.changes.conversations)) fail('对话核对必须是数组');
        next.conversations = clone(previous.conversations || []);
        const seen = new Set();
        for (const change of input.changes.conversations) {
          fields(change, ['conversationId', 'reviewedAt'], '对话核对');
          string(change.conversationId, 'conversationId', true);
          if (!Number.isFinite(change.reviewedAt) || change.reviewedAt < 0 || seen.has(change.conversationId)) fail('对话核对时间或 ID 无效');
          seen.add(change.conversationId);
          const link = next.conversations.find(link => link.conversationId === change.conversationId);
          if (!link) fail('不能伪造关联对话');
          link.reviewedAt = change.reviewedAt;
        }
      }
      return this.updateNow(next, true);
    });
  }
  async update(project) {
    const input = clone(project);
    return this.enqueue(async () => { await this.load(); return this.updateNow(input); });
  }
  async updateNow(input, allowConversationReview = false) {
    const index = this.projects.findIndex(p => p.id === input.id);
    if (index < 0) fail('项目未确认或不存在，不能 update');
    const previous = this.projects[index];
    if (typeof input.goalConfirmed !== 'boolean') fail('goalConfirmed 必须是布尔值');
    // Validate shape first, then use only server-owned task evidence. Legacy sources/files
    // remain compatible with historical fixtures, but cannot manufacture task references.
    fields(input, PROJECT_FIELDS, '项目');
    if (!Array.isArray(input.tasks) || input.tasks.length > 50000) fail('tasks 必须是有限数组');
    for (const task of input.tasks) {
      fields(task, TASK_FIELDS, '任务');
      for (const field of ['records', 'sourceIds']) strings(task[field], `任务.${field}`);
      const old = previous.tasks.find(value => value.id === task.id);
      if (old && Array.isArray(input.sources) && task.sourceIds.some(id => !input.sources.some(source => source?.id === id))) fail('任务 sourceIds 引用不存在');
      task.records = clone(old?.records || []);
      task.sourceIds = clone(old?.sourceIds || []);
    }
    validateProject(previous.goalConfirmed ? { ...input, goalConfirmed: false } : input);
    checkRevision(previous, input.revision);
    if (!active(previous)) fail('已删除或归档项目只读，不能 update');
    if (input.identityKey !== previous.identityKey || input.createdAt !== previous.createdAt) fail('项目 identityKey/createdAt 不可修改');
    const now = Date.now();
    for (const field of ['archivedAt', 'deletedAt', 'mergedInto', 'audit', 'auditHistory', 'acceptance', 'acceptanceInvalidatedReason', 'fieldEvidence', 'recognitionNotes', ...(allowConversationReview ? [] : ['conversations'])]) {
      if (previous[field] === undefined) delete input[field]; else input[field] = clone(previous[field]);
    }
    applyAcceptance(previous, input);
    for (const task of input.tasks) {
      const old = previous.tasks.find(value => value.id === task.id);
      task.editedFields = [...new Set([...(old?.editedFields || []), ...EDITABLE_TASK_FIELDS.filter(field => !old || !equal(old[field], task[field]))])];
      if (!old || old.status !== task.status) task.statusChangedAt = now;
      else if (old.statusChangedAt !== undefined) task.statusChangedAt = old.statusChangedAt;
      else delete task.statusChangedAt;
    }
    input.fieldProvenance = { ...(previous.fieldProvenance || {}) };
    for (const field of PROVENANCE_FIELDS) if (!equal(previous[field], input[field])) {
      input.fieldProvenance[field] = 'user';
      if (EVIDENCE_FIELDS.includes(field)) input.fieldEvidence = { ...input.fieldEvidence, [field]: { kind: input[field] ? 'model' : 'unknown', refs: [], reviewedAt: now } };
    }
    input.updatedAt = now; input.revision = previous.revision ?? 0; bump(input); validateProject(input);
    const next = clone(this.projects); next[index] = input;
    await this.persist(next);
    return clone(this.projects);
  }
  async create(input) {
    const data = clone(input);
    return this.enqueue(async () => {
      await this.load();
      fields(data, ['name', 'goal', 'description', 'background', 'constraints', 'decisions', 'deliverables', 'tags', 'workingDirectory'], '新建项目');
      if (data.workingDirectory !== undefined && data.workingDirectory !== '') absolute(data.workingDirectory, 'workingDirectory');
      string(data.name, 'name', true); string(data.goal, 'goal', true);
      for (const key of ['description', 'background', 'constraints', 'decisions', 'deliverables']) string(data[key] ?? '', key);
      if (data.tags !== undefined) strings(data.tags, 'tags');
      const now = Date.now();
      const record = {
        name: data.name.trim(), goal: data.goal.trim(), description: (data.description ?? '').trim(),
        background: (data.background ?? '').trim(), constraints: (data.constraints ?? '').trim(),
        decisions: (data.decisions ?? '').trim(), deliverables: (data.deliverables ?? '').trim(),
      };
      const fieldProvenance = Object.fromEntries(PROVENANCE_FIELDS.filter(field => record[field]).map(field => [field, 'user']));
      const project = {
        id: randomUUID(), identityKey: `manual:${randomUUID()}`, ...record,
        goalConfirmed: false, tasks: [], files: [], sources: [], uncertainties: [], pinned: false, tags: data.tags || [],
        fieldProvenance, resolvedUncertainties: [], auditHistory: [],
        createdAt: now, updatedAt: now, revision: 1, recognitionNotes: [],
        ...(data.workingDirectory !== undefined ? { workingDirectory: data.workingDirectory } : {}),
      };
      validateProject(project);
      const next = clone(this.projects);
      next.push(project);
      await this.persist(next);
      return clone(this.projects);
    });
  }
  async archive(id, archived) {
    if (typeof archived !== 'boolean') fail('archived 必须是布尔值');
    string(id, 'id', true);
    return this.enqueue(async () => {
      await this.load();
      const index = this.projects.findIndex(p => p.id === id);
      if (index < 0) fail('项目不存在，不能归档');
      const next = clone(this.projects);
      const project = { ...next[index] };
      if ((project.archivedAt !== undefined) === archived) return clone(this.projects);
      if (archived) project.archivedAt = Date.now(); else delete project.archivedAt;
      project.updatedAt = Date.now();
      bump(project);
      validateProject(project);
      next[index] = project;
      await this.persist(next);
      return clone(this.projects);
    });
  }
  async remove(id, deleted) {
    if (typeof deleted !== 'boolean') fail('deleted 必须是布尔值');
    string(id, 'id', true);
    return this.enqueue(async () => {
      await this.load();
      const index = this.projects.findIndex(p => p.id === id);
      if (index < 0) fail('项目不存在，不能删除');
      const next = clone(this.projects);
      const project = { ...next[index] };
      if ((project.deletedAt !== undefined) === deleted && (deleted || project.mergedInto === undefined)) return clone(this.projects);
      if (deleted) project.deletedAt = Date.now();
      else { delete project.deletedAt; delete project.mergedInto; }
      project.updatedAt = Date.now();
      bump(project);
      validateProject(project);
      next[index] = project;
      await this.persist(next);
      return clone(this.projects);
    });
  }
  async merge(sourceId, targetId) {
    string(sourceId, 'sourceId', true); string(targetId, 'targetId', true);
    if (sourceId === targetId) fail('不能将项目合并到自身');
    return this.enqueue(async () => {
      await this.load();
      const sourceIndex = this.projects.findIndex(p => p.id === sourceId);
      const targetIndex = this.projects.findIndex(p => p.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) fail('待合并或目标项目不存在');
      if (!active(this.projects[sourceIndex])) fail('来源项目已删除或归档，不能合并');
      if (!active(this.projects[targetIndex])) fail('目标项目已删除或归档，不能接收合并');
      const next = clone(this.projects);
      const source = next[sourceIndex], target = next[targetIndex];
      const merged = mergeEvidence(target, source, new Set());
      const provenance = { ...(target.fieldProvenance || {}) };
      for (const field of PROVENANCE_FIELDS) if (!target[field] && source[field]) provenance[field] = source.fieldProvenance?.[field] || 'unknown';
      // Merging never changes the target's identity or reviewed title/goal.
      Object.assign(merged, { name: target.name, goal: target.goal, description: target.description, updatedAt: Date.now(), fieldProvenance: provenance });
      applyAcceptance(target, merged);
      bump(merged);
      validateProject(merged);
      const removed = { ...source, deletedAt: Date.now(), mergedInto: target.id, updatedAt: Date.now() };
      bump(removed);
      validateProject(removed);
      next[targetIndex] = merged;
      next[sourceIndex] = removed;
      await this.persist(next);
      return clone(this.projects);
    });
  }
  async linkConversation(id, link) {
    const input = clone(link); string(id, 'id', true);
    return this.enqueue(async () => {
      fields(input, ['conversationId', 'sessionId', 'cwd', 'title', 'taskId'], '关联对话');
      string(input.conversationId, 'conversationId', true); absolute(input.cwd, 'cwd'); string(input.title, 'title');
      if (input.sessionId !== undefined) string(input.sessionId, 'sessionId', true);
      if (input.taskId !== undefined) string(input.taskId, 'taskId', true);
      await this.load();
      const project = this.projects.find(project => project.id === id);
      if (!project || !active(project)) fail('只能关联活跃项目');
      if (input.taskId !== undefined && !project.tasks.some(task => task.id === input.taskId)) fail('关联任务不存在');
      if (this.projects.some(project => project.id !== id && project.conversations?.some(link => link.conversationId === input.conversationId))) fail('对话已属于其他项目');
      const next = clone(this.projects), record = next.find(project => project.id === id);
      record.conversations ||= [];
      const resumed = input.sessionId && record.conversations.find(link => link.sessionId === input.sessionId);
      const old = resumed || record.conversations.find(link => link.conversationId === input.conversationId);
      if (old) {
        const merged = { ...old, ...input };
        if (equal(old, merged) && !record.conversations.some(link => link !== old &&
            (link.conversationId === input.conversationId || (input.sessionId && link.sessionId === input.sessionId)))) return clone(this.projects);
        Object.assign(old, merged);
      }
      // A reopened session replaces its old GUI identity, not its task/run history.
      record.conversations = record.conversations.filter(link => link === old ||
        (link.conversationId !== input.conversationId && (!input.sessionId || link.sessionId !== input.sessionId)));
      if (!old) record.conversations.push({ ...input, linkedAt: Date.now() });
      bump(record); record.updatedAt = Date.now(); await this.persist(next);
      return clone(this.projects);
    });
  }
  async recordConversation(conversationId, result) {
    string(conversationId, 'conversationId', true); const input = clone(result);
    return this.enqueue(async () => {
      fields(input, ['status', 'recordedAt', 'messageId', 'excerpt', 'sessionId'], '执行结果');
      if (!['completed', 'failed', 'aborted'].includes(input.status)) fail('执行状态无效');
      if (!Number.isFinite(input.recordedAt) || input.recordedAt < 0) fail('执行时间无效');
      string(input.excerpt, '执行摘要');
      if (input.messageId !== undefined) string(input.messageId, 'messageId');
      if (input.sessionId !== undefined) string(input.sessionId, 'sessionId', true);
      await this.load();
      const project = this.projects.find(project => project.conversations?.some(link => link.conversationId === conversationId));
      if (!project || project.deletedAt !== undefined) return clone(this.projects);
      const old = project.conversations.find(link => link.conversationId === conversationId);
      const { sessionId, ...run } = input; run.verified = false;
      if (old.lastRun && old.lastRun.recordedAt > run.recordedAt) return clone(this.projects);
      if (equal(old.lastRun, run) && (sessionId === undefined || sessionId === old.sessionId)) return clone(this.projects);
      const next = clone(this.projects), record = next.find(value => value.id === project.id);
      const link = record.conversations.find(link => link.conversationId === conversationId);
      link.lastRun = run; if (sessionId !== undefined) link.sessionId = sessionId;
      delete link.reviewedAt;
      bump(record); record.updatedAt = Date.now(); await this.persist(next);
      return clone(this.projects);
    });
  }
  async atomicWrite(file, serialized, beforeReplace) {
    const temp = `${file}.${randomUUID()}.tmp`; let handle;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      handle = await fs.promises.open(temp, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8'); await handle.sync();
      await handle.close(); handle = null;
      await beforeReplace?.();
      await fs.promises.rename(temp, file);
    } catch (error) {
      if (handle) { try { await handle.close(); } catch { /* Preserve the original failure. */ } }
      try { await fs.promises.unlink(temp); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new Error(`${error.message}; 临时文件清理失败: ${cleanup.message}`); }
      throw error;
    }
  }
  async readRegular(file, maxBytes = MAX_STORE_BYTES) {
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail('存储必须是容量限制内的常规文件');
      const raw = await fs.promises.readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > maxBytes) fail('存储读取容量超限');
      return raw;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  parseStore(raw) {
    const saved = JSON.parse(raw); fields(saved, ['version', 'projects'], '项目存储');
    if (saved.version !== 1 || !Array.isArray(saved.projects)) fail('项目存储版本无效');
    const normalized = { version: 1, projects: saved.projects.map(normalizeProject) };
    validateStore(normalized); return normalized.projects;
  }
  validateDraft(saved) {
    fields(saved, ['version', 'scanId', 'candidates', 'analysis', 'coverage', 'projectTasks', 'confirmed', 'reviews'], '审核草稿');
    if (saved.version !== 1) fail('审核草稿版本无效'); string(saved.scanId, 'scanId', true);
    if (!Array.isArray(saved.candidates) || !saved.candidates.length || saved.candidates.length > 10000) fail('审核草稿候选必须非空');
    const candidateIds = new Set();
    for (const candidate of saved.candidates) {
      fields(candidate, [...PROJECT_FIELDS, 'existingProjectId', 'evidence'], '草稿候选');
      validateProject(this.asProject(candidate));
      if (candidate.existingProjectId !== undefined) string(candidate.existingProjectId, 'existingProjectId', true);
      if (candidate.evidence !== undefined) strings(candidate.evidence, 'evidence');
      if (candidateIds.has(candidate.id)) fail('草稿候选重复'); candidateIds.add(candidate.id);
    }
    validateAudit({ ...saved.analysis, scannedAt: 0, coverage: saved.coverage });
    for (const name of ['projectTasks', 'confirmed']) {
      if (!Array.isArray(saved[name]) || saved[name].length > 10000) fail(`草稿 ${name} 无效`);
      const ids = new Set();
      for (const entry of saved[name]) {
        if (!Array.isArray(entry) || entry.length !== 2) fail(`草稿 ${name} entry 无效`);
        string(entry[0], name, true); if (ids.has(entry[0])) fail(`草稿 ${name} 重复`); ids.add(entry[0]);
        if (name === 'projectTasks') strings(entry[1], name);
        else { if (!candidateIds.has(entry[0])) fail('草稿确认候选不存在'); string(entry[1], name, true); }
      }
    }
    const reviews = this.draftReviews(saved.reviews);
    const seen = new Set();
    for (const review of reviews) {
      this.validateReview(review, true);
      if (!candidateIds.has(review.candidateId) || seen.has(review.candidateId)) fail('草稿审核候选无效或重复');
      seen.add(review.candidateId);
    }
    return saved;
  }
  draftReviews(reviews) {
    if (Array.isArray(reviews) && reviews.length <= 10000) return reviews;
    object(reviews, '草稿 reviews');
    if (Object.keys(reviews).length > 10000) fail('草稿审核数量超限');
    return Object.entries(reviews).map(([candidateId, value]) => {
      object(value, '草稿审核');
      if (value.candidateId !== undefined && value.candidateId !== candidateId) fail('草稿审核 ID 不一致');
      return { ...value, candidateId };
    });
  }
  publicDraft(saved) {
    if (!saved) return null;
    return clone({ scanResult: { scanId: saved.scanId, candidates: saved.candidates, analysis: saved.analysis, coverage: saved.coverage }, reviews: saved.reviews });
  }
  async loadReview() {
    if (this.reviewLoaded) { if (this.reviewError) throw this.reviewError; return; }
    try {
      const raw = await this.readRegular(this.reviewPath, 8 * 1024 * 1024);
      if (raw !== null) {
        const saved = this.validateDraft(JSON.parse(raw));
        this.reviewData = saved;
        this.scans.set(saved.scanId, { candidates: clone(saved.candidates), analysis: clone(saved.analysis), coverage: clone(saved.coverage),
          projectTasks: new Map(saved.projectTasks.map(([id, tasks]) => [id, new Set(tasks)])), confirmed: new Map(saved.confirmed) });
      }
      this.reviewLoaded = true;
    } catch (error) {
      this.reviewLoaded = true; this.reviewError = new Error(`审核草稿损坏或读取失败，显式丢弃前禁止覆盖: ${error.message}`); throw this.reviewError;
    }
  }
  async reviewDraft() {
    const result = this.reviewQueue.then(async () => { await this.loadReview(); return this.publicDraft(this.reviewData); });
    this.reviewQueue = result.catch(() => {}); return result;
  }
  async saveReviewDraft(draft) {
    const input = clone(draft);
    const result = this.reviewQueue.then(async () => {
      if (input === null) {
        try { await fs.promises.unlink(this.reviewPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        this.reviewData = null; this.reviewLoaded = true; this.reviewError = null; this.lastJob = null;
        return null;
      }
      await this.loadReview(); fields(input, ['scanResult', 'reviews'], '审核草稿输入');
      object(input.scanResult, 'scanResult'); string(input.scanResult.scanId, 'scanId', true);
      const scan = this.scans.get(input.scanResult.scanId);
      if (!scan || !scan.candidates.length) fail('审核草稿扫描不存在或候选为空');
      const saved = this.validateDraft({ version: 1, scanId: input.scanResult.scanId, candidates: clone(scan.candidates), analysis: clone(scan.analysis), coverage: clone(scan.coverage),
        projectTasks: [...scan.projectTasks].map(([id, tasks]) => [id, [...tasks]]), confirmed: [...scan.confirmed], reviews: input.reviews });
      const serialized = JSON.stringify(saved);
      if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) fail('审核草稿容量超过 8MB');
      await this.atomicWrite(this.reviewPath, serialized);
      this.reviewData = saved;
      if (this.lastJob?.result?.scanId === saved.scanId) this.lastJob = null;
      return this.publicDraft(saved);
    });
    this.reviewQueue = result.catch(() => {}); return result;
  }
  async storageInfo() {
    await this.writeQueue;
    let loadError;
    try { await this.load(); } catch (error) { loadError = error.message; }
    let backupAvailable = false;
    try { const raw = await this.readRegular(`${this.filePath}.bak`); if (raw !== null) { this.parseStore(raw); backupAvailable = true; } } catch { /* Never silently restore invalid backups. */ }
    let bytes = Buffer.byteLength(this.diskSnapshot || '');
    try { const stat = await fs.promises.lstat(this.filePath); if (stat.isFile() && !stat.isSymbolicLink()) bytes = stat.size; } catch { /* Preserve the actionable load error. */ }
    return { bytes, maxBytes: MAX_STORE_BYTES, projects: this.projects?.length ?? 0, maxProjects: 10000,
      deletedProjects: this.projects?.filter(project => project.deletedAt !== undefined).length ?? 0, backupAvailable,
      ...(loadError ? { loadError } : {}) };
  }
  async purge(id) {
    string(id, 'id', true);
    return this.enqueue(async () => {
      await this.load(); const project = this.projects.find(project => project.id === id);
      if (!project || project.deletedAt === undefined) fail('只能彻底清理已删除项目');
      await this.persist(this.projects.filter(project => project.id !== id)); return clone(this.projects);
    });
  }
  async reload() {
    if (this.scanBusy) fail('Projects scan busy：扫描中不能重载');
    return this.enqueue(async () => {
      if (this.scanBusy) fail('Projects scan busy：扫描中不能重载');
      ++this.loadGeneration; this.loadPromise = null;
      const raw = await this.readSnapshot();
      const projects = raw === null ? [] : this.parseStore(raw);
      ++this.loadGeneration;
      this.projects = projects; this.diskSnapshot = raw; this.loadError = null; this.loadPromise = null;
      this.plans.clear(); return clone(this.projects);
    });
  }
  async restoreBackup() {
    if (this.scanBusy) fail('Projects scan busy：扫描中不能恢复');
    return this.enqueue(async () => {
      if (this.scanBusy) fail('Projects scan busy：扫描中不能恢复');
      const raw = await this.readRegular(`${this.filePath}.bak`);
      if (raw === null) fail('项目备份不存在');
      const projects = this.parseStore(raw);
      const originalStat = async () => {
        try {
          const stat = await fs.promises.lstat(this.filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) fail('恢复拒绝目录或符号链接，请人工处理项目存储路径后重试');
          return stat;
        } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      };
      const original = await originalStat();
      const unchanged = async () => {
        const current = await originalStat();
        if (original === null ? current !== null : current === null ||
            ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode'].some(key => original[key] !== current[key])) {
          fail('恢复期间原文件已被外部修改，禁止覆盖');
        }
      };
      // Preserve original bytes without readFile's store-size guard or unbounded memory.
      // Never move/delete the live path: write failure needs no destructive rollback.
      if (original !== null) {
        await fs.promises.copyFile(this.filePath, `${this.filePath}.${randomUUID()}.corrupt`, fs.constants.COPYFILE_EXCL);
        await unchanged();
      }
      await this.atomicWrite(this.filePath, raw, unchanged);
      ++this.loadGeneration;
      this.projects = projects; this.diskSnapshot = raw; this.loadError = null; this.loadPromise = null; this.plans.clear();
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
