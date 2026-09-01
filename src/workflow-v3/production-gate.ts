import { contentHashV3 } from "./artifact-store";
import type {
  AdoptionReceiptV3,
  AdoptionV3,
  ApprovalReceiptV3,
  ArtifactInputRefV3,
  ArtifactKindV3,
  ArtifactRecordV3,
  ProductionGateResultV3,
  VerificationReceiptV3,
} from "./contracts";
import { adoptionMatchesReceiptV3 } from "./human-adoption";

const requiredAdoptionKinds = ["outline", "screenplay", "asset-bible", "shooting-script", "storyboard"] as const;

function refsEqual(left: ArtifactInputRefV3[], right: ArtifactInputRefV3[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateProductionGateV3(input: {
  artifacts: ArtifactRecordV3[];
  verifications: VerificationReceiptV3[];
  approvals: ApprovalReceiptV3[];
  adoptions: AdoptionV3[];
  currentAdoptionReceipts: AdoptionReceiptV3[];
}): ProductionGateResultV3 {
  const blockers: ProductionGateResultV3["blockers"] = [];
  const artifactsById = new Map(input.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const approvalsById = new Map(input.approvals.map((approval) => [approval.receiptId, approval]));
  const verificationsById = new Map(input.verifications.map((receipt) => [receipt.receiptId, receipt]));
  const adoptionReceiptsById = new Map(input.currentAdoptionReceipts.map((receipt) => [receipt.adoptionId, receipt]));
  const adoptionByKind = new Map<ArtifactKindV3, AdoptionV3>();
  for (const adoption of input.adoptions) {
    if (adoptionByKind.has(adoption.artifactKind)) {
      blockers.push({ code: "V3_MULTIPLE_CURRENT_ADOPTIONS", message: `${adoption.artifactKind} 存在多个 current Adoption` });
      continue;
    }
    adoptionByKind.set(adoption.artifactKind, adoption);
  }

  const adoptedArtifacts = new Map<ArtifactKindV3, ArtifactRecordV3>();
  for (const kind of requiredAdoptionKinds) {
    const adoption = adoptionByKind.get(kind);
    if (!adoption) {
      blockers.push({ code: "V3_ADOPTION_MISSING", message: `${kind} 缺少 current Adoption` });
      continue;
    }
    const adoptionReceipt = adoptionReceiptsById.get(adoption.adoptionId);
    if (!adoptionReceipt || !adoptionMatchesReceiptV3(adoption, adoptionReceipt)) {
      blockers.push({
        code: "V3_ADOPTION_RECEIPT_INVALID",
        message: `${kind} current Adoption 缺少精确匹配的 immutable receipt`,
        artifactId: adoption.artifactId,
      });
      continue;
    }
    const artifact = artifactsById.get(adoption.artifactId);
    if (adoption.schemaVersion !== "workflow-v3-adoption-v1"
      || !artifact
      || artifact.projectId !== adoption.projectId
      || artifact.kind !== kind
      || artifact.contentHash !== adoption.artifactHash) {
      blockers.push({ code: "V3_ADOPTION_ARTIFACT_INVALID", message: `${kind} Adoption 与 Artifact 不匹配`, artifactId: adoption.artifactId });
      continue;
    }
    adoptedArtifacts.set(kind, artifact);
    if (contentHashV3(artifact.payload) !== artifact.contentHash) {
      blockers.push({ code: "V3_ARTIFACT_INTEGRITY_FAILED", message: `${kind} 内容与 Artifact hash 不一致`, artifactId: artifact.artifactId });
      continue;
    }
    const approval = approvalsById.get(adoption.approvalReceiptId);
    if (!approval
      || approval.schemaVersion !== "workflow-v3-approval-v1"
      || approval.decidedBy !== "human"
      || approval.decision !== "approved"
      || approval.projectId !== adoption.projectId
      || approval.artifactId !== artifact.artifactId
      || approval.artifactHash !== artifact.contentHash) {
      blockers.push({ code: "V3_ADOPTION_APPROVAL_INVALID", message: `${kind} 缺少匹配的 human approved receipt`, artifactId: artifact.artifactId });
      continue;
    }
    const verification = verificationsById.get(approval.verificationReceiptId);
    if (!verification
      || verification.schemaVersion !== "workflow-v3-verification-v1"
      || verification.status !== "passed"
      || verification.artifactId !== artifact.artifactId
      || verification.artifactHash !== artifact.contentHash) {
      blockers.push({ code: "V3_VERIFICATION_NOT_PASSED", message: `${kind} 缺少 Approval 精确引用的 passed receipt`, artifactId: artifact.artifactId });
    }
  }

  const outline = adoptedArtifacts.get("outline");
  const sourceRef = outline?.inputArtifactRefs?.[0];
  const source = sourceRef ? artifactsById.get(sourceRef.artifactId) : undefined;
  if (outline && (!sourceRef
    || !source
    || source.kind !== "source"
    || source.contentHash !== sourceRef.contentHash
    || contentHashV3(source.payload) !== source.contentHash
    || JSON.stringify(outline.inputArtifactIds) !== JSON.stringify([source.artifactId])
    || outline.inputArtifactRefs.length !== 1)) {
    blockers.push({ code: "V3_INPUT_CHAIN_MISMATCH", message: "outline 输入链不匹配", artifactId: outline.artifactId });
  } else if (source) {
    const receipt = input.verifications.find((candidate) => candidate.artifactId === source.artifactId
      && candidate.artifactHash === source.contentHash
      && candidate.status === "passed");
    if (!receipt) blockers.push({ code: "V3_VERIFICATION_NOT_PASSED", message: "source 缺少同哈希 passed receipt", artifactId: source.artifactId });
  }

  const expectedInputs: Array<[ArtifactKindV3, ArtifactInputRefV3[] | null]> = [
    ["screenplay", source && outline ? [
      { artifactId: source.artifactId, contentHash: source.contentHash },
      { artifactId: outline.artifactId, contentHash: outline.contentHash },
    ] : null],
    ["asset-bible", adoptedArtifacts.has("screenplay") ? [{
      artifactId: adoptedArtifacts.get("screenplay")!.artifactId,
      contentHash: adoptedArtifacts.get("screenplay")!.contentHash,
    }] : null],
    ["shooting-script", adoptedArtifacts.has("screenplay") && adoptedArtifacts.has("asset-bible") ? [
      { artifactId: adoptedArtifacts.get("screenplay")!.artifactId, contentHash: adoptedArtifacts.get("screenplay")!.contentHash },
      { artifactId: adoptedArtifacts.get("asset-bible")!.artifactId, contentHash: adoptedArtifacts.get("asset-bible")!.contentHash },
    ] : null],
    ["storyboard", adoptedArtifacts.has("shooting-script") && adoptedArtifacts.has("asset-bible") ? [
      { artifactId: adoptedArtifacts.get("shooting-script")!.artifactId, contentHash: adoptedArtifacts.get("shooting-script")!.contentHash },
      { artifactId: adoptedArtifacts.get("asset-bible")!.artifactId, contentHash: adoptedArtifacts.get("asset-bible")!.contentHash },
    ] : null],
  ];
  for (const [kind, expected] of expectedInputs) {
    const artifact = adoptedArtifacts.get(kind);
    if (!artifact || !expected) continue;
    const idsMatch = JSON.stringify(artifact.inputArtifactIds) === JSON.stringify(expected.map((ref) => ref.artifactId));
    if (!idsMatch || !Array.isArray(artifact.inputArtifactRefs) || !refsEqual(artifact.inputArtifactRefs, expected)) {
      blockers.push({ code: "V3_INPUT_CHAIN_MISMATCH", message: `${kind} 输入链不匹配`, artifactId: artifact.artifactId });
    }
  }

  const checkedArtifactIds = [source, ...requiredAdoptionKinds.map((kind) => adoptedArtifacts.get(kind))]
    .filter((artifact): artifact is ArtifactRecordV3 => Boolean(artifact))
    .map((artifact) => artifact.artifactId);
  return {
    schemaVersion: "workflow-v3-production-gate-v1",
    passed: blockers.length === 0,
    blockers,
    checkedArtifactIds,
  };
}
