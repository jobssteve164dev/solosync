# SoloSync

SoloSync protects the code that Git has not protected yet. It creates restorable workspace snapshots in a local folder or a NAS share you already mounted on your computer.

## What the first release does

- Creates a snapshot manually from the Command Palette, Explorer, status bar, or SoloSync sidebar.
- Automatically creates a snapshot after the current Git commit changes.
- Creates an idle snapshot after workspace files stop changing.
- Keeps Git branch, commit, message, and dirty-state context with every snapshot.
- Shows snapshot history inside VS Code.
- Restores a whole snapshot into a new folder without overwriting the current workspace.
- Restores one selected file to a location you choose.
- Verifies every restored snapshot with SHA-256 hashes.
- Supports multi-root workspaces.

SoloSync never synchronizes remote deletions back into your workspace. The first release also never deletes old snapshots automatically.

## Start protecting a project

1. Open a local project folder in VS Code.
2. Run **SoloSync: Choose Backup Location**.
3. Choose a local folder, mounted QNAP share, or another mounted NAS folder.
4. Run **SoloSync: Back Up Now**.

Future snapshots appear in the SoloSync activity bar. Git commit backups are enabled by default. Idle backups default to ten minutes and can be changed in VS Code Settings.

## Restoring safely

Open **SoloSync → Backup History**, then use a snapshot's restore action. Full snapshots always restore into a newly created directory. SoloSync does not overwrite the open workspace.

Use **Restore File** when only one file is needed. You select the file from the snapshot and then choose its destination.

## What is stored

Snapshots use this structure inside your chosen location:

```text
SoloSync/<project-id>/snapshots/<snapshot-id>/
  manifest.json
  files/<workspace-root>/...
```

The manifest contains relative paths, file sizes, timestamps, SHA-256 hashes, and optional Git context. It does not store the original absolute workspace path.

## Defaults and exclusions

SoloSync skips symbolic links and excludes common generated directories including `.git`, `node_modules`, `dist`, `build`, `out`, `.next`, and `.cache`. You can change exclusions with the `solosync.exclude` setting.

Review whether secrets such as `.env` files should be present in your backup. Client-side encryption and native Google Drive/SFTP connections are planned but are not part of this first release.

## Storage support

The first release writes to a filesystem directory. This includes:

- A local external disk.
- A QNAP share mounted with SMB or another operating-system-supported protocol.
- A locally synchronized Google Drive directory.

Native Google Drive OAuth, QNAP SFTP, and WebDAV adapters are the next storage milestone. See [the product design](docs/product-design.md) for the full architecture and roadmap.

## Development

```bash
npm ci
npm test
npm run package
```

The packaged VSIX can be installed through **Extensions → … → Install from VSIX**.

## Privacy and security

- Workspace contents are written only to the folder you choose.
- SoloSync does not operate a cloud service or receive your source code.
- Snapshot verification uses SHA-256.
- Full restore is non-destructive by default.

## License

MIT
