# PROJECT_MEMORY.md

This file stores stable project facts future agents should reuse. Do not paste run logs, prompts, terminal output, or one-off debugging notes here.

## Project Identity

- Name: SoloSync
- Type: VS Code developer backup extension
- Users: Developers who need recoverable snapshots for committed and uncommitted workspace changes, especially AI-assisted coding work.
- Current stage: Version `0.0.2` released to Visual Studio Marketplace and Open VSX with the corrected full-color marketplace icon.
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
- Native Google Drive OAuth, SFTP, WebDAV, encryption, and incremental content-addressed storage are later milestones documented in `docs/product-design.md`.

## Verification

- Default CI: `.github/workflows/ci.yml`
- Default security checks: `.github/workflows/security.yml`
- Marketplace publishing: `.github/workflows/publish.yml`
- Local release gate: `npm test && npm audit --audit-level=high && npx @vscode/vsce package`

## Handoff Notes

- `SZLK.solosync@0.0.2` is publicly verified on Visual Studio Marketplace and Open VSX; icon rendering is generated with resvg and protected by a pixel-level regression test.
- Continue from `/home/ubuntu/project/solosync`; do not recreate the project under `.solomap-global/memory/inbox`.
