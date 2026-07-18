# Agent Workspace — VS Code 扩展实现方案

> 日期：2026-07-18 ｜ 状态：已评审，进入实现

## 1. 背景与目标

VS Code 的 workspace 只能展示当前连接（本机或单个远程）服务器的文件，无法跨服务器聚合视图。本扩展在左侧活动栏提供一个统一的 "Agent Workspace" 视图：

```
- 当前连接 server / 本地 workspace        ← 显示文件 + agent sessions
- - folderA
- - - <文件树…>
- - - sessions
- - - - sessionA  [codex]  标题…
- 远程 server1                            ← 只显示 sessions
- - server1_folderA
- - - sessionB  [opencode]  标题…
```

- 聚合 **opencode / Codex CLI / Claude Code** 三类 agent 的历史会话（跨 SSH 服务器）。
- 只有"当前连接"的服务器展开文件树（复用 `vscode.workspace.fs`，成本可控）；其他服务器仅列会话。
- 右键远程服务器 → "Connect"，当前窗口切换到该服务器（Remote-SSH），视图模式随之切换。
- 活动栏第二个视图提供 skills / plugins / MCPs / hooks 的统一管理面板。

## 2. 调研结论（决定架构的关键事实）

### 2.1 官方相关实现

| 名称 | 状态 | 结论 |
|---|---|---|
| VS Code "Agents window" | 仅 Insiders 预览，独立窗口，只支持 Copilot CLI / Copilot Cloud / Claude agent，不支持远程第三方 CLI | 不能依赖，自建等价树 |
| `chatSessions` 贡献点 API | **仍是 proposed API**，marketplace 扩展不可发布使用（2025-2026 持续变动中） | 自建 `TreeDataProvider` |
| opencode 官方 VS Code 扩展 (`sst-dev.opencode`) | 开源，仅终端拉起 + `@file` 注入，无会话树 | 参考其轻量命令模式 |
| `a710128/opencode-vscode-ui` | opencode 会话侧边栏（需本机 opencode CLI + `opencode serve`） | 最接近的先例，但依赖 daemon，我们不走此路 |
| `felix-lj-ct/opencode-history` | 直接只读查询 `opencode.db`（better-sqlite3），兼容新旧 schema | 借鉴其 schema 探测模式 |
| `ShahadIshraq/claude-session-vs-code-extension` | Claude 会话发现/解析/终端 resume 完整管线 | 借鉴 title 回退链与终端 resume 方式 |

### 2.2 三个 agent 的会话存储与 resume（v1 目标格式）

| Agent | 会话存储（远程服务器上） | 标题来源 | resume 命令（cwd 限定） |
|---|---|---|---|
| **opencode** ≥v1.18 | SQLite：`~/.local/share/opencode/opencode.db`，表 `session(id,title,directory,time_created,time_updated,time_archived,parent_id)`、`message(session_id,data JSON)`、`part(message_id,data JSON)` | `session.title` | `cd <directory> && opencode --session <id>`（注意 `--continue` 会覆盖 `--session`，不要同传） |
| opencode 旧版（回退） | `storage/session/<projectID>/<id>.json` 及更老的 `project/<slug>/storage/session/info/ses_*.json` | json `title` | 同上 |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`，首行 SessionMeta（`id,timestamp,cwd,source,…`）；标题另在 `~/.codex/session_index.jsonl`（`thread_name`，append-only 最新为准） | session_index.thread_name → 首条 user message → `codex:<id前8位>` | `cd <cwd> && codex resume <id>`（id 查找默认限定 cwd，先 cd） |
| **Claude Code** | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`（跳过 `subagents/` 与 `agent-*.jsonl`） | 最新 `custom-title` → `agent-name` → 首条 user prompt → `Session <id前8位>` | `cd <cwd> && claude --resume <sessionId>` |

### 2.3 管理面（settings 面板数据源）

| | opencode | Codex | Claude Code |
|---|---|---|---|
| MCP | `~/.config/opencode/opencode.json` → `mcp` | `~/.codex/config.toml` → `[mcp_servers.*]` | `~/.claude.json` → `mcpServers`；项目 `.mcp.json` |
| Skills | `~/.config/opencode/skills/*/SKILL.md`（亦读 `~/.claude/skills`、`~/.agents/skills`） | 无（slash commands） | `~/.claude/skills/*/SKILL.md` |
| Plugins | `~/.config/opencode/plugins/*.{js,ts}` + `opencode.json` 的 `plugin[]` | `config.toml` `[plugins.*]` + `~/.codex/plugins/` | `~/.claude/settings.json` → `enabledPlugins` |
| Hooks | 仅经插件实现（面板中说明） | `~/.codex/hooks.json` / `config.toml [hooks]` | `~/.claude/settings.json` → `hooks`（29+ 事件） |

### 2.4 VS Code 侧 API 决策

- **视图**：自建活动栏容器 `agentWorkspace`（不注入内置 Explorer：内置 Explorer 的标题/拖拽/内置动作会干扰；官方 TreeView 指南推荐自有 container）。
- **连接远程服务器**：`vscode.commands.executeCommand('vscode.openFolder', vscode-remote://ssh-remote+[user@]host[:port][/path], { forceNewWindow: false })`。`opensshremotes.*` 命令存在但微软明确声明不保证兼容，不用。前置检查 `ms-vscode-remote.remote-ssh` 是否安装。
- **当前窗口远程识别**：`vscode.env.remoteName`（`ssh-remote`/`wsl`/`dev-container`/undefined）+ `workspaceFolders[0].uri.authority`（`ssh-remote+host`）→ 与配置的服务器按 host 匹配。
- **SSH 传输**：系统 `ssh` + `child_process.spawn`，`-o BatchMode=yes -o ConnectTimeout=8 -T`。不用 `ssh2` npm 库（不吃 `~/.ssh/config`、不吃 ControlMaster、无 agent 转发）。设置面板/会话读取全部走一次 SSH 调用聚合返回。
- **Settings 面板**：`WebviewView`（贡献时必须 `"type": "webview"`，`enableScripts: true`），vanilla HTML + postMessage。

## 3. 总体架构

```
src/
├── extension.ts            # 激活：注册 tree provider、settings webview、全部命令
├── model.ts                # AgentKind / AgentSession / ServerConfig / 树节点类型
├── config.ts               # 读写 agentWorkspace.servers 配置；当前窗口服务器识别
├── ssh/
│   └── remoteExec.ts       # execRemote(server, bashScript) → stdout；execLocal()
├── agents/
│   ├── discoveryScript.ts  # 生成"一次 SSH 调用"的远程发现脚本（三 agent 全扫）
│   ├── parse.ts            # 解析脚本分段输出 → AgentSession[]
│   ├── transcript.ts       # 拉取并解析单个会话全文（jsonl / sqlite 消息）→ ChatMessage[]
│   └── resume.ts           # 生成各 agent 的 resume 命令行
├── tree/
│   └── workspaceProvider.ts# TreeDataProvider：服务器→目录→(文件|sessions)
├── views/
│   ├── sessionPanel.ts     # 会话全文 webview 面板
│   └── settingsView.ts     # 活动栏 settings WebviewView（MCP/Skills/Plugins/Hooks）
└── commands.ts             # connect/addServer/removeServer/refresh/openSession/resume/openSettings
```

**运行位置**：Remote-SSH 窗口中扩展宿主运行在远程 → "当前服务器"一律用 node `fs` 直读（天然就是当前服务器的文件系统）；"其他服务器"走 SSH。**注意**：窗口连在 A 时浏览 B 的会话，SSH 从 A 发起，A 上需有到 B 的密钥。

## 4. 远程发现脚本（核心设计）

一次 SSH 调用完成整台服务器扫描，stdout 分段返回，本地解析：

```
===AGENTWS:meta===        {"sqlite3":1,"python3":1}
===AGENTWS:opencode===    sqlite3 -json（无则 python3 -c sqlite3）查 session 表
                          都无则回退 find storage/session + project/*/storage/session/info 的 json 并 cat
===AGENTWS:codex===
                          cat session_index.jsonl；find sessions/ 下 rollout-*.jsonl（按 mtime 取最近 100 个）
                          每个文件输出 ===AGENTWS:file:<path>=== 后接 head -c 3000（首行 meta + 前几条 user 消息）
===AGENTWS:claude===
                          find ~/.claude/projects -name '*.jsonl'（排除 subagents/agent-*，最近 100 个）
                          每个文件输出 head -c 4000（首行 summary + 首条 user prompt）
                          + tail -c 20000 中 grep custom-title / agent-name 的最后一行
```

- 每 agent 上限 100 会话，按 mtime 倒序，足够覆盖"最近活跃"。
- 远程假定 GNU coreutils/findutils（Linux 服务器）；macOS 远程列为已知限制。
- 会话全文（打开查看时）才二次 SSH 拉取，列表阶段不拉全文 → 控制延迟。

## 5. 数据模型

```ts
type AgentKind = 'opencode' | 'codex' | 'claude';

interface ServerConfig {        // settings.json: agentWorkspace.servers
  name: string;                 // 显示名（树根节点）
  host: string;                 // ssh host（~/.ssh/config 别名或主机名）
  user?: string; port?: number;
}

interface AgentSession {
  agent: AgentKind;
  id: string;                   // opencode ses_* / codex uuid / claude sessionId
  title: string;
  cwd: string;                  // 归属目录（树中按此分组为"文件夹"）
  timeCreated: number; timeUpdated: number;
  sourcePath?: string;          // jsonl 路径（codex/claude）；opencode 为空
}

interface ChatMessage {         // transcript 渲染模型
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;                 // 已拼接的文本
  toolName?: string;            // 工具调用摘要
  timestamp?: number;
}
```

## 6. package.json 贡献点（定稿）

- `viewsContainers.activitybar`: `agentWorkspace`（图标 media/icon.svg）
- `views.agentWorkspace`:
  - `agentWorkspace.workspace`（TreeView："Workspace"）
  - `agentWorkspace.settings`（`"type": "webview"`："Agent Settings"）
- `configuration`: `agentWorkspace.servers`（array）、`agentWorkspace.sessionLimit`（默认 100）、`agentWorkspace.connectInNewWindow`（默认 false）
- `commands` / `menus.view/item/context`（按 `contextValue` 分发）：

| 节点 contextValue | 右键菜单 |
|---|---|
| `server.current` / `server.remote` | Connect（remote 时）、Remove Server、Refresh Sessions |
| `folder` | （current）Open Folder |
| `session` | Open Transcript、Resume in Terminal、Copy Session ID |
| `file` / 文件节点 | （current）Open |

`view/title`: Refresh、Add Server。

## 7. 里程碑（本次实现范围 = v1）

1. **M1 基础**：model/config/remoteExec，tsc 通过。
2. **M2 会话发现**：discoveryScript + parse，**用本机真实数据（~/.codex、~/.local/share/opencode）冒烟验证解析器**。
3. **M3 树视图**：三节点层级 + 当前服务器文件树 + 右键菜单。
4. **M4 会话操作**：transcript webview（user/assistant/tool 渲染）、resume 终端（本地直跑/远程 `ssh -t`）、connect 命令。
5. **M5 设置面板**：四 tab 列表 + "打开配置文件"动作（只读为主，编辑后续版本）。
6. **M6 验证**：tsc 零错误、解析器冒烟输出正确、git 分步提交。

**明确不做（v2 候选）**：跨服务器文件树（开销大）、`opencode serve` HTTP 通道（需远程 daemon + 端口转发）、会话内实时对话、settings 的就地编辑写回、chatSessions proposed API 接入、macOS 远程兼容、`.zst` 压缩 rollout 解压（遇到则跳过并标注）。

## 8. 风险与限制

| 风险 | 缓解 |
|---|---|
| 远程无 sqlite3/python3 且是新格式 opencode | 回退扫 legacy json；都没有则该 agent 显示不可用提示 |
| SSH 无密钥（BatchMode 失败） | 错误节点显示"SSH 连接失败"，提供"在终端中打开 ssh"动作手动认证 |
| Claude JSONL 格式闭源可能变动 | 解析容错（跳过不识别的行），title 多级回退 |
| 远程为 macOS（无 GNU find -printf） | 已知限制，文档标注；后续可改 `stat` 探测 |
| 扩展宿主在 A 服务器时浏览 B | README 说明 A→B 需本地 ssh 可用 |
