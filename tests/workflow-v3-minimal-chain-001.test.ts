import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStoreV3,
  ExistingArtifactContentAdapterV3,
  WorkflowV3MinimalChain,
  type ArtifactRecordV3,
  type ProjectV3,
  type ShootingScriptContentV3,
  type VerificationReceiptV3,
} from "../src/workflow-v3";
import { workflowV3ExistingGenerationProvider } from "./fixtures/workflow-v3-existing-provider";
import {
  createRepairContractV3,
  inspectShootingRepairV3,
} from "../src/workflow-v3/repair-contract";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const project: ProjectV3 = {
  projectId: "10000000-0000-4000-8000-000000000001",
  title: "最小链路测试-001",
  targetDurationSec: 10,
  aspectRatio: "16:9",
  resolution: "1920x1080",
};

describe("workflow-v3 最小链路测试-001", () => {
  it("runs Source to Generation Package without legacy state-machine or database writes", async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-v3-001-"));
    temporaryRoots.push(runtimeRoot);
    const store = new ArtifactStoreV3(path.join(runtimeRoot, "workflow-v3"));

    const chain = new WorkflowV3MinimalChain({
      project,
      sourceText: "雨夜，一个陌生人进入旧电梯，在镜中看到延迟出现的线索。",
      generator: new ExistingArtifactContentAdapterV3(workflowV3ExistingGenerationProvider(), {
        providerName: "minimal-chain-001-double",
        model: "deterministic-test-model",
        now: () => "2026-08-31T00:00:00.000Z",
      }),
      store,
      now: () => "2026-08-31T00:00:00.000Z",
      shotIdentity: (() => {
        const ids = [
          "20000000-0000-4000-8000-000000000001",
          "20000000-0000-4000-8000-000000000002",
        ];
        return () => ids.shift()!;
      })(),
    });
    const approveAndAdopt = async (artifact: ArtifactRecordV3, verification: VerificationReceiptV3) => {
      const approval = await store.recordHumanDecision({
        projectId: project.projectId,
        artifactId: artifact.artifactId,
        artifactHash: artifact.contentHash,
        verificationReceiptId: verification.receiptId,
        decision: "approved",
        decidedAt: "2026-08-31T00:00:00.000Z",
      });
      return store.adoptArtifact({
        projectId: project.projectId,
        artifactKind: artifact.kind,
        artifactId: artifact.artifactId,
        approvalReceiptId: approval.receiptId,
        adoptedAt: "2026-08-31T00:00:00.000Z",
      });
    };
    const source = await chain.createSourceCandidate();
    const outline = await chain.generateOutlineCandidate(source.artifact);
    await approveAndAdopt(outline.artifact, outline.verification);
    const screenplay = await chain.generateScreenplayCandidate(source.artifact);
    await approveAndAdopt(screenplay.artifact, screenplay.verification);
    const assetBible = await chain.generateAssetBibleCandidate(source.artifact);
    await approveAndAdopt(assetBible.artifact, assetBible.verification);
    const shootingScript = await chain.generateShootingScriptCandidate(source.artifact);
    await approveAndAdopt(shootingScript.artifact, shootingScript.verification);
    const storyboard = await chain.generateStoryboardCandidate();
    await approveAndAdopt(storyboard.artifact, storyboard.verification);
    const generationPackage = await chain.generatePackage();
    const artifacts = await store.listArtifacts(project.projectId);
    const verifications = await store.listVerifications(project.projectId);

    expect(artifacts.map((artifact) => artifact.kind)).toEqual([
      "source", "outline", "screenplay", "asset-bible", "shooting-script", "storyboard", "generation-package",
    ]);
    expect(artifacts.every((artifact) => artifact.version === 1)).toBe(true);
    expect(generationPackage.productionGate).toMatchObject({ passed: true, blockers: [] });
    expect(verifications).toHaveLength(7);
    expect(verifications.every((receipt) => receipt.status === "passed")).toBe(true);
    expect(await store.listApprovalReceipts(project.projectId)).toHaveLength(5);
    expect(await store.listCurrentAdoptions(project.projectId)).toHaveLength(5);
    expect(await store.listAdoptionHistory(project.projectId)).toHaveLength(5);

    const shooting = shootingScript.content;
    const storyboardContent = storyboard.content;
    const generationPackageContent = generationPackage.content;
    expect(shooting.shots.map((shot) => shot.shotUid)).toEqual([
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ]);
    expect(storyboardContent.frames.map((frame) => frame.shotUid)).toEqual(shooting.shots.map((shot) => shot.shotUid));
    expect(generationPackageContent.tasks.map((task) => task.shotUid)).toEqual(shooting.shots.map((shot) => shot.shotUid));
    expect(generationPackageContent.sourceArtifactIds).toEqual(artifacts.slice(3, 6).map((artifact) => artifact.artifactId));

    const stored = await store.listArtifacts(project.projectId);
    expect(stored.map((artifact) => artifact.artifactId)).toEqual(artifacts.map((artifact) => artifact.artifactId));
    expect(await store.listVerifications(project.projectId)).toHaveLength(7);
    expect(await fs.readdir(runtimeRoot)).toEqual(["workflow-v3"]);
  });

  it("uses immutable parent/input versions and never treats displayId as Shot identity", async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-v3-version-"));
    temporaryRoots.push(runtimeRoot);
    const store = new ArtifactStoreV3(runtimeRoot);
    const source = await store.commit({ projectId: project.projectId, kind: "source", payload: { text: "v1" }, inputArtifactIds: [] });
    const revised = await store.commit({
      projectId: project.projectId,
      kind: "source",
      parentArtifactId: source.artifactId,
      payload: { text: "v2" },
      inputArtifactIds: [],
    });
    expect([source.version, revised.version]).toEqual([1, 2]);
    expect(revised.parentArtifactId).toBe(source.artifactId);
    expect(Object.isFrozen(await store.requireArtifact(source.artifactId))).toBe(true);
  });

  it("rejects non-local topology and unmapped Repair instead of calling a legacy repair path", () => {
    const baseline: ShootingScriptContentV3 = {
      shots: [{
        shotUid: "20000000-0000-4000-8000-000000000001",
        displayId: "S001",
        sceneId: "SCENE-001",
        durationSec: 5,
        action: "baseline",
        startState: "start",
        endState: "end",
        camera: { position: "front", movement: "locked" },
        assetIds: ["SCENE-001"],
      }],
    };
    expect(createRepairContractV3({ baselineArtifactId: "artifact-1", baselineHash: "hash-1", baseline, issues: [{ code: "UNKNOWN", affectedShotUids: [baseline.shots[0].shotUid] }] }))
      .toMatchObject({ status: "UNMAPPED_ISSUE" });

    const contract = createRepairContractV3({
      baselineArtifactId: "artifact-1",
      baselineHash: "hash-1",
      baseline,
      issues: [{ code: "CAMERA_POSITION_MISMATCH", affectedShotUids: [baseline.shots[0].shotUid] }],
    });
    expect(contract.status).toBe("READY");
    const localCandidate = structuredClone(baseline);
    localCandidate.shots[0].camera.position = "profile";
    expect(inspectShootingRepairV3(contract, baseline, localCandidate)).toEqual({ passed: true, code: "PASSED", violations: [] });

    const pollutedCandidate = structuredClone(localCandidate);
    pollutedCandidate.shots[0].camera.movement = "pan";
    expect(inspectShootingRepairV3(contract, baseline, pollutedCandidate)).toMatchObject({
      passed: false,
      code: "REGRESSION",
      violations: [`${baseline.shots[0].shotUid}.camera.movement`],
    });

    const candidate = structuredClone(baseline);
    candidate.shots.push({ ...candidate.shots[0], shotUid: "20000000-0000-4000-8000-000000000002", displayId: "S002" });
    expect(inspectShootingRepairV3(contract, baseline, candidate)).toMatchObject({
      passed: false,
      code: "NON_LOCAL_REPAIR_REQUIRED",
    });
  });
});
