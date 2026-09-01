import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStoreV3,
  ExistingArtifactContentAdapterV3,
  WorkflowV3MinimalChain,
  evaluateProductionGateV3,
  verifyArtifactV3,
  type ArtifactKindV3,
  type ArtifactRecordV3,
  type ProjectV3,
  type VerificationReceiptV3,
} from "../src/workflow-v3";
import { workflowV3ExistingGenerationProvider } from "./fixtures/workflow-v3-existing-provider";

const roots: string[] = [];
const decidedAt = "2026-08-31T10:00:00.000Z";
const project: ProjectV3 = {
  projectId: "10000000-0000-4000-8000-000000000001",
  title: "最小链路测试-001",
  targetDurationSec: 10,
  aspectRatio: "16:9",
  resolution: "1920x1080",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createStore(label: string): Promise<ArtifactStoreV3> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `workflow-v3-${label}-`));
  roots.push(root);
  return new ArtifactStoreV3(root, () => decidedAt);
}

async function commitPassed<T>(
  store: ArtifactStoreV3,
  kind: ArtifactKindV3,
  payload: T,
  inputArtifactIds: string[] = [],
): Promise<{ artifact: ArtifactRecordV3<T>; verification: VerificationReceiptV3 }> {
  const artifact = await store.commit({ projectId: project.projectId, kind, payload, inputArtifactIds });
  const verification = verifyArtifactV3({
    artifact,
    artifacts: await store.listArtifacts(project.projectId),
    now: () => decidedAt,
  });
  expect(verification.status).toBe("passed");
  await store.commitVerification(verification);
  return { artifact, verification };
}

async function outlineCandidate(store: ArtifactStoreV3, label: string) {
  const source = await commitPassed(store, "source", {
    content: { text: "source" },
    trace: { provider: "intake", runId: "source", completedAt: decidedAt },
  });
  const outline = await commitPassed(store, "outline", {
    content: { title: label, logline: label, beats: [{ beatId: "B1", summary: label }] },
    trace: { provider: "test", runId: `outline-${label}`, completedAt: decidedAt },
  }, [source.artifact.artifactId]);
  return { source, outline };
}

async function decide(store: ArtifactStoreV3, artifact: ArtifactRecordV3, verification: VerificationReceiptV3, decision: "approved" | "rejected") {
  return store.recordHumanDecision({
    projectId: project.projectId,
    artifactId: artifact.artifactId,
    artifactHash: artifact.contentHash,
    verificationReceiptId: verification.receiptId,
    decision,
    decidedAt,
  });
}

async function approveAndAdopt(store: ArtifactStoreV3, artifact: ArtifactRecordV3, verification: VerificationReceiptV3) {
  const approval = await decide(store, artifact, verification, "approved");
  const adoption = await store.adoptArtifact({
    projectId: project.projectId,
    artifactKind: artifact.kind,
    artifactId: artifact.artifactId,
    approvalReceiptId: approval.receiptId,
    adoptedAt: decidedAt,
  });
  return { approval, adoption };
}

function testGenerator() {
  return new ExistingArtifactContentAdapterV3(workflowV3ExistingGenerationProvider(), {
    providerName: "approval-adoption-test-double",
    model: "deterministic-test-model",
    now: () => decidedAt,
  });
}

describe("workflow-v3 Human Approval + Adoption", () => {
  it("A. verified + approved Artifact can be explicitly adopted", async () => {
    const store = await createStore("adopt-success");
    const { outline } = await outlineCandidate(store, "A");
    const { approval, adoption } = await approveAndAdopt(store, outline.artifact, outline.verification);

    expect(approval).toMatchObject({
      artifactId: outline.artifact.artifactId,
      artifactHash: outline.artifact.contentHash,
      verificationReceiptId: outline.verification.receiptId,
      decision: "approved",
      decidedBy: "human",
    });
    expect(adoption).toMatchObject({
      projectId: project.projectId,
      artifactKind: "outline",
      artifactId: outline.artifact.artifactId,
      artifactHash: outline.artifact.contentHash,
      approvalReceiptId: approval.receiptId,
    });
  });

  it("B. verified + rejected Artifact cannot be adopted and remains historical", async () => {
    const store = await createStore("adopt-rejected");
    const { source, outline: outlineA } = await outlineCandidate(store, "A");
    const { adoption: adoptionA } = await approveAndAdopt(store, outlineA.artifact, outlineA.verification);
    const outlineB = await commitPassed(store, "outline", {
      content: { title: "B", logline: "B", beats: [{ beatId: "B1", summary: "B" }] },
      trace: { provider: "test", runId: "outline-B", completedAt: decidedAt },
    }, [source.artifact.artifactId]);
    const rejection = await decide(store, outlineB.artifact, outlineB.verification, "rejected");

    await expect(store.adoptArtifact({
      projectId: project.projectId,
      artifactKind: "outline",
      artifactId: outlineB.artifact.artifactId,
      approvalReceiptId: rejection.receiptId,
      adoptedAt: decidedAt,
    })).rejects.toThrow("WORKFLOW_V3_APPROVAL_NOT_APPROVED");
    expect((await store.listApprovalReceipts(project.projectId)).map((receipt) => receipt.receiptId)).toContain(rejection.receiptId);
    expect(await store.getCurrentAdoption(project.projectId, "outline")).toEqual(adoptionA);
    expect((await store.listArtifacts(project.projectId)).map((artifact) => artifact.artifactId)).toContain(outlineB.artifact.artifactId);
  });

  it("C. verified Artifact without a human approval cannot be adopted", async () => {
    const store = await createStore("adopt-no-approval");
    const { outline } = await outlineCandidate(store, "A");
    const before = await store.listArtifacts(project.projectId);

    await expect(store.adoptArtifact({
      projectId: project.projectId,
      artifactKind: "outline",
      artifactId: outline.artifact.artifactId,
      approvalReceiptId: "missing-approval",
      adoptedAt: decidedAt,
    })).rejects.toThrow("WORKFLOW_V3_APPROVAL_NOT_FOUND");
    expect(await store.listArtifacts(project.projectId)).toEqual(before);
    expect(await store.getCurrentAdoption(project.projectId, "outline")).toBeNull();
  });

  it("D. approved receipt whose hash is tampered cannot be adopted", async () => {
    const store = await createStore("adopt-hash-mismatch");
    const { outline } = await outlineCandidate(store, "A");
    const approval = await decide(store, outline.artifact, outline.verification, "approved");
    const approvalDirectory = path.join(store.root, project.projectId, "approval-receipts");
    const [name] = await fs.readdir(approvalDirectory);
    const receiptPath = path.join(approvalDirectory, name);
    const raw = JSON.parse(await fs.readFile(receiptPath, "utf8")) as { artifactHash: string };
    raw.artifactHash = "0".repeat(64);
    await fs.writeFile(receiptPath, `${JSON.stringify(raw, null, 2)}\n`);

    await expect(store.adoptArtifact({
      projectId: project.projectId,
      artifactKind: "outline",
      artifactId: outline.artifact.artifactId,
      approvalReceiptId: approval.receiptId,
      adoptedAt: decidedAt,
    })).rejects.toThrow("WORKFLOW_V3_APPROVAL_HASH_MISMATCH");
    expect(await store.getCurrentAdoption(project.projectId, "outline")).toBeNull();
  });

  it("E. Artifact content tampering fails before Adoption", async () => {
    const store = await createStore("adopt-artifact-tamper");
    const { outline } = await outlineCandidate(store, "A");
    const approval = await decide(store, outline.artifact, outline.verification, "approved");
    const artifactDirectory = path.join(store.root, project.projectId, "artifacts");
    const name = (await fs.readdir(artifactDirectory)).find((value) => value.includes(outline.artifact.artifactId))!;
    const artifactPath = path.join(artifactDirectory, name);
    const raw = JSON.parse(await fs.readFile(artifactPath, "utf8")) as { payload: { content: { title: string } } };
    raw.payload.content.title = "tampered";
    await fs.writeFile(artifactPath, `${JSON.stringify(raw, null, 2)}\n`);

    await expect(store.adoptArtifact({
      projectId: project.projectId,
      artifactKind: "outline",
      artifactId: outline.artifact.artifactId,
      approvalReceiptId: approval.receiptId,
      adoptedAt: decidedAt,
    })).rejects.toThrow("WORKFLOW_V3_ARTIFACT_INTEGRITY_FAILED");
    expect(await store.getCurrentAdoption(project.projectId, "outline")).toBeNull();
  });

  it("F. newer verified Candidate B does not replace adopted A", async () => {
    const store = await createStore("candidate-does-not-adopt");
    const { source, outline: outlineA } = await outlineCandidate(store, "A");
    const { adoption: adoptionA } = await approveAndAdopt(store, outlineA.artifact, outlineA.verification);
    await commitPassed(store, "outline", {
      content: { title: "B", logline: "B", beats: [{ beatId: "B1", summary: "B" }] },
      trace: { provider: "test", runId: "outline-B", completedAt: decidedAt },
    }, [source.artifact.artifactId]);

    expect(await store.getCurrentAdoption(project.projectId, "outline")).toEqual(adoptionA);
  });

  it("G. explicit approve + adopt B replaces only current Adoption and retains A history", async () => {
    const store = await createStore("explicit-replace");
    const { source, outline: outlineA } = await outlineCandidate(store, "A");
    const approvedA = await approveAndAdopt(store, outlineA.artifact, outlineA.verification);
    const outlineB = await commitPassed(store, "outline", {
      content: { title: "B", logline: "B", beats: [{ beatId: "B1", summary: "B" }] },
      trace: { provider: "test", runId: "outline-B", completedAt: decidedAt },
    }, [source.artifact.artifactId]);
    const approvedB = await approveAndAdopt(store, outlineB.artifact, outlineB.verification);

    expect(await store.getCurrentAdoption(project.projectId, "outline")).toEqual(approvedB.adoption);
    expect((await store.listArtifacts(project.projectId)).map((artifact) => artifact.artifactId)).toEqual(expect.arrayContaining([
      outlineA.artifact.artifactId,
      outlineB.artifact.artifactId,
    ]));
    expect((await store.listApprovalReceipts(project.projectId)).map((receipt) => receipt.receiptId)).toEqual(expect.arrayContaining([
      approvedA.approval.receiptId,
      approvedB.approval.receiptId,
    ]));
  });

  it("H. Screenplay generation resolves the adopted Outline, never a newer unadopted Candidate", async () => {
    const store = await createStore("screenplay-adoption-input");
    const chain = new WorkflowV3MinimalChain({ project, sourceText: "source", generator: testGenerator(), store, now: () => decidedAt });
    const source = await chain.createSourceCandidate();
    const outlineA = await chain.generateOutlineCandidate(source.artifact);
    await approveAndAdopt(store, outlineA.artifact, outlineA.verification);
    const outlineB = await chain.generateOutlineCandidate(source.artifact);
    const screenplay = await chain.generateScreenplayCandidate(source.artifact);

    expect(screenplay.artifact.inputArtifactIds).toEqual([source.artifact.artifactId, outlineA.artifact.artifactId]);
    expect(screenplay.artifact.inputArtifactRefs).toContainEqual({ artifactId: outlineA.artifact.artifactId, contentHash: outlineA.artifact.contentHash });
    expect(screenplay.artifact.inputArtifactIds).not.toContain(outlineB.artifact.artifactId);
  });

  it("I. Shooting Script generation resolves only adopted Screenplay and Asset Bible", async () => {
    const store = await createStore("shooting-adoption-input");
    const chain = new WorkflowV3MinimalChain({ project, sourceText: "source", generator: testGenerator(), store, now: () => decidedAt });
    const source = await chain.createSourceCandidate();
    const outline = await chain.generateOutlineCandidate(source.artifact);
    await approveAndAdopt(store, outline.artifact, outline.verification);
    const screenplay = await chain.generateScreenplayCandidate(source.artifact);
    await approveAndAdopt(store, screenplay.artifact, screenplay.verification);
    const assetBible = await chain.generateAssetBibleCandidate(source.artifact);
    await approveAndAdopt(store, assetBible.artifact, assetBible.verification);
    const newerUnadoptedScreenplay = await chain.generateScreenplayCandidate(source.artifact);
    const newerUnadoptedAsset = await chain.generateAssetBibleCandidate(source.artifact);
    const shooting = await chain.generateShootingScriptCandidate(source.artifact);

    expect(shooting.artifact.inputArtifactIds).toEqual([screenplay.artifact.artifactId, assetBible.artifact.artifactId]);
    expect(shooting.artifact.inputArtifactIds).not.toContain(newerUnadoptedScreenplay.artifact.artifactId);
    expect(shooting.artifact.inputArtifactIds).not.toContain(newerUnadoptedAsset.artifact.artifactId);
  });

  it("J. adopting Shooting B leaves Storyboard A untouched and Gate emits one lineage root cause", async () => {
    const store = await createStore("gate-lineage-mismatch");
    const chain = new WorkflowV3MinimalChain({
      project,
      sourceText: "source",
      generator: testGenerator(),
      store,
      now: () => decidedAt,
      shotIdentity: (() => {
        const ids = [
          "20000000-0000-4000-8000-000000000001",
          "20000000-0000-4000-8000-000000000002",
          "20000000-0000-4000-8000-000000000003",
          "20000000-0000-4000-8000-000000000004",
        ];
        return () => ids.shift()!;
      })(),
    });
    const source = await chain.createSourceCandidate();
    const outline = await chain.generateOutlineCandidate(source.artifact);
    await approveAndAdopt(store, outline.artifact, outline.verification);
    const screenplay = await chain.generateScreenplayCandidate(source.artifact);
    await approveAndAdopt(store, screenplay.artifact, screenplay.verification);
    const asset = await chain.generateAssetBibleCandidate(source.artifact);
    await approveAndAdopt(store, asset.artifact, asset.verification);
    const shootingA = await chain.generateShootingScriptCandidate(source.artifact);
    await approveAndAdopt(store, shootingA.artifact, shootingA.verification);
    const storyboardA = await chain.generateStoryboardCandidate();
    await approveAndAdopt(store, storyboardA.artifact, storyboardA.verification);
    const shootingB = await chain.generateShootingScriptCandidate(source.artifact);
    await approveAndAdopt(store, shootingB.artifact, shootingB.verification);
    const storyboardSnapshot = structuredClone(await store.requireArtifact(storyboardA.artifact.artifactId));

    const adoptions = await store.listCurrentAdoptions(project.projectId);
    const gate = evaluateProductionGateV3({
      artifacts: await store.listArtifacts(project.projectId),
      verifications: await store.listVerifications(project.projectId),
      approvals: await store.listApprovalReceipts(project.projectId),
      adoptions,
      currentAdoptionReceipts: (await Promise.all(adoptions.map((current) => (
        store.getAdoptionReceipt(project.projectId, current.adoptionId)
      )))).filter((receipt) => receipt !== null),
    });

    expect(gate).toMatchObject({ passed: false });
    expect(gate.blockers).toEqual([expect.objectContaining({
      code: "V3_INPUT_CHAIN_MISMATCH",
      artifactId: storyboardA.artifact.artifactId,
    })]);
    expect(await store.requireArtifact(storyboardA.artifact.artifactId)).toEqual(storyboardSnapshot);
    expect((await store.listArtifacts(project.projectId)).some((artifact) => artifact.kind === "generation-package")).toBe(false);
  });

  it("K. failed Adoption creates no Artifact, Verification, Adoption, model call, Repair, or Revision", async () => {
    const store = await createStore("failure-side-effects");
    const { outline } = await outlineCandidate(store, "A");
    const artifactsBefore = await store.listArtifacts(project.projectId);
    const verificationsBefore = await store.listVerifications(project.projectId);
    const approvalsBefore = await store.listApprovalReceipts(project.projectId);

    await expect(store.adoptArtifact({
      projectId: project.projectId,
      artifactKind: "outline",
      artifactId: outline.artifact.artifactId,
      approvalReceiptId: "missing",
      adoptedAt: decidedAt,
    })).rejects.toThrow("WORKFLOW_V3_APPROVAL_NOT_FOUND");

    expect(await store.listArtifacts(project.projectId)).toEqual(artifactsBefore);
    expect(await store.listVerifications(project.projectId)).toEqual(verificationsBefore);
    expect(await store.listApprovalReceipts(project.projectId)).toEqual(approvalsBefore);
    expect(await store.listCurrentAdoptions(project.projectId)).toEqual([]);
    const failurePath = await Promise.all([
      "src/workflow-v3/human-adoption.ts",
      "src/workflow-v3/production-gate.ts",
    ].map((file) => fs.readFile(path.resolve(file), "utf8")));
    expect(failurePath.join("\n")).not.toMatch(/CodexCliProvider|generateOutline\s*\(|generateScreenplay\s*\(|generateAssetBible\s*\(|generateShootingScript\s*\(|generateStoryboard\s*\(|repair|revision/iu);
  });
});
