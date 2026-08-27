import { createHash } from "node:crypto";
import fs from "node:fs";
import type Database from "better-sqlite3";

interface ArtifactRow {
  id: string;
  project_id: string;
  type: string;
  version: number;
  file_path: string;
  structured_path: string | null;
  content_hash: string;
  source_artifact_id: string | null;
  metadata: string;
  created_at: string;
}

const requiredInputs: Record<string, string[]> = {
  screenplay: ["outline"],
  "asset-bible": ["screenplay"],
  "shooting-script": ["asset-bible"],
  storyboard: ["shooting-script"],
};

function issueId(projectId: string, code: string, scopeId: string | null): string {
  return `issue-${createHash("sha256").update(`${projectId}|${code}|${scopeId ?? ""}`).digest("hex").slice(0, 32)}`;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function fileMatches(row: ArtifactRow): boolean {
  try {
    if (!fs.statSync(row.file_path).isFile()) return false;
    if (row.structured_path && !fs.statSync(row.structured_path).isFile()) return false;
    const hash = createHash("sha256").update(fs.readFileSync(row.file_path)).digest("hex");
    return hash === row.content_hash;
  } catch {
    return false;
  }
}

export function reconcileAgentFirstWorkspace(sqlite: Database.Database): void {
  const now = new Date().toISOString();
  const artifacts = sqlite.prepare(`
    SELECT id, project_id, type, version, file_path, structured_path, content_hash,
           source_artifact_id, metadata, created_at
    FROM artifacts ORDER BY project_id, type, version DESC
  `).all() as ArtifactRow[];
  const byId = new Map(artifacts.map((row) => [row.id, row]));
  const byHash = new Map(artifacts.map((row) => [`${row.project_id}|${row.content_hash}`, row]));
  const insertHead = sqlite.prepare(`
    INSERT INTO project_heads(project_id, artifact_type, artifact_id, selected_at, selected_by)
    VALUES (?, ?, ?, ?, 'migration') ON CONFLICT(project_id, artifact_type) DO NOTHING
  `);
  const insertEdge = sqlite.prepare(`
    INSERT OR IGNORE INTO artifact_edges(artifact_id, input_artifact_id, relation, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertIssue = sqlite.prepare(`
    INSERT OR IGNORE INTO project_issues(
      id, project_id, scope_type, scope_id, severity, code, title, detail,
      suggested_action, status, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'migration', ?)
  `);

  sqlite.transaction(() => {
    const groups = new Map<string, ArtifactRow[]>();
    for (const artifact of artifacts) {
      const key = `${artifact.project_id}|${artifact.type}`;
      groups.set(key, [...(groups.get(key) ?? []), artifact]);
    }
    for (const rows of groups.values()) {
      const valid = rows.find(fileMatches);
      if (valid) insertHead.run(valid.project_id, valid.type, valid.id, valid.created_at || now);
      else {
        const newest = rows[0];
        insertIssue.run(
          issueId(newest.project_id, "artifact-file-unverifiable", newest.id), newest.project_id,
          "artifact", newest.id, "error", "artifact-file-unverifiable", "产物文件无法核验",
          `${newest.type} V${String(newest.version).padStart(3, "0")} 的文件、结构化文件或哈希无法核验，因此没有自动选择 Head。`,
          "检查原文件后再由用户明确选择版本", now,
        );
      }
    }

    for (const artifact of artifacts) {
      const metadata = parseObject(artifact.metadata);
      const inputIds = new Map<string, string>();
      if (artifact.source_artifact_id && byId.get(artifact.source_artifact_id)?.project_id === artifact.project_id) {
        inputIds.set(artifact.source_artifact_id, "derived-from");
      }
      for (const key of ["basedOnArtifactId", "sourceArtifactId"] as const) {
        const candidate = metadata[key];
        if (typeof candidate === "string" && byId.get(candidate)?.project_id === artifact.project_id) inputIds.set(candidate, "derived-from");
      }
      const lock = metadata.approvedAssetBibleLock;
      if (lock && typeof lock === "object" && !Array.isArray(lock)) {
        const candidate = (lock as Record<string, unknown>).artifactId;
        if (typeof candidate === "string" && byId.get(candidate)?.project_id === artifact.project_id) inputIds.set(candidate, "references");
      }
      const inputs = metadata.inputArtifacts;
      if (Array.isArray(inputs)) {
        for (const input of inputs) {
          if (typeof input !== "string") continue;
          const hash = input.match(/:([a-f0-9]{64})$/iu)?.[1];
          const candidate = hash ? byHash.get(`${artifact.project_id}|${hash}`) : undefined;
          if (candidate) inputIds.set(candidate.id, "derived-from");
        }
      }
      for (const [inputId, relation] of inputIds) insertEdge.run(artifact.id, inputId, relation, artifact.created_at || now);

      const required = requiredInputs[artifact.type] ?? [];
      if (required.length && ![...inputIds.keys()].some((id) => required.includes(byId.get(id)?.type ?? ""))) {
        insertIssue.run(
          issueId(artifact.project_id, "lineage-unknown", artifact.id), artifact.project_id,
          "artifact", artifact.id, "warning", "lineage-unknown", "来源关系待确认",
          `${artifact.type} V${String(artifact.version).padStart(3, "0")} 没有足够证据关联所需上游版本；系统未猜测依赖。`,
          "核对产物 metadata、manifest 或生成记录后补充来源", now,
        );
      }

      if (artifact.type === "storyboard" && (metadata.continuityPassed === false
        || (metadata.verification && typeof metadata.verification === "object"
          && (metadata.verification as Record<string, unknown>).structuralConsistency === "blocked"))) {
        insertIssue.run(
          issueId(artifact.project_id, "storyboard-structure-blocked", artifact.id), artifact.project_id,
          "artifact", artifact.id, "error", "storyboard-structure-blocked", "分镜文字结构一致性未通过",
          `分镜 V${String(artifact.version).padStart(3, "0")} 的校验未通过；该问题只属于此版本，不会锁定项目或其他资料。`,
          "查看问题证据并创建显式修订请求", now,
        );
      }
    }

    sqlite.prepare(`
      UPDATE approvals SET artifact_id = (
        SELECT artifacts.id FROM artifacts
        WHERE artifacts.project_id = approvals.project_id
          AND artifacts.version = approvals.artifact_version
          AND artifacts.file_path = approvals.artifact_path
          AND artifacts.content_hash = approvals.artifact_hash
        LIMIT 1
      ) WHERE artifact_id IS NULL
    `).run();

    const jobs = sqlite.prepare("SELECT id, project_id FROM generation_jobs WHERE storyboard_artifact_id IS NULL").all() as Array<{ id: string; project_id: string }>;
    for (const job of jobs) {
      insertIssue.run(
        issueId(job.project_id, "generation-lineage-unknown", job.id), job.project_id,
        "generation", job.id, "warning", "generation-lineage-unknown", "生成视频来源关系待确认",
        "该生成记录没有可证明的分镜或镜头包 artifact ID，保留为历史快照。", "核对镜头包与分镜版本后补充来源", now,
      );
    }

    const renders = sqlite.prepare("SELECT id, project_id, payload, source_job_ids FROM renders").all() as Array<{ id: string; project_id: string; payload: string; source_job_ids: string | null }>;
    const updateRenderSources = sqlite.prepare("UPDATE renders SET source_job_ids = ? WHERE id = ? AND source_job_ids IS NULL");
    for (const render of renders) {
      const payload = parseObject(render.payload);
      if (!render.source_job_ids && Array.isArray(payload.sourceJobIds)) {
        updateRenderSources.run(JSON.stringify(payload.sourceJobIds.filter((id): id is string => typeof id === "string")), render.id);
      }
      insertIssue.run(
        issueId(render.project_id, "render-historical-snapshot", render.id), render.project_id,
        "render", render.id, "info", "render-historical-snapshot", "旧粗剪或交付已保留为历史快照",
        "该结果在旧状态机期间创建；只有补齐明确生成 manifest 和上游依赖后才能判断是否属于当前结果。",
        "查看来源明细，不自动重做或删除旧交付", now,
      );
    }
  })();
}
