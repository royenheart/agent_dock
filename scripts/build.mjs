/**
 * esbuild 打包：src/extension.ts → dist/extension.js（单文件、压缩、含 ssh2）。
 *
 * - external：vscode（宿主注入）、node-pty（原生模块必须留在 node_modules）、
 *   cpu-features/nan（ssh2 的可选原生依赖，加载失败 ssh2 有降级）
 * - 其它纯 JS 依赖（ssh2、asn1、bcrypt-pbkdf）全部打进 bundle —— 运行时不再
 *   需要 node_modules/ssh2，vsix 可排除，体积显著下降
 * - out/（tsc 产物）保留：e2e 测试直接 require('../../../out/...') 用
 */
import { build } from 'esbuild';
import * as fs from 'node:fs';

const outDir = 'dist';
fs.mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: 'node',
  target: 'node18',
  external: ['vscode', 'node-pty', 'cpu-features', 'nan'],
  outfile: `${outDir}/extension.js`,
  logLevel: 'info',
});

if (result.warnings.length > 0) {
  for (const w of result.warnings) {
    console.warn('[esbuild warn]', w.text);
  }
}
const size = fs.statSync(`${outDir}/extension.js`).size;
console.log(`esbuild bundle → dist/extension.js (${(size / 1024).toFixed(1)} KB)`);
