# EO-REVERSE-PROXY

> [OshekharO/CF-REVERSE-PROXY](https://github.com/OshekharO/CF-REVERSE-PROXY) 的 fork —— 将其中的反向代理脚本适配到**腾讯云 EdgeOne Pages**（Edge Functions）。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-%E8%85%BE%E8%AE%AF%E4%BA%91%20EdgeOne%20Pages-blue)](https://edgeone.cloud.tencent.com/pages)
[![Upstream](https://img.shields.io/badge/upstream-CF--REVERSE--PROXY-orange)](https://github.com/OshekharO/CF-REVERSE-PROXY)

---

## 📖 本仓库是什么

`Script/` 目录是**原封未动的上游内容**（Cloudflare Workers 脚本及其文档，仅作参考与追溯）；
`EdgeOne/` 目录是本仓库的产出 —— **移植到腾讯 EdgeOne Pages 的版本**：

| 项目 | 移植自 | 场景 | 状态 |
|---|---|---|---|
| [`EdgeOne/llm-relay`](EdgeOne/llm-relay/) | `Script/viperadnan/booster.js` | LLM API 反代（SSE 流式直通、多上游映射表、CORS） | ✅ 已上线 |
| [`EdgeOne/OshekharO`](EdgeOne/OshekharO/) | `Script/OshekharO/beta.js` | 通用网页反代（HTMLRewriter 域名改写） | ✅ 已上线 |

移植原则：**最薄适配层** —— 只改平台差异（事件入口、地理/IP 来源、平台注入头、
HTMLRewriter 垫片），不替上游改进功能。每个项目的文件头注释里有逐条差异清单。

## 📋 适配进度

| 上游脚本 | EdgeOne 版 | 状态 | 备注 |
|---|---|---|---|
| `viperadnan/booster.js` | [`EdgeOne/llm-relay`](EdgeOne/llm-relay/) | ✅ 已上线 | LLM API 场景，SSE 流式直通 + 多上游映射表 |
| `OshekharO/beta.js` | [`EdgeOne/OshekharO`](EdgeOne/OshekharO/) | ✅ 已上线 | 通用网页反代，HTMLRewriter 域名改写 |
| `xiaoyang-sde/index.js` | — | ⬜ 待定 | 最轻量原版，能力 ⊆ OshekharO 版；如需最小参考实现可移植 |
| `OshekharO/worker.js` | — | ⬜ 暂缓 | beta.js 的前身，功能被 beta 完全覆盖，优先级最低 |
| `KusakabeSi/worker.js` | — | ⬜ 待定 | 多站点 + 字符串替换；其 CF 邮件混淆解码仅在代理 CF 站点时有用 |
| `Mikotwa/index.js` | — | ⚠️ 谨慎 | 上游有并发缺陷（模块级全局变量承载请求态），移植前需先修 |
| `Clansty/proxy.js` | — | ⬜ 待定 | Telegram 频道预览专用，按需移植 |
| `ymyuuu/worker.js` | — | ⬜ 待定 | 大而全（含 Bootstrap UI），体量最大，可拆 UI 与转发两部分评估 |

状态说明：✅ 已上线 · ⬜ 待定（后续考虑适配）· ⚠️ 有已知问题需先解决 · ⬜ 暂缓（被现有版本覆盖）

如需 Cloudflare 原版用法，见下方上游原文。

---


## 📖 Overview

**CF-REVERSE-PROXY** lets you deploy a fully functional reverse proxy on Cloudflare's global edge network in minutes. Map any custom domain to any upstream target, enforce access controls, rewrite content on the fly, and serve your users with minimal latency — all without managing infrastructure.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🌍 **Domain & Subdomain Mapping** | Map one or more custom domains/subdomains to upstream targets |
| 🔐 **Region & IP Blocking** | Deny access from specific countries (ISO 3166-1 alpha-2) or IP addresses |
| 🔁 **URL Rewriting** | Automatically rewrite URLs in HTML, JS, CSS, and JSON responses |
| 🧠 **Text Replacement Engine** | Replace arbitrary strings in response bodies via a simple config dictionary |
| ⚡ **HTMLRewriter Support** | Stream-based, efficient HTML transformation using Cloudflare's native `HTMLRewriter` API |
| 🛡️ **Security Headers** | Inject `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, and more |
| 🚫 **Ad Removal** | Strip ad-injecting `<script>` and `<iframe>` blocks from proxied pages |
| 🔗 **CORS Support** | Adds appropriate CORS headers so proxied resources load cleanly in browsers |
| ⚙️ **Zero Infrastructure** | 100% serverless — runs on Cloudflare's edge, no VMs or containers needed |
| 🔒 **HTTPS Enforcement** | Force all upstream connections to use HTTPS |
| ♻️ **Cache Control** | Enable or disable caching with a single config flag |

---

## 📂 Repository Structure

```
EO-REVERSE-PROXY/
├── EdgeOne/            # 本仓库产出：腾讯 EdgeOne Pages 适配版
│   ├── llm-relay/      # LLM API 反代（移植自 viperadnan/booster.js）
│   └── OshekharO/      # 网页反代（移植自 OshekharO/beta.js）
└── Script/             # 上游原封内容（Cloudflare Workers 脚本，仅供参考）
    ├── xiaoyang-sde/   # Original lightweight reverse proxy
    ├── viperadnan/     # Booster — speed, caching, firewall, and route optimizations
    ├── KusakabeSi/     # Multi-site proxy with string replacement & ad removal
    ├── Clansty/        # Telegram channel preview reverse proxy
    ├── Mikotwa/        # HTMLRewriter-based proxy
    ├── ymyuuu/         # Simple general-purpose reverse proxy
    └── OshekharO/      # Enhanced proxy with full subdomain mapping (recommended)
```

---

## 🚀 Quick Start（EdgeOne Pages 版）

以 `llm-relay` 为例（`OshekharO` 同理）：

```bash
cd EdgeOne/llm-relay
npm install
npm run deploy   # 构建 + edgeone makers deploy 到 *.edgeone.dev 预设域名
```

前置条件：安装 [EdgeOne CLI](https://edgeone.cloud.tencent.com/pages/document) 并登录
（`edgeone login`）。`-a overseas` 表示部署在不含中国大陆的区域，绑定自定义域名无需备案。

---

以下为上游原文（Cloudflare Workers 用法）。


---

## 🚀 Quick Start（上游原文 · Cloudflare Workers）

### 1. Open Cloudflare Workers

Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create Application** → **Create Worker**.

### 2. Paste the Script

Pick the script that fits your use case (see [Script Variants](#-script-variants)), copy its contents, and paste it into the Cloudflare Workers online editor, replacing the default code.

### 3. Configure the Script

Edit the `config` object (or top-level constants) at the top of the script:

```js
const config = {
  // Map incoming host → upstream target
  domain_map: {
    'proxy.yourdomain.com': 'www.example.com',
    'cdn.yourdomain.com':   'cdn.example.com',
  },
  default_target:      'www.example.com',

  // Block access by country code (ISO 3166-1 alpha-2)
  blocked_region:      ['CN', 'KP', 'SY', 'PK', 'CU'],

  // Block specific IP addresses
  blocked_ip_address:  ['0.0.0.0', '127.0.0.1'],

  // Force HTTPS for upstream requests
  https:               true,

  // Disable response caching
  disable_cache:       true,

  // Replace text in response bodies
  replace_dict: {
    'example.com':     'yourdomain.com',
    'Premium':         '',
  },
};
```

### 4. Deploy & Bind a Custom Domain

1. Click **Save and Deploy** in the Workers editor.
2. In the Cloudflare dashboard, navigate to your domain → **Workers** → **Add Route**.
3. Enter `https://proxy.yourdomain.com/*` as the route and select your Worker.
4. Add a `CNAME` DNS record:
   - **Name:** `proxy` (or `@` for root)
   - **Target:** `<your-worker-subdomain>.workers.dev`
   - **Proxy status:** Proxied (orange cloud ☁️)

---

## 📦 Script Variants

### [`OshekharO/worker.js`](Script/OshekharO/worker.js) ⭐ Recommended

A full-featured reverse proxy with explicit subdomain mapping, security headers, CORS handling, redirect rewriting, and `X-Pjax-Url` support. Best for production use.

### [`OshekharO/beta.js`](Script/OshekharO/beta.js)

An optimized variant of `worker.js` that adds **streaming HTML transformation** via the native `HTMLRewriter` API, a loop-detection guard, and configurable request timeout handling.

### [`xiaoyang-sde/index.js`](Script/xiaoyang-sde/index.js)

The original lightweight reverse proxy. Simple configuration with `upstream`, `blocked_region`, `blocked_ip_address`, and `replace_dict` constants. Great starting point for basic use cases.

### [`viperadnan/booster.js`](Script/viperadnan/booster.js)

Extends the proxy with performance optimizations: static asset caching, image compression (Polish/Mirage), JavaScript minification, scrape shielding, and region-based routing.

### [`KusakabeSi/worker.js`](Script/KusakabeSi/worker.js)

Supports multiple upstream sites within a single Worker. Includes string replacement, custom resource substitution, Cloudflare email-obfuscation bypass, and optional ad removal from `<script>` and `<iframe>` elements.

### [`Clansty/proxy.js`](Script/Clansty/proxy.js)

Rewritten Telegram channel preview proxy using modern ES-module Workers syntax. Auto-detects its own `BASE_URL`, strips `X-Frame-Options` and `Content-Security-Policy` so the channel loads in an `<iframe>`, rewrites all Telegram CDN and asset URLs through the Worker, and handles "Load more" AJAX calls for infinite scroll.

### [`ymyuuu/worker.js`](Script/ymyuuu/worker.js)

A rewritten general-purpose open proxy using modern ES-module Workers syntax. Features Bootstrap 5 glassmorphism UI, CORS preflight handling, security headers, CSP removal, improved HTML path rewriting (`href`, `src`, `action`, `data-src`), and suffix-based domain blocklist matching.

---

## ⚙️ Configuration Reference

| Key | Type | Description |
|---|---|---|
| `domain_map` | `Object` | Maps incoming hostnames to upstream target hostnames |
| `default_target` | `string` | Fallback upstream when no mapping is found |
| `blocked_region` | `string[]` | ISO 3166-1 alpha-2 country codes to block |
| `blocked_ip_address` | `string[]` | IP addresses to block |
| `https` | `boolean` | Use `https:` for upstream connections |
| `disable_cache` | `boolean` | Set `Cache-Control: no-store` on responses |
| `replace_dict` | `Object` | Key-value pairs for text replacement in response bodies |
| `security_headers` | `Object` | Additional response headers to inject |

---

## ⚠️ Disclaimer

- This project is intended **for educational and legitimate use only**.
- Do **not** use this to proxy sites you do not own or have permission to mirror.
- Do **not** use this to violate Cloudflare's [Terms of Service](https://www.cloudflare.com/terms/) or any applicable laws.
- This script is **free** — do not sell it.
- The authors are not responsible for any misuse or legal consequences.

---

## 🤝 Credits

| Contributor | Contribution |
|---|---|
| [xiaoyang-sde](https://github.com/xiaoyang-sde) | Original Workers-Proxy script |
| [viperadnan-git](https://github.com/viperadnan-git) | Booster — caching, optimization, firewall |
| [KusakabeSi](https://github.com/KusakabeSi) | Multi-site support, string replacement, ad removal |
| [Mikotwa](https://github.com/Mikotwa) | HTMLRewriter integration |
| [Clansty](https://github.com/Clansty) | Telegram channel proxy |
| [ymyuuu](https://github.com/ymyuuu) | General-purpose proxy with UI |
| [OshekharO](https://github.com/OshekharO) | Repository maintainer & enhancements |

---

## 📄 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

---

<p align="center">© 2026 OshekharO · CF-REVERSE-PROXY</p>

