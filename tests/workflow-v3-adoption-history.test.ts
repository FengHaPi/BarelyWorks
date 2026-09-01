import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactStoreV3,
  ExistingArtifactContentAdapterV3,
  WorkflowV3MinimalChain,
  evaluateProductionGateV3,
  verifyArtifactV3,
  type ArtifactRecordV3,
  type ProjectV3,
  type VerificationReceiptV3,
} from "../src/workflow-v3";
import { workflowV3ExistingGenerationProvider } from "./fixtures/workflow-v3-existing-provider";

const roots: string[] = [];
const timestampA = "2026-08-31T11:00:00.000Z";
const timestampB = "2026-08-31T11:05:00.000Z";
const project: ProjectV3 = {
  projectId: "10000000-0000-4000-8000-000000000001",
  title: "最小链路测试-001",
  targetDurationSec: 10,
  aspectRatio: "16:9",
  resolution: "1920x1080",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createStore(label: string): Promise<ArtifactStoreV3> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `workflow-v3-history-${label}-`));
  roots.push(root);
  return new ArtifactStoreV3(root, () => timestampA);
}

async function commitPassed<T>(store: ArtifactStoreV3, payload: T, inputArtifactIds: string[]) {
  const artifact = await store.commit({ projectId: project.projectId, kind: "outline", payload, inputArtifactIds });
  const verification = verifyArtifactV3({
    artifact,
    artifacts: await store.listArtifacts(project.projectId),
    now: () => timestampA,
  });
  expect(verification.status).toBe("passed");
  await store.commitVerification(verification);
  return { artifact, verification };
}

async function createOutlineFixture(store: ArtifactStoreV3) {
  const source = await store.commit({
    projectId: project.projectId,
    kind: "source",
    payload: {
      content: { text: "source" },
      trace: { provider: "intake", runId: "source", completedAt: timestampA },
    },
    inputArtifactIds: [],
  });
  const sourceVerification = verifyArtifactV3({
    artifact: source,
    artifacts: [source],
    now: () => timestampA,
  });
  await store.commitVerification(sourceVerification);
  const candidate = async (label: string) => commitPassed(store, {
    content: { title: label, logline: label, beats: [{ beatId: "B1", summary: label }] },
    trace: { provider: "test", runId: `outline-${label}`, completedAt: timestampA },
  }, [source.artifactId]);
  return { source, candidate };
}

async function approve(store: ArtifactStoreV3, artifact: ArtifactRecordV3, verification: VerificationReceiptV3) {
  return store.recordHumanDecision({
    projectId: project.projectId,
    artifactId: artifact.artifactId,
    artifactHash: artifact.contentHash,
    verificationReceiptId: verification.receiptId,
    decision: "approved",
    decidedAt: timestampA,
  });
}

async function adopt(
  store: ArtifactStoreV3,
  candidate: { artifact: ArtifactRecordV3; verification: VerificationReceiptV3 },
  adoptedAt: string,
) {
  const approval = await approve(store, candidate.artifact, candidate.verification);
  const current = await store.adoptArtifact({
    projectId: project.projectId,
    artifactKind: candidate.artifact.kind,
    artifactId: candidate.artifact.artifactId,
    approvalReceiptId: approval.receiptId,
    adoptedAt,
  });
  return { approval, current };
}

async function createAThenB(store: ArtifactStoreV3) {
  const fixture = await createOutlineFixture(store);
  const candidateA = await fixture.candidate("A");
  const adoptedA = await adopt(store, candidateA, timestampA);
  const candidateB = await fixture.candidate("B");
  const adoptedB = await adopt(store, candidateB, timestampB);
  return { ...fixture, candidateA, adoptedA, candidateB, adoptedB };
}

function testGenerator() {
  return new ExistingArtifactContentAdapterV3(workflowV3ExistingGenerationProvider(), {
    providerName: "adoption-history-test-double",
    model: "deterministic-test-model",
    now: () => timestampA,
  });
}

async function buildFullChain(store: ArtifactStoreV3) {
  const chain = new WorkflowV3MinimalChain({
    project,
    sourceText: "source",
    generator: testGenerator(),
    store,
    now: () => timestampA,
    shotIdentity: (() => {
      const ids = ["20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"];
      return () => ids.shift()!;
    })(),
  });
  const source = await chain.createSourceCandidate();
  const outline = await chain.generateOutlineCandidate(source.artifact);
  await adopt(store, outline, timestampA);
  const screenplay = await chain.generateScreenplayCandidate(source.artifact);
  await adopt(store, screenplay, timestampA);
  const assetBible = await chain.generateAssetBibleCandidate(source.artifact);
  await adopt(store, assetBible, timestampA);
  const shooting = await chain.generateShootingScriptCandidate(source.artifact);
  await adopt(store, shooting, timestampA);
  const storyboard = await chain.generateStoryboardCandidate();
  await adopt(store, storyboard, timestampA);
  return { chain, source, outline, screenplay, assetBible, shooting, storyboard };
}

async function gateInput(store: ArtifactStoreV3) {
  const adoptions = await store.listCurrentAdoptions(project.projectId);
  return {
    artifacts: await store.listArtifacts(project.projectId),
    verifications: await store.listVerifications(project.projectId),
    approvals: await store.listApprovalReceipts(project.projectId),
    adoptions,
    currentAdoptionReceipts: (await Promise.all(adoptions.map((current) => store.getAdoptionReceipt(project.projectId, current.adoptionId))))
      .filter((receipt) => receipt !== null),
  };
}

describe("workflow-v3 immutable Adoption history", () => {
  it("A. first adopt A writes one immutable history receipt and current A", async () => {
    const store = await createStore("first");
    const fixture = await createOutlineFixture(store);
    const candidateA = await fixture.candidate("A");
    const { current } = await adopt(store, candidateA, timestampA);
    const history = await store.listAdoptionHistory(project.projectId, "outline");

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      adoptionId: current.adoptionId,
      artifactId: candidateA.artifact.artifactId,
      artifactHash: candidateA.artifact.contentHash,
      approvalReceiptId: current.approvalReceiptId,
      adoptedAt: timestampA,
      adoptedBy: "human",
    });
    expect(await store.getCurrentAdoption(project.projectId, "outline")).toEqual(current);
  });

  it("B. adopt A then B preserves two receipts and makes current B", async () => {
    const store = await createStore("a-then-b");
    const { candidateA, candidateB, adoptedB } = await createAThenB(store);
    const history = await store.listAdoptionHistory(project.projectId, "outline");

    expect(history.map((receipt) => receipt.artifactId)).toEqual([
      candidateA.artifact.artifactId,
      candidateB.artifact.artifactId,
    ]);
    expect(await store.getCurrentAdoption(project.projectId, "outline")).toEqual(adoptedB.current);
  });

  it("C. adopting B does not alter A receipt bytes", async () => {
    const store = await createStore("immutable-a");
    const fixture = await createOutlineFixture(store);
    const candidateA = await fixture.candidate("A");
    const adoptedA = await adopt(store, candidateA, timestampA);
    const receiptAPath = path.join(store.root, project.projectId, "adoptions", "history", `${adoptedA.current.adoptionId}.json`);
    const before = await fs.readFile(receiptAPath);
    const candidateB = await fixture.candidate("B");
    await adopt(store, candidateB, timestampB);

    expect(await fs.readFile(receiptAPath)).toEqual(before);
  });

  it("D. current adoptionId points exactly to B receipt", async () => {
    const store = await createStore("current-reference");
    const { candidateB, adoptedB } = await createAThenB(store);
    const receiptB = await store.getAdoptionReceipt(project.projectId, adoptedB.current.adoptionId);

    expect(receiptB).toMatchObject({
      adoptionId: adoptedB.current.adoptionId,
      artifactId: candidateB.artifact.artifactId,
      artifactHash: candidateB.artifact.contentHash,
      approvalReceiptId: adoptedB.current.approvalReceiptId,
    });
  });

  it("E. tampered current history receipt makes Production Gate fail closed", async () => {
    const store = await createStore("tampered-history");
    const { storyboard } = await buildFullChain(store);
    const current = await store.getCurrentAdoption(project.projectId, "storyboard");
    const receiptPath = path.join(store.root, project.projectId, "adoptions", "history", `${current!.adoptionId}.json`);
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as { artifactHash: string };
    receipt.artifactHash = "0".repeat(64);
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const gate = evaluateProductionGateV3(await gateInput(store));

    expect(gate.passed).toBe(false);
    expect(gate.blockers).toContainEqual(expect.objectContaining({
      code: "V3_ADOPTION_RECEIPT_INVALID",
      artifactId: storyboard.artifact.artifactId,
    }));
  });

  it("F. current pointing to a missing adoptionId makes Production Gate fail closed", async () => {
    const store = await createStore("missing-history");
    const { storyboard } = await buildFullChain(store);
    const currentPath = path.join(store.root, project.projectId, "adoptions", "current", "storyboard.json");
    const current = JSON.parse(await fs.readFile(currentPath, "utf8")) as { adoptionId: string };
    current.adoptionId = "90000000-0000-4000-8000-000000000001";
    await fs.writeFile(currentPath, `${JSON.stringify(current, null, 2)}\n`);
    const gate = evaluateProductionGateV3(await gateInput(store));

    expect(gate.passed).toBe(false);
    expect(gate.blockers).toContainEqual(expect.objectContaining({
      code: "V3_ADOPTION_RECEIPT_INVALID",
      artifactId: storyboard.artifact.artifactId,
    }));
  });

  it("G. rejected Artifact creates no Adoption history", async () => {
    const store = await createStore("rejected");
    const fixture = await createOutlineFixture(store);
    const candidate = await fixture.candidate("rejected");
    const rejection = await store.recordHumanDecision({
      projectId: project.projectId,
      artifactId: candidate.artifact.artifactId,
      artifactHash: candidate.artifact.contentHash,
      verificationReceiptId: candidate.verification.receiptId,
      decision: "rejected",
      decidedAt: timestampA,
    });

    await expect(store.adoptArtifact({
      projectId: project.projectId,
      artifactKind: "outline",
      artifactId: candidate.artifact.artifactId,
      approvalReceiptId: rejection.receiptId,
      adoptedAt: timestampA,
    })).rejects.toThrow("WORKFLOW_V3_APPROVAL_NOT_APPROVED");
    expect(await store.listAdoptionHistory(project.projectId)).toEqual([]);
    expect(await store.getCurrentAdoption(project.projectId, "outline")).toBeNull();
  });

  it("H1. history commit failure leaves no history or current", async () => {
    const store = await createStore("history-failure");
    const fixture = await createOutlineFixture(store);
    const candidate = await fixture.candidate("A");
    const approval = await approve(store, candidate.artifact, candidate.verification);
    const originalLink = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (oldPath, newPath) => {
      if (String(newPath).includes(`${path.sep}adoptions${path.sep}history${path.sep}`)) {
        throw new Error("INJECTED_HISTORY_COMMIT_FAILURE");
      }
      return originalLink(oldPath, newPath);
    });

    await expect(store.adoptArtifact({
      projectId: project.projectId,
      artifactKind: "outline",
      artifactId: candidate.artifact.artifactId,
      approvalReceiptId: approval.receiptId,
      adoptedAt: timestampA,
    })).rejects.toThrow("INJECTED_HISTORY_COMMIT_FAILURE");
    expect(await store.listAdoptionHistory(project.projectId)).toEqual([]);
    expect(await store.getCurrentAdoption(project.projectId, "outline")).toBeNull();
  });

  it("H2. current update failure rolls back B receipt and preserves complete A state", async () => {
    const store = await createStore("current-failure");
    const fixture = await createOutlineFixture(store);
    const candidateA = await fixture.candidate("A");
    const adoptedA = await adopt(store, candidateA, timestampA);
    const historyBefore = await store.listAdoptionHistory(project.projectId);
    const candidateB = await fixture.candidate("B");
    const approvalB = await approve(store, candidateB.artifact, candidateB.verification);
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (String(newPath).includes(`${path.sep}adoptions${path.sep}current${path.sep}`)) {
        throw new Error("INJECTED_CURRENT_COMMIT_FAILURE");
      }
      return originalRename(oldPath, newPath);
    });

    await expect(store.adoptArtifact({
      projectId: project.projectId,
      artifactKind: "outline",
      artifactId: candidateB.artifact.artifactId,
      approvalReceiptId: approvalB.receiptId,
      adoptedAt: timestampB,
    })).rejects.toThrow("INJECTED_CURRENT_COMMIT_FAILURE");
    expect(await store.listAdoptionHistory(project.projectId)).toEqual(historyBefore);
    expect(await store.getCurrentAdoption(project.projectId, "outline")).toEqual(adoptedA.current);
  });

  it("I. Adoption history write path has no model call, Repair, or Revision", async () => {
    const source = [
      await fs.readFile(path.resolve("src/workflow-v3/artifact-store.ts"), "utf8"),
      await fs.readFile(path.resolve("src/workflow-v3/human-adoption.ts"), "utf8"),
    ].join("\n");
    expect(source).not.toContain("CodexCliProvider");
    expect(source).not.toMatch(/generate(?:Outline|Screenplay|AssetBible|ShootingScript|Storyboard)\s*\(/u);
    expect(source).not.toMatch(/repair|revision/iu);
  });
});
