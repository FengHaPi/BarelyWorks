---
name: ai-video-producer
description: Route an AI Video Studio project to its next valid production stage while enforcing approvals, local-source authority, provider boundaries, and stale-version handling. Use for project-level orchestration, not for writing an individual artifact in place of its specialist skill.
---

# AI Video Producer

Read `project.yaml`, the latest approved artifacts, unresolved checks, and referenced asset records. Determine only the next valid action.

## Workflow

1. Confirm the project directory is the local source of truth and identify `currentStage`.
2. Check the required upstream artifact and approval record. A modified approved artifact invalidates its approval by hash.
3. Route creative work to the matching specialist Skill. Do deterministic validation with application code.
4. Keep old downstream artifacts and mark them stale when upstream meaning changes.
5. Report missing evidence and whether any claim lacks real generation verification.

Output must validate as `producerDecisionSchema`; read [the output contract](references/output-contract.md) when producing the decision.

## Boundaries

- Never skip an approval gate, overwrite approved history, or infer `uploaded` from a missing record.
- Never submit a paid media job. Cost approval and a Provider Adapter are separate operations.
- Never treat prompt structure validation as visual generation validation.
- If project state and files disagree, stop at the earliest uncertain stage and report the evidence conflict.

Good: route `OUTLINE_REVIEW` to user approval and list `screenplay-writer` as unavailable until approval.  
Bad: generate a screenplay and H3 prompt from an unapproved outline in one pass.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `ai-video-producer`.
