export type AgentKind = 'opencode' | 'codex' | 'claude';

export const AGENT_LABEL: Record<AgentKind, string> = {
  opencode: 'opencode',
  codex: 'Codex',
  claude: 'Claude Code',
};

export interface ServerConfig {
  /** Display name in the tree root. */
  name: string;
  /** SSH host (alias from ~/.ssh/config or hostname/IP). */
  host: string;
  user?: string;
  port?: number;
}

/** A discovered agent session on some server. */
export interface AgentSession {
  agent: AgentKind;
  /** opencode: ses_*; codex: uuid; claude: sessionId (uuid). */
  id: string;
  title: string;
  /** Working directory the session belongs to (tree groups by this). */
  cwd: string;
  /** ms epoch. */
  timeCreated: number;
  /** ms epoch. */
  timeUpdated: number;
  /** Absolute jsonl path for codex/claude sessions; undefined for opencode. */
  sourcePath?: string;
}

/** A normalized chat message used by the transcript webview. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  toolName?: string;
  timestamp?: number;
}

export type RenderBlock =
  | { kind: 'text'; role: 'user' | 'assistant' | 'system'; markdown: string; ts?: number }
  | { kind: 'thinking'; text: string; ts?: number }
  | { kind: 'tool'; name: string; input: string; output?: string; isError?: boolean; status?: string; ts?: number }
  | { kind: 'todo'; items: { content: string; status: string }[]; ts?: number }
  | { kind: 'files'; label: string; files: string[]; ts?: number }
  | { kind: 'notice'; text: string; ts?: number };

/** Result of scanning one server. */
export interface DiscoveryResult {
  sessions: AgentSession[];
  /** Human-readable capability notes / warnings from the remote probe. */
  notes: string[];
}
