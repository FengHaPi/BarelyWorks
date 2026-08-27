import type { Project } from "./types";

export function reconcileProjectSelection(projects: Project[], currentId: string | null): {
  selectedId: string | null;
  selectionLost: boolean;
} {
  if (currentId && projects.some((project) => project.id === currentId)) {
    return { selectedId: currentId, selectionLost: false };
  }
  return {
    selectedId: projects[0]?.id ?? null,
    selectionLost: currentId !== null,
  };
}

export function recoverDraftExpectedLatestArtifactId(
  storedExpectedLatestArtifactId: unknown,
  storedBaseArtifactId: string | null,
): string | null {
  return typeof storedExpectedLatestArtifactId === "string"
    ? storedExpectedLatestArtifactId
    : storedBaseArtifactId;
}

export function isDraftBaselineStale(
  expectedLatestArtifactId: string | null,
  currentLatestArtifactId: string | null,
): boolean {
  return expectedLatestArtifactId !== currentLatestArtifactId;
}

export function shouldSkipForegroundRefreshForFilePicker(
  activeElement: { tagName?: string; type?: string } | null,
): boolean {
  return activeElement?.tagName?.toUpperCase() === "INPUT" && activeElement.type?.toLowerCase() === "file";
}
