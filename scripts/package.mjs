/**
 * 统一打包入口：本地与 GitHub CI/CD 共用（改打包方式只改这里 + package.json scripts）。
 *
 * 流程：tsc（out/，供测试）→ esbuild（dist/extension.js，运行时 bundle）
 *       → vsce package（vsix）→ 产物验证（打包红线，失败即退出）。
 *
 * 用法：npm run package [-- --out <path>]
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outFlag = process.argv.indexOf('--out');
const vsixOut = outFlag >= 0 && process.argv[outFlag + 1] ? process.argv[outFlag + 1] : undefined;

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

// 1. 编译：tsc（out/ 给 e2e 测试 require）+ esbuild（dist/extension.js 给运行时）
run('npm run build');

// 2. 打包 vsix（vsce 会自动跑 vscode:prepublish=npm run build，与上一步重复但幂等无害；
//    任何绕过 package.mjs 直接 vsce package 的调用也能保证产物是最新构建）
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsixName = vsixOut ?? `agent-dock-${pkg.version}.vsix`;
run(`npx @vscode/vsce package --out ${JSON.stringify(vsixName)}`);

// 3. 产物验证（打包红线，防回退）
const vsixPath = path.isAbsolute(vsixName) ? vsixName : path.join(root, vsixName);
const list = execSync(`unzip -l ${JSON.stringify(vsixPath)}`, { encoding: 'utf8' });
const count = (re) => (list.match(re) || []).length;
const size = fs.statSync(vsixPath).size;

const nodeBinaries = count(/node-pty\/prebuilds\/[^ ]*\.node/g);
const pdbs = count(/\.pdb\b/g);
const hasDist = /dist\/extension\.js/.test(list);
const ssh2Bundled = /extension\.js/.test(list) && !/node_modules\/ssh2\//.test(list);

const problems = [];
if (nodeBinaries < 8) {
  problems.push(`node-pty prebuilds .node < 8 (got ${nodeBinaries}) — 原生依赖缺失`);
}
if (pdbs > 0) {
  problems.push(`vsix 含 ${pdbs} 个 .pdb（调试符号，不应发布）`);
}
if (!hasDist) {
  problems.push('vsix 缺少 dist/extension.js（运行时 bundle）');
}
if (!ssh2Bundled) {
  problems.push('ssh2 未被打进 bundle（应打包进 dist/extension.js）');
}

console.log('\n===== PACKAGE VERIFY =====');
console.log(`vsix: ${vsixName} (${(size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`node-pty prebuilds .node: ${nodeBinaries}`);
console.log(`pdb files: ${pdbs}`);
console.log(`dist/extension.js: ${hasDist ? 'yes' : 'NO'}`);
console.log(`ssh2 bundled (no node_modules/ssh2): ${ssh2Bundled ? 'yes' : 'no'}`);
console.log('===========================');

if (problems.length > 0) {
  console.error('\nPACKAGE VERIFY FAILED:');
  for (const p of problems) {
    console.error(' -', p);
  }
  process.exit(1);
}
console.log('PACKAGE VERIFY OK');
