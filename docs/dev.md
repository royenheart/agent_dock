# 开发指南（编译 / 打包 / 测试）

面向扩展开发者的本地工作流。普通用户安装 `.vsix` 即可，见 [README](../README.md)。

## 环境要求

- Node.js（仓库使用 `@types/node ^22`，建议 Node 20+）
- 打 vsix 需要 `@vscode/vsce`（devDependencies 已含，`npx` 直接可用）
- e2e 测试需要 Linux + `xvfb`（`sudo apt install xvfb` 等），并配置可免密的 ssh 目标

## 编译

```bash
npm install
npm run compile      # tsc -p ./，输出到 out/
```

调试：VS Code 打开本仓库，`F5`（`.vscode/launch.json` 已配 Extension Development Host）。

## 打包 vsix（注意 node-pty！）

```bash
npm run compile
npx vsce package --out agent-dock-<版本>.vsix
```

**打包红线**（历史踩坑，见 [AGENTS.md](../AGENTS.md)）：

- 绝不把 `node_modules/**` 加回 `.vscodeignore`——vsix 必须带 node-pty 预编译二进制，否则客户端终端失去真 pty，Ctrl+C 失效（0.1.9/0.1.10 因此回退）
- 打包后必须验证 node-pty 在包内：

```bash
unzip -l agent-dock-*.vsix | grep -c "node-pty"     # 期望 68 左右
unzip -l agent-dock-*.vsix | grep "prebuilds/.*\.node"   # 期望 8 个平台二进制
```

发布流程：改 `package.json` 版本 → 更新 `CHANGELOG.md` → 编译 → 打包 → 校验 node-pty。

## 测试

```bash
npm run test:unit    # 纯逻辑单测（node:test）：路径匹配、会话解析、transcript、ssh config、settings 聚合
npm run test:e2e     # @vscode/test-electron + xvfb：真实 VS Code 中验证树结构、文件命令、transcript 等
```

改动后至少跑 `npm run test:unit`（当前 91 项，全绿才算完成）。
