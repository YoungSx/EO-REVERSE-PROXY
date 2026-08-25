/*
  CORS 处理。

  为什么不能简单写 Access-Control-Allow-Origin: *
    浏览器规定：当请求带凭证（Authorization 头、Cookie）时，'*' 是非法值，
    响应会被直接拒绝。而调 LLM API 必然要带 Authorization —— 所以必须
    回显具体的 origin，并配 Vary: Origin 避免 CDN 把不同来源的响应串味。

  上游 booster.js 完全没做 CORS（它代理的是网页，不是给 JS 调的 API）。
*/

import { config } from './config.js';

// 预检放行的请求头。各家 LLM 的鉴权头名不同，一并列出。
const ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'x-api-key',            // Anthropic
  'anthropic-version',
  'anthropic-beta',
  'x-goog-api-key',       // Gemini
  'openai-organization',
  'openai-beta',
  'http-referer',         // OpenRouter
  'x-title',
].join(', ');

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (config.allowedOrigins.length === 0) return true;
  return config.allowedOrigins.includes(origin);
}

/** 把 CORS 头写入 headers（原地修改）。无 origin 的请求（curl、服务端调用）不需要 CORS，直接跳过。 */
export function applyCors(headers, requestOrigin) {
  if (!isOriginAllowed(requestOrigin)) return headers;

  headers.set('Access-Control-Allow-Origin', requestOrigin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  // 回显值随 origin 变化，必须声明 Vary，否则中间缓存会把 A 站的响应喂给 B 站。
  headers.append('Vary', 'Origin');
  // 让浏览器端能读到流式相关的响应头
  headers.set('Access-Control-Expose-Headers', 'content-type, x-request-id, x-relay-upstream, x-relay-ms');
  return headers;
}

/** OPTIONS 预检：不转发到上游，本地直接应答。 */
export function handlePreflight(request) {
  const origin = request.headers.get('origin');
  const headers = new Headers({
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    // 优先回显客户端实际请求的头，兼容各家 SDK 的自定义头；缺省时给白名单。
    'Access-Control-Allow-Headers':
      request.headers.get('access-control-request-headers') || ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
  });
  applyCors(headers, origin);
  return new Response(null, { status: 204, headers });
}
