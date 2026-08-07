const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { makeFixtures } = require('../fixtures/makeFixtures');

const RESULTS_FILE = '/tmp/agentws-e2e/mocha-results.txt';

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  // 两阶段 reload：phase 2 复用上一窗口的 user-data（保留 workspaceState）——
  // 必须在 makeFixtures() 之前设置，否则 phase2 会把 fixture 全量清空
  if (process.env.AGENTWS_RELOAD_PHASE === '2') {
    process.env.AGENTWS_KEEP_USER_DATA = '1';
  }
  const fx = makeFixtures();
  const wsPath = process.env.E2E_WS === 'real' ? fx.REALWS : fx.LINKWS;
  fs.rmSync(RESULTS_FILE, { force: true });
  // 沙箱/容器里 /run/user/<uid> 可能只读，VSCode 的 IPC socket 建不出来；
  // 一律把 XDG_RUNTIME_DIR 指到 fixture 可写目录，保证 e2e 可跑
  process.env.XDG_RUNTIME_DIR = path.join(fx.ROOT, 'xdg-runtime');
  fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
  const localWrapper = path.resolve(root, 'test', 'e2e', 'code-under-test.sh');
  const vscodeExecutablePath =
    process.env.VSCODE_PATH || (fs.existsSync('/usr/share/code/code') ? localWrapper : undefined);
  const exitCode = await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(root, 'test', 'e2e', 'suite', 'index.js'),
    extensionTestsEnv: {
      HOME: fx.HOME,
      AGENTWS_E2E_REALWS: fx.REALWS,
      VSCODE_IPC_HOOK_CLI: '',
      AGENTWS_RELOAD_PHASE: process.env.AGENTWS_RELOAD_PHASE || '',
    },
    launchArgs: [
      wsPath,
      '--user-data-dir',
      path.join(fx.ROOT, 'user-data'),
      '--extensions-dir',
      path.join(fx.ROOT, 'exts'),
      '--no-sandbox',
      '--disable-gpu',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
  const results = fs.existsSync(RESULTS_FILE) ? fs.readFileSync(RESULTS_FILE, 'utf8') : '(no results file)';
  console.log('===== E2E RESULTS =====');
  console.log(results.trim());
  console.log('=======================');
  const passes = (results.match(/^PASS /gm) || []).length;
  const fails = (results.match(/^FAIL /gm) || []).length;
  if (exitCode !== 0 || fails > 0 || passes === 0) {
    console.error(`E2E_FAILED exitCode=${exitCode} pass=${passes} fail=${fails}`);
    process.exit(1);
  }
  console.log(`E2E_OK pass=${passes}`);
}

main().catch((err) => {
  console.error('E2E_FAILED', err);
  process.exit(1);
});
