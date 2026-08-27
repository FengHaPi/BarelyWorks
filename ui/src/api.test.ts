import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("request", () => {
  it("uses a JSON error message when one is available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "输入无效" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(request("/api/test")).rejects.toThrow("输入无效");
  });

  it("turns a non-JSON error page into a readable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html><body>Bad gateway</body></html>", {
      status: 502,
      statusText: "Bad Gateway",
    })));

    await expect(request("/api/test")).rejects.toThrow("Bad gateway");
  });

  it("aborts a request after its timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));

    const pending = expect(request("/api/slow", { timeoutMs: 25 })).rejects.toThrow("请求超时");
    await vi.advanceTimersByTimeAsync(25);
    await pending;
  });

  it("distinguishes caller cancellation from timeout", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));

    const pending = expect(request("/api/cancel", { signal: controller.signal })).rejects.toThrow("请求已取消");
    controller.abort();
    await pending;
  });
});
