import type { ArtifactSummary, ProjectIssue } from "../shared/api-contracts/agent-first";
import type { ArtifactType } from "../shared/schemas";
import { ArtifactLineageService } from "./artifact-lineage-service";
import type { StoredArtifact } from "./artifact-repository";

export class ArtifactValidityService {
  constructor(private readonly lineage: ArtifactLineageService) {}

  summarize(artifact: StoredArtifact, headId: string | null, issues: ProjectIssue[]): ArtifactSummary {
    const isHead = artifact.id === headId;
    const dependency = this.lineage.dependencyState(artifact);
    const hasOpenError = issues.some((issue) => issue.status === "open" && issue.severity === "error" && issue.scopeId === artifact.id);
    let state: ArtifactSummary["state"];
    if (!isHead) state = "superseded";
    else if (artifact.status === "rejected") state = "rejected";
    else if (hasOpenError || dependency.state === "outdated" || dependency.state === "unknown" || artifact.status === "stale") state = "needs-review";
    else if (artifact.status === "approved") state = "approved";
    else state = "draft";
    return {
      ...artifact,
      type: artifact.type as ArtifactType,
      state,
      isHead,
      dependencyState: dependency.state,
      dependencyMessage: dependency.message,
    };
  }
}
