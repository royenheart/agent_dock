const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');
const { buildTranscriptScript } = require('../../../out/agents/discoveryScript');
const { renderTranscript } = require('../../../out/agents/transcript');
const { execLocal } = require('../../../out/ssh/remoteExec');
const { readSshConfigHosts } = require('../../../out/ssh/sshConfig');
const { clientTerminalOptions } = require('../../../out/ssh/clientTerminal');

suite('agent-workspace e2e', () => {
  let api;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('royenheart.agent-dock');
    assert.ok(ext, 'extension should be installed');
    api = await ext.activate();
    assert.ok(api && api.provider, 'activate() should export { provider, decorations }');
  });

  async function currentServerChildren() {
    const roots = await api.provider.getChildren(undefined);
    const cur = roots.find((n) => n.kind === 'server' && n.isCurrent);
    assert.ok(cur, 'current server node exists');
    for (let i = 0; i < 120; i++) {
      const children = await api.provider.getChildren(cur);
      const loading = children.length === 1 && children[0].kind === 'info' && children[0].severity === 'loading';
      if (!loading) {
        return children;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
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
    const parent = sessions.find((s) => s.session.id === 'ses_e2e_inws');
    assert.ok(parent.children && parent.children.length === 1, 'sub-agent session nested under parent');
    assert.equal(parent.children[0].session.id, 'ses_e2e_child');
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

  test('git status: remote dir/folder nodes expose resourceUri for decoration', () => {
    const dir = api.provider.getTreeItem({ kind: 'remoteFsEntry', serverKey: 'srv', path: '/x/d', name: 'd', isDir: true });
    assert.ok(dir.resourceUri, 'remoteFsDir node must expose resourceUri');
    assert.equal(dir.resourceUri.scheme, 'agentdock-remote');
    const folder = api.provider.getTreeItem({ kind: 'folder', serverKey: 'srv', path: '/x', label: 'x' });
    assert.ok(folder.resourceUri, 'folder.remote node must expose resourceUri');
    assert.equal(folder.resourceUri.scheme, 'agentdock-remote');
  });

  test('git status: decoration mapping + provider scheme filtering', async () => {
    const { decorationFor, RemoteGitDecorationProvider } = require('../../../out/git/gitDecorations');
    // 字母徽标 + 原生 git 主题色（与用户主题下原生 git 状态颜色一致）
    assert.equal(decorationFor('modified').badge, 'M');
    assert.equal(decorationFor('modified').color.id, 'gitDecoration.modifiedResourceForeground');
    assert.equal(decorationFor('untracked').badge, 'U');
    assert.equal(decorationFor('untracked').color.id, 'gitDecoration.untrackedResourceForeground');
    assert.equal(decorationFor('added').badge, 'A');
    assert.equal(decorationFor('deleted').badge, 'D');
    assert.equal(decorationFor('conflict').badge, 'C');
    // provider 只处理 agentdock-remote；空 store 时安全返回 undefined（不崩溃）
    const provider = new RemoteGitDecorationProvider();
    assert.equal(provider.provideFileDecoration(vscode.Uri.file('/x/a.txt')), undefined, 'local file ignored');
    const remoteUri = vscode.Uri.from({ scheme: 'agentdock-remote', authority: 'srv', path: '/x/a.txt' });
    assert.equal(provider.provideFileDecoration(remoteUri), undefined, 'no scanned status → undefined');
    provider.dispose();
  });

  test('opencode transcript via sqlite fixture', async () => {
    const session = { agent: 'opencode', id: 'ses_e2e_inws', title: 't', cwd: '', timeCreated: 0, timeUpdated: 0 };
    const res = await execLocal(buildTranscriptScript(session), 30_000);
    assert.equal(res.code, 0, res.stderr);
    const { blocks, summary } = renderTranscript(session, res.stdout);
    assert.deepEqual(blocks.map((b) => b.kind), ['text', 'text', 'tool', 'tool', 'todo']);
    assert.equal(blocks[0].markdown, 'e2e 用户问题');
    assert.equal(blocks[1].markdown, 'e2e 助手回答');
    assert.equal(blocks[2].name, 'bash');
    assert.equal(blocks[2].output, 'ok-out');
    assert.equal(blocks[2].status, 'completed');
    assert.equal(blocks[3].name, '⚡ skill: frontend');
    assert.equal(blocks[3].estTokens, 100);
    assert.deepEqual(blocks[4].items, [{ content: 'e2e 待办事项', status: 'in_progress' }]);
    assert.ok(summary && typeof summary === 'object');
    assert.deepEqual(summary.skills, [{ name: 'frontend', calls: 1, estTokens: 100 }]);
  });

  test('create session command opens a terminal for the picked agent', async () => {
    const children = await currentServerChildren();
    const wsFolder = children.find((n) => n.kind === 'folder' && n.workspaceUri);
    await vscode.commands.executeCommand('agentDock.createSession', wsFolder, 'codex');
    await new Promise((r) => setTimeout(r, 800));
    const term = vscode.window.terminals.find((t2) => t2.name.includes('codex'));
    assert.ok(term, `terminal for codex created, have: ${vscode.window.terminals.map((t2) => t2.name).join(',')}`);
    term.dispose();
  });

  async function runClientTermCommand(outFile) {
    fs.rmSync(outFile, { force: true });
    const term = vscode.window.createTerminal(clientTerminalOptions('Client Terminal'));
    term.show();
    await new Promise((r) => setTimeout(r, 1500));
    // 'echox' + 退格 → 'echo'：行编辑在两种后端（node-pty 原生 / 管道行缓冲）下都应成立
    term.sendText(`echox\x7f AGENTWS_CLIENT_TERM_OK > ${outFile}`);
    let content = '';
    for (let i = 0; i < 20 && !content; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(outFile)) {
        content = fs.readFileSync(outFile, 'utf8').trim();
      }
    }
    term.dispose();
    return content;
  }

  test('client terminal pty executes commands in a client-side shell', async () => {
    assert.equal(await runClientTermCommand('/tmp/agentws-e2e/client-term-out.txt'), 'AGENTWS_CLIENT_TERM_OK');
  });

  test('client terminal pipe fallback executes commands (node-pty disabled)', async () => {
    process.env.AGENTDOCK_NO_NODE_PTY = '1';
    try {
      assert.equal(await runClientTermCommand('/tmp/agentws-e2e/client-term-out-pipe.txt'), 'AGENTWS_CLIENT_TERM_OK');
    } finally {
      delete process.env.AGENTDOCK_NO_NODE_PTY;
    }
  });

  test('file node commands: copy path, new file, rename', async () => {
    const children = await currentServerChildren();
    const wsFolder = children.find((n) => n.kind === 'folder' && n.workspaceUri);
    const wsUri = wsFolder.workspaceUri;
    const kids = await api.provider.getChildren(wsFolder);
    const aTxt = kids.find((k) => k.kind === 'fsEntry' && k.name === 'a.txt');
    assert.ok(aTxt, 'a.txt node exists');

    await vscode.commands.executeCommand('agentDock.fsCopyPath', aTxt);
    const clip = await vscode.env.clipboard.readText();
    assert.ok(clip.endsWith('a.txt'), `clipboard should end with a.txt, got ${clip}`);

    await vscode.commands.executeCommand('agentDock.fsNewFile', wsFolder, 'e2e-new.txt');
    const created = await vscode.workspace.fs.stat(vscode.Uri.joinPath(wsUri, 'e2e-new.txt'));
    assert.ok(created, 'new file created');

    await vscode.commands.executeCommand(
      'agentDock.fsRename',
      { kind: 'fsEntry', uri: vscode.Uri.joinPath(wsUri, 'e2e-new.txt'), name: 'e2e-new.txt', isDir: false },
      'e2e-renamed.txt',
    );
    const renamed = await vscode.workspace.fs.stat(vscode.Uri.joinPath(wsUri, 'e2e-renamed.txt'));
    assert.ok(renamed, 'file renamed');
  });

  test('remove-from-workspace command resolves and routes by node', async () => {
    const children = await currentServerChildren();
    const wsFolder = children.find((n) => n.kind === 'folder' && n.workspaceUri);
    assert.ok(wsFolder, 'workspace folder node exists');
    const result = await vscode.commands.executeCommand('agentDock.fsRemoveFromWorkspace', wsFolder);
    assert.equal(typeof result, 'boolean', 'command returns a boolean contract');
    const bogus = await vscode.commands.executeCommand('agentDock.fsRemoveFromWorkspace', { kind: 'folder', serverKey: 'x', path: '/x', label: 'x' });
    assert.equal(bogus, false, 'non-workspace folder node is rejected');
  });

  test('ssh config parsed from fixture HOME', async () => {
    const hosts = await readSshConfigHosts(process.env.HOME);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].host, 'e2e-host');
    assert.equal(hosts[0].user, 'tester');
    assert.equal(hosts[0].port, 2222);
  });

  /* ---- 右键菜单完整性（防回退：历史缺陷「只剩刷新文件」） ---- */

  /** 提取 view/item/context 菜单里匹配某 viewItem 的命令集合。 */
  function cmdsFor(viewItem) {
    const pkg = vscode.extensions.getExtension('royenheart.agent-dock').packageJSON;
    const menus = pkg.contributes.menus['view/item/context'];
    return new Set(
      menus
        .filter((m) => {
          const when = m.when || '';
          return (
            when.includes(`viewItem == ${viewItem}`) ||
            when.includes(`viewItem =~ /^${viewItem}/`)
          );
        })
        .map((m) => m.command),
    );
  }

  /** package.json 菜单引用的全部 viewItem 值。 */
  function declaredViewItems() {
    const pkg = vscode.extensions.getExtension('royenheart.agent-dock').packageJSON;
    const menus = pkg.contributes.menus['view/item/context'];
    const out = new Set();
    for (const m of menus) {
      for (const hit of (m.when || '').matchAll(/viewItem\s*(?:==|=\s*~)\s*(\^?)([A-Za-z.]+)/g)) {
        out.add(hit[1] ? hit[2] : hit[2]);
      }
    }
    return out;
  }

  test('context menus: remote fs nodes keep the full operation set', () => {
    // 远程 fs 目录：新建文件/文件夹、重命名、删除、复制、粘贴、复制路径、刷新目录、打开终端
    for (const c of [
      'agentDock.remoteFsNewFile',
      'agentDock.remoteFsNewFolder',
      'agentDock.remoteFsRename',
      'agentDock.remoteFsDelete',
      'agentDock.remoteFsCopy',
      'agentDock.remoteFsPaste',
      'agentDock.remoteFsCopyPath',
      'agentDock.remoteFsRefreshDir',
      'agentDock.remoteFsOpenTerminal',
    ]) {
      assert.ok(cmdsFor('remoteFsDir').has(c), `remoteFsDir menu should contain ${c}`);
    }
    // 远程 fs 文件：刷新文件、重命名、删除、复制、复制路径
    for (const c of [
      'agentDock.remoteFsRefreshFile',
      'agentDock.remoteFsRename',
      'agentDock.remoteFsDelete',
      'agentDock.remoteFsCopy',
      'agentDock.remoteFsCopyPath',
    ]) {
      assert.ok(cmdsFor('remoteFsFile').has(c), `remoteFsFile menu should contain ${c}`);
    }
    // 本地 fs 目录/文件：完整操作集
    for (const c of [
      'agentDock.fsNewFile',
      'agentDock.fsNewFolder',
      'agentDock.fsRename',
      'agentDock.fsDelete',
      'agentDock.fsCopy',
      'agentDock.fsPaste',
      'agentDock.fsCopyPath',
      'agentDock.fsCopyRelativePath',
      'agentDock.fsRevealOS',
      'agentDock.fsOpenTerminal',
    ]) {
      assert.ok(cmdsFor('fsDir').has(c), `fsDir menu should contain ${c}`);
    }
    assert.ok(cmdsFor('fsFile').has('agentDock.fsRename'), 'fsFile menu should contain rename');
    assert.ok(cmdsFor('fsFile').has('agentDock.fsDelete'), 'fsFile menu should contain delete');
    // pin 目录（folder.remote / folder.workspace）保留「刷新目录」；远程固定目录可移出工作区（不删除真实目录）
    assert.ok(cmdsFor('folder.remote').has('agentDock.remoteFsRefreshDir'), 'folder.remote should keep refresh dir');
    assert.ok(cmdsFor('folder.workspace').has('agentDock.remoteFsRefreshDir'), 'folder.workspace should keep refresh dir');
    assert.ok(
      cmdsFor('folder.remote').has('agentDock.remoteFsRemoveFromWorkspace'),
      'folder.remote should support removing the directory from the workspace',
    );
  });

  test('context menus: getTreeItem contextValue matches declared viewItem (menu sync)', () => {
    const declared = declaredViewItems();
    const cases = [
      { node: { kind: 'server', key: '__current__', label: 'x', isCurrent: true }, expect: 'server.current' },
      { node: { kind: 'server', key: 's', label: 's', isCurrent: false, server: { name: 's', host: 'h' } }, expect: 'server.remote' },
      { node: { kind: 'folder', serverKey: '__current__', path: '/x', label: 'x', workspaceUri: vscode.Uri.file('/x') }, expect: 'folder.workspace' },
      { node: { kind: 'folder', serverKey: 's', path: '/x', label: 'x' }, expect: 'folder.remote' },
      { node: { kind: 'fsEntry', uri: vscode.Uri.file('/x/a.txt'), name: 'a.txt', isDir: false }, expect: 'fsFile' },
      { node: { kind: 'fsEntry', uri: vscode.Uri.file('/x/d'), name: 'd', isDir: true }, expect: 'fsDir' },
      { node: { kind: 'remoteFsEntry', serverKey: 's', path: '/x/f', name: 'f', isDir: false }, expect: 'remoteFsFile' },
      { node: { kind: 'remoteFsEntry', serverKey: 's', path: '/x/d', name: 'd', isDir: true }, expect: 'remoteFsDir' },
      { node: { kind: 'sessionsRoot', serverKey: '__current__', folderPath: '/x' }, expect: 'sessionsRoot' },
      { node: { kind: 'session', serverKey: '__current__', session: { agent: 'codex', id: 's1', title: 't', cwd: '/x', timeCreated: 0, timeUpdated: 0 } }, expect: 'session' },
      { node: { kind: 'portsRoot', serverKey: 's' }, expect: 'portsRoot' },
      { node: { kind: 'portForward', serverKey: 's', forward: { localPort: 1, remotePort: 2 } }, expect: 'portForward.' },
    ];
    const realValues = new Set();
    for (const c of cases) {
      const item = api.provider.getTreeItem(c.node);
      assert.ok(item.contextValue, `contextValue for ${c.node.kind}`);
      assert.ok(
        item.contextValue.startsWith(c.expect),
        `getTreeItem(${c.node.kind}).contextValue=${item.contextValue} should start with ${c.expect}`,
      );
      realValues.add(item.contextValue);
    }
    // 反向（防拼写错/菜单失联）：package.json 菜单引用的每个 viewItem 都必须能由
    // getTreeItem 产生（否则菜单永不显示，等于功能回退）。server.current 无右键菜单，
    // 不在 declared 里也正常。
    const expects = [
      'server.current',
      'server.remote',
      'session',
      'sessionsRoot',
      'fsFile',
      'fsDir',
      'folder.workspace',
      'folder.remote',
      'remoteFsFile',
      'remoteFsDir',
      'portsRoot',
      'portForward',
      'info',
    ];
    for (const v of declared) {
      assert.ok(
        expects.some((e) => e.startsWith(v) || v.startsWith(e)),
        `declared viewItem "${v}" must map to a real node type`,
      );
    }
  });
});
