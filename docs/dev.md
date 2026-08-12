# 开发指南（编译 / 打包 / 测试）

面向扩展开发者的本地工作流。普通用户安装 `.vsix` 即可，见 [README](../README.md)。

## 环境要求

- Node.js（仓库使用 `@types/node ^22`，建议 Node 20+）
- 打 vsix 需要 `@vscode/vsce`（devDependencies 已含，`npx` 直接可用）
- e2e 测试需要 Linux + `xvfb`（`sudo apt install xvfb` 等），并配置可免密的 ssh 目标

## 编译

```bash
npm install
npm run compile      # 仅 tsc → out/（e2e 测试 require 用）
npm run build        # 完整构建：tsc（out/）+ esbuild bundle（dist/extension.js，运行时加载）
```

调试：VS Code 打开本仓库，`F5`（`.vscode/launch.json` 已配 Extension Development Host）。

## 打包 vsix（统一入口，本地与 GitHub CI/CD 一致）

```bash
npm run package [-- --out <路径>]   # tsc → esbuild → vsce → 产物验证（node-pty/无 .pdb/ssh2 bundle/大小）
```

- 打包逻辑只存在 `scripts/build.mjs`（esbuild bundle）+ `scripts/package.mjs`（打包+验证）；
  本地与 `.github/workflows/*.yml` 都调用 `npm run build` / `npm run package`——**改打包方式只改 scripts/ + package.json + .vscodeignore，不要另写打包命令**
- 运行时加载 `dist/extension.js`（esbuild 单文件 bundle，含 ssh2；package.json main 指向它）；
  `out/` 仅供 e2e 测试 require，不进 vsix
- vsix 约 **2MB**（esbuild 压缩 JS + ssh2 打进 bundle；node-pty 只保留运行所需的
  lib/ + prebuilds，排除 ~20MB 的 .pdb 调试符号与 third_party 源码）

**打包红线**（历史踩坑，见 [AGENTS.md](../AGENTS.md)）：

- 绝不把 `node_modules/**` 加回 `.vscodeignore`——vsix 必须带 node-pty 预编译二进制，否则客户端终端失去真 pty，Ctrl+C 失效（0.1.9/0.1.10 因此回退）
- 打包后必须验证 node-pty 在包内：

```bash
unzip -l agent-dock-*.vsix | grep "prebuilds/.*\.node"   # 期望 8 个平台二进制
unzip -l agent-dock-*.vsix | grep -c "\.pdb"             # 期望 0（调试符号不得发布）
```

发布流程：改 `package.json` 版本 → 更新 `CHANGELOG.md` → 编译 → 打包 → 校验 node-pty。

## 测试

```bash
npm run test:unit    # 纯逻辑单测（node:test）：路径匹配、会话解析、transcript、ssh config、known_hosts、settings 聚合
npm run test:e2e     # @vscode/test-electron + xvfb：真实 VS Code 中验证树结构、文件命令、菜单完整性、transcript 等
```

改动后至少跑 `npm run test:unit`（当前 145 项，全绿才算完成）。

## 演示 GIF 录制（README）

README 的演示 GIF 全部由**本地沙箱**自动录制，不连接任何真实服务器、不写入个人数据：

```bash
npm run demo:record          # = bash scripts/record-demo.sh
# 可选：KEEP_FRAMES=1 npm run demo:record   # 保留 /tmp/agentdock-demo/frames 便于审片
```

管线（`scripts/record-demo.sh`）：

1. 起两台本地 sshd（端口 2222/2223）+ fixture 假数据（`scripts/demo-fixtures.mjs`）
2. 隔离 HOME / user-data；`~/.ssh/config` 写别名 `demo-sshd-a/b`（画面只出现别名）
3. `AGENTDOCK_HOSTNAME='Local workstation'` 覆盖真实主机名；沙箱 `PS1=demo@workstation`
4. Xvfb 里启动 VS Code（`--remote-debugging-port`），`src/demo.ts` 自动跑演示序列
5. `scripts/demo-record.mjs` 经 CDP `Page.startScreencast` 连续抓帧，按 marker 分段
6. SessionPanel / 设置等 webview 在无合成器的 Xvfb 下常不绘制——用 `scripts/render-demo-html.mjs` + headless Chrome 补帧
7. `scripts/demo-gif.mjs` 定 fps 重采样、折叠静态帧、加中文标注 → `docs/demo/*.gif`

依赖：Linux + `xvfb` + `magick`（ImageMagick 7）+ `google-chrome` + 中文字体（wqy-microhei）+ 本机 `/usr/share/code/code`。无需 ffmpeg / 窗口管理器。

隐私自检：产物与中间帧不得出现真实用户名、主机名、私钥路径；服务器一律为 `demo-sshd-*` 别名。

### 跨窗口 reload 恢复 e2e（目录展开状态 / 终端重建，两阶段）

对应历史缺陷：reload 后目录展开状态重置、客户端终端不恢复名字/不重建。用**同一个 user-data-dir 开两个窗口**验证恢复：

```bash
npm run test:e2e:reload:phase1   # 窗口1：展开目录 + 建客户端/原生终端 + 写状态 + 优雅退出
npm run test:e2e:reload:phase2   # 窗口2：断言展开状态/终端跨窗口恢复（复用 phase1 的 user-data）
```

- phase1 同时做「模拟 reload」断言（用真实 workspaceState 新建 ExpansionState 再 init）与持久化断言（clientTerminals/nativeTerminals/expandedNodes 已写入）
- phase2 先探测 phase1 是否真正落盘（state.vscdb）：正常 VSCode 环境走**强断言**（展开状态 + 终端重建）；若测试环境不写 state.vscdb（headless 下会出现）则降级为「新窗口正常启动 + 树可达」并打印 SKIP 说明，恢复路径已由 phase1 模拟 reload 覆盖
- 依赖：phase1 与 phase2 之间的 user-data 必须保留（`runTest.js` 在 phase2 自动置 `AGENTWS_KEEP_USER_DATA=1`；fixture 目录不能落在会被清空的临时区，沙箱单命令内跑两阶段）

### 其他服务器（远程文件/传输层）的 e2e —— 本地 sshd 沙箱，禁止连个人服务器

所有"其他服务器"测试一律跑在**本地沙箱**里（隐私红线，见 AGENTS.md），连接参数走环境变量：

```bash
# 起本地 sshd（非 root 也可，用当前用户认证；自动生成 keypair + known_hosts）
test/e2e/sshd-local.sh start
source /tmp/agentdock-sshd/env        # 导出 AGENTDOCK_E2E_HOST/PORT/USER/KEY/HOME
npm run compile
node test/e2e-poll.js                 # 轮询脚本/解析/diff（CLI ssh 路径）
node test/ssh-session-e2e.js          # 持久连接 + SFTP：单连接承载 exec/SFTP、二进制往返、超时、并发
node test/e2e-provider.js             # RemoteFsProvider：watch/轮询/readFile 上限 + SFTP 写/改/删
test/e2e/sshd-local.sh stop
```

也可用容器（如 `lscr.io/linuxserver/openssh-server`）替代本地 sshd，脚本头部有示例。

### SSH 传输层（persistent）

- 默认 `agentDock.sshTransport=persistent`：每台服务器一条 ssh2 长连接，文件走 SFTP、脚本走 exec 通道；`spawn` 为旧行为（每次一个 ssh 进程）与失败降级路径
- 主机密钥校验默认 `agentDock.sshHostKeyMode=yes`（按 ~/.ssh/known_hosts，支持哈希条目），可配 `accept-new` / `no`
- 认证：ssh-agent（SSH_AUTH_SOCK）→ ~/.ssh/config IdentityFile → 默认私钥，BatchMode 语义
