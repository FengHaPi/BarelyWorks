import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UpdreamPackageBuilder } from "../src/handoff/updream-package-builder";
import { projectSchema, type Project } from "../src/shared/schemas";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createIsolatedProject(): Promise<Project> {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-video-updream-path-test-"));
  temporaryRoots.push(runtimeRoot);
  const projectDir = path.join(runtimeRoot, "projects", "11111111-1111-4111-8111-111111111111");
  await fs.mkdir(projectDir, { recursive: true });
  const now = new Date().toISOString();
  return projectSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    title: "隔离路径测试",
    sourceType: "story",
    targetDurationSec: 10,
    aspectRatio: "16:9",
    resolution: "1280x720",
    videoType: null,
    visualStyle: null,
    releasePlatform: null,
    targetAudience: null,
    allowStorySuggestions: true,
    currentStage: "READY_FOR_GENERATION",
    staleStages: [],
    sourcePath: path.join(projectDir, "source", "original-v001.txt"),
    projectDir,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPackage(project: Project): Promise<void> {
  const packagePath = path.join(project.projectDir, "handoff", "updream", "shots", "S001", "v001");
  const bootstrapPath = path.join(project.projectDir, "handoff", "updream", "bootstrap");
  const materialPath = path.join(bootstrapPath, "characters", "CHAR-001_剑客_主参考_V001_01.png");
  await Promise.all([fs.mkdir(packagePath, { recursive: true }), fs.mkdir(path.dirname(materialPath), { recursive: true })]);
  await Promise.all([
    fs.writeFile(path.join(packagePath, "prompt.txt"), "safe prompt\n", "utf8"),
    fs.writeFile(materialPath, "fake image", "utf8"),
    fs.writeFile(path.join(bootstrapPath, "asset-index.json"), `${JSON.stringify({ created_at: new Date().toISOString(), assets: [{}] })}\n`, "utf8"),
    fs.writeFile(path.join(packagePath, "manifest.json"), `${JSON.stringify({
      created_at: new Date().toISOString(),
      mode: "T2VA",
      requested_settings: { generation_resolution: "platform-default" },
      required_assets: [{
        asset_id: "CHAR-001",
        name: "剑客",
        labels: ["<Subject 1>"],
        kinds: ["image"],
        roles: ["character reference for S001"],
        bootstrap_files: ["characters/CHAR-001_剑客_主参考_V001_01.png"],
      }],
    })}\n`, "utf8"),
    fs.writeFile(path.join(packagePath, "upload-state.json"), `${JSON.stringify({ state: "not-uploaded" })}\n`, "utf8"),
  ]);
}

describe("Updream shot package path safety", () => {
  it("reads and updates a legal S001 package inside an isolated project", async () => {
    const project = await createIsolatedProject();
    await seedPackage(project);
    const builder = new UpdreamPackageBuilder();

    await expect(builder.readPrompt(project, "S001", 1)).resolves.toMatchObject({ prompt: "safe prompt\n" });
    await expect(builder.setPackageUploadState(project, "S001", 1, "uploaded")).resolves.toMatchObject({
      shotId: "S001",
      version: 1,
      uploadState: "uploaded",
    });
  });

  it("copies the package material file itself through the native clipboard adapter", async () => {
    const project = await createIsolatedProject();
    await seedPackage(project);
    const copiedBatches: string[][] = [];
    const builder = new UpdreamPackageBuilder({ copyFiles: async (filePaths) => { copiedBatches.push(filePaths); } });

    await expect(builder.copyPackageMaterials(project, "S001", 1, "<Subject 1>")).resolves.toMatchObject({
      count: 1,
      files: [expect.objectContaining({ label: "<Subject 1>", assetId: "CHAR-001", fileName: "CHAR-001_剑客_主参考_V001_01.png" })],
    });
    expect(copiedBatches).toHaveLength(1);
    expect(copiedBatches[0]?.[0]).toMatch(/bootstrap[\\/]characters[\\/]CHAR-001_剑客_主参考_V001_01\.png$/);
  });

  it("rejects traversal, separators, absolute paths, and illegal shot IDs before file access", async () => {
    const project = await createIsolatedProject();
    const builder = new UpdreamPackageBuilder();
    const invalidShotIds = [
      "..",
      "../S001",
      "..\\S001",
      "S001/../../S002",
      "S001\\..\\S002",
      "C:\\temp\\S001",
      "/tmp/S001",
      "s001",
      "S0000",
      "S001?",
    ];

    for (const shotId of invalidShotIds) {
      await expect(builder.readPrompt(project, shotId, 1)).rejects.toThrow(/镜头 ID 无效/);
      await expect(builder.setPackageUploadState(project, shotId, 1, "uploaded")).rejects.toThrow(/镜头 ID 无效/);
    }
  });

  it("rejects package versions that cannot map to a v001-v999 directory", async () => {
    const project = await createIsolatedProject();
    const builder = new UpdreamPackageBuilder();

    for (const version of [0, -1, 1.5, 1_000, Number.NaN]) {
      await expect(builder.readPrompt(project, "S001", version)).rejects.toThrow(/镜头包版本无效/);
      await expect(builder.setPackageUploadState(project, "S001", version, "uploaded")).rejects.toThrow(/镜头包版本无效/);
    }
  });
});
