import type { AgentSession } from '../model';
import { shq } from '../ssh/remoteExec';

/** The CLI command that resumes the session, to run inside session.cwd. */
export function resumeCommand(session: AgentSession): string {
  switch (session.agent) {
    case 'opencode':
      // NOTE: do not combine with --continue (it overrides --session)
      return `opencode --session ${shq(session.id)}`;
    case 'codex':
      return `codex resume ${shq(session.id)}`;
    case 'claude':
      return `claude --resume ${shq(session.id)}`;
  }
}
