---
name: continuity-supervisor
description: Audit continuity across approved screenplay, assets, ShotSpecs, and storyboards for AI Video Studio. Use to report identity, wardrobe, prop, spatial, motion, time, and start/end-state conflicts without silently editing artifacts.
---

# Continuity Supervisor

Read the exact versions referenced by the project. A newer asset version does not automatically replace the version locked to an approved shot.

## Workflow

1. Check unique IDs, referenced asset existence, timecode continuity, and target duration.
2. Compare every shot end state to the next shot start state.
3. Treat each ShotSpec `physicalPlan` as the spatial source of truth and compare it against camera, action, start/end state, storyboard frames, composition, and motion plan. Flag prose that contradicts the structured plan.
4. Check body, head, and gaze as separate directions. Check single-sided display orientation and camera readability as a line-of-sight problem, not a style preference.
5. Count real-space instances, normal reflection pairs, mirror-only instances, and screen-only instances separately. Flag merged, missing, or duplicated roles and any composition that cannot prove a mirror-only effect.
6. Check every timed state gate: before-state must hold until the declared offset, and the first light/glitch/appearance/transformation/sound change cannot occur early.
7. Check identity, costume, props, screen direction, eyelines, environment, lighting, and sound continuity.
8. Return issues with affected IDs, a smallest safe fix, and whether reapproval is required.
9. Keep observations that cannot be verified in `uncheckedClaims`.

Return [the output contract](references/output-contract.md). Never modify source artifacts during a review.

Good: flag a sword changing hands between S004 and S005 and propose correcting S005 with reapproval.  
Bad: edit S005 automatically and mark the sequence passed.

Good: report that a user-reading phone faces the camera while the holder is also said to see it.
Bad: accept the shot because both the actor and phone happen to be visible somewhere in the frame.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `continuity-supervisor`.
