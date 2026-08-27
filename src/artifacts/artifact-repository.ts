import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { StudioDatabase } from "../database/client";
import { parseJsonObject } from "../database/row-utils";
import { artifactTypeSchema, type ArtifactType } from "../shared/schemas";

interface ArtifactRow {
  id: string; project_id: string; type: string; version: number; file_path: string;
  structured_path: string | null; content_hash: string; status: string;
  source_artifact_id: string | null; metadata: string; created_at: string; updated_at: string;
}

export interface StoredArtifact {
  id: string;
  projectId: string;
  type: ArtifactType;
  version: number;
  filePath: string;
  structuredPath: string | null;
  contentHash: string;
  status: string;
  sourceArtifactId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StoredArtifactEdge {
  artifactId: string;
  inputArtifactId: string;
  relation: string;
  createdAt: string;
}

function mapArtifact(row: ArtifactRow): StoredArtifact {
  return {
    id: row.id, projectId: row.project_id, type: artifactTypeSchema.parse(row.type), version: row.version,
    filePath: row.file_path, structuredPath: row.structured_path, contentHash: row.content_hash,
    status: row.status, sourceArtifactId: row.source_artifact_id, metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export class ArtifactRepository {
  constructor(private readonly studio: StudioDatabase) {}

  list(projectId: string, type?: ArtifactType): StoredArtifact[] {
    const rows = (type
      ? this.studio.sqlite.prepare("SELECT * FROM artifacts WHERE project_id = ? AND type = ? ORDER BY version DESC").all(projectId, type)
      : this.studio.sqlite.prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY type, version DESC").all(projectId)) as ArtifactRow[];
    return rows.map(mapArtifact);
  }

  get(id: string): StoredArtifact | null {
    const row = this.studio.sqlite.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  require(projectId: string, id: string): StoredArtifact {
    const artifact = this.get(id);
    if (!artifact || artifact.projectId !== projectId) throw new Error("产物版本不存在");
    return artifact;
  }

  async readContent(artifact: StoredArtifact): Promise<string> {
    const content = await fs.readFile(artifact.filePath, "utf8");
    const actualHash = createHash("sha256").update(content, "utf8").digest("hex");
    if (actualHash !== artifact.contentHash) throw new Error("产物文件哈希与数据库记录不一致");
    return content;
  }

  getHeads(projectId: string): Map<ArtifactType, string> {
    const rows = this.studio.sqlite.prepare("SELECT artifact_type, artifact_id FROM project_heads WHERE project_id = ?").all(projectId) as Array<{ artifact_type: string; artifact_id: string }>;
    return new Map(rows.map((row) => [artifactTypeSchema.parse(row.artifact_type), row.artifact_id]));
  }

  selectHead(projectId: string, type: ArtifactType, artifactId: string, selectedBy: "user" | "migration" | "system"): StoredArtifact {
    const artifact = this.require(projectId, artifactId);
    if (artifact.type !== type) throw new Error("Head 类型与产物类型不一致");
    const now = new Date().toISOString();
    this.studio.sqlite.prepare(`
      INSERT INTO project_heads(project_id, artifact_type, artifact_id, selected_at, selected_by)
      VALUES(?,?,?,?,?)
      ON CONFLICT(project_id, artifact_type) DO UPDATE SET
        artifact_id = excluded.artifact_id, selected_at = excluded.selected_at, selected_by = excluded.selected_by
    `).run(projectId, type, artifactId, now, selectedBy);
    return artifact;
  }

  listInputs(artifactId: string): StoredArtifactEdge[] {
    return (this.studio.sqlite.prepare(`
      SELECT artifact_id AS artifactId, input_artifact_id AS inputArtifactId, relation, created_at AS createdAt
      FROM artifact_edges WHERE artifact_id = ? ORDER BY created_at
    `).all(artifactId) as StoredArtifactEdge[]);
  }

  listDependents(inputArtifactId: string): StoredArtifactEdge[] {
    return (this.studio.sqlite.prepare(`
      SELECT artifact_id AS artifactId, input_artifact_id AS inputArtifactId, relation, created_at AS createdAt
      FROM artifact_edges WHERE input_artifact_id = ? ORDER BY created_at
    `).all(inputArtifactId) as StoredArtifactEdge[]);
  }

  addEdge(artifactId: string, inputArtifactId: string, relation: string, createdAt = new Date().toISOString()): void {
    this.studio.sqlite.prepare(`
      INSERT OR IGNORE INTO artifact_edges(artifact_id, input_artifact_id, relation, created_at) VALUES(?,?,?,?)
    `).run(artifactId, inputArtifactId, relation, createdAt);
  }

  listApprovals(artifact: StoredArtifact): Array<{ id: string; decision: string; comment: string | null; createdAt: string }> {
    return this.studio.sqlite.prepare(`
      SELECT id, decision, comment, created_at AS createdAt FROM approvals
      WHERE artifact_id = ? OR (artifact_id IS NULL AND project_id = ? AND artifact_path = ? AND artifact_hash = ?)
      ORDER BY created_at DESC
    `).all(artifact.id, artifact.projectId, artifact.filePath, artifact.contentHash) as Array<{ id: string; decision: string; comment: string | null; createdAt: string }>;
  }

  latestVersion(projectId: string, type: ArtifactType): number {
    const row = this.studio.sqlite.prepare("SELECT MAX(version) AS version FROM artifacts WHERE project_id = ? AND type = ?").get(projectId, type) as { version: number | null };
    return row.version ?? 0;
  }
}
