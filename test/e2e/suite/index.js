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
    runner.on('pass', (t) => lines.push(`PASS ${t.fullTitle()}`));
    runner.on('fail', (t, e) => lines.push(`FAIL ${t.fullTitle()} :: ${(e && e.message) || ''}`));
    runner.on('end', () => {
      fs.writeFileSync(RESULTS_FILE, `${lines.join('\n')}\n`);
      mark(`mocha end, ${lines.length} events`);
    });
  }
}

module.exports.run = function run(testsRoot, cb) {
  mark(`run() called, testsRoot=${testsRoot}`);
  const testFile = path.join(__dirname, 'extension.test.js');
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
