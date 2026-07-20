import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentKind } from '../model';

export interface SettingsItem {
  name: string;
  detail?: string;
  agent: AgentKind;
  sourcePath?: string;
}

export interface AgentBucket {
  mcps: SettingsItem[];
  skills: SettingsItem[];
  plugins: SettingsItem[];
  hooks: SettingsItem[];
}

export interface SettingsData {
  serverLabel: string;
  byAgent: Record<AgentKind, AgentBucket>;
  notes: string[];
}

export interface SettingsStrings {
  npmPackage: string;
  localPluginFile: string;
  handlers: (n: number) => string;
  installLocations: (n: number) => string;
  opencodeHooksName: string;
  opencodeHooksDetail: string;
  noConfigFound: string;
}

export const DEFAULT_SETTINGS_STRINGS: SettingsStrings = {
  npmPackage: 'npm package',
  localPluginFile: 'local plugin file',
  handlers: (n) => `${n} handlers`,
  installLocations: (n) => `(${n} install locations)`,
  opencodeHooksName: 'opencode hooks are plugin-based',
  opencodeHooksDetail: 'no standalone hooks config file; events are subscribed inside plugins',
  noConfigFound: 'No agent configuration found on the current server (MCP / Skills / Plugins / Hooks)',
};

const AGENTS: AgentKind[] = ['claude', 'codex', 'opencode'];

function emptyBucket(): AgentBucket {
  return { mcps: [], skills: [], plugins: [], hooks: [] };
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listFiles(dir: string, exts: string[]): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && exts.some((x) => e.name.endsWith(x))).map((e) => e.name);
  } catch {
    return [];
  }
}

function brief(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.slice(0, 120);
  }
  try {
    return JSON.stringify(value).slice(0, 120);
  } catch {
    return undefined;
  }
}

export function parseTomlSections(toml: string, prefix: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = new RegExp(`^\\[${prefix}\\.(?:"([^"]+)"|([^\\]\\n]+))\\]`, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(toml)) !== null) {
    const name = (m[1] ?? m[2] ?? '').trim();
    const start = m.index + m[0].length;
    const nextHeader = toml.indexOf('\n[', start);
    const body = toml.slice(start, nextHeader < 0 ? undefined : nextHeader);
    out.push({ name, body });
  }
  return out;
}

function tomlBodyDetail(body: string): string | undefined {
  const cmd = /^(?:command|url)\s*=\s*"([^"]*)"/m.exec(body);
  if (cmd) {
    return cmd[1].slice(0, 120);
  }
  const enabled = /^enabled\s*=\s*(true|false)/m.exec(body);
  return enabled ? `enabled=${enabled[1]}` : undefined;
}

/**
 * skill 目录 → 能读到它的 agent 集合。
 * ~/.claude/skills 会被 opencode 兼容读取；~/.agents/skills 是跨 agent 共享约定。
 */
const SKILL_ROOTS: { rel: string; agents: AgentKind[] }[] = [
  { rel: '.claude/skills', agents: ['claude', 'opencode'] },
  { rel: '.codex/skills', agents: ['codex'] },
  { rel: '.config/opencode/skills', agents: ['opencode'] },
  { rel: '.config/opencode/skill', agents: ['opencode'] },
  { rel: '.agents/skills', agents: ['claude', 'opencode', 'codex'] },
];

const PROJECT_SKILL_ROOTS: { rel: string; agents: AgentKind[] }[] = [
  { rel: '.claude/skills', agents: ['claude', 'opencode'] },
  { rel: '.opencode/skills', agents: ['opencode'] },
  { rel: '.agents/skills', agents: ['claude', 'opencode', 'codex'] },
];

async function gatherSkillsFrom(dir: string, agents: AgentKind[], out: Map<string, { item: SettingsItem; paths: string[] }>): Promise<void> {
  for (const name of await listDirs(dir)) {
    const skillMd = path.join(dir, name, 'SKILL.md');
    let detail: string | undefined;
    try {
      const raw = await fs.readFile(skillMd, 'utf8');
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      if (fm) {
        detail = /^description:\s*(.+)$/m.exec(fm[1])?.[1]?.trim().slice(0, 100);
      }
    } catch {
      continue;
    }
    for (const agent of agents) {
      const key = `${agent}:${name}`;
      const acc = out.get(key);
      if (acc) {
        acc.paths.push(skillMd);
      } else {
        out.set(key, { item: { name, detail, agent, sourcePath: skillMd }, paths: [skillMd] });
      }
    }
  }
}

async function gatherSkills(home: string, strings: SettingsStrings, projectDirs: string[]): Promise<SettingsItem[]> {
  const byAgentAndName = new Map<string, { item: SettingsItem; paths: string[] }>();
  for (const root of SKILL_ROOTS) {
    await gatherSkillsFrom(path.join(home, root.rel), root.agents, byAgentAndName);
  }
  for (const proj of projectDirs) {
    for (const root of PROJECT_SKILL_ROOTS) {
      await gatherSkillsFrom(path.join(proj, root.rel), root.agents, byAgentAndName);
    }
  }
  const out: SettingsItem[] = [];
  for (const { item, paths } of byAgentAndName.values()) {
    if (paths.length > 1) {
      item.detail = `${item.detail ?? ''} ${strings.installLocations(paths.length)}`.trim();
    }
    out.push(item);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function gatherSettings(
  serverLabel: string,
  homeDir?: string,
  strings: SettingsStrings = DEFAULT_SETTINGS_STRINGS,
  projectDirs: string[] = [],
): Promise<SettingsData> {
  const home = homeDir ?? os.homedir();
  const byAgent: Record<AgentKind, AgentBucket> = {
    claude: emptyBucket(),
    codex: emptyBucket(),
    opencode: emptyBucket(),
  };
  const data: SettingsData = { serverLabel, byAgent, notes: [] };

  // ---- claude code ----
  const claudeJsonPath = path.join(home, '.claude.json');
  const claudeJson = await readJson(claudeJsonPath);
  for (const [name, cfg] of Object.entries((claudeJson?.mcpServers ?? {}) as Record<string, unknown>)) {
    const c = cfg as Record<string, unknown>;
    byAgent.claude.mcps.push({
      name,
      detail: brief(c.command) ?? brief(c.url) ?? brief(c.type),
      agent: 'claude',
      sourcePath: claudeJsonPath,
    });
  }
  const claudeProjects = (claudeJson?.projects ?? {}) as Record<string, unknown>;
  for (const [projPath, projCfg] of Object.entries(claudeProjects)) {
    const projName = path.basename(projPath) || projPath;
    const projMcp = ((projCfg as Record<string, unknown>).mcpServers ?? {}) as Record<string, unknown>;
    for (const [name, cfg] of Object.entries(projMcp)) {
      const c = cfg as Record<string, unknown>;
      byAgent.claude.mcps.push({
        name,
        detail: `[${projName}] ${brief(c.command) ?? brief(c.url) ?? ''}`.trim(),
        agent: 'claude',
        sourcePath: claudeJsonPath,
      });
    }
  }
  const claudeSettingsPath = path.join(home, '.claude', 'settings.json');
  const claudeSettings = await readJson(claudeSettingsPath);
  const enabledPlugins = (claudeSettings?.enabledPlugins ?? {}) as Record<string, unknown>;
  for (const [name, on] of Object.entries(enabledPlugins)) {
    if (on) {
      byAgent.claude.plugins.push({ name, agent: 'claude', sourcePath: claudeSettingsPath });
    }
  }
  const claudeHooks = (claudeSettings?.hooks ?? {}) as Record<string, unknown>;
  for (const [event, handlers] of Object.entries(claudeHooks)) {
    const count = Array.isArray(handlers) ? handlers.length : 1;
    byAgent.claude.hooks.push({
      name: event,
      detail: strings.handlers(count),
      agent: 'claude',
      sourcePath: claudeSettingsPath,
    });
  }

  // ---- codex ----
  const codexTomlPath = path.join(home, '.codex', 'config.toml');
  let codexToml = '';
  try {
    codexToml = await fs.readFile(codexTomlPath, 'utf8');
  } catch {
    codexToml = '';
  }
  if (codexToml) {
    for (const s of parseTomlSections(codexToml, 'mcp_servers')) {
      byAgent.codex.mcps.push({ name: s.name, detail: tomlBodyDetail(s.body), agent: 'codex', sourcePath: codexTomlPath });
    }
    for (const s of parseTomlSections(codexToml, 'plugins')) {
      byAgent.codex.plugins.push({ name: s.name, detail: tomlBodyDetail(s.body), agent: 'codex', sourcePath: codexTomlPath });
    }
    if (/^\[hooks\]/m.test(codexToml)) {
      byAgent.codex.hooks.push({ name: 'config.toml [hooks]', agent: 'codex', sourcePath: codexTomlPath });
    }
  }
  const codexHooksPath = path.join(home, '.codex', 'hooks.json');
  const codexHooks = await readJson(codexHooksPath);
  if (codexHooks) {
    for (const name of Object.keys(codexHooks)) {
      byAgent.codex.hooks.push({ name, agent: 'codex', sourcePath: codexHooksPath });
    }
  }

  // ---- opencode ----
  const ocConfigDir = path.join(home, '.config', 'opencode');
  const ocJsonPath = path.join(ocConfigDir, 'opencode.json');
  const ocJson = (await readJson(ocJsonPath)) ?? (await readJson(path.join(ocConfigDir, 'config.json')));
  for (const [name, cfg] of Object.entries((ocJson?.mcp ?? {}) as Record<string, unknown>)) {
    const c = cfg as Record<string, unknown>;
    const cmd = Array.isArray(c.command) ? (c.command as unknown[]).join(' ') : brief(c.url);
    byAgent.opencode.mcps.push({ name, detail: cmd ?? brief(c.type), agent: 'opencode', sourcePath: ocJsonPath });
  }
  const ocPluginList = Array.isArray(ocJson?.plugin) ? (ocJson.plugin as unknown[]) : [];
  for (const p of ocPluginList) {
    byAgent.opencode.plugins.push({ name: String(p), detail: strings.npmPackage, agent: 'opencode', sourcePath: ocJsonPath });
  }
  const ocPluginFiles = await listFiles(path.join(ocConfigDir, 'plugins'), ['.js', '.ts']);
  for (const file of ocPluginFiles) {
    byAgent.opencode.plugins.push({
      name: file,
      detail: strings.localPluginFile,
      agent: 'opencode',
      sourcePath: path.join(ocConfigDir, 'plugins', file),
    });
  }
  if (ocPluginList.length > 0 || ocPluginFiles.length > 0) {
    byAgent.opencode.hooks.push({
      name: strings.opencodeHooksName,
      detail: strings.opencodeHooksDetail,
      agent: 'opencode',
      sourcePath: ocConfigDir,
    });
  }

  // ---- 项目级配置（workspace 目录）----
  for (const proj of projectDirs) {
    const projName = path.basename(proj) || proj;
    const prefix = `[${projName}]`;
    const projMcpJson = await readJson(path.join(proj, '.mcp.json'));
    for (const [name, cfg] of Object.entries((projMcpJson?.mcpServers ?? {}) as Record<string, unknown>)) {
      const c = cfg as Record<string, unknown>;
      byAgent.claude.mcps.push({
        name,
        detail: `${prefix} ${brief(c.command) ?? brief(c.url) ?? ''}`.trim(),
        agent: 'claude',
        sourcePath: path.join(proj, '.mcp.json'),
      });
    }
    const projClaudeSettings = await readJson(path.join(proj, '.claude', 'settings.json'));
    const projHooks = (projClaudeSettings?.hooks ?? {}) as Record<string, unknown>;
    for (const [event, handlers] of Object.entries(projHooks)) {
      const count = Array.isArray(handlers) ? handlers.length : 1;
      byAgent.claude.hooks.push({
        name: event,
        detail: `${prefix} ${strings.handlers(count)}`,
        agent: 'claude',
        sourcePath: path.join(proj, '.claude', 'settings.json'),
      });
    }
    const projEnabledPlugins = (projClaudeSettings?.enabledPlugins ?? {}) as Record<string, unknown>;
    for (const [name, on] of Object.entries(projEnabledPlugins)) {
      if (on) {
        byAgent.claude.plugins.push({ name, detail: prefix, agent: 'claude', sourcePath: path.join(proj, '.claude', 'settings.json') });
      }
    }
    const projOcJson = await readJson(path.join(proj, 'opencode.json'));
    for (const [name, cfg] of Object.entries((projOcJson?.mcp ?? {}) as Record<string, unknown>)) {
      const c = cfg as Record<string, unknown>;
      const cmd = Array.isArray(c.command) ? (c.command as unknown[]).join(' ') : brief(c.url);
      byAgent.opencode.mcps.push({
        name,
        detail: `${prefix} ${cmd ?? brief(c.type) ?? ''}`.trim(),
        agent: 'opencode',
        sourcePath: path.join(proj, 'opencode.json'),
      });
    }
    const projOcPlugins = Array.isArray(projOcJson?.plugin) ? (projOcJson.plugin as unknown[]) : [];
    for (const p of projOcPlugins) {
      byAgent.opencode.plugins.push({ name: String(p), detail: `${prefix} ${strings.npmPackage}`, agent: 'opencode', sourcePath: path.join(proj, 'opencode.json') });
    }
    let projCodexToml = '';
    try {
      projCodexToml = await fs.readFile(path.join(proj, '.codex', 'config.toml'), 'utf8');
    } catch {
      projCodexToml = '';
    }
    if (projCodexToml) {
      for (const s of parseTomlSections(projCodexToml, 'mcp_servers')) {
        byAgent.codex.mcps.push({ name: s.name, detail: `${prefix} ${tomlBodyDetail(s.body) ?? ''}`.trim(), agent: 'codex', sourcePath: path.join(proj, '.codex', 'config.toml') });
      }
      for (const s of parseTomlSections(projCodexToml, 'plugins')) {
        byAgent.codex.plugins.push({ name: s.name, detail: prefix, agent: 'codex', sourcePath: path.join(proj, '.codex', 'config.toml') });
      }
      if (/^\[hooks\]/m.test(projCodexToml)) {
        byAgent.codex.hooks.push({ name: 'config.toml [hooks]', detail: prefix, agent: 'codex', sourcePath: path.join(proj, '.codex', 'config.toml') });
      }
    }
  }

  // ---- skills（跨位置去重，按 agent 分行）----
  for (const item of await gatherSkills(home, strings, projectDirs)) {
    byAgent[item.agent].skills.push(item);
  }

  const total = AGENTS.reduce(
    (n, a) =>
      n + byAgent[a].mcps.length + byAgent[a].skills.length + byAgent[a].plugins.length + byAgent[a].hooks.length,
    0,
  );
  if (total === 0) {
    data.notes.push(strings.noConfigFound);
  }
  return data;
}
