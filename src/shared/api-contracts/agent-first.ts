import { z } from "zod";
import { artifactTypeSchema } from "../schemas";

export const workspaceArtifactStateSchema = z.enum(["absent", "draft", "approved", "rejected", "superseded", "needs-review"]);
export const dependencyStateSchema = z.enum(["current", "outdated", "unknown", "not-applicable"]);
export const operationStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancel_requested", "cancelled"]);
export const issueStatusSchema = z.enum(["open", "resolved", "ignored"]);

export const artifactSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: artifactTypeSchema,
  version: z.number().int().positive(),
  status: z.string(),
  state: workspaceArtifactStateSchema,
  filePath: z.string(),
  structuredPath: z.string().nullable(),
  contentHash: z.string(),
  sourceArtifactId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  isHead: z.boolean(),
  dependencyState: dependencyStateSchema,
  dependencyMessage: z.string().nullable(),
});
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const artifactEdgeSchema = z.object({
  artifactId: z.string(),
  inputArtifactId: z.string(),
  relation: z.string(),
  createdAt: z.string(),
  inputType: artifactTypeSchema.optional(),
  inputVersion: z.number().int().positive().optional(),
  inputIsCurrentHead: z.boolean().optional(),
});
export type ArtifactEdge = z.infer<typeof artifactEdgeSchema>;

export const projectIssueSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  scopeType: z.string(),
  scopeId: z.string().nullable(),
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  title: z.string(),
  detail: z.string(),
  suggestedAction: z.string().nullable(),
  status: issueStatusSchema,
  source: z.string(),
  resolutionNote: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type ProjectIssue = z.infer<typeof projectIssueSchema>;

export const operationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  status: operationStatusSchema,
  phase: z.string().nullable(),
  progressCurrent: z.number().int().nullable(),
  progressTotal: z.number().int().nullable(),
  requestPayload: z.record(z.string(), z.unknown()),
  resultPayload: z.record(z.string(), z.unknown()).nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean(),
  processId: z.number().int().nullable(),
  idempotencyKey: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
});
export type Operation = z.infer<typeof operationSchema>;

export const operationEventSchema = z.object({
  operationId: z.string(),
  sequence: z.number().int().nonnegative(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type OperationEvent = z.infer<typeof operationEventSchema>;

export const workspaceArtifactGroupSchema = z.object({
  type: artifactTypeSchema,
  label: z.string(),
  state: workspaceArtifactStateSchema,
  head: artifactSummarySchema.nullable(),
  versions: z.array(artifactSummarySchema),
  openIssueCount: z.number().int().nonnegative(),
});

export const historicalSnapshotSchema = z.object({
  id: z.string(),
  kind: z.enum(["generation", "render", "delivery"]),
  label: z.string(),
  status: z.string(),
  lineageState: dependencyStateSchema,
  lineageMessage: z.string(),
  createdAt: z.string().nullable(),
  sourceIds: z.array(z.string()),
});
export type HistoricalSnapshot = z.infer<typeof historicalSnapshotSchema>;

export const projectWorkspaceSchema = z.object({
  project: z.object({
    id: z.string(),
    title: z.string(),
    targetDurationSec: z.number().int(),
    aspectRatio: z.string(),
    resolution: z.string(),
    updatedAt: z.string(),
  }),
  artifactGroups: z.array(workspaceArtifactGroupSchema),
  issues: z.array(projectIssueSchema),
  operations: z.array(operationSchema),
  snapshots: z.array(historicalSnapshotSchema),
  resourceSummary: z.object({
    assets: z.number().int().nonnegative(),
    shots: z.number().int().nonnegative(),
    generations: z.number().int().nonnegative(),
    qualityReviews: z.number().int().nonnegative(),
    renders: z.number().int().nonnegative(),
  }),
});
export type ProjectWorkspace = z.infer<typeof projectWorkspaceSchema>;

export const artifactDetailSchema = z.object({
  artifact: artifactSummarySchema,
  content: z.string(),
  inputs: z.array(artifactEdgeSchema),
  dependents: z.array(artifactEdgeSchema),
  approvals: z.array(z.object({
    id: z.string(), decision: z.string(), comment: z.string().nullable(), createdAt: z.string(),
  })),
  issues: z.array(projectIssueSchema),
});
export type ArtifactDetail = z.infer<typeof artifactDetailSchema>;

export const selectHeadInputSchema = z.object({
  artifactId: z.string().min(1),
  selectedBy: z.literal("user").default("user"),
});

export const issueUpdateInputSchema = z.object({
  status: z.enum(["resolved", "ignored"]),
  actor: z.string().trim().min(1).max(100).default("user"),
  reason: z.string().trim().max(2_000).optional(),
}).superRefine((value, context) => {
  if (value.status === "ignored" && !value.reason) context.addIssue({ code: "custom", message: "忽略问题时必须填写理由" });
});

export const revisionIntentSchema = z.enum(["revise", "rewrite-section", "extend", "fix-issue", "compare"]);
export const createRevisionInputSchema = z.object({
  targetArtifactId: z.string().min(1),
  instruction: z.string().trim().min(2).max(12_000),
  intent: revisionIntentSchema.default("revise"),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const createThreadInputSchema = z.object({ title: z.string().trim().min(1).max(120).default("项目讨论") });
export const agentThreadSchema = z.object({
  id: z.string(), projectId: z.string(), title: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
export type AgentThread = z.infer<typeof agentThreadSchema>;

export const agentMessageSchema = z.object({
  id: z.string(), threadId: z.string(), role: z.enum(["user", "assistant"]), content: z.string(),
  messageType: z.enum(["user", "explanation", "plan", "operation", "error", "legacy-template"]),
  targetType: z.string().nullable(), targetId: z.string().nullable(), operationId: z.string().nullable(), createdAt: z.string(),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const agentMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(12_000),
  mode: z.enum(["ask", "compare", "revise", "plan"]),
  targetArtifactId: z.string().optional(),
  targetArtifactIds: z.array(z.string()).max(20).optional(),
  intent: revisionIntentSchema.optional(),
  confirmedPlanId: z.string().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const typedErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  operationId: z.string().optional(),
  retryable: z.boolean(),
});
export type TypedError = z.infer<typeof typedErrorSchema>;
