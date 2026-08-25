// 项目根中间件入口。
//
// 中间件对「所有」路径执行，且在静态资源层之前 —— 这正是它能补上根路径的原因：
// functions/[[default]].js 的路由正则 ^/(.+?)$ 匹配不到 /，请求会被静态层
// 抢先返回平台 404。
//
// 非根路径必须 next() 放行，交给 [[default]] 处理，否则同一请求被处理两次。
import { handleRequest } from './index.js';

export async function middleware(context) {
  const { pathname } = new URL(context.request.url);
  if (pathname !== '/') {
    return context.next();
  }
  return handleRequest(context.request);
}
