---
name: asset-bible-builder
description: Extract a versioned logical asset bible from an approved screenplay for AI Video Studio. Use for characters, scenes, props, costumes, styles, audio, and references before shooting-script work.
---

# Asset Bible Builder

Require a screenplay approval record. Define logical identity before images are generated, and assign stable IDs by asset type.

## Workflow

1. Extract screenplay-supported assets and cite source evidence. Read the supplied `designMode` before resolving missing visual details.
2. Assign `CHAR-001`, `SCENE-001`, `PROP-001`, `COSTUME-001`, `STYLE-001`, `AUDIO-001`, or `REF-001` IDs.
3. Treat the supplied project `aspectRatio` as an authoritative hard parameter. Style, scene, camera, framing, and composition descriptions must use that ratio and must never introduce a conflicting ratio.
4. Specify identity, visible appearance, continuity rules, and intended use. Every visual asset must include `designBasis`, `productionReady`, `designSummary`, distinctive features, and negative constraints.
5. Report contradictions rather than merging incompatible versions silently.
6. Do not generate files, hashes, upload states, or approval values that have not been measured.
7. Keep the result production-useful and concise. Do not repeat the same paragraph across sibling assets. Prefer one short, asset-specific sentence per field, at most three continuity rules, at most three unknown groups, and at most three short source-evidence entries unless the screenplay truly requires more.
8. When `designMode` is `original-proposal`, make an explicit, coherent and editable original visual proposal for every production-critical detail missing from the screenplay. Mark it `creative-proposal`; do not present it as a source fact. Do not return sibling placeholders such as Member A/B/C or defer colors, face, hair or headwear, body proportions, costume, signature features, performance traits, environment geometry, materials, or lighting to `unknowns` when those choices are required to draw the asset.
9. When `designMode` is `reference-first`, do not invent missing visual details. Mark unresolved assets `productionReady=false` and explain the exact reference or user decision required. A blocked draft may be reviewed but must not pretend to be ready.
10. A character marked `productionReady=true` needs a fixed palette, face plus hair/headwear, body proportions, costume, at least three distinguishing features, at least two negative constraints, and an actionable visual summary. Other visual assets need equivalent material, shape, palette, scale, lighting or spatial anchors appropriate to their type.
11. When several characters share project-wide rules, place those rules in the style asset, but still give every character a distinct silhouette, palette and signature detail.

Return [the output contract](references/output-contract.md).

Good: label an invented red leaf-shaped headpiece as a creative proposal and lock its silhouette and palette for review.  
Bad: call seven characters A through G while leaving colors, faces, costumes and abilities unknown.  
Bad: claim an image hash and Updream upload state when no file exists.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `asset-bible-builder`.
