import { describe, expect, it } from "vitest";
import {
  CodexJsonlAccumulator,
  CODEX_NETWORK_PROXY_FEATURES,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_TEXT_MODEL,
  defaultCodexTimeoutMs,
  detectCodexConnectionFailure,
  parseCodexJsonl,
  resolveCodexNetworkFeatureArgs,
  resolveCodexReasoningEffort,
  resolveCodexTextModel,
  resolveCodexTimeoutMs,
  sanitizeCodexDiagnostic,
  selectH3ModeReferences,
} from "../src/ai/codex-cli-provider";

describe("Codex CLI JSONL diagnostics", () => {
  it("pins the text model instead of silently inheriting a changing CLI default", () => {
    expect(resolveCodexTextModel({})).toBe(DEFAULT_CODEX_TEXT_MODEL);
    expect(resolveCodexTextModel({ AI_VIDEO_STUDIO_CODEX_MODEL: "gpt-5.6-sol" })).toBe("gpt-5.6-sol");
    expect(resolveCodexTextModel({ AI_VIDEO_STUDIO_CODEX_MODEL: "   " })).toBe(DEFAULT_CODEX_TEXT_MODEL);
  });

  it("uses balanced reasoning for continuity without overriding creative generation", () => {
    expect(resolveCodexReasoningEffort("continuity", {})).toBe("medium");
    expect(resolveCodexReasoningEffort("storyboard", {})).toBeNull();
    expect(resolveCodexReasoningEffort("continuity", {
      AI_VIDEO_STUDIO_CODEX_CONTINUITY_REASONING_EFFORT: "high",
    })).toBe("high");
    expect(resolveCodexReasoningEffort("continuity", {
      AI_VIDEO_STUDIO_CODEX_CONTINUITY_REASONING_EFFORT: "invalid",
    })).toBe("medium");
    expect(CODEX_REASONING_EFFORTS).toContain("max");
  });

  it("loads only the H3 guide required by the selected mode", () => {
    const skill = {
      provenance: { name: "h3-prompt-writing", version: "test", sha256: "hash", sourceFiles: [] },
      description: "test",
      instructionText: "instructions",
      references: [
        { path: "references/base-en.txt", content: "base" },
        { path: "references/ref-en.txt", content: "ref" },
      ],
    };
    expect(selectH3ModeReferences([skill], "Ref2VA")[0].references.map((item) => item.content)).toEqual(["ref"]);
    expect(selectH3ModeReferences([skill], "T2VA")[0].references.map((item) => item.content)).toEqual(["base"]);
  });
  it("extracts current event fields without making the final output depend on diagnostics", () => {
    const summary = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      "not-json",
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 8 } }),
    ].join("\n"));
    expect(summary.threadId).toBe("thread-1");
    expect(summary.usage).toEqual({ input_tokens: 12, output_tokens: 8 });
    expect(summary.eventTypes).toEqual(["thread.started", "turn.completed"]);
    expect(summary.errors).toEqual([]);
  });

  it("extracts structured Codex failures instead of unrelated stderr warnings", () => {
    const message = JSON.stringify({ type: "error", error: { code: "invalid_json_schema", message: "schema must have a type key" } });
    const summary = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-failed" }),
      JSON.stringify({ type: "error", message }),
      JSON.stringify({ type: "turn.failed", error: { message } }),
    ].join("\n"));
    expect(summary.eventTypes).toEqual(["thread.started", "error", "turn.failed"]);
    expect(summary.errors).toEqual([message]);
  });

  it("captures Codex transport errors emitted as completed error items", () => {
    const summary = parseCodexJsonl(JSON.stringify({
      type: "item.completed",
      item: { type: "error", message: "Falling back from WebSockets to HTTPS transport." },
    }));
    expect(summary.errors).toEqual(["Falling back from WebSockets to HTTPS transport."]);
  });

  it("enables the verified Windows proxy features for every Codex run", () => {
    expect(resolveCodexNetworkFeatureArgs({}, "win32")).toEqual(
      CODEX_NETWORK_PROXY_FEATURES.flatMap((feature) => ["--enable", feature]),
    );
    expect(resolveCodexNetworkFeatureArgs({ AI_VIDEO_STUDIO_CODEX_SYSTEM_PROXY: "off" }, "win32")).toEqual([]);
    expect(resolveCodexNetworkFeatureArgs({ AI_VIDEO_STUDIO_CODEX_SYSTEM_PROXY: "true" }, "linux")).not.toEqual([]);
  });

  it("fails fast after persistent connection errors but tolerates one transient reconnect", () => {
    expect(detectCodexConnectionFailure([
      "Reconnecting... 2/5 (stream disconnected before completion: temporary failure)",
    ])).toBeNull();
    expect(detectCodexConnectionFailure([
      "Reconnecting... 2/5 (stream disconnected before completion: Proxy URL scheme not supported)",
      "Reconnecting... 3/5 (stream disconnected before completion: Proxy URL scheme not supported)",
      "Reconnecting... 4/5 (stream disconnected before completion: Proxy URL scheme not supported)",
    ])).toContain("无法连接模型服务");
    expect(detectCodexConnectionFailure(["stream connection failed; waiting for network"])).toContain("项目数据未变更");
  });

  it("redacts credentials and token query values from persisted diagnostics", () => {
    expect(sanitizeCodexDiagnostic("https://user:pass@proxy.test/path?token=secret&mode=1 Bearer abc.def"))
      .toBe("https://<redacted>@proxy.test/path?token=<redacted>&mode=1 Bearer <redacted>");
  });

  it("retains the thread start while diagnostic output grows beyond the tail buffer", () => {
    const accumulator = new CodexJsonlAccumulator();
    accumulator.push(`${JSON.stringify({ type: "thread.started", thread_id: "thread-long" })}\n`);
    accumulator.push(`${"diagnostic".repeat(5_000)}\n`);
    accumulator.push(JSON.stringify({ type: "turn.completed", usage: { output_tokens: 42 } }));
    expect(accumulator.finish()).toMatchObject({
      threadId: "thread-long",
      usage: { output_tokens: 42 },
      eventTypes: ["thread.started", "turn.completed"],
    });
  });

  it("uses longer limits for complex artifacts", () => {
    expect(defaultCodexTimeoutMs.outline).toBe(5 * 60_000);
    expect(defaultCodexTimeoutMs["asset-bible"]).toBe(12 * 60_000);
    expect(defaultCodexTimeoutMs["asset-bible"]).toBeGreaterThan(defaultCodexTimeoutMs.outline);
    expect(defaultCodexTimeoutMs.continuity).toBe(4 * 60_000);
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
