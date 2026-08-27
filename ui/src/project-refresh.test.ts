import { describe, expect, it } from "vitest";
import type { Project } from "./types";
import {
  isDraftBaselineStale,
  reconcileProjectSelection,
  recoverDraftExpectedLatestArtifactId,
  shouldSkipForegroundRefreshForFilePicker,
} from "./project-refresh";

const project = (id: string): Project => ({ id } as Project);

describe("reconcileProjectSelection", () => {
  it("preserves a selected project that still exists", () => {
    expect(reconcileProjectSelection([project("A"), project("B")], "B"))
      .toEqual({ selectedId: "B", selectionLost: false });
  });

  it("moves to the first available project and reports a lost selection", () => {
    expect(reconcileProjectSelection([project("B")], "A"))
      .toEqual({ selectedId: "B", selectionLost: true });
  });

  it("clears selection when the last project disappears", () => {
    expect(reconcileProjectSelection([], "A"))
      .toEqual({ selectedId: null, selectionLost: true });
  });
});

describe("foreground refresh around native file selection", () => {
  it("does not refresh while the returning focus still belongs to a file input", () => {
    expect(shouldSkipForegroundRefreshForFilePicker({ tagName: "INPUT", type: "file" })).toBe(true);
  });

  it("keeps normal focus refreshes enabled", () => {
    expect(shouldSkipForegroundRefreshForFilePicker({ tagName: "INPUT", type: "text" })).toBe(false);
    expect(shouldSkipForegroundRefreshForFilePicker({ tagName: "BUTTON" })).toBe(false);
    expect(shouldSkipForegroundRefreshForFilePicker(null)).toBe(false);
  });
});

describe("stage draft version baseline", () => {
  it("preserves the expected-latest version captured with a recovered draft", () => {
    const recoveredBaseline = recoverDraftExpectedLatestArtifactId("artifact-v1", "artifact-v1");

    expect(recoveredBaseline).toBe("artifact-v1");
    expect(isDraftBaselineStale(recoveredBaseline, "artifact-v2")).toBe(true);
  });

  it("uses the base artifact as a safe baseline for drafts saved by older builds", () => {
    expect(recoverDraftExpectedLatestArtifactId(undefined, "artifact-v1")).toBe("artifact-v1");
    expect(recoverDraftExpectedLatestArtifactId(undefined, null)).toBeNull();
  });
});
