const assert = require('node:assert/strict');
const vscode = require('vscode');
const { buildTranscriptScript } = require('../../../out/agents/discoveryScript');
const { renderTranscript } = require('../../../out/agents/transcript');
const { execLocal } = require('../../../out/ssh/remoteExec');
const { readSshConfigHosts } = require('../../../out/ssh/sshConfig');

suite('agent-workspace e2e', () => {
  let api;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('royenheart.agent-workspace');
    assert.ok(ext, 'extension should be installed');
    api = await ext.activate();
    assert.ok(api && api.provider, 'activate() should export { provider, decorations }');
  });

  async function currentServerChildren() {
    const roots = await api.provider.getChildren(undefined);
    const cur = roots.find((n) => n.kind === 'server' && n.isCurrent);
    assert.ok(cur, 'current server node exists');
    return api.provider.getChildren(cur);
  }

  test('root has current server node', async () => {
    const roots = await api.provider.getChildren(undefined);
    assert.ok(roots.some((n) => n.kind === 'server' && n.isCurrent));
  });

  test('server level mirrors workspace folders (no stray session folders)', async () => {
    const children = await currentServerChildren();
    const wsFolders = children.filter((n) => n.kind === 'folder' && n.workspaceUri);
    const strayFolders = children.filter((n) => n.kind === 'folder' && !n.workspaceUri);
    assert.equal(wsFolders.length, 1, 'exactly the opened workspace folder');
    assert.equal(strayFolders.length, 0, 'session-derived folders must live under 其他目录会话');
    assert.ok(children.some((n) => n.kind === 'otherSessions'), '其他目录会话 node exists');
  });

  test('workspace folder shows files and sessions side by side (symlink cwd match)', async () => {
    const children = await currentServerChildren();
    const wsFolder = children.find((n) => n.kind === 'folder' && n.workspaceUri);
    const kids = await api.provider.getChildren(wsFolder);
    assert.ok(kids.some((k) => k.kind === 'fsEntry' && k.name === 'a.txt'), 'file a.txt');
    assert.ok(kids.some((k) => k.kind === 'fsEntry' && k.name === 'sub'), 'dir sub');
    const sr = kids.find((k) => k.kind === 'sessionsRoot');
    assert.ok(sr, 'sessions subnode next to files');
    const sessions = await api.provider.getChildren(sr);
    assert.deepEqual(
      sessions.map((s) => s.session.agent).sort(),
      ['claude', 'codex', 'opencode'],
      'sessions from all three agents attach to the workspace folder even though it was opened via symlink',
    );
  });

  test('其他目录会话 contains out-of-workspace sessions', async () => {
    const children = await currentServerChildren();
    const other = children.find((n) => n.kind === 'otherSessions');
    const folders = await api.provider.getChildren(other);
    assert.equal(folders.length, 1);
    const kids = await api.provider.getChildren(folders[0]);
    const sr = kids.find((k) => k.kind === 'sessionsRoot');
    assert.ok(sr, 'extra folder uses sessions subnode too');
    const sessions = await api.provider.getChildren(sr);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session.id, 'ses_e2e_outside');
  });

  test('AI badge decoration on workspace folder', async () => {
    const uri = vscode.workspace.workspaceFolders[0].uri;
    const dec = await api.decorations.provideFileDecoration(uri);
    assert.ok(dec, 'decoration returned');
    assert.equal(dec.badge, 'AI');
  });

  test('opencode transcript via sqlite fixture', async () => {
    const session = { agent: 'opencode', id: 'ses_e2e_inws', title: 't', cwd: '', timeCreated: 0, timeUpdated: 0 };
    const res = await execLocal(buildTranscriptScript(session), 30_000);
    assert.equal(res.code, 0, res.stderr);
    const msgs = renderTranscript(session, res.stdout);
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
    assert.equal(msgs[0].text, 'e2e 用户问题');
    assert.equal(msgs[1].text, 'e2e 助手回答');
  });

  test('ssh config parsed from fixture HOME', async () => {
    const hosts = await readSshConfigHosts(process.env.HOME);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].host, 'e2e-host');
    assert.equal(hosts[0].user, 'tester');
    assert.equal(hosts[0].port, 2222);
  });
});
