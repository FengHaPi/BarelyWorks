import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectAgentService } from "../../agent/project-agent-service";
import type { ApprovalService } from "../../approvals/approval-service";
import type { ArtifactService } from "../../artifacts/artifact-service";
import type { IssueService } from "../../issues/issue-service";
import type { OperationService } from "../../operations/operation-service";
import type { ProjectWorkspaceService } from "../../projects/project-workspace-service";
import type { ProductionOperationService } from "../../production/production-operation-service";
import type { ContinuityRepairOperationService } from "../../continuity/continuity-repair-operation-service";
import type { RevisionService } from "../../revisions/revision-service";
import type { CumulativeVerificationService } from "../../projects/cumulative-verification-service";
import {
  agentMessageInputSchema,
  createRevisionInputSchema,
  createThreadInputSchema,
  issueUpdateInputSchema,
  selectHeadInputSchema,
} from "../../shared/api-contracts/agent-first";
import { artifactTypeSchema } from "../../shared/schemas";
import { generationResolutionSchema } from "../../shared/handoff-schemas";

export interface AgentFirstRouteServices {
  workspace: ProjectWorkspaceService;
  artifacts: ArtifactService;
  revisions: RevisionService;
  operations: OperationService;
  issues: IssueService;
  agent: ProjectAgentService;
  approvals: ApprovalService;
  production: ProductionOperationService;
  continuityRepairs: ContinuityRepairOperationService;
  verification: CumulativeVerificationService;
}

export function registerAgentFirstRoutes(app: FastifyInstance, services: AgentFirstRouteServices): void {
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/workspace", async (request) => ({
    workspace: services.workspace.get(request.params.projectId),
  }));

  app.get<{ Params: { projectId: string }; Querystring: { through?: string; artifactId?: string } }>("/api/projects/:projectId/verification-ledger", async (request) => {
    const through = request.query.through === "production" ? "production" : artifactTypeSchema.parse(request.query.through);
    return { ledger: await services.verification.audit(request.params.projectId, through, request.query.artifactId ?? null) };
  });

  app.get<{ Params: { projectId: string; artifactId: string } }>("/api/projects/:projectId/artifacts/:artifactId/lineage", async (request) => {
    const detail = await services.artifacts.detail(request.params.projectId, request.params.artifactId);
    return { artifact: detail.artifact, inputs: detail.inputs, dependents: detail.dependents };
  });

  app.patch<{ Params: { projectId: string; artifactType: string }; Body: unknown }>("/api/projects/:projectId/heads/:artifactType", async (request) => {
    const type = artifactTypeSchema.parse(request.params.artifactType);
    const body = selectHeadInputSchema.parse(request.body);
    await services.artifacts.selectHead(request.params.projectId, type, body.artifactId);
    return { workspace: services.workspace.get(request.params.projectId) };
  });

  app.post<{ Params: { projectId: string }; Body: unknown }>("/api/projects/:projectId/revisions", async (request, reply) => {
    const body = createRevisionInputSchema.parse(request.body);
    const result = services.revisions.create(request.params.projectId, body);
    return reply.status(202).send(result);
  });

  app.get<{ Params: { operationId: string } }>("/api/operations/:operationId", async (request) => ({
    operation: services.operations.get(request.params.operationId),
  }));

  app.get<{ Params: { operationId: string } }>("/api/operations/:operationId/events", async (request) => ({
    events: services.operations.events(request.params.operationId),
  }));

  app.post<{ Params: { operationId: string } }>("/api/operations/:operationId/cancel", async (request) => ({
    operation: await services.operations.cancel(request.params.operationId),
  }));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/issues", async (request) => ({
    issues: services.issues.list(request.params.projectId),
  }));

  app.patch<{ Params: { projectId: string; issueId: string }; Body: unknown }>("/api/projects/:projectId/issues/:issueId", async (request) => {
    const body = issueUpdateInputSchema.parse(request.body);
    return { issue: services.issues.update(request.params.issueId, request.params.projectId, body.status, body.actor, body.reason) };
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/agent/threads", async (request) => ({
    threads: services.agent.listThreads(request.params.projectId),
  }));

  app.post<{ Params: { projectId: string }; Body: unknown }>("/api/projects/:projectId/agent/threads", async (request, reply) => {
    const body = createThreadInputSchema.parse(request.body ?? {});
    return reply.status(201).send({ thread: services.agent.createThread(request.params.projectId, body.title) });
  });

  app.get<{ Params: { projectId: string; threadId: string } }>("/api/projects/:projectId/agent/threads/:threadId/messages", async (request) => ({
    messages: services.agent.listMessages(request.params.projectId, request.params.threadId),
  }));

  app.post<{ Params: { projectId: string; threadId: string }; Body: unknown }>("/api/projects/:projectId/agent/threads/:threadId/messages", async (request, reply) => {
    const body = agentMessageInputSchema.parse(request.body);
    const result = await services.agent.send(request.params.projectId, request.params.threadId, body);
    return reply.status(result.kind === "operation" ? 202 : 200).send(result);
  });

  app.post<{ Params: { projectId: string; artifactId: string }; Body: unknown }>("/api/projects/:projectId/artifacts/:artifactId/decisions", async (request, reply) => {
    const body = z.object({ decision: z.enum(["approved", "rejected"]), comment: z.string().max(4_000).optional() }).parse(request.body);
    const result = await services.approvals.decide(request.params.projectId, request.params.artifactId, body.decision, body.comment);
    return reply.status(201).send(result);
  });

  app.post<{ Params: { projectId: string; artifactId: string }; Body: unknown }>("/api/projects/:projectId/artifacts/:artifactId/continuity-repair-operations", async (request, reply) => {
    const body = z.object({ idempotencyKey: z.string().trim().min(1).max(200).optional() }).parse(request.body ?? {});
    const operation = services.continuityRepairs.create(request.params.projectId, request.params.artifactId, body.idempotencyKey);
    return reply.status(202).send({ operationId: operation.id, operation });
  });

  app.get<{ Params: { projectId: string; artifactId: string } }>("/api/projects/:projectId/artifacts/:artifactId/continuity-repair-plan", async (request) => ({
    plan: await services.continuityRepairs.plan(request.params.projectId, request.params.artifactId),
  }));

  const commandInput = z.object({ idempotencyKey: z.string().trim().min(1).max(200).optional() });
  app.post<{ Params: { projectId: string }; Body: unknown }>("/api/projects/:projectId/production/bootstrap", async (request, reply) => {
    const body = commandInput.parse(request.body ?? {});
    const operation = services.production.createBootstrap(request.params.projectId, body.idempotencyKey);
    return reply.status(202).send({ operationId: operation.id, operation });
  });
  app.post<{ Params: { projectId: string; shotId: string }; Body: unknown }>("/api/projects/:projectId/production/shots/:shotId/package", async (request, reply) => {
    const body = commandInput.extend({ generationResolution: generationResolutionSchema.default("platform-default") }).parse(request.body ?? {});
    const operation = services.production.createShotPackage(request.params.projectId, request.params.shotId, body.generationResolution, body.idempotencyKey);
    return reply.status(202).send({ operationId: operation.id, operation });
  });
  app.post<{ Params: { projectId: string }; Body: unknown }>("/api/projects/:projectId/production/generations/scan", async (request, reply) => {
    const body = commandInput.parse(request.body ?? {});
    const operation = services.production.createInboxScan(request.params.projectId, body.idempotencyKey);
    return reply.status(202).send({ operationId: operation.id, operation });
  });
  app.post<{ Params: { projectId: string }; Body: unknown }>("/api/projects/:projectId/production/renders/rough-cut", async (request, reply) => {
    const body = commandInput.parse(request.body ?? {});
    const operation = services.production.createRoughCut(request.params.projectId, body.idempotencyKey);
    return reply.status(202).send({ operationId: operation.id, operation });
  });
}
