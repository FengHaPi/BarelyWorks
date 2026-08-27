import type { Artifact, ArtifactType, Asset, AssetDesignMode, AssetReferencePromptRecord, AssetReferenceRole, ContinuityReport, CreateProjectInput, GenerationCenter, GenerationReadiness, GenerationResolution, GenerationScanResult, HandoffPackageSummary, Health, ImageProviderCapabilities, Project, ProjectIntegrityAudit, ProjectOperationStatus, ProjectStage, QualityCenter, QualityReview, QualityReviewInput, RenderRecord, ShotSpec, StoryboardContinuityReviewSummary } from "./types";
import type { AgentMessage, AgentThread, ArtifactDetail, Operation, OperationEvent, ProjectIssue, ProjectWorkspace } from "../../src/shared/api-contracts/agent-first";
import type { ContinuityRepairPlan } from "../../src/shared/continuity-repair";
import type { CumulativeVerificationLedger, CumulativeVerificationTarget } from "../../src/shared/cumulative-verification";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 15 * 60_000;
const MAX_ERROR_BODY_LENGTH = 300;

export type ApiRequestInit = RequestInit & { timeoutMs?: number };

export interface AutoContinuityRepairSummary {
  passed: boolean;
  attempts: number;
  maxAttempts: number;
  fixedIssueCodes: string[];
  remainingIssueCodes: string[];
  intermediateArtifactIds: string[];
  blockedReason: string | null;
  finalHumanApprovalRequired: true;
}

function responseBodyMessage(rawBody: string): string {
  return rawBody
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_BODY_LENGTH);
}

function jsonMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("message" in payload)) return null;
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

export async function request<T>(url: string, init: ApiRequestInit = {}): Promise<T> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...fetchInit } = init;
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const callerSignal = fetchInit.signal;
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...fetchInit,
        headers,
        signal: controller.signal,
      });
    } catch (reason) {
      if (timedOut) throw new Error(`请求超时（等待 ${Math.ceil(timeoutMs / 1000)} 秒）`);
      if (callerSignal?.aborted || (reason instanceof Error && reason.name === "AbortError")) throw new Error("请求已取消");
      if (reason instanceof TypeError) throw new Error(`无法连接本地服务：${reason.message}`);
      throw reason;
    }

    const rawBody = await response.text();
    let payload: unknown;
    if (rawBody.trim()) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        if (response.ok) throw new Error(`服务器返回了无法解析的响应 (${response.status})`);
      }
    }

    if (!response.ok) {
      const message = jsonMessage(payload) ?? responseBodyMessage(rawBody);
      throw new Error(message || `请求失败 (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`);
    }
    return payload as T;
  } catch (reason) {
    if (timedOut) throw new Error(`请求超时（等待 ${Math.ceil(timeoutMs / 1000)} 秒）`);
    if (callerSignal?.aborted || (reason instanceof Error && reason.name === "AbortError")) throw new Error("请求已取消");
    throw reason;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export const api = {
  health: () => request<Health>("/api/health"),
  listProjects: () => request<{ projects: Project[] }>("/api/projects"),
  listArchivedProjects: () => request<{ projects: Project[] }>("/api/projects/archived"),
  createProject: (input: CreateProjectInput) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}`),
  getWorkspace: (id: string) => request<{ workspace: ProjectWorkspace }>(`/api/projects/${id}/workspace`),
  getVerificationLedger: (id: string, through: CumulativeVerificationTarget, artifactId?: string | null) =>
    request<{ ledger: CumulativeVerificationLedger }>(`/api/projects/${id}/verification-ledger?through=${encodeURIComponent(through)}${artifactId ? `&artifactId=${encodeURIComponent(artifactId)}` : ""}`),
  getArtifactDetail: (projectId: string, artifactId: string) => request<ArtifactDetail>(`/api/projects/${projectId}/artifacts/${artifactId}`),
  selectArtifactHead: (projectId: string, type: ArtifactType, artifactId: string) => request<{ workspace: ProjectWorkspace }>(`/api/projects/${projectId}/heads/${type}`, {
    method: "PATCH", body: JSON.stringify({ artifactId, selectedBy: "user" }),
  }),
  decideArtifact: (projectId: string, artifactId: string, decision: "approved" | "rejected", comment?: string) => request<{ artifactId: string; approvalId: string; decision: string; createdAt: string }>(`/api/projects/${projectId}/artifacts/${artifactId}/decisions`, {
    method: "POST", body: JSON.stringify({ decision, comment }),
  }),
  createRevision: (projectId: string, input: { targetArtifactId: string; instruction: string; intent: "revise" | "rewrite-section" | "extend" | "fix-issue"; idempotencyKey?: string }) => request<{ revisionRequestId: string; operationId: string }>(`/api/projects/${projectId}/revisions`, {
    method: "POST", body: JSON.stringify(input),
  }),
  createContinuityRepairOperation: (projectId: string, artifactId: string, idempotencyKey: string) => request<{ operationId: string; operation: Operation }>(`/api/projects/${projectId}/artifacts/${artifactId}/continuity-repair-operations`, {
    method: "POST", body: JSON.stringify({ idempotencyKey }),
  }),
  getContinuityRepairPlan: (projectId: string, artifactId: string) => request<{ plan: ContinuityRepairPlan }>(`/api/projects/${projectId}/artifacts/${artifactId}/continuity-repair-plan`),
  getOperation: (operationId: string) => request<{ operation: Operation }>(`/api/operations/${operationId}`),
  getOperationEvents: (operationId: string) => request<{ events: OperationEvent[] }>(`/api/operations/${operationId}/events`),
  cancelOperation: (operationId: string) => request<{ operation: Operation }>(`/api/operations/${operationId}/cancel`, { method: "POST" }),
  createProductionBootstrap: (projectId: string, idempotencyKey: string) => request<{ operationId: string; operation: Operation }>(`/api/projects/${projectId}/production/bootstrap`, { method: "POST", body: JSON.stringify({ idempotencyKey }) }),
  createProductionShotPackage: (projectId: string, shotId: string, generationResolution: GenerationResolution, idempotencyKey: string) => request<{ operationId: string; operation: Operation }>(`/api/projects/${projectId}/production/shots/${shotId}/package`, { method: "POST", body: JSON.stringify({ generationResolution, idempotencyKey }) }),
  createProductionInboxScan: (projectId: string, idempotencyKey: string) => request<{ operationId: string; operation: Operation }>(`/api/projects/${projectId}/production/generations/scan`, { method: "POST", body: JSON.stringify({ idempotencyKey }) }),
  createProductionRoughCut: (projectId: string, idempotencyKey: string) => request<{ operationId: string; operation: Operation }>(`/api/projects/${projectId}/production/renders/rough-cut`, { method: "POST", body: JSON.stringify({ idempotencyKey }) }),
  listIssues: (projectId: string) => request<{ issues: ProjectIssue[] }>(`/api/projects/${projectId}/issues`),
  updateIssue: (projectId: string, issueId: string, input: { status: "resolved" | "ignored"; actor?: string; reason?: string }) => request<{ issue: ProjectIssue }>(`/api/projects/${projectId}/issues/${issueId}`, {
    method: "PATCH", body: JSON.stringify(input),
  }),
  listAgentThreads: (projectId: string) => request<{ threads: AgentThread[] }>(`/api/projects/${projectId}/agent/threads`),
  createAgentThread: (projectId: string, title = "项目讨论") => request<{ thread: AgentThread }>(`/api/projects/${projectId}/agent/threads`, {
    method: "POST", body: JSON.stringify({ title }),
  }),
  listAgentMessages: (projectId: string, threadId: string) => request<{ messages: AgentMessage[] }>(`/api/projects/${projectId}/agent/threads/${threadId}/messages`),
  sendAgentMessage: (projectId: string, threadId: string, input: {
    content: string; mode: "ask" | "compare" | "revise" | "plan"; targetArtifactId?: string;
    targetArtifactIds?: string[]; intent?: "revise" | "rewrite-section" | "extend" | "fix-issue" | "compare"; idempotencyKey?: string;
  }) => request<{ kind: "explanation" | "plan" | "operation"; message: AgentMessage; operationId?: string; revisionRequestId?: string; planId?: string; impactedArtifactIds?: string[] }>(`/api/projects/${projectId}/agent/threads/${threadId}/messages`, {
    method: "POST", body: JSON.stringify(input),
  }),
  getProjectOperation: (id: string) => request<{ operation: ProjectOperationStatus | null }>(`/api/projects/${id}/operation`),
  getProjectIntegrity: (id: string) => request<{ audit: ProjectIntegrityAudit }>(`/api/projects/${id}/integrity`),
  reviseTargetDuration: (id: string, targetDurationSec: number, restartNarrative = false) => request<{ project: Project }>(`/api/projects/${id}/production-constraints`, {
    method: "PATCH",
    body: JSON.stringify({ targetDurationSec, restartNarrative }),
  }),
  archiveProject: (id: string) => request<{ project: Project; recoverable: true }>(`/api/projects/${id}`, { method: "DELETE" }),
  restoreProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}/restore`, { method: "POST" }),
  getSource: (id: string) => request<{ sourceText: string; sourcePath: string }>(`/api/projects/${id}/source`),
  listArtifacts: (id: string, type: ArtifactType) =>
    request<{ artifacts: Artifact[] }>(`/api/projects/${id}/artifacts/${type}`),
  getGenerationReadiness: (id: string) =>
    request<{ readiness: GenerationReadiness | null }>(`/api/projects/${id}/generation-readiness`),
  getContinuityReport: (id: string, artifactId: string) =>
    request<{ report: ContinuityReport }>(`/api/projects/${id}/artifacts/${artifactId}/continuity-report`),
  reviewStoryboardContinuity: (id: string, artifactId: string) =>
    request<{ project: Project; artifact: Artifact; continuityReview: StoryboardContinuityReviewSummary }>(`/api/projects/${id}/artifacts/${artifactId}/continuity-review`, {
      method: "POST",
      timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS,
    }),
  startContinuityRepair: (id: string, artifactId: string) =>
    request<{ project: Project; artifact: Artifact; repair: { fixedIssueCodes: string[]; remainingIssueCodes: string[]; nextTarget: ArtifactType } }>(`/api/projects/${id}/artifacts/${artifactId}/continuity-repair`, { method: "POST", timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS }),
  autoContinuityRepair: (id: string, artifactId: string, maxAttempts = 3) =>
    request<{ project: Project; artifact: Artifact; autoRepair: AutoContinuityRepairSummary }>(`/api/projects/${id}/artifacts/${artifactId}/continuity-repair/auto`, {
      method: "POST",
      body: JSON.stringify({ maxAttempts }),
      timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS,
    }),
  continueContinuityRepair: (id: string) =>
    request<{ project: Project; artifact: Artifact; repair: { fixedIssueCodes: string[]; remainingIssueCodes: string[]; nextTarget: ArtifactType } }>(`/api/projects/${id}/continuity-repair/continue`, { method: "POST", timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS }),
  saveArtifact: (id: string, type: ArtifactType, content: string, sourceArtifactId?: string | null, expectedLatestArtifactId?: string | null) =>
    request<{ project: Project; artifact: Artifact }>(`/api/projects/${id}/artifacts/${type}`, {
      method: "POST",
      body: JSON.stringify({ content, sourceArtifactId, expectedLatestArtifactId }),
    }),
  generateArtifact: (id: string, type: ArtifactType, options?: { designMode?: AssetDesignMode }) =>
    request<{ project: Project; artifact: Artifact; autoRepair?: AutoContinuityRepairSummary; continuityReview?: StoryboardContinuityReviewSummary }>(`/api/projects/${id}/stages/${type}/generate`, {
      method: "POST",
      body: type === "asset-bible" ? JSON.stringify({ designMode: options?.designMode ?? "original-proposal" }) : undefined,
      timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS,
    }),
  listAssets: (id: string) => request<{ assets: Asset[] }>(`/api/projects/${id}/assets`),
  getAssetReadiness: (id: string) => request<{ passed: boolean; issues: string[] }>(`/api/projects/${id}/assets/readiness`),
  getImageProviderCapabilities: () => request<ImageProviderCapabilities>("/api/image-provider/capabilities"),
  generateAssetReferencePrompt: (id: string, assetId: string, role: AssetReferenceRole) =>
    request<{ asset: Asset; prompt: AssetReferencePromptRecord; imageProvider: ImageProviderCapabilities }>(`/api/projects/${id}/assets/${assetId}/reference-prompts`, {
      method: "POST",
      body: JSON.stringify({ role }),
      timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS,
    }),
  generateAssetReferenceImage: (id: string, assetId: string, promptId: string) =>
    request<{ asset: Asset; providerTaskId: string | null }>(`/api/projects/${id}/assets/${assetId}/reference-images/generate`, {
      method: "POST",
      body: JSON.stringify({ promptId }),
      timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS,
    }),
  uploadAssetReference: (id: string, assetId: string, input: { fileName: string; mimeType: string; dataBase64: string; role: string; authorizationConfirmed: true }, workflowMode?: "agent-first") =>
    request<{ asset: Asset }>(`/api/projects/${id}/assets/${assetId}/references`, { method: "POST", body: JSON.stringify({ ...input, ...(workflowMode ? { workflowMode } : {}) }) }),
  replaceAssetReference: (id: string, assetId: string, index: number, input: { fileName: string; mimeType: string; dataBase64: string; authorizationConfirmed: true }, workflowMode?: "agent-first") =>
    request<{ asset: Asset }>(`/api/projects/${id}/assets/${assetId}/references/${index}`, { method: "PUT", body: JSON.stringify({ ...input, ...(workflowMode ? { workflowMode } : {}) }) }),
  deleteAssetReference: (id: string, assetId: string, index: number, workflowMode?: "agent-first") =>
    request<{ asset: Asset; archivedFileName: string }>(`/api/projects/${id}/assets/${assetId}/references/${index}${workflowMode ? `?workflowMode=${workflowMode}` : ""}`, { method: "DELETE" }),
  assetReferenceUrl: (id: string, assetId: string, index: number) => `/api/projects/${id}/assets/${assetId}/references/${index}`,
  listShots: (id: string) => request<{ shots: ShotSpec[] }>(`/api/projects/${id}/shots`),
  updateShot: (id: string, shot: ShotSpec, expectedLatestArtifactId: string) => request<{ project: Project; artifact: Artifact; shot: ShotSpec }>(`/api/projects/${id}/shots/${shot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ shot, expectedLatestArtifactId }),
  }),
  decide: (id: string, stage: ProjectStage, artifactId: string, decision: "approve" | "reject", comment: string) =>
    request<{ project: Project }>(`/api/projects/${id}/stages/${stage}/${decision}`, {
      method: "POST",
      body: JSON.stringify({ artifactId, comment }),
    }),
  generationCenter: (id: string) => request<GenerationCenter>(`/api/projects/${id}/generation-center`),
  lockAssets: (id: string) => request<{ project: Project }>(`/api/projects/${id}/handoff/updream/lock-assets`, { method: "POST" }),
  createUpdreamBootstrap: (id: string, workflowMode?: "agent-first") => request<{ project: Project; bootstrap: GenerationCenter["bootstrap"] }>(`/api/projects/${id}/handoff/updream/bootstrap`, { method: "POST", body: workflowMode ? JSON.stringify({ workflowMode }) : undefined }),
  createUpdreamShotPackage: (id: string, shotId: string, generationResolution: GenerationResolution, workflowMode?: "agent-first") => request<{ project: Project; package: HandoffPackageSummary }>(`/api/projects/${id}/handoff/updream/shots/${shotId}/package`, { method: "POST", body: JSON.stringify({ generationResolution, ...(workflowMode ? { workflowMode } : {}) }), timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS }),
  readUpdreamPrompt: (id: string, shotId: string, version: number) => request<{ prompt: string; path: string }>(`/api/projects/${id}/handoff/updream/shots/${shotId}/packages/${version}/prompt`),
  copyUpdreamMaterials: (id: string, shotId: string, version: number, label?: string) => request<{ count: number; files: Array<{ label: string; assetId: string; name: string; fileName: string }> }>(`/api/projects/${id}/handoff/updream/shots/${shotId}/packages/${version}/copy-materials`, {
    method: "POST",
    body: JSON.stringify(label ? { label } : {}),
  }),
  setAssetUploadState: (id: string, assetId: string, state: "not-uploaded" | "uploaded", workflowMode?: "agent-first") => request<{ asset: Asset }>(`/api/projects/${id}/assets/${assetId}/updream-upload-state`, {
    method: "PATCH", body: JSON.stringify({ state, ...(workflowMode ? { workflowMode } : {}) }),
  }),
  setPackageUploadState: (id: string, shotId: string, version: number, state: "not-uploaded" | "uploaded", workflowMode?: "agent-first") => request<{ package: HandoffPackageSummary }>(`/api/projects/${id}/handoff/updream/shots/${shotId}/packages/${version}/upload-state`, {
    method: "PATCH", body: JSON.stringify({ state, ...(workflowMode ? { workflowMode } : {}) }),
  }),
  qualityCenter: (id: string, workflowMode?: "agent-first") => request<QualityCenter>(`/api/projects/${id}/quality-center${workflowMode ? `?workflowMode=${workflowMode}` : ""}`),
  scanGenerationInbox: (id: string, workflowMode?: "agent-first") => request<GenerationScanResult>(`/api/projects/${id}/generations/scan`, { method: "POST", body: workflowMode ? JSON.stringify({ workflowMode }) : undefined }),
  generationMediaUrl: (id: string, jobId: string) => `/api/projects/${id}/generations/${jobId}/media`,
  generationReviewFrameUrl: (id: string, jobId: string, index: number) => `/api/projects/${id}/generations/${jobId}/review-frames/${index}`,
  reviewGeneration: (id: string, jobId: string, input: QualityReviewInput, workflowMode?: "agent-first") => request<{ project: Project; review: QualityReview }>(`/api/projects/${id}/generations/${jobId}/reviews`, {
    method: "POST", body: JSON.stringify({ ...input, ...(workflowMode ? { workflowMode } : {}) }), timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS,
  }),
  renderRoughCut: (id: string, workflowMode?: "agent-first") => request<{ project: Project; render: RenderRecord }>(`/api/projects/${id}/renders/rough-cut`, { method: "POST", body: workflowMode ? JSON.stringify({ workflowMode }) : undefined, timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS }),
  renderMediaUrl: (id: string, renderId: string) => `/api/projects/${id}/renders/${renderId}/media`,
  renderFileUrl: (id: string, renderId: string, kind: "video" | "subtitle" | "report") => `/api/projects/${id}/renders/${renderId}/files/${kind}`,
  decideRender: (id: string, renderId: string, decision: "approved" | "rejected", comment: string, workflowMode?: "agent-first") => request<{ project: Project; render: RenderRecord }>(`/api/projects/${id}/renders/${renderId}/decision`, {
    method: "POST", body: JSON.stringify({ decision, comment, ...(workflowMode ? { workflowMode } : {}) }),
  }),
};
