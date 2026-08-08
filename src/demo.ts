/**
 * 演示模式（README GIF 录屏用）：设置 AGENTDOCK_DEMO=1 后，扩展激活会自动
 * 逐步执行演示序列。仅由 scripts/record-demo.sh 配合本地 sshd 沙箱使用；
 * 正常用户不设置该环境变量，此模块不执行任何操作。
 *
 * full 序列覆盖核心功能（每个场景开头写 /tmp/demo-step-<name>.marker，
 * 录制脚本 scripts/demo-record.mjs 据此把连续录像切成分场景 GIF）：
 *   1. tree     多服务器 Agent Workspace 树（当前 + 两台远程，逐级展开）
 *   2. edit-a   远程服务器 A：打开文件 → 逐字输入 → 保存（SFTP 原子写）
 *   3. edit-b   远程服务器 B：同样的可写链路
 *   4. sessions 展开会话列表 → 打开 transcript 面板
 *   5. resume   会话一键「在终端中继续」（ssh config 别名，不暴露用户名/IP）
 *   6. settings Agent 设置视图：MCPs / Skills / Plugins / Hooks 解析
 *
 * 注意：Xvfb 无合成器时 editor webview（SessionPanel）常不绘制——sessions GIF
 * 的 transcript 正文由 scripts/demo-gif.mjs 用 headless Chrome 渲染真实数据补帧。
 */
import * as fs from 'node:fs';
import * as vscode from 'vscode';

const mark = (step: string): void => {
  try {
    fs.writeFileSync(`/tmp/demo-step-${step}.marker`, 'done');
  } catch {
    // ignore
  }
};
import type { ServerConfig } from './model';
import { execRemote } from './ssh/remoteExec';
import { remoteUri } from './ssh/remoteFsProvider';
import type { WorkspaceProvider, Node } from './tree/workspaceProvider';
import { log } from './log';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface DemoServerCfg {
  name: string;
  host: string;
  user?: string;
  port?: number;
  dir: string;
}

/** 逐字输入（模拟真人打字，录屏里可见逐字符出现与光标移动）。 */
async function typeText(text: string, intervalMs = 55): Promise<void> {
  for (const ch of text) {
    await vscode.commands.executeCommand('type', { text: ch });
    await sleep(intervalMs);
  }
}

/** 轮询 getChildren 直到满足条件（远程扫描/列表是异步的，录屏也要等真实数据）。 */
async function waitChildren(
  provider: WorkspaceProvider,
  node: Node | undefined,
  pred: (kids: Node[]) => boolean,
  tries = 12,
  intervalMs = 800,
): Promise<Node[]> {
  for (let i = 0; i < tries; i++) {
    const kids = await provider.getChildren(node);
    if (pred(kids)) {
      return kids;
    }
    await sleep(intervalMs);
  }
  return provider.getChildren(node);
}

/** 尽量关掉右侧 Chat 等辅助栏，给演示画面留出横向空间。 */
async function declutterWorkbench(): Promise<void> {
  for (const cmd of ['workbench.action.closeAuxiliaryBar', 'workbench.action.chat.close']) {
    try {
      await vscode.commands.executeCommand(cmd);
    } catch {
      // 命令在部分 VS Code 版本不存在
    }
  }
}

export async function maybeRunDemo(
  provider: WorkspaceProvider,
  treeView: vscode.TreeView<Node>,
): Promise<void> {
  if (process.env.AGENTDOCK_DEMO !== '1') {
    return;
  }
  const dlog = log.child('demo');
  dlog.info('demo mode: starting recording sequence');
  const stage = process.env.AGENTDOCK_DEMO_STAGE || 'full';
  try {
    // 分镜模式：启动即进入目标状态（调试用）
    if (stage === 'tree' || stage === 'file-a' || stage === 'file-b') {
      const raw = process.env.AGENTDOCK_DEMO_SERVERS || '[]';
      const cfgs = JSON.parse(raw) as DemoServerCfg[];
      const servers: ServerConfig[] = cfgs.map((c) => ({ name: c.name, host: c.host, user: c.user, port: c.port, folders: [c.dir] }));
      await vscode.workspace.getConfiguration('agentDock').update('servers', servers, vscode.ConfigurationTarget.Global);
      if (stage === 'file-a' || stage === 'file-b') {
        const idx = stage === 'file-a' ? 0 : 1;
        const c = cfgs[idx];
        const file = stage === 'file-a' ? `${c.dir}/app.py` : `${c.dir}/src/util.js`;
        const doc = await vscode.workspace.openTextDocument(remoteUri(c.name, file));
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        await vscode.commands.executeCommand('agentDock.workspace.focus');
      }
      fs.writeFileSync('/tmp/demo-done.marker', 'done');
      dlog.info(`demo stage ${stage} done`);
      return;
    }
    if (stage === 'settings') {
      await vscode.workspace
        .getConfiguration('agentDock')
        .update('servers', [], vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('agentDock.settings.focus');
      fs.writeFileSync('/tmp/demo-done.marker', 'done');
      dlog.info('demo stage settings done');
      return;
    }
    if (stage === 'transcript') {
      const roots = await provider.getChildren(undefined);
      const serverNode = roots.find((n) => n.kind === 'server' && n.isCurrent);
      if (serverNode) {
        const kids = await provider.getChildren(serverNode);
        const folder = kids.find((n) => n.kind === 'folder');
        if (folder) {
          const folderKids = await provider.getChildren(folder);
          const sr = folderKids.find((n) => n.kind === 'sessionsRoot');
          if (sr) {
            const sessions = await provider.getChildren(sr);
            if (sessions[0]) {
              await vscode.commands.executeCommand('agentDock.openSession', sessions[0]);
            }
          }
        }
      }
      fs.writeFileSync('/tmp/demo-done.marker', 'done');
      dlog.info('demo stage transcript done');
      return;
    }

    const raw = process.env.AGENTDOCK_DEMO_SERVERS || '[]';
    const cfgs = JSON.parse(raw) as DemoServerCfg[];
    const servers: ServerConfig[] = cfgs.map((c) => ({
      name: c.name,
      host: c.host,
      user: c.user,
      port: c.port,
      folders: [c.dir],
    }));

    await sleep(2000);
    await declutterWorkbench();

    // 0. 配置服务器（写全局配置，provider 读取 → 树出现多台远程服务器）
    await vscode.workspace
      .getConfiguration('agentDock')
      .update('servers', servers, vscode.ConfigurationTarget.Global);
    await sleep(2500);

    // ---- 1. tree：多服务器树，逐级展开 ----
    mark('tree');
    await vscode.commands.executeCommand('agentDock.workspace.focus');
    await sleep(2000);
    const roots = await waitChildren(provider, undefined, (r) => r.length >= 3);
    const currentNode = roots.find((n) => n.kind === 'server' && n.isCurrent);
    const serverA = roots.find((n) => n.kind === 'server' && n.key === cfgs[0]?.name);
    const serverB = roots.find((n) => n.kind === 'server' && n.key === cfgs[1]?.name);
    if (currentNode) {
      await treeView.reveal(currentNode, { expand: true });
      await sleep(800);
      const curKids = await provider.getChildren(currentNode);
      const curFolder = curKids.find((n) => n.kind === 'folder');
      if (curFolder) {
        await treeView.reveal(curFolder, { expand: true });
        await sleep(800);
      }
    }
    if (serverA) {
      await treeView.reveal(serverA, { expand: true });
      await sleep(800);
      const aKids = await provider.getChildren(serverA);
      const folderA = aKids.find((n) => n.kind === 'folder');
      if (folderA) {
        await treeView.reveal(folderA, { expand: true });
        await sleep(1200);
      }
    }
    if (serverB) {
      await treeView.reveal(serverB, { expand: true });
      await sleep(1500);
    }

    // ---- 2. edit-a：打开远程 A 文件 → 逐字输入 → 保存（SFTP）----
    mark('edit-a');
    const a = servers[0];
    const fileA = `${cfgs[0].dir}/app.py`;
    const docA = await vscode.workspace.openTextDocument(remoteUri(a.name, fileA));
    const editorA = await vscode.window.showTextDocument(docA, { preview: false });
    await sleep(1500);
    // 在第 1 行（0-based）前插入新行再打字，避免与 `def main` 纠缠
    await editorA.edit((b) => b.insert(new vscode.Position(1, 0), '\n'));
    editorA.selection = new vscode.Selection(1, 0, 1, 0);
    await typeText('# edited on server A via SFTP — live save demo');
    await sleep(400);
    await vscode.commands.executeCommand('workbench.action.files.save');
    await sleep(1500);
    const checkA = await execRemote(a, `grep -c "edited on server A" ${fileA}`, 8_000, { quiet: true });
    dlog.info(`server A save verified: ${checkA.stdout.trim()}`);

    // ---- 3. edit-b：远程 B 同样可写 ----
    mark('edit-b');
    const b = servers[1];
    const fileB = `${cfgs[1].dir}/src/util.js`;
    const docB = await vscode.workspace.openTextDocument(remoteUri(b.name, fileB));
    const editorB = await vscode.window.showTextDocument(docB, { preview: false });
    await sleep(1500);
    await editorB.edit((ed) => ed.insert(new vscode.Position(1, 0), '\n'));
    editorB.selection = new vscode.Selection(1, 0, 1, 0);
    await typeText('// edited on server B via SFTP — live save demo');
    await sleep(400);
    await vscode.commands.executeCommand('workbench.action.files.save');
    await sleep(1500);
    const checkB = await execRemote(b, `grep -c "edited on server B" ${fileB}`, 8_000, { quiet: true });
    dlog.info(`server B save verified: ${checkB.stdout.trim()}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(800);

    // ---- 4. sessions：展开服务器 A 会话 → 打开 transcript 面板（webview 正文由 GIF 管线补帧）----
    mark('sessions');
    if (serverA) {
      const aKids = await provider.getChildren(serverA);
      const folderA = aKids.find((n) => n.kind === 'folder' && n.path === cfgs[0].dir);
      if (folderA) {
        await treeView.reveal(folderA, { expand: true, focus: true });
        await sleep(1000);
        const folderKids = await waitChildren(provider, folderA, (k) => k.some((n) => n.kind === 'sessionsRoot'));
        const sessionsRoot = folderKids.find((n) => n.kind === 'sessionsRoot');
        if (sessionsRoot) {
          await treeView.reveal(sessionsRoot, { expand: true, focus: true });
          await sleep(1500);
          const sessions = await waitChildren(provider, sessionsRoot, (s) => s.length > 0);
          dlog.info(`sessions under ${cfgs[0].dir}: ${sessions.map((n) => (n.kind === 'session' ? `${n.session.agent}:${n.session.title}` : n.kind)).join(' | ')}`);
          const rich = sessions.find((n) => n.kind === 'session' && n.session.agent === 'opencode') ?? sessions[0];
          if (rich && rich.kind === 'session') {
            dlog.info(`opening session ${rich.session.agent} ${rich.session.id}`);
            await vscode.commands.executeCommand('agentDock.openSession', rich);
            await sleep(4500); // 等 tab 标题出现（webview 正文在 Xvfb 下常为黑屏，GIF 管线会补）
          }
        }
      }
    }

    // ---- 5. resume：会话一键在终端继续（ssh config 别名，画面无用户名/IP）----
    mark('resume');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(500);
    if (serverA) {
      const aKids = await provider.getChildren(serverA);
      const folderA = aKids.find((n) => n.kind === 'folder' && n.path === cfgs[0].dir);
      const folderKids = folderA ? await provider.getChildren(folderA) : [];
      const sessionsRoot = folderKids.find((n) => n.kind === 'sessionsRoot');
      const sessions = sessionsRoot ? await provider.getChildren(sessionsRoot) : [];
      const codex = sessions.find((n) => n.kind === 'session' && n.session.agent === 'codex');
      if (codex) {
        dlog.info('resuming codex session in terminal');
        await vscode.commands.executeCommand('agentDock.resumeSession', codex);
        await sleep(10000); // stub CLI 横幅停留（stub 内 sleep 配合）
      }
    }

    // ---- 6. settings：Agent 设置视图 ----
    mark('settings');
    try {
      await vscode.commands.executeCommand('workbench.action.togglePanel');
    } catch {
      // ignore
    }
    await sleep(600);
    await vscode.commands.executeCommand('agentDock.settings.focus');
    await sleep(5000);

    fs.writeFileSync('/tmp/demo-done.marker', 'done');
    dlog.info('demo sequence done');
  } catch (err) {
    log.child('demo').error(`demo sequence failed: ${String(err)}`);
    try {
      fs.writeFileSync('/tmp/demo-done.marker', `failed: ${String(err)}`);
    } catch {
      // ignore
    }
  }
}
