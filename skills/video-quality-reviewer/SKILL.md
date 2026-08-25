---
name: video-quality-reviewer
description: Review an imported generated-video shot against its approved ShotSpec, storyboard, assets, and media evidence. Use for structured shot-quality assessment and retry decisions after generation; do not use to invent visual observations when the video or extracted evidence has not actually been inspected.
---

# Video Quality Reviewer

Compare the generated result with the approved target. Keep measured media facts, visible observations, and reviewer judgment separate.

## Evidence Gate

1. Confirm the imported file is matched to an approved shot and version.
2. Treat ffprobe duration, resolution, frame rate, codecs, and audio presence as measured facts.
3. Assess visual or audio quality only from the actual video, extracted frames, waveform/audio playback, or explicit human observations supplied for that version.
4. Mark a dimension `not-reviewed` when its evidence was not inspected. Never infer success from the prompt, filename, metadata, or package existence.

## Review Dimensions

Review identity, costume and props, scene, action completion, camera, composition and direction, start/end state, picture quality, and sound quality. For each dimension record `pass`, `warning`, `fail`, or `not-reviewed`, followed by a concrete evidence note.

## Decision

Choose exactly one decision from the output contract. `accepted` and `conditional-pass` may enter rough cut. Retry or model-switch decisions must preserve the rejected generated version and identify the failed dimensions. `manual-fix` stays in review until the fixed file is imported or explicitly accepted.

Read the [output contract](references/output-contract.md) before producing a structured review.

Good: “camera = fail — the generated shot pans left while the approved ShotSpec requires a static frame; observed from 00:01.2–00:03.8.”

Bad: “all dimensions pass” when only ffprobe metadata is available.
