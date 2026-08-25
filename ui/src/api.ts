import type { Artifact, ArtifactType, Asset, AssetDesignMode, CreateProjectInput, GenerationCenter, GenerationScanResult, HandoffPackageSummary, Health, Project, ProjectStage, QualityCenter, QualityReview, QualityReviewInput, RenderRecord, ShotSpec } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
  });
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `请求失败 (${response.status})`);
  return payload;
}

export const api = {
  health: () => request<Health>("/api/health"),
  listProjects: () => request<{ projects: Project[] }>("/api/projects"),
  createProject: (input: CreateProjectInput) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}`),
  getSource: (id: string) => request<{ sourceText: string; sourcePath: string }>(`/api/projects/${id}/source`),
  listArtifacts: (id: string, type: ArtifactType) =>
    request<{ artifacts: Artifact[] }>(`/api/projects/${id}/artifacts/${type}`),
  saveArtifact: (id: string, type: ArtifactType, content: string, sourceArtifactId?: string | null) =>
    request<{ project: Project; artifact: Artifact }>(`/api/projects/${id}/artifacts/${type}`, {
      method: "POST",
      body: JSON.stringify({ content, sourceArtifactId }),
    }),
  generateArtifact: (id: string, type: ArtifactType, options?: { designMode?: AssetDesignMode }) =>
    request<{ project: Project; artifact: Artifact }>(`/api/projects/${id}/stages/${type}/generate`, {
      method: "POST",
      body: type === "asset-bible" ? JSON.stringify({ designMode: options?.designMode ?? "original-proposal" }) : undefined,
    }),
  listAssets: (id: string) => request<{ assets: Asset[] }>(`/api/projects/${id}/assets`),
  uploadAssetReference: (id: string, assetId: string, input: { fileName: string; mimeType: string; dataBase64: string; role: string; authorizationConfirmed: true }) =>
    request<{ asset: Asset }>(`/api/projects/${id}/assets/${assetId}/references`, { method: "POST", body: JSON.stringify(input) }),
  assetReferenceUrl: (id: string, assetId: string, index: number) => `/api/projects/${id}/assets/${assetId}/references/${index}`,
  listShots: (id: string) => request<{ shots: ShotSpec[] }>(`/api/projects/${id}/shots`),
  updateShot: (id: string, shot: ShotSpec) => request<{ project: Project; artifact: Artifact; shot: ShotSpec }>(`/api/projects/${id}/shots/${shot.id}`, {
    method: "PATCH",
    body: JSON.stringify(shot),
  }),
  decide: (id: string, stage: ProjectStage, artifactId: string, decision: "approve" | "reject", comment: string) =>
    request<{ project: Project }>(`/api/projects/${id}/stages/${stage}/${decision}`, {
      method: "POST",
      body: JSON.stringify({ artifactId, comment }),
    }),
  generationCenter: (id: string) => request<GenerationCenter>(`/api/projects/${id}/generation-center`),
  lockAssets: (id: string) => request<{ project: Project }>(`/api/projects/${id}/handoff/updream/lock-assets`, { method: "POST" }),
  createUpdreamBootstrap: (id: string) => request<{ project: Project; bootstrap: GenerationCenter["bootstrap"] }>(`/api/projects/${id}/handoff/updream/bootstrap`, { method: "POST" }),
  createUpdreamShotPackage: (id: string, shotId: string) => request<{ project: Project; package: HandoffPackageSummary }>(`/api/projects/${id}/handoff/updream/shots/${shotId}/package`, { method: "POST" }),
  readUpdreamPrompt: (id: string, shotId: string, version: number) => request<{ prompt: string; path: string }>(`/api/projects/${id}/handoff/updream/shots/${shotId}/packages/${version}/prompt`),
  setAssetUploadState: (id: string, assetId: string, state: "not-uploaded" | "uploaded") => request<{ asset: Asset }>(`/api/projects/${id}/assets/${assetId}/updream-upload-state`, {
    method: "PATCH", body: JSON.stringify({ state }),
  }),
  setPackageUploadState: (id: string, shotId: string, version: number, state: "not-uploaded" | "uploaded") => request<{ package: HandoffPackageSummary }>(`/api/projects/${id}/handoff/updream/shots/${shotId}/packages/${version}/upload-state`, {
    method: "PATCH", body: JSON.stringify({ state }),
  }),
  qualityCenter: (id: string) => request<QualityCenter>(`/api/projects/${id}/quality-center`),
  scanGenerationInbox: (id: string) => request<GenerationScanResult>(`/api/projects/${id}/generations/scan`, { method: "POST" }),
  generationMediaUrl: (id: string, jobId: string) => `/api/projects/${id}/generations/${jobId}/media`,
  reviewGeneration: (id: string, jobId: string, input: QualityReviewInput) => request<{ project: Project; review: QualityReview }>(`/api/projects/${id}/generations/${jobId}/reviews`, {
    method: "POST", body: JSON.stringify(input),
  }),
  renderRoughCut: (id: string) => request<{ project: Project; render: RenderRecord }>(`/api/projects/${id}/renders/rough-cut`, { method: "POST" }),
  renderMediaUrl: (id: string, renderId: string) => `/api/projects/${id}/renders/${renderId}/media`,
  decideRender: (id: string, renderId: string, decision: "approved" | "rejected", comment: string) => request<{ project: Project; render: RenderRecord }>(`/api/projects/${id}/renders/${renderId}/decision`, {
    method: "POST", body: JSON.stringify({ decision, comment }),
  }),
};
