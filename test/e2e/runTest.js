const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { makeFixtures } = require('../fixtures/makeFixtures');

const RESULTS_FILE = '/tmp/agentws-e2e/mocha-results.txt';

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const fx = makeFixtures();
  const wsPath = process.env.E2E_WS === 'real' ? fx.REALWS : fx.LINKWS;
  fs.rmSync(RESULTS_FILE, { force: true });
  const exitCode = await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH || path.resolve(root, 'test', 'e2e', 'code-under-test.sh'),
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(root, 'test', 'e2e', 'suite', 'index.js'),
    extensionTestsEnv: { HOME: fx.HOME, AGENTWS_E2E_REALWS: fx.REALWS, VSCODE_IPC_HOOK_CLI: '' },
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
