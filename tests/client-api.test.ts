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
});
