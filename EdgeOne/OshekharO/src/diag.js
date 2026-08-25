/*
  诊断入口（/__diag）—— 定位「中国大陆访问 504」的归属。

  不引入 HTMLRewriter，不走反代逻辑，只回答三个问题：
    1. 请求落在哪个地区的节点上（node.*，由 EdgeOne 注入的 request.eo 给出）
    2. 该节点回源到境外目标站（news.ycombinator.com）耗时多久、是否超时
    3. 同一节点回源到境内站点（www.qq.com）是否正常 —— 用于区分
       「节点整体不能出网」和「节点出境被阻断/限速」

  探测超时设为 3s（并发），保证本接口自身绝不会 504 —— 它必须能在
  「反代页面 504」的同一节点上活着把结论说出来。
*/

// 3s：两个探测并发跑，保证本接口总耗时远低于平台函数上限，自身绝不 504。
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 12000;

async function probe(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
      signal: controller.signal,
      redirect: 'manual',
    });
    const body = await res.text();
    return {
      // ok 只代表「请求没抛异常」，判定成败必须再看 status：
      // 上游被阻断时节点会回一个 5xx 错误页，fetch 本身是「成功」的。
      ok: res.status < 400,
      completed: true,
      status: res.status,
      bytes: body.length,
      ms: Date.now() - started,
      // 4xx/5xx 时留 200 字符指纹，用来认出这页是 EdgeOne 网关发的还是目标站发的
      snippet: res.status >= 400 ? body.replace(/\s+/g, ' ').slice(0, 200) : undefined,
    };
  } catch (err) {
    return { ok: false, completed: false, error: String((err && err.message) || err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const eo = context.request.eo || {};
  const geo = eo.geo || {};

  // ?t=9000 可放宽单次探测上限（封顶 12s），用于区分「出境被阻断」与「出境只是慢」
  const url = new URL(context.request.url);
  const timeoutMs = Math.min(
    Math.max(parseInt(url.searchParams.get('t') || '', 10) || DEFAULT_TIMEOUT_MS, 500),
    MAX_TIMEOUT_MS
  );

  const [overseas, mainland] = await Promise.all([
    probe('https://news.ycombinator.com/robots.txt', timeoutMs),
    probe('https://www.qq.com/robots.txt', timeoutMs),
  ]);

  const report = {
    client: {
      ip: eo.clientIp || null,
      country: geo.countryCodeAlpha2 || null,
      region: geo.regionName || geo.regionCode || null,
      asn: geo.asn || null,
    },
    // 平台注入的完整上下文：用于看清请求究竟落在哪个地区的节点上
    eo: { keys: Object.keys(eo), geo },
    upstream: { 'news.ycombinator.com': overseas, 'www.qq.com': mainland },
    timeoutMs,
    verdict:
      overseas.ok && mainland.ok ? '节点出网正常，504 与回源无关'
      : !overseas.ok && mainland.ok ? '节点出境不可用（境内可达）→ 这就是 504 的根因：该节点在中国大陆'
      : !overseas.ok && !mainland.ok ? '节点完全不能出网'
      : '境外可达、境内不可达 → 该节点在海外，反代可正常工作',
    now: new Date().toISOString(),
  };

  return new Response(JSON.stringify(report, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
