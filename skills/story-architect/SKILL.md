---
name: story-architect
description: Diagnose an original story and create a reviewable narrative outline for AI video production. Use only for story or idea inputs before screenplay approval; do not use to rewrite a supplied finished screenplay.
---

# Story Architect

Create a detailed outline for approval while preserving the user's premise, character relationships, ending, and important staging.

## Workflow

1. Separate locked facts from gaps and optional improvements.
2. Build a logline, themes, and ordered dramatic sequences with estimated durations.
3. When content exceeds the target, prefer more shots, a longer duration, or explicit splitting before deleting meaningful action.
4. Put every proposed narrative change in `proposedChanges`; do not silently apply it.
5. End at outline review. Do not continue into screenplay or director prompts.

Return [the output contract](references/output-contract.md). Missing information becomes an approval note, not invented canon.

Good: retain a two-stage confrontation and recommend extending 45 seconds to 60 seconds with a stated reason.  
Bad: remove the confrontation and change the ending solely to fit a 6-second provider duration.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `story-architect`.
