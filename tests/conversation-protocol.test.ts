import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useStore, snapshotConversations, convertSessionMessages } from '../src/renderer/store';
import type { StreamMessage } from '../src/renderer/types';
import { abortConversation, generateUserMessageId } from '../src/renderer/utils/deliver';
const state = () => useStore.getState();
const conv = () => state().conversations[0];
const emit = (event: Record<string, unknown>) => state().handleStream(event as unknown as StreamMessage);
beforeEach(() => { state().hydrate({ cwd: '/tmp', conversations: [] }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('indexed nested stream seam', () => {
  it('isolates parents and indices, flushes before full message, reconstructs JSON input', () => {
    emit({ type: 'assistant', message: { id: 'top', content: [{ type: 'tool_use', id: 'p', name: 'Agent', input: {} }] } });
    const partial = (event: unknown, parent = 'p') => emit({ type: 'stream_event', parent_tool_use_id: parent, event });
    partial({ type: 'message_start', message: { id: 'nested' } });
    partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } });
    partial({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'B' } });
    partial({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't', name: 'Bash' } });
    partial({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":' } });
    partial({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"ls"}' } });
    partial({ type: 'content_block_stop', index: 2 });
    emit({ type: 'assistant', parent_tool_use_id: 'p', uuid: 'a', message: { id: 'nested', content: [{ type: 'text', text: 'AB' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] } });
    const parent = conv().streamingMessage!.blocks[0];
    expect(parent.kind).toBe('tool_use');
    if (parent.kind !== 'tool_use') throw new Error('missing parent');
    expect(parent.children!.filter(b => b.kind === 'text').map(b => b.text)).toEqual(['A', 'B']);
    expect(parent.children!.filter(b => b.kind === 'tool_use')).toHaveLength(1);
    expect(parent.children!.find(b => b.kind === 'tool_use')).toMatchObject({ input: { command: 'ls' } });
  });
  it('result-only errors preserve details, delta counters are finite and result UUID is idempotent', () => {
    const result = { type: 'result', uuid: 'r', subtype: 'error_max_turns', is_error: false, result: 'fallback', errors: ['limit'], total_cost_usd: 0.2,
      modelUsage: { a: { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, contextWindow: 200000 } },
      usage: { input_tokens: Infinity, output_tokens: -5 } };
    emit(result); emit(result);
    expect(conv().status).toBe('error');
    expect(conv().messages).toHaveLength(1);
    expect(JSON.stringify(conv().messages)).toContain('limit');
    expect(state().totalCost).toBe(0.2);
    expect(state().totalInputTokens).toBe(15);
    expect(state().totalOutputTokens).toBe(4);
  });
  it('late tool results update archived cards without truncating multimodal payloads', () => {
    emit({ type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } });
    emit({ type: 'result', subtype: 'success', result: '' });
    const content = [{ type: 'text', text: 'x'.repeat(30000) }, { type: 'image', source: { data: 'image' } }];
    emit({ type: 'user', uuid: 'late', message: { content: [{ type: 'tool_result', tool_use_id: 't', content }] } });
    expect(conv().messages[0].blocks[0]).toMatchObject({ result: 'x'.repeat(30000), resultContent: content });
    expect(conv().streamingMessage).toBeNull();
  });
});

describe('additional SDK regressions', () => {
  it('ready metadata preceding the real SDK result keeps one final response and its stats together', () => {
    const id = conv().id;
    state().setRuntime(id, { runId: 'run', state: 'busy', busy: true });
    // Captured from CLI 2.1.229 / SDK 0.3.229, including assistant-before-block_stop.
    emit({ type: 'stream_event', runId: 'run', uuid: 'start', event: { type: 'message_start', message: { id: 'msg_api' } } });
    emit({ type: 'stream_event', runId: 'run', uuid: 'block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    for (const [index, text] of ['Desktop', ' histor', 'y compl', 'eted'].entries()) {
      emit({ type: 'stream_event', runId: 'run', uuid: `delta-${index}`, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    }
    emit({ type: 'assistant', runId: 'run', uuid: 'normalized', message: { id: 'msg_api', content: [{ type: 'text', text: 'Desktop history completed' }] } });
    emit({ type: 'stream_event', runId: 'run', uuid: 'stop', event: { type: 'content_block_stop', index: 0 } });
    emit({ type: 'stream_event', runId: 'run', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
    emit({ type: 'stream_event', runId: 'run', event: { type: 'message_stop' } });
    state().setRuntime(id, { runId: 'run', state: 'ready', busy: false, pendingApprovals: [], pendingUserMessageIds: [] });
    emit({ type: 'result', runId: 'run', uuid: 'result', subtype: 'success', result: 'Desktop history completed', hasPending: false });
    state().setStatus('completed', id, 'run');
    const answers = conv().messages.filter(m => m.role === 'assistant');
    expect(answers.flatMap(m => m.blocks.filter(b => b.kind === 'text').map(b => b.text))).toEqual(['Desktop history completed']);
    expect(answers).toHaveLength(1);
    expect(answers[0].blocks.map(b => b.kind)).toEqual(['text', 'stats']);
    expect(conv().streamingMessage).toBeNull();
  });
  it('normalised singleton assistant shards use their API block index and retain literal repeated text', async () => {
    const partial = (event: unknown) => emit({ type: 'stream_event', event });
    partial({ type: 'message_start', message: { id: 'msg_multi' } });
    partial({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Considering both independent blocks.' } });
    emit({ type: 'assistant', uuid: 'thinking', message: { id: 'msg_multi', content: [{ type: 'thinking', thinking: 'Considering both independent blocks.', signature: 'local-only-signature' }] } });
    partial({ type: 'content_block_stop', index: 0 });
    // Each real CLI full message has content[0], while original indices are 1 and 2.
    for (const index of [1, 2]) {
      partial({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const text of ['Repeate', 'd block', '\n']) partial({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
      emit({ type: 'assistant', uuid: `text-${index}`, message: { id: 'msg_multi', content: [{ type: 'text', text: 'Repeated block\n' }] } });
      partial({ type: 'content_block_stop', index });
    }
    partial({ type: 'message_stop' });
    emit({ type: 'result', subtype: 'success', result: 'Repeated block\n' });
    expect(conv().messages[0].blocks.filter(b => b.kind === 'text').map(b => b.text)).toEqual(['Repeated block\n', 'Repeated block\n']);
    expect(conv().messages[0].blocks.filter(b => b.kind === 'thinking').map(b => b.text)).toEqual(['Considering both independent blocks.']);
    // A late echo is the same indexed block, not a new assistant response.
    emit({ type: 'assistant', uuid: 'late-text-2', message: { id: 'msg_multi', content: [{ type: 'text', text: 'Repeated block\n' }] } });
    expect(conv().streamingMessage).toBeNull();
    expect(conv().messages).toHaveLength(1);
    await state().sendPrompt('next turn');
    partial({ type: 'message_start', message: { id: 'next-api-message' } });
    partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Next answer\n' } });
    emit({ type: 'assistant', uuid: 'next-answer', message: { id: 'next-api-message', content: [{ type: 'text', text: 'Next answer\n' }] } });
    // Same normalised UUID, different final metadata, after a newer block/message.
    emit({ type: 'assistant', uuid: 'text-1', message: { id: 'msg_multi', content: [{ type: 'text', text: 'Repeated block\n' }], stop_reason: 'end_turn' } });
    emit({ type: 'result', subtype: 'success', result: 'Next answer\n' });
    expect(conv().messages.filter(m => m.role === 'assistant').flatMap(m => m.blocks.filter(b => b.kind === 'text').map(b => b.text)))
      .toEqual(['Repeated block\n', 'Repeated block\n', 'Next answer\n']);
  });
  it('full-only SDK normalised UUIDs preserve separate equal blocks without partial frames', () => {
    emit({ type: 'assistant', uuid: 'block-one', message: { id: 'full-api', content: [{ type: 'text', text: 'Repeated\n' }] } });
    emit({ type: 'assistant', uuid: 'block-two', message: { id: 'full-api', content: [{ type: 'text', text: 'Repeated\n' }] } });
    expect(conv().streamingMessage!.blocks.filter(b => b.kind === 'text').map(b => b.text)).toEqual(['Repeated\n', 'Repeated\n']);
    const packed = { type: 'assistant', uuid: 'packed', message: { id: 'next-full-api', content: [
      { type: 'text', text: 'Also repeated\n' }, { type: 'text', text: 'Also repeated\n' },
    ] } };
    emit(packed); emit({ ...packed, uuid: 'packed-echo' });
    expect(conv().streamingMessage!.blocks.filter(b => b.kind === 'text').map(b => b.text))
      .toEqual(['Repeated\n', 'Repeated\n', 'Also repeated\n', 'Also repeated\n']);
  });
  it('result fallback belongs to the final API response, not a prior tool preamble or another turn', async () => {
    await state().sendPrompt('first turn');
    emit({ type: 'assistant', message: { id: 'opening', content: [
      { type: 'text', text: 'Opening text' },
      { type: 'tool_use', id: 'probe', name: 'Bash', input: {} },
    ] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'probe', content: 'done' }] } });
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'final-without-body' } } });
    emit({ type: 'result', uuid: 'first-result', subtype: 'success', result: 'Final fallback\n' });
    expect(conv().messages.filter(m => m.role === 'assistant').flatMap(m => m.blocks.filter(b => b.kind === 'text').map(b => b.text)))
      .toEqual(['Opening text', 'Final fallback\n']);
    await state().sendPrompt('second turn');
    emit({ type: 'assistant', message: { id: 'independent-answer', content: [{ type: 'text', text: 'Final fallback\n' }] } });
    emit({ type: 'result', uuid: 'second-result', subtype: 'success', result: 'Final fallback\n' });
    expect(conv().messages.filter(m => m.role === 'assistant').flatMap(m => m.blocks.filter(b => b.kind === 'text').map(b => b.text)))
      .toEqual(['Opening text', 'Final fallback\n', 'Final fallback\n']);
  });
  it('partial thinking does not suppress full text, and interleaved block indices retain identity', () => {
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think' } } });
    emit({ type: 'assistant', message: { id: 'm', content: [{ type: 'thinking', thinking: 'think' }, { type: 'text', text: 'answer' }] } });
    expect(conv().streamingMessage?.blocks.filter(b => b.kind === 'text').map(b => b.text)).toEqual(['answer']);
  });
  it('a persistent connected send supplies current startup settings and supports structured TaskList/Get outputs', async () => {
    const send = vi.fn().mockImplementation(payload => Promise.resolve({ success: true, runId: 'run', userMessageId: payload.userMessageId, sessionId: 's' }));
    vi.stubGlobal('window', { api: { claude: { send } } });
    state().setRuntime(conv().id, { runId: 'run', state: 'ready', info: { permissionMode: 'plan' } });
    await state().sendPrompt('q');
    expect(send.mock.calls[0][0].options).toMatchObject({ permissionMode: 'plan' });
    expect(send.mock.calls[0][0].cwd).toBe('/tmp');
    emit({ type: 'assistant', message: { id: 'tasks', content: [{ type: 'tool_use', id: 'list', name: 'TaskList', input: {} }] } });
    emit({ type: 'user', tool_use_result: { tasks: [{ id: '1', subject: 'one', status: 'pending', blockedBy: [] }] }, message: { content: [{ type: 'tool_result', tool_use_id: 'list', content: 'human output' }] } });
    expect(conv().todoList?.items).toMatchObject([{ id: '1', content: 'one', status: 'pending' }]);
    emit({ type: 'assistant', message: { id: 'get', content: [{ type: 'tool_use', id: 'get', name: 'TaskGet', input: { taskId: '1' } }] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'get', content: '{"task":{"id":"1","subject":"renamed","status":"completed"}}' }] } });
    expect(conv().todoList?.items).toMatchObject([{ id: '1', content: 'renamed', status: 'completed' }]);
  });
  it('historical nested assistant content remains attached to its agent', () => {
    const messages = convertSessionMessages([
      { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 'p', name: 'Agent', input: {} }] } },
      { type: 'assistant', uuid: 'b', parent_tool_use_id: 'p', message: { content: [{ type: 'text', text: 'child' }] } },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].blocks[0]).toMatchObject({ children: [{ kind: 'text', text: 'child' }] });
  });
});

describe('protocol boundary regressions', () => {
  it('deduplicates an exact assistant UUID event but retains different shards sharing UUID', () => {
    const base = { type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'text', text: 'one' }] } };
    emit(base); emit(base);
    emit({ ...base, message: { id: 'm', content: [{ type: 'text', text: 'two' }] } });
    expect(conv().streamingMessage?.blocks).toMatchObject([{ kind: 'text', text: 'onetwo' }]);
  });
  it('unknown system metadata retains all fields and runtime secrets never persist through notices', () => {
    const event = { type: 'system', subtype: 'hook_response', hook_id: 'h', output: { stdout: 'hi' }, extra: { nested: 1 } };
    emit(event);
    expect(conv().messages[0].blocks[0]).toMatchObject({ kind: 'notice', raw: event });
    emit({ type: 'system', subtype: 'runtime', info: { env: { TOKEN: 'secret' } }, pendingApprovals: [] });
    expect(JSON.stringify(snapshotConversations(state().conversations))).not.toContain('secret');
  });
  it('a buffered final delta survives close and background late full message stays under archived parent', () => {
    emit({ type: 'system', subtype: 'init', session_id: 's' });
    emit({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'p', name: 'Agent', input: {} }] } });
    emit({ type: 'result', subtype: 'success', result: '' });
    emit({ type: 'assistant', parent_tool_use_id: 'p', message: { id: 'child', content: [{ type: 'text', text: 'late child' }] } });
    expect(conv().streamingMessage).toBeNull();
    expect(conv().messages[0].blocks[0]).toMatchObject({ children: [{ kind: 'text', text: 'late child' }] });
    state().sendPrompt('next');
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'last' } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tail' } } });
    state().closeConversation(conv().id);
    expect(JSON.stringify(state().sessions)).toContain('tail');
  });
});

describe('history and task seam', () => {
  it('applies TodoWrite only after successful result and merges namespaced Task CRUD', () => {
    const tool = (id: string, name: string, input: unknown, parent?: string) => emit({ type: 'assistant', parent_tool_use_id: parent, message: { id, content: [{ type: 'tool_use', id, name, input }] } });
    const done = (id: string, content: unknown, error = false) => emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: error }] } });
    tool('todo', 'TodoWrite', { todos: [{ content: 'base', status: 'pending' }] });
    expect(conv().todoList).toBeNull();
    done('todo', 'ok');
    expect(conv().todoList?.items.map(t => t.content)).toEqual(['base']);
    tool('create', 'TaskCreate', { subject: 'root task' }); done('create', 'Task #1 created successfully: root task');
    tool('p', 'Agent', {});
    tool('sub-create', 'TaskCreate', { subject: 'child task' }, 'p'); done('sub-create', '{"id":"1","subject":"child task","status":"pending"}');
    tool('update', 'TaskUpdate', { taskId: '1', status: 'completed', addBlockedBy: ['2'] }); done('update', 'ok');
    expect(conv().todoList?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '1', content: 'root task', status: 'completed', blockedBy: ['2'] }),
      expect.objectContaining({ id: 'p:1', content: 'child task', status: 'pending' }),
    ]));
    tool('fail', 'TaskUpdate', { taskId: '1', status: 'deleted' }); done('fail', 'denied', true);
    expect(conv().todoList?.items.some(t => t.id === '1')).toBe(true);
    tool('delete', 'TaskUpdate', { taskId: '1', status: 'deleted' }); done('delete', 'ok');
    expect(conv().todoList?.items.some(t => t.id === '1')).toBe(false);
  });
  it('imports SDK pages, ties tool_result back and exposes checkpoint chain anchors', () => {
    const messages = [
      { type: 'user', uuid: 'u', message: { content: 'question' } },
      { type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
      { type: 'user', uuid: 'r', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'contents' }] } },
      { type: 'assistant', uuid: 'b', message: { content: [{ type: 'text', text: 'answer' }] } },
    ];
    const converted = convertSessionMessages({ messages, raw: 'jsonl' });
    expect(converted.map(m => m.cliUuid)).toEqual(['u', 'a', 'b']);
    expect(converted[1]).toMatchObject({ endUuid: 'r', blocks: [{ kind: 'tool_use', status: 'done', result: 'contents' }] });
    const id = state().importSession({ sessionId: 'forked', cwd: '/project', title: 'fork', messages: { messages } });
    expect(state().conversations.find(c => c.id === id)?.messages).toHaveLength(3);
    expect(state().sessions[0].origin).toBe('cli');
  });
  it('background partial after result remains visible without reviving main failure/counters', () => {
    emit({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.1 });
    emit({ type: 'stream_event', parent_tool_use_id: 'background', event: { type: 'message_start', message: { id: 'bg' } } });
    emit({ type: 'stream_event', parent_tool_use_id: 'background', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'background output' } } });
    state().setStatus('error');
    expect(JSON.stringify(conv().messages)).toContain('background output');
    expect(conv().status).toBe('completed');
    expect(state().totalCost).toBe(0.1);
  });
});

describe('same-generation queued turn boundaries', () => {
  it('keeps two GUI queued turns behind the exact result/status/ready/accept/busy IPC order', async () => {
    const receipts: Array<() => void> = [];
    const send = vi.fn().mockImplementation(p => new Promise(resolve => {
      receipts.push(() => resolve({ success: true, runId: 'persistent', userMessageId: p.userMessageId }));
    }));
    vi.stubGlobal('window', { api: { claude: { send } } });
    const id = conv().id;
    state().setRuntime(id, { runId: 'persistent', state: 'busy', busy: true });
    state().enqueueMessage('second'); state().enqueueMessage('third');
    emit({ type: 'result', runId: 'persistent', uuid: 'first-result', subtype: 'success', hasPending: false, result: 'first' });
    const shell = conv().streamingMessage;
    expect(send).toHaveBeenCalledTimes(1);
    expect(state().setStatus('completed', id, 'persistent')).toBe(false);
    state().setRuntime(id, { runId: 'persistent', state: 'ready', busy: false, pendingUserMessageIds: [] });
    expect(conv()).toMatchObject({ status: 'streaming', queue: ['third'] });
    expect(conv().streamingMessage).toBe(shell);
    receipts[0](); await vi.waitFor(() => expect(conv().messages.find(m => m.role === 'user')?.cliUuid).toBe(send.mock.calls[0][0].userMessageId));
    state().setRuntime(id, { runId: 'persistent', state: 'busy', busy: true, pendingUserMessageIds: [send.mock.calls[0][0].userMessageId] });
    expect(state().setStatus('completed', id, 'persistent')).toBe(false);
    expect(conv().queue).toEqual(['third']);
    emit({ type: 'result', runId: 'persistent', uuid: 'second-result', user_message_uuid: send.mock.calls[0][0].userMessageId, subtype: 'success', hasPending: false, result: 'second' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(state().setStatus('completed', id, 'persistent')).toBe(false);
    state().setRuntime(id, { runId: 'persistent', state: 'ready', busy: false, pendingUserMessageIds: [] });
    receipts[1](); await Promise.resolve(); await Promise.resolve();
    state().setRuntime(id, { runId: 'persistent', state: 'busy', busy: true });
    expect(conv()).toMatchObject({ status: 'streaming', queue: [] });
    emit({ type: 'result', runId: 'persistent', uuid: 'third-result', user_message_uuid: send.mock.calls[1][0].userMessageId, subtype: 'success', hasPending: false, result: 'third' });
    expect(state().setStatus('completed', id, 'persistent')).toBe(true);
    expect(conv().messages.filter(m => m.role === 'assistant').flatMap(m => m.blocks.filter(b => b.kind === 'text').map(b => b.text))).toEqual(['first', 'second', 'third']);
  });
});

describe('current runner state and stop guarantees', () => {
  it('runner and approval validation errors are visible; absent snapshots never retire live approvals', () => {
    const id = conv().id;
    state().setRuntime(id, { runId: 'run', state: 'busy', busy: true, pendingApprovals: [
      { requestId: 'p', kind: 'elicitation', status: 'waiting', input: { requestedSchema: { type: 'object' } } },
      { requestId: 'other', kind: 'tool', status: 'waiting' },
    ] });
    const other = conv().pendingApprovals![1];
    const validation = { type: 'approval_validation_error', runId: 'run', requestId: 'p', kind: 'elicitation', error: 'Content does not match schema' };
    emit(validation);
    expect(conv().pendingApprovals![0]).toMatchObject({ requestId: 'p', validationError: validation.error });
    expect(conv().pendingApprovals![1]).toBe(other);
    const failed = conv().pendingApprovals![0];
    // A missing snapshot is not a confirmed close; the runner explicitly sends [] to clear.
    expect(() => state().setRuntime(id, null)).not.toThrow();
    expect(() => state().setRuntime(id, undefined)).not.toThrow();
    state().setRuntime(id, { info: { model: 'actual' } });
    expect(conv().pendingApprovals![0]).toBe(failed);
    const error = { type: 'runner_error', runId: 'run', operation: 'query', error: 'Query ended before a final result' };
    emit(error);
    expect(conv().messages.filter(m => m.status === 'error').map(m => m.metadata)).toEqual([validation, error]);
    expect(conv().messages.filter(m => m.status === 'error').flatMap(m => m.blocks)).toMatchObject([
      { kind: 'stderr', text: validation.error }, { kind: 'stderr', text: error.error },
    ]);
    expect(conv().status).toBe('streaming'); // Only the runner status confirms lifecycle changes.
    state().setRuntime(id, { pendingApprovals: [] });
    expect(conv().pendingApprovals).toEqual([]);
  });
  it('partial text only suppresses its indexed block, not another complete text block', () => {
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } } });
    emit({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] } });
    expect(conv().streamingMessage?.blocks.filter(b => b.kind === 'text').map(b => b.text)).toEqual(['first', 'second']);
  });
  it('interrupt success permits a new body before acceptance without dropping it', async () => {
    const send = vi.fn().mockImplementation(p => {
      emit({ type: 'assistant', runId: 'new', message: { id: 'answer', content: [{ type: 'text', text: 'new body' }] } });
      emit({ type: 'result', runId: 'new', uuid: 'finished', subtype: 'success', result: 'new body', hasPending: false });
      return Promise.resolve({ success: true, runId: 'new', userMessageId: p.userMessageId });
    });
    vi.stubGlobal('window', { api: { claude: { send, interrupt: async () => ({ success: true, closed: true }) } } });
    state().setRuntime(conv().id, { runId: 'old', state: 'busy', busy: true });
    await state().sendPrompt('replacement', conv().id, { interrupt: true });
    expect(JSON.stringify(conv().messages)).toContain('new body');
    expect(conv()).toMatchObject({ status: 'completed', streamingMessage: null, runtime: { state: 'ready', busy: false } });
  });
  it('late accepted receipt from a retired generation cannot resurrect the runtime', async () => {
    let accept!: (value: unknown) => void;
    const send = vi.fn().mockImplementation(() => new Promise(resolve => { accept = resolve; }));
    vi.stubGlobal('window', { api: { claude: { send } } });
    const pending = state().sendPrompt('q');
    emit({ type: 'assistant', runId: 'old', message: { id: 'm', content: [{ type: 'text', text: 'old' }] } });
    state().setRuntime(conv().id, { runId: null, state: 'closed', busy: false });
    accept({ success: true, runId: 'old', userMessageId: send.mock.calls[0][0].userMessageId });
    await pending;
    expect(conv()).toMatchObject({ protocolConnected: false, status: 'aborted', runtime: { busy: false } });
  });
  it('runner delta cost and model usage do not accumulate cumulative fields twice', () => {
    emit({ type: 'result', uuid: 'one', subtype: 'success', total_cost_usd: 0.1, cumulativeCostUsd: 0.1, modelUsage: { m: { inputTokens: 10, outputTokens: 2 } } });
    emit({ type: 'result', uuid: 'two', subtype: 'success', total_cost_usd: 0.2, cumulativeCostUsd: 0.3, modelUsage: { m: { inputTokens: 5, outputTokens: 3 } }, cumulativeUsage: { m: { inputTokens: 15, outputTokens: 5 } } });
    expect(state().totalCost).toBeCloseTo(0.3);
    expect(state().totalInputTokens).toBe(15);
    expect(state().totalOutputTokens).toBe(5);
  });
  it('actual completed callback drains GUI queue after a pending batch', async () => {
    const send = vi.fn().mockImplementation(p => Promise.resolve({ success: true, userMessageId: p.userMessageId, runId: 'r' }));
    vi.stubGlobal('window', { api: { claude: { send } } });
    state().setRuntime(conv().id, { runId: 'r', state: 'busy', busy: true });
    state().enqueueMessage('next');
    emit({ type: 'result', uuid: 'pending', runId: 'r', subtype: 'success', result: 'batch', hasPending: true });
    expect(send).not.toHaveBeenCalled();
    state().setStatus('completed', conv().id, 'r');
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].prompt).toBe('next');
    expect(conv().queue).toEqual([]);
    expect(conv().status).toBe('streaming');
  });
  it('ready snapshot settles pending batch and drains queue even after background output', async () => {
    const send = vi.fn().mockImplementation(p => Promise.resolve({ success: true, userMessageId: p.userMessageId, runId: 'r' }));
    vi.stubGlobal('window', { api: { claude: { send } } });
    state().setRuntime(conv().id, { runId: 'r', busy: true });
    state().enqueueMessage('next');
    emit({ type: 'result', uuid: 'pending', runId: 'r', subtype: 'success', hasPending: true });
    emit({ type: 'assistant', runId: 'r', parent_tool_use_id: 'bg', message: { id: 'bg', content: [{ type: 'text', text: 'background' }] } });
    state().setRuntime(conv().id, { state: 'ready', busy: false });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(conv().status).toBe('streaming');
    expect(conv().queue).toEqual([]);
  });
  it('thrown interrupt failure blocks replacement and retains a visible error', async () => {
    const send = vi.fn();
    vi.stubGlobal('window', { api: { claude: { send, interrupt: async () => { throw new Error('transport failed'); } } } });
    await state().sendPrompt('replacement', conv().id, { interrupt: true });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(conv().messages)).toContain('transport failed');
  });
  it('missing interrupt API cannot silently send a replacement', async () => {
    const send = vi.fn();
    vi.stubGlobal('window', { api: { claude: { send } } });
    await state().sendPrompt('replacement', conv().id, { interrupt: true });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(conv().messages)).toContain('stop cannot be confirmed');
  });
  it('preserves UUID shape without randomUUID and binds the exact runner nonce', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(255) });
    expect(generateUserMessageId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    const send = vi.fn().mockImplementation(p => Promise.resolve({ success: true, userMessageId: p.userMessageId, runId: 'r' }));
    vi.stubGlobal('window', { api: { claude: { send } } });
    await state().sendPrompt('q');
    expect(conv().messages[0].cliUuid).toBe(send.mock.calls[0][0].userMessageId);
  });
  it('rehydrates actual starting/busy/ready/closed snapshots and array capabilities', () => {
    const id = conv().id;
    state().setRuntime(id, { state: 'starting', busy: true, runId: null, info: null });
    expect(conv().status).toBe('starting');
    state().setRuntime(id, { runId: 'r', state: 'busy', busy: true, info: { permissionMode: 'plan', capabilities: ['interrupt_receipt_v1'] }, commands: [{ name: 'context' }], pendingUserMessageIds: ['u'] });
    expect(conv()).toMatchObject({ status: 'streaming', capabilities: ['interrupt_receipt_v1'], commands: [{ name: 'context' }] });
    state().setRuntime(id, { state: 'ready', busy: false, pendingUserMessageIds: [], info: { model: 'actual' } });
    expect(conv()).toMatchObject({ status: 'completed', permissionMode: 'plan', runtime: { info: { permissionMode: 'plan', model: 'actual' } } });
    state().setRuntime(id, { state: 'closed', busy: false, runId: null, info: null });
    expect(conv()).toMatchObject({ protocolConnected: false, capabilities: [], pendingApprovals: [] });
  });
  it('pending results archive the batch without draining GUI queue and allow actual status to settle', () => {
    state().setRuntime(conv().id, { runId: 'r', state: 'busy', busy: true });
    state().enqueueMessage('next');
    emit({ type: 'result', uuid: 'result', runId: 'r', subtype: 'success', result: 'batch', hasPending: true, total_cost_usd: 0.1 });
    expect(conv()).toMatchObject({ status: 'streaming', streamingMessage: null, queue: ['next'], runtime: { busy: true } });
    emit({ type: 'assistant', runId: 'r', parent_tool_use_id: 'bg', message: { id: 'bg', content: [{ type: 'text', text: 'background' }] } });
    state().setStatus('error', conv().id, 'r');
    expect(conv().status).toBe('error');
    expect(conv().queue).toEqual([]);
    expect(state().totalCost).toBe(0.1);
  });
  it('a result before acceptance cannot be revived by the delayed receipt', async () => {
    let accept!: (value: unknown) => void;
    const send = vi.fn().mockImplementation(() => new Promise(resolve => { accept = resolve; }));
    vi.stubGlobal('window', { api: { claude: { send } } });
    const sending = state().sendPrompt('q');
    emit({ type: 'result', runId: 'r', uuid: 'done', subtype: 'success', result: 'done', hasPending: false });
    accept({ success: true, runId: 'r', userMessageId: send.mock.calls[0][0].userMessageId });
    await sending;
    expect(conv()).toMatchObject({ status: 'completed', streamingMessage: null, runtime: { busy: false } });
  });
  it('interrupt rejection never sends and preserves the active shell and draft', async () => {
    const send = vi.fn();
    const interrupt = vi.fn().mockResolvedValue({ success: false, stillQueued: ['u'], error: 'stop unconfirmed' });
    vi.stubGlobal('window', { api: { claude: { send, interrupt } } });
    emit({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'working' }] } });
    state().setStatus('streaming'); state().setDraft('keep');
    const shell = conv().streamingMessage;
    await state().sendPrompt('replacement', conv().id, { interrupt: true });
    expect(send).not.toHaveBeenCalled();
    expect(conv().streamingMessage).toBe(shell);
    expect(conv().draft).toBe('keep');
    expect(JSON.stringify(conv().messages)).toContain('stop unconfirmed');
  });
  it('stop-only failures are visible and confirmed close fallback disconnects the protocol', async () => {
    const interrupt = vi.fn().mockResolvedValue({ success: false, error: 'still queued' });
    const close = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('window', { api: { claude: { interrupt, close } } });
    state().setRuntime(conv().id, { runId: 'old', state: 'busy', busy: true });
    await abortConversation(conv().id);
    expect(close).toHaveBeenCalledWith(conv().id);
    expect(conv()).toMatchObject({ protocolConnected: false, status: 'aborted', runtime: { busy: false, state: 'closed' } });
    expect(JSON.stringify(conv().messages)).toContain('still queued');
  });
  it('failed close does not claim a stopped runtime or send queued replacement', async () => {
    const send = vi.fn();
    vi.stubGlobal('window', { api: { claude: { send, interrupt: async () => ({ success: false, error: 'interrupt failed' }), close: async () => ({ success: false, error: 'close failed' }) } } });
    state().setRuntime(conv().id, { runId: 'r', state: 'busy', busy: true });
    await abortConversation(conv().id);
    expect(conv()).toMatchObject({ protocolConnected: true, status: 'streaming', runtime: { busy: true } });
    expect(JSON.stringify(conv().messages)).toContain('close failed');
    expect(send).not.toHaveBeenCalled();
  });
  it('closed interrupt restarts with full current settings and ignores retired receipt', async () => {
    const send = vi.fn().mockImplementation(p => Promise.resolve({ success: true, runId: 'new', userMessageId: p.userMessageId }));
    vi.stubGlobal('window', { api: { claude: { send, interrupt: async () => ({ success: true, closed: true }) } } });
    state().setRuntime(conv().id, { runId: 'old', state: 'busy', busy: true, info: { permissionMode: 'auto' } });
    state().setModel('new-model');
    await state().sendPrompt('replacement', conv().id, { interrupt: true });
    expect(send.mock.calls[0][0]).toMatchObject({ cwd: '/tmp', options: { model: 'new-model', permissionMode: 'auto' } });
    expect(conv()).toMatchObject({ runId: 'new', status: 'streaming' });
    emit({ type: 'result', runId: 'old', uuid: 'retired', subtype: 'success', result: 'ghost' });
    expect(JSON.stringify(conv())).not.toContain('ghost');
  });
});

describe('persistent SDK send seam', () => {
  it('binds accepted UUID to the exact local nonce even when replay arrives before receipt; busy send preserves shell', async () => {
    let accept!: (value: unknown) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }))
      .mockImplementation(payload => Promise.resolve({ success: true, sessionId: 'session', userMessageId: payload.userMessageId, runId: 'run' }));
    vi.stubGlobal('window', { api: { claude: { send } } });
    const first = state().sendPrompt('same');
    expect(first).toBeInstanceOf(Promise);
    const firstNonce = send.mock.calls[0][0].userMessageId;
    emit({ type: 'user', runId: 'run', uuid: firstNonce, message: { content: 'same' } });
    emit({ type: 'assistant', runId: 'run', uuid: 'a-1', message: { id: 'm', content: [{ type: 'text', text: 'working' }] } });
    const shell = conv().streamingMessage;
    await state().sendPrompt('same');
    accept({ success: true, sessionId: 'session', userMessageId: firstNonce, runId: 'run' });
    await first;
    expect(conv().messages.filter(m => m.role === 'user').map(m => m.cliUuid)).toEqual([firstNonce, send.mock.calls[1][0].userMessageId]);
    expect(conv().streamingMessage).toBe(shell);
    expect(send.mock.calls[0][0].userMessageId).toMatch(/^[a-f0-9-]{36}$/);
    emit({ type: 'user', runId: 'run', uuid: 'old-user', message: { content: 'same' } });
    expect(conv().messages.filter(m => m.role === 'user')).toHaveLength(2);
  });
  it('IPC failures are visible in the target tab without destroying draft', async () => {
    vi.stubGlobal('window', { api: { claude: { send: () => Promise.resolve({ success: false, error: 'backpressure' }) } } });
    state().setDraft('keep');
    await state().sendPrompt('q');
    expect(conv().draft).toBe('keep');
    expect(conv().status).toBe('error');
    expect(JSON.stringify(conv().messages)).toContain('backpressure');
  });
  it('restores live approvals from getState, rejects retired generations and strips runtime persistence', () => {
    state().setRuntime(conv().id, { sessionId: 's', runId: 'old', state: 'ready', busy: false, info: { permissionMode: 'plan' }, pendingApprovals: [] });
    state().setRuntime(conv().id, { sessionId: 's', runId: 'new', state: 'busy', busy: true, info: { permissionMode: 'auto' }, pendingApprovals: [{ requestId: 'p', kind: 'tool', status: 'waiting', input: { token: 'secret' } }] });
    emit({ type: 'assistant', runId: 'old', message: { id: 'late', content: [{ type: 'text', text: 'stale' }] } });
    expect(conv().streamingMessage).toBeNull();
    expect(conv().permissionMode).toBe('auto');
    expect(conv().pendingApprovals).toHaveLength(1);
    const snapshot = snapshotConversations(state().conversations);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(snapshot[0].runId).toBeUndefined();
    state().hydrate({ conversations: [{ ...conv(), options: { token: 'secret' } }] });
    expect(JSON.stringify(conv())).not.toContain('secret');
  });
});