# SoloSync

SoloSync protects the code that Git has not protected yet. It creates restorable snapshots of the project folder you choose on a directly connected QNAP NAS, a local folder, or a NAS share already mounted on your computer.

## What the first release does

- Creates a snapshot manually from the Command Palette, Explorer, status bar, or SoloSync sidebar.
- Automatically creates a snapshot after the current Git commit changes.
- Creates an idle snapshot after workspace files stop changing.
- Keeps Git branch, commit, message, and dirty-state context with every snapshot.
- Shows snapshot history inside VS Code.
- Restores a whole snapshot into a new folder without overwriting the current workspace.
- Restores one selected file to a location you choose.
- Verifies every restored snapshot with SHA-256 hashes.
- Backs up only the project folder you explicitly choose, even when VS Code has a broader parent folder open.
- Shows scanning and copying progress with a Cancel button that discards the incomplete snapshot.

SoloSync never synchronizes remote deletions back into your workspace. The first release also never deletes old snapshots automatically.

## Start protecting a project

1. Open the SoloSync sidebar and run **SoloSync: Setup**.
2. Choose the project folder you want SoloSync to protect.
3. Choose QNAP NAS, a local folder, a mounted NAS share, or a Google Drive desktop folder for snapshots.
4. Run **SoloSync: Back Up Now**. The progress notification can cancel an incorrect or unexpectedly large backup.

The sidebar Setup button keeps the two choices separate: **Project folder** is what SoloSync backs up, while **Backup location** is where snapshots are stored. A QNAP can be connected directly with the HTTPS address of a WebDAV-enabled shared folder. Google Drive must already be signed in and synchronized by Google Drive for desktop, and other NAS shares must already be mounted by your operating system. SoloSync checks that the selected location is available and writable. A mounted backup folder inside the selected project is automatically excluded from snapshots.

Backup Settings keeps the destination, QNAP HTTPS address and secure sign-in, backup timing, and exclusions in one entry point. QNAP passwords remain hidden in VS Code secure storage rather than appearing in `settings.json`. The sidebar shows the selected project, storage type, and destination folder, and provides recovery actions if either location becomes unavailable.

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

Review whether secrets such as `.env` files should be present in your backup. QNAP transfers use HTTPS, but snapshots are readable on the NAS because client-side encryption is not part of this release.

## Storage support

SoloSync supports:

- A QNAP shared folder connected directly over HTTPS.
- A local external disk.
- A NAS share mounted with SMB or another operating-system-supported protocol.
- A locally synchronized Google Drive directory.

### Connect QNAP NAS

1. On the NAS, create a dedicated shared folder and a non-administrator account that can read and write only that folder.
2. In QTS, open **Control Panel → Network & File Services → Win/Mac/NFS/WebDAV → WebDAV**, enable WebDAV, and use HTTPS.
3. Make the shared folder available through a trusted HTTPS address. A private VPN address is preferred; do not expose QTS, SMB, or SSH just for SoloSync.
4. In SoloSync, choose **Backup location → QNAP NAS** and enter the complete shared-folder address, username, and password.

SoloSync tests the connection by creating, reading, moving, and removing one temporary test folder. The password is kept in VS Code secure storage. A backup is reported as protected only after every uploaded file has been read back and verified, and the completed snapshot appears in remote history.

Use **SoloSync: Browse and Restore Backups** to recover a project even when its original folder or computer is unavailable. See the [QNAP implementation and security design](docs/qnap-webdav-design.md) for supported gateway and authentication boundaries.

Native Google Drive OAuth and client-side encryption remain future storage milestones. See the [native Google Drive connection design](docs/google-drive-native-design.md) and [product design](docs/product-design.md) for the implementation contract and roadmap.

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
