// esbuild 打包成 EdgeOne Pages Edge Function 单文件。
//
// 用 JS API 而非 CLI，只为一件事：把 `lol-html` 这个裸标识符解析到
// `htmlrewriter/dist/html_rewriter.js`。
//
// 为什么不能直接 import 那个路径：
//   1. 包的 exports 字段封死了深层路径，`htmlrewriter/dist/...` 解析不了；
//   2. 所有公开入口（default/vercel/node/cloudflare）导出的都是套了上游 wrapper 的
//      版本，而那个 wrapper 用的 ReadableStream 写法在 EdgeOne 上会崩
//      （详见 src/htmlrewriter.js 顶部注释），我们需要未封装的裸类。
//   3. 在 src 里写 `../node_modules/...` 能跑，但把依赖布局硬编码进源码。
//      路径解析属于构建配置的职责。
//
// 双入口：
//   src/edge-function.js → functions/[[default]].js  路由 ^/(.+?)$（除根路径）
//   src/middleware.js    → middleware.js             项目根中间件，兜住根路径 /
//   两者的业务逻辑都来自 src/index.js 的 handleRequest，只有入口壳不同。
import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const lolHtml = join(
  dirname(require.resolve("htmlrewriter/package.json")),
  "dist",
  "html_rewriter.js"
);

const common = {
  bundle: true,
  format: "esm",
  // neutral：不注入任何 Node/browser 专属 shim，产物纯 ES2022。
  platform: "neutral",
  target: "es2022",
  alias: { "lol-html": lolHtml },
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
  {
    // 诊断入口：具名路由优先于 catch-all，不含 WASM，产物仅几 KB。
    entry: join(root, "src/diag.js"),
    outfile: join(root, "functions/__diag.js"),
  },
];

for (const { entry, outfile } of entries) {
  const result = await build({ ...common, entryPoints: [entry], outfile });
  const out = Object.entries(result.metafile.outputs)[0];
  console.log(`[build] ${out[0]}  ${(out[1].bytes / 1024).toFixed(0)} KB`);
}
