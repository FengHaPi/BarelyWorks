import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  sourceType: text("source_type").notNull(),
  targetDurationSec: integer("target_duration_sec").notNull(),
  aspectRatio: text("aspect_ratio").notNull(),
  resolution: text("resolution").notNull(),
  videoType: text("video_type"),
  visualStyle: text("visual_style"),
  releasePlatform: text("release_platform"),
  targetAudience: text("target_audience"),
  allowStorySuggestions: integer("allow_story_suggestions", { mode: "boolean" }).notNull(),
  currentStage: text("current_stage").notNull(),
  staleStages: text("stale_stages", { mode: "json" }).$type<string[]>().notNull(),
  sourcePath: text("source_path").notNull(),
  projectDir: text("project_dir").notNull(),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  stage: text("stage").notNull(),
  artifactPath: text("artifact_path").notNull(),
  artifactHash: text("artifact_hash").notNull(),
  artifactVersion: integer("artifact_version").notNull(),
  artifactId: text("artifact_id"),
  decision: text("decision").notNull(),
  comment: text("comment"),
  createdAt: text("created_at").notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  type: text("type").notNull(),
  version: integer("version").notNull(),
  filePath: text("file_path").notNull(),
  structuredPath: text("structured_path"),
  contentHash: text("content_hash").notNull(),
  status: text("status").notNull(),
  sourceArtifactId: text("source_artifact_id"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const assets = sqliteTable("assets", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  approved: integer("approved", { mode: "boolean" }).notNull(),
});

export const shots = sqliteTable("shots", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull(),
  sequence: integer("sequence").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull(),
});

export const generationJobs = sqliteTable("generation_jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  shotId: text("shot_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  parameterHash: text("parameter_hash").notNull(),
  storyboardArtifactId: text("storyboard_artifact_id"),
  shotPackageArtifactId: text("shot_package_artifact_id"),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});

export const qualityReviews = sqliteTable("quality_reviews", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  jobId: text("job_id").notNull(),
  shotId: text("shot_id").notNull(),
  decision: text("decision").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: text("created_at").notNull(),
});

export const renders = sqliteTable("renders", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  videoPath: text("video_path").notNull(),
  subtitlePath: text("subtitle_path"),
  reportPath: text("report_path").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  manifestArtifactId: text("manifest_artifact_id"),
  sourceJobIds: text("source_job_ids", { mode: "json" }).$type<string[]>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: text("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: text("applied_at").notNull(),
  checksum: text("checksum").notNull(),
});

export const projectHeads = sqliteTable("project_heads", {
  projectId: text("project_id").notNull(),
  artifactType: text("artifact_type").notNull(),
  artifactId: text("artifact_id").notNull(),
  selectedAt: text("selected_at").notNull(),
  selectedBy: text("selected_by").notNull(),
});

export const artifactEdges = sqliteTable("artifact_edges", {
  artifactId: text("artifact_id").notNull(),
  inputArtifactId: text("input_artifact_id").notNull(),
  relation: text("relation").notNull(),
  createdAt: text("created_at").notNull(),
});

export const operations = sqliteTable("operations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  kind: text("kind").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  status: text("status").notNull(),
  phase: text("phase"),
  progressCurrent: integer("progress_current"),
  progressTotal: integer("progress_total"),
  requestPayload: text("request_payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  resultPayload: text("result_payload", { mode: "json" }).$type<Record<string, unknown>>(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  retryable: integer("retryable", { mode: "boolean" }).notNull(),
  processId: integer("process_id"),
  idempotencyKey: text("idempotency_key"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  heartbeatAt: text("heartbeat_at"),
});

export const operationEvents = sqliteTable("operation_events", {
  operationId: text("operation_id").notNull(),
  sequence: integer("sequence").notNull(),
  eventType: text("event_type").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: text("created_at").notNull(),
});

export const projectIssues = sqliteTable("project_issues", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id"),
  severity: text("severity").notNull(),
  code: text("code").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  suggestedAction: text("suggested_action"),
  status: text("status").notNull(),
  source: text("source").notNull(),
  resolutionNote: text("resolution_note"),
  resolvedBy: text("resolved_by"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const agentThreads = sqliteTable("agent_threads", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentMessages = sqliteTable("agent_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  messageType: text("message_type").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  operationId: text("operation_id"),
  createdAt: text("created_at").notNull(),
});

export const revisionRequests = sqliteTable("revision_requests", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  targetArtifactId: text("target_artifact_id").notNull(),
  targetType: text("target_type").notNull(),
  instruction: text("instruction").notNull(),
  intent: text("intent").notNull(),
  status: text("status").notNull(),
  operationId: text("operation_id"),
  outputArtifactId: text("output_artifact_id"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});
