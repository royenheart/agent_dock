# Agent Workspace

跨服务器的 AI Agent 会话工作区：在 VS Code 左侧活动栏聚合展示多台服务器上的 **opencode / Codex CLI / Claude Code** 会话，当前连接的服务器同时展示文件树。

## 功能

- **统一 Workspace 树**（活动栏「Agent Workspace」+ 内置「资源管理器」面板中均有入口，内容同步）
  - 当前服务器（本机或 Remote-SSH 已连机器）：workspace 文件夹的文件树 + `sessions` 子节点下的 agent 会话（目录 → sessions → 各会话）
  - 其他配置的远程服务器：按目录分组的会话列表（SSH 只读扫描，不传输文件树）
  - 内置资源管理器中，包含 agent 会话的目录会显示 **AI 徽标**（VS Code 不允许向内建文件树注入子节点，徽标是官方提供的唯一挂载点；会话本体在我们的树视图中）
- **会话操作**：单击查看完整对话 transcript（结构化渲染：markdown 正文、折叠 thinking、工具卡片含输入/输出、todo 清单、文件变更；顶部有刷新按钮）；右键在终端中 resume（`opencode --session` / `codex resume` / `claude --resume`）
- **连接切换**：右键远程服务器 → Connect，当前窗口切换连接到该服务器（基于 Remote-SSH）
- **添加目录**：「+」按钮分级选择——先列当前服务器的目录（选中直接加入 workspace），底部「连接至其他服务器…」→ ssh config 主机列表 → SSH 扫描该服务器的会话目录后选择保存（`agentWorkspace.servers[].folders` 持久化，树下固定展示）
- **Agent Settings**（活动栏第二个视图）：按 agent（Claude Code / Codex / opencode）分组展示当前服务器的 MCPs / Skills / Plugins / Hooks；skill 跨目录去重并标注其可见的全部 agent 与安装位置数，点击条目打开对应配置文件

## 使用

1. `npm install && npm run compile`
2. 在 VS Code 中按 `F5` 启动 Extension Development Host，或 `npx @vscode/vsce package` 打包安装
3. 树视图标题栏「+」添加远程服务器（自动列出 `~/.ssh/config` 主机），保存于 `agentWorkspace.servers`

> 更新扩展后需执行 `Developer: Reload Window` 重新加载窗口才会生效。

## 测试

- `npm run test:unit` — 纯逻辑单元测试（node:test，无需 VS Code）：路径匹配、会话解析、transcript 渲染、ssh config、settings 聚合
- `npm run test:e2e` — 端到端测试（`@vscode/test-electron` + xvfb）：在真实 VS Code 实例中验证树结构（目录镜像、文件与 sessions 并列、符号链接 cwd 匹配、AI 徽标、opencode sqlite transcript、ssh config 解析）
  - fixtures 由 `test/fixtures/makeFixtures.js` 生成（`/tmp/agentws-e2e`），工作区经符号链接打开以覆盖 realpath 场景
  - 注意：`test/e2e/code-under-test.sh` 直接调 electron 二进制——`/usr/bin/code` 包装脚本在 Remote-SSH 终端里会转发到已运行的 vscode-server，且 cli.js 会 detach 导致测试宿主被提前杀掉

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

## 版本管理与发布

**版本号唯一来源：`package.json` 的 `version` 字段**（vsce 与 CI 都以它为准）。

- `npm version patch|minor|major` —— bump + commit + 自动生成 `vX.Y.Z` tag
- 或 commitizen：`npx cz bump`（按 conventional commits 自动定级）

`git push --follow-tags` 后，tag 触发 `.github/workflows/release.yml`：编译 → 单测 → 打包 vsix → 创建 GitHub Release（附 vsix）→ 若仓库配置了 `VSCE_PAT` secret 则自动发布到 Marketplace。日常 push/PR 走 `ci.yml`（含真实 VS Code 的 e2e）。

### 手动发布到 VS Code Marketplace

1. 注册 [Azure DevOps](https://dev.azure.com) 账号 → Personal Access Tokens → 新建（scope: **Marketplace → Manage**）
2. `npm i -g @vscode/vsce`
3. 创建发布者：`vsce create-publisher royenheart`（须与 `package.json` 的 `publisher` 一致）
4. 登录：`vsce login royenheart`（粘贴 PAT）
5. 发布：`vsce publish`（或 `vsce publish patch` 一步 bump+发布）

发布前检查项（已具备）：`publisher`、`license`、`README.md`、`LICENSE`；建议在 `package.json` 补上 `repository` 字段（推送 GitHub 后填入实际地址）。CI 自动发布只需把 PAT 存为仓库 secret `VSCE_PAT`。

> 备选渠道：[Open VSX](https://open-vsx.org)（VSCodium/Cursor 用户的插件市场），用 `npx ovsx publish` 发布同一 vsix。
