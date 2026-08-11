# Changelog

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
