# AGENTS.md

本扩展的历史回退大多源于下面几行被改坏。改代码前先读，改完跑 `npm test`（106 项单测）。

## 隐私红线（最高优先级，违反即回退）

- **严禁把任何个人/私密信息写进仓库并提交**：真实服务器地址（IP/域名）、SSH 用户名、端口、私钥路径、密码、token、API key 等，一律禁止出现在源码、测试、文档、配置、commit message 里
- e2e 测试的"其他服务器"目标**必须是本地沙箱**：本地 sshd、容器（docker 起 sshd）、或 PATH 注入的 fake ssh——禁止连接任何个人真实服务器；测试连接参数一律走环境变量（见 `test/e2e-provider.js` / `test/e2e-poll.js` 头部的 `AGENTDOCK_E2E_*`）
- 提交前自查：`grep -rniE '你的服务器地址|用户名|私钥' test/ src/ docs/` 之类的敏感词扫描；拿不准就先问
- 若发现历史中有私密信息：用 git-filter-repo 重写历史（`--invert-paths` / `--replace-text`）+ 强制推送 + **立即轮换相关凭据**（公网可见过的私钥视同已泄露），并同步清理 GitHub 侧缓存/请求支持删除

## 发版流程（commitizen，违反即卡死发版）

- 固定流程：写好功能 → 提交**一次**功能 commit → 由维护者手动跑 `cz bump --increment …` 生成 bump commit + tag，然后 `git push --follow-tags`
- **禁止在功能 commit 里预写未发版的 CHANGELOG 段落或手改版本号**——a61dec3 把提前生成的 `## v0.2.4` 段提交进 CHANGELOG.md，cz 增量 changelog 拿顶部版本去模糊匹配 git tag（相似度阈值 0.89）匹配不到，报 "No tag found to do an incremental changelog"，发版直接卡死
- `package.json` 的 `version`、`.cz.toml` 的 `version`、CHANGELOG.md 顶部版本段落，只允许 `cz bump` 一处产出；手动改任何一处都属回退

## 打包（改 .vscodeignore / package.json / scripts/ 必读）

- 绝不把 `node_modules/**` 加回 `.vscodeignore`——vsix 必须带 node-pty 预编译二进制，否则客户端终端失去真 pty，Ctrl+C 失效（0.1.9/0.1.10 因此回退）
- 打 vsix 后用 `unzip -l *.vsix | grep node-pty` 确认二进制在包内
- **编译打包统一入口**：本地与 GitHub CI/CD 都跑 `npm run package`（scripts/package.mjs：tsc → esbuild bundle → vsce → 产物验证）；运行时加载 `dist/extension.js`（esbuild 单文件 bundle，package.json main 指向它），`out/` 仅供 e2e 测试 require——**改打包方式只改 scripts/ + package.json + .vscodeignore，CI（.github/workflows/*.yml）只引用 `npm run build` / `npm run package`，禁止在 CI 里另写一套打包命令**
- **dependencies 只允许 node-pty**（原生模块无法 bundle，必须留在 node_modules 进 vsix）；**ssh2 在 devDependencies**（被 esbuild 打进 dist bundle，运行时不再需要 node_modules/ssh2）；dompurify/marked 的 npm 包源码不用（webview 走 media/vendor 的 UMD），必须放 devDependencies，否则 vsce 把它们打进 vsix 白白膨胀 20+MB
- vsix 裁剪约束：.vscodeignore 必须排除 node-pty 的 `*.pdb`（~20MB 调试符号）、`third_party`/`src`/`scripts`/`typings`/`node_modules`（编译期/源码）、`out/**`；**正常 vsix 应在 ~2MB 量级**——打包后若明显变大（>3MB），检查是否有新依赖/文件回退进包
- `@types/*` 永远只在 devDependencies，vsce 不会打包
- **涉及编译/打包/依赖/CI 的改动，必须同时审视 `.github/workflows/` 是否要同步**（CI 引用 npm scripts，一般改 scripts/ 即可自动同步，但要确认 yml 没有硬编码旧命令）；改 esbuild 入口/依赖布局后必须本地 `npm run package` 跑通并看产物验证输出

## SSH 传输层（src/ssh/sshSession.ts + remoteExec.ts）

- **默认且必须保持 persistent 传输**：每台服务器一条长连接（ssh2），文件操作走 SFTP 子系统、脚本走 exec 通道——禁止退回"每次操作 spawn 一个 ssh 进程"（Windows 无 ControlMaster 时尤其慢）
- 认证只走 ssh-agent（SSH_AUTH_SOCK）或 ~/.ssh/config 的 IdentityFile/默认私钥，BatchMode 语义不弹密码
- 主机密钥默认按 ~/.ssh/known_hosts 严格校验（`agentDock.sshHostKeyMode`），实现见 `knownHosts.ts`（支持哈希条目 `|1|salt|hash`）
- execRemote/execRemoteBuffer 持久路径失败会自动降级 spawn（可用性兜底），但这是异常路径不是常态
- 连接失败有指数退避（1s→30s），防止轮询对不可达服务器反复发起 10s 超时连接
- 会话池（sessionFor）在 extension.ts deactivate 时 `disposeSshSessions()` 释放

## 远程文件可写（remoteFsProvider.ts + extension.ts 必须同步）

- **其他服务器文件必须可写**：`RemoteFsProvider.stat()` 不得返回 `FilePermission.Readonly`，`registerFileSystemProvider` 的 `isReadonly` 必须为 `false`——任一侧改回只读 = 编辑器/资源管理器全部只读，属回退
- 写路径走 SFTP：`writeFile`（临时文件 + rename 原子写）、`createDirectory`、`delete`（目录递归用 exec `rm -rf` 通道）、`rename`（目标存在时先删再 rename）
- `readFile` 保留 8 MiB 预览上限（防大文件进内存）；超限文件无法在编辑器打开属预期，不是只读
- tree 中 remoteFsEntry 的 tooltip 文案含 "editable"，与可写行为一致

## 客户端终端（src/ssh/clientTerminal.ts）

- 管道降级路径（无 node-pty）里 Ctrl+C（`\x03`）必须转发：pty 包装子进程写 stdin，纯管道 shell 发 SIGINT——禁止静默吞掉只回显 `^C`
- 客户端终端必须持久化到 workspaceState 并在 activate 重建——VSCode 不会自动恢复扩展终端的 pty（官方 #199）
- **窗口 reload 时 VSCode 会以 Shutdown reason 销毁所有扩展 pty 终端并派发 `onDidCloseTerminal`**——`untrackClientTerminal` 若照常删记录并落盘，保存的描述就被抹掉，reload 后无终端可重建。必须保留 `markClientTerminalsShuttingDown`（deactivate 调用）+ untrack 落盘防抖这套防护，删掉 = 终端恢复回退
- node-pty 的 Windows 实现不自动补 `.exe`：spawn 的 `file` 在 win32 必须传 `ssh.exe`（不是 `ssh`），否则 "File not found: "（空路径）且终端永远退回管道模式
- 用户 rename 终端后必须同步名字：`syncTrackedTerminalName` 挂在 `onDidChangeTerminalState`，否则 reload 后还原成创建时名字；删掉它 = 名字回退
- 原生终端（`fsOpenTerminal` 的 `createTerminal({cwd})`）由 VSCode persistent sessions 恢复终端本身，需显式传 `name`（按 cwd 目录名）。但**名字恢复靠 `nativeTerminal.ts` 自己跟踪**（persist `{creationName, cwd, name}` + `onDidChangeTerminalState` 同步 rename）：VSCode 只在 reload 重连时恢复用户 rename 的标题，完全重启走 process revive 名字回落创建名，且没有公开 rename API（只有内部命令 `renameWithArg`，作用于活跃终端）——按 `creationOptions` 的 name+cwd 匹配并回放保存的名字（activate 全量扫一轮 + `onDidOpenTerminal` 补迟到终端，二者缺一不可）；删掉这套 = 重启后名字回退
- **当前服务器节点的终端 cwd 必须走 `uriFsPath()`（src/paths.ts），严禁直接传 `vscode-remote` URI 的 `fsPath`**：Windows 客户端上 `vscode-remote:` 的 `fsPath` 是反斜杠形态（`/mnt/xxx` → `\mnt\xxx`），`createTerminal({cwd})` 会把它原样交给 Linux pty host，终端报 "Starting directory ... does not exist"（`fsOpenTerminal`/`createSession` 当前服务器分支与 `nativeTerminal.ts` 持久化键必须用同一个 cwd 字符串；`uriFsPath` 对 `vscode-remote` 返回 POSIX `uri.path`、对 `file` 返回 `fsPath`）。回归单测见 `test/unit/structure.test.js` 的 uriFsPath backslash guard，改回 `fsPath` = 回退

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

## 远程 git 集成（只读展示，自绘 gutter）

- **现行实现是 gitDirtyDiff.ts 的自绘 gutter**（TextEditorDecorationType + SVG data URI 图标，数据走 `git diff HEAD -U0`，解析器 parseUnifiedZeroHunks 在 parse.ts 有单测）——零接触原生 git；当前连接服务器的 git 完全交给原生 git 扩展，不要碰
- **quickDiff 载体 remoteScm.ts 保留但禁止在 extension.ts 实例化**：理论上 quickDiff 按 rootUri（scheme 敏感）隔离，但实测启用后当前服务器的原生 git 编辑器改动显示仍被破坏，原因待查（README TODO 有记录）
- 性能三板斧（删掉任何一条 = 首开延迟回退）：hunk 结果走模块级共享缓存（`cachedDirtyHunks`/`warmDirtyHunks`，store onChange 整体失效）、首开编辑器仓库根未知时 fetchDirtyHunks 踢 `remoteGitStore.request()` 管线、编辑器事件 50ms 短去抖
- 点击查看改动走 **CodeLens**（每个改动块上方「打开更改」→ `agentDock.openGitDiff` → vscode.diff，左侧 HEAD 走 gitHeadContent.ts 的 `agentdock-git-head` scheme）——gutter 图标无公开点击事件 API，不要退回悬停方案（用户明确要求点击）；CodeLens 与装饰器共享同一份 hunk 缓存
- untracked/added/deleted/ignored 不打 gutter（与原生 git 语义一致）；编辑后标记要等保存→轮询→重扫刷新，不做逐键 diff（每键一次 ssh 不可接受）
- 树/资源管理器的字母徽标装饰走 gitDecorations.ts，与 gutter 并存

## 端口转发（src/ssh/portForward.ts）- Windows（Win32-OpenSSH）不支持 ControlMaster，`-O forward`/`-O cancel` 必然失败——win32 直接走独立 `ssh -N` 进程，不要尝试 `-O`，否则每次启动都打失败日志
- 活跃转发必须持久化到 workspaceState（`persistActiveForwards` 在 start/stop/进程退出时调用），reload 后由 `restoreActiveForwards` 自动重启——否则转发随窗口关闭

## 右键菜单（package.json + getTreeItem 必须同步）

- 远程 fs 节点（`remoteFsFile`/`remoteFsDir`）菜单必须保留完整操作集：新建文件/文件夹、重命名、移动到、删除、复制、粘贴、复制路径、**下载**、打开终端、刷新——删成只剩"刷新"就是回退；`remoteFsDir`/`folder.remote` 还要有**上传到此处**
- 本地 fs 节点（`fsFile`/`fsDir`）同样保留：打开、新建、重命名、移动到、删除、复制、粘贴、复制路径、复制相对路径、**下载**、在文件管理器中显示、打开终端；`fsDir`/`folder.workspace` 还要有**上传到此处**
- `folder.remote`/`folder.workspace` 必须保留"刷新目录"
- 菜单 `when` 里的 `viewItem` 必须与 `getTreeItem` 的 `contextValue` 完全一致，改任一侧要同步另一侧

## 下载与拖动上传（moveOps.ts + dragDrop.ts）

- **SFTP 流式传输必须经 `pumpStreams`（内含 `rs.pipe(ws)`）**——0.2.4/0.2.5 的 sftpDownload/sftpUpload 建了读写流却没 pipe，数据零流动，下载只建空文件、上传挂起，属严重回退；pumpStreams 有单测锁死（字节搬运/进度合计/取消清理），禁止绕过它手写流逻辑
- 下载/上传进度走 `runCopyWithProgress`（右下角通知，字节级 increment + 可取消）；ssh2 的 SFTP 写流 `finish` 事件不可靠，结算必须 finish/close 先到先用
- 下载目的地是**客户端磁盘**：扩展以 UI 侧运行（extensionKind `['ui','workspace']`，`currentNeedsSsh()` 是判据），`vscode.workspace.fs` 直写客户端；当前服务器下载走 `copyCurrentToLocal`（workspace.fs 递归，兼容 file/vscode-remote），其他服务器走 `copyRemoteToLocal`/`downloadRemoteToUri`（SFTP 流式）
- **禁止**给"当前服务器→客户端"的复制复用 `fsCopyFile` 的 local→local 分支（node `fsp.copyFile` 拿 vscode-remote 路径在客户端盘上找不到）——跨 scheme 一律 `copyUriRecursive`
- 树拖放除树内 MIME 外必须保留 `'files'` 和 `'text/uri-list'` 两个 MIME（OS 文件管理器拖入上传）：**uri-list 优先**（`URI.file()` 产出的规范 file://，且仅接受 `scheme === 'file'`）、`asFile()` 兜底——**asFile().uri 在 Windows 上是盘符当 scheme 的畸形 URI**（`URI.parse('C:\…')` → scheme='c'），直接用会 stat 失败（0.2.5 回退）；有合法 `uri` 走流式复制（`copyLocalToRemote` / `copyUriRecursive`），无 uri 走 `data()` 全量读入（`OS_DROP_BYTES_CAP` 上限防撑爆宿主）
- 目录节点另有右键「上传到此处…」（`fsUpload`/`remoteFsUpload`，showOpenDialog 多选）作为拖放的保底路径，删除属回退

## 轮询与日志

- 远程目录/文件轮询的 ssh 调用必须 `quiet`，视图不可见/目录折叠时暂停，否则控制台被 `[DEBUG] [ssh]` 刷屏
- 远程路径拼接一律用 `shq()` 引用
