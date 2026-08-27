import { z } from "zod";

export const projectIntegrityStepIds = [
  "source",
  "outline",
  "screenplay",
  "asset-bible",
  "shooting-script",
  "storyboard",
  "generation",
  "quality",
  "delivery",
] as const;

export const projectIntegrityStepIdSchema = z.enum(projectIntegrityStepIds);
export type ProjectIntegrityStepId = z.infer<typeof projectIntegrityStepIdSchema>;

export const projectIntegrityIssueSchema = z.object({
  stepId: projectIntegrityStepIdSchema,
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  severity: z.enum(["error", "warning"]),
});
export type ProjectIntegrityIssue = z.infer<typeof projectIntegrityIssueSchema>;

export const projectIntegrityAuditSchema = z.object({
  projectId: z.uuid(),
  status: z.enum(["healthy", "blocked"]),
  firstBlockedStepId: projectIntegrityStepIdSchema.nullable(),
  issues: z.array(projectIntegrityIssueSchema),
  checkedAt: z.iso.datetime(),
});
export type ProjectIntegrityAudit = z.infer<typeof projectIntegrityAuditSchema>;
