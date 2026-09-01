import { randomUUID } from "node:crypto";
import type { ArtifactStoreV3 } from "./artifact-store";
import {
  assetBibleContentV3Schema,
  generatedShootingScriptContentV3Schema,
  generatedStoryboardContentV3Schema,
  generationPackageContentV3Schema,
  outlineContentV3Schema,
  projectV3Schema,
  screenplayContentV3Schema,
  shootingScriptContentV3Schema,
  sourceContentV3Schema,
  storyboardContentV3Schema,
  type ArtifactRecordV3,
  type AssetBibleContentV3,
  type ContentGeneratorV3,
  type GeneratedContentV3,
  type GenerationPackageContentV3,
  type OutlineContentV3,
  type ProductionGateResultV3,
  type ProjectV3,
  type ScreenplayContentV3,
  type ShootingScriptContentV3,
  type SourceContentV3,
  type StoryboardContentV3,
  type VerificationReceiptV3,
} from "./contracts";
import { evaluateProductionGateV3 } from "./production-gate";
import { verifyArtifactV3 } from "./verification";

type StoredGeneratedPayloadV3<T> = GeneratedContentV3<T> & { content: T };

export interface CandidateResultV3<T> {
  artifact: ArtifactRecordV3<StoredGeneratedPayloadV3<T>>;
  verification: VerificationReceiptV3;
  content: T;
}

export interface SourceCandidateResultV3 {
  artifact: ArtifactRecordV3<{
    content: SourceContentV3;
    trace: { provider: "workflow-v3"; runId: "source-intake"; completedAt: string };
  }>;
  verification: VerificationReceiptV3;
  content: SourceContentV3;
}

function promptForShot(
  shot: ShootingScriptContentV3["shots"][number],
  frame: StoryboardContentV3["frames"][number],
  assets: AssetBibleContentV3,
): string {
  const facts = assets.assets.filter((asset) => shot.assetIds.includes(asset.assetId))
    .flatMap((asset) => [`${asset.name}：${asset.promptFacts.join("、")}`]);
  return [
    `镜头 ${shot.displayId}，时长 ${shot.durationSec} 秒。`,
    `动作：${shot.action}`,
    `状态：${shot.startState} → ${shot.endState}`,
    `摄影机：${shot.camera.position}，${shot.camera.movement}`,
    `画面：${frame.startFrame}；${frame.composition}；${frame.motion}；${frame.endFrame}`,
    `资产事实：${facts.join("；")}`,
  ].join("\n");
}

function storedPayload<T>(artifact: ArtifactRecordV3): StoredGeneratedPayloadV3<T> {
  return artifact.payload as StoredGeneratedPayloadV3<T>;
}

export class WorkflowV3MinimalChain {
  readonly project: ProjectV3;
  private readonly sourceText: string;
  private readonly generator: ContentGeneratorV3;
  private readonly store: ArtifactStoreV3;
  private readonly now: () => string;
  private readonly shotIdentity: () => string;
  private readonly verificationIdentity?: () => string;

  constructor(input: {
    project: ProjectV3;
    sourceText: string;
    generator: ContentGeneratorV3;
    store: ArtifactStoreV3;
    now?: () => string;
    shotIdentity?: () => string;
    verificationIdentity?: () => string;
  }) {
    this.project = projectV3Schema.parse(input.project);
    this.sourceText = sourceContentV3Schema.parse({ text: input.sourceText }).text;
    this.generator = input.generator;
    this.store = input.store;
    this.now = input.now ?? (() => new Date().toISOString());
    this.shotIdentity = input.shotIdentity ?? randomUUID;
    this.verificationIdentity = input.verificationIdentity;
  }

  private async commitVerified<T>(
    kind: ArtifactRecordV3["kind"],
    payload: T,
    inputArtifactIds: string[],
  ): Promise<{ artifact: ArtifactRecordV3<T>; verification: VerificationReceiptV3 }> {
    const artifact = await this.store.commit({
      projectId: this.project.projectId,
      kind,
      payload,
      inputArtifactIds,
    });
    const verification = verifyArtifactV3({
      artifact,
      artifacts: await this.store.listArtifacts(this.project.projectId),
      now: this.now,
      identity: this.verificationIdentity,
    });
    await this.store.commitVerification(verification);
    if (verification.status !== "passed") throw new Error(`WORKFLOW_V3_VERIFICATION_FAILED: ${kind}`);
    return { artifact, verification };
  }

  private async requireExactSource(sourceArtifact: ArtifactRecordV3): Promise<ArtifactRecordV3> {
    const stored = await this.store.requireArtifact(sourceArtifact.artifactId);
    if (stored.projectId !== this.project.projectId
      || stored.kind !== "source"
      || stored.contentHash !== sourceArtifact.contentHash) {
      throw new Error("WORKFLOW_V3_SOURCE_ARTIFACT_MISMATCH");
    }
    return stored;
  }

  async createSourceCandidate(): Promise<SourceCandidateResultV3> {
    const content = sourceContentV3Schema.parse({ text: this.sourceText });
    const stored = await this.commitVerified("source", {
      content,
      trace: { provider: "workflow-v3" as const, runId: "source-intake" as const, completedAt: this.now() },
    }, []);
    return { ...stored, content };
  }

  async generateOutlineCandidate(sourceArtifact: ArtifactRecordV3): Promise<CandidateResultV3<OutlineContentV3>> {
    const source = await this.requireExactSource(sourceArtifact);
    const sourceContent = sourceContentV3Schema.parse((source.payload as { content: unknown }).content);
    const generated = await this.generator.generateOutline({ project: this.project, sourceText: sourceContent.text });
    const content = outlineContentV3Schema.parse(generated.content);
    const stored = await this.commitVerified("outline", { ...generated, content }, [source.artifactId]);
    return { ...stored, content };
  }

  async generateScreenplayCandidate(sourceArtifact: ArtifactRecordV3): Promise<CandidateResultV3<ScreenplayContentV3>> {
    const source = await this.requireExactSource(sourceArtifact);
    const outlineArtifact = await this.store.requireAdoptedArtifact(this.project.projectId, "outline");
    const sourceContent = sourceContentV3Schema.parse((source.payload as { content: unknown }).content);
    const outlinePayload = storedPayload<OutlineContentV3>(outlineArtifact);
    const outline = outlineContentV3Schema.parse(outlinePayload.content);
    const generated = await this.generator.generateScreenplay({
      project: this.project,
      sourceText: sourceContent.text,
      outline,
      outlineProviderPayload: outlinePayload.providerPayload,
      outlineArtifact,
    });
    const content = screenplayContentV3Schema.parse(generated.content);
    const stored = await this.commitVerified("screenplay", { ...generated, content }, [source.artifactId, outlineArtifact.artifactId]);
    return { ...stored, content };
  }

  async generateAssetBibleCandidate(sourceArtifact: ArtifactRecordV3): Promise<CandidateResultV3<AssetBibleContentV3>> {
    const source = await this.requireExactSource(sourceArtifact);
    const screenplayArtifact = await this.store.requireAdoptedArtifact(this.project.projectId, "screenplay");
    const sourceContent = sourceContentV3Schema.parse((source.payload as { content: unknown }).content);
    const screenplayPayload = storedPayload<ScreenplayContentV3>(screenplayArtifact);
    const screenplay = screenplayContentV3Schema.parse(screenplayPayload.content);
    const generated = await this.generator.generateAssetBible({
      project: this.project,
      sourceText: sourceContent.text,
      screenplay,
      screenplayProviderPayload: screenplayPayload.providerPayload,
      screenplayArtifact,
    });
    const content = assetBibleContentV3Schema.parse(generated.content);
    const stored = await this.commitVerified("asset-bible", { ...generated, content }, [screenplayArtifact.artifactId]);
    return { ...stored, content };
  }

  async generateShootingScriptCandidate(sourceArtifact: ArtifactRecordV3): Promise<CandidateResultV3<ShootingScriptContentV3>> {
    const source = await this.requireExactSource(sourceArtifact);
    const screenplayArtifact = await this.store.requireAdoptedArtifact(this.project.projectId, "screenplay");
    const assetBibleArtifact = await this.store.requireAdoptedArtifact(this.project.projectId, "asset-bible");
    const sourceContent = sourceContentV3Schema.parse((source.payload as { content: unknown }).content);
    const screenplayPayload = storedPayload<ScreenplayContentV3>(screenplayArtifact);
    const assetBiblePayload = storedPayload<AssetBibleContentV3>(assetBibleArtifact);
    const screenplay = screenplayContentV3Schema.parse(screenplayPayload.content);
    const assetBible = assetBibleContentV3Schema.parse(assetBiblePayload.content);
    const generated = await this.generator.generateShootingScript({
      project: this.project,
      sourceText: sourceContent.text,
      screenplay,
      screenplayProviderPayload: screenplayPayload.providerPayload,
      screenplayArtifact,
      assetBible,
      assetBibleProviderPayload: assetBiblePayload.providerPayload,
      assetBibleArtifact,
    });
    const generatedContent = generatedShootingScriptContentV3Schema.parse(generated.content);
    const duration = generatedContent.shots.reduce((sum, shot) => sum + shot.durationSec, 0);
    if (Math.abs(duration - this.project.targetDurationSec) > 0.001) {
      throw new Error(`WORKFLOW_V3_DURATION_MISMATCH: expected ${this.project.targetDurationSec}, got ${duration}`);
    }
    const content = shootingScriptContentV3Schema.parse({
      shots: generatedContent.shots.map((shot) => ({ ...shot, shotUid: this.shotIdentity() })),
    });
    const stored = await this.commitVerified("shooting-script", { ...generated, content }, [
      screenplayArtifact.artifactId,
      assetBibleArtifact.artifactId,
    ]);
    return { ...stored, content };
  }

  async generateStoryboardCandidate(): Promise<CandidateResultV3<StoryboardContentV3>> {
    const shootingArtifact = await this.store.requireAdoptedArtifact(this.project.projectId, "shooting-script");
    const assetBibleArtifact = await this.store.requireAdoptedArtifact(this.project.projectId, "asset-bible");
    const shootingPayload = storedPayload<ShootingScriptContentV3>(shootingArtifact);
    const assetBiblePayload = storedPayload<AssetBibleContentV3>(assetBibleArtifact);
    const shootingScript = shootingScriptContentV3Schema.parse(shootingPayload.content);
    const assetBible = assetBibleContentV3Schema.parse(assetBiblePayload.content);
    const generated = await this.generator.generateStoryboard({
      project: this.project,
      shootingScript,
      shootingScriptProviderPayload: shootingPayload.providerPayload,
      shootingScriptArtifact: shootingArtifact,
      assetBible,
      assetBibleProviderPayload: assetBiblePayload.providerPayload,
      assetBibleArtifact,
    });
    const generatedContent = generatedStoryboardContentV3Schema.parse(generated.content);
    const expectedDisplayIds = shootingScript.shots.map((shot) => shot.displayId);
    const actualDisplayIds = generatedContent.frames.map((frame) => frame.displayId);
    if (JSON.stringify(actualDisplayIds) !== JSON.stringify(expectedDisplayIds)) {
      throw new Error(`WORKFLOW_V3_STORYBOARD_TOPOLOGY_MISMATCH: expected ${expectedDisplayIds.join(",")}, got ${actualDisplayIds.join(",")}`);
    }
    const shotUidByDisplayId = new Map(shootingScript.shots.map((shot) => [shot.displayId, shot.shotUid]));
    const content = storyboardContentV3Schema.parse({
      frames: generatedContent.frames.map((frame) => ({ ...frame, shotUid: shotUidByDisplayId.get(frame.displayId) })),
    });
    const stored = await this.commitVerified("storyboard", { ...generated, content }, [
      shootingArtifact.artifactId,
      assetBibleArtifact.artifactId,
    ]);
    return { ...stored, content };
  }

  async evaluateProductionGate(): Promise<ProductionGateResultV3> {
    const adoptions = await this.store.listCurrentAdoptions(this.project.projectId);
    const currentAdoptionReceipts = (await Promise.all(adoptions.map((adoption) => (
      this.store.getAdoptionReceipt(this.project.projectId, adoption.adoptionId)
    )))).filter((receipt) => receipt !== null);
    return evaluateProductionGateV3({
      artifacts: await this.store.listArtifacts(this.project.projectId),
      verifications: await this.store.listVerifications(this.project.projectId),
      approvals: await this.store.listApprovalReceipts(this.project.projectId),
      adoptions,
      currentAdoptionReceipts,
    });
  }

  async generatePackage(): Promise<CandidateResultV3<GenerationPackageContentV3> & { productionGate: ProductionGateResultV3 }> {
    const productionGate = await this.evaluateProductionGate();
    if (!productionGate.passed) {
      throw new Error(`WORKFLOW_V3_PRODUCTION_GATE_FAILED: ${productionGate.blockers.map((blocker) => blocker.code).join(",")}`);
    }
    const assetBibleArtifact = await this.store.requireAdoptedArtifact(this.project.projectId, "asset-bible");
    const shootingArtifact = await this.store.requireAdoptedArtifact(this.project.projectId, "shooting-script");
    const storyboardArtifact = await this.store.requireAdoptedArtifact(this.project.projectId, "storyboard");
    const assetBible = assetBibleContentV3Schema.parse(storedPayload<AssetBibleContentV3>(assetBibleArtifact).content);
    const shootingScript = shootingScriptContentV3Schema.parse(storedPayload<ShootingScriptContentV3>(shootingArtifact).content);
    const storyboard = storyboardContentV3Schema.parse(storedPayload<StoryboardContentV3>(storyboardArtifact).content);
    const frameByShotUid = new Map(storyboard.frames.map((frame) => [frame.shotUid, frame]));
    const content = generationPackageContentV3Schema.parse({
      schemaVersion: "generation-package-v3",
      sourceArtifactIds: [assetBibleArtifact.artifactId, shootingArtifact.artifactId, storyboardArtifact.artifactId],
      tasks: shootingScript.shots.map((shot) => ({
        shotUid: shot.shotUid,
        displayId: shot.displayId,
        durationSec: shot.durationSec,
        prompt: promptForShot(shot, frameByShotUid.get(shot.shotUid)!, assetBible),
        assetIds: shot.assetIds,
      })),
    });
    const stored = await this.commitVerified("generation-package", {
      content,
      trace: {
        provider: "workflow-v3-deterministic-compiler",
        runId: `package-${shootingArtifact.contentHash.slice(0, 16)}`,
        completedAt: this.now(),
      },
    }, [assetBibleArtifact.artifactId, shootingArtifact.artifactId, storyboardArtifact.artifactId]);
    return { ...stored, content, productionGate };
  }
}
