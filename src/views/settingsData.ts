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

export interface SettingsData {
  serverLabel: string;
  mcps: SettingsItem[];
  skills: SettingsItem[];
  plugins: SettingsItem[];
  hooks: SettingsItem[];
  notes: string[];
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

async function gatherSkills(home: string): Promise<SettingsItem[]> {
  const roots: { dir: string; agent: AgentKind }[] = [
    { dir: path.join(home, '.claude', 'skills'), agent: 'claude' },
    { dir: path.join(home, '.codex', 'skills'), agent: 'codex' },
    { dir: path.join(home, '.config', 'opencode', 'skills'), agent: 'opencode' },
    { dir: path.join(home, '.config', 'opencode', 'skill'), agent: 'opencode' },
    { dir: path.join(home, '.agents', 'skills'), agent: 'claude' },
  ];
  const seen = new Set<string>();
  const out: SettingsItem[] = [];
  for (const { dir, agent } of roots) {
    for (const name of await listDirs(dir)) {
      if (seen.has(`${agent}:${name}`)) {
        continue;
      }
      const skillMd = path.join(dir, name, 'SKILL.md');
      let detail: string | undefined;
      try {
        const raw = await fs.readFile(skillMd, 'utf8');
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
        if (fm) {
          const desc = /^description:\s*(.+)$/m.exec(fm[1]);
          detail = desc?.[1]?.trim().slice(0, 120);
        }
        seen.add(`${agent}:${name}`);
        out.push({ name, detail, agent, sourcePath: skillMd });
      } catch {
        // 无 SKILL.md —— 不是 skill 目录
      }
    }
  }
  return out;
}

export async function gatherSettings(serverLabel: string): Promise<SettingsData> {
  const home = os.homedir();
  const data: SettingsData = { serverLabel, mcps: [], skills: [], plugins: [], hooks: [], notes: [] };

  const claudeJson = await readJson(path.join(home, '.claude.json'));
  const claudeMcp = (claudeJson?.mcpServers ?? {}) as Record<string, unknown>;
  for (const [name, cfg] of Object.entries(claudeMcp)) {
    const c = cfg as Record<string, unknown>;
    data.mcps.push({
      name,
      detail: brief(c.command) ?? brief(c.url) ?? brief(c.type),
      agent: 'claude',
      sourcePath: path.join(home, '.claude.json'),
    });
  }
  const claudeSettings = await readJson(path.join(home, '.claude', 'settings.json'));
  const enabledPlugins = (claudeSettings?.enabledPlugins ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(enabledPlugins)) {
    if (enabledPlugins[name]) {
      data.plugins.push({ name, agent: 'claude', sourcePath: path.join(home, '.claude', 'settings.json') });
    }
  }
  const claudeHooks = (claudeSettings?.hooks ?? {}) as Record<string, unknown>;
  for (const [event, handlers] of Object.entries(claudeHooks)) {
    const count = Array.isArray(handlers) ? handlers.length : 1;
    data.hooks.push({
      name: event,
      detail: `${count} 个处理器`,
      agent: 'claude',
      sourcePath: path.join(home, '.claude', 'settings.json'),
    });
  }

  const codexTomlPath = path.join(home, '.codex', 'config.toml');
  let codexToml = '';
  try {
    codexToml = await fs.readFile(codexTomlPath, 'utf8');
  } catch {
    codexToml = '';
  }
  if (codexToml) {
    for (const s of parseTomlSections(codexToml, 'mcp_servers')) {
      data.mcps.push({ name: s.name, detail: tomlBodyDetail(s.body), agent: 'codex', sourcePath: codexTomlPath });
    }
    for (const s of parseTomlSections(codexToml, 'plugins')) {
      data.plugins.push({ name: s.name, detail: tomlBodyDetail(s.body), agent: 'codex', sourcePath: codexTomlPath });
    }
    if (/^\[hooks\]/m.test(codexToml)) {
      data.hooks.push({ name: 'config.toml [hooks]', agent: 'codex', sourcePath: codexTomlPath });
    }
  }
  const codexHooks = await readJson(path.join(home, '.codex', 'hooks.json'));
  if (codexHooks) {
    for (const name of Object.keys(codexHooks)) {
      data.hooks.push({ name, agent: 'codex', sourcePath: path.join(home, '.codex', 'hooks.json') });
    }
  }

  const ocConfigDir = path.join(home, '.config', 'opencode');
  const ocJson =
    (await readJson(path.join(ocConfigDir, 'opencode.json'))) ?? (await readJson(path.join(ocConfigDir, 'config.json')));
  const ocJsonPath = path.join(ocConfigDir, 'opencode.json');
  const ocMcp = (ocJson?.mcp ?? {}) as Record<string, unknown>;
  for (const [name, cfg] of Object.entries(ocMcp)) {
    const c = cfg as Record<string, unknown>;
    const cmd = Array.isArray(c.command) ? (c.command as unknown[]).join(' ') : brief(c.url);
    data.mcps.push({ name, detail: cmd ?? brief(c.type), agent: 'opencode', sourcePath: ocJsonPath });
  }
  const ocPluginList = Array.isArray(ocJson?.plugin) ? (ocJson.plugin as unknown[]) : [];
  for (const p of ocPluginList) {
    data.plugins.push({ name: String(p), detail: 'npm 包', agent: 'opencode', sourcePath: ocJsonPath });
  }
  const ocPluginFiles = await listFiles(path.join(ocConfigDir, 'plugins'), ['.js', '.ts']);
  for (const file of ocPluginFiles) {
    data.plugins.push({
      name: file,
      detail: '本地插件文件',
      agent: 'opencode',
      sourcePath: path.join(ocConfigDir, 'plugins', file),
    });
  }
  if (ocPluginList.length > 0 || ocPluginFiles.length > 0) {
    data.hooks.push({
      name: 'opencode hooks 由插件实现',
      detail: '无独立 hooks 配置文件，事件在插件中订阅',
      agent: 'opencode',
      sourcePath: ocConfigDir,
    });
  }

  data.skills = await gatherSkills(home);

  if (data.mcps.length + data.skills.length + data.plugins.length + data.hooks.length === 0) {
    data.notes.push('在当前服务器上未找到任何 agent 配置（MCP / Skills / Plugins / Hooks）');
  }
  return data;
}
