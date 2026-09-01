import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkflowV3LiveE2E, type ProjectV3 } from "../src/workflow-v3";

const liveEnabled = process.env.WORKFLOW_V3_LIVE === "1";

async function fileFingerprint(filePath: string): Promise<{ exists: boolean; sha256: string | null; size: number | null }> {
  try {
    const value = await fs.readFile(filePath);
    return { exists: true, sha256: createHash("sha256").update(value).digest("hex"), size: value.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, sha256: null, size: null };
    throw error;
  }
}

describe.skipIf(!liveEnabled)("workflow-v3 最小链路测试-001 LIVE", () => {
  it("runs one real Codex model pass from Source to Generation Package", async () => {
    const repositoryRoot = path.resolve(".");
    const oldDatabasePath = path.join(repositoryRoot, "data", "studio.sqlite");
    const databaseBefore = await fileFingerprint(oldDatabasePath);
    const runId = process.env.WORKFLOW_V3_LIVE_RUN_ID?.trim() || `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
    const outputRoot = path.resolve(process.env.WORKFLOW_V3_LIVE_OUTPUT_ROOT?.trim() || path.join(repositoryRoot, "projects", "workflow-v3-live"));
    const runRoot = path.join(outputRoot, runId);
    const project: ProjectV3 = {
      projectId: "30000000-0000-4000-8000-000000000001",
      title: "最小链路测试-001",
      targetDurationSec: 15,
      aspectRatio: "16:9",
      resolution: "1920x1080",
      visualStyle: "克制的电影感写实风格",
    };
    const sourceText = [
      "成片总时长必须为15秒。",
      "必须恰好使用2个生产镜头：S001 0-7秒，S002 7-15秒。",
      "雨夜，一个独自回家的年轻人走进旧公寓电梯。",
      "S001中他进入空电梯，门关闭后发现镜中的自己慢半拍。",
      "S002中电梯灯闪烁，镜中人没有跟随他回头，而是直视镜外；电梯到站开门，现实中的他立刻退出。",
      "不要增加其他人物、地点或支线。",
    ].join("\n");

    const result = await runWorkflowV3LiveE2E({ repositoryRoot, runRoot, project, sourceText });
    const databaseAfter = await fileFingerprint(oldDatabasePath);
    expect(databaseAfter).toEqual(databaseBefore);
    expect(result.status, result.status === "failed" ? JSON.stringify(result.failure, null, 2) : undefined).toBe("passed");
    if (result.status !== "passed") return;

    const generatedKinds = ["outline", "screenplay", "asset-bible", "shooting-script", "storyboard"] as const;
    for (const kind of generatedKinds) {
      const artifact = result.artifacts.find((candidate) => candidate.kind === kind);
      const trace = (artifact?.payload as { trace?: { provider?: string; model?: string; runId?: string; eventTypes?: string[] } } | undefined)?.trace;
      expect(trace?.provider, `${kind} provider`).toBe("codex-cli");
      expect(trace?.model, `${kind} model`).toBeTruthy();
      expect(trace?.runId, `${kind} runId`).toBeTruthy();
      expect(trace?.eventTypes, `${kind} eventTypes`).toContain("turn.completed");
    }

    expect(result.content.shootingScript.shots.map((shot) => shot.displayId)).toEqual(["S001", "S002"]);
    expect(new Set(result.content.shootingScript.shots.map((shot) => shot.shotUid)).size).toBe(2);
    expect(result.content.storyboard.frames.map((frame) => frame.shotUid))
      .toEqual(result.content.shootingScript.shots.map((shot) => shot.shotUid));
    expect(result.content.generationPackage.tasks.map((task) => task.shotUid))
      .toEqual(result.content.shootingScript.shots.map((shot) => shot.shotUid));
    expect(result.approvals).toHaveLength(5);
    expect(result.approvals.every((receipt) => receipt.decision === "approved" && receipt.decidedBy === "human")).toBe(true);
    expect(result.adoptions).toHaveLength(5);
    expect(result.adoptionHistory).toHaveLength(5);
    for (const adoption of result.adoptions) {
      const artifact = result.artifacts.find((candidate) => candidate.artifactId === adoption.artifactId)!;
      expect(result.adoptionHistory.find((receipt) => receipt.adoptionId === adoption.adoptionId)).toMatchObject({
        artifactId: artifact.artifactId,
        artifactHash: artifact.contentHash,
        approvalReceiptId: adoption.approvalReceiptId,
        adoptedBy: "human",
      });
      expect(adoption.artifactHash).toBe(artifact.contentHash);
      expect(result.approvals.find((receipt) => receipt.receiptId === adoption.approvalReceiptId)).toMatchObject({
        artifactId: artifact.artifactId,
        artifactHash: artifact.contentHash,
        decision: "approved",
        decidedBy: "human",
      });
    }
    expect(result.productionGate).toEqual(expect.objectContaining({ passed: true, blockers: [] }));
    expect(result.resultPath).toBe(path.join(runRoot, "live-e2e-result.json"));
  });
});
