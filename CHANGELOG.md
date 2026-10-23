# Changelog

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
