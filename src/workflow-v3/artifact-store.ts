import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdoptionReceiptV3,
  AdoptionV3,
  ApprovalReceiptV3,
  ArtifactKindV3,
  ArtifactRecordV3,
  VerificationReceiptV3,
} from "./contracts";
import { adoptionMatchesReceiptV3, assertAdoptableV3 } from "./human-adoption";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function assertProjectId(projectId: string): void {
  if (!uuidPattern.test(projectId)) throw new Error(`WORKFLOW_V3_PROJECT_ID_INVALID: ${projectId}`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]));
}

export function contentHashV3(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export class ArtifactStoreV3 {
  private commitQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly identity: () => string = randomUUID,
  ) {}

  async commit<T>(input: {
    projectId: string;
    kind: ArtifactKindV3;
    payload: T;
    inputArtifactIds: string[];
    parentArtifactId?: string | null;
  }): Promise<ArtifactRecordV3<T>> {
    assertProjectId(input.projectId);
    let release!: () => void;
    const previous = this.commitQueue;
    this.commitQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const existing = await this.listArtifacts(input.projectId);
      const byId = new Map(existing.map((artifact) => [artifact.artifactId, artifact]));
      for (const inputArtifactId of input.inputArtifactIds) {
        const artifact = byId.get(inputArtifactId);
        if (!artifact || artifact.projectId !== input.projectId) throw new Error(`WORKFLOW_V3_INPUT_NOT_FOUND: ${inputArtifactId}`);
      }
      const parentArtifactId = input.parentArtifactId ?? null;
      if (parentArtifactId) {
        const parent = byId.get(parentArtifactId);
        if (!parent || parent.projectId !== input.projectId || parent.kind !== input.kind) {
          throw new Error(`WORKFLOW_V3_PARENT_INVALID: ${parentArtifactId}`);
        }
      }
      const version = Math.max(0, ...existing.filter((artifact) => artifact.kind === input.kind).map((artifact) => artifact.version)) + 1;
      const ordinal = Math.max(0, ...existing.map((artifact) => artifact.ordinal)) + 1;
      const artifactId = this.identity();
      const inputArtifactIds = [...new Set(input.inputArtifactIds)];
      const record: ArtifactRecordV3<T> = {
        schemaVersion: "workflow-v3-artifact-v1",
        artifactId,
        projectId: input.projectId,
        kind: input.kind,
        version,
        ordinal,
        parentArtifactId,
        inputArtifactIds,
        inputArtifactRefs: inputArtifactIds.map((artifactId) => {
          const artifact = byId.get(artifactId)!;
          return { artifactId, contentHash: artifact.contentHash };
        }),
        contentHash: contentHashV3(input.payload),
        payload: structuredClone(input.payload),
        createdAt: this.now(),
      };
      const artifactDirectory = path.join(this.root, input.projectId, "artifacts");
      await fs.mkdir(artifactDirectory, { recursive: true });
      const finalPath = path.join(artifactDirectory, `${String(ordinal).padStart(6, "0")}-${input.kind}-${artifactId}.json`);
      const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await fs.rename(temporaryPath, finalPath);
      return deepFreeze(record);
    } finally {
      release();
    }
  }

  async listArtifacts(projectId: string): Promise<Array<ArtifactRecordV3>> {
    assertProjectId(projectId);
    const artifactDirectory = path.join(this.root, projectId, "artifacts");
    let names: string[];
    try {
      names = await fs.readdir(artifactDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const record = JSON.parse(await fs.readFile(path.join(artifactDirectory, name), "utf8")) as ArtifactRecordV3;
      if (record.schemaVersion !== "workflow-v3-artifact-v1"
        || record.projectId !== projectId
        || contentHashV3(record.payload) !== record.contentHash) {
        throw new Error(`WORKFLOW_V3_ARTIFACT_INTEGRITY_FAILED: ${name}`);
      }
      return record;
    }));
    return records.sort((left, right) => left.ordinal - right.ordinal).map(deepFreeze);
  }

  async requireArtifact(artifactId: string): Promise<ArtifactRecordV3> {
    const projectDirectories = await fs.readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const directory of projectDirectories) {
      if (!directory.isDirectory()) continue;
      const artifact = (await this.listArtifacts(directory.name)).find((candidate) => candidate.artifactId === artifactId);
      if (artifact) return artifact;
    }
    throw new Error(`WORKFLOW_V3_ARTIFACT_NOT_FOUND: ${artifactId}`);
  }

  async commitVerification(receipt: VerificationReceiptV3): Promise<void> {
    const artifact = await this.requireArtifact(receipt.artifactId);
    if (artifact.contentHash !== receipt.artifactHash) {
      throw new Error(`WORKFLOW_V3_VERIFICATION_HASH_MISMATCH: ${receipt.artifactId}`);
    }
    const directory = path.join(this.root, artifact.projectId, "verifications");
    await fs.mkdir(directory, { recursive: true });
    const finalPath = path.join(directory, `${String(artifact.ordinal).padStart(6, "0")}-${receipt.receiptId}.json`);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, finalPath);
  }

  async listVerifications(projectId: string): Promise<VerificationReceiptV3[]> {
    assertProjectId(projectId);
    const directory = path.join(this.root, projectId, "verifications");
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(names.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
      const receipt = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as VerificationReceiptV3;
      if (receipt.schemaVersion !== "workflow-v3-verification-v1") {
        throw new Error(`WORKFLOW_V3_VERIFICATION_INTEGRITY_FAILED: ${name}`);
      }
      return deepFreeze(receipt);
    }));
  }

  async recordHumanDecision(input: {
    projectId: string;
    artifactId: string;
    artifactHash: string;
    verificationReceiptId: string;
    decision: ApprovalReceiptV3["decision"];
    decidedAt?: string;
    receiptId?: string;
  }): Promise<ApprovalReceiptV3> {
    assertProjectId(input.projectId);
    const artifact = await this.requireArtifact(input.artifactId);
    if (artifact.projectId !== input.projectId) throw new Error("WORKFLOW_V3_APPROVAL_PROJECT_MISMATCH");
    if (artifact.contentHash !== input.artifactHash) throw new Error("WORKFLOW_V3_APPROVAL_HASH_MISMATCH");
    const verification = (await this.listVerifications(input.projectId))
      .find((receipt) => receipt.receiptId === input.verificationReceiptId);
    if (!verification) throw new Error("WORKFLOW_V3_VERIFICATION_NOT_FOUND");
    if (verification.artifactId !== artifact.artifactId) throw new Error("WORKFLOW_V3_VERIFICATION_ARTIFACT_MISMATCH");
    if (verification.artifactHash !== artifact.contentHash) throw new Error("WORKFLOW_V3_VERIFICATION_HASH_MISMATCH");
    const receipt: ApprovalReceiptV3 = {
      schemaVersion: "workflow-v3-approval-v1",
      receiptId: input.receiptId ?? this.identity(),
      projectId: input.projectId,
      artifactId: artifact.artifactId,
      artifactHash: artifact.contentHash,
      verificationReceiptId: verification.receiptId,
      decision: input.decision,
      decidedAt: input.decidedAt ?? this.now(),
      decidedBy: "human",
    };
    const directory = path.join(this.root, input.projectId, "approval-receipts");
    await fs.mkdir(directory, { recursive: true });
    const finalPath = path.join(directory, `${String(artifact.ordinal).padStart(6, "0")}-${receipt.receiptId}.json`);
    await fs.writeFile(finalPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return deepFreeze(receipt);
  }

  async listApprovalReceipts(projectId: string): Promise<ApprovalReceiptV3[]> {
    assertProjectId(projectId);
    const directory = path.join(this.root, projectId, "approval-receipts");
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(names.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
      const receipt = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as ApprovalReceiptV3;
      if (receipt.schemaVersion !== "workflow-v3-approval-v1"
        || receipt.projectId !== projectId
        || receipt.decidedBy !== "human"
        || !["approved", "rejected"].includes(receipt.decision)) {
        throw new Error(`WORKFLOW_V3_APPROVAL_INTEGRITY_FAILED: ${name}`);
      }
      return deepFreeze(receipt);
    }));
  }

  async adoptArtifact(input: {
    projectId: string;
    artifactKind: ArtifactKindV3;
    artifactId: string;
    approvalReceiptId: string;
    adoptedAt?: string;
  }): Promise<AdoptionV3> {
    assertProjectId(input.projectId);
    let release!: () => void;
    const previous = this.commitQueue;
    this.commitQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const artifact = await this.requireArtifact(input.artifactId);
      if (artifact.projectId !== input.projectId || artifact.kind !== input.artifactKind) {
        throw new Error("WORKFLOW_V3_ADOPTION_ARTIFACT_MISMATCH");
      }
      const approval = (await this.listApprovalReceipts(input.projectId))
        .find((receipt) => receipt.receiptId === input.approvalReceiptId);
      const verification = approval
        ? (await this.listVerifications(input.projectId)).find((receipt) => receipt.receiptId === approval.verificationReceiptId)
        : undefined;
      assertAdoptableV3({ artifact, verification, approval });
      const adoptionId = this.identity();
      if (!uuidPattern.test(adoptionId)) throw new Error(`WORKFLOW_V3_ADOPTION_ID_INVALID: ${adoptionId}`);
      const adoptedAt = input.adoptedAt ?? this.now();
      const receipt: AdoptionReceiptV3 = {
        schemaVersion: "workflow-v3-adoption-receipt-v1",
        adoptionId,
        projectId: input.projectId,
        artifactKind: artifact.kind,
        artifactId: artifact.artifactId,
        artifactHash: artifact.contentHash,
        approvalReceiptId: approval!.receiptId,
        adoptedAt,
        adoptedBy: "human",
      };
      const adoption: AdoptionV3 = {
        schemaVersion: "workflow-v3-adoption-v1",
        adoptionId,
        projectId: input.projectId,
        artifactKind: artifact.kind,
        artifactId: artifact.artifactId,
        artifactHash: artifact.contentHash,
        approvalReceiptId: approval!.receiptId,
        adoptedAt,
      };
      const adoptionDirectory = path.join(this.root, input.projectId, "adoptions");
      const historyDirectory = path.join(adoptionDirectory, "history");
      const currentDirectory = path.join(adoptionDirectory, "current");
      await fs.mkdir(historyDirectory, { recursive: true });
      await fs.mkdir(currentDirectory, { recursive: true });
      const historyPath = path.join(historyDirectory, `${adoptionId}.json`);
      const currentPath = path.join(currentDirectory, `${artifact.kind}.json`);
      const transactionId = randomUUID();
      const historyTemporaryPath = path.join(historyDirectory, `.${adoptionId}.${transactionId}.tmp`);
      const currentTemporaryPath = path.join(currentDirectory, `.${artifact.kind}.${transactionId}.tmp`);
      let historyCommitted = false;
      try {
        await fs.writeFile(historyTemporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await fs.writeFile(currentTemporaryPath, `${JSON.stringify(adoption, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await fs.link(historyTemporaryPath, historyPath);
        historyCommitted = true;
        await fs.rm(historyTemporaryPath);
        await fs.rename(currentTemporaryPath, currentPath);
      } catch (error) {
        const cleanupTargets = [historyTemporaryPath, currentTemporaryPath, ...(historyCommitted ? [historyPath] : [])];
        const cleanup = await Promise.allSettled(cleanupTargets.map((target) => fs.rm(target, { force: true })));
        const cleanupFailures = cleanup.filter((result) => result.status === "rejected");
        if (cleanupFailures.length > 0) {
          throw new Error("WORKFLOW_V3_ADOPTION_ROLLBACK_FAILED", {
            cause: new AggregateError([error, ...cleanupFailures.map((result) => result.reason)]),
          });
        }
        throw error;
      }
      return deepFreeze(adoption);
    } finally {
      release();
    }
  }

  async listCurrentAdoptions(projectId: string): Promise<AdoptionV3[]> {
    assertProjectId(projectId);
    const directory = path.join(this.root, projectId, "adoptions", "current");
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(names.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
      const adoption = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as AdoptionV3;
      if (adoption.schemaVersion !== "workflow-v3-adoption-v1"
        || !uuidPattern.test(adoption.adoptionId)
        || adoption.projectId !== projectId
        || `${adoption.artifactKind}.json` !== name) {
        throw new Error(`WORKFLOW_V3_ADOPTION_INTEGRITY_FAILED: ${name}`);
      }
      return deepFreeze(adoption);
    }));
  }

  async getCurrentAdoption(projectId: string, kind: ArtifactKindV3): Promise<AdoptionV3 | null> {
    return (await this.listCurrentAdoptions(projectId)).find((adoption) => adoption.artifactKind === kind) ?? null;
  }

  async getAdoptionReceipt(projectId: string, adoptionId: string): Promise<AdoptionReceiptV3 | null> {
    assertProjectId(projectId);
    if (!uuidPattern.test(adoptionId)) return null;
    const filePath = path.join(this.root, projectId, "adoptions", "history", `${adoptionId}.json`);
    let receipt: AdoptionReceiptV3;
    try {
      receipt = JSON.parse(await fs.readFile(filePath, "utf8")) as AdoptionReceiptV3;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (receipt.schemaVersion !== "workflow-v3-adoption-receipt-v1"
      || receipt.adoptionId !== adoptionId
      || receipt.projectId !== projectId
      || receipt.adoptedBy !== "human") {
      throw new Error(`WORKFLOW_V3_ADOPTION_RECEIPT_INTEGRITY_FAILED: ${adoptionId}`);
    }
    return deepFreeze(receipt);
  }

  async listAdoptionHistory(projectId: string, kind?: ArtifactKindV3): Promise<AdoptionReceiptV3[]> {
    assertProjectId(projectId);
    const directory = path.join(this.root, projectId, "adoptions", "history");
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const receipts = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const adoptionId = name.slice(0, -".json".length);
      const receipt = await this.getAdoptionReceipt(projectId, adoptionId);
      if (!receipt) throw new Error(`WORKFLOW_V3_ADOPTION_RECEIPT_INTEGRITY_FAILED: ${name}`);
      return receipt;
    }));
    return receipts
      .filter((receipt) => kind === undefined || receipt.artifactKind === kind)
      .sort((left, right) => left.adoptedAt.localeCompare(right.adoptedAt) || left.adoptionId.localeCompare(right.adoptionId));
  }

  async requireAdoptedArtifact(projectId: string, kind: ArtifactKindV3): Promise<ArtifactRecordV3> {
    const adoption = await this.getCurrentAdoption(projectId, kind);
    if (!adoption) throw new Error(`WORKFLOW_V3_ADOPTION_NOT_FOUND: ${kind}`);
    const adoptionReceipt = await this.getAdoptionReceipt(projectId, adoption.adoptionId);
    if (!adoptionReceipt || !adoptionMatchesReceiptV3(adoption, adoptionReceipt)) {
      throw new Error(`WORKFLOW_V3_ADOPTION_RECEIPT_MISMATCH: ${kind}`);
    }
    const artifact = await this.requireArtifact(adoption.artifactId);
    if (artifact.projectId !== projectId
      || artifact.kind !== kind
      || adoption.artifactHash !== artifact.contentHash) {
      throw new Error(`WORKFLOW_V3_ADOPTION_ARTIFACT_MISMATCH: ${kind}`);
    }
    const approval = (await this.listApprovalReceipts(projectId))
      .find((receipt) => receipt.receiptId === adoption.approvalReceiptId);
    const verification = approval
      ? (await this.listVerifications(projectId)).find((receipt) => receipt.receiptId === approval.verificationReceiptId)
      : undefined;
    assertAdoptableV3({ artifact, verification, approval });
    return artifact;
  }
}
