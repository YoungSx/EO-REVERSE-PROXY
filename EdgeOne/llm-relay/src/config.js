/*
  配置与上游路由。
*/

/*
  上游供应商表 —— 前缀 → 上游主机 的映射。

  按请求路径的第一段选前缀，一个部署同时代理多家：
    /openai/v1/chat/completions  → api.openai.com/v1/chat/completions
    /claude/v1/messages          → api.anthropic.com/v1/messages

  路径不带已知前缀时落到 DEFAULT_PROVIDER，于是也兼容「整个部署只代理一家」
  的裸路径用法：/v1/chat/completions → api.openai.com/v1/chat/completions。
  这样各家官方 SDK 只改 baseURL 就能用，不必改路径。

  扩展规则（加任意多对映射只动这张表）：
    - 新增一行即新增一条「前缀 → 上游」映射，转发逻辑零改动
    - 值填 null = 登记前缀但暂不配置：请求会得到显式 503，
      绝不会静默改道默认上游（用户的前缀是明确的意图表达）
    - 值可带路径基座，如 'api.example.com/openai-compatible'：
      回源时会拼在前缀之后（见 resolveUpstream）
    - DEFAULT_PROVIDER 必须指向表中已配置的键，否则裸路径用法返回 404
*/
export const PROVIDERS = {
  openai: 'api.openai.com',
  claude: 'api.anthropic.com',
  gemini: 'generativelanguage.googleapis.com',
  groq: 'api.groq.com',
  deepseek: 'api.deepseek.com',
  openrouter: 'openrouter.ai',
  ollama: null, // 已登记前缀但未配置。自建 Ollama 填公网地址即可启用；
                // 未填时请求 /ollama/* 会得到显式 503，而非静默转给默认上游
};

export const DEFAULT_PROVIDER = 'openai';

/**
 * 由请求路径解析上游主机与回源路径。
 * 命中已知前缀但该上游未配置（host 为空）时返回 { host: null } ——
 * 调用方必须显式报错，绝不能静默改道默认上游：用户写 /ollama/* 是明确的
 * 意图表达，悄悄转给 OpenAI 只会让对方收到一头雾水的 404。
 *
 * 上游值支持路径基座：'api.example.com/v1' 表示该上游所有接口都挂在
 * /v1 下。命中时回源路径 = 基座 + 前缀后的剩余路径：
 *   /myai/chat/completions → api.example.com/v1/chat/completions
 * @returns {{host: string | null, rewritePath: (p: string) => string} | null}
 */
export function resolveUpstream(pathname) {
  /* 'host/base' → { host, base }；纯 'host' → base 为 '' */
  const splitEntry = (entry) => {
    const slash = entry.indexOf('/');
    return slash === -1
      ? { host: entry, base: '' }
      : { host: entry.slice(0, slash), base: entry.slice(slash) };
  };

  const seg = pathname.split('/')[1] || '';

  // 命中前缀：回源路径 = 基座 + 去前缀的剩余（/openai/v1/x → /v1/x）
  if (seg in PROVIDERS) {
    const entry = PROVIDERS[seg];
    if (!entry) return { host: null, rewritePath: (p) => p };
    const { host, base } = splitEntry(entry);
    return {
      host,
      rewritePath: (p) => base + p.slice(seg.length + 1),
    };
  }

  // 未命中任何前缀：走默认上游，路径原样透传（基座照加）
  const fallback = PROVIDERS[DEFAULT_PROVIDER];
  if (!fallback) return null;
  const { host, base } = splitEntry(fallback);
  return {
    host,
    rewritePath: (p) => base + p,
  };
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
  // 仅排查问题时临时打开；x-relay-pop 会把调用者国家暴露给任意网页。
  debugHeaders: false,
};
