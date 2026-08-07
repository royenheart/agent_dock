# AGENTS.md

本扩展的历史回退大多源于下面几行被改坏。改代码前先读，改完跑 `npm test`（106 项单测）。

## 隐私红线（最高优先级，违反即回退）

- **严禁把任何个人/私密信息写进仓库并提交**：真实服务器地址（IP/域名）、SSH 用户名、端口、私钥路径、密码、token、API key 等，一律禁止出现在源码、测试、文档、配置、commit message 里
- e2e 测试的"其他服务器"目标**必须是本地沙箱**：本地 sshd、容器（docker 起 sshd）、或 PATH 注入的 fake ssh——禁止连接任何个人真实服务器；测试连接参数一律走环境变量（见 `test/e2e-provider.js` / `test/e2e-poll.js` 头部的 `AGENTDOCK_E2E_*`）
- 提交前自查：`grep -rniE '你的服务器地址|用户名|私钥' test/ src/ docs/` 之类的敏感词扫描；拿不准就先问
- 若发现历史中有私密信息：用 git-filter-repo 重写历史（`--invert-paths` / `--replace-text`）+ 强制推送 + **立即轮换相关凭据**（公网可见过的私钥视同已泄露），并同步清理 GitHub 侧缓存/请求支持删除

## 打包（改 .vscodeignore / package.json 必读）

- 绝不把 `node_modules/**` 加回 `.vscodeignore`——vsix 必须带 node-pty 预编译二进制，否则客户端终端失去真 pty，Ctrl+C 失效（0.1.9/0.1.10 因此回退）
- 打 vsix 后用 `unzip -l *.vsix | grep node-pty` 确认二进制在包内
- **dependencies 只允许 node-pty 和 ssh2**（均为运行时必需：node-pty 提供真 pty；ssh2 提供持久 SSH 连接 + SFTP，纯 JS 体积小）：dompurify/marked 的 npm 包源码不用（webview 走 media/vendor 的 UMD），必须放 devDependencies，否则 vsce 把它们打进 vsix 白白膨胀 20+MB
- `@types/*` 永远只在 devDependencies，vsce 不会打包

## SSH 传输层（src/ssh/sshSession.ts + remoteExec.ts）

- **默认且必须保持 persistent 传输**：每台服务器一条长连接（ssh2），文件操作走 SFTP 子系统、脚本走 exec 通道——禁止退回"每次操作 spawn 一个 ssh 进程"（Windows 无 ControlMaster 时尤其慢）
- 认证只走 ssh-agent（SSH_AUTH_SOCK）或 ~/.ssh/config 的 IdentityFile/默认私钥，BatchMode 语义不弹密码
- 主机密钥默认按 ~/.ssh/known_hosts 严格校验（`agentDock.sshHostKeyMode`），实现见 `knownHosts.ts`（支持哈希条目 `|1|salt|hash`）
- execRemote/execRemoteBuffer 持久路径失败会自动降级 spawn（可用性兜底），但这是异常路径不是常态
- 连接失败有指数退避（1s→30s），防止轮询对不可达服务器反复发起 10s 超时连接
- 会话池（sessionFor）在 extension.ts deactivate 时 `disposeSshSessions()` 释放

## 客户端终端（src/ssh/clientTerminal.ts）

- 管道降级路径（无 node-pty）里 Ctrl+C（`\x03`）必须转发：pty 包装子进程写 stdin，纯管道 shell 发 SIGINT——禁止静默吞掉只回显 `^C`
- 客户端终端必须持久化到 workspaceState 并在 activate 重建——VSCode 不会自动恢复扩展终端的 pty（官方 #199）
- **窗口 reload 时 VSCode 会以 Shutdown reason 销毁所有扩展 pty 终端并派发 `onDidCloseTerminal`**——`untrackClientTerminal` 若照常删记录并落盘，保存的描述就被抹掉，reload 后无终端可重建。必须保留 `markClientTerminalsShuttingDown`（deactivate 调用）+ untrack 落盘防抖这套防护，删掉 = 终端恢复回退
- node-pty 的 Windows 实现不自动补 `.exe`：spawn 的 `file` 在 win32 必须传 `ssh.exe`（不是 `ssh`），否则 "File not found: "（空路径）且终端永远退回管道模式
- 用户 rename 终端后必须同步名字：`syncTrackedTerminalName` 挂在 `onDidChangeTerminalState`，否则 reload 后还原成创建时名字；删掉它 = 名字回退
- 原生终端（`fsOpenTerminal` 的 `createTerminal({cwd})`）由 VSCode persistent sessions 恢复终端本身，需显式传 `name`（按 cwd 目录名）。但**名字恢复靠 `nativeTerminal.ts` 自己跟踪**（persist `{creationName, cwd, name}` + `onDidChangeTerminalState` 同步 rename）：VSCode 只在 reload 重连时恢复用户 rename 的标题，完全重启走 process revive 名字回落创建名，且没有公开 rename API（只有内部命令 `renameWithArg`，作用于活跃终端）——按 `creationOptions` 的 name+cwd 匹配并回放保存的名字（activate 全量扫一轮 + `onDidOpenTerminal` 补迟到终端，二者缺一不可）；删掉这套 = 重启后名字回退

## 激活与恢复（package.json + extension.ts 必须同步）

- 绝不把 `activationEvents` 改回 `[]`：必须保留 `onStartupFinished`，否则 reload 后客户端终端/端口转发只有打开 Agent Workspace 视图才恢复
- 客户端终端（`initClientTerminalPersistence`）和端口转发（`initForwardStore` + `restoreActiveForwards`）的恢复都依赖 activate 在窗口启动时执行，且 `restoreActiveForwards` 必须在 `registerCommands` 之后调用

## 视图容器（package.json + extension.ts 必须同步）

- 只有一个 TreeView：`agentDock.workspace`（Agent Dock 活动栏）——**不要**再往 `explorer` 容器加 `agentDock.workspaceExplorer` 之类的冗余视图（两个视图状态不同步，用户明确要求取消）
- `agentDock.settings` 是 webview 视图，保留在 agentDock 容器

## 树展开状态（workspaceProvider.ts + expansionState.ts）

- 每个节点必须设置 `item.id = nodeId(node)`（稳定、与内容绑定）——否则 VSCode 按 label 生成 id（handle 还带父节点 prefix），label 一变或 reload 后展开状态就丢
- `getParent` 必须实现（`nodeParent`）——reveal 恢复展开状态的前提；改节点类型/字段要同步 `nodeId`/`nodeParent`/`nodeFromId`，并跑 `nodeId.test.js`
- **VSCode 不自动持久化扩展 TreeView 的展开状态**（官方讨论 #1071）——必须由 `ExpansionState` 自行记录（onDidExpand/onDidCollapse）并在 reload/刷新后 `treeView.reveal(node, {expand:true})` 重放；删掉这套逻辑 = 展开状态回退
- `nodeFromId` 的 case 前缀必须与 `nodeId` 的**输出前缀完全一致**（如 `fs:` / `remoteFs:`，不是 `fsEntry`/`remoteFsEntry`）——不一致则 reveal 恢复静默失败
- **当前服务器的 server 节点 key 必须恒为 `CURRENT_SERVER_KEY`**（rootNodes 里即使有匹配配置也统一用它）——folder/otherSessions/portsRoot 的 serverKey 都是它，nodeParent 推导的父 server id 才能与树中实际节点一致；改回 `current.name` 会导致当前服务器目录展开状态无法恢复
- 展开状态异常时看 `[tree]` 日志：`getParent <kind> id=... -> parent id=...`（debug）与 `reveal <id> failed`——核对 id 是否跨 reload 一致

## 端口转发（src/ssh/portForward.ts）

- Windows（Win32-OpenSSH）不支持 ControlMaster，`-O forward`/`-O cancel` 必然失败——win32 直接走独立 `ssh -N` 进程，不要尝试 `-O`，否则每次启动都打失败日志
- 活跃转发必须持久化到 workspaceState（`persistActiveForwards` 在 start/stop/进程退出时调用），reload 后由 `restoreActiveForwards` 自动重启——否则转发随窗口关闭

## 右键菜单（package.json + getTreeItem 必须同步）

- 远程 fs 节点（`remoteFsFile`/`remoteFsDir`）菜单必须保留完整操作集：新建文件/文件夹、重命名、删除、复制、粘贴、复制路径、打开终端、刷新——删成只剩"刷新"就是回退
- 本地 fs 节点（`fsFile`/`fsDir`）同样保留：打开、新建、重命名、删除、复制、粘贴、复制路径、复制相对路径、在文件管理器中显示、打开终端
- `folder.remote`/`folder.workspace` 必须保留"刷新目录"
- 菜单 `when` 里的 `viewItem` 必须与 `getTreeItem` 的 `contextValue` 完全一致，改任一侧要同步另一侧

## 轮询与日志

- 远程目录/文件轮询的 ssh 调用必须 `quiet`，视图不可见/目录折叠时暂停，否则控制台被 `[DEBUG] [ssh]` 刷屏
- 远程路径拼接一律用 `shq()` 引用
