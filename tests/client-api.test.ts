import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../ui/src/api";
import type { ShotSpec } from "../ui/src/types";

afterEach(() => vi.restoreAllMocks());

describe("browser API request headers", () => {
  it("does not attach a JSON content type to empty generation POST requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ project: {}, artifact: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await api.generateArtifact("project-1", "outline");
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
  });

  it("keeps the JSON content type when a request has a JSON body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ project: {}, artifact: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await api.saveArtifact("project-1", "outline", "changed outline");
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ content: "changed outline" }));
  });

  it("sends the edited source and expected latest artifact separately", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ project: {}, artifact: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await api.saveArtifact("project-1", "outline", "changed outline", "source-v1", "latest-v2");
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBe(JSON.stringify({
      content: "changed outline",
      sourceArtifactId: "source-v1",
      expectedLatestArtifactId: "latest-v2",
    }));
  });

  it("archives and restores projects with bodyless requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ project: {}, recoverable: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ project: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await api.archiveProject("project-1");
    await api.restoreProject("project-1");

    const [archiveUrl, archiveInit] = fetchMock.mock.calls[0];
    expect(archiveUrl).toBe("/api/projects/project-1");
    expect(archiveInit?.method).toBe("DELETE");
    expect(archiveInit?.body).toBeUndefined();
    expect(new Headers(archiveInit?.headers).has("Content-Type")).toBe(false);

    const [restoreUrl, restoreInit] = fetchMock.mock.calls[1];
    expect(restoreUrl).toBe("/api/projects/project-1/restore");
    expect(restoreInit?.method).toBe("POST");
    expect(restoreInit?.body).toBeUndefined();
    expect(new Headers(restoreInit?.headers).has("Content-Type")).toBe(false);
  });

  it("sends generation clarity as package metadata instead of prompt text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ project: {}, package: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await api.createUpdreamShotPackage("project-1", "S001", "480p");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/project-1/handoff/updream/shots/S001/package");
    expect(init?.body).toBe(JSON.stringify({ generationResolution: "480p" }));
  });

  it("requests native file copying for one H3 material label", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ count: 1, files: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await api.copyUpdreamMaterials("project-1", "S001", 2, "<Subject 1>");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/project-1/handoff/updream/shots/S001/packages/2/copy-materials");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ label: "<Subject 1>" }));
  });

  it("sends the expected director-script version with a shot edit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ project: {}, artifact: {}, shot: {} }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const shot = { id: "S001", purpose: "新的镜头目的" } as ShotSpec;
    await api.updateShot("project-1", shot, "latest-shooting-script-id");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/project-1/shots/S001");
    expect(init?.body).toBe(JSON.stringify({ shot, expectedLatestArtifactId: "latest-shooting-script-id" }));
  });

  it("loads the structured continuity report for the selected storyboard version", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ report: { checkedShotIds: ["S001"], issues: [], passed: true, uncheckedClaims: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await api.getContinuityReport("project-1", "storyboard-v1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/project-1/artifacts/storyboard-v1/continuity-report");
    expect(init?.method).toBeUndefined();
  });

  it("retries only the continuity review for an existing storyboard", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ project: {}, artifact: {}, continuityReview: { status: "completed", message: null } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await api.reviewStoryboardContinuity("project-1", "storyboard-v3");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/project-1/artifacts/storyboard-v3/continuity-review");
    expect(init?.method).toBe("POST");
  });

  it("loads asset approval issues before the user clicks approve", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ passed: false, issues: ["STYLE-001 画幅冲突"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await api.getAssetReadiness("project-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/project-1/assets/readiness");
    expect(init?.method).toBeUndefined();
  });

  it("routes Codex prompt generation separately from the reserved image provider", async () => {
    const responseBody = JSON.stringify({ asset: {}, prompt: {}, imageProvider: {} });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(responseBody, { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ asset: {}, providerTaskId: null }), { status: 201, headers: { "Content-Type": "application/json" } }));

    await api.generateAssetReferencePrompt("project-1", "CHAR-001", "主参考");
    await api.generateAssetReferenceImage("project-1", "CHAR-001", "019c9a68-6d6e-7cf1-b9cc-0caa79d9887a");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project-1/assets/CHAR-001/reference-prompts");
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({ role: "主参考" }));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project-1/assets/CHAR-001/reference-images/generate");
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ promptId: "019c9a68-6d6e-7cf1-b9cc-0caa79d9887a" }));
  });

  it("routes reference replacement and deletion to the indexed asset endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ asset: {} }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ asset: {}, archivedFileName: "old.png" }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await api.replaceAssetReference("project-1", "CHAR-001", 2, {
      fileName: "new.png",
      mimeType: "image/png",
      dataBase64: "AAAA",
      authorizationConfirmed: true,
    });
    await api.deleteAssetReference("project-1", "CHAR-001", 2);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project-1/assets/CHAR-001/references/2");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PUT");
    expect(fetchMock.mock.calls[0][1]?.body).toContain('"fileName":"new.png"');
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project-1/assets/CHAR-001/references/2");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
  });

  it("starts and continues targeted continuity repair with bodyless posts", async () => {
    const responseBody = JSON.stringify({ project: {}, artifact: {}, repair: { fixedIssueCodes: [], remainingIssueCodes: [], nextTarget: "asset-bible" } });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(responseBody, { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(responseBody, { status: 201, headers: { "Content-Type": "application/json" } }));

    await api.startContinuityRepair("project-1", "storyboard-v1");
    await api.continueContinuityRepair("project-1");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project-1/artifacts/storyboard-v1/continuity-repair");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project-1/continuity-repair/continue");
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
    }
  });

  it("creates a persistent structured repair operation with an idempotency key", async () => {
    const responseBody = JSON.stringify({ operationId: "operation-1", operation: { id: "operation-1" } });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(responseBody, { status: 202, headers: { "Content-Type": "application/json" } }),
    );

    await api.createContinuityRepairOperation("project-1", "storyboard-v4", "repair-key");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/project-1/artifacts/storyboard-v4/continuity-repair-operations");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ idempotencyKey: "repair-key" }));
  });

  it("runs bounded background continuity repair with an explicit attempt limit", async () => {
    const responseBody = JSON.stringify({ project: {}, artifact: {}, autoRepair: { passed: true, attempts: 1, maxAttempts: 3, fixedIssueCodes: [], remainingIssueCodes: [], intermediateArtifactIds: [], blockedReason: null, finalHumanApprovalRequired: true } });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(responseBody, { status: 201, headers: { "Content-Type": "application/json" } }),
    );

    await api.autoContinuityRepair("project-1", "storyboard-v1", 3);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/project-1/artifacts/storyboard-v1/continuity-repair/auto");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ maxAttempts: 3 }));
  });
});
