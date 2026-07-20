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

test('opencode: model/agent meta attaches on change only', () => {
  const dump = {
    messages: [
      ['m1', JSON.stringify({ role: 'user', agent: 'Sisyphus', model: { providerID: 'cch', modelID: 'k3' }, time: { created: 1 } })],
      ['m2', JSON.stringify({ role: 'assistant', agent: 'Sisyphus', model: null, time: { created: 2 } })],
      ['m3', JSON.stringify({ role: 'assistant', agent: 'explorer', model: { providerID: 'cch', modelID: 'k3' }, time: { created: 3 } })],
    ],
    parts: [
      ['m1', JSON.stringify({ type: 'text', text: '问' })],
      ['m2', JSON.stringify({ type: 'text', text: '答1' })],
      ['m3', JSON.stringify({ type: 'text', text: '答2' })],
    ],
  };
  const stdout = ['===AGENTWS:json===', JSON.stringify(dump)].join('\n');
  const blocks = renderOpencodeTranscript(stdout);
  assert.equal(blocks[0].meta, 'Sisyphus · cch/k3');
  assert.equal(blocks[1].meta, undefined, 'same agent/model key — no repeated meta');
  assert.equal(blocks[2].meta, 'explorer · cch/k3', 'agent switch surfaces as new meta');
});

test('codex: turn_context model switch emits notice and tracks summary model', () => {
  const lines = [
    { timestamp: '2026-07-01T04:00:00Z', id: 'u1', cwd: '/p', model_provider: 'openai' },
    { type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.5', cwd: '/p' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答' }] } },
    { type: 'turn_context', payload: { turn_id: 't2', model: 'gpt-5.5', cwd: '/p' } },
    { type: 'turn_context', payload: { turn_id: 't3', model: 'gpt-6', cwd: '/p' } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const acc = {};
  const blocks = renderCodexTranscript(lines, undefined, acc);
  const notices = blocks.filter((b) => b.kind === 'notice').map((b) => b.text);
  assert.deepEqual(notices, ['⇄ model → gpt-5.5', '⇄ model → gpt-6']);
  assert.equal(acc.model, 'gpt-6');
});

test('claude: sidechain records carry subagent meta', () => {
  const lines = [
    { type: 'assistant', isSidechain: true, message: { model: 'm-x', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: '子代理回答' }] } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const blocks = renderClaudeTranscript(lines);
  assert.ok(blocks[0].meta.includes('(subagent)'));
  assert.ok(blocks[0].meta.includes('m-x'));
});

test('skills: claude Skill tool pairs with est tokens and summary', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'writing-plans' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'sk1', content: 'x'.repeat(400) }] } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const acc = {};
  const blocks = renderClaudeTranscript(lines, undefined, acc);
  assert.equal(blocks[0].name, '⚡ skill: writing-plans');
  assert.equal(blocks[0].estTokens, 100);
  assert.equal(acc.skillCalls, 1);
  assert.equal(acc.skillTokens, 100);
});

test('skills: opencode skill tool estimates from inline output', () => {
  const dump = {
    messages: [['m1', JSON.stringify({ role: 'assistant', time: { created: 1 } })]],
    parts: [['m1', JSON.stringify({ type: 'tool', tool: 'skill', state: { status: 'completed', input: { name: 'frontend' }, output: 'y'.repeat(800) } })]],
  };
  const stdout = ['===AGENTWS:json===', JSON.stringify(dump)].join('\n');
  const acc = {};
  const blocks = renderOpencodeTranscript(stdout, undefined, acc);
  assert.equal(blocks[0].name, '⚡ skill: frontend');
  assert.equal(blocks[0].estTokens, 200);
  assert.equal(acc.skillCalls, 1);
});

test('skills: codex skill function_call parses json args', () => {
  const lines = [
    { type: 'response_item', payload: { type: 'function_call', name: 'skill', call_id: 's1', arguments: JSON.stringify({ name: 'debugging' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 's1', output: 'z'.repeat(200) } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const acc = {};
  const blocks = renderCodexTranscript(lines, undefined, acc);
  assert.equal(blocks[0].name, '⚡ skill: debugging');
  assert.equal(blocks[0].estTokens, 50);
  assert.equal(acc.skillTokens, 50);
});

test('skills: usage aggregated per skill name in summary.skills', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'debugging' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'x'.repeat(400) }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 's2', name: 'Skill', input: { skill: 'debugging' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's2', content: 'x'.repeat(800) }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 's3', name: 'Skill', input: { skill: 'frontend' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's3', content: 'x'.repeat(120) }] } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const acc = {};
  renderClaudeTranscript(lines, undefined, acc);
  assert.equal(acc.skillCalls, 3);
  assert.equal(acc.skillTokens, 330);
  const dbg = acc.skills.find((s) => s.name === 'debugging');
  assert.deepEqual(dbg, { name: 'debugging', calls: 2, estTokens: 300 });
  const fe = acc.skills.find((s) => s.name === 'frontend');
  assert.deepEqual(fe, { name: 'frontend', calls: 1, estTokens: 30 });
});
