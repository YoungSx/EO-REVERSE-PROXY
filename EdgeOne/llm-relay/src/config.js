/*
  配置与上游路由。
*/

/*
  上游供应商表。

  按请求路径的第一段选前缀，一个部署同时代理多家：
    /openai/v1/chat/completions  → api.openai.com/v1/chat/completions
    /claude/v1/messages          → api.anthropic.com/v1/messages

  路径不带已知前缀时落到 DEFAULT_PROVIDER，于是也兼容「整个部署只代理一家」
  的裸路径用法：/v1/chat/completions → api.openai.com/v1/chat/completions。
  这样各家官方 SDK 只改 baseURL 就能用，不必改路径。
*/
export const PROVIDERS = {
  openai: 'api.openai.com',
  claude: 'api.anthropic.com',
  gemini: 'generativelanguage.googleapis.com',
  groq: 'api.groq.com',
  deepseek: 'api.deepseek.com',
  openrouter: 'openrouter.ai',
  ollama: null, // 占位：自建 Ollama 需填你自己的公网地址
};

export const DEFAULT_PROVIDER = 'openai';

/**
 * 由请求路径解析上游主机与回源路径。
 * @returns {{host: string, rewritePath: (p: string) => string} | null}
 */
export function resolveUpstream(pathname) {
  const seg = pathname.split('/')[1] || '';
  const host = PROVIDERS[seg];

  // 命中前缀：剥掉前缀段再回源（/openai/v1/x → /v1/x）
  if (host) {
    return {
      host,
      rewritePath: (p) => p.slice(seg.length + 1) || '/',
    };
  }

  // 未命中：走默认上游，路径原样透传
  const fallback = PROVIDERS[DEFAULT_PROVIDER];
  if (!fallback) return null;
  return { host: fallback, rewritePath: (p) => p };
}

export const config = {
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
    headerName: 'Authorization',
    apiKey: '', // 例：globalThis.OPENAI_API_KEY
    headerValue() {
      return `Bearer ${this.apiKey}`;
    },
  },

  // 上游响应头到达的等待上限。只覆盖「首字节」，不限制正文流的持续时长，
  // 因此长对话不会被它掐断。
  upstreamTimeoutMs: 30000,

  // 是否在响应中附带 x-relay-* 调试头（上游主机、耗时、节点地区）。
  debugHeaders: true,
};
