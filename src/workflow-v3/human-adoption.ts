import type {
  AdoptionReceiptV3,
  AdoptionV3,
  ApprovalReceiptV3,
  ArtifactRecordV3,
  VerificationReceiptV3,
} from "./contracts";

export function assertAdoptableV3(input: {
  artifact: ArtifactRecordV3;
  verification: VerificationReceiptV3 | undefined;
  approval: ApprovalReceiptV3 | undefined;
}): void {
  const { artifact, verification, approval } = input;
  if (!approval) throw new Error("WORKFLOW_V3_APPROVAL_NOT_FOUND");
  if (approval.decidedBy !== "human") throw new Error("WORKFLOW_V3_APPROVAL_NOT_HUMAN");
  if (approval.decision !== "approved") throw new Error("WORKFLOW_V3_APPROVAL_NOT_APPROVED");
  if (approval.artifactId !== artifact.artifactId) throw new Error("WORKFLOW_V3_APPROVAL_ARTIFACT_MISMATCH");
  if (approval.artifactHash !== artifact.contentHash) throw new Error("WORKFLOW_V3_APPROVAL_HASH_MISMATCH");
  if (!verification) throw new Error("WORKFLOW_V3_VERIFICATION_NOT_FOUND");
  if (verification.status !== "passed") throw new Error("WORKFLOW_V3_VERIFICATION_NOT_PASSED");
  if (verification.artifactId !== artifact.artifactId) throw new Error("WORKFLOW_V3_VERIFICATION_ARTIFACT_MISMATCH");
  if (verification.artifactHash !== artifact.contentHash) throw new Error("WORKFLOW_V3_VERIFICATION_HASH_MISMATCH");
  if (approval.verificationReceiptId !== verification.receiptId) {
    throw new Error("WORKFLOW_V3_APPROVAL_VERIFICATION_MISMATCH");
  }
}

export function adoptionMatchesArtifactV3(adoption: AdoptionV3, artifact: ArtifactRecordV3): boolean {
  return adoption.projectId === artifact.projectId
    && adoption.artifactKind === artifact.kind
    && adoption.artifactId === artifact.artifactId
    && adoption.artifactHash === artifact.contentHash;
}

export function adoptionMatchesReceiptV3(adoption: AdoptionV3, receipt: AdoptionReceiptV3): boolean {
  return receipt.schemaVersion === "workflow-v3-adoption-receipt-v1"
    && receipt.adoptedBy === "human"
    && adoption.adoptionId === receipt.adoptionId
    && adoption.projectId === receipt.projectId
    && adoption.artifactKind === receipt.artifactKind
    && adoption.artifactId === receipt.artifactId
    && adoption.artifactHash === receipt.artifactHash
    && adoption.approvalReceiptId === receipt.approvalReceiptId
    && adoption.adoptedAt === receipt.adoptedAt;
}
