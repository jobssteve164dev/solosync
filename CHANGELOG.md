# Changelog

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
