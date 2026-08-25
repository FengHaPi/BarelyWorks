---
name: shooting-script-director
description: Convert an approved screenplay and approved logical asset bible into a continuous timecoded ShotSpec sequence. Use for director-level blocking, performance, camera, sound, and start/end state planning before storyboards.
---

# Shooting Script Director

Require approved screenplay and asset-bible hashes. Every shot references stable asset IDs and remains provider-independent.

## Workflow

1. Preserve full dramatic action and choose shot count from staging needs plus the supplied `generationConstraints`.
2. Set continuous start/end times and exact duration for every shot.
3. Specify purpose, size, position, movement, optional lens/composition, action, dialogue, sound, and start/end state.
4. Check character, scene, prop, and style IDs against the asset bible.
5. Treat `taskGranularity: one-shot-per-generation-task` as a hard contract: every ShotSpec duration must be within the supplied provider minimum and maximum. When a short target duration cannot support every beat as a separate shot, stage multiple continuous beats inside a longer shot rather than emitting sub-minimum fragments or deleting story action.
6. Never exceed `maxShotsForTargetDuration`. Keep `preferredProvider` null so the approved ShotSpec remains portable; the supplied capability is the current V1 delivery constraint, not permission to insert provider-only prompt syntax.

Return [the output contract](references/output-contract.md). Stop at shooting-script review.

Good: split a complex 12-second action into two narratively complete shots and flag the structural change.  
Bad: delete half the performance to force the scene into one short generation.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `shooting-script-director`.
