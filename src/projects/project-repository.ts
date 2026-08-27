import type { StudioDatabase } from "../database/client";

export interface WorkspaceProjectRow {
  id: string;
  title: string;
  targetDurationSec: number;
  aspectRatio: string;
  resolution: string;
  currentStage: string;
  projectDir: string;
  updatedAt: string;
}

export class ProjectRepository {
  constructor(private readonly studio: StudioDatabase) {}

  get(id: string): WorkspaceProjectRow | null {
    const row = this.studio.sqlite.prepare(`
      SELECT id, title, target_duration_sec, aspect_ratio, resolution, current_stage, project_dir, updated_at
      FROM projects WHERE id = ? AND archived_at IS NULL
    `).get(id) as {
      id: string; title: string; target_duration_sec: number; aspect_ratio: string; resolution: string;
      current_stage: string; project_dir: string; updated_at: string;
    } | undefined;
    return row ? {
      id: row.id,
      title: row.title,
      targetDurationSec: row.target_duration_sec,
      aspectRatio: row.aspect_ratio,
      resolution: row.resolution,
      currentStage: row.current_stage,
      projectDir: row.project_dir,
      updatedAt: row.updated_at,
    } : null;
  }

  require(id: string): WorkspaceProjectRow {
    const project = this.get(id);
    if (!project) throw new Error("项目不存在");
    return project;
  }
}
