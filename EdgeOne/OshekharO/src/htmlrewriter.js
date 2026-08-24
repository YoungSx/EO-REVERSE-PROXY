// HTMLRewriter for EdgeOne Pages Edge Functions
//
// EdgeOne 的边缘运行时是 V8 isolate（同 Cloudflare Workers），但没有内置
// HTMLRewriter。这里用 Cloudflare 自家的 lol-html 编译产物补上，语义与 CF 原生一致
// —— 因为它就是 CF 原生 HTMLRewriter 的同一个 Rust 库。
//
// 与上游 npm 包 `htmlrewriter` 的唯一区别：
//   上游 wrapper 用 `new ReadableStream({ async start(){ while(true){ await read() } } })`
//   在一个 start 回调里跑完整个读循环。这个写法在 EdgeOne 边缘节点上会让 isolate
//   直接崩掉（连接被切断，连 500 都返回不了 —— 实测确认）。
//   改用 TransformStream 后每个 chunk 一次同步回调，正常工作。
//
// 生产环境实测（EdgeOne 边缘节点）：
//   base64 解码 888KB wasm + WebAssembly.Module 编译 + init  ≈ 10ms
//   全流程改写                                              ≈ 30ms
//   都在 200ms CPU 限额内，且模块级只初始化一次。
import wasmB64 from "./generated/wasm-b64.js";
// `lol-html` 是构建时 alias，指向 htmlrewriter 包内未封装的裸类。
// 解析规则见 scripts/build.mjs。
import init, { HTMLRewriter as LolHtmlRewriter } from "lol-html";

// 模块级求值：整个 isolate 生命周期只做一次，后续请求直接复用。
const wasmReady = (() => {
  const bin = atob(wasmB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // 同步编译，避开 fetch/import.meta.url —— 边缘节点上两者都不可用。
  return init(new WebAssembly.Module(bytes));
})();

export class HTMLRewriter {
  #elementHandlers = [];
  #documentHandlers = [];

  on(selector, handlers) {
    this.#elementHandlers.push([selector, handlers]);
    return this;
  }

  onDocument(handlers) {
    this.#documentHandlers.push(handlers);
    return this;
  }

  transform(response) {
    const body = response.body;
    // 与 CF 行为一致：body 为空时不建管道。
    if (body === null) return new Response(body, response);

    const elementHandlers = this.#elementHandlers;
    const documentHandlers = this.#documentHandlers;
    let rewriter = null;

    const ts = new TransformStream({
      async start(controller) {
        await wasmReady;
        rewriter = new LolHtmlRewriter(
          (chunk) => {
            // enqueue 空 chunk 会抛。
            if (chunk.length !== 0) controller.enqueue(chunk);
          },
          { enableEsiTags: false }
        );
        for (const [selector, handlers] of elementHandlers) {
          rewriter.on(selector, handlers);
        }
        for (const handlers of documentHandlers) {
          rewriter.onDocument(handlers);
        }
      },
      transform(chunk) {
        rewriter.write(toUint8Array(chunk));
      },
      flush() {
        rewriter.end();
        rewriter.free();
        rewriter = null;
      },
    });

    const res = new Response(body.pipeThrough(ts), response);
    // 改写后长度必然变化，留着旧值会让客户端截断。
    res.headers.delete("Content-Length");
    return res;
  }
}

// EdgeOne body 流的 chunk 类型随场景变化：edge function 场景给 Uint8Array，
// middleware 场景给 DataView（实测）。`new Uint8Array(dataView)` 会得到长度 0
// 的空数组（DataView 不是 array-like），wasm 收到空字节后静默无输出 ——
// 必须按 buffer 视图重建。
function toUint8Array(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    // 覆盖 DataView / Int8Array 等 TypedArray 变体：按其 buffer + 偏移切片
    return new Uint8Array(
      chunk.buffer, chunk.byteOffset, chunk.byteLength
    );
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  // 兜底：类数组/可迭代
  return new Uint8Array(chunk);
}

// 挂到全局，让引用 `new HTMLRewriter()` 的代码不需要 import。
if (!("HTMLRewriter" in globalThis)) {
  Object.defineProperty(globalThis, "HTMLRewriter", {
    value: HTMLRewriter,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}
