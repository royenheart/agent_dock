const fs = require('node:fs');
const path = require('node:path');
const Mocha = require('mocha');

const RESULTS_FILE = '/tmp/agentws-e2e/mocha-results.txt';
const MARKER = '/tmp/agentws-e2e/suite-markers.log';

function mark(msg) {
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.appendFileSync(MARKER, `${new Date().toISOString()} ${msg}\n`);
}
mark('suite module loaded');

class FileReporter {
  constructor(runner) {
    const lines = [];
    // 增量写：测试可能用 workbench.action.quit 提前优雅退出（触发 storage flush），
    // 结果必须在那之前落盘，不能在 mocha end 才一次性写
    const append = () => {
      fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
      fs.appendFileSync(RESULTS_FILE, lines.join('\n') + '\n');
      lines.length = 0;
    };
    runner.on('pass', (t) => {
      lines.push(`PASS ${t.fullTitle()}`);
      append();
    });
    runner.on('fail', (t, e) => {
      lines.push(`FAIL ${t.fullTitle()} :: ${(e && e.message) || ''}`);
      append();
    });
    runner.on('end', () => {
      append();
      mark(`mocha end, ${lines.length} events`);
    });
  }
}

module.exports.run = function run(testsRoot, cb) {
  mark(`run() called, testsRoot=${testsRoot}`);
  // 两阶段 reload 测试：AGENTWS_RELOAD_PHASE=1/2 时只跑 reload.test.js（跨窗口验证恢复），
  // 否则跑常规 suite（extension.test.js）
  const reloadPhase = process.env.AGENTWS_RELOAD_PHASE;
  const testFile = reloadPhase
    ? path.join(__dirname, 'reload.test.js')
    : path.join(__dirname, 'extension.test.js');
  mark(`reload phase: ${reloadPhase || '(none)'}, test file: ${testFile}`);
  mark('test file exists: ' + fs.existsSync(testFile) + ' (' + testFile + ')');
  const mocha = new Mocha({ ui: 'tdd', timeout: 120000, reporter: FileReporter });
  mocha.addFile(testFile);
  try {
    mocha.run((failures) => {
      mark(`mocha done, failures=${failures}`);
      cb(null, failures);
    });
  } catch (err) {
    mark(`mocha threw: ${err && err.stack}`);
    cb(err);
  }
};
