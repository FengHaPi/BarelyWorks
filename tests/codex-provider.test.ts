import { describe, expect, it } from "vitest";
import {
  defaultCodexTimeoutMs,
  parseCodexJsonl,
  resolveCodexTimeoutMs,
} from "../src/ai/codex-cli-provider";

describe("Codex CLI JSONL diagnostics", () => {
  it("extracts current event fields without making the final output depend on diagnostics", () => {
    const summary = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      "not-json",
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 8 } }),
    ].join("\n"));
    expect(summary.threadId).toBe("thread-1");
    expect(summary.usage).toEqual({ input_tokens: 12, output_tokens: 8 });
    expect(summary.eventTypes).toEqual(["thread.started", "turn.completed"]);
  });

  it("uses longer limits for complex artifacts", () => {
    expect(defaultCodexTimeoutMs.outline).toBe(5 * 60_000);
    expect(defaultCodexTimeoutMs["asset-bible"]).toBe(12 * 60_000);
    expect(defaultCodexTimeoutMs["asset-bible"]).toBeGreaterThan(defaultCodexTimeoutMs.outline);
  });

  it("allows safe global and artifact-specific timeout overrides", () => {
    expect(resolveCodexTimeoutMs("asset-bible", {
      AI_VIDEO_STUDIO_CODEX_TIMEOUT_MS: "600000",
    })).toBe(600_000);
    expect(resolveCodexTimeoutMs("asset-bible", {
      AI_VIDEO_STUDIO_CODEX_TIMEOUT_MS: "600000",
      AI_VIDEO_STUDIO_ASSET_BIBLE_TIMEOUT_MS: "900000",
    })).toBe(900_000);
  });

  it("ignores invalid or unsafe timeout overrides", () => {
    expect(resolveCodexTimeoutMs("asset-bible", {
      AI_VIDEO_STUDIO_ASSET_BIBLE_TIMEOUT_MS: "not-a-number",
    })).toBe(defaultCodexTimeoutMs["asset-bible"]);
    expect(resolveCodexTimeoutMs("asset-bible", {
      AI_VIDEO_STUDIO_ASSET_BIBLE_TIMEOUT_MS: "1000",
    })).toBe(defaultCodexTimeoutMs["asset-bible"]);
  });
});
