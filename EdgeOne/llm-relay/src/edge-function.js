// Edge Function 入口薄壳。
// CLI 为 functions/[[default]].js 生成的路由正则是 ^/(.+?)$ —— 斜杠后至少一个
// 字符，因此根路径 / 匹配不上（由 middleware.js 兜住）。
// 全部逻辑在 ./index.js，两个入口共用。
import { handleRequest } from './index.js';

export async function onRequest(context) {
  return handleRequest(context.request);
}
