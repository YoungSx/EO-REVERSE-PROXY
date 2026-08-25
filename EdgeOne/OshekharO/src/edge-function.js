// Edge Function 入口薄壳：路由 ^/(.+?)$（除根路径外的所有路径）。
// 全部逻辑在 ./index.js 的 handleRequest，与 middleware.js 共用同一份代码。
import { handleRequest } from "./index.js";

export async function onRequest(context) {
  return handleRequest(context.request);
}
