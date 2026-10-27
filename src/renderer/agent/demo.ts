// 演示时间线：固定 120 秒、可回放的确定性数据（示例常量，非真实测量）。
// 65 秒处保留 4 个 agent（2 个运行中）、6~8 个文件节点、失败与重试、审批等待。

import type { ExecutionEvent, ExecutionGraph, NodeStatus } from './types';
import { applyEvents, createGraph, getRootId } from './model';

export const DEMO_DURATION = 120000;
export const DEMO_INITIAL_TIME = 65000;
export const DEMO_CONVERSATION_ID = 'demo:claude-code-gui';
export const DEMO_ROOT_ID = getRootId(DEMO_CONVERSATION_ID);
export const DEMO_TITLE = '构建 Agent 可视化中心';
export const DEMO_PROJECT_PATH = '/Users/demo/claude-code-gui';

/** 时间线关键点（毫秒） */
const T = {
  start: 600,
  plan: 1400,
  todo: 1600,
  architect: 2200,
  scout: 3000,
  builder: 3600,
  tester: 4400,
  architectDone: 41200,
  scoutDone: 48000,
  builderDone: 96000,
  testerDone: 76000,
  scan: 5200,
  scanDone: 7800,
  readTypes: 8600,
  readTypesDone: 11800,
  readStore: 12600,
  readStoreDone: 17400,
  readModel: 18200,
  readModelDone: 21600,
  grepUsage: 22400,
  grepUsageDone: 25200,
  editModel: 26000,
  editModelDone: 30400,
  writeStore: 31200,
  writeStoreDone: 35800,
  readRunner: 12400,
  readRunnerDone: 16200,
  testFail: 18800,
  testFailAt: 24800,
  retry: 25400,
  retryPass: 68000,
  approval: 34800,
  approvalDone: 74000,
  grepTodo: 36600,
  grepTodoDone: 39200,
  editAdapter: 40400,
  editAdapterDone: 44600,
  typecheck: 45200,
  typecheckDone: 49800,
  grepSelect: 50600,
  grepSelectDone: 53800,
  writeTest: 61800,
  writeTestDone: 66800,
  longrun: 58600,
  bashBuild: 68200,
  bashBuildDone: 72400,
  writeDemo: 74200,
  writeDemoDone: 78800,
  readTypesLate: 79600,
  readTypesLateDone: 82000,
  editDemo: 83200,
  editDemoDone: 87800,
  lint: 88600,
  lintDone: 92400,
  writeIndex: 96800,
  writeIndexDone: 102400,
  finalTest: 103600,
  finalTestDone: 110200,
  wrapUp: 113000,
  done: 118000,
} as const;

interface DemoNode {
  id: string;
  type: 'agent' | 'tool' | 'task';
  label: string;
  subtitle?: string;
  parentId: string;
  toolName?: string;
  filePath?: string;
  at: number;
  done?: number;
  /** 结束时状态，默认 completed */
  endStatus?: 'completed' | 'error';
  /** 阻塞节点：到 done 才解除 */
  blocked?: boolean;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  after?: string;
  retryOf?: string;
}

const NODES: DemoNode[] = [
  // 4 个 agent：中文短标题 + 角色说明
  { id: 'agent:architect', type: 'agent', label: '架构拆解', subtitle: 'architect · 拆分数据层职责', parentId: DEMO_ROOT_ID, at: T.architect, done: T.architectDone, input: { prompt: '把执行可视化拆成 reducer / adapter / store / demo 四层，给出接口与边界' } },
  { id: 'agent:scout', type: 'agent', label: '代码勘察', subtitle: 'scout · 读取 runner 与会话状态', parentId: DEMO_ROOT_ID, at: T.scout, done: T.scoutDone, input: { prompt: '读 src/main/runner.js 与 renderer/store.ts，确认真实事件形状' } },
  { id: 'agent:builder', type: 'agent', label: '界面实现', subtitle: 'builder · 修补 reducer 与适配器', parentId: DEMO_ROOT_ID, at: T.builder, done: T.builderDone, input: { prompt: '修补 model.ts 与 adapter.ts，保证文件节点与乱序结果正确' } },
  { id: 'agent:tester', type: 'agent', label: '回归验证', subtitle: 'tester · 类型检查与单测', parentId: DEMO_ROOT_ID, at: T.tester, done: T.testerDone, input: { prompt: '运行 tsc --noEmit 与 vitest，确认数据层行为' } },

  // architect：扫描与三个文件读取
  { id: 'tool:scan', type: 'tool', label: '扫描目录', subtitle: 'Glob src/renderer/agent/*.ts', parentId: 'agent:architect', toolName: 'Glob', at: T.scan, done: T.scanDone, input: { pattern: 'src/renderer/agent/*.ts' }, output: 'types.ts · model.ts · adapter.ts · store.ts · demo.ts', after: 'agent:architect' },
  { id: 'tool:read-types', type: 'tool', label: '读取类型定义', subtitle: 'Read types.ts', parentId: 'agent:architect', toolName: 'Read', filePath: 'src/renderer/agent/types.ts', at: T.readTypes, done: T.readTypesDone, input: { file_path: 'src/renderer/agent/types.ts' }, output: '读取 190 行', after: 'tool:scan' },
  { id: 'tool:read-store', type: 'tool', label: '读取会话 store', subtitle: 'Read store.ts', parentId: 'agent:architect', toolName: 'Read', filePath: 'src/renderer/store.ts', at: T.readStore, done: T.readStoreDone, input: { file_path: 'src/renderer/store.ts' }, output: '读取 1374 行', after: 'tool:read-types' },
  { id: 'tool:read-model', type: 'tool', label: '读取 reducer', subtitle: 'Read model.ts', parentId: 'agent:architect', toolName: 'Read', filePath: 'src/renderer/agent/model.ts', at: T.readModel, done: T.readModelDone, input: { file_path: 'src/renderer/agent/model.ts' }, output: '读取 792 行', after: 'tool:read-store' },

  // scout：runner 读取、失败测试与明确重试
  { id: 'tool:read-runner', type: 'tool', label: '读取 runner', subtitle: 'Read runner.js', parentId: 'agent:scout', toolName: 'Read', filePath: 'src/main/runner.js', at: T.readRunner, done: T.readRunnerDone, input: { file_path: 'src/main/runner.js' }, output: '确认 conversationId 附着在每个事件上', after: 'agent:scout' },
  { id: 'tool:test-fail', type: 'tool', label: '运行数据层测试', subtitle: 'Bash npx vitest run tests/agent-model.test.ts', parentId: 'agent:scout', toolName: 'Bash', at: T.testFail, done: T.testFailAt, endStatus: 'error', input: { command: 'npx vitest run tests/agent-model.test.ts' }, output: 'FAIL tests/agent-model.test.ts', error: '断言失败：文件节点状态仍为 running', after: 'tool:read-runner' },
  // 数据层测试首次失败后，主线程长时间重跑（65 秒仍在重试）
  { id: 'tool:retry-test', type: 'tool', label: '重试数据层测试', subtitle: 'Bash 第 2 次', parentId: DEMO_ROOT_ID, toolName: 'Bash', at: T.retry, done: T.retryPass, input: { command: 'npx vitest run tests/agent-model.test.ts' }, output: 'PASS 42 个用例', after: 'tool:test-fail', retryOf: 'tool:test-fail' },

  // 等待审批的任务（阻塞直到审批通过；挂在负责写测试的 tester 下）
  { id: 'task:approval', type: 'task', label: '等待审批：写入测试夹具', subtitle: 'approval', parentId: 'agent:tester', at: T.approval, done: T.approvalDone, blocked: true, after: 'tool:retry-test' },

  // builder：检索与编辑
  { id: 'tool:grep-usage', type: 'tool', label: '检索 usage 用法', subtitle: 'Grep usage result.usage', parentId: 'agent:builder', toolName: 'Grep', at: T.grepUsage, done: T.grepUsageDone, input: { pattern: 'result.usage' }, output: 'adapter.ts: 3 处', after: 'agent:builder' },
  { id: 'tool:edit-model', type: 'tool', label: '修补文件节点派生', subtitle: 'Edit model.ts', parentId: 'agent:builder', toolName: 'Edit', filePath: 'src/renderer/agent/model.ts', at: T.editModel, done: T.editModelDone, input: { file_path: 'src/renderer/agent/model.ts', old_string: 'if (!toolName) return null;', new_string: 'if (!toolName || !filePath) return null;' }, output: '已应用 1 处修改', after: 'tool:grep-usage' },
  { id: 'tool:write-store', type: 'tool', label: '接线 store', subtitle: 'Write store.ts', parentId: 'agent:builder', toolName: 'Write', filePath: 'src/renderer/agent/store.ts', at: T.writeStore, done: T.writeStoreDone, input: { file_path: 'src/renderer/agent/store.ts' }, output: '写入 192 行', after: 'tool:edit-model' },
  { id: 'tool:grep-todo', type: 'tool', label: '检索任务清单', subtitle: 'Grep todos', parentId: 'agent:builder', toolName: 'Grep', at: T.grepTodo, done: T.grepTodoDone, input: { pattern: 'todos' }, output: 'adapter.ts: 2 处', after: 'tool:write-store' },
  { id: 'tool:edit-adapter', type: 'tool', label: '修补占位回填', subtitle: 'Edit adapter.ts', parentId: 'agent:builder', toolName: 'Edit', filePath: 'src/renderer/agent/adapter.ts', at: T.editAdapter, done: T.editAdapterDone, input: { file_path: 'src/renderer/agent/adapter.ts', old_string: "if (rec.hasInput || rec.hasResult) return [];", new_string: "if (rec.hasInput) return [];" }, output: '已应用 2 处修改', after: 'tool:grep-todo' },

  // tester：类型检查、检索、写测试
  { id: 'tool:typecheck', type: 'tool', label: '类型检查', subtitle: 'Bash npx tsc --noEmit', parentId: 'agent:tester', toolName: 'Bash', at: T.typecheck, done: T.typecheckDone, input: { command: 'npx tsc --noEmit' }, output: '无类型错误', after: 'agent:tester' },
  { id: 'tool:grep-select', type: 'tool', label: '检索选择器', subtitle: 'Grep useAgentStore', parentId: 'agent:tester', toolName: 'Grep', at: T.grepSelect, done: T.grepSelectDone, input: { pattern: 'useAgentStore' }, output: '4 处引用', after: 'tool:typecheck' },
  { id: 'tool:write-test', type: 'tool', label: '补充数据层测试', subtitle: 'Write tests/agent-model.test.ts', parentId: 'agent:tester', toolName: 'Write', filePath: 'tests/agent-model.test.ts', at: T.writeTest, done: T.writeTestDone, input: { file_path: 'tests/agent-model.test.ts' }, output: '写入 900 行', after: 'tool:grep-select' },

  // 长运行工具（65 秒仍在运行）
  { id: 'tool:longrun', type: 'tool', label: '长任务：回归抽样', subtitle: 'Bash npm test -- tests/agent-model.test.ts', parentId: DEMO_ROOT_ID, toolName: 'Bash', at: T.longrun, input: { command: 'npm test -- tests/agent-model.test.ts' }, after: 'tool:grep-select' },

  // 65 秒之后
  { id: 'tool:bash-build', type: 'tool', label: '运行构建', subtitle: 'Bash npm run build', parentId: DEMO_ROOT_ID, toolName: 'Bash', at: T.bashBuild, done: T.bashBuildDone, input: { command: 'npm run build' }, output: 'built in 4.8s', after: 'tool:write-test' },
  { id: 'tool:write-demo', type: 'tool', label: '整理演示时间线', subtitle: 'Write demo.ts', parentId: DEMO_ROOT_ID, toolName: 'Write', filePath: 'src/renderer/agent/demo.ts', at: T.writeDemo, done: T.writeDemoDone, input: { file_path: 'src/renderer/agent/demo.ts' }, output: '写入 420 行', after: 'tool:bash-build' },
  { id: 'tool:read-types-late', type: 'tool', label: '复查类型文件', subtitle: 'Read types.ts', parentId: DEMO_ROOT_ID, toolName: 'Read', filePath: 'src/renderer/agent/types.ts', at: T.readTypesLate, done: T.readTypesLateDone, input: { file_path: 'src/renderer/agent/types.ts' }, output: '读取 190 行', after: 'tool:write-demo' },
  { id: 'tool:edit-demo', type: 'tool', label: '修正演示节点', subtitle: 'Edit demo.ts', parentId: DEMO_ROOT_ID, toolName: 'Edit', filePath: 'src/renderer/agent/demo.ts', at: T.editDemo, done: T.editDemoDone, input: { file_path: 'src/renderer/agent/demo.ts', old_string: 'DEMO_INITIAL_TIME = 60000', new_string: 'DEMO_INITIAL_TIME = 65000' }, output: '已应用 1 处修改', after: 'tool:read-types-late' },
  { id: 'tool:lint', type: 'tool', label: '诊断检查', subtitle: 'Bash npm run typecheck', parentId: DEMO_ROOT_ID, toolName: 'Bash', at: T.lint, done: T.lintDone, input: { command: 'npm run typecheck' }, output: '无类型错误', after: 'tool:edit-demo' },
  { id: 'tool:write-index', type: 'tool', label: '导出数据层入口', subtitle: 'Write index.ts', parentId: DEMO_ROOT_ID, toolName: 'Write', filePath: 'src/renderer/agent/index.ts', at: T.writeIndex, done: T.writeIndexDone, input: { file_path: 'src/renderer/agent/index.ts' }, output: '写入 12 行', after: 'tool:lint' },
  { id: 'tool:final-test', type: 'tool', label: '完整回归', subtitle: 'Bash npm test', parentId: DEMO_ROOT_ID, toolName: 'Bash', at: T.finalTest, done: T.finalTestDone, input: { command: 'npm test' }, output: '全部通过', after: 'tool:write-index' },
];

interface DemoTodo {
  id: string;
  label: string;
  /** 各阶段状态变化时间：pending → running → completed */
  events: { at: number; status: NodeStatus }[];
}

const TODOS: DemoTodo[] = [
  { id: 'task:spec', label: '梳理数据层接口', events: [{ at: T.plan, status: 'running' }, { at: T.architectDone, status: 'completed' }] },
  { id: 'task:reducer', label: '实现 reducer 与文件节点', events: [{ at: T.builder, status: 'running' }, { at: T.writeStoreDone, status: 'completed' }] },
  { id: 'task:adapter', label: '适配器接流与乱序处理', events: [{ at: T.writeStoreDone, status: 'running' }, { at: T.editAdapterDone, status: 'completed' }] },
  { id: 'task:tests', label: '编写数据层测试', events: [{ at: T.grepSelectDone, status: 'running' }] },
  { id: 'task:panel', label: '接入执行可视化面板', events: [] },
];

const METRICS: { at: number; metrics: Partial<ExecutionGraph['metrics']> }[] = [
  { at: T.typecheckDone, metrics: { model: 'claude-sonnet-4-5', inputTokens: 2100, outputTokens: 640, cacheTokens: 0 } },
  { at: T.finalTestDone, metrics: { inputTokens: 24600, outputTokens: 7180, cacheTokens: 17600, costUsd: 0.2188, turns: 8, durationMs: T.finalTestDone - T.start } },
];

/**
 * 生成按时间排序的事件序列。
 * 所有节点状态都由时间推导，且每个事件只携带该时刻已发生的事实。
 */
export function buildDemoEvents(): ExecutionEvent[] {
  const events: ExecutionEvent[] = [];
  let counter = 0;
  const push = (
    timestamp: number,
    kind: ExecutionEvent['kind'],
    label: string,
    opts: { nodeId?: string; status?: NodeStatus; delta?: ExecutionEvent['delta'] } = {}
  ) => {
    counter += 1;
    events.push({
      id: `demo:${String(counter).padStart(4, '0')}`,
      conversationId: DEMO_CONVERSATION_ID,
      timestamp,
      source: 'demo',
      kind,
      label,
      ...opts,
    });
  };

  // 会话开始
  push(T.start, 'session', '演示会话开始', {
    nodeId: DEMO_ROOT_ID,
    status: 'running',
    delta: {
      node: { id: DEMO_ROOT_ID, type: 'core', label: DEMO_TITLE, subtitle: DEMO_PROJECT_PATH, status: 'running', startedAt: T.start },
      graph: { title: DEMO_TITLE, projectPath: DEMO_PROJECT_PATH, status: 'running' },
    },
  });

  // 计划：4 个 agent 与根节点之间显式 delegation 边
  for (const agent of NODES.filter((n) => n.type === 'agent')) {
    push(T.plan, 'agent', `${agent.label} 计划`, {
      nodeId: agent.id,
      status: 'pending',
      delta: { edge: { source: DEMO_ROOT_ID, target: agent.id, kind: 'delegation' } },
    });
  }

  // 任务清单：TodoWrite 观测到真实清单
  push(T.todo, 'task', 'TodoWrite：5 个任务', {
    nodeId: 'tool:todo',
    status: 'completed',
    delta: {
      node: {
        id: 'tool:todo',
        type: 'tool',
        label: 'TodoWrite',
        subtitle: '5 个任务',
        toolName: 'TodoWrite',
        status: 'completed',
        parentId: DEMO_ROOT_ID,
        startedAt: T.todo,
        input: {
          // TodoWrite 只携带该时刻已发生的任务状态，不泄漏未来进度
          todos: TODOS.map((td) => {
            const current = [...td.events].reverse().find((step) => step.at <= T.todo);
            return {
              content: td.label,
              status: current?.status === 'completed' ? 'completed' : current?.status === 'running' ? 'in_progress' : 'pending',
            };
          }),
        },
      },
      edge: { source: DEMO_ROOT_ID, target: 'tool:todo', kind: 'call' },
    },
  });
  for (const td of TODOS) {
    push(T.todo, 'task', `任务待办：${td.label}`, {
      nodeId: td.id,
      status: 'pending',
      delta: {
        node: { id: td.id, type: 'task', label: td.label, status: 'pending', parentId: DEMO_ROOT_ID, lastEventAt: T.todo },
        edge: { source: 'tool:todo', target: td.id, kind: 'dependency' },
      },
    });
    for (const step of td.events) {
      push(step.at, 'task', `任务 ${step.status === 'completed' ? '完成' : '开始'}：${td.label}`, {
        nodeId: td.id,
        status: step.status,
        delta: {
          node: {
            id: td.id,
            status: step.status,
            ...(step.status === 'running' ? { startedAt: step.at } : {}),
            ...(step.status === 'completed' ? { endedAt: step.at } : {}),
            lastEventAt: step.at,
          },
        },
      });
    }
  }

  // 节点开始 / 结束
  for (const node of NODES) {
    const isAgent = node.type === 'agent';
    push(node.at, isAgent ? 'agent' : 'tool', `${node.label} 开始`, {
      nodeId: node.id,
      status: node.blocked ? 'blocked' : 'running',
      delta: {
        node: {
          id: node.id,
          type: node.type,
          label: node.label,
          ...(node.subtitle ? { subtitle: node.subtitle } : {}),
          parentId: node.parentId,
          status: node.blocked ? 'blocked' : 'running',
          startedAt: node.at,
          ...(node.toolName ? { toolName: node.toolName } : {}),
          ...(node.filePath ? { filePath: node.filePath, relatedFiles: [node.filePath] } : {}),
          ...(node.input ? { input: node.input } : {}),
          ...(node.blocked ? { metadata: { approval: true } } : {}),
          lastEventAt: node.at,
        },
        edge: { source: node.parentId, target: node.id, kind: isAgent ? 'delegation' : 'call' },
      },
    });

    if (node.after) {
      // 依赖边在节点开始时建立：此时上下游节点都已存在，不会被 reducer 丢弃
      push(node.at, 'tool', `${node.label} 依赖上游`, {
        nodeId: node.id,
        status: 'pending',
        delta: { edge: { source: node.after, target: node.id, kind: 'dependency' } },
      });
    }

    if (node.retryOf) {
      // 明确重试：retry 边 + 依赖未满足时 blocked
      push(T.retry, 'status', `${node.label} 重试失败节点`, {
        nodeId: node.id,
        status: 'retrying',
        delta: {
          node: { id: node.id, status: 'retrying', metadata: { retryOf: node.retryOf } },
          edge: { source: node.retryOf, target: node.id, kind: 'retry' },
        },
      });
    }

    if (node.done !== undefined) {
      const end = node.blocked ? 'completed' : node.endStatus ?? 'completed';
      push(node.done, isAgent ? 'agent' : 'tool', `${node.label} ${end === 'completed' ? '完成' : '失败'}`, {
        nodeId: node.id,
        status: end,
        delta: {
          node: {
            id: node.id,
            status: end,
            endedAt: node.done,
            ...(end === 'completed' && node.output ? { output: node.output } : {}),
            ...(end === 'error'
              ? { error: node.error ?? '执行失败', ...(node.output ? { output: node.output } : {}) }
              : {}),
            lastEventAt: node.done,
          },
        },
      });
    }
  }

  // 审批解除
  push(T.approvalDone, 'status', '审批通过', {
    nodeId: 'task:approval',
    status: 'completed',
    delta: { node: { id: 'task:approval', status: 'completed', endedAt: T.approvalDone, output: '已允许写入测试夹具' } },
  });

  // 示例用量采样
  for (const m of METRICS) push(m.at, 'metrics', '示例用量', { delta: { metrics: m.metrics } });

  // 收尾：仍未结束的节点显式收束（不再有进行中动画），随后会话完成
  for (const node of NODES) {
    if (node.done !== undefined) continue;
    const label = node.label;
    // 仍在运行的长任务与重试统一收束为完成（时间线已不再推进）
    push(T.wrapUp, node.type === 'agent' ? 'agent' : 'tool', `${label} 收束`, {
      nodeId: node.id,
      status: 'completed',
      delta: { node: { id: node.id, status: 'completed', endedAt: T.wrapUp, lastEventAt: T.wrapUp } },
    });
  }
  for (const td of TODOS) {
    if (td.events.some((e) => e.status === 'completed')) continue;
    push(T.wrapUp, 'task', `任务收束：${td.label}`, {
      nodeId: td.id,
      status: 'completed',
      delta: { node: { id: td.id, status: 'completed', endedAt: T.wrapUp, lastEventAt: T.wrapUp } },
    });
  }
  push(T.done, 'status', '演示结束', {
    nodeId: DEMO_ROOT_ID,
    status: 'completed',
    delta: {
      node: { id: DEMO_ROOT_ID, status: 'completed', endedAt: T.done },
      graph: { status: 'completed', endedAt: T.done },
    },
  });

  return events.sort((a, b) => a.timestamp - b.timestamp);
}

export const DEMO_EVENTS: ExecutionEvent[] = buildDemoEvents();

/** 回放到 timeMs 的图（同一时刻结果恒定，无未来信息泄漏） */
export function getDemoGraph(timeMs: number): ExecutionGraph {
  const t = Math.max(0, Math.min(DEMO_DURATION, Number.isFinite(timeMs) ? timeMs : DEMO_INITIAL_TIME));
  return applyEvents(
    createGraph(DEMO_CONVERSATION_ID, 'demo', DEMO_TITLE, DEMO_PROJECT_PATH),
    DEMO_EVENTS.filter((e) => e.timestamp <= t)
  );
}

export function getDemoFullGraph(): ExecutionGraph {
  return getDemoGraph(DEMO_DURATION);
}
