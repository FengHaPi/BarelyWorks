---
name: continuity-supervisor
description: Audit continuity across approved screenplay, assets, ShotSpecs, and storyboards for AI Video Studio. Use to report identity, wardrobe, prop, spatial, motion, time, and start/end-state conflicts without silently editing artifacts.
---

# Continuity Supervisor

Read the exact versions referenced by the project. A newer asset version does not automatically replace the version locked to an approved shot.

## Workflow

1. Check unique IDs, referenced asset existence, timecode continuity, and target duration.
2. Compare every shot end state to the next shot start state.
3. Check identity, costume, props, screen direction, eyelines, environment, lighting, and sound continuity.
4. Return issues with affected IDs, a smallest safe fix, and whether reapproval is required.
5. Keep observations that cannot be verified in `uncheckedClaims`.

Return [the output contract](references/output-contract.md). Never modify source artifacts during a review.

Good: flag a sword changing hands between S004 and S005 and propose correcting S005 with reapproval.  
Bad: edit S005 automatically and mark the sequence passed.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `continuity-supervisor`.
