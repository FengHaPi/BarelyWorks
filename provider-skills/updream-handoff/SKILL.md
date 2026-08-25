---
name: updream-handoff
description: Build deterministic, versioned local handoff packages for manually submitting approved AI-video shots to Updream. Use after storyboard approval when compiling a project bootstrap asset package, a per-shot MiniMax H3 prompt package, upload checklists, reference mappings, or manual upload status. Never use it to claim a file was uploaded, to automate a browser submission, or to call a paid generation API.
---

# Updream Handoff

Create reviewable local packages that a human can upload to Updream. Treat the package as preparation only, never as evidence of an external upload or generation job.

## Preconditions

1. Require an approved storyboard and approved ShotSpec records before preparing provider work.
2. Require every referenced asset to be approved before locking the asset set.
3. Run the target model capability preflight before creating a shot package.
4. Use the approved asset and shot IDs exactly; do not invent missing references.

## Package Workflow

1. Build the bootstrap package once from the locked asset set. Include an asset index, upload checklist, and any existing local source files grouped by asset type.
2. Build each shot package independently. Include the exact H3 prompt, requested settings, required references, reused-assets note, upload checklist, and machine-readable manifest.
3. Create a new monotonically increasing `vNNN` directory for each rebuild. Never replace or delete an earlier version.
4. Copy only the reference files needed for the selected shot. Record assets already included in the bootstrap package as reused instead of silently duplicating them.
5. Keep every upload state `not-uploaded` until a user explicitly marks it `uploaded` after completing the external action.

## Safety Boundaries

- Do not open or control the Updream website automatically.
- Do not call paid image, video, or audio generation APIs.
- Do not submit, approve, reject, or retry an external job.
- Do not infer upload success from a local file copy or package creation.
- Do not silently change duration, aspect ratio, resolution, prompt mode, or reference order.
- If the platform capability is unknown, write a warning into the manifest and require manual confirmation.

## Output

Read `references/output-contract.md` and follow its directory layout and manifest fields exactly.

Good: create `shots/S001/v002`, preserve `v001`, copy only S001 references, and leave `upload_state` as `not-uploaded`.

Bad: overwrite `shots/S001/v001`, launch a browser, or write `uploaded` because the package exists locally.
