# PROJECT_MEMORY.md

This file stores stable project facts future agents should reuse. Do not paste run logs, prompts, terminal output, or one-off debugging notes here.

## Project Identity

- Name: SoloSync
- Type: VS Code developer backup extension
- Users: Developers who need recoverable snapshots for committed and uncommitted workspace changes, especially AI-assisted coding work.
- Current stage: Version `0.0.6` adds native QNAP backup over HTTPS while preserving local and mounted-folder storage.
- Canonical local path: `/home/ubuntu/project/solosync`
- Repository: `https://github.com/jobssteve164dev/solosync`

## Stable Decisions

- SoloSync is versioned backup, not bidirectional file synchronization.
- Full restore writes to a new directory and does not overwrite the open workspace.
- Storage backends share one snapshot repository contract. The production backends are filesystem directories and native QNAP HTTPS/WebDAV connections.
- QNAP credentials use a dedicated least-privilege NAS account. The password is stored in VS Code SecretStorage and is never written to extension settings or snapshot manifests.
- Marketplace credentials are stored as encrypted GitHub Actions Secrets in the SoloSync repository so the project publishes independently.
- A push to `main` automatically publishes an unreleased `package.json` version to Visual Studio Marketplace and Open VSX, then creates the matching tag and GitHub Release. Existing complete releases are skipped, while interrupted draft or missing-asset releases resume from the frozen release commit.

## Architecture Boundaries

- Snapshot creation, listing, verification, and restore live in `src/snapshotRepository.ts`.
- Storage-provider operations and QNAP WebDAV protocol handling live in `src/storageProvider.ts`.
- Git state and commit-trigger classification live in `src/git.ts`.
- VS Code lifecycle, commands, automatic triggers, and user interaction are composed in `src/extension.ts`.
- The backup source is the single project folder explicitly selected by the user; SoloSync does not infer or fall back to the VS Code workspace root.
- Snapshot scanning and copying accept cancellation and report progress. Cancellation or failure removes only the staging directory created by that run and never publishes it as a snapshot.
- Native QNAP backups stage files locally, upload into a remote staging directory, read every file back for SHA-256 verification, then publish with WebDAV MOVE. Discovery and restore work without the original project folder.
- Native Google Drive OAuth, client-side encryption, retention, and incremental content-addressed storage remain later milestones documented in `docs/product-design.md`.

## Verification

- Default CI: `.github/workflows/ci.yml`
- Default security checks: `.github/workflows/security.yml`
- Marketplace publishing: `.github/workflows/publish.yml`
- Local release gate: `npm test && npm audit --audit-level=high && npx @vscode/vsce package`

## Handoff Notes

- `0.0.6` has mock-WebDAV coverage for Basic and Digest authentication, capability probing, verified publish, discovery, restore, corruption rejection, cancellation, and staging cleanup. A real QNAP connection is intentionally pending the next session and must be validated before calling native QNAP support production-verified.
- `SZLK.solosync@0.0.6` is publicly verified on Visual Studio Marketplace and Open VSX; its GitHub Release contains the same packaged VSIX bytes. It adds native QNAP HTTPS/WebDAV support, but real-device validation is still pending.
- `SZLK.solosync@0.0.4` is publicly verified on Visual Studio Marketplace and Open VSX; its GitHub Release contains the packaged VSIX.
- `0.0.4` allows a dedicated backup folder inside a broader VS Code workspace and excludes that folder from snapshot scans and idle-backup triggers; only choosing an actual workspace root itself remains blocked.
- `0.0.3` added sidebar setup and settings entry points, guided Google Drive desktop-folder / mounted NAS / local-drive choices, location availability validation, and recoverable empty states.
- Native Google Drive OAuth is still not implemented; Google Drive continues to require a synchronized desktop folder.
- Icon rendering is generated with resvg and protected by a pixel-level regression test.
- Continue from `/home/ubuntu/project/solosync`; do not recreate the project under `.solomap-global/memory/inbox`.
