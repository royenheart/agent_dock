import type { AgentSession, RenderBlock } from '../model';

const MAX_TEXT = 20_000;
const TOOL_INPUT_PREVIEW = 600;
const TOOL_OUTPUT_PREVIEW = 4_000;

export interface TranscriptStrings {
  compactSummary: string;
  truncatedNotice: string;
  compactBoundary: string;
  redactedThinking: string;
  filesChanged: string;
  attachment: string;
  subtask: string;
  subagent: string;
}

const DEFAULT_STRINGS: TranscriptStrings = {
  compactSummary: '(compacted context summary — skipped)',
  truncatedNotice: 'Session file is large; showing the last 6 MiB only (earlier messages not loaded)',
  compactBoundary: '— context compacted —',
  redactedThinking: '(redacted thinking)',
  filesChanged: 'files changed',
  attachment: 'attachment',
  subtask: 'subtask',
  subagent: '(subagent)',
};

type ToolBlock = Extract<RenderBlock, { kind: 'tool' }>;

export interface TranscriptSummary {
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  skillCalls?: number;
  skillTokens?: number;
}

function estimateTokensFromChars(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

function skillNameOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const i = input as Record<string, unknown>;
  for (const key of ['skill', 'name', 'skill_name', 'command']) {
    if (typeof i[key] === 'string' && (i[key] as string)) {
      return i[key] as string;
    }
  }
  return undefined;
}

function markSkillCall(acc: TranscriptSummary | undefined, output: string): number {
  const est = estimateTokensFromChars(output);
  if (acc) {
    acc.skillCalls = (acc.skillCalls ?? 0) + 1;
    acc.skillTokens = (acc.skillTokens ?? 0) + est;
  }
  return est;
}

export interface TranscriptResult {
  blocks: RenderBlock[];
  summary: TranscriptSummary;
}

export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function addUsage(acc: TranscriptSummary | undefined, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number }): void {
  if (!acc) {
    return;
  }
  acc.input = (acc.input ?? 0) + (u.input ?? 0);
  acc.output = (acc.output ?? 0) + (u.output ?? 0);
  acc.cacheRead = (acc.cacheRead ?? 0) + (u.cacheRead ?? 0);
  acc.cacheWrite = (acc.cacheWrite ?? 0) + (u.cacheWrite ?? 0);
  acc.cost = (acc.cost ?? 0) + (u.cost ?? 0);
}

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

function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(t);
      if (parsed && typeof parsed === 'object') {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // 截断的尾行 —— 跳过
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

function tsOf(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

function pushTodoItems(out: RenderBlock[], raw: unknown, ts?: number): void {
  if (!Array.isArray(raw)) {
    return;
  }
  const items = raw
    .map((x) => {
      const r = x as Record<string, unknown>;
      return { content: String(r?.content ?? r?.subject ?? r?.step ?? ''), status: String(r?.status ?? 'pending') };
    })
    .filter((i) => i.content);
  if (items.length > 0) {
    out.push({ kind: 'todo', items, ts });
  }
}

// ---------------- claude ----------------

export function renderClaudeTranscript(
  jsonl: string,
  strings: TranscriptStrings = DEFAULT_STRINGS,
  acc?: TranscriptSummary,
): RenderBlock[] {
  const out: RenderBlock[] = [];
  const pendingTools = new Map<string, ToolBlock>();
  const skillPending = new Set<ToolBlock>();
  for (const d of jsonLines(jsonl)) {
    const ts = tsOf(d.timestamp);
    const msg = d.message as Record<string, unknown> | undefined;
    if (d.type === 'user') {
      if (d.isCompactSummary) {
        out.push({ kind: 'notice', text: strings.compactSummary, ts });
        continue;
      }
      const content = msg?.content;
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: typeof content === 'string' ? content : '' }];
      const texts: string[] = [];
      for (const raw of blocks) {
        if (!raw || typeof raw !== 'object') {
          continue;
        }
        const b = raw as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        } else if (b.type === 'tool_result') {
          const output = truncate(textFromContent(b.content) || brief(b.content, TOOL_INPUT_PREVIEW), TOOL_OUTPUT_PREVIEW);
          const pending = typeof b.tool_use_id === 'string' ? pendingTools.get(b.tool_use_id) : undefined;
          if (pending) {
            pending.output = output;
            pending.isError = b.is_error === true;
            if (skillPending.has(pending)) {
              pending.estTokens = markSkillCall(acc, output);
              skillPending.delete(pending);
            }
            pendingTools.delete(String(b.tool_use_id));
          } else {
            out.push({ kind: 'tool', name: 'tool_result', input: '', output, isError: b.is_error === true, ts });
          }
        }
      }
      const t = texts.join('\n').trim();
      if (t) {
        out.push({
          kind: 'text',
          role: 'user',
          markdown: truncate(t, MAX_TEXT),
          meta: d.isSidechain === true ? strings.subagent : undefined,
          ts,
        });
      }
    } else if (d.type === 'assistant') {
      const content = msg?.content;
      if (!Array.isArray(content)) {
        continue;
      }
      const usage = msg?.usage as Record<string, unknown> | undefined;
      const model = typeof msg?.model === 'string' ? msg.model : undefined;
      let usageMeta: string | undefined;
      if (usage && typeof usage.input_tokens === 'number') {
        if (acc) {
          acc.model = model ?? acc.model;
          addUsage(acc, {
            input: usage.input_tokens as number,
            output: (usage.output_tokens as number) ?? 0,
            cacheRead: (usage.cache_read_input_tokens as number) ?? 0,
            cacheWrite: (usage.cache_creation_input_tokens as number) ?? 0,
          });
        }
        usageMeta = [
          model,
          `in ${formatTokens(usage.input_tokens as number)}`,
          `out ${formatTokens((usage.output_tokens as number) ?? 0)}`,
          (usage.cache_read_input_tokens as number) > 0 ? `cache ${formatTokens(usage.cache_read_input_tokens as number)}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
      }
      let firstText = true;
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') {
          continue;
        }
        const b = raw as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const sidechain = d.isSidechain === true;
          out.push({
            kind: 'text',
            role: 'assistant',
            markdown: truncate(b.text, MAX_TEXT),
            meta: [firstText ? usageMeta : undefined, sidechain ? strings.subagent : undefined]
              .filter(Boolean)
              .join(' · ') || undefined,
            ts,
          });
          firstText = false;
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          out.push({ kind: 'thinking', text: truncate(b.thinking, MAX_TEXT), ts });
        } else if (b.type === 'redacted_thinking') {
          out.push({ kind: 'thinking', text: strings.redactedThinking, ts });
        } else if (b.type === 'tool_use') {
          if (b.name === 'TodoWrite') {
            pushTodoItems(out, (b.input as Record<string, unknown> | undefined)?.todos, ts);
            continue;
          }
          const skillName = b.name === 'Skill' ? skillNameOf(b.input) : undefined;
          const block: ToolBlock = {
            kind: 'tool',
            name: skillName ? `⚡ skill: ${skillName}` : String(b.name ?? 'tool'),
            input: brief(b.input, TOOL_INPUT_PREVIEW),
            ts,
          };
          out.push(block);
          if (skillName) {
            skillPending.add(block);
          }
          if (typeof b.id === 'string') {
            pendingTools.set(b.id, block);
          }
        }
      }
    } else if (d.type === 'system' && d.subtype === 'compact_boundary') {
      out.push({ kind: 'notice', text: strings.compactBoundary, ts });
    }
  }
  return out;
}

// ---------------- codex ----------------

function functionOutputText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.content === 'string') {
      return o.content;
    }
    if (Array.isArray(o.content_items)) {
      return textFromContent(o.content_items);
    }
  }
  return brief(output, TOOL_INPUT_PREVIEW);
}

export function renderCodexTranscript(
  jsonl: string,
  strings: TranscriptStrings = DEFAULT_STRINGS,
  acc?: TranscriptSummary,
): RenderBlock[] {
  void strings;
  const out: RenderBlock[] = [];
  const pendingTools = new Map<string, ToolBlock>();
  const skillPending = new Set<ToolBlock>();
  let lastModel: string | undefined;
  for (const d of jsonLines(jsonl)) {
    const p = d.payload as Record<string, unknown> | undefined;
    const ts = tsOf(d.timestamp) ?? tsOf(p?.timestamp);
    if (d.type === 'turn_context' && p && typeof p.model === 'string') {
      if (p.model !== lastModel) {
        out.push({ kind: 'notice', text: `⇄ model → ${p.model}`, ts });
        lastModel = p.model;
        if (acc) {
          acc.model = p.model;
        }
      }
    } else if (acc && d.type === 'session_meta') {
      const meta = p ?? d;
      if (typeof meta.model_provider === 'string') {
        acc.model = meta.model_provider;
      }
    } else if (acc && !p && typeof d.model_provider === 'string') {
      acc.model = d.model_provider as string;
    }
    if (!p) {
      continue;
    }
    if (d.type === 'response_item') {
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const text = textFromContent(p.content).trim();
        const isCodexEnvelope =
          p.role === 'user' && (text.startsWith('<environment_context>') || text.startsWith('<user_instructions>'));
        if (text && !isCodexEnvelope) {
          out.push({ kind: 'text', role: p.role, markdown: truncate(text, MAX_TEXT), ts });
        }
      } else if (p.type === 'reasoning') {
        const summary = Array.isArray(p.summary) ? textFromContent(p.summary) : '';
        if (summary.trim()) {
          out.push({ kind: 'thinking', text: truncate(summary, MAX_TEXT), ts });
        }
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const rawArgs = p.arguments ?? p.input;
        let parsedArgs: unknown;
        if (typeof rawArgs === 'string') {
          try {
            parsedArgs = JSON.parse(rawArgs);
          } catch {
            parsedArgs = undefined;
          }
        } else {
          parsedArgs = rawArgs;
        }
        const skillName = /skill/i.test(String(p.name ?? '')) ? skillNameOf(parsedArgs) : undefined;
        const block: ToolBlock = {
          kind: 'tool',
          name: skillName ? `⚡ skill: ${skillName}` : String(p.name ?? 'function'),
          input: brief(rawArgs, TOOL_INPUT_PREVIEW),
          ts,
        };
        out.push(block);
        if (skillName) {
          skillPending.add(block);
        }
        if (typeof p.call_id === 'string') {
          pendingTools.set(p.call_id, block);
        }
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const output = truncate(functionOutputText(p.output), TOOL_OUTPUT_PREVIEW);
        const pending = typeof p.call_id === 'string' ? pendingTools.get(p.call_id) : undefined;
        if (pending) {
          pending.output = output;
          if (skillPending.has(pending)) {
            pending.estTokens = markSkillCall(acc, output);
            skillPending.delete(pending);
          }
          pendingTools.delete(String(p.call_id));
        } else {
          out.push({ kind: 'tool', name: 'output', input: '', output, ts });
        }
      } else if (p.type === 'local_shell_call') {
        const action = p.action as Record<string, unknown> | undefined;
        const cmd = Array.isArray(action?.command) ? (action.command as unknown[]).join(' ') : brief(action, TOOL_INPUT_PREVIEW);
        out.push({ kind: 'tool', name: 'shell', input: truncate(cmd, TOOL_INPUT_PREVIEW), ts });
      } else if (p.type === 'web_search_call') {
        const action = p.action as Record<string, unknown> | undefined;
        out.push({ kind: 'tool', name: 'web_search', input: String(action?.query ?? brief(action, 200)), ts });
      }
    } else if (d.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) {
        out.push({ kind: 'text', role: 'user', markdown: truncate(p.message, MAX_TEXT), ts });
      } else if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim()) {
        out.push({ kind: 'text', role: 'assistant', markdown: truncate(p.message, MAX_TEXT), ts });
      } else if (p.type === 'agent_reasoning' && typeof p.text === 'string' && p.text.trim()) {
        out.push({ kind: 'thinking', text: truncate(p.text, MAX_TEXT), ts });
      } else if (p.type === 'exec_command_begin') {
        const cmd = Array.isArray(p.command) ? (p.command as unknown[]).join(' ') : brief(p.command, TOOL_INPUT_PREVIEW);
        const block: ToolBlock = { kind: 'tool', name: 'shell', input: truncate(cmd, TOOL_INPUT_PREVIEW), ts };
        out.push(block);
        if (typeof p.call_id === 'string') {
          pendingTools.set(p.call_id, block);
        }
      } else if (p.type === 'exec_command_end') {
        const output = truncate(
          String(p.aggregated_output ?? `${p.stdout ?? ''}${p.stderr ?? ''}`),
          TOOL_OUTPUT_PREVIEW,
        );
        const pending = typeof p.call_id === 'string' ? pendingTools.get(p.call_id) : undefined;
        const isError = typeof p.exit_code === 'number' && p.exit_code !== 0;
        if (pending) {
          pending.output = output;
          pending.isError = isError;
          pendingTools.delete(String(p.call_id));
        } else {
          out.push({ kind: 'tool', name: 'shell output', input: '', output, isError, ts });
        }
      } else if (p.type === 'plan_update') {
        pushTodoItems(out, p.plan, ts);
      } else if (p.type === 'token_count') {
        const info = p.info as Record<string, unknown> | undefined;
        const last = info?.last_token_usage as Record<string, unknown> | undefined;
        const total = info?.total_token_usage as Record<string, unknown> | undefined;
        if (last && typeof last.input_tokens === 'number') {
          out.push({
            kind: 'usage',
            label: `tokens · in ${formatTokens(last.input_tokens as number)} · out ${formatTokens((last.output_tokens as number) ?? 0)} · cached ${formatTokens((last.cached_input_tokens as number) ?? 0)}`,
            ts,
          });
        }
        if (acc && total && typeof total.input_tokens === 'number') {
          acc.input = total.input_tokens as number;
          acc.output = (total.output_tokens as number) ?? 0;
          acc.cacheRead = (total.cached_input_tokens as number) ?? 0;
        }
      } else if (p.type === 'patch_apply_end') {
        const changes = p.changes as Record<string, unknown> | undefined;
        const files = changes ? Object.keys(changes) : [];
        if (files.length > 0) {
          out.push({ kind: 'files', label: strings.filesChanged, files, ts });
        }
      }
    }
  }
  return out;
}

// ---------------- opencode ----------------

interface OpencodeDump {
  messages?: [string, string][];
  parts?: [string, string][];
  todos?: [string, unknown, unknown][];
  v2?: [string, string][];
  session?: Record<string, unknown> | null;
}

function splitTranscriptSections(stdout: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^===AGENTWS:(json|messages|parts|todos|error|full|truncated)===$/.exec(line);
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

function renderOpencodeToolPart(part: Record<string, unknown>, ts: number | undefined, acc?: TranscriptSummary): ToolBlock {
  const state = (part.state ?? {}) as Record<string, unknown>;
  const status = typeof state.status === 'string' ? state.status : undefined;
  const block: ToolBlock = {
    kind: 'tool',
    name: String(part.tool ?? 'tool'),
    input: brief(state.input ?? part.input, TOOL_INPUT_PREVIEW),
    output:
      typeof state.output === 'string'
        ? truncate(state.output, TOOL_OUTPUT_PREVIEW)
        : typeof state.error === 'string'
          ? truncate(state.error, TOOL_OUTPUT_PREVIEW)
          : undefined,
    isError: status === 'error',
    status,
    ts,
  };
  if (part.tool === 'skill') {
    const skillName = skillNameOf(state.input ?? part.input);
    block.name = `⚡ skill: ${skillName ?? 'skill'}`;
    if (block.output) {
      block.estTokens = markSkillCall(acc, block.output);
    }
  }
  return block;
}

export function renderOpencodeTranscript(
  stdout: string,
  strings: TranscriptStrings = DEFAULT_STRINGS,
  acc?: TranscriptSummary,
): RenderBlock[] {
  const sections = splitTranscriptSections(stdout);
  let dump: OpencodeDump = {};
  const jsonSection = sections.get('json');
  if (jsonSection && jsonSection.trim()) {
    try {
      dump = JSON.parse(jsonSection.trim()) as OpencodeDump;
    } catch {
      dump = {};
    }
  } else {
    const parseRows = (text: string | undefined, keyField: string): [string, string][] => {
      if (!text) {
        return [];
      }
      try {
        const rows = JSON.parse(text.trim()) as Record<string, unknown>[];
        return rows
          .map((r) => [String(r[keyField] ?? ''), String(r.data ?? '')] as [string, string])
          .filter((row) => row[0] !== '');
      } catch {
        return [];
      }
    };
    dump.messages = parseRows(sections.get('messages'), 'id');
    dump.parts = parseRows(sections.get('parts'), 'message_id');
    try {
      const rows = JSON.parse((sections.get('todos') ?? '').trim() || '[]') as Record<string, unknown>[];
      dump.todos = rows.map((r) => [String(r.content ?? ''), r.status, r.priority]);
    } catch {
      dump.todos = [];
    }
  }

  if (acc && dump.session) {
    const s = dump.session;
    const model = s.model as Record<string, unknown> | undefined;
    if (typeof s.agent === 'string' && s.agent) {
      acc.model = s.agent;
    }
    if (model && typeof model.id === 'string') {
      acc.model = model.providerID ? `${String(model.providerID)}/${model.id}` : model.id;
    }
    acc.input = (s.tokens_input as number) ?? 0;
    acc.output = (s.tokens_output as number) ?? 0;
    acc.cacheRead = (s.tokens_cache_read as number) ?? 0;
    acc.cacheWrite = (s.tokens_cache_write as number) ?? 0;
    if (typeof s.cost === 'number') {
      acc.cost = s.cost;
    }
  }

  const out: RenderBlock[] = [];
  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const [messageId, dataStr] of dump.parts ?? []) {
    try {
      const data = JSON.parse(dataStr) as Record<string, unknown>;
      const list = partsByMessage.get(messageId) ?? [];
      list.push(data);
      partsByMessage.set(messageId, list);
    } catch {
      // 跳过畸形 part
    }
  }

  let prevAgent: string | undefined;
  let prevModel: string | undefined;
  for (const [id, dataStr] of dump.messages ?? []) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role = data.role === 'user' ? 'user' : 'assistant';
    const time = data.time as Record<string, unknown> | undefined;
    const ts = typeof time?.created === 'number' ? time.created : undefined;
    const agentName = typeof data.agent === 'string' && data.agent ? data.agent : undefined;
    const modelRef = data.model as Record<string, unknown> | undefined;
    const modelStr =
      modelRef && typeof modelRef.modelID === 'string'
        ? modelRef.providerID
          ? `${String(modelRef.providerID)}/${modelRef.modelID}`
          : modelRef.modelID
        : undefined;
    const changedAgent = agentName !== undefined && agentName !== prevAgent;
    const changedModel = modelStr !== undefined && modelStr !== prevModel;
    if (agentName) {
      prevAgent = agentName;
    }
    if (modelStr) {
      prevModel = modelStr;
    }
    const messageMeta =
      changedAgent || changedModel
        ? [agentName ?? prevAgent, modelStr ?? prevModel].filter(Boolean).join(' · ')
        : undefined;
    let firstText = true;
    for (const part of partsByMessage.get(id) ?? []) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        out.push({
          kind: 'text',
          role,
          markdown: truncate(part.text, MAX_TEXT),
          meta: firstText ? messageMeta : undefined,
          ts,
        });
        firstText = false;
      } else if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
        out.push({ kind: 'thinking', text: truncate(part.text, MAX_TEXT), ts });
      } else if (part.type === 'tool') {
        out.push(renderOpencodeToolPart(part, ts, acc));
      } else if (part.type === 'step-finish') {
        const tokens = part.tokens as Record<string, unknown> | undefined;
        if (tokens && typeof tokens.input === 'number') {
          const cache = tokens.cache as Record<string, unknown> | undefined;
          const cost = typeof part.cost === 'number' ? ` · $${(part.cost as number).toFixed(4)}` : '';
          out.push({
            kind: 'usage',
            label: `step tokens · in ${formatTokens(tokens.input as number)} · out ${formatTokens((tokens.output as number) ?? 0)} · cache ${formatTokens((cache?.read as number) ?? 0)}${cost}`,
            ts,
          });
        }
      } else if (part.type === 'patch' && Array.isArray(part.files) && part.files.length > 0) {
        out.push({ kind: 'files', label: strings.filesChanged, files: part.files.map(String), ts });
      } else if (part.type === 'file' && typeof part.filename === 'string') {
        out.push({ kind: 'notice', text: `${strings.attachment}: ${part.filename}`, ts });
      } else if (part.type === 'subtask') {
        out.push({ kind: 'notice', text: `${strings.subtask}: ${String(part.description ?? part.agent ?? '')}`, ts });
      }
    }
  }

  if (out.length === 0 && dump.v2 && dump.v2.length > 0) {
    for (const [type, dataStr] of dump.v2) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(dataStr) as Record<string, unknown>;
      } catch {
        continue;
      }
      const time = data.time as Record<string, unknown> | undefined;
      const ts = typeof time?.created === 'number' ? time.created : undefined;
      if (type === 'user' || type === 'assistant') {
        const content = Array.isArray(data.content) ? data.content : [];
        for (const raw of content) {
          if (!raw || typeof raw !== 'object') {
            continue;
          }
          const c = raw as Record<string, unknown>;
          if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
            out.push({ kind: 'text', role: type, markdown: truncate(c.text, MAX_TEXT), ts });
          } else if (c.type === 'reasoning' && typeof c.text === 'string' && c.text.trim()) {
            out.push({ kind: 'thinking', text: truncate(c.text, MAX_TEXT), ts });
          } else if (c.type === 'tool') {
            out.push(renderOpencodeToolPart(c, ts, acc));
          }
        }
      } else if (type === 'compaction') {
        out.push({ kind: 'notice', text: strings.compactBoundary, ts });
      } else if (type === 'shell') {
        out.push({ kind: 'tool', name: 'shell', input: brief(data.command ?? data, TOOL_INPUT_PREVIEW), ts });
      } else if (type === 'model-switched' || type === 'agent-switched') {
        const model = data.model as Record<string, unknown> | undefined;
        const detail = String(model?.id ?? data.agent ?? '');
        out.push({ kind: 'notice', text: `⇄ ${type === 'model-switched' ? 'model' : 'agent'} → ${detail}`, ts });
      } else {
        out.push({ kind: 'notice', text: type, ts });
      }
    }
  }

  const todos = (dump.todos ?? [])
    .map((row) => ({ content: String(row[0] ?? ''), status: String(row[1] ?? 'pending') }))
    .filter((i) => i.content);
  if (todos.length > 0) {
    out.push({ kind: 'todo', items: todos });
  }
  return out;
}

// ---------------- dispatch ----------------

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

export function renderTranscript(
  session: AgentSession,
  stdout: string,
  strings: TranscriptStrings = DEFAULT_STRINGS,
): TranscriptResult {
  const summary: TranscriptSummary = {};
  if (session.agent === 'opencode') {
    return { blocks: renderOpencodeTranscript(stdout, strings, summary), summary };
  }
  const { body, truncated } = stripLeadMarker(stdout);
  const blocks =
    session.agent === 'claude'
      ? renderClaudeTranscript(body, strings, summary)
      : renderCodexTranscript(body, strings, summary);
  if (truncated) {
    blocks.unshift({ kind: 'notice', text: strings.truncatedNotice });
  }
  return { blocks, summary };
}
