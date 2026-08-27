import type { ArtifactDetail } from "../shared/api-contracts/agent-first";
import type { ArtifactType } from "../shared/schemas";
import { IssueRepository } from "../issues/issue-repository";
import { ProjectRepository } from "../projects/project-repository";
import { ArtifactLineageService } from "./artifact-lineage-service";
import { ArtifactRepository } from "./artifact-repository";
import { ArtifactValidityService } from "./artifact-validity-service";
import type { ProjectService } from "../projects/project-service";

export class ArtifactService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly issues: IssueRepository,
    private readonly lineage: ArtifactLineageService,
    private readonly validity: ArtifactValidityService,
    private readonly projectService: ProjectService,
  ) {}

  async detail(projectId: string, artifactId: string): Promise<ArtifactDetail> {
    this.projects.require(projectId);
    const artifact = this.artifacts.require(projectId, artifactId);
    const heads = this.artifacts.getHeads(projectId);
    const issues = this.issues.listForScope(projectId, "artifact", artifactId);
    const mapEdge = (edge: { artifactId: string; inputArtifactId: string; relation: string; createdAt: string }) => {
      const input = this.artifacts.get(edge.inputArtifactId);
      return {
        ...edge,
        ...(input ? {
          inputType: input.type,
          inputVersion: input.version,
          inputIsCurrentHead: heads.get(input.type) === input.id,
        } : {}),
      };
    };
    return {
      artifact: this.validity.summarize(artifact, heads.get(artifact.type) ?? null, issues),
      content: await this.artifacts.readContent(artifact),
      inputs: this.artifacts.listInputs(artifact.id).map(mapEdge),
      dependents: this.artifacts.listDependents(artifact.id).map(mapEdge),
      approvals: this.artifacts.listApprovals(artifact),
      issues,
    };
  }

  async selectHead(projectId: string, type: ArtifactType, artifactId: string): Promise<void> {
    this.projects.require(projectId);
    const artifact = this.artifacts.require(projectId, artifactId);
    if (artifact.type !== type) throw new Error("Head 类型与产物类型不一致");
    await this.artifacts.readContent(artifact);
    await this.projectService.activateArtifactProjection(projectId, artifactId);
    this.artifacts.selectHead(projectId, type, artifactId, "user");
    this.lineage.reconcileProject(projectId);
  }
}
