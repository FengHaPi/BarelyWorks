import { describe, expect, it } from "vitest";
import { isAllowedBrowserOrigin, localBrowserOrigins } from "../src/server/local-origin";

describe("local browser origin policy", () => {
  it("accepts the production UI, development UI, and non-browser local calls", () => {
    expect(isAllowedBrowserOrigin("http://127.0.0.1:4317")).toBe(true);
    expect(isAllowedBrowserOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedBrowserOrigin(undefined)).toBe(true);
  });

  it("does not trust arbitrary ports or external sites", () => {
    expect(isAllowedBrowserOrigin("http://127.0.0.1:9999")).toBe(false);
    expect(isAllowedBrowserOrigin("https://example.invalid")).toBe(false);
  });

  it("derives the production origin from a configured API port", () => {
    const origins = localBrowserOrigins(6200);
    expect(isAllowedBrowserOrigin("http://127.0.0.1:6200", origins)).toBe(true);
    expect(isAllowedBrowserOrigin("http://127.0.0.1:4317", origins)).toBe(false);
    expect(() => localBrowserOrigins(70_000)).toThrow(/端口/);
  });
});
