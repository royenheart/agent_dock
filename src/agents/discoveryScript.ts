import type { AgentSession } from '../model';

/**
 * Build the single-shot bash script that scans one server for agent sessions.
 *
 * Output protocol (markers on their own lines):
 *   ===AGENTWS:meta===          one JSON line {"python3":0|1,"sqlite3":0|1}
 *   ===AGENTWS:json===          (python3 path) one big JSON line:
 *                               {"opencode":[...],"codex":[...],"claude":[...],"notes":[...]}
 *   --- or, without python3 (shell fallback) ---
 *   ===AGENTWS:opencode===      sqlite3 -json output, or file chunks
 *   ===AGENTWS:codex-index===   raw tail of session_index.jsonl
 *   ===AGENTWS:codex===         file chunks
 *   ===AGENTWS:claude===        file chunks
 *   ===AGENTWS:end===
 *
 * A file chunk is:
 *   ===AGENTWS:file===
 *   <mtime_sec> <absolute path>
 *   <raw bytes, truncated>
 *
 * The script deliberately avoids `${...}` expansions and requires only
 * bash + GNU findutils on the remote (Linux dev servers).
 */
export function buildDiscoveryScript(limit: number): string {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
  return SCRIPT.replace('__PY__', PY_DISCOVERY).replace(/__LIMIT__/g, String(n));
}

/**
 * Build the script that fetches the full content of one session.
 * For codex/claude: cats the jsonl (tail-capped at 6 MiB).
 * For opencode: dumps messages+parts JSON from the sqlite DB.
 */
export function buildTranscriptScript(session: AgentSession): string {
  if (session.sourcePath) {
    const p = session.sourcePath.replace(/'/g, `'\\''`);
    return [
      'set +e',
      `f='${p}'`,
      'sz=$(stat -c %s "$f" 2>/dev/null || echo 0)',
      'if [ "$sz" -gt 6291456 ]; then',
      'echo "===AGENTWS:truncated==="',
      'tail -c 6291456 "$f"',
      'else',
      'echo "===AGENTWS:full==="',
      'cat "$f"',
      'fi',
    ].join('\n');
  }
  // opencode: only [A-Za-z0-9_-] survives — safe to inject into SQL
  const sid = session.id.replace(/[^A-Za-z0-9_-]/g, '');
  return [
    'set +e',
    'if [ -n "$XDG_DATA_HOME" ]; then OCD="$XDG_DATA_HOME/opencode"; else OCD="$HOME/.local/share/opencode"; fi',
    'OCDB="$OCD/opencode.db"',
    'PY3=$(command -v python3 2>/dev/null)',
    'SQ3=$(command -v sqlite3 2>/dev/null)',
    'if [ -n "$PY3" ]; then',
    'echo "===AGENTWS:json==="',
    `"$PY3" - "$OCDB" '${sid}' <<'AWSPY'`,
    PY_TRANSCRIPT,
    'AWSPY',
    'elif [ -n "$SQ3" ]; then',
    'echo "===AGENTWS:messages==="',
    `"$SQ3" -json "$OCDB" "SELECT id,data FROM message WHERE session_id='${sid}' ORDER BY time_created,id;" 2>/dev/null`,
    'echo "===AGENTWS:parts==="',
    `"$SQ3" -json "$OCDB" "SELECT message_id,data FROM part WHERE session_id='${sid}' ORDER BY time_created,id;" 2>/dev/null`,
    'else',
    'echo "===AGENTWS:error==="',
    'echo "python3 or sqlite3 is required on the server to read opencode sessions"',
    'fi',
  ].join('\n');
}

const PY_TRANSCRIPT = `
import sqlite3, json, sys
db = sys.argv[1]
sid = sys.argv[2]
con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
msgs = con.execute("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id", (sid,)).fetchall()
parts = con.execute("SELECT message_id,data FROM part WHERE session_id=? ORDER BY time_created,id", (sid,)).fetchall()
print(json.dumps({"messages": msgs, "parts": parts}))
`.trim();

// NOTE: the python below deliberately uses no f-strings, no backslashes and no
// `${` sequences — it is embedded inside a TS template literal and a quoted
// bash heredoc.
const PY_DISCOVERY = `
import json, os, sys, glob, sqlite3
from datetime import datetime

limit = int(sys.argv[1])
home = os.path.expanduser("~")
out = {"opencode": [], "codex": [], "claude": [], "notes": []}

def iso_ms(s):
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return 0

def mtime(p):
    try:
        return int(os.path.getmtime(p) * 1000)
    except Exception:
        return 0

def read_lines(p, max_lines):
    n = 0
    with open(p, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            yield line
            n += 1
            if n >= max_lines:
                return

def content_text(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        out = []
        for x in c:
            if isinstance(x, dict):
                tx = x.get("text")
                if isinstance(tx, str):
                    out.append(tx)
        return " ".join(out)
    return ""

# ---------------- opencode ----------------
try:
    if os.environ.get("XDG_DATA_HOME"):
        ocdir = os.environ["XDG_DATA_HOME"] + "/opencode"
    else:
        ocdir = home + "/.local/share/opencode"
    db = ocdir + "/opencode.db"
    if os.path.isfile(db):
        try:
            con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
            cur = con.execute(
                "SELECT id,title,directory,time_created,time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?",
                (limit,),
            )
            for r in cur.fetchall():
                out["opencode"].append({
                    "id": r[0], "title": r[1] or "", "cwd": r[2] or "",
                    "created": r[3] or 0, "updated": r[4] or 0,
                })
            con.close()
        except Exception as e:
            out["notes"].append("opencode db error: %s" % e)
    else:
        cands = []
        for base in (ocdir + "/storage/session", ocdir + "/project"):
            if os.path.isdir(base):
                for p in glob.glob(base + "/**/*.json", recursive=True):
                    if "/message/" in p or "/part/" in p:
                        continue
                    if p.endswith("project.json"):
                        continue
                    cands.append(p)
        cands.sort(key=lambda p: -mtime(p))
        for p in cands[:limit]:
            try:
                with open(p, encoding="utf-8", errors="replace") as fh:
                    d = json.load(fh)
                t = d.get("time") or {}
                out["opencode"].append({
                    "id": d.get("id") or os.path.basename(p)[:-5],
                    "title": d.get("title") or "",
                    "cwd": d.get("directory") or "",
                    "created": t.get("created") or mtime(p),
                    "updated": t.get("updated") or mtime(p),
                })
            except Exception:
                pass
        if not cands:
            out["notes"].append("opencode: no database or legacy sessions found")
except Exception as e:
    out["notes"].append("opencode scan error: %s" % e)

# ---------------- codex ----------------
try:
    cx = os.environ.get("CODEX_HOME", home + "/.codex")
    titles = {}
    idx = cx + "/session_index.jsonl"
    if os.path.isfile(idx):
        for line in read_lines(idx, 100000):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("id") and d.get("thread_name"):
                titles[d["id"]] = d["thread_name"]
    files = glob.glob(cx + "/sessions/**/rollout-*.jsonl", recursive=True)
    files.sort(key=lambda p: -mtime(p))
    for p in files[:limit]:
        try:
            meta = None
            first_user = None
            for line in read_lines(p, 400):
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if meta is None:
                    pay = d.get("payload")
                    if d.get("type") == "session_meta" and isinstance(pay, dict):
                        meta = pay
                    elif d.get("timestamp") and (d.get("id") or d.get("session_id")):
                        meta = d
                    if meta is not None:
                        continue
                txt = None
                pay = d.get("payload")
                if d.get("type") == "event_msg" and isinstance(pay, dict):
                    if pay.get("type") in ("user_message", "userMessage"):
                        m = pay.get("message")
                        if isinstance(m, str):
                            txt = m
                if txt is None and d.get("type") == "response_item" and isinstance(pay, dict):
                    if pay.get("type") == "message" and pay.get("role") == "user":
                        txt = content_text(pay.get("content"))
                if txt and txt.strip():
                    t2 = txt.strip()
                    if not t2.startswith("<environment_context>") and not t2.startswith("<user_instructions>"):
                        first_user = t2[:120]
                        break
            if meta:
                sid = str(meta.get("id") or meta.get("session_id"))
                out["codex"].append({
                    "id": sid,
                    "title": titles.get(sid) or first_user or ("codex:" + sid[:8]),
                    "cwd": meta.get("cwd") or "",
                    "created": iso_ms(meta.get("timestamp") or "") or mtime(p),
                    "updated": mtime(p),
                    "path": p,
                })
        except Exception:
            pass
    if not files:
        out["notes"].append("codex: no rollout files found")
except Exception as e:
    out["notes"].append("codex scan error: %s" % e)

# ---------------- claude ----------------
try:
    clroot = os.environ.get("CLAUDE_CONFIG_DIR", home + "/.claude") + "/projects"
    files = []
    if os.path.isdir(clroot):
        for root, dirs, fns in os.walk(clroot):
            dirs[:] = [d for d in dirs if d != "subagents"]
            for fn in fns:
                if fn.endswith(".jsonl") and not fn.startswith("agent-"):
                    files.append(os.path.join(root, fn))
    files.sort(key=lambda p: -mtime(p))
    for p in files[:limit]:
        try:
            sid = os.path.basename(p)[:-6]
            title = None
            first_prompt = None
            cwd = ""
            for line in read_lines(p, 300):
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if not cwd and d.get("cwd"):
                    cwd = d["cwd"]
                t = d.get("type")
                if t == "summary" and d.get("summary"):
                    if title is None:
                        title = d["summary"]
                elif t == "custom-title" and d.get("customTitle"):
                    title = d["customTitle"]
                elif t == "agent-name" and d.get("agentName"):
                    if title is None:
                        title = d["agentName"]
                elif t == "user" and first_prompt is None and not d.get("isCompactSummary"):
                    m = d.get("message") or {}
                    txt = content_text(m.get("content")).strip()
                    if txt:
                        first_prompt = txt[:120]
            try:
                sz = os.path.getsize(p)
                with open(p, "rb") as fh:
                    fh.seek(max(0, sz - 65536))
                    tail = fh.read().decode("utf-8", "replace")
                for line in tail.splitlines():
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get("type") == "custom-title" and d.get("customTitle"):
                        title = d["customTitle"]
            except Exception:
                pass
            if not cwd:
                name = os.path.basename(os.path.dirname(p))
                cwd = name.replace("-", "/")
            out["claude"].append({
                "id": sid,
                "title": title or first_prompt or ("Session " + sid[:8]),
                "cwd": cwd,
                "created": mtime(p),
                "updated": mtime(p),
                "path": p,
            })
        except Exception:
            pass
    if not files:
        out["notes"].append("claude: no project transcripts found")
except Exception as e:
    out["notes"].append("claude scan error: %s" % e)

print(json.dumps(out))
`.trim();

const SCRIPT = `
set +e
LIMIT=__LIMIT__
echo "===AGENTWS:meta==="
PY3=$(command -v python3 2>/dev/null)
SQ3=$(command -v sqlite3 2>/dev/null)
HPY3=0; [ -n "$PY3" ] && HPY3=1
HSQ3=0; [ -n "$SQ3" ] && HSQ3=1
echo "{\\"python3\\":$HPY3,\\"sqlite3\\":$HSQ3}"

if [ "$HPY3" = "1" ]; then
echo "===AGENTWS:json==="
"$PY3" - "$LIMIT" <<'AWSPY'
__PY__
AWSPY
else
echo "===AGENTWS:opencode==="
if [ -n "$XDG_DATA_HOME" ]; then OCD="$XDG_DATA_HOME/opencode"; else OCD="$HOME/.local/share/opencode"; fi
OCDB="$OCD/opencode.db"
if [ -f "$OCDB" ] && [ "$HSQ3" = "1" ]; then
  "$SQ3" -json "$OCDB" "SELECT id,title,directory,time_created,time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT $LIMIT;" 2>/dev/null
else
  ( find "$OCD/storage/session" -name '*.json' -printf '%T@ %p\\n' 2>/dev/null; find "$OCD/project" -path '*storage/session/info/ses_*.json' -printf '%T@ %p\\n' 2>/dev/null ) | sort -rn | head -n "$LIMIT" | while IFS=' ' read -r mt f; do
    [ -z "$f" ] && continue
    echo "===AGENTWS:file==="
    echo "$mt $f"
    head -c 4096 "$f" 2>/dev/null
    echo
  done
fi
echo "===AGENTWS:codex-index==="
CXD="$HOME/.codex"; [ -n "$CODEX_HOME" ] && CXD="$CODEX_HOME"
tail -n 500 "$CXD/session_index.jsonl" 2>/dev/null
echo "===AGENTWS:codex==="
find "$CXD/sessions" -name 'rollout-*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -n "$LIMIT" | while IFS=' ' read -r mt f; do
  [ -z "$f" ] && continue
  echo "===AGENTWS:file==="
  echo "$mt $f"
  head -c 12288 "$f" 2>/dev/null
  echo
done
echo "===AGENTWS:claude==="
CLD="$HOME/.claude/projects"; [ -n "$CLAUDE_CONFIG_DIR" ] && CLD="$CLAUDE_CONFIG_DIR/projects"
find "$CLD" -name '*.jsonl' -not -path '*/subagents/*' -not -name 'agent-*' -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -n "$LIMIT" | while IFS=' ' read -r mt f; do
  [ -z "$f" ] && continue
  echo "===AGENTWS:file==="
  echo "$mt $f"
  head -c 8192 "$f" 2>/dev/null
  echo
done
fi
echo "===AGENTWS:end==="
`.trim();
