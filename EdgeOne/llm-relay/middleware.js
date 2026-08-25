// src/config.js
var PROVIDERS = {
  openai: "api.openai.com",
  claude: "api.anthropic.com",
  gemini: "generativelanguage.googleapis.com",
  groq: "api.groq.com",
  deepseek: "api.deepseek.com",
  openrouter: "openrouter.ai",
  ollama: null
  // 已登记前缀但未配置。自建 Ollama 填公网地址即可启用；
  // 未填时请求 /ollama/* 会得到显式 503，而非静默转给默认上游
};
var DEFAULT_PROVIDER = "openai";
function resolveUpstream(pathname) {
  const splitEntry = (entry) => {
    const slash = entry.indexOf("/");
    return slash === -1 ? { host: entry, base: "" } : { host: entry.slice(0, slash), base: entry.slice(slash) };
  };
  const seg = pathname.split("/")[1] || "";
  if (seg in PROVIDERS) {
    const entry = PROVIDERS[seg];
    if (!entry) return { host: null, rewritePath: (p) => p };
    const { host: host2, base: base2 } = splitEntry(entry);
    return {
      host: host2,
      rewritePath: (p) => base2 + p.slice(seg.length + 1)
    };
  }
  const fallback = PROVIDERS[DEFAULT_PROVIDER];
  if (!fallback) return null;
  const { host, base } = splitEntry(fallback);
  return {
    host,
    rewritePath: (p) => base + p
  };
}
var config = {
  // 允许携带凭证的来源。'*' 仅在无凭证请求下合法，因此这里按 origin 精确回显，
  // 空数组 = 放行任意来源（仍逐个回显，不输出 '*'）。
  // 生产建议填成白名单，否则任何网页都能借你的代理转发。
  allowedOrigins: [],
  // 地区封锁：留空表示不封。注意不要照搬上游 booster.js 的 ['CN', ...] ——
  // 那会把中国大陆用户挡在门外。
  blockedRegions: [],
  blockedIps: [],
  /*
      由边缘补鉴权（可选）。开启后客户端不必带密钥，密钥也不会出现在浏览器里。
      密钥请通过控制台环境变量注入，不要硬编码进仓库。
  
      注意：一旦开启且 allowedOrigins 为空，等于把你的额度开放给任何人 ——
      两者必须配套使用。
    */
  injectAuth: {
    enabled: false,
    headerName: "Authorization",
    apiKey: "",
    // 例：globalThis.OPENAI_API_KEY
    headerValue() {
      return `Bearer ${this.apiKey}`;
    }
  },
  // 上游响应头到达的等待上限。只覆盖「首字节」，不限制正文流的持续时长，
  // 因此长对话不会被它掐断。
  upstreamTimeoutMs: 3e4,
  // 是否在响应中附带 x-relay-* 调试头（上游主机、耗时、节点地区）。
  // 仅排查问题时临时打开；x-relay-pop 会把调用者国家暴露给任意网页。
  debugHeaders: false
};

// src/cors.js
var ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "x-api-key",
  // Anthropic
  "anthropic-version",
  "anthropic-beta",
  "x-goog-api-key",
  // Gemini
  "openai-organization",
  "openai-beta",
  "http-referer",
  // OpenRouter
  "x-title"
].join(", ");
var ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
function isOriginAllowed(origin) {
  if (!origin) return false;
  if (config.allowedOrigins.length === 0) return true;
  return config.allowedOrigins.includes(origin);
}
function applyCors(headers, requestOrigin) {
  if (!isOriginAllowed(requestOrigin)) return headers;
  headers.set("Access-Control-Allow-Origin", requestOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.append("Vary", "Origin");
  headers.set("Access-Control-Expose-Headers", "content-type, x-request-id, x-relay-upstream, x-relay-ms");
  return headers;
}
function handlePreflight(request) {
  const origin = request.headers.get("origin");
  const headers = new Headers({
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    // 优先回显客户端实际请求的头，兼容各家 SDK 的自定义头；缺省时给白名单。
    "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers") || ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400"
  });
  applyCors(headers, origin);
  return new Response(null, { status: 204, headers });
}

// src/index.js
var STREAMING_TYPES = [
  "text/event-stream",
  // SSE：OpenAI / Anthropic / Gemini 流式
  "application/x-ndjson",
  // NDJSON：Ollama 流式
  "application/stream+json",
  "application/jsonl"
];
function isStreaming(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return STREAMING_TYPES.some((t) => ct.includes(t));
}
var HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];
var PLATFORM_HEADERS = [
  "eo-connecting-ip",
  "eo-is-mainland",
  "eo-pages-deployment-id",
  "x-nws-log-uuid",
  "cdn-loop",
  "x-forwarded-proto"
];
function buildUpstreamHeaders(request, upstreamHost) {
  const headers = new Headers(request.headers);
  for (const h of [...HOP_BY_HOP, ...PLATFORM_HEADERS]) headers.delete(h);
  headers.set("Host", upstreamHost);
  headers.delete("origin");
  headers.delete("referer");
  if (config.injectAuth.enabled && config.injectAuth.apiKey) {
    headers.set(config.injectAuth.headerName, config.injectAuth.headerValue());
  }
  return headers;
}
async function forward(request, eo) {
  const url = new URL(request.url);
  const upstream = resolveUpstream(url.pathname);
  if (!upstream) {
    return jsonError(404, "no_upstream", `No upstream configured for path: ${url.pathname}`, request.headers.get("origin"));
  }
  if (!upstream.host) {
    return jsonError(503, "upstream_unconfigured", `Upstream "${new URL(request.url).pathname.split("/")[1]}" is known but not configured`, request.headers.get("origin"));
  }
  const target = new URL(url);
  target.protocol = "https:";
  target.host = upstream.host;
  target.port = "";
  target.pathname = upstream.rewritePath(url.pathname);
  if (target.host === url.host) {
    return jsonError(508, "loop_detected", "Upstream resolves to this proxy itself", request.headers.get("origin"));
  }
  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : null;
  const upstreamRequest = new Request(target, {
    method,
    headers: buildUpstreamHeaders(request, upstream.host),
    body,
    redirect: "manual"
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  const started = Date.now();
  let response;
  try {
    response = await fetch(upstreamRequest, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === "AbortError";
    return jsonError(
      aborted ? 504 : 502,
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? `Upstream did not respond within ${config.upstreamTimeoutMs}ms` : `Failed to reach ${upstream.host}`,
      request.headers.get("origin")
    );
  }
  clearTimeout(timer);
  const headers = new Headers(response.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  applyCors(headers, request.headers.get("origin"));
  if (config.debugHeaders) {
    headers.set("x-relay-upstream", upstream.host);
    headers.set("x-relay-ms", String(Date.now() - started));
    if (eo && eo.geo) headers.set("x-relay-pop", eo.geo.countryCodeAlpha2 || "");
  }
  if (isStreaming(headers.get("content-type"))) {
    headers.set("cache-control", "no-cache, no-transform");
    headers.set("x-accel-buffering", "no");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
function jsonError(status, code, message, requestOrigin) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  applyCors(headers, requestOrigin);
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}
async function handleRequest(request) {
  if (request.method === "OPTIONS") return handlePreflight(request);
  const eo = request.eo || {};
  if (config.blockedRegions.length > 0) {
    const region = eo.geo && eo.geo.countryCodeAlpha2;
    if (region && config.blockedRegions.includes(region.toUpperCase())) {
      return jsonError(403, "region_blocked", "Not available in your region", request.headers.get("origin"));
    }
  }
  if (config.blockedIps.length > 0 && eo.clientIp) {
    if (config.blockedIps.includes(eo.clientIp)) {
      return jsonError(403, "ip_blocked", "Your IP is blocked", request.headers.get("origin"));
    }
  }
  try {
    return await forward(request, eo);
  } catch (err) {
    console.error("relay error:", err && err.stack ? err.stack : err);
    return jsonError(500, "internal_error", "Proxy encountered an internal error", request.headers.get("origin"));
  }
}

// src/middleware.js
async function middleware(context) {
  const { pathname } = new URL(context.request.url);
  if (pathname !== "/") {
    return context.next();
  }
  return handleRequest(context.request);
}
export {
  middleware
};
