import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export interface StudioDatabase {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database;
  runtimeRoot: string;
  dataRoot: string;
  projectsRoot: string;
}

export function createStudioDatabase(runtimeRoot: string): StudioDatabase {
  const resolvedRoot = path.resolve(runtimeRoot);
  const dataRoot = path.join(resolvedRoot, "data");
  const projectsRoot = path.join(resolvedRoot, "projects");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });

  const sqlite = new Database(path.join(dataRoot, "studio.sqlite"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      target_duration_sec INTEGER NOT NULL,
      aspect_ratio TEXT NOT NULL,
      resolution TEXT NOT NULL,
      video_type TEXT,
      visual_style TEXT,
      release_platform TEXT,
      target_audience TEXT,
      allow_story_suggestions INTEGER NOT NULL,
      current_stage TEXT NOT NULL,
      stale_stages TEXT NOT NULL DEFAULT '[]',
      source_path TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      stage TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      artifact_version INTEGER NOT NULL,
      decision TEXT NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      type TEXT NOT NULL,
      version INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      structured_path TEXT,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      source_artifact_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, type, version)
    );
    CREATE INDEX IF NOT EXISTS artifacts_project_type_version
      ON artifacts(project_id, type, version DESC);
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      approved INTEGER NOT NULL,
      PRIMARY KEY (project_id, id, version)
    );
    CREATE TABLE IF NOT EXISTS shots (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS generation_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      shot_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      parameter_hash TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS generation_idempotency
      ON generation_jobs(project_id, shot_id, provider, model, parameter_hash);
    CREATE TABLE IF NOT EXISTS quality_reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      job_id TEXT NOT NULL REFERENCES generation_jobs(id),
      shot_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS quality_reviews_job_created
      ON quality_reviews(job_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS renders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      video_path TEXT NOT NULL,
      subtitle_path TEXT,
      report_path TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, version)
    );
    CREATE INDEX IF NOT EXISTS renders_project_version
      ON renders(project_id, version DESC);
  `);

  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    runtimeRoot: resolvedRoot,
    dataRoot,
    projectsRoot,
  };
}
