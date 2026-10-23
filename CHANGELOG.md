# Changelog

## 0.0.15

- Add a **Backup Files** view to the SoloSync sidebar for browsing current Google Drive backups by project, folder, and file.
- Restore a selected file directly from its latest completed snapshot or open its readable current copy in Google Drive.
- Load the complete current-file index in three parallel paginated Drive queries only when the view is opened or refreshed; no polling or broader Drive permission is added.
- Resolve the latest completed snapshot in a fixed three Drive requests for current-format backups, regardless of history length; legacy folder snapshots remain supported in four requests.

## 0.0.14

- Remove the redundant workspace-root folder from the readable Google Drive layout when a project has one backup root.
- Move existing v0.0.13 current files out of that redundant folder without changing their Drive file IDs, then preserve the old folder and any extra contents inside `Backup History`.
- Keep named root folders for multi-root projects so equal relative paths remain distinct.

## 0.0.13

- Replace the visible Google Drive file when the same source path changes instead of leaving multiple current files with the same name.
- Keep immutable restore contents inside the single `Backup History/Previous File Versions` folder while updating a separate, stable current-file ID in place.
- Mirror workspace-relative directories so distinct source paths stay separate even when they share a name or identical bytes, and migrate the duplicate visible objects created by 0.0.12 into file history.
- Update the readable current view only after snapshot publication, and converge it back to the newest committed snapshot when connected clients finish overlapping replacements out of order.
- Preserve the sub-30-request target with at most 23 Drive requests for a changed small-file snapshot in the single-page test model.

## 0.0.12

- Keep each Google Drive content object's original file name and extension visible while retaining SHA-256 as its stable incremental identity.
- Rename legacy hash-named objects when they are reused, without uploading their contents again.
- Store new Google Drive snapshots as timestamped records in one stable Backup History folder instead of creating a folder and `manifest.json` for every automatic backup; older snapshot folders remain restorable.
- Keep the measured Google Drive path within 21 requests for the first connected empty backup, 8 for one changed small file, 6 for an unchanged snapshot, and 14 for reconnect plus unchanged backup, including checks that recover late writes from another still-open window.
- Replace per-file lookup and download verification with one paginated object listing and Drive's server-provided SHA-256 metadata, while preserving upload and recovery verification.
- Batch 100 Drive ID reservations, reuse recent root validation, avoid duplicate fresh-snapshot probes, and skip unchanged project-name updates.

## 0.0.11

- Store new snapshots as complete manifests backed by stable SHA-256 content objects, so unchanged files are reused instead of copied into every snapshot folder.
- Keep all format-1 snapshots readable, verifiable, and restorable while publishing new snapshots in the incremental format.
- Cut the first small Google Drive snapshot path from 104 provider operations to a tested sub-30-request budget, reuse the active Drive connection, and avoid rereading all history after a successful backup.
- Upload files up to 5 MiB in one multipart request and increase resumable chunks from 256 KiB to 8 MiB for larger changes.
- Show real scanning, copying, uploading, verification, publication, and elapsed-time phases in the progress notification and **SoloSync: Show Backup Logs**.
- Reconcile lost Drive responses and concurrent first-time folder creation, and repair damaged content objects before a new snapshot is published.

## 0.0.10

- Fix hosted Google Drive sign-in on Cloudflare Workers by invoking the runtime `fetch` function without an invalid object receiver.
- Preserve specific, safe errors for Google token network and response failures instead of masking them as a generic authorization outage.
- Verify the deployed callback and Google token exchange path during every automatic release.

## 0.0.9

- Make the public home page explicitly identify SoloSync as a VS Code backup and restore extension, explain why Google sign-in is optional, and confirm that the site is viewable without signing in.
- Expand the privacy policy with complete data collection, use, infrastructure processing, retention, deletion, AI-use, and prohibited-content boundaries for Google verification.
- Publish the official square PNG application logo at `https://solosync.szlk.uk/icon.png` for the Google OAuth consent screen.

## 0.0.8

- Publish a dedicated SoloSync home page, privacy policy, and terms of service at `solosync.szlk.uk`.
- Explain the exact Google Drive data path, `drive.file` permission, credential storage, retention controls, and readable-backup boundary.
- Keep the public legal pages on the same domain as the Google OAuth callback.

## 0.0.7

- Connect Google Drive directly with browser-based Google sign-in and the least-privilege `drive.file` permission; no local sync folder is required.
- Support local VS Code, Remote SSH, Dev Containers, Coder, and code-server through one Google Drive connection experience.
- Upload backups directly to Google Drive with resumable 256 KiB chunks, saved upload sessions, server-confirmed resume offsets, and streamed SHA-256 verification.
- Keep Google credentials in VS Code secure storage; the hosted callback returns an opaque credential and never proxies backup contents.
- Detect common secret-bearing files before cloud backup, recommend excluding them, remember exact per-project choices, and allow those choices to be cleared.
- Automatically create and use a visible `SoloSync Backups` folder while keeping incomplete snapshots out of backup history.
- Resume an interrupted backup from its protected local copy, expose its actual disk use, and let the user continue or safely abandon it.
- Preserve the same Drive folder after it is moved, request sign-in again when authorization expires, and clear unfinished upload credentials on disconnect.

## 0.0.6

- Connect directly to a QNAP shared folder through its HTTPS address, with Basic or Digest authentication and credentials kept in VS Code secure storage.
- Verify WebDAV read, write, move, and cleanup capabilities before saving a QNAP connection.
- Build each snapshot locally, verify every uploaded file, and publish remote history only after the complete snapshot passes SHA-256 checks.
- Browse projects and restore verified snapshots from the backup location without requiring the original project folder or computer.
- Keep existing local, mounted NAS, and synchronized-folder backups compatible with the new storage layer.

## 0.0.5

- Require an explicit project-folder selection and never fall back to a broader VS Code workspace.
- Show scanning and copying progress with a native Cancel button.
- Remove the current staging snapshot when a backup is canceled or fails, without publishing it.
- Ignore file changes outside the selected project and add `.pnpm-store` to the default exclusions.

## 0.0.4

- Allow dedicated backup folders inside a broader VS Code workspace while excluding them from snapshot scans and idle-backup triggers.
- Only reject the open workspace directory itself as a backup destination.

## 0.0.3

- Add a visible backup-location setup entry and Settings button to the SoloSync sidebar.
- Add guided Google Drive, mounted NAS, and local/external drive setup using one reliable folder-based workflow.
- Add first-run, ready, and unavailable-location states with direct recovery actions.
- Validate that a backup location exists, is readable and writable, and sits outside the open workspace before saving or backing up.

## 0.0.2

- Fix the marketplace icon rendering so the intended blue-purple background and white cloud mark are preserved.
- Add automated SVG rendering and pixel-level regression coverage to prevent monochrome icon releases.

## 0.0.1

- Create manual, Git-commit, and idle workspace snapshots.
- Store snapshots in a local or mounted NAS folder.
- Browse history, verify integrity, and safely restore projects or individual files.
