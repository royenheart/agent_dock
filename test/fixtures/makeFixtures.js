// E2E fixture generator: fixture HOME (opencode sqlite / codex jsonl / claude
// jsonl / ssh config) + workspace opened VIA SYMLINK to exercise realpath
// matching. Idempotent: wipes and recreates /tmp/agentws-e2e.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = '/tmp/agentws-e2e';
const HOME = path.join(ROOT, 'home');
const REALWS = path.join(ROOT, 'realws');
const LINKWS = path.join(ROOT, 'linkws');
const OUTSIDE = path.join(ROOT, 'outside');

const CODEX_ID = '11111111-2222-3333-4444-555555555555';
const CLAUDE_ID = '22222222-3333-4444-5555-666666666666';

function makeFixtures() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(REALWS, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });

  fs.writeFileSync(path.join(REALWS, 'a.txt'), 'hello e2e\n');
  fs.mkdirSync(path.join(REALWS, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(REALWS, 'sub', 'b.txt'), 'nested\n');
  fs.symlinkSync(REALWS, LINKWS);

  // ---- opencode sqlite ----
  const ocDir = path.join(HOME, '.local', 'share', 'opencode');
  fs.mkdirSync(ocDir, { recursive: true });
  const dbPath = path.join(ocDir, 'opencode.db');
  const py = `
import sqlite3
db = ${JSON.stringify(dbPath)}
realws = ${JSON.stringify(REALWS)}
outside = ${JSON.stringify(OUTSIDE)}
con = sqlite3.connect(db)
con.execute("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)")
con.execute("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)")
con.execute("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)")
con.execute("INSERT INTO session VALUES ('ses_e2e_inws','E2E 工作区内会话',?,1000,2000,NULL)", (realws,))
con.execute("INSERT INTO session VALUES ('ses_e2e_outside','E2E 外部会话',?,1000,1500,NULL)", (outside,))
con.execute("INSERT INTO message VALUES ('m1','ses_e2e_inws',1,?)", ('{"role":"user","time":{"created":1}}',))
con.execute("INSERT INTO message VALUES ('m2','ses_e2e_inws',2,?)", ('{"role":"assistant","time":{"created":2}}',))
con.execute("INSERT INTO part VALUES ('p1','m1','ses_e2e_inws',1,?)", ('{"type":"text","text":"e2e 用户问题"}',))
con.execute("INSERT INTO part VALUES ('p2','m2','ses_e2e_inws',2,?)", ('{"type":"text","text":"e2e 助手回答"}',))
con.commit()
con.close()
`;
  execFileSync('python3', ['-c', py]);

  // ---- codex rollout ----
  const codexDir = path.join(HOME, '.codex', 'sessions', '2026', '07', '20');
  fs.mkdirSync(codexDir, { recursive: true });
  const rollout = [
    JSON.stringify({ timestamp: '2026-07-20T02:00:00.000Z', id: CODEX_ID, cwd: REALWS, originator: 'codex_cli', cli_version: '0.0.0', source: 'cli' }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'e2e codex 问题' }] } }),
  ].join('\n');
  fs.writeFileSync(path.join(codexDir, `rollout-2026-07-20T10-00-00-${CODEX_ID}.jsonl`), rollout + '\n');

  // ---- claude transcript ----
  const claudeDir = path.join(HOME, '.claude', 'projects', '-tmp-agentws-e2e-realws');
  fs.mkdirSync(claudeDir, { recursive: true });
  const transcript = [
    JSON.stringify({ type: 'summary', summary: 'e2e claude 会话', cwd: REALWS }),
    JSON.stringify({ type: 'user', cwd: REALWS, message: { content: [{ type: 'text', text: 'e2e claude 问题' }] } }),
  ].join('\n');
  fs.writeFileSync(path.join(claudeDir, `${CLAUDE_ID}.jsonl`), transcript + '\n');

  // ---- ssh config ----
  fs.mkdirSync(path.join(HOME, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.ssh', 'config'), 'Host e2e-host\n  HostName 127.0.0.1\n  User tester\n  Port 2222\n');

  return { ROOT, HOME, REALWS, LINKWS, OUTSIDE, CODEX_ID, CLAUDE_ID };
}

module.exports = { makeFixtures };

if (require.main === module) {
  const fx = makeFixtures();
  console.log('fixtures ready:', fx);
}
