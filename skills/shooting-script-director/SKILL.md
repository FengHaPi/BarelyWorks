---
name: shooting-script-director
description: Convert an approved screenplay and approved logical asset bible into a continuous timecoded ShotSpec sequence. Use for director-level blocking, performance, camera, sound, and start/end state planning before storyboards.
---

# Shooting Script Director

Require approved screenplay and asset-bible hashes. Every shot references stable asset IDs and remains provider-independent.

## Workflow

1. Preserve full dramatic action and choose shot count from staging needs plus the supplied `generationConstraints`. Use the fewest model-executable generation segments: prefer a shot near `preferredShotDurationSec` only while it remains inside the supplied beat, camera-phase, timed-gate, and high-risk-layer budgets. A longer but overloaded shot is not feasible.
2. Set continuous start/end times and exact duration for every shot. Production time is quantized to whole seconds: `durationSec`, `startTimeSec`, and `endTimeSec` must be integers. Every shot must be at least the supplied `durationMinSec` (the product floor is 5 seconds), and all shot durations must sum exactly to the project target. For example, split 15 seconds as 8+7, 9+6, or 5+5+5, never 7.5+7.5.
3. Specify purpose, size, position, movement, optional lens/composition, action, dialogue, sound, and start/end state.
4. Build `physicalPlan` before writing prose. Give every on-screen presence a stable instance ID and domain (`real-space`, `screen-space`, or `reflection-only`). Before camera prose, declare `cameraContinuityMode` and a `spaceTopology` containing every physical space and traversable boundary. Then cover the whole shot with continuous camera segments. Every segment must name its `spaceId`, stable `positionAnchor`, `lookAt`, `transitionFromPrevious`, nullable `boundaryId`, and (after the first segment unless it is a cut) an executable `transitionPath`. Keep body direction, head direction, and gaze target separate.
5. For any display device, declare whether it is single-sided, who holds and reads it, which way its display faces, whether the camera must read it, and the physically achievable reading method. Ordinary user reading means the screen faces the holder. A frontal camera cannot read that same single-sided screen unless the story explicitly changes the interaction to presentation; otherwise use an over-shoulder, profile, insert, or reflection view.
6. For reflective surfaces, enumerate normal reflection pairs, mirror-only instances, and real-space instances separately. A mirror-only anomaly must not be represented as the normal reflection, and the reflective boundary plus real-space evidence must stay visible when needed to prove the topology.
7. For every delayed light, glitch, appearance, transformation, sound, or other state change, add a `timedStateGate` with a before-state, exact first allowed offset, after-state, and `noEarlyOccurrence: true`.
8. If camera visibility, character visibility, display orientation, or reflection topology cannot all be true at once, change the blocking or split the shot before returning it. Never compensate by silently turning a prop toward the lens or changing the story's spatial facts.
9. Check character, scene, prop, and style IDs against the asset bible.
10. Treat `taskGranularity: one-shot-per-generation-task` as a hard contract: every ShotSpec duration must be an integer multiple of `durationStepSec` and within the supplied product minimum and provider maximum. When a short target duration cannot support every beat as a separate shot, stage multiple continuous beats inside a longer shot rather than emitting sub-minimum fragments or deleting story action.
11. Split only for a real narrative turn, scene or time transition, incompatible performance phase, or an essential camera-language change. Fewer longer tasks reduce cross-task color/exposure drift, identity variation, and assembly work.
12. `avoidDurationPadding: true` forbids empty waiting, repeated motion, meaningless pauses, or unrelated action added only to make a shot longer. Content density overrides duration preference: a naturally complete shorter shot is better than padded footage.
13. Never exceed `maxShotsForTargetDuration`. Keep `preferredProvider` null so the approved ShotSpec remains portable; the supplied capability is the current V1 delivery constraint, not permission to insert provider-only prompt syntax.
14. Before returning, perform a causal-visibility audit: when a door, shutter, lid, curtain, or other occluder starts opening, anything directly behind it becomes at least partially visible at that same moment unless another explicitly modelled occluder remains. A later gate may mark “first clearly recognizable,” but must not still claim complete invisibility.
15. Perform a boundary-state audit across every adjacent ShotSpec. Copy the exact character pose, gaze, prop hand, prop height, prop orientation, light state, display state, and reflection state from the previous `endState` into the next `startState`. A camera cut or position reset cannot silently move a prop or character.
16. Keep each shot within the model execution budget: no more than `maxMajorBeatsPerShot` major visible beats, `maxCameraPhasesPerShot` camera phases, `maxTimedStateGatesPerShot` exact gates, and `maxHighRiskLayersPerShot` high-risk layers. Treat readable screen content, complex reflection topology, non-Euclidean/direct-connected space, and multi-copy crowds as separate high-risk layers. If all four occur, split at a real reveal boundary.
17. Describe only results visible or audible from the active camera. Do not schedule screen pixels, facial micro-details, or spatial evidence that the camera cannot read. Use exact timing only for causally critical reveals; express secondary motion as order or broad ranges.
18. In confined spaces, limit camera grammar to an establishing/follow move, one principal reposition, and one final small adjustment. Do not solve staging with repeated arcs, backtracks, centimetre corrections, or alternating pushes and pulls.
19. Keep copy crowds to roughly 8–12 readable figures and give the group one collective action. Sound layers must have one non-contradictory timeline: a layer cannot continue past its stated stop, dropout, or silence point.
20. Spatial continuity is a hard gate. The first camera segment uses `transitionFromPrevious: initial`. Later segments may use `continuous`, `boundary-crossing`, or an explicitly motivated `cut`. A `single-take` may never contain `cut`. Changing `spaceId` during a continuous move requires `boundary-crossing` through a matching `traversalAllowed` boundary. Never reset the camera from outside to inside, or inside to outside, without showing the real doorway traversal; if that path is not model-executable, split into adjacent ShotSpecs and copy the exact boundary state.

Return [the output contract](references/output-contract.md). Stop at shooting-script review.

Good: keep a naturally continuous 12-second performance in one generation task when it stays inside the model execution budget; split at a reveal boundary when screen, mirror, impossible space, and a copy crowd would otherwise compete in one shot.
Bad: delete half the performance to force the scene into one short generation.

Good: let a phone user see the screen while an over-shoulder camera also reads it.
Bad: turn a normally used single-sided phone screen outward only so a frontal camera can see the call.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `shooting-script-director`.
