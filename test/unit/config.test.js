const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSshConfigHosts } = require('../../out/ssh/sshConfig');
const { gatherSettings } = require('../../out/views/settingsData');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentws-test-'));
}

test('sshConfig: parses hosts, skips wildcards, first-wins, includes', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.ssh', 'conf.d'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ssh', 'config'),
    [
      '# comment',
      'Host *',
      '  User nobody',
      '',
      'Host dev dev-alias',
      '  HostName 10.0.0.1',
      '  User alice',
      '  Port 2222',
      '',
      'Host dev',
      '  User ignored-second-wins-none',
      '',
      'Match host bastion',
      '  User skipme',
      '',
      'Include conf.d/*.conf',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(home, '.ssh', 'conf.d', 'extra.conf'), 'Host staging\n  HostName staging.internal\n');
  return readSshConfigHosts(home).then((hosts) => {
    const byName = Object.fromEntries(hosts.map((h) => [h.host, h]));
    assert.equal(byName['*'], undefined);
    assert.equal(byName.dev.hostName, '10.0.0.1');
    assert.equal(byName.dev.user, 'alice');
    assert.equal(byName.dev.port, 2222);
    assert.equal(byName['dev-alias'].hostName, '10.0.0.1');
    assert.equal(byName['dev-alias'].user, 'alice');
    assert.equal(byName.staging.hostName, 'staging.internal');
    assert.equal(byName.staging.user, undefined);
    assert.ok(!hosts.some((h) => h.user === 'skipme'));
  });
});

test('sshConfig: missing config yields empty list', async () => {
  const hosts = await readSshConfigHosts(tmpHome());
  assert.deepEqual(hosts, []);
});

test('settingsData: per-agent buckets, skills attributed to all owning agents', async () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { ctx7: { command: 'npx ctx7' } } }));  fs.mkdirSync(path.join(home, '.claude', 'skills', 'sk1'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'sk1', 'SKILL.md'), '---\nname: sk1\ndescription: claude skill\n---\nbody');
  fs.mkdirSync(path.join(home, '.agents', 'skills', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: 共享技能\n---\nbody');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers."db"]\ncommand = "npx db-mcp"\n\n[hooks]\n');
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { fs: { type: 'local', command: ['npx', 'fs-mcp'] } }, plugin: ['oc-plugin@1'] }));

  const d = await gatherSettings('test', home);
  assert.equal(d.serverLabel, 'test');
  assert.deepEqual(d.byAgent.claude.mcps.map((m) => m.name), ['ctx7']);
  assert.deepEqual(d.byAgent.codex.mcps.map((m) => m.name), ['db']);
  assert.equal(d.byAgent.codex.hooks.length, 1);
  assert.deepEqual(d.byAgent.opencode.mcps.map((m) => m.name), ['fs']);
  assert.ok(d.byAgent.opencode.plugins.some((p) => p.name === 'oc-plugin@1'));
  // sk1: ~/.claude/skills → claude + opencode 可见，codex 不可见
  assert.ok(d.byAgent.claude.skills.some((s) => s.name === 'sk1'));
  assert.ok(d.byAgent.opencode.skills.some((s) => s.name === 'sk1'));
  assert.ok(!d.byAgent.codex.skills.some((s) => s.name === 'sk1'));
  // shared: ~/.agents/skills → 三个 agent 都可见
  for (const a of ['claude', 'codex', 'opencode']) {
    assert.ok(d.byAgent[a].skills.some((s) => s.name === 'shared'), `${a} should see shared`);
  }
});

test('settingsData: project-level configs and claude projects map', async () => {
  const home = tmpHome();
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ projects: { '/work/projA': { mcpServers: { 'proj-mcp': { command: 'npx proj-mcp' } } } } }),
  );
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'agentws-proj-'));
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'file-mcp': { command: 'npx file-mcp' } } }));
  fs.writeFileSync(path.join(proj, 'opencode.json'), JSON.stringify({ mcp: { 'oc-mcp': { type: 'local', command: ['npx', 'oc-mcp'] } }, plugin: ['proj-plugin@1'] }));
  fs.mkdirSync(path.join(proj, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.codex', 'config.toml'), '[mcp_servers."cx-mcp"]\ncommand = "npx cx-mcp"\n\n[hooks]\n');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [] }] }, enabledPlugins: { 'p@m': true } }));
  fs.mkdirSync(path.join(proj, '.claude', 'skills', 'proj-skill'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'skills', 'proj-skill', 'SKILL.md'), '---\nname: proj-skill\ndescription: 项目技能\n---\n');

  const d = await gatherSettings('test', home, undefined, [proj]);
  const names = (bucket) => bucket.map((x) => x.name);
  assert.ok(names(d.byAgent.claude.mcps).includes('proj-mcp'), 'claude projects map mcp');
  assert.ok(names(d.byAgent.claude.mcps).includes('file-mcp'), '.mcp.json mcp');
  assert.ok(names(d.byAgent.opencode.mcps).includes('oc-mcp'), 'project opencode.json mcp');
  assert.ok(names(d.byAgent.opencode.plugins).includes('proj-plugin@1'), 'project opencode plugin');
  assert.ok(names(d.byAgent.codex.mcps).includes('cx-mcp'), 'project codex toml mcp');
  assert.ok(d.byAgent.codex.hooks.length >= 1, 'project codex hooks');
  assert.ok(names(d.byAgent.claude.hooks).includes('PreToolUse'), 'project claude hooks');
  assert.ok(names(d.byAgent.claude.plugins).includes('p@m'), 'project claude enabledPlugins');
  assert.ok(names(d.byAgent.claude.skills).includes('proj-skill'), 'project skill visible to claude');
  assert.ok(names(d.byAgent.opencode.skills).includes('proj-skill'), 'project skill visible to opencode');
  const projMcpItem = d.byAgent.claude.mcps.find((x) => x.name === 'file-mcp');
  assert.ok(projMcpItem.detail.includes('['), 'project item carries project prefix');
});
