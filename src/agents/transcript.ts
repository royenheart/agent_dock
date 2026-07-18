import type { AgentSession, ChatMessage } from '../model';

const MAX_TEXT = 20_000;
const TOOL_INPUT_PREVIEW = 400;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
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
    return parts.join('\n');
  }
  return '';
}

function jsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      out.push(JSON.parse(t));
    } catch {
      // partial line (truncated tail) — skip
    }
  }
  return out;
}

function brief(value: unknown, max: number): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------- claude ----------------

export function renderClaudeTranscript(jsonl: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const rec of jsonLines(jsonl)) {
    if (!rec || typeof rec !== 'object') {
      continue;
    }
    const d = rec as Record<string, unknown>;
    const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : undefined;
    const msg = d.message as Record<string, unknown> | undefined;
    if (d.type === 'user') {
      if (d.isCompactSummary) {
        out.push({ role: 'system', text: '（上下文压缩摘要，已跳过）', timestamp: ts });
        continue;
      }
      const content = msg?.content;
      if (Array.isArray(content)) {
        // split text vs tool_result blocks
        const texts: string[] = [];
        for (const block of content) {
          if (!block || typeof block !== 'object') {
            continue;
          }
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text);
          } else if (b.type === 'tool_result') {
            out.push({
              role: 'tool',
              toolName: 'tool_result',
              text: truncate(textFromContent(b.content) || brief(b.content, TOOL_INPUT_PREVIEW), MAX_TEXT),
              timestamp: ts,
            });
          }
        }
        const t = texts.join('\n').trim();
        if (t) {
          out.push({ role: 'user', text: truncate(t, MAX_TEXT), timestamp: ts });
        }
      } else {
        const t = textFromContent(content).trim();
        if (t) {
          out.push({ role: 'user', text: truncate(t, MAX_TEXT), timestamp: ts });
        }
      }
    } else if (d.type === 'assistant') {
      const content = msg?.content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue;
        }
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ role: 'assistant', text: truncate(b.text, MAX_TEXT), timestamp: ts });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          out.push({ role: 'system', text: `💭 ${truncate(b.thinking, 600)}`, timestamp: ts });
        } else if (b.type === 'tool_use') {
          out.push({
            role: 'tool',
            toolName: typeof b.name === 'string' ? b.name : 'tool',
            text: brief(b.input, TOOL_INPUT_PREVIEW),
            timestamp: ts,
          });
        }
      }
    }
    // summary/system/progress/file-history records are skipped
  }
  return out;
}

// ---------------- codex ----------------

export function renderCodexTranscript(jsonl: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const rec of jsonLines(jsonl)) {
    if (!rec || typeof rec !== 'object') {
      continue;
    }
    const d = rec as Record<string, unknown>;
    const p = d.payload as Record<string, unknown> | undefined;
    if (!p) {
      continue;
    }
    const ts = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : undefined;

    if (d.type === 'response_item') {
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const t = textFromContent(p.content).trim();
        const isCodexEnvelope =
          p.role === 'user' && (t.startsWith('<environment_context>') || t.startsWith('<user_instructions>'));
        if (t && !isCodexEnvelope) {
          out.push({ role: p.role, text: truncate(t, MAX_TEXT), timestamp: ts });
        }
      } else if (p.type === 'function_call') {
        out.push({
          role: 'tool',
          toolName: typeof p.name === 'string' ? p.name : 'function_call',
          text: brief(p.arguments, TOOL_INPUT_PREVIEW),
          timestamp: ts,
        });
      } else if (p.type === 'local_shell_call') {
        const action = p.action as Record<string, unknown> | undefined;
        const cmd = Array.isArray(action?.command) ? (action.command as unknown[]).join(' ') : brief(p, TOOL_INPUT_PREVIEW);
        out.push({ role: 'tool', toolName: 'shell', text: truncate(cmd, TOOL_INPUT_PREVIEW), timestamp: ts });
      } else if (p.type === 'function_call_output') {
        const output = typeof p.output === 'string' ? p.output : brief(p.output, TOOL_INPUT_PREVIEW);
        out.push({ role: 'tool', toolName: 'output', text: truncate(output, 2_000), timestamp: ts });
      } else if (p.type === 'reasoning') {
        const summary = Array.isArray(p.summary) ? textFromContent(p.summary) : '';
        if (summary.trim()) {
          out.push({ role: 'system', text: `💭 ${truncate(summary, 600)}`, timestamp: ts });
        }
      }
    } else if (d.type === 'event_msg') {
      // legacy rollout format
      if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) {
        out.push({ role: 'user', text: truncate(p.message, MAX_TEXT), timestamp: ts });
      } else if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim()) {
        out.push({ role: 'assistant', text: truncate(p.message, MAX_TEXT), timestamp: ts });
      } else if (p.type === 'agent_reasoning' && typeof p.text === 'string' && p.text.trim()) {
        out.push({ role: 'system', text: `💭 ${truncate(p.text, 600)}`, timestamp: ts });
      }
    }
    // turn_context / session_meta / compacted records are skipped
  }
  return out;
}

// ---------------- opencode ----------------

interface OpencodeDump {
  messages: [string, string][];
  parts: [string, string][];
}

export function renderOpencodeTranscript(stdout: string): ChatMessage[] {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^===AGENTWS:([a-z-]+)===$/.exec(line);
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

  let messages: [string, string][] = [];
  let parts: [string, string][] = [];

  const jsonSection = sections.get('json');
  if (jsonSection) {
    try {
      const dump = JSON.parse(jsonSection.trim()) as OpencodeDump;
      messages = dump.messages ?? [];
      parts = dump.parts ?? [];
    } catch {
      // fall through to empty
    }
  } else {
    const parseRows = (text: string | undefined): [string, string][] => {
      if (!text) {
        return [];
      }
      try {
        const rows = JSON.parse(text.trim()) as Record<string, unknown>[];
        return rows
          .map((r) => [String(r.id ?? r.message_id ?? ''), String(r.data ?? '{}')] as [string, string])
          .filter((row) => row[0] !== '');
      } catch {
        return [];
      }
    };
    messages = parseRows(sections.get('messages'));
    parts = parseRows(sections.get('parts'));
  }

  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const [messageId, dataStr] of parts) {
    try {
      const data = JSON.parse(dataStr) as Record<string, unknown>;
      const list = partsByMessage.get(messageId) ?? [];
      list.push(data);
      partsByMessage.set(messageId, list);
    } catch {
      // skip malformed part
    }
  }

  const out: ChatMessage[] = [];
  for (const [id, dataStr] of messages) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role = data.role === 'user' || data.role === 'assistant' ? data.role : 'assistant';
    const time = data.time as Record<string, unknown> | undefined;
    const ts = typeof time?.created === 'number' ? (time.created as number) : undefined;
    for (const part of partsByMessage.get(id) ?? []) {
      const ptype = part.type;
      if (ptype === 'text' && typeof part.text === 'string' && part.text.trim()) {
        out.push({ role, text: truncate(part.text, MAX_TEXT), timestamp: ts });
      } else if (ptype === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
        out.push({ role: 'system', text: `💭 ${truncate(part.text, 600)}`, timestamp: ts });
      } else if (ptype === 'tool') {
        const state = part.state as Record<string, unknown> | undefined;
        const input = state?.input ?? part.input;
        out.push({
          role: 'tool',
          toolName: typeof part.tool === 'string' ? part.tool : 'tool',
          text: brief(input, TOOL_INPUT_PREVIEW),
          timestamp: ts,
        });
      }
    }
  }
  return out;
}

// ---------------- dispatch ----------------

/** Strip the leading ===AGENTWS:full===/===AGENTWS:truncated=== marker line. */
function stripLeadMarker(stdout: string): { body: string; truncated: boolean } {
  const firstNl = stdout.indexOf('\n');
  const first = firstNl >= 0 ? stdout.slice(0, firstNl) : stdout;
  if (first === '===AGENTWS:full===') {
    return { body: stdout.slice(firstNl + 1), truncated: false };
  }
  if (first === '===AGENTWS:truncated===') {
    return { body: stdout.slice(firstNl + 1), truncated: true };
  }
  return { body: stdout, truncated: false };
}

export function renderTranscript(session: AgentSession, stdout: string): ChatMessage[] {
  if (session.agent === 'opencode') {
    return renderOpencodeTranscript(stdout);
  }
  const { body, truncated } = stripLeadMarker(stdout);
  const msgs = session.agent === 'claude' ? renderClaudeTranscript(body) : renderCodexTranscript(body);
  if (truncated) {
    msgs.unshift({
      role: 'system',
      text: '⚠️ 会话文件过大，仅显示末尾 6 MiB 内容（早期消息未加载）',
    });
  }
  return msgs;
}
