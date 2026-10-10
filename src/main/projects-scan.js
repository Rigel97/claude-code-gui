const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxScanBytes: 128 * 1024 * 1024,
  maxCandidates: 100,
  maxCandidateMessages: 2000,
  maxFiles: 1000,
  maxDirectories: 500,
  maxMessages: 50000,
  maxGuiSessions: 500,
  maxTasks: 500,
  maxWarnings: 200,
});
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
// Keep meaningful punctuation (C++ vs C, paths, version numbers) to avoid false merges.
const normalize = value => String(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[。.!！]+$/g, '');
const TITLE_PREFIX = /^(?:#{1,6}\s*)?(?:项目目标|项目标题|任务目标|任务标题|项目|任务|目标|需求|goal|objective|project|task)\s*[:：]\s*/i;
const goalText = goal => String(goal).trim().replace(TITLE_PREFIX, '').replace(/^(?:(?:请帮我|请直接|请协助我|请你|请|帮我|麻烦你|麻烦|我想要|我想|我需要|我要|我们要|我希望|希望你|希望|需要你|需求是|需求为|继续)\s*|(?:please|help me|i want to|i need to|continue to)\s+)+/i, '');
const ACTION = /^(?:开发|构建|搭建|实现|建设|制作|设计|完成|重构|迁移|打造|添加|增加|build\b|develop\b|implement\b|create\b|refactor\b|migrate\b|add\b)\s*(.+)$/i;
// Only the action/article may differ. Context, punctuation and the entire subject must match.
const goalSubject = goal => normalize(goalText(goal).replace(/^(?:开发|构建|搭建|建设|打造|build\b|develop\b|create\b)\s*/i, '').replace(/^(?:一个|一套|a\s+|an\s+)/i, ''));
const directoryScope = cwd => typeof cwd === 'string' && !cwd.includes('\0') && path.isAbsolute(cwd) ? path.resolve(cwd) : '';
// Mixed or missing directories cannot establish a strong automatic association.
const projectScope = project => {
  const scopes = new Set(project.sources.map(source => directoryScope(source.cwd)));
  return scopes.size === 1 && !scopes.has('') ? [...scopes][0] : '';
};
const sameDirectory = (a, b) => Boolean(projectScope(a)) && projectScope(a) === projectScope(b);
const sameGoal = (a, b) => sameDirectory(a, b) && goalSubject(a.goal) === goalSubject(b.goal);
function similarGoal(a, b) {
  if (!sameDirectory(a, b)) return false;
  const left = goalSubject(a.goal), right = goalSubject(b.goal);
  if (left === right || Math.min(left.length, right.length) < 6) return false;
  const grams = text => new Set(Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2)));
  const x = grams(left), y = grams(right);
  const common = [...x].filter(g => y.has(g)).length;
  return common >= 4 && 2 * common / (x.size + y.size) >= 0.75;
}
const identity = (goal, scope = '') => `goal:${hash(`${scope || 'unknown'}:${goalSubject(goal)}`)}`;
const statuses = new Set(['pending', 'in_progress', 'completed']);
const clip = (value, size = 1000) => String(value || '').slice(0, size);
const unique = values => [...new Set(values)];
const errorText = error => `${error.code || 'ERROR'}: ${error.message}`;

function warn(coverage, limits, message) {
  // Global omissions can hide later updates to any retained goal; local damage is tracked separately.
  if (/^(?:GUI 会话数量|GUI 消息|GUI 消息总读取量|扫描总读取量|消息数量|CLI 目录数量|CLI 文件或消息数量).*达到.*上限/.test(message)) coverage.incomplete = true;
  if (coverage.warnings.length < limits.maxWarnings) coverage.warnings.push(message);
  else if (!coverage.warnings.at(-1)?.startsWith('反馈数量')) coverage.warnings.push('反馈数量达到上限，后续警告未逐条列出；扫描结果不完整。');
}
function blocksText(blocks) {
  if (typeof blocks === 'string') return blocks;
  return Array.isArray(blocks) ? blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : '';
}
function resultText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return blocksText(value);
  return value && typeof value === 'object' ? JSON.stringify(value) : '';
}
const validId = value => (typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0')) || (typeof value === 'number' && Number.isFinite(value));
function eventMetadata(id, sessionId, cwd, fallbackId, fallbackSession) {
  const invalid = (id !== undefined && !validId(id)) || (sessionId !== undefined && !validId(sessionId)) ||
    (cwd !== undefined && (typeof cwd !== 'string' || cwd.includes('\0')));
  return {
    id: validId(id) ? String(id) : fallbackId,
    sessionId: validId(sessionId) ? String(sessionId) : fallbackSession,
    cwd: typeof cwd === 'string' && !cwd.includes('\0') ? cwd : '',
    ...(invalid ? { incomplete: true, metadataWarning: '消息元数据 ID/sessionId/cwd 无效，已安全回退；关联 unknown，状态待确认。' } : {}),
  };
}
function cliEvent(row, file, fallbackId, line) {
  // Only genuine top-level messages; never nested subagent, summary or synthetic user prompts.
  if (!row || row.parent_tool_use_id || row.isSidechain || row.isMeta || row.isCompactSummary || row.isSynthetic) return null;
  if (!['user', 'assistant'].includes(row.type) || !row.message || (row.message.role && row.message.role !== row.type)) return null;
  const content = row.message.content;
  if (typeof content !== 'string' && !Array.isArray(content)) return null;
  const tools = Array.isArray(content) && row.type === 'assistant' ? content.filter(b => b?.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input, success: false })) : [];
  const results = Array.isArray(content) ? content.filter(b => b?.type === 'tool_result').map(b => ({ id: b.tool_use_id, content: b.content, error: b.is_error === true })) : [];
  return {
    ...eventMetadata(row.uuid ?? row.message.id, row.sessionId ?? row.session_id, row.cwd, `line:${line}`, fallbackId),
    kind: 'claude', path: file, title: '', role: row.type,
    text: blocksText(content), tools, results, order: line,
    timestamp: typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : line,
    timestampKnown: typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)),
  };
}
function guiEvent(message, session) {
  if (!message || message.isMeta || message.isCompactSummary || message.isSynthetic || message.isSidechain || message.parent_tool_use_id || !['user', 'assistant'].includes(message.role) || !Array.isArray(message.blocks)) return null;
  return {
    ...eventMetadata(message.id, session.sessionId, session.cwd, undefined, `gui:${validId(session.id) ? session.id : 'unknown'}`),
    kind: 'gui', title: typeof session.title === 'string' ? session.title : '',
    role: message.role, timestamp: Number.isFinite(message.timestamp) ? message.timestamp : 0,
    timestampKnown: Number.isFinite(message.timestamp),
    text: message.blocks.filter(b => b?.kind === 'text').map(b => b.text || '').join('\n'),
    // Ignore children: their tools belong to delegated/subagent executions.
    tools: message.role === 'assistant' ? message.blocks.filter(b => b?.kind === 'tool_use').map(b => ({
      id: b.toolId, name: b.toolName, input: b.input,
      success: b.status === 'done' && b.result !== undefined, error: b.status === 'error', result: b.result,
    })) : [], results: [],
  };
}

async function readJsonl(file, fallbackId, events, coverage, limits, budget) {
  let handle;
  const skippedBefore = coverage.skipped;
  let incomplete = false;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile()) { coverage.skipped++; warn(coverage, limits, `跳过非常规文件 ${file}`); return; }
    if (stat.size > limits.maxFileBytes) { coverage.skipped++; warn(coverage, limits, `文件过大，跳过 ${file}（${stat.size} bytes，上限 ${limits.maxFileBytes}）`); return; }
    coverage.claudeSessions++;
    // Bounded chunks and bounded line buffers also protect against a file growing while scanned.
    const buffer = Buffer.alloc(Math.min(64 * 1024, limits.maxLineBytes));
    let parts = [], lineBytes = 0, total = 0, line = 0, oversized = false;
    const consume = () => {
      line++;
      if (oversized) { coverage.skipped++; warn(coverage, limits, `行过大 ${file}:${line}，上限 ${limits.maxLineBytes} bytes`); }
      else if (lineBytes) {
        const raw = Buffer.concat(parts).toString('utf8').trim();
        if (raw) {
          let parsed;
          try { parsed = JSON.parse(raw); }
          catch (error) { coverage.skipped++; warn(coverage, limits, `JSONL 坏行 ${file}:${line}: ${error.message}`); }
          if (parsed !== undefined) {
            const event = cliEvent(parsed, file, fallbackId, line);
            if (event) {
              if (event.metadataWarning) warn(coverage, limits, `${event.metadataWarning} ${file}:${line}`);
              events.push(event);
            }
            else if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
              (['user', 'assistant'].includes(parsed.type) && !parsed.isSidechain && !parsed.isMeta && !parsed.parent_tool_use_id &&
                (!parsed.message || (typeof parsed.message.content !== 'string' && !Array.isArray(parsed.message.content))))) {
              coverage.skipped++; warn(coverage, limits, `JSONL 消息结构无效 ${file}:${line}，已跳过`);
            }
          }
        }
      }
      parts = []; lineBytes = 0; oversized = false;
    };
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      budget.bytes += bytesRead;
      if (budget.bytes > limits.maxScanBytes) { coverage.skipped++; warn(coverage, limits, `扫描总读取量达到上限 ${limits.maxScanBytes} bytes，结果不完整`); return; }
      if (total > limits.maxFileBytes) { incomplete = true; coverage.skipped++; warn(coverage, limits, `读取中达到文件大小上限 ${file}，结果不完整`); return; }
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] !== 10) continue;
        const piece = buffer.subarray(start, i);
        lineBytes += piece.length;
        if (lineBytes > limits.maxLineBytes) { oversized = true; parts = []; }
        if (!oversized) parts.push(Buffer.from(piece));
        consume(); start = i + 1;
        if (events.length >= limits.maxMessages) { incomplete = true; warn(coverage, limits, `消息数量达到上限 ${limits.maxMessages}，扫描提前停止`); return; }
      }
      const piece = buffer.subarray(start, bytesRead);
      lineBytes += piece.length;
      if (lineBytes > limits.maxLineBytes) { oversized = true; parts = []; }
      if (!oversized && piece.length) parts.push(Buffer.from(piece));
    }
    if (lineBytes || oversized) consume();
  } catch (error) {
    coverage.skipped++;
    warn(coverage, limits, `无法读取 CLI 文件 ${file}: ${errorText(error)}`);
  } finally {
    if (incomplete || coverage.skipped > skippedBefore) {
      for (const event of events) if (event.path === file) event.incomplete = true;
    }
    if (handle) {
      try { await handle.close(); }
      catch (error) { warn(coverage, limits, `关闭 CLI 文件失败 ${file}: ${errorText(error)}`); }
    }
  }
}

async function scanEvents(data, root, limits) {
  const coverage = { guiSessions: 0, claudeSessions: 0, skipped: 0, roots: [root], warnings: [
    `只读扫描范围：${root}/*/*.jsonl；仅顶层用户/助手消息，不递归 subagents，不读取其他配置目录。`,
    `限制：最多 ${limits.maxDirectories} 个目录、${limits.maxFiles} 个文件、${limits.maxGuiSessions} 个 GUI 条目、${limits.maxMessages} 条消息；总读取 ${limits.maxScanBytes} bytes，单文件 ${limits.maxFileBytes} bytes，单行 ${limits.maxLineBytes} bytes；最多 ${limits.maxCandidates} 个候选，每目标 ${limits.maxCandidateMessages} 条消息、${limits.maxTasks} 个任务。`,
  ] };
  const events = [];
  const budget = { bytes: 0 };
  const guiSessions = new Set();
  // When the cap is reached, keep active conversations before older archives.
  const newestFirst = (a, b) => {
    const time = session => Number.isFinite(session?.updatedAt) ? session.updatedAt : (Array.isArray(session?.messages) ? session.messages.reduce((latest, message) => Math.max(latest, Number.isFinite(message?.timestamp) ? message.timestamp : 0), 0) : 0);
    const id = session => validId(session?.sessionId) ? String(session.sessionId) : validId(session?.id) ? String(session.id) : '';
    return time(b) - time(a) || id(a).localeCompare(id(b), 'en');
  };
  const capped = data.sessions.length + data.conversations.length > limits.maxGuiSessions;
  const active = (capped ? [...data.conversations].sort(newestFirst) : data.conversations).slice(0, limits.maxGuiSessions);
  const archives = capped ? [...data.sessions].sort(newestFirst) : data.sessions;
  const sessions = [...archives.slice(0, Math.max(0, limits.maxGuiSessions - active.length)), ...active];
  if (data.sessions.length + data.conversations.length > limits.maxGuiSessions) warn(coverage, limits, 'GUI 会话数量达到上限，部分会话未扫描');
  for (const session of sessions.slice(0, limits.maxGuiSessions)) {
    if (!session || typeof session !== 'object' || (typeof session.sessionId !== 'string' && typeof session.id !== 'string') || (!session.sessionId && !session.id) || !Array.isArray(session.messages)) {
      coverage.skipped++; warn(coverage, limits, 'GUI 会话结构无效，已跳过'); continue;
    }
    const sessionId = validId(session.sessionId) ? String(session.sessionId) : `gui:${validId(session.id) ? session.id : 'unknown'}`;
    const skippedBefore = coverage.skipped;
    guiSessions.add(sessionId);
    if (session.messages.length > limits.maxMessages) warn(coverage, limits, 'GUI 消息达到数量上限，结果不完整');
    for (const message of [...session.messages.slice(0, limits.maxMessages), ...(session.streamingMessage ? [session.streamingMessage] : [])]) {
      if (events.length >= limits.maxMessages) { warn(coverage, limits, 'GUI 消息达到数量上限，结果不完整'); break; }
      // Payload is already IPC-cloned; bound extraction size before retaining it.
      let serialized;
      try { serialized = JSON.stringify(message); }
      catch (error) { coverage.skipped++; warn(coverage, limits, `GUI 消息无效：${error.message}`); continue; }
      if (!serialized || Buffer.byteLength(serialized) > limits.maxLineBytes) { coverage.skipped++; warn(coverage, limits, `GUI 消息过大或无效 ${sessionId}`); continue; }
      budget.bytes += Buffer.byteLength(serialized);
      if (budget.bytes > limits.maxScanBytes) { warn(coverage, limits, 'GUI 消息总读取量达到上限，结果不完整'); break; }
      const event = guiEvent(message, session);
      if (!event && !message?.isMeta && !message?.isCompactSummary && !message?.isSynthetic && !message?.isSidechain && !message?.parent_tool_use_id) {
        coverage.skipped++; warn(coverage, limits, `GUI 消息结构无效 ${sessionId}，已跳过`);
      }
      if (event) {
        if (event.metadataWarning) warn(coverage, limits, `${event.metadataWarning} GUI ${sessionId}`);
        event.order = events.length;
        events.push(event);
      }
    }
    if (coverage.skipped > skippedBefore) for (const event of events) if (event.kind === 'gui' && event.sessionId === sessionId) event.incomplete = true;
    if (budget.bytes > limits.maxScanBytes || events.length >= limits.maxMessages) break;
  }
  if (events.length >= limits.maxMessages) warn(coverage, limits, 'GUI 消息达到数量上限，后续会话未完整扫描');
  coverage.guiSessions = guiSessions.size;
  let files = 0, directories = 0;
  try {
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('扫描根目录必须是真实目录，禁止跟随符号链接');
    const sortedEntries = async directory => {
      const entries = await fs.promises.opendir(directory);
      const result = [];
      for await (const entry of entries) result.push(entry);
      return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    };
    for (const directory of await sortedEntries(root)) {
      if (budget.bytes > limits.maxScanBytes || events.length >= limits.maxMessages) break;
      if (!directory.isDirectory()) continue;
      if (++directories > limits.maxDirectories) { warn(coverage, limits, 'CLI 目录数量达到上限，结果不完整'); break; }
      try {
        for (const entry of await sortedEntries(path.join(root, directory.name))) {
          if (!entry.name.endsWith('.jsonl')) continue;
          if (!entry.isFile()) { coverage.skipped++; warn(coverage, limits, `跳过链接或非常规 JSONL ${entry.name}`); continue; }
          if (++files > limits.maxFiles || events.length >= limits.maxMessages) { warn(coverage, limits, 'CLI 文件或消息数量达到上限，结果不完整'); break; }
          await readJsonl(path.join(root, directory.name, entry.name), entry.name.slice(0, -6), events, coverage, limits, budget);
          if (budget.bytes > limits.maxScanBytes) break;
        }
      } catch (error) { coverage.skipped++; warn(coverage, limits, `无法扫描 CLI 目录 ${directory.name}: ${errorText(error)}`); }
      if (files > limits.maxFiles || events.length >= limits.maxMessages || budget.bytes > limits.maxScanBytes) break;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') coverage.skipped++;
    warn(coverage, limits, `CLI 扫描目录不可用 ${root}: ${errorText(error)}`);
  }
  coverage.claudeSessions = new Set(events.filter(event => event.kind === 'claude').map(event => event.sessionId)).size;
  return { events, coverage };
}

function explicitGoal(text) {
  // A rewritten conversation summary is not a new original user goal.
  if (/(?:\[Previous conversation summary\]|<summary>|对话摘要|会话摘要|conversation summary)/i.test(text)) return null;
  const lines = String(text).replace(/```[\s\S]*?```/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const labeled = TITLE_PREFIX.test(line);
    if (/^(?:>|[-*]\s|\d+[.)、])/.test(line) || line.length < 8 || line.length > 2000) continue;
    // Never promote an explicitly temporary change or a question, even with a task heading.
    if (/(临时|顺手|小任务|改一个|改一下|修改.{0,12}(?:按钮|颜色|文案|错别字)|解释|是什么|什么是|为什么|怎么|如何|翻译|能否|可否|[?？]|temporary|quick question|explain|what is|how to|how do|can you)/i.test(line)) continue;
    const target = goalText(line);
    if (/^(?:不要|无需|不需要|别|do not|don't)/i.test(target)) continue;
    const action = target.match(ACTION);
    const contextual = target.match(/^(?:为|给|在)(.+?)(?:开发|构建|搭建|实现|建设|制作|设计|打造|添加|增加)(.+)$/);
    if (!action && !contextual && !labeled) continue;
    const subject = action ? action[1] : contextual ? `${contextual[1]} ${contextual[2]}` : target;
    if (/(?:添加|增加|实现|开发).{0,8}(?:一个)?(?:按钮|颜色|文案|错别字)(?:[。.!！]|$)/i.test(target)) continue;
    if (!/(项目|系统|平台|应用|工具|网站|流程|模块|后端|前端|服务|客户端|看板|中心|评测|可视化|会员功能|分析|报告|方案|迁移|重构|app\b|application\b|system\b|platform\b|website\b|service\b|dashboard\b|workflow\b|backend\b|frontend\b|api\b|tool\b)/i.test(subject)) continue;
    if (/^(?:(?:一个|一套|新的|完整的|这个|该)|(?:a|an|the|new|complete)\s+)*(?:项目|系统|平台|应用|工具|网站|代码|后端|前端|服务|app|application|system|platform|website|tool|backend|frontend|service|api)(?:并测试|和测试|\s+with tests)?[。.!！]?$/i.test(subject)) continue;
    return line;
  }
  return null;
}
function numberedSteps(text) {
  return String(text).replace(/```[\s\S]*?```/g, '').split('\n').map(line => line.match(/^\s*(?:\d{1,2}[.)、]|[一二三四五六七八九十]+[、.)])\s*(\S.*)$/)?.[1]).filter(Boolean);
}
const PROJECT_LABELS = Object.freeze({
  项目背景: 'background', 需求背景: 'background', 背景: 'background',
  约束条件: 'constraints', 约束: 'constraints', 关键决策: 'decisions', 决策: 'decisions',
  预期交付物: 'deliverables', 交付物: 'deliverables', 验收目标: 'deliverables',
});
const IO_LABELS = Object.freeze({ 输入: 'inputs', 输出: 'outputs' });
// Read only explicit sections; unrelated headings/fields terminate the previous section.
// Fenced examples are never evidence, even if they contain matching labels.
function labeledSections(text, labels, project = false) {
  const sections = [];
  let current = null, fence = null, taskLevel = null;
  const flush = () => {
    if (current) {
      const value = current.lines.join('\n').trim();
      if (value) sections.push({ field: current.field, value });
    }
    current = null;
  };
  for (const line of String(text || '').split('\n')) {
    // Markdown indented code and quotations cannot introduce or extend trusted fields.
    if (/^(?: {4}|\t|\s*>)/.test(line)) { flush(); continue; }
    const trimmed = line.trim();
    const marker = trimmed.match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = trimmed.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
    const body = (heading ? heading[2] : trimmed).replace(/^\*\*(.+?)\*\*(?=\s*[:：]|$)/, '$1');
    const label = body.match(/^([^:：]{1,30})\s*[:：]\s*(.*)$/);
    const name = (label ? label[1] : body).trim();
    const field = Object.hasOwn(labels, name) ? labels[name] : null;
    const knownBoundary = Object.hasOwn(PROJECT_LABELS, name) || Object.hasOwn(IO_LABELS, name);
    if (heading || label || knownBoundary || explicitGoal(trimmed)) {
      flush();
      if (project && heading) {
        const level = heading[1].length;
        if (taskLevel !== null && level <= taskLevel) taskLevel = null;
        if (/^(?:任务(?:列表|拆解|详情|说明|计划)?|Task(?:Create|Update)?)(?:\s|[:：]|$)/i.test(body)) taskLevel = level;
      }
      if (field && (!project || taskLevel === null)) current = { field, lines: label && label[2] ? [label[2]] : [] };
    } else if (current) current.lines.push(line);
  }
  flush();
  return sections;
}
function sourceFor(event) {
  return {
    id: `src:${hash(`${event.kind}:${event.sessionId}:${event.id}:${event.path || ''}:${directoryScope(event.cwd)}`)}`,
    kind: event.kind, sessionId: String(event.sessionId), title: clip(event.title, 300), cwd: event.cwd,
    ...(event.path ? { path: event.path } : {}), messageId: String(event.id || ''),
    excerpt: clip(event.text || event.tools.map(t => `${t.name}: ${JSON.stringify(t.input)}`).join('\n') || event.results.map(r => resultText(r.content)).join('\n')),
  };
}
function taskFor(name, sourceId, key = normalize(name), description = '', prefix = 'task') {
  return { id: `${prefix}:${hash(key)}`, name: clip(name, 500), description: clip(description, 2000), status: 'pending', inputs: [], outputs: [], dependsOn: [], dependencyNote: '依赖未记录，待确认（未连线不代表没有依赖）', sourceIds: [sourceId], records: [] };
}
function normalizeToolInput(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { return { input: {}, inputError: 'input JSON 解析失败' }; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { input: {}, inputError: 'input 必须是 JSON 对象，不能是 primitive/数组' };
  return { input: value };
}
function taskInputError(name, input) {
  if (name === 'TodoWrite') {
    if (!Array.isArray(input.todos) || !input.todos.every(todo => todo && typeof todo === 'object' && !Array.isArray(todo) &&
      typeof todo.content === 'string' && todo.content.trim() && statuses.has(todo.status))) return 'todos 任务结构或 status 无效';
  } else {
    if (input.status !== undefined && !statuses.has(input.status)) return '任务 status 无效/不支持';
    if (name === 'TaskCreate' && (typeof input.subject !== 'string' || !input.subject.trim())) return 'subject 任务结构无效';
    if (name === 'TaskUpdate' && !validId(input.taskId)) return 'taskId 无效';
    if (input.subject !== undefined && (typeof input.subject !== 'string' || !input.subject.trim())) return 'subject 无效';
    if (input.description !== undefined && typeof input.description !== 'string') return 'description 无效';
    for (const field of ['addBlockedBy', 'addBlocks']) if (input[field] !== undefined &&
      (!Array.isArray(input[field]) || !input[field].every(validId))) return `${field} 依赖结构无效`;
  }
  return '';
}
function successfulTools(events) {
  const results = new Map(), errors = new Set();
  for (const event of events) for (const result of event.results) {
    if (typeof result.id !== 'string') continue;
    const key = `${directoryScope(event.cwd)}:${event.sessionId}:${result.id}`;
    if (result.error) errors.add(key);
    results.set(key, { ...result, event });
  }
  const seen = new Map();
  for (const event of events) for (const tool of event.tools) {
    if (typeof tool.id !== 'string' || typeof tool.name !== 'string') continue;
    const key = `${directoryScope(event.cwd)}:${event.sessionId}:${tool.id}`;
    if (tool.error) errors.add(key);
    const result = results.get(key);
    const success = !tool.error && (result ? !result.error : tool.success);
    const item = { ...tool, ...normalizeToolInput(tool.input), success, result: result ? result.content : tool.result, resultEvent: result?.event || (tool.success ? event : undefined), event };
    const previous = seen.get(key);
    // Use CLI per-line ordering instead of the GUI's aggregated assistant-message timestamp.
    if (!previous) seen.set(key, item);
    else if ((event.kind === 'claude' && previous.event.kind !== 'claude') ||
      (event.kind === previous.event.kind && (success || !previous.success))) {
      seen.set(key, { ...item, success: success || previous.success, result: item.result ?? previous.result, resultEvent: item.resultEvent || previous.resultEvent });
    } else if (success && !previous.success) {
      // A GUI success can verify a CLI call whose result has not yet been flushed to JSONL.
      seen.set(key, { ...previous, success: true, result: item.result, resultEvent: item.resultEvent });
    }
  }
  return [...seen.entries()].map(([key, call]) => ({ ...call, success: call.success && !errors.has(key) }))
    .sort((a, b) => a.event.sessionId === b.event.sessionId && a.event.kind === b.event.kind ? a.event.order - b.event.order : a.event.timestamp - b.event.timestamp);
}
function createdTaskId(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const id = content.task?.id || content.taskId || content.id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  const text = resultText(content);
  try {
    const parsed = JSON.parse(text);
    const id = parsed && typeof parsed === 'object' ? (parsed.task?.id || parsed.taskId || parsed.id) : undefined;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  } catch { /* Text success results are supported below; no state is guessed from prose. */ }
  return text.match(/Task\s+#([\w-]+)\s+created\s+successfully/i)?.[1] || null;
}
function acyclic(tasks) {
  const degrees = new Map(tasks.map(t => [t.id, t.dependsOn.length]));
  const outgoing = new Map(tasks.map(t => [t.id, []]));
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!outgoing.has(dep) || dep === task.id) return false;
    outgoing.get(dep).push(task.id);
  }
  const queue = tasks.filter(t => !t.dependsOn.length).map(t => t.id);
  for (let i = 0; i < queue.length; i++) for (const id of outgoing.get(queue[i])) {
    degrees.set(id, degrees.get(id) - 1);
    if (!degrees.get(id)) queue.push(id);
  }
  return queue.length === tasks.length;
}

function candidateFor(goal, events, limits, coverage, scope) {
  let truncated = events.length > limits.maxCandidateMessages;
  let damaged = coverage.incomplete || events.some(e => e.incomplete);
  if (truncated) {
    warn(coverage, limits, `目标消息数量达到上限 ${limits.maxCandidateMessages}: ${clip(goal, 100)}；仅提取前部证据，状态待审核`);
    events = events.slice(0, limits.maxCandidateMessages);
  }
  const sources = [...new Map(events.map(e => { const s = sourceFor(e); return [s.id, s]; })).values()];
  const uncertainties = ['目标及项目字段仅保留用户显式原文；未标注的背景、约束、决策和交付验收不自动推断。', '助手宣称完成不等于项目完成；goalConfirmed 需要用户确认。'];
  const evidence = [`明确用户目标（原文标题/需求前置或行动目标识别；短问答/临时修改过滤）：${clip(goal)}`];
  if (!directoryScope(scope)) uncertainties.push('工作目录 unknown：未自动合并跨会话目标或关联已有项目，需要人工审核。');
  if (events.some(event => event.followup)) uncertainties.push('跟进反馈或已知 TaskUpdate 保守归属原目标，关联 unknown，待用户审核；未据此推断目标完成。');
  for (const event of events) {
    const original = event.role === 'user' ? explicitGoal(event.text) : null;
    if (original && original !== goal) evidence.push(`相同完整目标主体保守关联的用户原文：${clip(original)}（source ${sourceFor(event).id}）；未按相似度合并。`);
  }
  const projectValues = Object.fromEntries(['background', 'constraints', 'decisions', 'deliverables'].map(field => [field, new Map()]));
  for (const event of events) {
    if (event.role !== 'user' || /^(?:\[Previous conversation summary\]|<summary>|对话摘要|会话摘要|conversation summary)/i.test(event.text.trim())) continue;
    const sourceId = sourceFor(event).id;
    const sections = labeledSections(event.text, PROJECT_LABELS, true);
    for (const { field, value } of sections) {
      const values = projectValues[field];
      // Case and punctuation can be meaningful constraints; deduplicate exact raw text only.
      if (!values.has(value)) values.set(value, value);
      evidence.push(`用户显式 ${field} 原文：${value}（source ${sourceId}）`);
    }
    if (sections.length) {
      const source = sources.find(source => source.id === sourceId);
      // Preserve labeled originals beyond the normal excerpt clip, including after confirm.
      source.excerpt = sections.map(({ field, value }) => `${field} 用户显式原文：${value}`).join('\n\n') + '\n\n消息摘录：' + source.excerpt;
    }
  }
  const projectFields = Object.fromEntries(Object.entries(projectValues).map(([field, values]) => {
    if (values.size > 1) uncertainties.push(`${field} 有多段不同来源/段落原文，可能补充或矛盾；全部保留，需用户确认，不自动选择。`);
    return [field, [...values.values()].join('\n\n')];
  }));
  const tasks = new Map(), cliIds = new Map(), files = new Map();
  const toolCalls = successfulTools(events);
  const activeAtCall = new Map();
  const sessionStatuses = new Map();
  const liveTodoIds = new Map();
  const setStatus = (task, call, status) => {
    if (!sessionStatuses.has(call.event.sessionId)) sessionStatuses.set(call.event.sessionId, new Map());
    sessionStatuses.get(call.event.sessionId).set(task.id, status);
    task.status = status;
  };
  let structured = false;
  let multiStep = false;
  const createdIds = new Map();
  const put = (name, sourceId, key, description, prefix) => {
    const task = taskFor(name, sourceId, key, description, prefix);
    const existing = tasks.get(task.id);
    if (existing) { existing.sourceIds = unique([...existing.sourceIds, sourceId]); return existing; }
    if (tasks.size >= limits.maxTasks) { truncated = true; warn(coverage, limits, `目标任务数量达到上限 ${limits.maxTasks}: ${clip(goal, 100)}`); return null; }
    tasks.set(task.id, task); return task;
  };
  for (const call of toolCalls) {
    const sourceId = sourceFor(call.event).id;
    const input = call.input;
    const resultSourceId = call.resultEvent ? sourceFor(call.resultEvent).id : sourceId;
    const remember = task => {
      if (task) task.sourceIds = unique([...task.sourceIds, sourceId, resultSourceId]);
    };
    if (!call.success) {
      if (['TodoWrite', 'TaskCreate', 'TaskUpdate'].includes(call.name)) uncertainties.push(`${call.name} ${call.id} 没有成功结果，未采信状态或任务结构。`);
      continue;
    }
    const taskTool = ['TodoWrite', 'TaskCreate', 'TaskUpdate'].includes(call.name);
    const ioTool = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(call.name);
    const inputError = taskTool || ioTool ? call.inputError || (taskTool ? taskInputError(call.name, input) : '') : '';
    if (inputError) {
      if (taskTool) damaged = true;
      call.invalidInput = true;
      const warning = `evidence warning：工具参数 ${call.name} ${call.id} 无效：${inputError}；${taskTool ? '目标 evidence damaged，任务统一 pending 待确认' : 'IO unknown，未采信参数，不改变任务状态'}（source ${sourceId}，result source ${resultSourceId}）`;
      evidence.push(warning); uncertainties.push(warning); warn(coverage, limits, warning);
      // Invalid task mutations cannot leave a stale active task for later file attribution.
      if (taskTool) sessionStatuses.get(call.event.sessionId)?.clear();
      continue;
    }
    if (call.name === 'TodoWrite') {
      structured = true;
      if (new Set(input.todos.map(t => normalize(t.content))).size >= 2) multiStep = true;
      evidence.push(`成功 TodoWrite：${input.todos.length} 个任务（tool ${call.id}；source ${sourceId}，result source ${resultSourceId}）`);
      const previousTodos = liveTodoIds.get(call.event.sessionId) || [];
      const currentTodos = input.todos.map(todo => taskFor(todo.content, sourceId).id);
      for (const id of previousTodos) if (!currentTodos.includes(id)) {
        sessionStatuses.get(call.event.sessionId)?.delete(id);
        uncertainties.push('任务从后续 TodoWrite 清单中消失，未据此推断完成；文件操作不再关联消失任务。');
      }
      liveTodoIds.set(call.event.sessionId, currentTodos);
      for (const todo of input.todos) {
        const task = put(todo.content, sourceId);
        remember(task);
        if (task) setStatus(task, call, todo.status);
      }
    } else if (call.name === 'TaskCreate') {
      const id = createdTaskId(call.result);
      if (!id || typeof input.subject !== 'string' || !input.subject.trim()) { uncertainties.push(`TaskCreate ${call.id} 无法可靠解析任务 id，未采信。`); continue; }
      structured = true;
      if (!createdIds.has(call.event.sessionId)) createdIds.set(call.event.sessionId, new Set());
      createdIds.get(call.event.sessionId).add(id);
      if (createdIds.get(call.event.sessionId).size >= 2) multiStep = true;
      const task = put(input.subject, sourceId, `${call.event.sessionId}:${id}`, typeof input.description === 'string' ? input.description : '', 'task:claude');
      if ([...tasks.values()].filter(t => normalize(t.name) === normalize(input.subject)).length > 1) uncertainties.push('TaskCreate 同名任务有独立 id，未擅自按名称归并，需审核是否重复。');
      remember(task);
      if (task) {
        for (const { field, value } of labeledSections(input.description, IO_LABELS)) {
          const label = field === 'inputs' ? '输入' : '输出';
          task[field] = unique([...task[field], `预期${label}：${value}`]);
          const record = `预期${label}（TaskCreate description 原文，非实际执行/验收）：${value}（source ${sourceId}，result source ${resultSourceId}）`;
          task.records = unique([...task.records, record]);
          evidence.push(record);
        }
        cliIds.set(`${call.event.sessionId}:${id}`, task.id);
        setStatus(task, call, 'pending');
      }
      evidence.push(`成功 TaskCreate #${id}：${clip(input.subject)}（source ${sourceId}）`);
    } else if (call.name === 'TaskUpdate') {
      const task = tasks.get(cliIds.get(`${call.event.sessionId}:${input.taskId}`));
      if (!task) { uncertainties.push(`TaskUpdate ${call.id} 引用未知任务，未采信。`); continue; }
      if (input.status !== undefined) setStatus(task, call, input.status);
      if (typeof input.description === 'string') task.description = clip(input.description, 2000);
      if (typeof input.subject === 'string' && input.subject.trim()) task.name = clip(input.subject, 500);
      remember(task);
    }
    const activeIds = [...(sessionStatuses.get(call.event.sessionId) || new Map())].filter(([, status]) => status === 'in_progress').map(([id]) => id);
    activeAtCall.set(`${call.event.sessionId}:${call.id}`, {
      ids: activeIds,
      planning: activeIds.length === 1 && /(?:编写|撰写|生成|write|draft).*(?:计划|方案|规格|说明|plan|spec)/i.test(tasks.get(activeIds[0])?.name || ''),
    });
  }
  // Compare only final per-session states: intermediate differences are not a final conflict.
  for (const task of tasks.values()) {
    const evidenceStatuses = [...sessionStatuses.values()].map(s => s.get(task.id)).filter(Boolean);
    if (new Set(evidenceStatuses).size > 1) {
      task.status = 'pending';
      uncertainties.push(`任务「${task.name}」跨会话状态证据不一致，保留 pending 等待用户审核。`);
    }
  }
  // Resolve dependencies after all creations, including forward references; reject uncertain graphs.
  for (const call of toolCalls.filter(c => c.success && !c.invalidInput && c.name === 'TaskUpdate')) {
    const task = tasks.get(cliIds.get(`${call.event.sessionId}:${call.input.taskId}`));
    if (!task) continue;
    for (const [field, reverse] of [['addBlockedBy', false], ['addBlocks', true]]) {
      if (call.input[field] === undefined) continue;
      if (!Array.isArray(call.input[field])) { uncertainties.push(`${field} 格式无效，未采信依赖。`); continue; }
      for (const id of call.input[field]) {
        const other = tasks.get(cliIds.get(`${call.event.sessionId}:${id}`));
        if (!other || other.id === task.id) { uncertainties.push('结构化依赖引用未知任务或自环，未采信。'); continue; }
        const target = reverse ? other : task, dependency = reverse ? task : other;
        const before = [...target.dependsOn];
        target.dependsOn = unique([...before, dependency.id]);
        if (!acyclic([...tasks.values()])) { target.dependsOn = before; uncertainties.push('结构化依赖产生循环，未采信该边。'); }
        else {
          const note = `成功 TaskUpdate ${call.id} ${field}：${target.name} 依赖 ${dependency.name}（结构化证据；source ${sourceFor(call.event).id}，result source ${sourceFor(call.resultEvent).id}）`;
          target.dependencyNote = unique([target.dependencyNote === '依赖未记录，待确认（未连线不代表没有依赖）' ? '' : target.dependencyNote, note]).filter(Boolean).join('\n');
          evidence.push(note);
        }
      }
    }
  }
  if (!multiStep) {
    for (const event of events) {
      const steps = numberedSteps(event.text);
      const actionable = event.role === 'user' || /(?:计划|步骤|任务|将|plan|steps|tasks|i will)/i.test(event.text) ||
        steps.every(step => /^(?:实现|开发|构建|设计|编写|创建|添加|集成|验证|测试|部署|迁移|重构|build|implement|create|add|integrate|verify|test|deploy|migrate|refactor)/i.test(step));
      if (steps.length >= 2 && actionable) {
        multiStep = true;
        const sourceId = sourceFor(event).id;
        for (const name of steps) {
          const existing = [...tasks.values()].find(t => normalize(t.name) === normalize(name));
          if (existing) existing.sourceIds = unique([...existing.sourceIds, sourceId]);
          else put(name, sourceId);
        }
        evidence.push(`消息编号步骤：${steps.length}（source ${sourceId}）`);
      }
    }
    uncertainties.push(structured ? '结构化任务不足，编号步骤仅补充为 pending 待办，未推断依赖。' : '编号步骤仅作为待办计划，未据此推断执行状态或依赖。');
  }
  if (!multiStep || tasks.size < 2) return null;
  // A narrow modification to an existing app is not a long-running project just because it has two todos.
  const smallExistingChange = /(?:现有|已有|existing).*(?:网站|应用|系统|app\b|website\b|application\b|system\b).*(?:添加|增加|修改|修复|add\b|change\b|fix\b)/i.test(goalText(goal));
  const substantial = /(?:长期|注册.*订阅.*权限)/i.test(goalText(goal)) || /(?:添加|增加|add\b).*(?:完整.{0,12}(?:中心|系统|平台)|管理中心|management\s+center)/i.test(goalText(goal));
  if (smallExistingChange && !substantial && tasks.size < 4) {
    warn(coverage, limits, `识别过滤 evidence：现有应用的局部增改且不足 4 个任务，不构造长期项目：${clip(goal, 100)}`);
    return null;
  }
  if (truncated || damaged) {
    tasks.forEach(task => { task.status = 'pending'; });
    uncertainties.push('目标 evidence damaged 或截断：证据受坏行、无效消息、工具参数或扫描上限影响，结果 unknown；任务统一降为 pending，待确认。');
  }
  // Tool execution records are not deliverables. Only an unambiguous currently active task gets IO.
  for (const call of toolCalls) {
    if (!call.success || call.invalidInput || !['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(call.name)) continue;
    const filePath = call.input.file_path || call.input.notebook_path;
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
      const warning = `evidence warning：工具参数 ${call.name} ${call.id} 文件路径无效；IO unknown，不改变任务状态（source ${sourceFor(call.event).id}）`;
      evidence.push(warning); uncertainties.push(warning); warn(coverage, limits, warning);
      continue;
    }
    const sourceId = sourceFor(call.event).id;
    const reading = call.name === 'Read';
    const contextNames = /(?:^|[\/._-])(plans?|planning|todos?|specs?|specification|requirements|instruction|rubrics|readme|agents|claude|design|计划|方案|说明)(?:[\/._-]|$)/i;
    const atCall = activeAtCall.get(`${call.event.sessionId}:${call.id}`);
    const activeTaskIds = atCall?.ids || [];
    const plan = contextNames.test(filePath) || atCall?.planning ||
      /^(?:#|标题[:：]|title:)\s*.*(?:项目计划|实施计划|设计方案|implementation plan|project plan|specification)/i.test(clip(call.input.content, 200).trim());
    files.set(`${filePath}:${sourceId}`, { path: filePath, purpose: reading ? '工具成功读取（非交付产物）' : plan ? '计划/说明文件写入记录（非实际产物）' : '工具成功写入/编辑记录（未验收产物）', sourceId });
    const active = activeTaskIds.map(id => tasks.get(id)).filter(Boolean);
    const resultSourceId = call.resultEvent ? sourceFor(call.resultEvent).id : sourceId;
    const record = `${call.name} ${filePath}；成功结果：${clip(resultText(call.result), 500)}；source ${sourceId}`;
    if (active.length === 1) {
      active[0].records.push(record);
      active[0].sourceIds = unique([...active[0].sourceIds, sourceId, resultSourceId]);
      if (reading) active[0].inputs = unique([...active[0].inputs, filePath]);
      else if (!plan) active[0].outputs = unique([...active[0].outputs, filePath]);
    } else {
      // Explicitly labelled shared-session evidence, not a claim that this task executed it.
      const task = tasks.values().next().value;
      task.records.push(`会话执行记录（对应任务不确定）：${record}`);
      task.sourceIds = unique([...task.sourceIds, sourceId, resultSourceId]);
      uncertainties.push('部分文件操作无法明确关联到单个任务，仅保留带标记的会话执行记录，未推断任务 IO。');
    }
  }
  for (const task of tasks.values()) {
    if (!task.inputs.some(value => !value.startsWith('预期输入：'))) task.records.push('输入 unknown：无可明确归属的成功读取证据，待确认（不代表没有输入，预期 IO 不代表已执行）。');
    if (!task.outputs.some(value => !value.startsWith('预期输出：'))) task.records.push('输出 unknown：无可明确归属的实际产物写入证据，待确认（计划、预期 IO 或助手宣称不作为已执行产物）。');
  }
  const now = Date.now();
  return {
    id: `candidate:${hash(identity(goal, scope))}`, identityKey: identity(goal, scope), name: clip(goal, 100), goal,
    description: '', ...projectFields, goalConfirmed: false,
    tasks: [...tasks.values()], files: [...files.values()], sources, uncertainties: unique(uncertainties), evidence: unique(evidence), createdAt: now, updatedAt: now,
  };
}

async function scanProjects(data, root, limits) {
  const { events, coverage } = await scanEvents(data, root, limits);
  const lanes = new Map();
  for (const event of events) {
    const lane = `${event.kind}:${event.sessionId}:${event.path || ''}:${directoryScope(event.cwd)}`;
    if (!lanes.has(lane)) lanes.set(lane, new Map());
    // Archived and active GUI messages with the same id are snapshots, not new turns.
    const eventId = `${event.role}:${event.id || event.order}${event.role === 'user' ? `:${hash(event.text)}` : ''}`;
    const previous = lanes.get(lane).get(eventId);
    if (previous && event.kind === 'gui') {
      const tools = new Map(previous.tools.map(tool => [tool.id, tool]));
      for (const tool of event.tools) {
        const old = tools.get(tool.id);
        tools.set(tool.id, old?.error ? old : tool.error || tool.success || !old?.success ? tool : old);
      }
      lanes.get(lane).set(eventId, { ...event, incomplete: previous.incomplete || event.incomplete, text: previous.text.length > event.text.length ? previous.text : event.text, tools: [...tools.values()] });
    } else lanes.get(lane).set(eventId, event);
  }
  const goals = new Map();
  for (const [laneKey, lane] of lanes) {
    const laneEvents = [...lane.values()].sort((a, b) => a.kind === 'claude' ? a.order - b.order : a.timestamp - b.timestamp || a.order - b.order);
    const calls = new Map(successfulTools(laneEvents).map(call => [call.id, call]));
    const taskOwners = new Map(), toolOwners = new Map();
    let current = null, following = false;
    for (const event of laneEvents) {
      const goal = event.role === 'user' ? explicitGoal(event.text) : null;
      const scope = directoryScope(event.cwd);
      if (goal) {
        current = identity(goal, scope || `unknown:${laneKey}`);
        following = false;
        if (!goals.has(current)) goals.set(current, { goal, scope: scope || `unknown:${laneKey}`, events: [] });
      } else if (event.role === 'user' && event.text.trim()) {
        const message = event.text.trim();
        const unrelated = /(?:临时|顺手|小任务|按钮|颜色|文案|错别字|解释|是什么|什么是|为什么|怎么|如何|翻译|[?？]|另外|另一个|新项目|temporary|quick question|explain|how to|what is|another project)/i.test(message);
        const continuation = /(?:接着|继续|下一步|第二步|按(?:这个|上述)|这个项目|该项目|上述|go ahead|continue)/i.test(message) ||
          /(?:已经|已|可以了|完成).*(?:实现|推进|测试|验证|修复|完善)/.test(message) || /^(?:请)?(?:好的|可以|同意|测试|验证|完成|yes\b|ok\b)/i.test(message);
        const labeledFollowup = /^(?:#{1,6}\s+)?(?:\*\*)?(?:项目背景|需求背景|背景|约束条件|约束|关键决策|决策|预期交付物|交付物|验收目标)(?:\*\*)?(?:\s*[:：]|\s*$)/m.test(message.split('\n')[0]) && labeledSections(message, PROJECT_LABELS, true).length > 0;
        if (current && (labeledFollowup || (!unrelated && continuation))) following = true;
        else {
          if (current) warn(coverage, limits, '用户新消息与原目标关联不明确；后续内容暂停归属，直到再次出现明确目标。');
          current = null; following = false;
        }
      }
      if (current && goals.get(current).scope !== (scope || `unknown:${laneKey}`)) current = null;
      // A known task id traces only its update back to the original goal, never all adjacent tools.
      const routed = new Map();
      for (const tool of event.tools) {
        const input = calls.get(tool.id)?.input || normalizeToolInput(tool.input).input;
        const owner = tool.name === 'TaskUpdate' && validId(input.taskId) ? taskOwners.get(String(input.taskId)) || current : current;
        if (!owner) continue;
        if (!routed.has(owner)) routed.set(owner, { tools: [], results: [] });
        routed.get(owner).tools.push(tool);
        toolOwners.set(tool.id, owner);
        const call = calls.get(tool.id);
        if (tool.name === 'TaskCreate' && call?.success) {
          const id = createdTaskId(call.result);
          if (id) taskOwners.set(id, owner);
        }
      }
      for (const result of event.results) {
        const owner = toolOwners.get(result.id);
        if (!owner) continue;
        if (!routed.has(owner)) routed.set(owner, { tools: [], results: [] });
        routed.get(owner).results.push(result);
      }
      if (current && !routed.has(current)) routed.set(current, { tools: [], results: [] });
      for (const [owner, parts] of routed) goals.get(owner).events.push({ ...event, ...parts, text: owner === current ? event.text : '', followup: following || owner !== current });
      if (!current && event.role === 'user' && event.text.trim()) warn(coverage, limits, '识别过滤 evidence：未发现明确长期具体目标（短问答、临时修改、摘要或含糊需求不构造候选）。');
    }
  }
  const cliToolGoals = new Map();
  const failedTools = new Set();
  for (const event of events) {
    for (const result of event.results) if (result.error && typeof result.id === 'string') failedTools.add(`${directoryScope(event.cwd)}:${event.sessionId}:${result.id}`);
    for (const tool of event.tools) if (tool.error && typeof tool.id === 'string') failedTools.add(`${directoryScope(event.cwd)}:${event.sessionId}:${tool.id}`);
  }
  for (const [key, group] of goals) for (const event of group.events.filter(e => e.kind === 'claude')) for (const tool of event.tools) {
    if (typeof tool.id === 'string') cliToolGoals.set(`${directoryScope(event.cwd)}:${event.sessionId}:${tool.id}`, key);
  }
  const candidates = [];
  for (const [key, { goal, events: group }] of goals) {
    if (candidates.length >= limits.maxCandidates) { warn(coverage, limits, `候选数量达到上限 ${limits.maxCandidates}，其余目标未提取`); break; }
    const corrected = group.map(event => ({
      ...event,
      tools: event.tools.filter(tool => typeof tool.id === 'string').filter(tool => event.kind !== 'gui' || !cliToolGoals.has(`${directoryScope(event.cwd)}:${event.sessionId}:${tool.id}`) || cliToolGoals.get(`${directoryScope(event.cwd)}:${event.sessionId}:${tool.id}`) === key)
        .map(tool => failedTools.has(`${directoryScope(event.cwd)}:${event.sessionId}:${tool.id}`) ? { ...tool, error: true, success: false } : tool),
    }));
    const candidate = candidateFor(goal, corrected, limits, coverage, goals.get(key).scope);
    if (candidate) {
      if (coverage.skipped) candidate.uncertainties.push('扫描跳过了部分文件或行；覆盖范围及具体错误见 coverage.warnings，任务状态可能缺少后续证据。');
      candidates.push(candidate);
    }
    // Yield between completed goal groups, including groups without sufficient task evidence.
    await new Promise(resolve => setImmediate(resolve));
  }
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    if (similarGoal(candidates[i], candidates[j])) {
      candidates[i].uncertainties.push(`同工作目录目标主体相似，需人工关联（未合并）：${candidates[j].goal}`);
      candidates[j].uncertainties.push(`同工作目录目标主体相似，需人工关联（未合并）：${candidates[i].goal}`);
    }
  }
  return { candidates, coverage };
}

// Independent semantic-history entry point: deliberately never calls explicitGoal.
async function collectProjectHistory(data, root, limits = DEFAULT_LIMITS) {
  const { events: rawEvents, coverage } = await scanEvents(data, root, { ...DEFAULT_LIMITS, ...limits });
  const normalizedEvents = rawEvents.map(raw => ({ ...raw,
    id: raw.id || `content:${hash(`${raw.role}:${raw.text}:${JSON.stringify(raw.tools.map(t => [t.id, t.name]))}`)}` }));
  const groups = [], indexes = new Map(), contentGroups = new Map();
  for (const event of normalizedEvents) {
    const lane = `${directoryScope(event.cwd)}:${event.sessionId}:${event.role}:`;
    const keys = [lane + `id:${event.id}`];
    const contentKey = event.text.trim() ? lane + `text:${hash(event.text)}` : '';
    for (const tool of event.tools) if (validId(tool.id)) keys.push(lane + `tool:${tool.id}`);
    const matches = [...new Set(keys.map(key => indexes.get(key)).filter(Boolean))];
    // Equal prose on different days is genuine temporal evidence, not a duplicate turn.
    // Content-only matching is allowed solely for one unambiguous GUI/CLI mirror.
    if (!matches.length && contentKey) {
      const mirrors = [...(contentGroups.get(contentKey) || [])].filter(group =>
        group.events.every(old => old.kind !== event.kind));
      if (mirrors.length === 1) matches.push(mirrors[0]);
    }
    const group = matches[0] || { events: [], keys: new Set(), contentKeys: new Set() };
    if (!matches.length) groups.push(group);
    // A GUI aggregate may bridge several CLI turns; retain each original as an alias.
    for (const other of matches.slice(1)) {
      group.events.push(...other.events);
      for (const key of other.keys) { group.keys.add(key); indexes.set(key, group); }
      for (const key of other.contentKeys) { group.contentKeys.add(key); contentGroups.get(key).delete(other); contentGroups.get(key).add(group); }
      groups.splice(groups.indexOf(other), 1);
    }
    group.events.push(event);
    for (const key of keys) { group.keys.add(key); indexes.set(key, group); }
    if (contentKey) {
      if (!contentGroups.has(contentKey)) contentGroups.set(contentKey, new Set());
      contentGroups.get(contentKey).add(group); group.contentKeys.add(contentKey);
    }
  }
  const events = groups.map(group => {
    const originals = group.events.sort((a, b) => (a.kind === 'claude' ? 0 : 1) - (b.kind === 'claude' ? 0 : 1) || String(a.id).localeCompare(String(b.id), 'en'));
    const canonical = originals[0];
    const texts = unique(originals.map(event => event.text).filter(Boolean));
    const times = originals.filter(event => event.timestampKnown).map(event => event.timestamp);
    return { ...canonical, title: canonical.title || originals.find(event => event.title)?.title || '',
      firstTimestamp: times.length ? Math.min(...times) : undefined, lastTimestamp: times.length ? Math.max(...times) : undefined,
      text: texts.filter(text => !texts.some(other => other !== text && other.includes(text))).join('\n'),
      tools: originals.flatMap(event => event.tools), results: originals.flatMap(event => event.results),
      incomplete: originals.some(event => event.incomplete), originals };
  }).sort((a, b) => a.timestamp - b.timestamp || `${a.sessionId}:${a.id}`.localeCompare(`${b.sessionId}:${b.id}`, 'en'));
  return { events, coverage, toolEvidence: successfulTools(normalizedEvents) };
}

module.exports = { scanProjects, collectProjectHistory, sourceFor, successfulTools, normalizeToolInput, taskInputError, createdTaskId,
  DEFAULT_LIMITS, identity, normalize, acyclic, sameGoal, similarGoal, projectScope, directoryScope };
