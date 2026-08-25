/*
  LLM API 反向代理 —— EdgeOne Pages Edge Functions

  移植自 Script/viperadnan/booster.js（Cloudflare Workers）。
  选它的理由：全仓库九个脚本里，只有它把响应正文原样传出
  （`new Response(fetchedResponse.body, ...)`），不看 Content-Type、不做
  改写。其余脚本都会对 json/text/html 调 await text()，那会把 SSE 流
  整段攥住直到上游说完最后一个字 —— LLM 的逐字输出就没了。

  定位：最薄的 EdgeOne 适配层 + 为 API 场景做的必要加固。

  与上游 booster.js 的差异，逐条：

  平台适配（不改就跑不起来）：
    1. 事件入口     addEventListener('fetch') → onRequest(context)，
                    双入口（[[default]] 路由 + 根路径 middleware）共用
    2. 地理与 IP     cf-ipcountry / cf-connecting-ip → request.eo
    3. 删 cf 选项    cacheEverything / mirage / polish / minify / scrapeShield
                    全是 Cloudflare 专有字段，EdgeOne 不认，留着是死配置

  场景适配（LLM API 反代所需）：
    4. 请求体        await request.text() → arrayBuffer()
                    text() 会按 UTF-8 解码，二进制体（音频转写、图片理解）
                    会被破坏
    5. 防火墙        上游默认 blockedRegion: ['CN', ...] —— 中国大陆在黑名单
                    第一位，原样搬过来自己先被 403。改为默认空
    6. 新增 CORS     浏览器端带 Authorization 调 API 时 '*' 非法，须回显 origin；
                    错误响应同样回显，否则浏览器只看到网络错误而非真实状态码
    7. 前缀路由      多上游映射表（PROVIDERS），值支持 '主机/路径基座'；
                    登记未配置的前缀显式 503，绝不静默改道默认上游

  删除项（API 场景无意义的上游功能）：
    8. 移动端分流 isMobile/mobileRedirect；x-pjax-url 头
*/

import { config, resolveUpstream } from './config.js';
import { applyCors, handlePreflight } from './cors.js';

/*
  边缘不得改写、必须原样透传的响应类型。

  SSE 的 content-type 是 text/event-stream —— 注意它含 'text/'。任何
  "见 text/ 就 await text()" 的写法都会吃掉流式。这个集合的存在就是
  为了把这类协议在分支判断的最前面拦下来。
*/
const STREAMING_TYPES = [
  'text/event-stream',        // SSE：OpenAI / Anthropic / Gemini 流式
  'application/x-ndjson',     // NDJSON：Ollama 流式
  'application/stream+json',
  'application/jsonl',
];

function isStreaming(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return STREAMING_TYPES.some((t) => ct.includes(t));
}

/*
  逐跳头（hop-by-hop headers）：按 RFC 7230 §6.1 只对单个连接有意义，
  不能转发给上游。connection / keep-alive / transfer-encoding 尤其危险，
  转发过去会和边缘自己的连接管理打架。
*/
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/* EdgeOne 注入的平台头，回源前清掉（对应 CF 的 cf-* 系列） */
const PLATFORM_HEADERS = [
  'eo-connecting-ip',
  'eo-is-mainland',
  'eo-pages-deployment-id',
  'x-nws-log-uuid',
  'cdn-loop',
  'x-forwarded-proto',
];

function buildUpstreamHeaders(request) {
  const headers = new Headers(request.headers);

  for (const h of [...HOP_BY_HOP, ...PLATFORM_HEADERS]) headers.delete(h);

  /* Host 是 fetch 禁改头，运行时按 URL 主机名路由（target 已设为 upstream.host），
     这里无需也无法设置。Origin/Referer 带着代理域名传上去，某些上游会据此
     做来源校验而拒绝。 */
  headers.delete('origin');
  headers.delete('referer');

  // 由边缘补鉴权：客户端不带密钥也能用，密钥不出现在浏览器里
  if (config.injectAuth.enabled && config.injectAuth.apiKey) {
    headers.set(config.injectAuth.headerName, config.injectAuth.headerValue());
  }

  return headers;
}

async function forward(request, eo) {
  const url = new URL(request.url);
  const upstream = resolveUpstream(url.pathname);

  if (!upstream) {
    return jsonError(404, 'no_upstream', `No upstream configured for path: ${url.pathname}`, request.headers.get('origin'));
  }
  if (!upstream.host) {
    // 已知前缀但未配置上游地址（如自建 Ollama 未填公网地址）
    return jsonError(503, 'upstream_unconfigured', `Upstream "${new URL(request.url).pathname.split('/')[1]}" is known but not configured`, request.headers.get('origin'));
  }

  const target = new URL(url);
  target.protocol = 'https:';
  target.host = upstream.host;
  target.port = '';
  target.pathname = upstream.rewritePath(url.pathname);

  // 防自环：上游被配成了代理自己
  if (target.host === url.host) {
    return jsonError(508, 'loop_detected', 'Upstream resolves to this proxy itself', request.headers.get('origin'));
  }

  /*
    请求体用 arrayBuffer 而非 text()。
    上游 booster.js 用的是 text()，会按 UTF-8 解码 —— 传音频（whisper 转写）
    或图片（多模态）时正文会被破坏。GET/HEAD 按规范不能带体。
  */
  const method = request.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : null;

  const upstreamRequest = new Request(target, {
    method,
    headers: buildUpstreamHeaders(request),
    body,
    redirect: 'manual',
  });

  /*
    超时只卡"响应头到达"这一段，不卡正文流。
    AbortController 一旦 abort 会连正在下发的流一起掐断，所以拿到
    response 后立即 clearTimeout —— 长回答（几分钟的推理）才不会被误杀。
  */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

  const started = Date.now();
  let response;
  try {
    response = await fetch(upstreamRequest, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    return jsonError(
      aborted ? 504 : 502,
      aborted ? 'upstream_timeout' : 'upstream_unreachable',
      aborted
        ? `Upstream did not respond within ${config.upstreamTimeoutMs}ms`
        : `Failed to reach ${upstream.host}`,
      request.headers.get('origin'),
    );
  }
  clearTimeout(timer);

  const headers = new Headers(response.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  applyCors(headers, request.headers.get('origin'));

  if (config.debugHeaders) {
    headers.set('x-relay-upstream', upstream.host);
    headers.set('x-relay-ms', String(Date.now() - started));
    if (eo && eo.geo) headers.set('x-relay-pop', eo.geo.countryCodeAlpha2 || '');
  }

  /*
    核心：response.body 原样传出，一个字节都不碰。
    流式响应（SSE/NDJSON）由此逐帧下发，与直连上游的时序一致；
    非流式响应（普通 JSON）同样直通 —— 反正我们不需要改写内容，
    读出来再塞回去只是白白多一次全量缓冲。
  */
  if (isStreaming(headers.get('content-type'))) {
    // 显式关掉可能的中间缓冲，确保逐帧下发
    headers.set('cache-control', 'no-cache, no-transform');
    headers.set('x-accel-buffering', 'no');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/* 错误响应同样要走 CORS 回显 —— 否则浏览器里带 Authorization 的调用
   收到的是被 CORS 拦截的网络错误，而不是真实的 404/504 状态码。 */
function jsonError(status, code, message, requestOrigin) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  applyCors(headers, requestOrigin);
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

/* 统一入口：Edge Function 与根路径中间件共用 */
export async function handleRequest(request) {
  if (request.method === 'OPTIONS') return handlePreflight(request);

  const eo = request.eo || {};

  if (config.blockedRegions.length > 0) {
    const region = eo.geo && eo.geo.countryCodeAlpha2;
    if (region && config.blockedRegions.includes(region.toUpperCase())) {
      return jsonError(403, 'region_blocked', 'Not available in your region', request.headers.get('origin'));
    }
  }

  if (config.blockedIps.length > 0 && eo.clientIp) {
    if (config.blockedIps.includes(eo.clientIp)) {
      return jsonError(403, 'ip_blocked', 'Your IP is blocked', request.headers.get('origin'));
    }
  }

  try {
    return await forward(request, eo);
  } catch (err) {
    console.error('relay error:', err && err.stack ? err.stack : err);
    return jsonError(500, 'internal_error', 'Proxy encountered an internal error', request.headers.get('origin'));
  }
}
