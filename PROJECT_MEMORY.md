# PROJECT_MEMORY.md

This file stores stable project facts future agents should reuse. Do not paste run logs, prompts, terminal output, or one-off debugging notes here.

## Project Identity

- Name: SoloSync
- Type: VS Code developer backup extension
- Users: Developers who need recoverable snapshots for committed and uncommitted workspace changes, especially AI-assisted coding work.
- Current stage: Version `0.0.5` requires an explicit project source folder and adds cancellable, observable backups with precise staging cleanup.
- Canonical local path: `/home/ubuntu/project/solosync`
- Repository: `https://github.com/jobssteve164dev/solosync`

## Stable Decisions

- SoloSync is versioned backup, not bidirectional file synchronization.
- Full restore writes to a new directory and does not overwrite the open workspace.
- The first storage backend is a filesystem directory, covering local disks and operating-system-mounted NAS shares.
- Marketplace credentials are stored as encrypted GitHub Actions Secrets in the SoloSync repository so the project publishes independently.

## Architecture Boundaries

- Snapshot creation, listing, verification, and restore live in `src/snapshotRepository.ts`.
- Git state and commit-trigger classification live in `src/git.ts`.
- VS Code lifecycle, commands, automatic triggers, and user interaction are composed in `src/extension.ts`.
- The backup source is the single project folder explicitly selected by the user; SoloSync does not infer or fall back to the VS Code workspace root.
- Snapshot scanning and copying accept cancellation and report progress. Cancellation or failure removes only the staging directory created by that run and never publishes it as a snapshot.
- Native Google Drive OAuth, SFTP, WebDAV, encryption, and incremental content-addressed storage are later milestones documented in `docs/product-design.md`.

## Verification

- Default CI: `.github/workflows/ci.yml`
- Default security checks: `.github/workflows/security.yml`
- Marketplace publishing: `.github/workflows/publish.yml`
- Local release gate: `npm test && npm audit --audit-level=high && npx @vscode/vsce package`

## Handoff Notes

- `SZLK.solosync@0.0.5` is publicly verified on Visual Studio Marketplace and Open VSX; its GitHub Release contains the packaged VSIX. It requires explicit project selection and provides observable, cancellable backups with precise staging cleanup.
- `SZLK.solosync@0.0.4` is publicly verified on Visual Studio Marketplace and Open VSX; its GitHub Release contains the packaged VSIX.
- `0.0.4` allows a dedicated backup folder inside a broader VS Code workspace and excludes that folder from snapshot scans and idle-backup triggers; only choosing an actual workspace root itself remains blocked.
- `0.0.3` added sidebar setup and settings entry points, guided Google Drive desktop-folder / mounted NAS / local-drive choices, location availability validation, and recoverable empty states.
- Native Google Drive OAuth and direct NAS credentials are still not implemented; `0.0.3` keeps the production filesystem-backend boundary and requires Drive desktop sync or an operating-system-mounted NAS share.
- Icon rendering is generated with resvg and protected by a pixel-level regression test.
- Continue from `/home/ubuntu/project/solosync`; do not recreate the project under `.solomap-global/memory/inbox`.
