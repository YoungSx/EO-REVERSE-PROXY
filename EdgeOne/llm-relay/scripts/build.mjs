// esbuild 打包成 EdgeOne Pages Edge Function 单文件。
//
// 双入口（与 EdgeOne/OshekharO 同构，理由相同）：
//   src/edge-function.js → functions/[[default]].js  路由 ^/(.+?)$（根路径匹配不上）
//   src/middleware.js    → middleware.js             项目根中间件，兜住根路径 /
//
// 这个项目不含 wasm，无需路径 alias，配置比 OshekharO 简单。
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const common = {
  bundle: true,
  format: "esm",
  // neutral：不注入任何 Node/browser 专属 shim，产物纯 ES2022。
  platform: "neutral",
  target: "es2022",
  legalComments: "none",
  metafile: true,
};

const entries = [
  {
    entry: join(root, "src/edge-function.js"),
    outfile: join(root, "functions/[[default]].js"),
  },
  {
    // 中间件约定：项目根目录下的 middleware.js（无目录层级）。
    entry: join(root, "src/middleware.js"),
    outfile: join(root, "middleware.js"),
  },
];

for (const { entry, outfile } of entries) {
  const result = await build({ ...common, entryPoints: [entry], outfile });
  const [name, meta] = Object.entries(result.metafile.outputs)[0];
  console.log(`[build] ${name}  ${(meta.bytes / 1024).toFixed(1)} KB`);
}
