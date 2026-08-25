# Updream Handoff Output Contract

## Bootstrap package

```text
handoff/updream/bootstrap/
  characters/
  scenes/
  props/
  costumes/
  styles/
  audio/
  references/
  asset-index.json
  asset-index.html
  upload-checklist.md
```

`asset-index.json` contains `project_id`, `created_at`, `skill_provenance`, and an `assets` array. Every asset entry contains `asset_id`, `type`, `name`, `approval_status`, `upload_state`, `local_files`, and `packaged_files`.

## Shot package

```text
handoff/updream/shots/{shot_id}/vNNN/
  prompt.txt
  settings.json
  manifest.json
  upload-checklist.md
  reused-assets.md
  references/
```

`manifest.json` contains:

- `schema_version`
- `project_id`, `shot_id`, `package_version`, `created_at`
- `provider` fixed to `updream`
- `model` fixed to `MiniMax H3`
- `mode`: `T2VA`, `I2VA`, `FL2VA`, `L2VA`, or `Ref2VA`
- `requested_settings` without silent normalization
- `preflight` with `passed`, `errors`, and `warnings`
- `required_assets` and stable reference labels
- `packaged_files`
- `upload_state` fixed to `not-uploaded` when created
- provenance for both `h3-prompt-writing` and `updream-handoff`

## Upload state

Allowed states are `not-uploaded` and `uploaded`. Package creation always writes `not-uploaded`. Only an explicit user action may change the state to `uploaded`, and that action must store the timestamp separately from the immutable package manifest.
