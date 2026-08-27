import { createHash } from "node:crypto";
import type { ArtifactType } from "../shared/schemas";
import { IssueRepository } from "../issues/issue-repository";
import { ArtifactRepository, type StoredArtifact } from "./artifact-repository";

const requiredInputTypes: Partial<Record<ArtifactType, ArtifactType[]>> = {
  screenplay: ["outline"],
  "asset-bible": ["screenplay"],
  "shooting-script": ["asset-bible"],
  storyboard: ["shooting-script"],
};

function dependencyIssueId(projectId: string, artifactId: string): string {
  return `issue-${createHash("sha256").update(`${projectId}|dependency-outdated|${artifactId}`).digest("hex").slice(0, 32)}`;
}

export interface ArtifactDependencyResult {
  state: "current" | "outdated" | "unknown" | "not-applicable";
  message: string | null;
}

export class ArtifactLineageService {
  constructor(private readonly artifacts: ArtifactRepository, private readonly issues: IssueRepository) {}

  dependencyState(artifact: StoredArtifact, heads = this.artifacts.getHeads(artifact.projectId)): ArtifactDependencyResult {
    const required = requiredInputTypes[artifact.type] ?? [];
    if (!required.length) return { state: "not-applicable", message: null };
    const inputs = this.artifacts.listInputs(artifact.id)
      .map((edge) => ({ edge, artifact: this.artifacts.get(edge.inputArtifactId) }))
      .filter((item): item is { edge: typeof item.edge; artifact: StoredArtifact } => Boolean(item.artifact));
    const missing = required.filter((type) => !inputs.some((input) => input.artifact.type === type));
    if (missing.length) return { state: "unknown", message: `缺少可证明的${missing.join("、")}来源关系` };
    const outdated = inputs.filter((input) => required.includes(input.artifact.type) && heads.get(input.artifact.type) !== input.artifact.id);
    if (outdated.length) {
      return {
        state: "outdated",
        message: `仍基于旧版本：${outdated.map((input) => `${input.artifact.type} V${String(input.artifact.version).padStart(3, "0")}`).join("、")}`,
      };
    }
    return { state: "current", message: "所有可证明的上游输入均为当前 Head" };
  }

  reconcileProject(projectId: string): void {
    const heads = this.artifacts.getHeads(projectId);
    for (const artifact of this.artifacts.list(projectId)) {
      const result = this.dependencyState(artifact, heads);
      const id = dependencyIssueId(projectId, artifact.id);
      if (result.state === "outdated") {
        this.issues.upsertOpen({
          id, projectId, scopeType: "artifact", scopeId: artifact.id, severity: "warning",
          code: "dependency-outdated", title: "当前内容仍基于旧版本", detail: result.message ?? "上游 Head 已变化",
          suggestedAction: "可继续查看和使用；需要更新时请显式创建修订，不会自动重做", source: "validator",
        });
      } else {
        this.issues.resolveIfOpen(id, "validator", "依赖已与当前 Head 对齐");
      }
    }
  }
}
