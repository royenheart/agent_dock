import type { AgentKind, AgentSession, DiscoveryResult } from '../model';

interface RawSession {
  id: string;
  title: string;
  cwd: string;
  created: number;
  updated: number;
  path?: string;
}

const SECTION_RE = /^===AGENTWS:([a-z-]+)===$/;
const FILE_MARKER = '===AGENTWS:file===';

function toMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // seconds-float mtimes (from shell fallback) vs ms epochs (from python)
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Split the script stdout into named sections (file chunks stay inside their section). */
function splitSections(stdout: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = SECTION_RE.exec(line);
    if (m) {
      if (current !== null) {
        sections.set(current, buf.join('\n'));
      }
      current = m[1];
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  if (current !== null) {
    sections.set(current, buf.join('\n'));
  }
  return sections;
}

interface FileChunk {
  mtimeMs: number;
  path: string;
  content: string;
}

function splitFileChunks(section: string): FileChunk[] {
  const chunks: FileChunk[] = [];
  const parts = section.split(FILE_MARKER);
  for (const part of parts) {
    const trimmedStart = part.startsWith('\n') ? part.slice(1) : part;
    if (!trimmedStart.trim()) {
      continue;
    }
    const nl = trimmedStart.indexOf('\n');
    if (nl < 0) {
      continue;
    }
    const header = trimmedStart.slice(0, nl);
    const content = trimmedStart.slice(nl + 1);
    const sp = header.indexOf(' ');
    if (sp < 0) {
      continue;
    }
    const mtimeMs = toMs(parseFloat(header.slice(0, sp)));
    chunks.push({ mtimeMs, path: header.slice(sp + 1).trim(), content });
  }
  return chunks;
}

function firstJsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      out.push(JSON.parse(t));
    } catch {
      // truncated tail of a chunk — ignore
    }
  }
  return out;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join(' ');
  }
  return '';
}

// ---------- codex ----------

function codexMetaFrom(record: unknown): Record<string, unknown> | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  const d = record as Record<string, unknown>;
  if (d.type === 'session_meta' && d.payload && typeof d.payload === 'object') {
    return d.payload as Record<string, unknown>;
  }
  if (typeof d.timestamp === 'string' && (typeof d.id === 'string' || typeof d.session_id === 'string')) {
    return d;
  }
  return undefined;
}

function codexUserText(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  const d = record as Record<string, unknown>;
  const p = d.payload as Record<string, unknown> | undefined;
  if (d.type === 'event_msg' && p && (p.type === 'user_message' || p.type === 'userMessage')) {
    if (typeof p.message === 'string') {
      return p.message;
    }
  }
  if (d.type === 'response_item' && p && p.type === 'message' && p.role === 'user') {
    const t = textFromContent(p.content).trim();
    if (t && !t.startsWith('<environment_context>') && !t.startsWith('<user_instructions>')) {
      return t;
    }
  }
  return undefined;
}

function parseCodexChunk(
  chunk: FileChunk,
  titles: Map<string, string>,
): RawSession | undefined {
  const lines = chunk.content.split('\n');
  let meta: Record<string, unknown> | undefined;
  let firstUser: string | undefined;
  for (const line of lines.slice(0, 400)) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    let rec: unknown;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    if (!meta) {
      meta = codexMetaFrom(rec);
      if (meta) {
        continue;
      }
    }
    const u = codexUserText(rec);
    if (u) {
      firstUser = u.trim().slice(0, 120);
      break;
    }
  }
  if (!meta) {
    return undefined;
  }
  const id = String(meta.id ?? meta.session_id ?? '');
  if (!id) {
    return undefined;
  }
  return {
    id,
    title: titles.get(id) ?? firstUser ?? `codex:${id.slice(0, 8)}`,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
    created: toMs(meta.timestamp) || chunk.mtimeMs,
    updated: chunk.mtimeMs,
    path: chunk.path,
  };
}

// ---------- claude ----------

function parseClaudeChunk(chunk: FileChunk): RawSession | undefined {
  const id = chunk.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.jsonl$/, '') ?? '';
  if (!id) {
    return undefined;
  }
  let title: string | undefined;
  let firstPrompt: string | undefined;
  let cwd = '';
  for (const rec of firstJsonLines(chunk.content)) {
    if (!rec || typeof rec !== 'object') {
      continue;
    }
    const d = rec as Record<string, unknown>;
    if (!cwd && typeof d.cwd === 'string') {
      cwd = d.cwd;
    }
    if (d.type === 'summary' && typeof d.summary === 'string' && !title) {
      title = d.summary;
    } else if (d.type === 'custom-title' && typeof d.customTitle === 'string') {
      title = d.customTitle;
    } else if (d.type === 'agent-name' && typeof d.agentName === 'string' && !title) {
      title = d.agentName;
    } else if (d.type === 'user' && !firstPrompt && !d.isCompactSummary) {
      const msg = d.message as Record<string, unknown> | undefined;
      const txt = textFromContent(msg?.content).trim();
      if (txt) {
        firstPrompt = txt.slice(0, 120);
      }
    }
  }
  if (!cwd) {
    const dir = chunk.path.replace(/\\/g, '/').split('/').slice(-2, -1)[0] ?? '';
    cwd = dir.replace(/-/g, '/');
  }
  return {
    id,
    title: title ?? firstPrompt ?? `Session ${id.slice(0, 8)}`,
    cwd,
    created: chunk.mtimeMs,
    updated: chunk.mtimeMs,
    path: chunk.path,
  };
}

// ---------- opencode fallback ----------

function parseOpencodeSection(section: string): RawSession[] {
  const trimmed = section.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('[')) {
    // sqlite3 -json output
    try {
      const rows = JSON.parse(trimmed) as Record<string, unknown>[];
      return rows
        .filter((r) => typeof r.id === 'string')
        .map((r) => ({
          id: String(r.id),
          title: typeof r.title === 'string' && r.title ? r.title : `opencode:${String(r.id).slice(4, 12)}`,
          cwd: typeof r.directory === 'string' ? r.directory : '',
          created: toMs(r.time_created),
          updated: toMs(r.time_updated),
        }));
    } catch {
      return [];
    }
  }
  // legacy file chunks
  const out: RawSession[] = [];
  for (const chunk of splitFileChunks(section)) {
    try {
      const d = JSON.parse(chunk.content) as Record<string, unknown>;
      const time = (d.time ?? {}) as Record<string, unknown>;
      const id = typeof d.id === 'string' ? d.id : chunk.path.split('/').pop()?.replace(/\.json$/, '') ?? '';
      if (!id) {
        continue;
      }
      out.push({
        id,
        title: typeof d.title === 'string' && d.title ? d.title : `opencode:${id.slice(4, 12)}`,
        cwd: typeof d.directory === 'string' ? d.directory : '',
        created: toMs(time.created) || chunk.mtimeMs,
        updated: toMs(time.updated) || chunk.mtimeMs,
      });
    } catch {
      // unparseable chunk — skip
    }
  }
  return out;
}

// ---------- main entry ----------

export function parseDiscoveryOutput(stdout: string): DiscoveryResult {
  const sections = splitSections(stdout);
  const notes: string[] = [];
  const sessions: AgentSession[] = [];

  const push = (agent: AgentKind, raws: RawSession[]): void => {
    for (const r of raws) {
      sessions.push({
        agent,
        id: r.id,
        title: r.title || `${agent}:${r.id.slice(0, 8)}`,
        cwd: r.cwd,
        timeCreated: r.created,
        timeUpdated: r.updated,
        sourcePath: r.path,
      });
    }
  };

  const jsonSection = sections.get('json');
  if (jsonSection && jsonSection.trim()) {
    // python3 path — already normalized
    try {
      const data = JSON.parse(jsonSection.trim()) as {
        opencode?: RawSession[];
        codex?: RawSession[];
        claude?: RawSession[];
        notes?: string[];
      };
      push('opencode', data.opencode ?? []);
      push('codex', data.codex ?? []);
      push('claude', data.claude ?? []);
      if (Array.isArray(data.notes)) {
        notes.push(...data.notes.map(String));
      }
    } catch (err) {
      notes.push(`failed to parse discovery json: ${String(err)}`);
    }
    return { sessions, notes };
  }

  // shell fallback
  const meta = sections.get('meta');
  if (meta) {
    try {
      const caps = JSON.parse(meta.trim().split('\n')[0]) as { python3?: number; sqlite3?: number };
      if (!caps.python3) {
        notes.push('python3 not found on server — using limited shell fallback');
      }
    } catch {
      // ignore
    }
  }

  const oc = sections.get('opencode');
  if (oc !== undefined) {
    push('opencode', parseOpencodeSection(oc));
  }

  const titles = new Map<string, string>();
  const idx = sections.get('codex-index');
  if (idx) {
    for (const rec of firstJsonLines(idx)) {
      if (rec && typeof rec === 'object') {
        const d = rec as Record<string, unknown>;
        if (typeof d.id === 'string' && typeof d.thread_name === 'string') {
          titles.set(d.id, d.thread_name);
        }
      }
    }
  }

  const codex = sections.get('codex');
  if (codex !== undefined) {
    const raws: RawSession[] = [];
    for (const chunk of splitFileChunks(codex)) {
      const r = parseCodexChunk(chunk, titles);
      if (r) {
        raws.push(r);
      }
    }
    push('codex', raws);
  }

  const claude = sections.get('claude');
  if (claude !== undefined) {
    const raws: RawSession[] = [];
    for (const chunk of splitFileChunks(claude)) {
      const r = parseClaudeChunk(chunk);
      if (r) {
        raws.push(r);
      }
    }
    push('claude', raws);
  }

  return { sessions, notes };
}
