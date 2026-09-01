# Workflow V3 Live E2E — Redacted Evidence Summary

This document records aggregate facts from an existing real-model run. The Live test was **not rerun for this release workspace**.

## Run summary

| Field | Result |
|---|---|
| Test date | 2026-08-31 (UTC) |
| Workflow result schema | `workflow-v3-live-result-v1` |
| Artifact schema | `workflow-v3-artifact-v1` |
| Verification schema | `workflow-v3-verification-v1` |
| Production Gate schema | `workflow-v3-production-gate-v1` |
| Provider | Codex CLI |
| Model observed in all five stages | `gpt-5.6-sol` |
| Model stages | 5 started / 5 completed / 0 failed |
| Content path | Outline → Screenplay → Asset Bible → Shooting Script → Storyboard |
| Artifacts | 7: Source, five content stages, Generation Package |
| Verification | 7 passed receipts |
| Human decisions | 5 Approval receipts / 5 Adoption receipts |
| Production Gate | passed / 0 blockers / 6 checked Artifacts |
| Generation Package | generated |

The five observed prompt/output contracts were `story-architect-v1`, `screenplay-writer-v1`, `asset-bible-builder-v1`, `shooting-script-director-v2`, and `storyboard-director-v2`.

## Aggregate token usage

| Metric | Total |
|---|---:|
| Input tokens | 135,011 |
| Cached input tokens | 0 |
| Cache-write input tokens | 0 |
| Output tokens | 26,506 |
| Reasoning output tokens | 11,655 |

These values are aggregate diagnostics from the recorded run. They are not a benchmark, price estimate, or guarantee for another model or checkout.

## Failure-path evidence

The public non-Live failure/chaos suite uses a sanitized structural snapshot derived from the successful run. It exercises content-hash tampering, stale lineage, invalid human evidence, Adoption mismatch, and gate failures. Each case verifies that the fixture, legacy SQLite path, and ignored local Live-run directory are unchanged. The failure path imports no model provider and contains no automatic repair, revision, review, or regeneration call.

## Public-data boundary

The repository does not publish authentication, cookies, API keys, Codex sign-in state, proxy configuration, private machine paths, raw Provider JSONL, original thread IDs, original run IDs, or local project directories. The committed structural fixture replaces run identifiers, removes thread identifiers, and recomputes all affected Artifact, lineage, Verification, and fixture hashes.

This evidence demonstrates a real-model Source-to-Storyboard control-plane run. It does **not** demonstrate H3 integration, video-provider execution, shot-media quality, editing, delivery, production UI integration, production readiness, or a finished video.
