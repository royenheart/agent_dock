/**
 * 演示 fixture 生成器：为录屏（README GIF）在指定 HOME 下生成
 * 会话数据（opencode sqlite / codex rollout / claude transcript）与
 * agent skills/MCP 配置。内容全部为通用示例，不含任何真实/个人数据。
 *
 * 用法：node scripts/demo-fixtures.mjs <homeDir> <serverLabel> [workspaceDir]
 *   serverLabel: 'local' | 'a' | 'b'（决定会话标题/目录，演示多服务器差异）
 *   workspaceDir: 本地窗口的 workspace 路径（local 时会话 cwd 放其下）
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const [, , home, label, workspaceDir] = process.argv;
if (!home || !label) {
  console.error('usage: node scripts/demo-fixtures.mjs <homeDir> <local|a|b> [workspaceDir]');
  process.exit(2);
}
fs.mkdirSync(home, { recursive: true });

// ---- 演示目录与 cwd ----
const projDir = label === 'local' ? (workspaceDir || '/tmp/agentdock-demo/nebula') : `/tmp/apps/app-${label}`;
fs.mkdirSync(projDir, { recursive: true });

const titles = {
  local: [
    { agent: 'opencode', title: '重构登录模块（opencode）', cwd: projDir, updated: 9200 },
    { agent: 'codex', title: '修复 CI 构建失败（codex）', cwd: projDir, updated: 9100 },
    { agent: 'claude', title: '设计 API 错误码规范（claude）', cwd: projDir, updated: 9000 },
  ],
  a: [
    { agent: 'opencode', title: 'API 响应性能优化（opencode）', cwd: projDir, updated: 9900, rich: true },
    { agent: 'codex', title: '实现用户鉴权中间件（codex）', cwd: projDir, updated: 9300 },
    { agent: 'claude', title: '数据库迁移回滚方案（claude）', cwd: projDir, updated: 9200 },
    // 非固定目录的会话 → 收进「其他目录会话」，演示聚合分组
    { agent: 'codex', title: '为 infra 仓库补全部署脚本（codex）', cwd: '/tmp/apps/infra', updated: 8000 },
  ],
  b: [
    { agent: 'claude', title: '前端组件库主题重构（claude）', cwd: projDir, updated: 9400 },
    { agent: 'opencode', title: '数据迁移脚本（opencode）', cwd: projDir, updated: 9300 },
  ],
}[label];

// 会话 id：按 label 区分前缀，保证同一 HOME 可同时存放 local 与远程服务器会话
const idBase = label === 'local' ? 'loc' : label;
const IDS = {
  opencode: [`ses_demo_${idBase}_1`, `ses_demo_${idBase}_2`],
  codex: [`11111111-2222-3333-4444-${idBase}0001`, `66666666-7777-8888-9999-${idBase}0002`],
  claude: [`aaaaaaaa-bbbb-cccc-dddd-${idBase}0001`, `ffffffff-0000-1111-2222-${idBase}0002`],
};

// ---- opencode sqlite ----
const ocDir = path.join(home, '.local', 'share', 'opencode');
fs.mkdirSync(ocDir, { recursive: true });
const dbPath = path.join(ocDir, 'opencode.db');
const ocSessions = titles.filter((t) => t.agent === 'opencode');

// 富文本会话（transcript 场景主角）：reasoning + bash/edit/skill 工具卡片 +
// patch 文件变更 + step tokens + markdown 正文 + todo 清单
const richParts = [
  {
    t: 10,
    data: {
      type: 'reasoning',
      text: '先定位瓶颈：常见点是 N+1 查询、缺失索引、响应体过大。先跑一遍 profile 看耗时分布，再决定优化方案。',
    },
  },
  {
    t: 11,
    data: {
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'npm run profile -- --route /api/list' },
        output:
          'route /api/list · 100 requests\n' +
          '┌─────────────┬────────┐\n' +
          '│ db.query    │ 1820ms │  ← 94%：逐条 owner 查询（N+1）\n' +
          '│ serialize   │   82ms │\n' +
          '│ network     │   38ms │\n' +
          '└─────────────┴────────┘\n' +
          'p95 = 2140ms',
      },
    },
  },
  {
    t: 12,
    data: {
      type: 'text',
      text:
        '## 分析结果\n\n瓶颈在 **N+1 查询**：列表页每条记录都单独查一次 owner。方案：\n\n' +
        '- 为 `list_items.owner_id` 加索引\n- 用 `JOIN` 预加载替代逐条查询\n\n```ts\nconst rows = await db.listItem.findMany({ include: { owner: true } });\n```',
    },
  },
  {
    t: 13,
    data: {
      type: 'tool',
      tool: 'edit',
      state: {
        status: 'completed',
        input: {
          filePath: '/tmp/apps/app-a/src/routes/list.ts',
          oldString: 'for (const r of rows) r.owner = await db.user.find(r.ownerId);',
          newString: 'const rows = await db.listItem.findMany({ include: { owner: true } });',
        },
        output: 'The file has been updated successfully.',
      },
    },
  },
  {
    t: 14,
    data: {
      type: 'patch',
      files: ['/tmp/apps/app-a/src/routes/list.ts', '/tmp/apps/app-a/prisma/migrations/0001_add_owner_index.sql'],
    },
  },
  {
    t: 15,
    data: {
      type: 'tool',
      tool: 'skill',
      state: {
        status: 'completed',
        input: { name: 'performance' },
        output: '性能优化检查清单：索引覆盖 / N+1 消除 / 分页上限 / 响应压缩（demo skill output）',
      },
    },
  },
  {
    t: 16,
    data: { type: 'step-finish', tokens: { input: 45210, output: 1832, cache: { read: 12033 } } },
  },
  {
    t: 17,
    data: {
      type: 'text',
      text:
        '已完成优化并补了回归测试：\n\n1. `list.ts` 改用 JOIN 预加载，消除 N+1\n2. 新增迁移 `0001_add_owner_index.sql`\n\n' +
        '本地基准：**p95 从 2.1s 降到 180ms**。建议上线后观察一天慢查询日志。',
    },
  },
];

const py = `
import sqlite3, json
db = ${JSON.stringify(dbPath)}
con = sqlite3.connect(db)
con.execute("CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT)")
con.execute("CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)")
con.execute("CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)")
con.execute("CREATE TABLE IF NOT EXISTS todo (session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER)")
${ocSessions
  .map((s, i) => {
    const id = IDS.opencode[i];
    if (s.rich) {
      return [
        `con.execute("INSERT OR REPLACE INTO session VALUES (?,?,?,?,?,NULL,NULL)", (${JSON.stringify(id)}, ${JSON.stringify(s.title)}, ${JSON.stringify(s.cwd)}, 1000, ${s.updated},))`,
        `con.execute("INSERT OR REPLACE INTO message VALUES (?,?,?,?)", ('m${id}', ${JSON.stringify(id)}, 1, '{"role":"user","time":{"created":1}}'))`,
        `con.execute("INSERT OR REPLACE INTO message VALUES (?,?,?,?)", ('m2${id}', ${JSON.stringify(id)}, 2, '{"role":"assistant","time":{"created":2}}'))`,
        `con.execute("INSERT OR REPLACE INTO part VALUES (?,?,?,?,?)", ('p1${id}','m${id}',${JSON.stringify(id)},1, ${JSON.stringify(JSON.stringify({ type: 'text', text: '列表接口响应超过 2s，帮忙优化一下。相关代码在 src/routes/list.ts' }))}))`,
        ...richParts.map(
          (p, j) =>
            `con.execute("INSERT OR REPLACE INTO part VALUES (?,?,?,?,?)", ('rp${j}${id}','m2${id}',${JSON.stringify(id)},${p.t}, ${JSON.stringify(JSON.stringify(p.data))}))`,
        ),
        `con.execute("INSERT OR REPLACE INTO todo VALUES (?,?,?,?,?)", (${JSON.stringify(id)},'定位性能瓶颈','completed','high',0))`,
        `con.execute("INSERT OR REPLACE INTO todo VALUES (?,?,?,?,?)", (${JSON.stringify(id)},'加索引 + JOIN 预加载','completed','high',1))`,
        `con.execute("INSERT OR REPLACE INTO todo VALUES (?,?,?,?,?)", (${JSON.stringify(id)},'补回归测试','in_progress','medium',2))`,
      ].join('\n');
    }
    return [
      `con.execute("INSERT OR REPLACE INTO session VALUES (?,?,?,?,?,NULL,NULL)", (${JSON.stringify(id)}, ${JSON.stringify(s.title)}, ${JSON.stringify(s.cwd)}, 1000, ${s.updated},))`,
      `con.execute("INSERT OR REPLACE INTO message VALUES (?,?,?,?)", ('m${id}', ${JSON.stringify(id)}, 1, '{"role":"user","time":{"created":1}}'))`,
      `con.execute("INSERT OR REPLACE INTO message VALUES (?,?,?,?)", ('m2${id}', ${JSON.stringify(id)}, 2, '{"role":"assistant","time":{"created":2}}'))`,
      `con.execute("INSERT OR REPLACE INTO part VALUES (?,?,?,?,?)", ('p1${id}','m${id}',${JSON.stringify(id)},1, ${JSON.stringify(JSON.stringify({ type: 'text', text: `用户问题：${s.title.split('（')[0]}` }))}))`,
      `con.execute("INSERT OR REPLACE INTO part VALUES (?,?,?,?,?)", ('p2${id}','m2${id}',${JSON.stringify(id)},2, ${JSON.stringify(JSON.stringify({ type: 'text', text: '示例回复：已按方案完成实现并补充了单元测试。' }))}))`,
      `con.execute("INSERT OR REPLACE INTO part VALUES (?,?,?,?,?)", ('p3${id}','m2${id}',${JSON.stringify(id)},3, ${JSON.stringify(JSON.stringify({ type: 'tool', tool: 'skill', state: { status: 'completed', input: { name: 'frontend' }, output: 'demo skill output' } }))}))`,
      `con.execute("INSERT OR REPLACE INTO todo VALUES (?,?,?,?,?)", (${JSON.stringify(id)},'示例待办项','in_progress','high',0))`,
    ].join('\n');
  })
  .join('\n')}
con.commit()
con.close()
`;
execFileSync('python3', ['-c', py]);

// ---- codex rollout ----
const codexSessions = titles.filter((t) => t.agent === 'codex');
codexSessions.forEach((s, i) => {
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '07', '20');
  fs.mkdirSync(codexDir, { recursive: true });
  const rollout = [
    JSON.stringify({ timestamp: '2026-07-20T02:00:00.000Z', id: IDS.codex[i], cwd: s.cwd, originator: 'codex_cli', cli_version: '0.0.0', source: 'cli' }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: s.title }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '示例回复：已完成。' }] } }),
  ].join('\n');
  fs.writeFileSync(path.join(codexDir, `rollout-2026-07-20T10-00-00-${IDS.codex[i]}.jsonl`), rollout + '\n');
});

// ---- claude transcript ----
const claudeSessions = titles.filter((t) => t.agent === 'claude');
claudeSessions.forEach((s, i) => {
  const claudeDir = path.join(home, '.claude', 'projects', s.cwd.replace(/[^\w-]/g, '-'));
  fs.mkdirSync(claudeDir, { recursive: true });
  const transcript = [
    JSON.stringify({ type: 'summary', summary: s.title, cwd: s.cwd }),
    JSON.stringify({ type: 'user', cwd: s.cwd, message: { content: [{ type: 'text', text: s.title }] } }),
    JSON.stringify({ type: 'assistant', cwd: s.cwd, message: { content: [{ type: 'text', text: '示例回复：已给出方案。' }] } }),
  ].join('\n');
  fs.writeFileSync(path.join(claudeDir, `${IDS.claude[i]}.jsonl`), transcript + '\n');
});

// ---- skills / MCP 配置（settings 视图展示，仅 local home 生效）----
if (label === 'local') {
  const skills = [
    { name: 'web-dev', desc: '前端开发辅助（demo）', dir: '.claude/skills' },
    { name: 'data-analysis', desc: '数据分析（demo）', dir: '.agents/skills' },
    { name: 'performance', desc: '性能分析与优化清单（demo）', dir: '.claude/skills' },
  ];
  for (const sk of skills) {
    const dir = path.join(home, sk.dir, sk.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${sk.name}\ndescription: ${sk.desc}\n---\n${sk.name} 的演示说明。\n`,
    );
  }
  const ocCfgDir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(ocCfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(ocCfgDir, 'opencode.json'),
    JSON.stringify({ mcp: { fs: { type: 'local', command: ['npx', 'fs-mcp-demo'] } }, plugin: ['demo-plugin@1'] }, null, 2),
  );
  // 项目级 skill（settings 视图会区分用户级/项目级）
  if (workspaceDir) {
    const projSkill = path.join(workspaceDir, '.claude', 'skills', 'release-checklist');
    fs.mkdirSync(projSkill, { recursive: true });
    fs.writeFileSync(
      path.join(projSkill, 'SKILL.md'),
      '---\nname: release-checklist\ndescription: 发版前检查清单（demo，项目级）\n---\n项目级演示 skill。\n',
    );
  }
}

// ---- 演示项目文件 ----
const write = (rel, content) => {
  const p = path.join(projDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
if (label === 'a') {
  write('app.py', '# app-a 服务示例\ndef main():\n    print("hello from server a")\n');
  write('README.md', '# app-a\n示例后端服务（demo sandbox）。\n');
  write('requirements.txt', 'fastapi==0.115.0\nuvicorn==0.30.6\n');
  write('src/__init__.py', '');
  write('src/api.py', 'from fastapi import FastAPI\n\napp = FastAPI()\n');
  write('src/cache.py', 'CACHE_TTL = 60\n');
  write('src/util.js', '// util for server a\nmodule.exports = { ping: () => "pong" };\n');
  write('tests/test_app.py', 'def test_ping():\n    assert True\n');
  write('scripts/deploy.sh', '#!/bin/sh\necho deploy app-a\n');
} else if (label === 'b') {
  write('app.py', '# app-b 服务示例\ndef main():\n    print("hello from server b")\n');
  write('package.json', JSON.stringify({ name: 'app-b', private: true, version: '0.1.0' }, null, 2) + '\n');
  write('src/util.js', '// util for server b\nmodule.exports = { ping: () => "pong" };\n');
  write('web/index.html', '<!doctype html><title>app-b</title><h1>app-b</h1>\n');
} else {
  write('README.md', '# nebula\n本地工作区示例（demo sandbox）。\n');
  write('package.json', JSON.stringify({ name: 'nebula', private: true, version: '0.1.0' }, null, 2) + '\n');
  write('src/main.ts', 'export const main = () => console.log("nebula");\n');
}

console.log(`demo fixtures ready for label=${label} home=${home} proj=${projDir}`);
