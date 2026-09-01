# Workflow V3 Release Manifest

This manifest defines the complete file boundary for the `workflow-v3-release` branch. The source checkout contained 302 mixed dirty paths; only files listed in categories A–E are eligible for migration. Category G is empty after dependency tracing. Everything in F remains in the source checkout.

## A. Required production code

| File | Change | Why it is required | Direct dependency outside V3 |
|---|---|---|---|
| `src/workflow-v3/artifact-store.ts` | Add | Immutable Artifact, Verification, Approval, and Adoption receipt persistence | Node.js only |
| `src/workflow-v3/contracts.ts` | Add | Public V3 records, schemas, and generator contract | `zod` |
| `src/workflow-v3/existing-content-adapter.ts` | Add | Narrow bridge from the existing text generator into V3 candidates | E: text-provider, shared schemas, explicit topology, skill schemas |
| `src/workflow-v3/human-adoption.ts` | Add | Hash-bound human Approval and Adoption validation | V3 contracts only |
| `src/workflow-v3/index.ts` | Add | Public V3 module exports | Other A files |
| `src/workflow-v3/live-e2e.ts` | Add | Opt-in real-model Source-to-Storyboard harness and redacted result model | V3 only |
| `src/workflow-v3/live-provider.ts` | Add | Opt-in Codex CLI stage observer and adapter | E: Codex CLI and text-provider |
| `src/workflow-v3/minimal-chain.ts` | Add | Explicit candidate, verification, approval, adoption, gate, and package sequence | V3 only |
| `src/workflow-v3/production-gate.ts` | Add | Fail-closed exact-hash and exact-lineage production gate | V3 only |
| `src/workflow-v3/repair-contract.ts` | Add | Describes bounded candidate repair without adding an automatic repair loop | V3 only |
| `src/workflow-v3/verification.ts` | Add | Deterministic immutable Verification receipts | V3 only |

## B. Required tests and test configuration

| File | Change | Why it is required | Dependencies |
|---|---|---|---|
| `tests/workflow-v3-minimal-chain-001.test.ts` | Add | Non-Live Source-to-Generation-Package chain | A plus test fixture |
| `tests/workflow-v3-approval-adoption.test.ts` | Add | Approval and current Adoption projection semantics | A plus test fixture |
| `tests/workflow-v3-adoption-history.test.ts` | Add | Immutable Adoption history and projection replacement | A plus test fixture |
| `tests/workflow-v3-failure-chaos.test.ts` | Add, redact identifiers | Fail-closed tamper and zero-side-effect cases over a sanitized real-model structural snapshot | A plus sanitized fixture |
| `tests/workflow-v3-isolation.test.ts` | Add | Proves no legacy database, state-machine, or automatic repair imports | A and both Vitest configs |
| `tests/workflow-v3-minimal-chain-001.live.test.ts` | Add | Explicitly opt-in real-model harness; excluded from all normal test commands | A plus live config |
| `tests/fixtures/workflow-v3-existing-provider.ts` | Add | Deterministic text-stage provider for all non-Live tests | Existing text-provider type only |
| `tests/fixtures/workflow-v3-golden-live-001.json` | Add, sanitized | Structural real-model baseline with private run/thread identifiers removed and hashes recomputed | A hash contract |
| `vitest.config.ts` | Modify | Explicitly excludes `tests/**/*.live.test.ts` from the default suite so model-backed tests remain opt-in | `vitest` test discovery only; no production runtime effect |
| `vitest.workflow-v3-live.config.ts` | Add | Keeps the real-model test outside the default and V3 non-Live suites | `vitest` |

## C. Required package/config changes

| File | Change | Why it is required | Merge rule |
|---|---|---|---|
| `package.json` | Modify | Adds `test:workflow-v3` and explicit `test:workflow-v3:live` commands | Start from `origin/main`; retain repository metadata and `check:version` |

No dependency version or lockfile change is required.

## D. README and documentation

| File | Change | Why it is required |
|---|---|---|
| `README.md` | Modify | Adds a 30-second V3 overview, status, workflow, commands, and limitations without replacing newer repository hygiene content |
| `CHANGELOG.md` | Modify | Records the unreleased V3 checkpoint without inventing a semantic version |
| `src/workflow-v3/README.md` | Add | Module-local safety boundary and opt-in Live command |
| `docs/workflow-v3-architecture.md` | Add | Documents Artifact → Verification → Approval → Adoption, shot identity, gate, and failure semantics |
| `docs/workflow-v3-live-e2e.md` | Add | Publishes only aggregate, redacted Live E2E evidence |
| `docs/workflow-v3-release-manifest.md` | Add | Makes the migration boundary reviewable |

`CONTRIBUTING.md`, Issue templates, `SECURITY.md`, and release hygiene files remain exactly as provided by `origin/main`.

## E. Required shared code outside `src/workflow-v3`

| File | Change | Referenced by | Why it is required | Other dirty dependencies migrated? |
|---|---|---|---|---|
| `src/shared/explicit-shot-topology.ts` | Add | `existing-content-adapter.ts` | Extracts and validates only source-authored exact shot topology | No |
| `src/ai/text-provider.ts` | Modify minimally | `existing-content-adapter.ts`, `live-provider.ts` | Adds optional V3 topology data to the two existing generation inputs | No H3/Repair changes |
| `src/ai/codex-cli-provider.ts` | Modify minimally | `live-provider.ts` | Includes the optional exact topology in Asset Bible/Shooting Script model input | No H3/Repair changes |

## F. Explicitly excluded

- All UI changes and UI tests.
- Legacy Agent, project, approval, operation, revision, production, QA, H3, handoff, database, schema migration, Skill, and provider-Skill changes not listed in E.
- Release-harness and legacy-migration scripts unrelated to the isolated V3 test command.
- `artifacts/**`, screenshots, build output, caches, SQLite files, local projects, media, and raw Provider logs.
- The source checkout's root README/package/changelog versions; only V3-specific hunks are applied to the current `origin/main` versions.

## G. Uncertain

None. Files that initially appeared in the recursive dependency closure were traced to unrelated dirty H3/Repair/legacy edits. The V3 bridge uses the clean `origin/main` implementations plus only the three explicit E changes above.
