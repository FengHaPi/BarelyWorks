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
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
