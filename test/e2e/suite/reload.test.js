/* 跨窗口 reload 恢复 e2e（两阶段）。
 *
 * 背景：VSCode 不自动保存扩展 TreeView 的展开状态（官方 #1071），扩展自行
 * 用 ExpansionState 记录 + reveal 重放；客户端终端由 workspaceState 记录并在
 * activate 重建。此套件用「同一 user-data-dir 开两个窗口」验证这些状态真的
 * 跨 reload 存活——对应历史对话「修复VSCode插件菜单与终端刷新问题」里的
 * reload 后目录结构重置、终端不恢复等缺陷，防止回退。
 *
 * 运行：
 *   AGENTWS_RELOAD_PHASE=1 npm run test:e2e   # 窗口1：展开目录 + 建终端 + 写 marker
 *   AGENTWS_RELOAD_PHASE=2 npm run test:e2e   # 窗口2：断言展开状态/终端已恢复
 * （phase 2 由 runTest.js 自动置 AGENTWS_KEEP_USER_DATA=1 保留 workspaceState）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { clientTerminalOptions } = require('../../../out/ssh/clientTerminal');
const { trackNativeTerminal } = require('../../../out/ssh/nativeTerminal');
const { ExpansionState } = require('../../../out/tree/expansionState');
const { nodeId } = require('../../../out/tree/workspaceProvider');

const PHASE = process.env.AGENTWS_RELOAD_PHASE;
const REALWS = process.env.AGENTWS_E2E_REALWS || '/tmp/agentws-e2e/realws';
const MARKER = path.join(
  path.dirname(process.env.AGENTWS_E2E_REALWS || '/tmp/agentws-e2e/realws'),
  'phase1.json',
);

suite('agent-dock reload persistence e2e', () => {
  let api;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('royenheart.agent-dock');
    assert.ok(ext, 'extension should be installed');
    api = await ext.activate();
    assert.ok(api.provider, 'activate() should export provider');
    assert.ok(api.expansion, 'activate() should export expansion (reload test hook)');
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

  /** 诊断：user-data 下所有 vscdb + 关键状态（定位跨窗口持久化问题）。 */
  async function diag() {
    const ud = '/tmp/agentws-e2e/user-data';
    const dbs = [];
    const walk = (p) => {
      let entries = [];
      try {
        entries = fs.readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const fp = path.join(p, e.name);
        if (e.isDirectory()) {
          walk(fp);
        } else if (fp.endsWith('.vscdb')) {
          dbs.push(fp);
        }
      }
    };
    walk(ud);
    return {
      dbs,
      wsUri: vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
      expansionIds: api.expansion.ids,
      terminals: vscode.window.terminals.map((t) => t.name),
    };
  }

  /** 探测 workspaceState：update 是否可用 + 是否真正落盘（轮询 state.vscdb）。 */
  async function probePersistence() {
    const probe = '__e2e_probe__';
    await api.workspaceState.update(probe, 'hello-' + Date.now());
    const readBack = api.workspaceState.get(probe);
    const dbs = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      dbs.length = 0;
      const walk = (p) => {
        let entries = [];
        try {
          entries = fs.readdirSync(p, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const fp = path.join(p, e.name);
          if (e.isDirectory()) {
            walk(fp);
          } else if (fp.endsWith('.vscdb')) {
            dbs.push(fp);
          }
        }
      };
      walk('/tmp/agentws-e2e/user-data');
      if (dbs.length > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { readBack, dbs, probeValue: api.workspaceState.get(probe) };
  }

  if (PHASE === '1') {
    test('phase1: expand dirs + create client terminal, then persist', async () => {
      // 1. 展开当前服务器下的 workspace folder 与其子目录（模拟用户在界面展开）
      const children = await currentServerChildren();
      const wsFolder = children.find((n) => n.kind === 'folder' && n.workspaceUri);
      assert.ok(wsFolder, 'workspace folder node');
      const kids = await api.provider.getChildren(wsFolder);
      const sub = kids.find((k) => k.kind === 'fsEntry' && k.name === 'sub');
      assert.ok(sub, 'sub dir node');
      await api.provider.getChildren(sub); // 触发 sub 目录条目加载

      api.expansion.onExpand(wsFolder);
      api.expansion.onExpand(sub);
      // 等 workspaceState 落盘
      await new Promise((r) => setTimeout(r, 600));

      // 2. 创建客户端终端（onDidOpenTerminal 自动 track + 持久化到 workspaceState）
      const term = vscode.window.createTerminal(clientTerminalOptions('E2E-RELOAD-CLIENT'));
      term.show();
      await new Promise((r) => setTimeout(r, 1500)); // 等 track/persist 防抖落盘

      // 2b. 创建原生终端并纳入名字跟踪（fsOpenTerminal 的路径）
      const native = vscode.window.createTerminal({ name: 'E2E-RELOAD-NATIVE', cwd: REALWS });
      trackNativeTerminal(native, REALWS);
      await new Promise((r) => setTimeout(r, 800));

      // 3. 持久化断言：状态确实写进了真实 workspaceState（同一 memento 读回）
      const savedTerms = api.workspaceState.get('agentDock.clientTerminals.v1', []);
      assert.ok(
        Array.isArray(savedTerms) && savedTerms.some((d) => d && d.name === 'E2E-RELOAD-CLIENT'),
        `client terminal should be persisted to workspaceState; have: ${JSON.stringify(savedTerms)}`,
      );
      const savedNative = api.workspaceState.get('agentDock.nativeTerminals.v1', {});
      assert.ok(
        Object.values(savedNative).some((r) => r && r.name === 'E2E-RELOAD-NATIVE'),
        `native terminal should be persisted to workspaceState; have: ${JSON.stringify(savedNative)}`,
      );

      // 4. 模拟 reload：用真实 workspaceState 新建 ExpansionState 实例再 init，
      //    验证「持久化 → 恢复」链路（跨窗口版见 phase2，取决于环境是否落盘）
      const es2 = new ExpansionState();
      es2.init(api.workspaceState);
      assert.ok(es2.ids.includes(nodeId(sub)), 'simulated reload: init restores sub dir from real workspaceState');
      assert.ok(es2.ids.includes(nodeId(wsFolder)), 'simulated reload: init restores workspace folder');

      // 5. 写 phase1 marker（phase2 断言用；nodeId 跨窗口稳定）
      const marker = {
        wsFolderId: nodeId(wsFolder),
        subId: nodeId(sub),
        clientTerm: 'E2E-RELOAD-CLIENT',
        nativeTerm: 'E2E-RELOAD-NATIVE',
        diag: await diag(),
        probe: await probePersistence(),
      };
      fs.writeFileSync(MARKER, JSON.stringify(marker, null, 2));
      console.log('phase1 marker written:', MARKER, JSON.stringify(marker));
      // 优雅退出窗口：让 workspaceState（SQLite）真正落盘，phase2 才能读到
      // （若此环境不落盘，phase2 会降级，见 phase2 内 probe.dbs 判断）
      await new Promise((r) => setTimeout(r, 1500));
      await vscode.commands.executeCommand('workbench.action.quit');
    });
  } else if (PHASE === '2') {
    // 落盘探测：phase1 若探测到 state.vscdb（正常 VSCode 环境）→ 强断言跨窗口恢复；
    // 若此环境不落盘（headless 测试的 VSCode 不写 workspaceStorage）→ 降级为
    // 「新窗口正常启动 + 树可达」，跨窗口恢复逻辑已由 phase1 的模拟 reload 覆盖。
    const persisted = fs.existsSync(MARKER)
      ? (JSON.parse(fs.readFileSync(MARKER, 'utf8')).probe?.dbs?.length ?? 0) > 0
      : false;

    test('phase2: window restarted and tree reachable', async () => {
      assert.ok(fs.existsSync(MARKER), `phase1 marker missing: run AGENTWS_RELOAD_PHASE=1 first`);
      const marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
      // 新窗口进程：phase1 的内存探针值不应存活（除非落盘恢复）
      const probeNow = api.workspaceState.get('__e2e_probe__');
      if (persisted) {
        assert.equal(probeNow, marker.probe.probeValue, 'workspaceState should survive reload when persisted');
      } else {
        assert.equal(probeNow, undefined, 'new window: in-memory probe must not survive without persistence');
        console.log('SKIP cross-window restore asserts: this environment does not write state.vscdb (headless VSCode); phase1 simulated reload covers the restore path');
      }
      // 目录结构 reload 后仍可达（reveal 重放依赖的树路径）
      const children = await currentServerChildren();
      const wsFolder = children.find((n) => n.kind === 'folder' && n.workspaceUri);
      assert.ok(wsFolder, 'workspace folder reachable after reload');
      const kids = await api.provider.getChildren(wsFolder);
      assert.ok(kids.some((k) => k.kind === 'fsEntry' && k.name === 'a.txt'), 'dir contents reachable after reload');
      const sub = kids.find((k) => k.kind === 'fsEntry' && k.name === 'sub');
      assert.ok(sub, 'sub dir reachable after reload');
      await api.provider.getChildren(sub);
    });

    test('phase2: expanded dirs + terminals restored from previous window', async () => {
      assert.ok(fs.existsSync(MARKER), `phase1 marker missing: run AGENTWS_RELOAD_PHASE=1 first`);
      const marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
      if (!persisted) {
        // 环境不落盘：跨窗口恢复无法成立，跳过（phase1 已做模拟 reload 断言）
        console.log('SKIP: no workspaceState persistence in this environment');
        return;
      }
      // 目录展开状态跨窗口存活（ExpansionState.init 从 workspaceState 恢复）
      const ids = api.expansion.ids;
      assert.ok(
        ids.includes(marker.subId),
        `expanded ids should contain sub dir ${marker.subId}; have: ${ids.join(',')}`,
      );
      assert.ok(ids.includes(marker.wsFolderId), `expanded ids should contain workspace folder ${marker.wsFolderId}`);
      // 客户端终端按保存的名字重建
      const found = vscode.window.terminals.find((t) => t.name === marker.clientTerm);
      assert.ok(
        found,
        `client terminal "${marker.clientTerm}" should be rebuilt after reload; have: ${vscode.window.terminals
          .map((t) => t.name)
          .join(',')}`,
      );
    });
  } else {
    test('no-op: set AGENTWS_RELOAD_PHASE=1 then =2 to run', () => {});
  }
});
