// Smoke test: run the discovery pipeline against this machine's real
// ~/.local/share/opencode, ~/.codex and ~/.claude stores, then render one
// transcript per agent. Run: node test/smoke.js
const { execLocal } = require('../out/ssh/remoteExec');
const { buildDiscoveryScript, buildTranscriptScript } = require('../out/agents/discoveryScript');
const { parseDiscoveryOutput } = require('../out/agents/parse');
const { renderTranscript } = require('../out/agents/transcript');

function fmt(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '----';
}

(async () => {
  // 0. bash syntax check of the generated script
  const script = buildDiscoveryScript(15);
  require('fs').writeFileSync('/tmp/agentws-discovery.sh', script);
  console.log('--- discovery script written to /tmp/agentws-discovery.sh');

  // 1. run it locally
  const res = await execLocal(script, 120_000);
  console.log('--- exec: code=%d timedOut=%s stdout=%dB stderr=%s',
    res.code, res.timedOut, res.stdout.length, res.stderr.slice(0, 300) || '(empty)');

  // 2. parse
  const { sessions, notes } = parseDiscoveryOutput(res.stdout);
  const byAgent = { opencode: [], codex: [], claude: [] };
  for (const s of sessions) byAgent[s.agent].push(s);
  console.log('\n=== notes ===');
  for (const n of notes) console.log('  *', n);
  for (const agent of ['opencode', 'codex', 'claude']) {
    const list = byAgent[agent];
    console.log(`\n=== ${agent}: ${list.length} sessions ===`);
    for (const s of list.slice(0, 3)) {
      console.log(`  [${fmt(s.timeUpdated)}] ${s.title.slice(0, 60)}`);
      console.log(`      id=${s.id.slice(0, 28)} cwd=${s.cwd.slice(0, 70)}`);
      console.log(`      path=${s.sourcePath ?? '(sqlite)'}`);
    }
  }

  // 3. transcript smoke: one session per agent (if any)
  for (const agent of ['opencode', 'codex', 'claude']) {
    const s = byAgent[agent][0];
    if (!s) continue;
    const tscript = buildTranscriptScript(s);
    const tres = await execLocal(tscript, 60_000);
    const msgs = renderTranscript(s, tres.stdout);
    console.log(`\n=== transcript ${agent} "${s.title.slice(0, 40)}" → ${msgs.length} messages ===`);
    for (const m of msgs.slice(0, 4)) {
      console.log(`  <${m.role}${m.toolName ? ':' + m.toolName : ''}> ${m.text.slice(0, 110).replace(/\n/g, ' | ')}`);
    }
  }
  console.log('\nSMOKE_DONE');
})().catch((e) => {
  console.error('SMOKE_FAIL', e);
  process.exit(1);
});
