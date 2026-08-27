import type { StudioDatabase } from "../database/client";
import { parseJsonArray, parseJsonObject } from "../database/row-utils";
import { reconcileAgentFirstWorkspace } from "../database/agent-first-backfill";
import type { HistoricalSnapshot, ProjectWorkspace } from "../shared/api-contracts/agent-first";
import { artifactTypeSchema, type ArtifactType } from "../shared/schemas";
import { ArtifactLineageService } from "../artifacts/artifact-lineage-service";
import { ArtifactRepository } from "../artifacts/artifact-repository";
import { ArtifactValidityService } from "../artifacts/artifact-validity-service";
import { IssueRepository } from "../issues/issue-repository";
import { OperationRepository } from "../operations/operation-repository";
import { ProjectRepository } from "./project-repository";

const artifactTypes = artifactTypeSchema.options;
const artifactLabels: Record<ArtifactType, string> = {
  outline: "剧情大纲",
  screenplay: "影视剧本",
  "asset-bible": "资产定义",
  "shooting-script": "导演脚本",
  storyboard: "分镜设计",
};

export class ProjectWorkspaceService {
  constructor(
    private readonly studio: StudioDatabase,
    private readonly projects: ProjectRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly issues: IssueRepository,
    private readonly operations: OperationRepository,
    private readonly lineage: ArtifactLineageService,
    private readonly validity: ArtifactValidityService,
  ) {}

  get(projectId: string): ProjectWorkspace {
    reconcileAgentFirstWorkspace(this.studio.sqlite);
    const project = this.projects.require(projectId);
    this.lineage.reconcileProject(projectId);
    const allIssues = this.issues.list(projectId);
    const openIssues = allIssues.filter((issue) => issue.status === "open");
    const heads = this.artifacts.getHeads(projectId);
    const artifactGroups = artifactTypes.map((type) => {
      const versions = this.artifacts.list(projectId, type);
      const headId = heads.get(type) ?? null;
      const summaries = versions.map((artifact) => this.validity.summarize(artifact, headId, allIssues));
      const head = summaries.find((artifact) => artifact.isHead) ?? null;
      return {
        type,
        label: artifactLabels[type],
        state: head?.state ?? "absent" as const,
        head,
        versions: summaries,
        openIssueCount: openIssues.filter((issue) => issue.scopeType === "artifact" && (issue.scopeId === headId || versions.some((version) => version.id === issue.scopeId))).length,
      };
    });
    return {
      project: {
        id: project.id, title: project.title, targetDurationSec: project.targetDurationSec,
        aspectRatio: project.aspectRatio, resolution: project.resolution,
        updatedAt: project.updatedAt,
      },
      artifactGroups,
      issues: allIssues,
      operations: this.operations.listProject(projectId),
      snapshots: this.snapshots(projectId, heads),
      resourceSummary: {
        assets: this.count("assets", projectId), shots: this.count("shots", projectId),
        generations: this.count("generation_jobs", projectId), qualityReviews: this.count("quality_reviews", projectId),
        renders: this.count("renders", projectId),
      },
    };
  }

  private count(table: "assets" | "shots" | "generation_jobs" | "quality_reviews" | "renders", projectId: string): number {
    return (this.studio.sqlite.prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id = ?`).get(projectId) as { count: number }).count;
  }

  private snapshots(projectId: string, heads: Map<ArtifactType, string>): HistoricalSnapshot[] {
    const currentStoryboardId = heads.get("storyboard") ?? null;
    const jobs = this.studio.sqlite.prepare(`
      SELECT id, shot_id, status, storyboard_artifact_id, shot_package_artifact_id, payload
      FROM generation_jobs WHERE project_id = ? ORDER BY id
    `).all(projectId) as Array<{
      id: string; shot_id: string; status: string; storyboard_artifact_id: string | null;
      shot_package_artifact_id: string | null; payload: string;
    }>;
    const jobStates = new Map<string, HistoricalSnapshot["lineageState"]>();
    const snapshots: HistoricalSnapshot[] = jobs.map((job) => {
      const payload = parseJsonObject(job.payload);
      const lineageState = !job.storyboard_artifact_id ? "unknown"
        : job.storyboard_artifact_id === currentStoryboardId ? "current" : "outdated";
      jobStates.set(job.id, lineageState);
      return {
        id: job.id,
        kind: "generation",
        label: `${job.shot_id} · 生成记录`,
        status: job.status,
        lineageState,
        lineageMessage: lineageState === "current" ? "基于当前分镜 Head"
          : lineageState === "outdated" ? "基于旧分镜版本，保留为历史快照" : "来源关系待确认，未猜测分镜版本",
        createdAt: typeof payload.createdAt === "string" ? payload.createdAt : null,
        sourceIds: [job.storyboard_artifact_id, job.shot_package_artifact_id].filter((id): id is string => Boolean(id)),
      };
    });
    const renders = this.studio.sqlite.prepare(`
      SELECT id, version, status, payload, source_job_ids, created_at FROM renders WHERE project_id = ? ORDER BY version DESC
    `).all(projectId) as Array<{ id: string; version: number; status: string; payload: string; source_job_ids: string | null; created_at: string }>;
    for (const render of renders) {
      const payload = parseJsonObject(render.payload);
      const sourceIds = parseJsonArray(render.source_job_ids).length ? parseJsonArray(render.source_job_ids)
        : Array.isArray(payload.sourceJobIds) ? payload.sourceJobIds.filter((id): id is string => typeof id === "string") : [];
      const states = sourceIds.map((id) => jobStates.get(id) ?? "unknown");
      const lineageState = !states.length || states.includes("unknown") ? "unknown" : states.includes("outdated") ? "outdated" : "current";
      const delivered = typeof payload.deliveryVideoPath === "string" && Boolean(payload.deliveryVideoPath);
      snapshots.push({
        id: render.id,
        kind: delivered ? "delivery" : "render",
        label: `${delivered ? "交付" : "粗剪"} V${String(render.version).padStart(3, "0")}`,
        status: render.status,
        lineageState,
        lineageMessage: lineageState === "current" ? "所有输入视频均可追溯到当前分镜"
          : lineageState === "outdated" ? "部分输入来自旧分镜，保留为历史快照" : "无法完整证明输入关系，不作为当前完成证据",
        createdAt: render.created_at,
        sourceIds,
      });
    }
    return snapshots;
  }
}
