<p align="right">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

# BarelyWorks · AI Video Studio

> A local-first, Agent-first AI video production console for Windows, built around versioned artifacts, cumulative verification, human approval gates, and auditable handoffs.

![Project status](https://img.shields.io/badge/status-alpha-7c3aed)
![Version](https://img.shields.io/badge/version-v0.2.0--alpha-6366f1)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12.0-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-22c55e)
[![Build](https://github.com/FengHaPi/BarelyWorks/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/FengHaPi/BarelyWorks/actions/workflows/verify.yml)
[![Release](https://img.shields.io/github/v/release/FengHaPi/BarelyWorks?include_prereleases&label=release)](https://github.com/FengHaPi/BarelyWorks/releases)

> **📦 [Releases and source downloads](https://github.com/FengHaPi/BarelyWorks/releases)**

BarelyWorks turns story material into a traceable nine-stage video production workflow. It is deliberately not a black box that accepts one sentence and silently spends money on generation. Instead, it keeps every outline, screenplay, asset definition, shooting script, storyboard, generation handoff, review result, and delivery decision visible and versioned.

Text-stage artifacts are produced through real Codex CLI runs guided by versioned project Skills. Video generation remains human-controlled: the application compiles reviewable H3 / Updream handoff packages while paid video APIs stay disabled by default. Missing checks, provider failures, and unknown evidence are shown as unresolved—not reported as success.

> [!IMPORTANT]
> **v0.2.0 is an Alpha release.** It introduces independent artifact Heads, provenance links, a real project Agent, recoverable long-running Operations, an issue center, and cumulative verification that rechecks all applicable upstream evidence before later production stages.

## Why BarelyWorks

AI video workflows usually fail long before the final render: an upstream story error propagates, a character drifts between shots, reference-image intent disappears, or an unavailable checker is mistaken for a pass. BarelyWorks is designed to make those failures inspectable and repairable before expensive generation.

- **Versioned artifacts:** new revisions never silently overwrite the active Head or historical approvals.
- **Cumulative verification:** later stages revalidate upstream Heads, approvals, file hashes, schemas, provenance, coverage, and human evidence.
- **Explicit responsibility:** issues point to the earliest artifact that should be repaired, with evidence and dependency order.
- **Auditable AI runs:** model, Skill version and SHA-256, thread, usage, duration, and failure diagnostics are recorded.
- **Human approval gates:** approval, external submission, rough-cut creation, and final delivery require explicit actions.
- **Local-first privacy:** project content, SQLite data, reference images, generated media, deliveries, and logs stay outside Git.
- **No fake fallback:** an unavailable Codex/provider/checker fails visibly instead of returning canned output or a false pass.

## Release history

Public releases are preserved as independent tags and commits:

- **v0.1.0** — initial auditable AI video production workflow
- **v0.1.1** — local media pipeline and V1 release gates
- **v0.2.0** — Agent-first workspace, cumulative verification, and paid-generation safety refactor

Versions v0.1.2–v0.1.6 were internal development builds consolidated into v0.2.0 and were not published as separate releases. Current Alpha releases provide source archives only; a Windows installer or portable package is not available yet.

See the [release checklist](docs/release-process.md) for the version, tag, changelog, and Release consistency rules.

## What it can do

- Create, archive, restore, and inspect local video projects without discarding source material or history.
- Maintain independent versions and Heads for outlines, screenplays, asset definitions, shooting scripts, and storyboards.
- Ask, compare, revise, and analyze the impact of explicit artifact versions through a real project Agent.
- Run long tasks as persistent Operations with progress events, idempotency, refresh recovery, failure stops, and cancellation.
- Build stable characters, locations, props, costumes, styles, and voice assets with IDs, versions, hashes, and shot references.
- Attach PNG/JPEG/WebP references to visual assets and assign roles such as primary, front, side, back, expression, or costume.
- Select T2VA when no reference exists and Ref2VA when validated role-aware references are available.
- Check duration capacity before outlining or screenwriting and block content that cannot reliably fit the target runtime.
- Validate camera plans, eye lines, visible surfaces, reflection topology, event gates, story beats, motion, and risk budgets.
- Compile compact H3 execution briefs and block handoffs that violate structure, character-budget, reference, or model-executability rules.
- Import provider-generated media, bind it to the exact generation version, and run a nine-dimension human quality review.
- Create local H.264/AAC rough cuts, subtitles, review reports, and downloadable delivery files after every current shot passes.
- Verify the local FFmpeg/ffprobe toolchain with synthetic media before relying on it for production work.

## Nine-stage workflow

```text
01 Source Input
  → 02 Story Outline
  → 03 Screenplay
  → 04 Asset Definitions
  → 05 Shooting Script
  → 06 Storyboard
  → 07 Video Generation
  → 08 Quality Review
  → 09 Edit & Export
```

Every critical stage stops at a human review gate. The workflow is not a one-way wizard: any artifact can be inspected and revised independently, and later stages recheck all applicable upstream artifacts and evidence.

## Current status

| Area | Status | Current result |
|---|---|---|
| Project history and migration | Complete | Incremental SQLite migration, immutable source files, independent Heads, provenance links, in-place compatibility, recoverable archives |
| Agent-first workspace | Complete | Three-column workspace, version selection, real project Agent, issue center, explicit production actions |
| Operation infrastructure | Complete | Persistent progress/events, idempotency, failure stops, refresh recovery, cancellation |
| Cumulative verification | Complete | Deterministic rules, model + Skill checks, and human approvals remain independent and visible |
| Assets and references | Complete | Role-aware visual references, T2VA/Ref2VA routing, server-side upload gates |
| Shooting script, storyboard, H3 | Complete | Physical plans, executability checks, continuity rechecks, compact briefs, stale-package detection |
| Import, QA, rough cut | Implemented locally | Synthetic-media validation covers import, keyframes, nine-dimension review, 1080p rough cuts, SRT, final review, and downloads; real provider footage still requires human visual acceptance |

The v0.2.0 release gate passed **154 server tests across 33 files, 47 UI tests across 14 files, and one real browser E2E**, together with TypeScript checks and production builds.

## Architecture

| Layer | Technology and responsibility |
|---|---|
| UI | React 19 + Vite; Agent-first workspace, issue center, production, QA, delivery |
| Local service | Fastify bound to `127.0.0.1); explicit command endpoints and persistent Operations |
| Data | SQLite + Drizzle; project files plus persisted Heads, provenance, approvals, issues, and operation events |
| Contracts | TypeScript + Zod + JSON Schema |
| Text intelligence | Local Codex CLI, versioned project `SKILL.md` routing, real project Agent |
| Verification | Deterministic evidence, model + Skill semantic checks, and human approval remain independent |
| Video handoff | MiniMax H3 preflight and reviewable Updream packages |
| Media | Portable FFmpeg 9.0.1 / ffprobe; libx264/AAC preflight and production rough-cut implementation |

## Quick start

### Requirements

- Windows 10 or 11
- Node.js 22.12.0 or newer
- npm
- A working Codex CLI installation
- FFmpeg / ffprobe for media import and rough-cut stages

### Development

```powershell
git clone https://github.com/FengHaPi/BarelyWorks.git
cd BarelyWorks
npm install
npm run dev
```

- UI: `http://127.0.0.1:5173`
- Local API: `http://127.0.0.1:4317`

### Build and run

```powershell
npm run check
npm start
```

The local service serves the production build at `http://127.0.0.1:4317`.

| Command | Purpose |
|---|---|
| `npm run dev` | Start the API and Vite development server |
| `npm run typecheck` | Run TypeScript type checks |
| `npm test` | Run server and UI Vitest suites |
| `npm run build` | Build the server and UI |
| `npm run check` | Version consistency, types, tests, production builds, and browser E2E |
| `npm run verify:media` | Validate probing, H.264/AAC rough cuts, and output parameters with synthetic clips |
| `npm run verify:phase5` | Validate import, nine-dimension QA, rough cuts, SRT, final review, and downloads |
| `npm run verify:v1` | Run the complete build, test, media, and Phase 5 release gate |
| `npm start` | Start the built local application |

## Versioned Skill routing

The repository contains 10 production Skills and 2 provider-specific Skills:

```text
ai-video-producer
├─ project-intake
├─ story-architect
├─ screenplay-writer
├─ asset-bible-builder
├─ asset-reference-prompt-writer
├─ shooting-script-director
├─ storyboard-director
├─ continuity-supervisor
└─ video-quality-reviewer

provider-skills
├─ h3-prompt-writing
└─ updream-handoff
```

Each text-generation run records the actual Skill name, version, SHA-256, schema version, and runtime diagnostics. The interface does not merely claim that a Skill was used.

## Data and safety boundaries

- The service listens only on local `127.0.0.1` by default.
- `.env`, SQLite files, project source material, references, generated videos, delivery files, and logs are excluded from Git.
- Paid video APIs are disabled by default; BarelyWorks does not automatically operate the Updream website.
- Approved artifacts gain new versions rather than losing history to overwrites.
- Failed or timed-out runs do not advance the project stage.
- Never commit cookies, tokens, API keys, or personal sign-in information.

## Repository layout

```text
src/                 Fastify service, workflow, data, and generation logic
ui/                  React local console
skills/              Versioned production Skills
provider-skills/     H3 and Updream provider Skills
templates/schemas/   Structured-output JSON Schemas
tests/               Contracts, persistence, workflow, and end-to-end tests
docs/                Environment evidence, release rules, backup policy, and capability notes
projects/             Local runtime projects; only .gitkeep is tracked
```

## Documentation

- [Changelog](CHANGELOG.md)
- [Release checklist](docs/release-process.md)
- [v0.2.0 release notes](docs/releases/v0.2.0.md)
- [Agent-first refactor and acceptance plan (Chinese)](docs/agent-first-refactor-plan.zh-CN.md)
- [Agent-first remediation audit (Chinese)](docs/agent-first-remediation-audit.zh-CN.md)
- [Environment and contract evidence](docs/phase-0-environment.md)
- [Local project and backup policy](docs/backup-policy.md)
- [Local media toolchain](docs/media-toolchain.md)
- [V1 acceptance status](docs/v1-acceptance.md)
- [Updream capability checklist](docs/updream-capability-checklist.md)

## Contributing and security

- Use [Issues](https://github.com/FengHaPi/BarelyWorks/issues) for bugs and feature requests.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `npm run check` before submitting code.
- Do not disclose vulnerabilities in public Issues; follow [SECURITY.md](SECURITY.md) for private reporting.

## Known limitations

- BarelyWorks is currently a Windows-only, local, single-user Alpha.
- Real provider footage still requires human visual acceptance even though the synthetic-media import and rough-cut pipeline is verified.
- Updream is treated as a manual generation endpoint; the project does not depend on unverified private APIs or browser automation.
- H3 prompt structure is validated, but visual quality must be judged from actual generated footage.
- No paid video API is called automatically.
- A Windows installer or portable binary is not available yet.

## License

[MIT](LICENSE) © 2026 风诀
