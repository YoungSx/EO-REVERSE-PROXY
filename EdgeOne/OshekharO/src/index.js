/*
   EO-REVERSE-PROXY — EdgeOne Pages Edge Functions 版
   移植自 Script/OshekharO/beta.js (Cloudflare Workers)。

   定位：最薄的 EdgeOne 适配层 —— 只做平台差异，不替上游改进功能。
   与 CF 原版的差异全部标了 [EO]，除此之外逻辑逐字未改：

   平台适配（不改就跑不起来）：
     1. 事件入口     addEventListener('fetch') → handleRequest 导出，双入口共用
     2. 地理/IP 来源  cf-ipcountry / cf-connecting-ip → request.eo
     3. 回源头清理    cf-* → eo-* / cdn-loop 系列
     4. HTMLRewriter  平台无此 API，靠 ./htmlrewriter.js 垫片提供同名全局
                     （lol-html WASM，语义与 CF 一致）
     5. TextRewriter  lol-html 按 1024 字节切分文本节点（CF 原生按整节点回调），
                     原版「攒到末尾再 replace」在此会丢全文，改为逐块替换
     6. 编码头剥离    改写正文前剥 content-encoding/length（见对应位置注释）

   配置语义补全：
     7. targetMain/use_www  目标站主域不再强制加 www（HN 无 www 子域，
                           硬编码会导致回源解析失败挂到超时）
     8. injection_script    为空时跳过注入分支直接流出，避免无谓的全页缓冲

   其余 handler 类（AttributeRewriter 等 4 个）与上游零改动。
*/

// [EO] 引入 HTMLRewriter 垫片：把 HTMLRewriter 挂到 globalThis，下方代码无需感知
import './htmlrewriter.js';

// [EO] 对外访问域名：既是 custom 主域（入口 Host 映射），也是 HTML 内域名替换的目标。
// 原上游填的是脚本作者自己的 goindex.eu.org（解析到 Cloudflare，与本部署无关），
// 会把页面里所有链接改写到第三方站点。
//
// 当前用平台预设域名 relay.edgeone.dev（项目名即子域名）。代价：预设域名在
// 中国大陆网络一律返回 401（平台合规闸门，"不含中国大陆"区域下连预览 token
// 都不豁免），因此本站目前仅境外可直连。
// 若要让大陆直连，改为自有域名并在控制台绑定即可（"不含中国大陆"区域下绑
// 自有域名无需备案与实名）。换域名只改这一处。
const PUBLIC_HOST = 'relay.edgeone.dev';

const config = {
  domains: {
    custom: {
      main: PUBLIC_HOST,
      subdomains: ['www']
    },
    target: {
      // [EO] 测试站点：Hacker News（原 literotica.com，换站只动这里和 replace_dict）
      main: 'news.ycombinator.com',
      // 目标站是否有 www 子域：HN 没有 www.news.ycombinator.com，
      // 映射生成时按此开关决定是否给主域加前缀
      use_www: false,
      subdomains: []
    }
  },
  blocked_region: ['CU'],
  blocked_ip_address: ['0.0.0.0', '127.0.0.1'],
  https: true,
  disable_cache: false,
  replace_dict: {
    'news.ycombinator.com': PUBLIC_HOST
  },
  security_headers: {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  },
  injection_script: ''
};

// Domain Mappings
// [EO] 目标站主域是否带 www 前缀由 config.domains.target.use_www 决定，
// 不再硬编码（HN 没有 www 子域，literotica 有）。
function targetMain() {
  const { main, use_www } = config.domains.target;
  return use_www ? `www.${main}` : main;
}

function generateDomainMappings() {
  const mappings = {};
  const targetMainHost = targetMain();

  // Custom main -> target main（custom 侧保留裸域与 www 两种入口）
  mappings[config.domains.custom.main] = targetMainHost;
  mappings[`www.${config.domains.custom.main}`] = targetMainHost;

  // Subdomains：同名一一对应（custom sub -> target 同名 sub）
  config.domains.custom.subdomains.forEach(subdomain => {
    if (subdomain !== 'www') {
      mappings[`${subdomain}.${config.domains.custom.main}`] =
        `${subdomain}.${config.domains.target.main}`;
    }
  });

  return mappings;
}

function generateReverseMappings() {
  const reverse = {};
  const targetMainHost = targetMain();

  // Target main -> custom main（裸域与 www 双入口都映射回 custom 主域）
  reverse[targetMainHost] = config.domains.custom.main;
  reverse[`www.${targetMainHost}`] = `www.${config.domains.custom.main}`;

  // Subdomains
  config.domains.target.subdomains.forEach(subdomain => {
    if (subdomain !== 'www') {
      reverse[`${subdomain}.${config.domains.target.main}`] =
        `${subdomain}.${config.domains.custom.main}`;
    }
  });

  return reverse;
}

const domain_map = generateDomainMappings();
const reverse_map = generateReverseMappings();

// [EO] 统一入口：Edge Function（functions/[[default]].js）与根路径中间件
// （middleware.js）共用。为什么需要中间件：CLI 为 [[default]] 生成的路由正则是
// ^/(.+?)$，要求斜杠后至少一个字符 —— 根路径 / 永远匹配不上，会被静态层
// 抢先返回平台 404。中间件在静态层之前执行，补上这个洞。
export async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }
  return fetchAndApply(request);
}

async function fetchAndApply(request) {
  try {
    // [EO] 地理与客户端 IP 从 request.eo 读取（CF 原为 cf-ipcountry / cf-connecting-ip 请求头）
    const eo = request.eo || {};
    const region = eo.geo && eo.geo.countryCodeAlpha2
      ? eo.geo.countryCodeAlpha2.toUpperCase()
      : undefined;
    const ip_address = eo.clientIp;
    const user_agent = request.headers.get('user-agent');

    // Header validation
    if (!region || !ip_address || !user_agent) {
      return new Response('Access denied: Missing required headers.', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
      });
    }

    if (config.blocked_region.includes(region)) {
      return new Response('Access denied: Region blocked.', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
      });
    }

    if (config.blocked_ip_address.includes(ip_address)) {
      return new Response('Access denied: IP blocked.', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
      });
    }

    const url = new URL(request.url);
    const incomingHost = url.hostname;
    // [EO] fallback 走 targetMain()，不硬编码 www. —— 部署域（*.edgeone.cool、
    // 预览域）不在 domain_map 里，会落到这里。目标站若无 www 子域（如 HN），
    // 硬编码的 www.<main> 解析不出来，fetch 会一直挂到 15s 超时 → 平台 504。
    const targetDomain = domain_map[incomingHost] || targetMain();

    // Prevent loop
    if (incomingHost === targetDomain) {
      return new Response('Loop detected', { status: 508 });
    }

    console.log(`Proxying ${incomingHost} -> ${targetDomain}${url.pathname}`);

    url.hostname = targetDomain;
    url.protocol = config.https ? 'https:' : 'http:';
    url.port = '';

    const modifiedRequest = await createModifiedRequest(request, url, targetDomain, incomingHost);

    // Timeout controller
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(modifiedRequest, { signal: controller.signal }).catch(() => null);
    clearTimeout(timeout);

    if (!response) return new Response('Upstream Timeout', { status: 504 });

    return await processResponse(response, targetDomain, incomingHost);

  } catch (err) {
    console.error('Error:', err);
    return new Response('Internal Server Error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
    });
  }
}

async function createModifiedRequest(originalRequest, targetUrl, targetDomain, incomingHost) {
  const headers = new Headers(originalRequest.headers);
  // Host 是 fetch 禁改头，运行时按 URL 主机名路由；上游原版这行是死代码，保留 diff 干净故不照搬
  headers.set('Referer', `${targetUrl.protocol}//${targetDomain}`);
  // [EO] 清理平台注入头：CF 为 cf-connecting-ip / cf-ipcountry / cf-ray
  headers.delete('eo-connecting-ip');
  headers.delete('eo-is-mainland');
  headers.delete('eo-pages-deployment-id');
  headers.delete('x-nws-log-uuid');
  headers.delete('cdn-loop');

  // Safely clone body for non-GET/HEAD
  let body = null;
  if (originalRequest.method !== 'GET' && originalRequest.method !== 'HEAD') {
    body = await originalRequest.clone().arrayBuffer();
  }

  return new Request(targetUrl, {
    method: originalRequest.method,
    headers,
    body,
    redirect: 'manual'
  });
}

// HTMLRewriter Element Handler for rewriting URL attributes
class AttributeRewriter {
  constructor(attributeName, incomingHost) {
    this.attributeName = attributeName;
    this.incomingHost = incomingHost;
  }

  element(element) {
    const attribute = element.getAttribute(this.attributeName);
    if (attribute) {
      const rewritten = rewriteUrl(attribute, this.incomingHost);
      if (rewritten !== attribute) {
        element.setAttribute(this.attributeName, rewritten);
      }
    }
  }
}

// HTMLRewriter Element Handler for elements with multiple URL attributes
class MultiAttributeRewriter {
  constructor(attributes, incomingHost) {
    this.attributes = attributes;
    this.incomingHost = incomingHost;
  }

  element(element) {
    for (const attr of this.attributes) {
      const value = element.getAttribute(attr);
      if (value) {
        // Special handling for srcset attribute
        const rewritten = attr === 'srcset'
          ? rewriteSrcset(value, this.incomingHost)
          : rewriteUrl(value, this.incomingHost);
        if (rewritten !== value) {
          element.setAttribute(attr, rewritten);
        }
      }
    }
  }
}

// HTMLRewriter Element Handler for meta tags with URL content
class MetaRewriter {
  constructor(incomingHost) {
    this.incomingHost = incomingHost;
  }

  element(element) {
    const httpEquiv = element.getAttribute('http-equiv');
    const property = element.getAttribute('property');
    const name = element.getAttribute('name');
    const content = element.getAttribute('content');

    if (!content) return;

    // Only rewrite content for meta tags that are known to contain URLs
    const isRefresh = httpEquiv && httpEquiv.toLowerCase() === 'refresh';
    const isOgUrl = property && (property === 'og:url' || property === 'og:image' || property === 'og:video');
    const isTwitterUrl = name && (name === 'twitter:url' || name === 'twitter:image');

    if (isRefresh || isOgUrl || isTwitterUrl) {
      const rewritten = rewriteUrl(content, this.incomingHost);
      if (rewritten !== content) {
        element.setAttribute('content', rewritten);
      }
    }
  }
}

// HTMLRewriter Text Handler for rewriting text content
//
// [EO] 与 CF 原生的差异：lol-html（wasm）按 1024 字节切分长文本节点，
// 一个 <script>/<style> 会触发多次 text() 回调。实测分块规律：内容全部
// 落在非末尾块（各 ≤1024B），lastInTextNode === true 的末尾块恒为 0 字节
// 空段 —— 对它 replace 无效（输出为空），CF 原版「攒到末尾再 replace」的
// 写法在这里等于丢弃全文。
// 因此改为：每个非末尾块就地 replace（改写只依赖本块文本，无跨块状态，
// 域名替换天然不会跨 1KB 边界漏配）；0 字节末尾块不调用任何方法直接跳过。
class TextRewriter {
  constructor(incomingHost) {
    this.incomingHost = incomingHost;
  }

  text(text) {
    if (text.lastInTextNode && text.text.length === 0) return;
    const rewritten = rewriteTextContent(text.text, this.incomingHost);
    if (rewritten !== text.text) {
      text.replace(rewritten);
    }
  }
}

// Check if hostname matches target domain (exact match or subdomain)
function isTargetDomain(hostname) {
  const targetMain = config.domains.target.main;
  return hostname === targetMain || hostname.endsWith('.' + targetMain);
}

// Rewrite URL to use custom domain
function rewriteUrl(url, incomingHost) {
  if (!url) return url;

  try {
    // Handle absolute URLs with protocol
    if (url.startsWith('https://') || url.startsWith('http://')) {
      const urlObj = new URL(url);
      if (isTargetDomain(urlObj.hostname)) {
        urlObj.hostname = getCustomDomain(urlObj.hostname);
        urlObj.protocol = 'https:';
        return urlObj.toString();
      }
    }
    // Handle protocol-relative URLs
    else if (url.startsWith('//')) {
      const hostname = url.slice(2).split('/')[0];
      if (isTargetDomain(hostname)) {
        const customDomain = getCustomDomain(hostname);
        return url.replace(`//${hostname}`, `//${customDomain}`);
      }
    }
  } catch (e) {
    // URL parsing may fail for malformed URLs or relative paths - return original
  }

  return url;
}

// Rewrite srcset attribute (handles multiple URLs with descriptors)
function rewriteSrcset(srcset, incomingHost) {
  if (!srcset) return srcset;

  // srcset format: "url1 1x, url2 2x" or "url1 100w, url2 200w"
  return srcset.split(',').map(entry => {
    const trimmed = entry.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 1) {
      parts[0] = rewriteUrl(parts[0], incomingHost);
    }
    return parts.join(' ');
  }).join(', ');
}

// Replace domain occurrences in text (shared logic for rewriteTextContent and replace_all_domains)
function replaceDomains(text) {
  let result = text;
  const allTargetDomains = Object.keys(reverse_map);

  for (const targetDomain of allTargetDomains) {
    const customDomain = reverse_map[targetDomain];

    // Replace full URLs with protocol
    result = result.replace(
      new RegExp(`https?://${escapeRegExp(targetDomain)}`, 'gi'),
      `https://${customDomain}`
    );

    // Replace protocol-relative URLs
    result = result.replace(
      new RegExp(`//${escapeRegExp(targetDomain)}`, 'gi'),
      `//${customDomain}`
    );
  }

  return result;
}

// Apply text replacements from replace_dict
function applyReplaceDict(text) {
  let result = text;
  for (const [key, value] of Object.entries(config.replace_dict)) {
    const re = new RegExp(escapeRegExp(key), 'gi');
    result = result.replace(re, value);
  }
  return result;
}

// Rewrite text content to replace target domains (for HTMLRewriter)
function rewriteTextContent(text, incomingHost) {
  let result = applyReplaceDict(text);
  return replaceDomains(result);
}

// Create HTMLRewriter with all necessary handlers
function createHTMLRewriter(incomingHost) {
  return new HTMLRewriter()
    // Rewrite href attributes on anchor and link tags
    .on('a', new AttributeRewriter('href', incomingHost))
    .on('link', new AttributeRewriter('href', incomingHost))
    // Rewrite multiple attributes on media elements
    .on('img', new MultiAttributeRewriter(['src', 'data-src', 'srcset'], incomingHost))
    .on('video', new MultiAttributeRewriter(['src', 'poster'], incomingHost))
    .on('audio', new AttributeRewriter('src', incomingHost))
    .on('source', new MultiAttributeRewriter(['src', 'srcset'], incomingHost))
    // Rewrite src on script and iframe
    .on('script', new AttributeRewriter('src', incomingHost))
    .on('iframe', new AttributeRewriter('src', incomingHost))
    // Rewrite action attributes on forms
    .on('form', new AttributeRewriter('action', incomingHost))
    // Rewrite content in meta tags that contain URLs (og:url, og:image, twitter:url, etc.)
    .on('meta', new MetaRewriter(incomingHost))
    // Rewrite data attributes that may contain URLs
    .on('*', new MultiAttributeRewriter(['data-url', 'data-href'], incomingHost))
    // Rewrite inline scripts and styles that may contain URLs
    .on('script', new TextRewriter(incomingHost))
    .on('style', new TextRewriter(incomingHost));
}

async function processResponse(originalResponse, targetDomain, incomingHost) {
  const headers = new Headers(originalResponse.headers);

  if (config.disable_cache) {
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    headers.set('Pragma', 'no-cache');
    headers.set('Expires', '0');
  }

  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', '*');
  headers.set('Access-Control-Allow-Credentials', 'true');

  headers.delete('Content-Security-Policy');
  headers.delete('Content-Security-Policy-Report-Only');
  headers.delete('Clear-Site-Data');

  Object.entries(config.security_headers).forEach(([key, value]) => headers.set(key, value));

  // Rewrite redirects
  if ([301, 302, 303, 307, 308].includes(originalResponse.status)) {
    const loc = headers.get('location');
    if (loc) {
      try {
        const u = new URL(loc, `https://${targetDomain}`);
        if (isTargetDomain(u.hostname)) {
          u.hostname = getCustomDomain(u.hostname);
          headers.set('location', u.toString());
        }
      } catch (e) {
        console.error('Error parsing location header:', e);
      }
    }
  }

  // Handle X-Pjax-Url header
  if (headers.get('X-Pjax-Url')) {
    const pjaxUrl = headers.get('X-Pjax-Url');
    try {
      const pjaxUrlObj = new URL(pjaxUrl);
      if (isTargetDomain(pjaxUrlObj.hostname)) {
        const customDomain = getCustomDomain(pjaxUrlObj.hostname);
        pjaxUrlObj.hostname = customDomain;
        headers.set('X-Pjax-Url', pjaxUrlObj.toString());
      }
    } catch (e) {
      // If URL parsing fails, try simple replacement
      const newPjaxUrl = pjaxUrl.replace(`//${targetDomain}`, `//${incomingHost}`);
      headers.set('X-Pjax-Url', newPjaxUrl);
    }
  }

  const contentType = headers.get('content-type') || '';

  // Use HTMLRewriter for HTML content (streaming, more efficient)
  if (contentType.includes('text/html')) {
    // [EO] 上游若为 gzip/br，边缘节点不会自动解压，先剥掉编码头再交给 HTMLRewriter
    headers.delete('content-encoding');
    headers.delete('content-length');

    const rewriter = createHTMLRewriter(incomingHost);
    const transformedResponse = rewriter.transform(
      new Response(originalResponse.body, {
        status: originalResponse.status,
        statusText: originalResponse.statusText,
        headers
      })
    );
    if (!config.injection_script) {
      // 无注入内容时保持流式，不缓冲整页
      return transformedResponse;
    }
    const text = await transformedResponse.text();
    const injected = text.replace(/<\/body>/i, `${config.injection_script}</body>`);
    if (injected === text) {
      return new Response(text + config.injection_script, {
        status: transformedResponse.status,
        statusText: transformedResponse.statusText,
        headers: transformedResponse.headers
      });
    }
    return new Response(injected, {
      status: transformedResponse.status,
      statusText: transformedResponse.statusText,
      headers: transformedResponse.headers
    });
  }

  // Use regex-based replacement for non-HTML text content (JSON, JavaScript, CSS)
  if (contentType.includes('text/') ||
      contentType.includes('application/json') ||
      contentType.includes('application/javascript') ||
      contentType.includes('application/x-javascript')) {
    const text = await originalResponse.text();
    const body = await replace_all_domains(text, incomingHost);
    // [EO] 同上：正文已解码且长度已变，剥掉原编码/长度头
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(body, {
      status: originalResponse.status,
      statusText: originalResponse.statusText,
      headers
    });
  }

  // Return binary content as-is
  return new Response(originalResponse.body, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers
  });
}

function getCustomDomain(targetHostname) {
  // Exact match first
  if (reverse_map[targetHostname]) {
    return reverse_map[targetHostname];
  }

  // Then check for subdomain matches
  for (const [target, custom] of Object.entries(reverse_map)) {
    if (targetHostname.endsWith('.' + target)) {
      // Replace the target part with custom part
      const subdomainPart = targetHostname.slice(0, -target.length);
      return subdomainPart + custom;
    }
  }

  // Default to main custom domain
  return config.domains.custom.main;
}

async function replace_all_domains(text, incomingHost) {
  // Apply replace_dict and basic domain replacements using shared functions
  let replaced_text = applyReplaceDict(text);
  replaced_text = replaceDomains(replaced_text);

  // Additional replacements specific to non-HTML content (JSON/JavaScript)
  const allTargetDomains = Object.keys(reverse_map);

  for (const targetDomain of allTargetDomains) {
    const customDomain = reverse_map[targetDomain];

    // Replace in JSON/JavaScript contexts (quoted)
    replaced_text = replaced_text.replace(
      new RegExp(`"${escapeRegExp(targetDomain)}"`, 'gi'),
      `"${customDomain}"`
    );

    replaced_text = replaced_text.replace(
      new RegExp(`'${escapeRegExp(targetDomain)}'`, 'gi'),
      `'${customDomain}'`
    );

    // Replace in various other contexts
    replaced_text = replaced_text.replace(
      new RegExp(`\\\\/${escapeRegExp(targetDomain)}`, 'gi'),
      `\\/${customDomain}`
    );
  }

  // Catch-all for any target domain subdomain that might have been missed
  replaced_text = replaced_text.replace(
    new RegExp(`https?://([a-zA-Z0-9-]+\\.)?${escapeRegExp(config.domains.target.main)}`, 'gi'),
    (match) => {
      const url = new URL(match);
      const customDomain = getCustomDomain(url.hostname);
      return `https://${customDomain}`;
    }
  );

  // Catch-all for protocol-relative URLs
  replaced_text = replaced_text.replace(
    new RegExp(`//([a-zA-Z0-9-]+\\.)?${escapeRegExp(config.domains.target.main)}`, 'gi'),
    (match) => {
      const hostname = match.replace('//', '');
      const customDomain = getCustomDomain(hostname);
      return `//${customDomain}`;
    }
  );

  return replaced_text;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function handleOptions() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    }
  });
}
