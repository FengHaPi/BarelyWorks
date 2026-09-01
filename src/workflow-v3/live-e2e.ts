import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ArtifactStoreV3 } from "./artifact-store";
import type {
  AdoptionReceiptV3,
  AdoptionV3,
  ApprovalReceiptV3,
  ArtifactKindV3,
  ArtifactRecordV3,
  AssetBibleContentV3,
  GenerationPackageContentV3,
  OutlineContentV3,
  ProductionGateResultV3,
  ProjectV3,
  ScreenplayContentV3,
  ShootingScriptContentV3,
  SourceContentV3,
  StoryboardContentV3,
  VerificationReceiptV3,
} from "./contracts";
import { WorkflowV3MinimalChain } from "./minimal-chain";
import {
  WorkflowV3CodexLiveProvider,
  WorkflowV3LiveProviderError,
  type WorkflowV3LiveStage,
  type WorkflowV3LiveStageRecord,
  workflowV3PromptContracts,
} from "./live-provider";

type LiveFailureStageV3 = "source" | WorkflowV3LiveStage | "production-gate" | "generation-package";
type LiveFailureCategoryV3 = "content" | "schema" | "prompt" | "provider" | "v3-orchestration";

interface ArtifactEvidenceV3 {
  kind: ArtifactKindV3;
  artifactId: string;
  hash: string;
  inputArtifactIds: string[];
}

interface SerializedFailureV3 {
  name: string;
  message: string;
  structuredFailureType: string;
  validationErrors: unknown[];
}

export interface WorkflowV3LiveFailureReport {
  schemaVersion: "workflow-v3-live-failure-v1";
  status: "failed";
  failedAt: string;
  firstFailureStage: LiveFailureStageV3;
  category: LiveFailureCategoryV3;
  inputArtifacts: ArtifactEvidenceV3[];
  prompt: (typeof workflowV3PromptContracts)[WorkflowV3LiveStage] | null;
  provider: {
    name: "codex-cli";
    model: string | null;
    runId: string | null;
  };
  error: SerializedFailureV3;
  successfulArtifacts: ArtifactEvidenceV3[];
  successfulVerifications: Array<{ artifactId: string; artifactHash: string; status: VerificationReceiptV3["status"] }>;
  successfulApprovals: Array<{ receiptId: string; artifactId: string; artifactHash: string; decision: ApprovalReceiptV3["decision"] }>;
  currentAdoptions: AdoptionV3[];
  adoptionHistory: AdoptionReceiptV3[];
  stages: WorkflowV3LiveStageRecord[];
}

export type WorkflowV3LiveE2EResult =
  | {
    status: "passed";
    resultPath: string;
    runRoot: string;
    stages: WorkflowV3LiveStageRecord[];
    artifacts: ArtifactRecordV3[];
    verifications: VerificationReceiptV3[];
    approvals: ApprovalReceiptV3[];
    adoptions: AdoptionV3[];
    adoptionHistory: AdoptionReceiptV3[];
    productionGate: ProductionGateResultV3;
    content: {
      source: SourceContentV3;
      outline: OutlineContentV3;
      screenplay: ScreenplayContentV3;
      assetBible: AssetBibleContentV3;
      shootingScript: ShootingScriptContentV3;
      storyboard: StoryboardContentV3;
      generationPackage: GenerationPackageContentV3;
    };
  }
  | {
    status: "failed";
    resultPath: string;
    runRoot: string;
    artifacts: ArtifactRecordV3[];
    verifications: VerificationReceiptV3[];
    failure: WorkflowV3LiveFailureReport;
  };

const inputKindsByStage: Record<LiveFailureStageV3, ArtifactKindV3[]> = {
  source: [],
  outline: ["source"],
  screenplay: ["source", "outline"],
  "asset-bible": ["screenplay"],
  "shooting-script": ["screenplay", "asset-bible"],
  storyboard: ["shooting-script", "asset-bible"],
  "production-gate": ["source", "outline", "screenplay", "asset-bible", "shooting-script", "storyboard"],
  "generation-package": ["asset-bible", "shooting-script", "storyboard"],
};

function artifactEvidence(artifact: ArtifactRecordV3): ArtifactEvidenceV3 {
  return {
    kind: artifact.kind,
    artifactId: artifact.artifactId,
    hash: artifact.contentHash,
    inputArtifactIds: [...artifact.inputArtifactIds],
  };
}

function rootCause(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && current.cause !== undefined && !seen.has(current.cause)) {
    seen.add(current);
    current = current.cause;
  }
  return current;
}

function serializeFailure(error: unknown): SerializedFailureV3 {
  const root = rootCause(error);
  if (root instanceof z.ZodError) {
    return {
      name: root.name,
      message: root.message,
      structuredFailureType: "ZodError",
      validationErrors: structuredClone(root.issues),
    };
  }
  if (root instanceof Error) {
    return {
      name: root.name,
      message: root.message,
      structuredFailureType: root.constructor.name,
      validationErrors: [],
    };
  }
  return {
    name: "UnknownFailure",
    message: String(root),
    structuredFailureType: typeof root,
    validationErrors: [],
  };
}

function inferFailureStage(error: unknown, artifacts: ArtifactRecordV3[], stages: WorkflowV3LiveStageRecord[]): LiveFailureStageV3 {
  if (error instanceof WorkflowV3LiveProviderError) return error.stage;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("WORKFLOW_V3_PRODUCTION_GATE_FAILED")) return "production-gate";
  const order: Array<Exclude<LiveFailureStageV3, "production-gate">> = [
    "source", "outline", "screenplay", "asset-bible", "shooting-script", "storyboard", "generation-package",
  ];
  const missing = order.find((kind) => !artifacts.some((artifact) => artifact.kind === kind));
  if (missing) return missing;
  return stages.findLast((stage) => stage.status === "failed")?.stage ?? "generation-package";
}

function classifyFailure(error: unknown): LiveFailureCategoryV3 {
  const failure = serializeFailure(error);
  if (failure.structuredFailureType === "ZodError") return "schema";
  if (/EXPLICIT_TOPOLOGY_MISMATCH|DURATION_MISMATCH|STORYBOARD_TOPOLOGY_MISMATCH/iu.test(failure.message)) return "content";
  if (/PROMPT/iu.test(failure.message)) return "prompt";
  if (error instanceof WorkflowV3LiveProviderError || /Codex|LIVE_TRACE_INVALID|connection|network|proxy/iu.test(failure.message)) return "provider";
  return "v3-orchestration";
}

async function writeExclusiveJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function assertIsolatedRunRoot(repositoryRoot: string, runRoot: string): void {
  const normalizedRepository = path.resolve(repositoryRoot);
  const normalizedRun = path.resolve(runRoot);
  const oldDataRoot = path.join(normalizedRepository, "data");
  if (normalizedRun === normalizedRepository || normalizedRun === oldDataRoot || normalizedRun.startsWith(`${oldDataRoot}${path.sep}`)) {
    throw new Error(`WORKFLOW_V3_LIVE_ROOT_NOT_ISOLATED: ${normalizedRun}`);
  }
}

export async function runWorkflowV3LiveE2E(input: {
  repositoryRoot: string;
  runRoot: string;
  project: ProjectV3;
  sourceText: string;
}): Promise<WorkflowV3LiveE2EResult> {
  if (process.env.WORKFLOW_V3_LIVE !== "1") {
    throw new Error("WORKFLOW_V3_LIVE_NOT_ENABLED: set WORKFLOW_V3_LIVE=1 explicitly");
  }
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const runRoot = path.resolve(input.runRoot);
  assertIsolatedRunRoot(repositoryRoot, runRoot);
  await fs.mkdir(path.dirname(runRoot), { recursive: true });
  await fs.mkdir(runRoot);
  const providerProjectDirectory = path.join(runRoot, "provider-project");
  await fs.mkdir(path.join(providerProjectDirectory, "logs"), { recursive: true });
  const store = new ArtifactStoreV3(path.join(runRoot, "artifact-store"));
  const resultPath = path.join(runRoot, "live-e2e-result.json");
  let provider: WorkflowV3CodexLiveProvider | null = null;

  try {
    provider = new WorkflowV3CodexLiveProvider({
      repositoryRoot,
      projectDirectory: providerProjectDirectory,
      durationMinSec: 5,
      durationMaxSec: 15,
    });
    const chain = new WorkflowV3MinimalChain({
      project: input.project,
      sourceText: input.sourceText,
      generator: provider,
      store,
    });
    const explicitlyApproveAndAdopt = async (artifact: ArtifactRecordV3, verification: VerificationReceiptV3) => {
      const approval = await store.recordHumanDecision({
        projectId: input.project.projectId,
        artifactId: artifact.artifactId,
        artifactHash: artifact.contentHash,
        verificationReceiptId: verification.receiptId,
        decision: "approved",
      });
      await store.adoptArtifact({
        projectId: input.project.projectId,
        artifactKind: artifact.kind,
        artifactId: artifact.artifactId,
        approvalReceiptId: approval.receiptId,
      });
    };
    const source = await chain.createSourceCandidate();
    const outline = await chain.generateOutlineCandidate(source.artifact);
    await explicitlyApproveAndAdopt(outline.artifact, outline.verification);
    const screenplay = await chain.generateScreenplayCandidate(source.artifact);
    await explicitlyApproveAndAdopt(screenplay.artifact, screenplay.verification);
    const assetBible = await chain.generateAssetBibleCandidate(source.artifact);
    await explicitlyApproveAndAdopt(assetBible.artifact, assetBible.verification);
    const shootingScript = await chain.generateShootingScriptCandidate(source.artifact);
    await explicitlyApproveAndAdopt(shootingScript.artifact, shootingScript.verification);
    const storyboard = await chain.generateStoryboardCandidate();
    await explicitlyApproveAndAdopt(storyboard.artifact, storyboard.verification);
    const generationPackage = await chain.generatePackage();
    const artifacts = await store.listArtifacts(input.project.projectId);
    const verifications = await store.listVerifications(input.project.projectId);
    const approvals = await store.listApprovalReceipts(input.project.projectId);
    const adoptions = await store.listCurrentAdoptions(input.project.projectId);
    const adoptionHistory = await store.listAdoptionHistory(input.project.projectId);
    const stages = provider.getStageRecords();
    const generationPackageArtifact = generationPackage.artifact;
    await writeExclusiveJson(resultPath, {
      schemaVersion: "workflow-v3-live-result-v1",
      status: "passed",
      completedAt: new Date().toISOString(),
      project: input.project,
      provider: { name: "codex-cli", model: provider.getTextModel() },
      stages,
      artifacts: artifacts.map(artifactEvidence),
      verifications,
      approvals,
      adoptions,
      adoptionHistory,
      productionGate: generationPackage.productionGate,
      generationPackageArtifact: artifactEvidence(generationPackageArtifact),
    });
    return {
      status: "passed",
      resultPath,
      runRoot,
      stages,
      artifacts,
      verifications,
      approvals,
      adoptions,
      adoptionHistory,
      productionGate: generationPackage.productionGate,
      content: {
        source: source.content,
        outline: outline.content,
        screenplay: screenplay.content,
        assetBible: assetBible.content,
        shootingScript: shootingScript.content,
        storyboard: storyboard.content,
        generationPackage: generationPackage.content,
      },
    };
  } catch (error) {
    const artifacts = await store.listArtifacts(input.project.projectId);
    const verifications = await store.listVerifications(input.project.projectId);
    const approvals = await store.listApprovalReceipts(input.project.projectId);
    const adoptions = await store.listCurrentAdoptions(input.project.projectId);
    const adoptionHistory = await store.listAdoptionHistory(input.project.projectId);
    const stages = provider?.getStageRecords() ?? [];
    const firstFailureStage = inferFailureStage(error, artifacts, stages);
    const failedStageRecord = stages.findLast((stage) => stage.stage === firstFailureStage);
    const inputKinds = inputKindsByStage[firstFailureStage];
    const failure: WorkflowV3LiveFailureReport = {
      schemaVersion: "workflow-v3-live-failure-v1",
      status: "failed",
      failedAt: new Date().toISOString(),
      firstFailureStage,
      category: classifyFailure(error),
      inputArtifacts: inputKinds.flatMap((kind) => {
        const artifact = artifacts.find((candidate) => candidate.kind === kind);
        return artifact ? [artifactEvidence(artifact)] : [];
      }),
      prompt: firstFailureStage in workflowV3PromptContracts
        ? workflowV3PromptContracts[firstFailureStage as WorkflowV3LiveStage]
        : null,
      provider: {
        name: "codex-cli",
        model: provider?.getTextModel() ?? null,
        runId: failedStageRecord?.runId ?? null,
      },
      error: serializeFailure(error),
      successfulArtifacts: artifacts.map(artifactEvidence),
      successfulVerifications: verifications.map((receipt) => ({
        artifactId: receipt.artifactId,
        artifactHash: receipt.artifactHash,
        status: receipt.status,
      })),
      successfulApprovals: approvals.map((receipt) => ({
        receiptId: receipt.receiptId,
        artifactId: receipt.artifactId,
        artifactHash: receipt.artifactHash,
        decision: receipt.decision,
      })),
      currentAdoptions: adoptions,
      adoptionHistory,
      stages,
    };
    await writeExclusiveJson(resultPath, failure);
    return { status: "failed", resultPath, runRoot, artifacts, verifications, failure };
  }
}
