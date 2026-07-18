# Agent Workspace

跨服务器的 AI Agent 会话工作区：在 VS Code 左侧活动栏聚合展示多台服务器上的 **opencode / Codex CLI / Claude Code** 会话，当前连接的服务器同时展示文件树。

## 功能

- **统一 Workspace 树**（活动栏「Agent Workspace」）
  - 当前服务器（本机或 Remote-SSH 已连机器）：workspace 文件夹的文件树 + 各目录下的 agent 会话
  - 其他配置的远程服务器：按目录分组的会话列表（SSH 只读扫描，不传输文件树）
- **会话操作**：单击查看完整对话 transcript（webview）；右键在终端中 resume（`opencode --session` / `codex resume` / `claude --resume`）
- **连接切换**：右键远程服务器 → Connect，当前窗口切换连接到该服务器（基于 Remote-SSH）
- **Agent Settings**（活动栏第二个视图）：当前服务器的 MCPs / Skills / Plugins / Hooks 汇总，点击打开对应配置文件

## 使用

1. `npm install && npm run compile`
2. 在 VS Code 中按 `F5` 启动 Extension Development Host，或 `npx @vscode/vsce package` 打包安装
3. 树视图标题栏「+」添加远程服务器（name / host / user? / port?），保存于 `agentWorkspace.servers`

## 依赖

- 远程服务器需可通过 `ssh`（BatchMode，密钥认证）访问；建议安装 `python3`（最优扫描路径），否则回退 `sqlite3` CLI / 文件扫描
- Connect 功能需要 `ms-vscode-remote.remote-ssh` 扩展
- 远程假定为 Linux（GNU findutils）

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `agentWorkspace.servers` | `[]` | `[{ name, host, user?, port? }]` |
| `agentWorkspace.sessionLimit` | `100` | 每服务器每 agent 扫描会话上限 |
| `agentWorkspace.connectInNewWindow` | `false` | Connect 是否新窗口打开 |

实现方案与调研结论见 `docs/IMPLEMENTATION_PLAN.md`。
