// 根路径兜底：CLI 为 functions/[[default]].js 生成的路由正则是 ^/(.+?)$，
// 匹配不了 / 本身 —— 根路径会落到静态资源层返回平台 404。
// 项目根 middleware.js 在静态层之前执行，这里把 / 转交给业务逻辑，
// 其余路径 context.next() 放行走原管线（edge function 或回源）。
import { handleRequest } from "./index.js";

export async function middleware(context) {
  const { pathname } = new URL(context.request.url);
  if (pathname !== "/") {
    return context.next();
  }
  return handleRequest(context.request);
}
