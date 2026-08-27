import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TextIntelligenceProvider } from "../src/ai/text-provider";
import { createStudioDatabase, type StudioDatabase } from "../src/database/client";
import { ProjectService } from "../src/projects/project-service";

const temporaryRoots: string[] = [];
const openDatabases: StudioDatabase[] = [];

afterEach(async () => {
  for (const studio of openDatabases.splice(0)) studio.sqlite.close();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createIsolatedService(): Promise<ProjectService> {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-video-artifact-source-test-"));
  temporaryRoots.push(runtimeRoot);
  const studio = createStudioDatabase(runtimeRoot);
  openDatabases.push(studio);
  return new ProjectService(studio, {} as TextIntelligenceProvider);
}

const projectInput = {
  title: "来源约束测试",
  sourceType: "story" as const,
  sourceText: "隔离测试原文。",
  targetDurationSec: 10,
  aspectRatio: "16:9",
  resolution: "1280x720",
  allowStorySuggestions: true,
};

describe("manual artifact source safety", () => {
  it("requires a manual source artifact to exist in the same project and have the same type", async () => {
    const service = await createIsolatedService();
    const firstProject = await service.create(projectInput);
    const secondProject = await service.create({ ...projectInput, title: "第二个隔离项目" });
    const firstOutline = (await service.createArtifactVersion(firstProject.id, "outline", "第一版大纲")).artifact;
    const secondOutline = (await service.createArtifactVersion(secondProject.id, "outline", "第二项目大纲")).artifact;

    await service.recordDecision({
      projectId: firstProject.id,
      stage: "OUTLINE_REVIEW",
      decision: "approved",
      artifactId: firstOutline.id,
      comment: "人工确认该大纲版本用于来源绑定测试",
    });
    const firstScreenplay = (await service.createArtifactVersion(firstProject.id, "screenplay", "第一版剧本", {
      sourceArtifactId: firstOutline.id,
    })).artifact;

    await expect(service.createArtifactVersion(firstProject.id, "screenplay", "跨项目来源", {
      sourceArtifactId: secondOutline.id,
      expectedLatestArtifactId: firstScreenplay.id,
      metadata: { origin: "manual-edit" },
    })).rejects.toThrow(/不属于当前项目/);

    await expect(service.createArtifactVersion(firstProject.id, "screenplay", "不存在来源", {
      sourceArtifactId: "22222222-2222-4222-8222-222222222222",
      expectedLatestArtifactId: firstScreenplay.id,
      metadata: { origin: "manual-edit" },
    })).rejects.toThrow(/来源产物不存在/);

    await expect(service.createArtifactVersion(firstProject.id, "screenplay", "错误来源类型", {
      sourceArtifactId: firstOutline.id,
      expectedLatestArtifactId: firstScreenplay.id,
      metadata: { origin: "manual-edit" },
    })).rejects.toThrow(/来源产物类型必须同为 screenplay/);

    await expect(service.createArtifactVersion(firstProject.id, "screenplay", "合法的第二版剧本", {
      sourceArtifactId: firstScreenplay.id,
      expectedLatestArtifactId: firstScreenplay.id,
      metadata: { origin: "manual-edit" },
    })).resolves.toMatchObject({ artifact: { version: 2, sourceArtifactId: firstScreenplay.id } });

    await expect(service.createArtifactVersion(firstProject.id, "screenplay", "基于旧快照的第三版", {
      sourceArtifactId: firstScreenplay.id,
      expectedLatestArtifactId: firstScreenplay.id,
      metadata: { origin: "manual-edit" },
    })).rejects.toThrow(/另一个标签页更新/);

    await expect(service.listArtifacts(firstProject.id, "screenplay"))
      .resolves.toMatchObject([{ version: 2 }, { version: 1 }]);
  });
});
