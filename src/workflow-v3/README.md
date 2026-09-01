# workflow-v3 experimental chain

`workflow-v3` is an isolated control plane for the first executable experiment:

`Source -> Candidate -> Verification -> Human Approval -> Adoption -> downstream Candidate -> ... -> Production Gate -> Generation Package`

Hard boundaries:

- Artifact and Verification records are immutable JSON files under a v3-only runtime root. No existing SQLite database is opened or migrated.
- Every Artifact names every direct input by exact Artifact ID and content hash. Same-kind versions additionally name an explicit parent; there is no implicit current selection.
- `shotUid` is the immutable Shot identity. `S001`-style `displayId` values are labels only.
- The existing text provider is used through `ExistingArtifactContentAdapterV3`, which exposes generation methods only. It cannot call legacy repair, review, approval, operation, or state-machine services.
- v3 Repair is full-candidate plus explicit issue-to-leaf authorization. Unknown issues fail closed; Shot membership or order changes return `NON_LOCAL_REPAIR_REQUIRED`.
- Verification emits immutable hash-bound receipts. A human must explicitly record an immutable Approval receipt and explicitly adopt an approved Artifact before a downstream stage can consume it.
- Adoption is v3-only. Every successful adoption appends an immutable human Adoption receipt under `adoptions/history/`; one replaceable projection per Artifact kind is stored under `adoptions/current/` and references its receipt by `adoptionId`.
- A newer Candidate or passed Verification never changes current Adoption. Production Gate reads current projections only, resolves each projection's exact immutable receipt, and then validates hash-bound Verification, human Approval, and downstream ID+hash lineage.

Run the first experiment:

```powershell
npm run test:workflow-v3
```

Run the real-model experiment explicitly (it is excluded from the default server suite):

```powershell
$env:WORKFLOW_V3_LIVE = "1"
npm run test:workflow-v3:live
```

The live run creates a unique v3-only directory under `projects/workflow-v3-live/`. Its test harness explicitly records a human approval and Adoption after each passed generated Candidate. It makes exactly one call for each of the five content stages, stops at the first failure, and writes `live-e2e-result.json` together with immutable upstream Artifacts and Provider logs. It never opens the legacy database.

Raw Live output remains Git-ignored. The committed chaos-test fixture is a sanitized structural snapshot: provider run identifiers are replaced, thread identifiers are removed, and all affected hashes are recomputed.

Not implemented in this experiment: API/UI wiring, migration from legacy projects, provider-specific media compilation, media submission, or structural revision.
