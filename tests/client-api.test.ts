import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../ui/src/api";

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
});
