import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileAgentFirstWorkspace } from "../src/database/agent-first-backfill";
import { createStudioDatabase } from "../src/database/client";
import { runStudioMigrations } from "../src/database/migration-runner";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-first-foundation-"));
  roots.push(root);
  return root;
}

describe("agent-first database foundation", () => {
  it("applies additive migrations idempotently", async () => {
    const studio = createStudioDatabase(await createRoot());
    runStudioMigrations(studio.sqlite);
    const tables = studio.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      "schema_migrations", "project_heads", "artifact_edges", "operations", "operation_events",
      "project_issues", "agent_threads", "agent_messages", "revision_requests",
    ]));
    expect(studio.sqlite.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    expect((studio.sqlite.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("artifact_id");
    studio.sqlite.close();
  });

  it("backfills a valid latest Head and evidence-based dependency without changing legacy stages", async () => {
    const root = await createRoot();
    const studio = createStudioDatabase(root);
    const projectId = randomUUID();
    const projectDir = path.join(root, "projects", projectId);
    await fs.mkdir(path.join(projectDir, "outline"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "screenplay"), { recursive: true });
    const outlinePath = path.join(projectDir, "outline", "outline-v001.md");
    const screenplayPath = path.join(projectDir, "screenplay", "screenplay-v001.md");
    await fs.writeFile(outlinePath, "outline", "utf8");
    await fs.writeFile(screenplayPath, "screenplay", "utf8");
    const outlineId = randomUUID();
    const screenplayId = randomUUID();
    const now = new Date().toISOString();
    studio.sqlite.prepare(`INSERT INTO projects(
      id,title,source_type,target_duration_sec,aspect_ratio,resolution,allow_story_suggestions,
      current_stage,stale_stages,source_path,project_dir,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      projectId, "原地项目", "story", 20, "16:9", "1080p", 0,
      "SCREENPLAY_REVIEW", "[]", outlinePath, projectDir, now, now,
    );
    const insertArtifact = studio.sqlite.prepare(`INSERT INTO artifacts(
      id,project_id,type,version,file_path,structured_path,content_hash,status,source_artifact_id,metadata,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    insertArtifact.run(outlineId, projectId, "outline", 1, outlinePath, null, createHash("sha256").update("outline").digest("hex"), "approved", null, "{}", now, now);
    insertArtifact.run(screenplayId, projectId, "screenplay", 1, screenplayPath, null, createHash("sha256").update("screenplay").digest("hex"), "draft", outlineId, "{}", now, now);

    reconcileAgentFirstWorkspace(studio.sqlite);
    reconcileAgentFirstWorkspace(studio.sqlite);

    expect(studio.sqlite.prepare("SELECT artifact_id, selected_by FROM project_heads WHERE project_id = ? AND artifact_type = 'screenplay'").get(projectId))
      .toEqual({ artifact_id: screenplayId, selected_by: "migration" });
    expect(studio.sqlite.prepare("SELECT input_artifact_id, relation FROM artifact_edges WHERE artifact_id = ?").get(screenplayId))
      .toEqual({ input_artifact_id: outlineId, relation: "derived-from" });
    expect(studio.sqlite.prepare("SELECT current_stage, stale_stages FROM projects WHERE id = ?").get(projectId))
      .toEqual({ current_stage: "SCREENPLAY_REVIEW", stale_stages: "[]" });
    studio.sqlite.close();
  });
});
