import type { Operation } from "../shared/api-contracts/agent-first";
import type { GenerationResolution } from "../shared/handoff-schemas";
import { OperationRepository } from "../operations/operation-repository";
import { OperationRunner, type OperationContext } from "../operations/operation-runner";
import { ProjectService } from "../projects/project-service";
import { QualityService } from "../projects/quality-service";
import { ProjectRepository } from "../projects/project-repository";
import { CumulativeVerificationService } from "../projects/cumulative-verification-service";

export class ProductionOperationService {
  constructor(
    private readonly projects: ProjectService,
    private readonly quality: QualityService,
    private readonly projectRepository: ProjectRepository,
    private readonly operations: OperationRepository,
    private readonly runner: OperationRunner,
    private readonly verification: CumulativeVerificationService,
  ) {
    runner.register("generation.bootstrap", (context) => this.bootstrap(context));
    runner.register("generation.shot-package", (context) => this.shotPackage(context));
    runner.register("generation.scan-inbox", (context) => this.scanInbox(context));
    runner.register("render.rough-cut", (context) => this.roughCut(context));
  }

  createBootstrap(projectId: string, idempotencyKey?: string): Operation {
    return this.create({ projectId, kind: "generation.bootstrap", targetType: "project", targetId: projectId, requestPayload: {}, idempotencyKey, progressTotal: 2 });
  }

  createShotPackage(projectId: string, shotId: string, generationResolution: GenerationResolution, idempotencyKey?: string): Operation {
    return this.create({ projectId, kind: "generation.shot-package", targetType: "shot", targetId: shotId, requestPayload: { shotId, generationResolution }, idempotencyKey, progressTotal: 3 });
  }

  createInboxScan(projectId: string, idempotencyKey?: string): Operation {
    return this.create({ projectId, kind: "generation.scan-inbox", targetType: "project", targetId: projectId, requestPayload: {}, idempotencyKey, progressTotal: 2 });
  }

  createRoughCut(projectId: string, idempotencyKey?: string): Operation {
    return this.create({ projectId, kind: "render.rough-cut", targetType: "project", targetId: projectId, requestPayload: {}, idempotencyKey, progressTotal: 3 });
  }

  private create(input: {
    projectId: string; kind: string; targetType: string; targetId: string; requestPayload: Record<string, unknown>;
    idempotencyKey?: string; progressTotal: number;
  }): Operation {
    this.projectRepository.require(input.projectId);
    const created = this.operations.create({ ...input, idempotencyKey: input.idempotencyKey ?? null, phase: "queued" });
    if (created.created) this.runner.schedule(created.operation.id);
    return created.operation;
  }

  private async bootstrap(context: OperationContext): Promise<Record<string, unknown>> {
    context.progress("validating-heads", 1, 2);
    await this.verification.assertReadyForProduction(context.operation.projectId);
    const result = await this.projects.createUpdreamBootstrap(context.operation.projectId, { agentFirst: true });
    context.progress("writing-bootstrap", 2, 2);
    return { bootstrap: result.bootstrap, legacyStageChanged: false, paidProviderSubmitted: false };
  }

  private async shotPackage(context: OperationContext): Promise<Record<string, unknown>> {
    const shotId = String(context.operation.requestPayload.shotId ?? "");
    const generationResolution = String(context.operation.requestPayload.generationResolution ?? "platform-default") as GenerationResolution;
    context.progress("preflight", 1, 3, { shotId });
    await this.verification.assertReadyForProduction(context.operation.projectId);
    const result = await this.projects.createUpdreamShotPackage(context.operation.projectId, shotId, generationResolution, {
      agentFirst: true,
      signal: context.signal,
      onEvent: context.event,
      onProcessId: context.setProcessId,
    });
    context.progress("writing-package", 3, 3, { shotId, version: result.package.version });
    return { package: result.package, legacyStageChanged: false, paidProviderSubmitted: false };
  }

  private async scanInbox(context: OperationContext): Promise<Record<string, unknown>> {
    context.progress("scanning-inbox", 1, 2);
    await this.verification.assertReadyForProduction(context.operation.projectId);
    const result = await this.quality.scanGenerationInbox(context.operation.projectId, 0, undefined, {
      agentFirst: true,
      signal: context.signal,
      onProcessId: context.setProcessId,
    });
    context.progress("recording-imports", 2, 2, { imported: result.imported.length, skipped: result.skipped.length, errors: result.errors.length });
    return { imported: result.imported, skipped: result.skipped, errors: result.errors, legacyStageChanged: false };
  }

  private async roughCut(context: OperationContext): Promise<Record<string, unknown>> {
    context.progress("validating-accepted-generations", 1, 3);
    await this.verification.assertReadyForProduction(context.operation.projectId);
    const result = await this.quality.renderRoughCut(context.operation.projectId, {
      agentFirst: true,
      signal: context.signal,
      onProcessId: context.setProcessId,
    });
    context.progress("writing-render-record", 3, 3, { renderId: result.render.id });
    return { render: result.render, legacyStageChanged: false };
  }
}
