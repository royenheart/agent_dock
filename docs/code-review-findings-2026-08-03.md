# Agent Dock 代码审查发现汇总（2026-08-03）

> 审查方式：9 个 deepseek-v4-flash 子代理并行扫描 6 个代码区域（只读，未修改任何代码），
> 其中"远程文件系统"区域经第二轮复核确认并补充。共 **66 条发现**：
> bug 26 · perf 15 · improvement 25。
> 严重性为建议排序依据，未做实施，等确认后再动手。

## 实施状态（2026-08-03 更新，v0.1.10）

以下发现已在本轮修复（配套单元测试 + 真实服务器 e2e + VSCode e2e suite 回归）：

- **一-1** stdin/stdout/stderr EPIPE 监听（remoteExec + 二-3 clientTerminal 同修）
- **一-2** AbortSignal：Semaphore 支持排队取消 + spawn 前检查已中止
- **一-3** 超时/中止先 SIGTERM、500ms 宽限后再 SIGKILL（保护共享 ControlMaster）
- **一-4** stdout 字节上限（默认 16 MiB，超限 kill + truncated 标记）
- **一-6** runSsh 走全局信号量
- **三-1 / 三-2 / 三-7** 轮询分隔符与文件名冲突：S| 行从右往左切分、目录块显式 E|/M| 结束标记、dir mtime 行 lastIndexOf 解析（三处同族修复）
- **三-3** 目录删除经 M| 标记解析为 null，applyDir 消失分支可达
- **三-4** parseLsAp 与 ls -1Ap（-p 语义）对齐，不再截断 `* @ = | %` 结尾的合法文件名
- **三-5** expandedDirs 时间淘汰改为 LRU 上限（1000），展开目录不再静默停止轮询
- **三-6** refreshPorts 身份失配：回退全量重绘，不再静默 no-op
- **三-8** 父子会话归组改为递归（buildSessionTree），深度 ≥2 不再丢失
- **三-9** pollOnce / pollExpandedDirs 各服务器并发轮询
- **三-11 / 三-14** memento 持久化串行化（createSerialQueue）+ 无变化不写 + 每目录截断 + 失败降级日志
- **三-12** remoteDirCache/dirMtimes 随 LRU 淘汰清理，不再无限增长
- **三-13** readFile 单次带限读取（stat+cat 一条脚本 + TOOBIG 标记），消除 TOCTOU
- **四-6 / 四-13** 装饰器：缓存为空不触发扫描；refresh 不再清空 realpathCache
- **六-1 / 六-7** servers 读-改-写串行化（configQueue）；ensureCurrentServerRegistered 捕获失败记日志
- **六-2** removeServer 先停止该服务器活跃转发再删配置
- **六-8** 日志默认级别统一 info + 非法值回退校验
- **六-11** batch flush 同步抛错也保证 pending 全部 settle
- 另：clientTerminal 写前检查 exitCode

以下发现暂缓实施（中等风险/收益比待评估）：一-5（每服务器信号量）、一-7（Windows bash）、一-8（IPv6 authority）、一-9（ssh config 缓存）、二-1（startForward in-flight）、二-2（master 条目 TTL）、二-4（probe 冗余）、二-5（stopForward cancel 失败保留）、二-6（ClientPty emitter dispose）、二-7（macOS netstat）、三-10（全量重绘链）、三-15（秒级 mtime）、四-1（DB 硬编码列）、四-2（单行 JSON）、四-3（claude cwd 解码）、四-5（python transcript 无上限）、四-7（渲染块预算）、四-8（usage 口径）、四-9（head -c 4096）、四-10（分段超时）、四-11（远程 cwd realpath）、四-12（function_call_output 数组）、四-14（codex resume git 检查）、五区全部（视图层）、六-3（Windows sendText）、六-5（迁移相等跳过）、六-6（配置变更按键刷新）、六-9（sync-folders 并集）、六-10（addRemoteDirectory 复用缓存）。

---

## 一、SSH 传输层（src/ssh/remoteExec.ts, sshArgs.ts, sshConfig.ts, progress.ts, currentExec.ts）— 9 条

### bug
1. **stdin/stdout/stderr 无 error 监听，EPIPE 可成未捕获异常**
   `remoteExec.ts:67-91` — spawnCollect 未给 stdin/stdout/stderr 挂 `'error'` 监听；ssh 提前退出（spawn ENOENT、连接被拒、abort/timeout 时仍在写）触发 EPIPE，Node 无监听器的 error 事件直接抛出，击穿扩展宿主。建议：挂 no-op error 监听 + write 前检查。
2. **AbortSignal 注册过晚：排队期间/已中止的取消被完全忽略**
   `remoteExec.ts:176-180,71` — 先 await 信号量再 spawn 后才注册 abort 监听；排队等待期间用户取消（progress.ts 立即 abort）不会阻止 ssh 启动，结果 cancelled=false。建议：acquire 后、spawn 前检查 `signal.aborted`，被中止直接返回 cancelled。
3. **SIGKILL 可能杀掉共享 ControlMaster 连接，殃及同服务器其他并发操作**
   `remoteExec.ts:63-70` + `sshArgs.ts:19` — 所有调用共享 ControlPath，超时/中止直接 SIGKILL；若被杀的恰好是持有 master 的进程，同服务器其他通道全断，且残留失效 socket。建议：先 SIGTERM 宽限再 SIGKILL，必要时 `ssh -O exit` 优雅关停。

### perf
4. **stdout/stderr 无上限缓冲：大输出或失控脚本可耗尽内存**
   `remoteExec.ts:59-77` — outChunks/stderr 无字节上限（readFile 的 8MiB 预检是 stat 与 cat 之间的 TOCTOU）。建议：spawnCollect 内加硬上限（如 16MiB）超限 kill；size 检查下沉到 cat 脚本内。
5. **全局信号量无每服务器隔离：黑洞服务器可饿死健康服务器**
   `remoteExec.ts:95-116,176` — 单一 4 槽队列，一台 ConnectTimeout=8s 的挂起服务器可长期占满全部槽位，且 pollOnce 对失败无退避。建议：每服务器独立信号量 + 指数退避。

### improvement
6. **runSsh 绕过全局信号量，与"并发上限 4"设计不一致**
   `remoteExec.ts:214-226` — 仅 portForward 的 `-O forward/cancel` 使用，不受限流且不可 abort。建议：统一走信号量。
7. **Windows 分支缺失：execLocal 与远端 bash -s 硬依赖 bash，无回退**
   `remoteExec.ts:229-236,172` — 原生 Windows 宿主或无 Git Bash 时每次 spawn ENOENT。建议：win32 检测 + 可读错误。
8. **parseSshAuthority 正则不支持 IPv6 方括号 authority**
   `currentExec.ts:46-48` — `[::1]` 或 `user@[::1]:22` 匹配失败，兜底拼出非法目标。建议：剥离 `[...]` 段再解析。
9. **ssh config 每次打开选择器都全量重解析且失败静默**
   `sshConfig.ts:46-116` — 无 mtime 缓存；解析失败返回空列表用户无从得知。建议：按 mtime 缓存 + 失败告警。

---

## 二、网络与终端（src/ssh/portForward.ts, clientTerminal.ts, listeners.ts）— 7 条

### bug
1. **startForward 无 in-flight 状态，并发调用可双开转发并孤儿化一个 ssh -N 进程**
   `portForward.ts:50-103` — active.has 检查在两个 await 之前，无占位；并发 start 各自 spawn，后者覆盖前者，前者 exit 处理器永不清理（持锁进程成孤儿，UI 显示 inactive 且 stopForward 杀不掉）。建议：active 表纳入 starting Promise；stop 在 start 在途时先取消。
2. **master 模式转发条目永不过期：ControlMaster 连接死亡后 UI 永远显示 forwarding**
   `portForward.ts:64-67,93-99` — master 条目无任何移除路径（exit 处理器只匹配 child）；主连接随空闲超时/断网/sshd 重启消亡后 `isForwardActive` 仍返回 true。建议：TTL/惰性 `-O check` 校验，失败即删条目。
3. **管道模式下 child.stdin 无 error 监听，进程退出后写入可触发未捕获 EPIPE**
   `clientTerminal.ts:171,237,257` — handleInput 直接 write，无 error 监听；子进程退出到 'close' 派发之间写入即抛。建议：挂 error 监听 + exited 标志。

### perf
4. **每次 startForward 都多一次完整 ssh 往返（probe），Windows 上纯属浪费**
   `portForward.ts:56` — probe 冗余且占全局信号量最多 10s；win32 禁用 ControlMaster 时 -O forward 必然失败走 fallback，probe 白跑。建议：去掉独立 probe，失败时再补建 master。

### improvement
5. **stopForward 在 -O cancel 失败时仍删除条目并宣称 down，状态与实际脱节**
   `portForward.ts:114-121` — 瞬时失败后端口仍占用但 UI 显示 not started，再 start 撞端口占用且无自愈。建议：cancel 失败保留条目，用 -O check 核实。
6. **ClientPty 的 EventEmitter 从不 dispose，每次打开终端都泄漏**
   `clientTerminal.ts:101-104` — 每开一个客户端终端永久泄漏一对 emitter 及其订阅。建议：实现 dispose()，close()/onDidClose 后调用。
7. **macOS 上 netstat -tlnp 参数非法，服务探测静默返回空**
   `portForward.ts:24` — macOS netstat 无 -t；stderr 被吞，端口节点永远无 service 名。建议：darwin 用 `lsof -nP -iTCP -sTCP:LISTEN`。

---

## 三、远程文件系统（src/ssh/remoteFsProvider.ts, remoteFsPoll.ts, remoteFsParse.ts, tree/workspaceProvider.ts）— 15 条

### bug
1. **parsePollOutput 按第一个 '|' 切分 S| 行，路径含 '|' 的文件解析错乱**
   `remoteFsPoll.ts:56-66` — `S|/tmp/a|b|123|456` 被切为 path=/tmp/a、size=b(NaN)；watcher 永久拿不到快照，实时刷新静默失效（已确认）。建议：从行尾反向切分固定字段数，或换不冲突分隔符。
2. **D 块边界用 S|/D| 前缀启发式，目录内名为 S|x/D|x 的文件截断块并被丢弃**
   `remoteFsPoll.ts:70-77` — 合法文件名撞块头标记，条目丢失并误报 Deleted。建议：显式块结束标记（如 `E|<path>`）。
3. **目录被删时解析为空数组 [] 而非 null，applyDir 的"目录消失"分支永远不可达**
   `remoteFsPoll.ts:41-44,67-78` — 无条件先打印 D| 头再 ls，失败时输出仍有头 → 解析为 []；被删目录呈现为"空目录"持续存在。建议：`ls ... || echo 'E|<path>'` 映射为 null。
4. **parseLsAp 按 -F 标记语义剥尾字符，但生产全部用 ls -1Ap（-p 只加 '/'）**
   `remoteFsParse.ts:14-21` — 标记分支是死代码；真实文件名以 `* @ = | %` 结尾时被剥离 → 树中名称错误、打开 404；指向目录的 symlink 被误判为文件无法展开。建议：统一 -F 或 -p 语义，并修正单测输入。
5. **expandedDirs 30 分钟无活动超时会把仍展开的远程目录踢出轮询，实时刷新静默停止**
   `workspaceProvider.ts:675-684,629` — touchedAt 只在 getChildren 时更新；展开后闲置 30 分钟即被移除且无法自动恢复（已确认）。建议：显式维护展开/折叠状态，或每轮续期；移除时清理 dirMtimes。
6. **refreshPorts 用新建字面量节点触发局部刷新，树按对象身份匹配必然失配 → 静默 no-op**
   `workspaceProvider.ts:238-240` — fire 全新 `{kind:'portsRoot',...}` 永远匹配不到树中实例；refreshNode 同理，全量重绘后旧引用全部失效（已确认）。建议：按 serverKey 缓存稳定节点引用，失配时回退全量刷新。
7. **pollExpandedDirs 用 `path|` 前缀 + indexOf('|') 解析，路径含 '|' 的目录永不刷新**
   `workspaceProvider.ts:700-713` — 与发现 1 同族，树轮询路径第三处。建议：统一分隔符方案并共享解析函数。
8. **父子会话归组只渲染一层：深度 ≥2 的嵌套会话从树中静默丢失**
   `workspaceProvider.ts:581-593` — childrenOf 只挂在 top 级，孙级会话无处渲染。建议：递归构建 children。

### perf
9. **pollOnce 多服务器轮询串行 await，慢服务器拖长所有服务器的有效刷新间隔**
   `remoteFsProvider.ts:184-206` — 一轮耗时 = 各服务器 ssh 往返之和（已确认）。建议：Promise.all 并发（信号量已限 4）。
10. **全量重绘链：任何磁盘/远程目录变化 → 两棵树全量重绘 → 展开的 portsRoot 触发 ssh ss 探测**
    `workspaceProvider.ts:243-245` + `extension.ts:65-78` — 修正版：ss 探测仅在 portsRoot 展开时发生且受 30s TTL 限制（portForward.ts:15-28），但整树重绘本身频繁。建议：ss 结果 TTL 缓存进节点 + 局部刷新。
11. **persistRemoteDirCache 每次目录拉取把最多 200 目录 × 501 节点整体写入 globalState，并发写可能交错产生陈旧覆盖**
    `workspaceProvider.ts:618-624,790` — 无防抖无串行化，~10 万节点载荷（已确认）。建议：摘要比较 + 防抖 + promise 链串行化。
12. **remoteDirCache 与 dirMtimes 两个 Map 随会话无限增长**
    `workspaceProvider.ts:596-604,715-721` — 内存 Map 无上限（仅持久化时 slice(-200)）；dirMtimes 只增不删。建议：LRU 淘汰 + 退出轮询时清理。

### improvement
13. **readFile 先 stat 后 cat 两次 ssh 存在 TOCTOU，8MiB 上限可被绕过且整文件先进内存**
    `remoteFsProvider.ts:248-262` — 两次调用间文件可增长；execRemoteBuffer 把整个 stdout 收进内存。建议：单次调用带限读取（`head -c MAX+1` 并检查截断）。
14. **所有 memento 持久化为 fire-and-forget：无错误处理，并发 update 可能乱序覆盖**
    `workspaceProvider.ts:95-105,171,205,226,618-624` — update reject → 未处理拒绝；晚发起的写可能先落盘。建议：.catch 降级 + 单 promise 链串行化。
15. **目录/文件轮询都用秒级 mtime，同秒内变化可能漏报**
    `workspaceProvider.ts:701` / `remoteFsPoll.ts:38` — 秒级粒度下同秒多次写入采样相同 → 不触发。建议：纳秒级时间（GNU stat %y）或辅助信号。

---

## 四、Agent 会话（src/agents/*, tree/structure.ts, tree/sessionDecorations.ts）— 13 条

### bug
1. **opencode DB 查询硬编码列 + 单层 try/except：schema 漂移时整个 opencode 扫描归零，legacy 兜底不可达**
   `discoveryScript.ts:172-183` — 缺 parent_id/time_archived 列时 execute 抛错直接跳 except（作者自己在 PY_TRANSCRIPT 用 PRAGMA 动态取列，说明 schema 会变）。建议：PRAGMA table_info 动态拼列；失败回退 legacy 文件扫描。
2. **python 路径输出为单行巨型 JSON：解析失败（截断/超时被杀/乱码）时所有 agent 的会话全部丢失**
   `parse.ts:313-333` + `discoveryScript.ts:354` — 三 agent 结果攒成一行 print；脚本无内部超时，撞 ssh 20s 上限被 SIGKILL 即全丢且不回退 shell 解析。建议：按 agent 分段各自 print 一行 + 内部 signal.alarm 时限。
3. **claude cwd 兜底用 replace('-','/') 反解项目目录名：以 '-' 开头的目录名被错误解码**
   `parse.ts:228-231` + `discoveryScript.ts:336-338` — 真实路径 /home/user/-tmp 解成 /home/user//tmp，isUnder 精确匹配永远失败，会话误归 others。建议：按 claude 编码规则逐段还原 + '//' 归一。

### perf
5. **opencode transcript 走 python 时无大小上限：整个会话 messages+parts 全量 dump**
   `discoveryScript.ts:78-115` — 无 LIMIT 无截断（codex/claude 有 6MiB tail 上限）；part.data 存完整工具输出，数十上百 MB 进内存。建议：按 time_created 取尾部 N 条或对超大 data 截断。
6. **装饰器刷新频率过高：任何文件系统事件都触发全量重装饰 + realpathCache 清空重算**
   `sessionDecorations.ts:19-22,33-62` + `extension.ts:35,65-78` — fsWatcher 防抖 300ms 后全树刷新 → 清 realpathCache 全部重算（本地 fs.realpath / 远程一批 ssh）。建议：realpathCache 长缓存 + 装饰器刷新防抖。
7. **6 MiB 上限的 jsonl 可展开出数万 RenderBlock，无总块数/总字符上限**
   `transcript.ts:740-757,129-146` — 一次性注入 webview 明显卡顿。建议：输出预算（块数/字符上限）+ 超长行跳过。

### improvement
8. **Claude transcript 的 usage 逐条累加 input_tokens 造成总量虚高**
   `transcript.ts:244-253` — 每条 input_tokens 是含缓存的完整上下文，逐条求和远超真实消耗；与 codex 整体覆盖口径不一致。建议：只累加非缓存增量或标注近似值。
9. **无 python3 的服务器上 opencode 旧版回退用 head -c 4096 截断会话 JSON，大会话被静默丢弃**
   `discoveryScript.ts:383` — 旧版 info/ses_*.json 常远超 4KB，JSON.parse 失败即跳过且无 note。建议：提高阈值/用 jq，并提示部分会话未列出。
10. **发现脚本内无分段超时：单个 agent 扫描拖满整体 20s 预算会饿死其余两个 agent**
    `discoveryScript.ts:120-355,367-407` — 三 agent 串行在同一 python 进程，无各自 deadline。建议：`timeout 8s` 拆分或按剩余时间预算提前终止。
11. **远程服务器会话 cwd 不做 realpath 归一，符号链接 cwd 与 pinned folder 词法匹配失败**
    `structure.ts:22-36` + `workspaceProvider.ts:159-168` — 只对当前服务器归一，远端两侧都没归一，不一致。建议：PY_DISCOVERY 输出前 os.path.realpath。
12. **codex function_call_output 的 output 为内容块数组时未处理，工具输出只显示 600 字符 JSON 转义预览**
    `transcript.ts:315-329` — 数组形态落到 brief(output,600)，应走 textFromContent。建议：分支开头 `if (Array.isArray(output)) return textFromContent(output)`。
13. **provideFileDecoration 在缓存为空时会触发一次完整远端会话扫描并阻塞等待**
    `sessionDecorations.ts:37` — 打开资源管理器即隐式触发扫描（最长 20s），首屏徽标延迟数十秒。建议：缓存为空直接返回 undefined，数据到达后自然补上。
14. **codex resume 在非 git 仓库目录会直接报错退出，无兜底**
    `resume.ts:11` — 建议：追加 `--skip-git-repo-check` 或探测 .git。

---

## 五、视图层（src/views/sessionPanel.ts, pathInput.ts, dirPicker.ts, settingsView.ts, settingsData.ts）— 12 条

### bug
1. **复用已存在面板时重复注册 webview 消息监听器，每次 refresh 触发 N 次 ssh 拉取**
   `sessionPanel.ts:36-50,87-98` — 旧 disposables 从不释放，Refresh 消息被所有监听器各执行一次。建议：注册移入创建分支，或复用前 dispose 旧批。
2. **面板销毁后 load() 仍写 panel.webview.html：抛异常且 catch 内再次抛出**
   `sessionPanel.ts:53-86` — disposed webview 写 .html 抛错，catch 里再写又抛 → unhandled rejection。建议：写前检查 disposed/标志。
3. **refreshBrowse 无 try/catch：execRemote reject 导致未处理 rejection 且 busy 永久卡住**
   `dirPicker.ts:61-83` — spawn 失败/error 事件时 qp.busy 永不复位，QuickPick 永远转圈。建议：try/catch + finally 复位。
4. **splitPathInput 只按 '/' 切分，Windows 本地路径（反斜杠）浏览退化为 base='/' 无法浏览**
   `pathInput.ts:11-17` — 与 dirPicker.basename 对 '\\' 的归一化不一致。建议：切分前把 '\\' 归一为 '/'。
5. **push() 存在并发与销毁竞态：视图关闭后写 html 抛异常，慢 push 后完成会以旧数据覆盖新数据**
   `settingsView.ts:18-35,38-55` — 无 generation 守卫、无 disposed 检查。建议：generation 计数 + disposed 检查 + try/catch。
6. **parseTomlSections 对数组表 [[...]] 和正文中以 '[' 开头的行敏感：节被静默丢弃或 body 截错**
   `settingsData.ts:111-123` — `[[mcp_servers.foo]]` 永不匹配；body 用 indexOf('\n[') 截断会被正文表头提前截断。建议：逐行扫描表头。

### perf
7. **大会话同步渲染：每个 text block 同步执行 marked.parse + DOMPurify.sanitize，webview 主线程可阻塞数秒**
   `sessionPanel.ts:250-252,350-358` — 全量同步 + 整页重建丢滚动位置。建议：分块渲染（rAF）+ 单 block 长度上限。
8. **目录导航每次多打一次 ssh 往返：qp.value 赋值触发防抖刷新，又立即手动 refreshBrowse**
   `dirPicker.ts:103-106` — 200ms 内两次 listSubdirs。建议：手动刷新前 clearTimeout 或只留防抖路径。
9. **gatherSettings 全程串行文件 I/O，远程窗口下打开/刷新设置视图延迟随操作数线性累加**
   `settingsData.ts:152-196,317-379` — 各目录、各 skill 串行 await vscode.fs（远程=IPC 往返）。建议：Promise.all 并行 + 按 mtime 缓存。

### improvement
10. **DOMPurify 使用不一致：addHook 有存在性守卫而 md() 无守卫，vendor 脚本缺失时整个面板渲染崩溃**
    `sessionPanel.ts:250-257` — 建议：md() 内检查 window.DOMPurify，缺失时纯文本降级 + 警告。
11. **关闭 QuickPick 时未清理防抖定时器，Esc 后仍会发起一次多余的 ssh 目录列举**
    `dirPicker.ts:86-97,117` — 建议：finish() 中 clearTimeout。
12. **硬编码 `<html lang="zh">`，未跟随 vscode.env.language**
    `settingsView.ts:68` — 与 sessionPanel 用 `${vscode.env.language}` 不一致。建议：改为动态值。

---

## 六、核心与命令（src/extension.ts, commands.ts, config.ts, serverRegistration.ts, model.ts, paths.ts, log.ts, i18n.ts, batch.ts）— 10 条

### bug
1. **agentDock.servers 读-改-写无串行化，迁移的删除+重写两步存在丢失更新竞态**
   `config.ts:34-45,53-76,86-111` — ensureCurrentServerRegistered 在激活/文件夹变更/手动刷新三处 fire-and-forget；两个并发调用互相覆盖，迁移的 update(undefined) 中间态可清空配置。建议：模块级 promise 链互斥 + 单次 update 写合并结果。
2. **removeServer 不停止该服务器的活跃端口转发，专用 ssh -N 子进程泄漏**
   `config.ts:113-118` — 不触碰 portForward 模块级 active Map；deactivate() 为空，无人清理。建议：removeServer 先 stopForward 再更新配置。
3. **本地 Windows 窗口下 term.sendText 发送 POSIX 单引号转义命令，恢复/新建会话命令失效**
   `commands.ts:78-92,596-608` — shq 输出 POSIX 语法，cmd/PowerShell 下必然失败。建议：win32 走 openClientTerminal/sshSpawnSpec。

### perf
5. **迁移逻辑每次 ensureCurrentServerRegistered 无条件删除+重写配置，触发全量缓存失效与重复 ssh 扫描**
   `config.ts:86-111` — 合并结果与现值相同也重写；每次 update 触发 onDidChangeConfiguration → provider.refresh() 清空全部缓存 → 重新完整发现扫描。建议：写前 JSON 相等比较 + 单次 update。
6. **任意 agentDock 配置项变更都触发全量 refresh，清空会话/远程目录缓存**
   `extension.ts:80-84` — 改 logLevel/轮询间隔也会导致全部服务器重新扫描。建议：仅对影响树数据的键刷新。

### improvement
7. **void ensureCurrentServerRegistered() 未捕获拒绝，配置写失败产生 unhandled rejection**
   `extension.ts:62,86` — 建议：.catch 记日志。
8. **日志级别默认值不一致：代码回退 'info' 但 package.json 默认 'debug'，非法级别不校验**
   `log.ts:73-76` + `package.json:163` — 默认安装下每次 ssh 调用全量 argv/stderr 进通道；非法值使级别过滤完全绕过。建议：统一 'info' + 取值校验。
9. **sync-folders 用当前打开的 workspace 子集整体替换已 pin 目录，打开子集时静默丢失其余 pin**
   `serverRegistration.ts:120-128` — 只保护空 workspace 一种情形。建议：并集合并或删除前确认。
10. **addRemoteDirectory 每次执行完整发现扫描，未复用已缓存的会话快照**
    `commands.ts:271-293` — 无进度不可取消且占信号量；store 中可能已有快照。建议：优先复用缓存，无缓存时 execRemoteSmart。
11. **run 同步抛错时 pending promise 永不 settle（timer 路径），调用方静默挂起**
    `batch.ts:28-41` — createBatcher 通用 API，非 async run 同步抛异常时 pending 全挂起。建议：flush 内 try/catch，catch 时 reject 全部 pending。

---

## 建议优先处理（Top 10）

1. **EPIPE 未捕获异常**（一-1、二-3）：可能直接击穿扩展宿主，修复成本极低（挂 error 监听）。
2. **servers 配置读-改-写竞态/迁移可清空配置**（六-1）：数据丢失风险最高。
3. **refreshPorts/refreshNode 身份失配静默 no-op**（三-6）：局部刷新整体失效的根因。
4. **30 分钟超时踢出展开目录**（三-5）：长时间使用的会话中实时刷新静默停止。
5. **startForward 并发双开/孤儿进程**（二-1）：端口转发状态错乱。
6. **parseLsAp 与 ls -1Ap 语义不符**（三-4）：含 `*@=|%` 结尾的合法文件名显示/打开错误。
7. **S|/D| 与 path| 分隔符与文件名冲突**（三-1、三-2、三-7）：轮询解析错乱的根源，应统一分隔方案。
8. **目录删除解析为 [] 而非 null**（三-3）：被删目录永远显示为空目录。
9. **全量重绘链 + 每次目录拉取全量写 globalState**（三-10、三-11）：远程会话下的主要性能开销。
10. **单行巨型 JSON 输出**（四-2）：慢服务器上三家会话全部丢失。

## 附注

- 二轮复核对"每服务器一次 ssh ss 探测"的说法做了修正：实际仅 portsRoot 展开时探测且有 30s TTL。
- 所有行号为审查时源码行号（2026-08-03，v0.1.9 工作区）。
- 本清单为只读审查产物，未做任何代码修改。
