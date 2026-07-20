const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('transcript: claude renders roles and tools', () => {
  const lines = [
    { type: 'summary', summary: 't' },
    { type: 'user', message: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '回答' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'file body' }] } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const msgs = renderClaudeTranscript(lines);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'system', 'assistant', 'tool', 'tool']);
  assert.equal(msgs[0].text, '你好');
  assert.equal(msgs[3].toolName, 'Read');
});

test('transcript: codex filters environment_context user envelopes', () => {
  const lines = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '问题' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回答' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const msgs = renderCodexTranscript(lines);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(msgs[0].text, '问题');
  assert.equal(msgs[2].toolName, 'shell');
});

test('transcript: opencode stitches messages and parts', () => {
  const dump = {
    messages: [
      ['m1', JSON.stringify({ role: 'user', time: { created: 1 } })],
      ['m2', JSON.stringify({ role: 'assistant', time: { created: 2 } })],
    ],
    parts: [
      ['m1', JSON.stringify({ type: 'text', text: '问' })],
      ['m2', JSON.stringify({ type: 'text', text: '答' })],
      ['m2', JSON.stringify({ type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } })],
    ],
  };
  const stdout = ['===AGENTWS:json===', JSON.stringify(dump)].join('\n');
  const msgs = renderOpencodeTranscript(stdout);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(msgs[2].toolName, 'bash');
});
