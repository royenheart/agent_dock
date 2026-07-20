const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDiscoveryOutput } = require('../../out/agents/parse');
const { renderClaudeTranscript, renderCodexTranscript, renderOpencodeTranscript } = require('../../out/agents/transcript');

test('parse: python json path', () => {
  const stdout = [
    '===AGENTWS:meta===',
    '{"python3":1,"sqlite3":1}',
    '===AGENTWS:json===',
    JSON.stringify({
      opencode: [{ id: 'ses_1', title: 'oc', cwd: '/p', created: 1750000000000, updated: 1750000001000 }],
      codex: [{ id: 'uuid-1', title: 'cx', cwd: '/q', created: 1750000000000, updated: 1750000002000, path: '/home/u/.codex/sessions/2026/07/20/rollout-x.jsonl' }],
      claude: [{ id: 'cl-1', title: 'cl', cwd: '/r', created: 1750000000000, updated: 1750000003000, path: '/home/u/.claude/projects/-r/cl-1.jsonl' }],
      notes: ['n1'],
    }),
    '===AGENTWS:end===',
  ].join('\n');
  const { sessions, notes } = parseDiscoveryOutput(stdout);
  assert.equal(sessions.length, 3);
  assert.deepEqual(notes, ['n1']);
  const oc = sessions.find((s) => s.agent === 'opencode');
  assert.equal(oc.title, 'oc');
  assert.equal(oc.sourcePath, undefined);
  const cx = sessions.find((s) => s.agent === 'codex');
  assert.equal(cx.sourcePath, '/home/u/.codex/sessions/2026/07/20/rollout-x.jsonl');
  assert.ok(cx.timeUpdated > 0);
});

test('parse: shell fallback with file chunks', () => {
  const meta = JSON.stringify({ timestamp: '2026-07-01T04:00:00.000Z', id: 'uuid-a', cwd: '/proj' });
  const userMsg = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修复登录bug' }] } });
  const claudeSummary = JSON.stringify({ type: 'summary', summary: '数据库迁移排查', cwd: '/dbproj' });
  const stdout = [
    '===AGENTWS:meta===',
    '{"python3":0,"sqlite3":0}',
    '===AGENTWS:opencode===',
    '',
    '===AGENTWS:codex-index===',
    '{"id":"uuid-a","thread_name":"已命名会话"}',
    '===AGENTWS:codex===',
    '===AGENTWS:file===',
    '1751400000.5 /home/u/.codex/sessions/2026/07/01/rollout-a.jsonl',
    meta,
    userMsg,
    '',
    '===AGENTWS:claude===',
    '===AGENTWS:file===',
    '1751400100.2 /home/u/.claude/projects/-dbproj/aaaa-bbbb.jsonl',
    claudeSummary,
    '',
    '===AGENTWS:end===',
  ].join('\n');
  const { sessions, notes } = parseDiscoveryOutput(stdout);
  const cx = sessions.find((s) => s.agent === 'codex');
  assert.equal(cx.title, '已命名会话');
  assert.equal(cx.cwd, '/proj');
  assert.ok(cx.timeCreated > 0);
  const cl = sessions.find((s) => s.agent === 'claude');
  assert.equal(cl.title, '数据库迁移排查');
  assert.equal(cl.cwd, '/dbproj');
  assert.ok(notes.some((n) => n.includes('python3')));
});

test('parse: codex title falls back to first real user message, skipping envelopes', () => {
  const meta = JSON.stringify({ timestamp: '2026-07-01T04:00:00.000Z', id: 'uuid-b', cwd: '/p' });
  const env = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>blah' }] } });
  const real = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真正的问题' }] } });
  const stdout = ['===AGENTWS:meta===', '{"python3":0}', '===AGENTWS:codex===', '===AGENTWS:file===', '1751400000.1 /x.jsonl', meta, env, real, '===AGENTWS:end==='].join('\n');
  const { sessions } = parseDiscoveryOutput(stdout);
  assert.equal(sessions[0].title, '真正的问题');
});

test('claude: tool_use pairs with tool_result; TodoWrite becomes todo block', () => {
  const lines = [
    { type: 'summary', summary: 't' },
    { type: 'user', message: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '回答' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }, { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: '步骤1', status: 'completed' }, { content: '步骤2', status: 'in_progress' }] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const blocks = renderClaudeTranscript(lines);
  assert.deepEqual(blocks.map((b) => b.kind), ['text', 'thinking', 'text', 'tool', 'todo']);
  const tool = blocks.find((b) => b.kind === 'tool');
  assert.equal(tool.name, 'Read');
  assert.equal(tool.output, 'file body');
  assert.equal(tool.isError, false);
  const todo = blocks.find((b) => b.kind === 'todo');
  assert.deepEqual(todo.items, [
    { content: '步骤1', status: 'completed' },
    { content: '步骤2', status: 'in_progress' },
  ]);
});

test('claude: compact boundary and compact summary are notices', () => {
  const lines = [
    { type: 'user', message: { content: [{ type: 'text', text: '问题' }] } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', isCompactSummary: true, message: { content: [{ type: 'text', text: 'long summary' }] } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const blocks = renderClaudeTranscript(lines);
  assert.deepEqual(blocks.map((b) => b.kind), ['text', 'notice', 'notice']);
});

test('codex: function_call pairs with output; shell and plan supported', () => {
  const lines = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '问题' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'c1', arguments: '{"cmd":"ls"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'file1\nfile2' } },
    { type: 'response_item', payload: { type: 'local_shell_call', action: { command: ['npm', 'run', 'build'] } } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '思考一下' }] } },
    { type: 'event_msg', payload: { type: 'plan_update', plan: [{ step: '写代码', status: 'in_progress' }, { step: '测试', status: 'pending' }] } },
    { type: 'event_msg', payload: { type: 'patch_apply_end', changes: { '/a.ts': {}, '/b.ts': {} } } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const blocks = renderCodexTranscript(lines);
  assert.deepEqual(blocks.map((b) => b.kind), ['text', 'tool', 'tool', 'thinking', 'todo', 'files']);
  assert.equal(blocks[0].markdown, '问题');
  const fn = blocks[1];
  assert.equal(fn.name, 'exec');
  assert.equal(fn.output, 'file1\nfile2');
  assert.equal(blocks[2].name, 'shell');
  assert.equal(blocks[2].input, 'npm run build');
  assert.deepEqual(blocks[4].items.map((i) => i.content), ['写代码', '测试']);
  assert.deepEqual(blocks[5].files, ['/a.ts', '/b.ts']);
});

test('opencode: tool state, todos and v2 fallback', () => {
  const dump = {
    messages: [
      ['m1', JSON.stringify({ role: 'user', time: { created: 1 } })],
      ['m2', JSON.stringify({ role: 'assistant', time: { created: 2 } })],
    ],
    parts: [
      ['m1', JSON.stringify({ type: 'text', text: '问' })],
      ['m2', JSON.stringify({ type: 'text', text: '答' })],
      ['m2', JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'ok' } })],
      ['m2', JSON.stringify({ type: 'tool', tool: 'edit', state: { status: 'error', input: { file: 'a' }, error: 'denied' } })],
    ],
    todos: [['完成任务', 'in_progress', 'high'], ['收尾', 'pending', 'low']],
    v2: [],
  };
  const stdout = ['===AGENTWS:json===', JSON.stringify(dump)].join('\n');
  const blocks = renderOpencodeTranscript(stdout);
  assert.deepEqual(blocks.map((b) => b.kind), ['text', 'text', 'tool', 'tool', 'todo']);
  assert.equal(blocks[2].output, 'ok');
  assert.equal(blocks[2].status, 'completed');
  assert.equal(blocks[3].isError, true);
  assert.equal(blocks[3].output, 'denied');
  assert.deepEqual(blocks[4].items.map((i) => i.content), ['完成任务', '收尾']);
});

test('opencode: v2 session_message used when v1 empty', () => {
  const dump = {
    messages: [],
    parts: [],
    todos: [],
    v2: [
      ['user', JSON.stringify({ time: { created: 1 }, content: [{ type: 'text', text: 'v2 问题' }] })],
      ['assistant', JSON.stringify({ time: { created: 2 }, content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: 'v2 回答' }, { type: 'tool', tool: 'read', state: { status: 'completed', input: { f: 1 }, output: 'data' } }] })],
      ['compaction', JSON.stringify({})],
    ],
  };
  const stdout = ['===AGENTWS:json===', JSON.stringify(dump)].join('\n');
  const blocks = renderOpencodeTranscript(stdout);
  assert.deepEqual(blocks.map((b) => b.kind), ['text', 'thinking', 'text', 'tool', 'notice']);
  assert.equal(blocks[0].markdown, 'v2 问题');
  assert.equal(blocks[3].output, 'data');
});
