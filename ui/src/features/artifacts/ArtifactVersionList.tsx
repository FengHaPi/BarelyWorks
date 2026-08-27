import type { ArtifactSummary } from "../../../../src/shared/api-contracts/agent-first";

export function ArtifactVersionList({ versions, selectedId, onSelect }: {
  versions: ArtifactSummary[];
  selectedId: string | null;
  onSelect: (artifactId: string) => void;
}) {
  return <div className="af-version-list" aria-label="版本历史">
    {versions.map((version) => <button key={version.id} className={selectedId === version.id ? "is-selected" : ""} onClick={() => onSelect(version.id)}>
      <span>V{String(version.version).padStart(3, "0")}</span>
      <small>{version.isHead ? "当前 Head" : version.status === "approved" ? "已批准历史" : "历史版本"}</small>
      {version.dependencyState === "outdated" && <b>基于旧版本</b>}
    </button>)}
  </div>;
}
