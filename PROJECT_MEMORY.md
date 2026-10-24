# PROJECT_MEMORY.md

This file stores stable project facts future agents should reuse. Do not paste run logs, prompts, terminal output, or one-off debugging notes here.

## Project Identity

- Name: SoloSync
- Type: VS Code developer backup extension
- Users: Developers who need recoverable snapshots for committed and uncommitted workspace changes, especially AI-assisted coding work.
- Current stage: Version `0.0.16` is published, making the Google Drive backup-file browser recover cleanly when an open VS Code window still holds the previous extension manifest.
- Canonical local path: `/home/ubuntu/project/solosync`
- Repository: `https://github.com/jobssteve164dev/solosync`

## Stable Decisions

- SoloSync is versioned backup, not bidirectional file synchronization.
- Full restore writes to a new directory and does not overwrite the open workspace.
- Storage backends share one snapshot repository contract. The production backends are filesystem directories, native QNAP HTTPS/WebDAV connections, and Google Drive.
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
- Native Google Drive uses `drive.file`, resumable direct uploads, and PKCE. Desktop VS Code uses a loopback callback; browser-hosted VS Code uses the HTTPS broker at `solosync.szlk.uk`, which returns an encrypted opaque credential and never proxies backup contents.
- New format-2 snapshots store one verified object per distinct SHA-256 under the project. On Google Drive, manifests are timestamped records inside one root-level `Backup History` folder rather than one physical folder plus `manifest.json` per automatic backup; older snapshot folders remain readable and restorable.
- Google Drive connections and resolved paths are cached for the extension session, small files use one multipart request, larger files use 8 MiB resumable chunks, and successful backup completion updates the in-memory history instead of rereading every historical manifest.
- Google Drive keeps immutable SHA-256-addressed restore objects in `Backup History/Previous File Versions`. Object integrity is reconciled in one paginated metadata listing using Drive's SHA-256 checksum.
- Each source path has a separate readable current file under mirrored workspace-relative directories in its project folder. Single-root projects start directly at the root-relative path; multi-root projects retain named root folders. Source identity still includes root name, so layout migration preserves stable Drive file IDs. Changes update that ID in place with `files.update` only after snapshot publication; same-basename and same-content paths remain independently visible. A latest-committed snapshot gate skips known-stale runs, and a post-write reconciliation rebuilds the current view from immutable history if a newer snapshot commits while an older replacement is already in flight. Version 0.0.12 objects left in the project folder migrate into immutable history. The redundant single-root directory created by 0.0.13 moves to `Backup History` as an archived previous layout on the next backup, preserving any extra contents rather than deleting the directory.
- The native **Backup Files** sidebar view lists only SoloSync-managed Google Drive current copies, grouped as project/folder/file. It loads three paginated metadata queries concurrently on first view or explicit refresh, performs no background polling, restores from the latest committed snapshot, and opens the readable current Drive item by stable ID. Resolving the latest current-format manifest uses a fixed three requests regardless of history length; legacy folder snapshots use four.
- The measured single-page Drive request ceilings are 26 for the first connected empty backup, 23 for one changed small file on an active connection, 12 for an unchanged snapshot, and 22 for reconnect plus unchanged backup. Updating an established visible file stays within 15 requests; changing back to retained content stays within 12. A 100-ID reservation pool amortizes occasional refills.
- The same Cloudflare Worker serves the public SoloSync home page at `/`, privacy policy at `/privacy`, terms at `/terms`, PNG application logo at `/icon.png`, and OAuth callback at `/oauth/google/callback`.
- Client-side encryption and retention remain later milestones documented in `docs/product-design.md`.

## Verification

- Default CI: `.github/workflows/ci.yml`
- Default security checks: `.github/workflows/security.yml`
- Marketplace publishing: `.github/workflows/publish.yml`
- Local release gate: `npm test && npm audit --audit-level=high && npx @vscode/vsce package`

## Handoff Notes

- `SZLK.solosync@0.0.16` is published on Visual Studio Marketplace and Open VSX; GitHub Release `v0.0.16` contains the same packaged VSIX bytes. It adds an upgrade-manifest guard so an already-open host receives a reload action instead of the raw `No view is registered` error, while a fresh host registers both sidebar views normally.
- `0.0.6` has mock-WebDAV coverage for Basic and Digest authentication, capability probing, verified publish, discovery, restore, corruption rejection, cancellation, and staging cleanup. A real QNAP connection is intentionally pending the next session and must be validated before calling native QNAP support production-verified.
- `SZLK.solosync@0.0.6` is publicly verified on Visual Studio Marketplace and Open VSX; its GitHub Release contains the same packaged VSIX bytes. It adds native QNAP HTTPS/WebDAV support, but real-device validation is still pending.
- `SZLK.solosync@0.0.4` is publicly verified on Visual Studio Marketplace and Open VSX; its GitHub Release contains the packaged VSIX.
- `0.0.4` allows a dedicated backup folder inside a broader VS Code workspace and excludes that folder from snapshot scans and idle-backup triggers; only choosing an actual workspace root itself remains blocked.
- `0.0.3` added sidebar setup and settings entry points, guided Google Drive desktop-folder / mounted NAS / local-drive choices, location availability validation, and recoverable empty states.
- `0.0.7` added native Google Drive backup, a visible `SoloSync Backups` folder, direct resumable transfers, verified restore, and one connection flow across desktop and browser-hosted VS Code.
- Icon rendering is generated with resvg and protected by a pixel-level regression test.
- Continue from `/home/ubuntu/project/solosync`; do not recreate the project under `.solomap-global/memory/inbox`.
