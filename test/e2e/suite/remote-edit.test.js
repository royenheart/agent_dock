/* 编辑器级远程文件读写 e2e：证明 agentdock-remote 文件在真实 VSCode 里可编辑保存。
 *
 * 背景：曾出现「编辑器是只读的，因为文件的文件系统是只读的」——provider 注册的
 * isReadonly 与 stat 的 Readonly 都已移除，此 suite 在真实 VSCode 窗口里打开远程
 * 文件，实际执行 TextEditor.edit + document.save()，验证全链路
 * 编辑器 → FileSystemProvider.writeFile → SFTP 原子写 确实可写。
 *
 * 运行（需要本地 sshd 沙箱）：
 *   test/e2e/sshd-local.sh start && source /tmp/agentdock-sshd/env
 *   AGENTWS_SUITE=remote-edit npm run test:e2e
 *   test/e2e/sshd-local.sh stop
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { remoteUri, remoteFsProvider } = require('../../../out/ssh/remoteFsProvider');
const { execRemote } = require('../../../out/ssh/remoteExec');

const E2E_HOST = process.env.AGENTDOCK_E2E_HOST || '127.0.0.1';
const E2E_PORT = Number(process.env.AGENTDOCK_E2E_PORT || 2222);
const E2E_USER = process.env.AGENTDOCK_E2E_USER || 'e2e';
const SERVER_NAME = 'e2e-sshd';
const FILE = '/tmp/agentdock-editor-e2e/f.txt';

suite('agent-dock remote editor read-write e2e', () => {
  let api;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('royenheart.agent-dock');
    assert.ok(ext, 'extension should be installed');
    api = await ext.activate();
    // 把服务器配置写入全局（user-data 隔离），让 provider 的 serverFor 能解析
    await vscode.workspace
      .getConfiguration('agentDock')
      .update(
        'servers',
        [{ name: SERVER_NAME, host: E2E_HOST, user: E2E_USER, port: E2E_PORT, folders: [] }],
        vscode.ConfigurationTarget.Global,
      );
    // 等待配置生效（onDidChangeConfiguration 会触发 provider.refresh）
    await new Promise((r) => setTimeout(r, 800));
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('agentDock').update('servers', [], vscode.ConfigurationTarget.Global);
  });

  test('open remote file: editor is writable, edit + save lands on the server', async () => {
    const server = { name: SERVER_NAME, host: E2E_HOST, user: E2E_USER, port: E2E_PORT, folders: [] };
    const probe = await execRemote(server, 'true', 8_000, { quiet: true });
    assert.equal(probe.code, 0, `local sshd reachable (${E2E_USER}@${E2E_HOST}:${E2E_PORT})`);
    await execRemote(server, `rm -rf /tmp/agentdock-editor-e2e && mkdir -p /tmp/agentdock-editor-e2e && printf 'hello' > ${FILE}`);

    const uri = remoteUri(SERVER_NAME, FILE);

    // 1. 打开远程文件（走真实 FileSystemProvider）
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    assert.equal(editor.document.getText(), 'hello');

    // 2. 编辑 + 保存 —— 若文件系统只读，edit/save 会失败
    const editOk = await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'edited-'));
    assert.equal(editOk, true, 'TextEditor.edit must succeed (filesystem not readonly)');
    const saved = await doc.save();
    assert.equal(saved, true, 'document.save() must succeed');

    // 3. 落盘校验：远端文件内容已更新（编辑器 → writeFile → SFTP 原子写）
    const res = await execRemote(server, `cat ${FILE}`, 8_000, { quiet: true });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'edited-hello', `remote file content after save: ${res.stdout.trim()}`);
    console.log('remote editor write OK: edited-hello on', FILE);

    // 4. 反向读取（provider.readFile 走 SFTP）应一致
    const content = Buffer.from(await remoteFsProvider.readFile(uri)).toString('utf8');
    assert.equal(content, 'edited-hello');

    // 5. stat 不应带 Readonly（VSCode 编辑器只读提示的直接来源之一）
    const st = await remoteFsProvider.stat(uri);
    assert.equal(st.permissions, undefined, 'stat must not report Readonly');

    await execRemote(server, `rm -rf /tmp/agentdock-editor-e2e`, 8_000, { quiet: true });
  });
});
