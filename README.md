# SoloSync

SoloSync protects the code that Git has not protected yet. It creates restorable snapshots of the project folder you choose in Google Drive, on a directly connected QNAP NAS, or in a local or mounted folder.

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
- Reuses unchanged file contents across snapshots instead of uploading another complete directory tree.
- Records connection time, each scanning/copying/upload/verification/publication phase duration, and total elapsed time in **SoloSync: Show Backup Logs** without writing file contents, local paths, credentials, or raw provider errors to the log.

SoloSync never synchronizes remote deletions back into your workspace. The first release also never deletes old snapshots automatically.

## Start protecting a project

1. Open the SoloSync sidebar and run **SoloSync: Setup**.
2. Choose the project folder you want SoloSync to protect.
3. Choose Google Drive, QNAP NAS, a local folder, or a mounted NAS share for snapshots.
4. Run **SoloSync: Back Up Now**. The progress notification can cancel an incorrect or unexpectedly large backup.

The sidebar Setup button keeps the two choices separate: **Project folder** is what SoloSync backs up, while **Backup location** is where snapshots are stored. Google Drive opens its normal browser sign-in and then uses the visible `SoloSync Backups` folder; no desktop sync folder is required. A QNAP can be connected directly with the HTTPS address of a WebDAV-enabled shared folder. Other NAS shares must already be mounted by your operating system. SoloSync checks that the selected location is available and writable. A mounted backup folder inside the selected project is automatically excluded from snapshots.

Backup Settings keeps the destination, QNAP HTTPS address and secure sign-in, backup timing, and exclusions in one entry point. QNAP passwords remain hidden in VS Code secure storage rather than appearing in `settings.json`. The sidebar shows the selected project, storage type, and destination folder, and provides recovery actions if either location becomes unavailable.

Future snapshots appear in the SoloSync activity bar. Git commit backups are enabled by default. Idle backups default to ten minutes and can be changed in VS Code Settings.

## Restoring safely

Open **SoloSync → Backup History**, then use a snapshot's restore action. Full snapshots always restore into a newly created directory. SoloSync does not overwrite the open workspace.

Use **Restore File** when only one file is needed. You select the file from the snapshot and then choose its destination.

## What is stored

Local folders and QNAP use the logical snapshot structure below:

```text
SoloSync/<project-id>/
  objects/<sha256>                 # one verified copy of each distinct file content
  snapshots/<snapshot-id>/
    manifest.json                  # the complete restorable file list for this point in time
```

Each snapshot is logically complete, but its unchanged bytes are not copied again. The manifest maps every relative project path to a stable SHA-256 content object, so old and new snapshots remain independently restorable while a repeated unchanged snapshot uploads only its manifest. Snapshots created by older SoloSync versions with files inside each snapshot remain readable and restorable. The manifest never stores the original absolute workspace path.

Google Drive keeps the same logical model without creating a folder and a file named `manifest.json` for every automatic backup:

```text
SoloSync Backups/
  Backup History/
    <snapshot-time-and-id>.json    # compact records for every project
  <project-name>/
    <original-file-name.ext>       # one verified copy of each distinct content
```

The single **Backup History** folder contains the small records SoloSync needs for restore. Project folders remain readable instead of filling with timestamp folders. SHA-256 remains each content object's internal identity, while its visible Drive name keeps the original file name and extension. Existing hash-named objects are renamed when the corresponding content is next reused; the bytes are not uploaded again. Older snapshot folders remain readable and restorable but new backups do not create them.

The tested Google Drive path uses at most 21 remote requests for the first empty backup including connection and first-time folder creation, 8 for an existing connected project with one changed small file, and 6 for an unchanged snapshot on the active connection. Reconnecting and then making an unchanged snapshot uses at most 14 requests in the same single-page model. The connection totals include parallel checks for earlier folders that another still-open SoloSync window may have written after a duplicate was merged. An occasional batched ID refill adds one request; SoloSync reserves 100 IDs at once so that refill is amortized. Unchanged objects are checked together using Drive's SHA-256 metadata instead of being downloaded one by one. Files up to 5 MiB use one multipart upload request; larger files retain resumable upload protection with 8 MiB chunks. Actual time for large or numerous changed files still depends on the bytes that must cross the network, and an object listing can require another request when it exceeds one Drive page.

## Defaults and exclusions

SoloSync skips symbolic links and excludes common generated directories including `.git`, `node_modules`, `dist`, `build`, `out`, `.next`, and `.cache`. You can change exclusions with the `solosync.exclude` setting.

Before the first Google Drive upload, SoloSync detects common secret-bearing files such as `.env`, PEM keys, and `id_rsa*`, then lets you exclude them or remember an explicit include choice. You can clear those remembered choices in **SoloSync: Backup Settings**. Transfers use HTTPS, but snapshots remain readable at the chosen destination because client-side encryption is not part of this release.

## Storage support

SoloSync supports:

- A QNAP shared folder connected directly over HTTPS.
- A local external disk.
- A NAS share mounted with SMB or another operating-system-supported protocol.
- Google Drive through native browser sign-in and the Drive API, including browser-based Coder/code-server and remote VS Code environments.

### Connect Google Drive

1. Choose **Backup location → Google Drive**.
2. Complete Google sign-in in your browser. Local desktop VS Code returns automatically; browser and remote environments show a one-time SoloSync code to paste back into the connection prompt.
3. SoloSync creates or finds `SoloSync Backups`, verifies the connection, and shows the connected Google account.

SoloSync requests only `drive.file`, so it can manage files it creates without receiving access to the rest of your Drive. The authorization service handles the fixed HTTPS callback needed by browser and remote environments; backup file contents still transfer directly between the extension and Google Drive and are not sent through that service. Disconnecting keeps existing backups. Revoking access also keeps backups but requires every installation using that Google authorization to sign in again.

The public [SoloSync home page](https://solosync.szlk.uk/), [privacy policy](https://solosync.szlk.uk/privacy), and [terms of service](https://solosync.szlk.uk/terms) describe the same Google data path and readable-backup boundary shown in the extension. The official square [application logo](https://solosync.szlk.uk/icon.png) is available as a PNG for the Google OAuth consent screen.

### Connect QNAP NAS

1. On the NAS, create a dedicated shared folder and a non-administrator account that can read and write only that folder.
2. In QTS, open **Control Panel → Network & File Services → Win/Mac/NFS/WebDAV → WebDAV**, enable WebDAV, and use HTTPS.
3. Make the shared folder available through a trusted HTTPS address. A private VPN address is preferred; do not expose QTS, SMB, or SSH just for SoloSync.
4. In SoloSync, choose **Backup location → QNAP NAS** and enter the complete shared-folder address, username, and password.

SoloSync tests the connection by creating, reading, moving, and removing one temporary test folder. The password is kept in VS Code secure storage. A backup is reported as protected only after every uploaded file has been read back and verified, and the completed snapshot appears in remote history.

Use **SoloSync: Browse and Restore Backups** to recover a project even when its original folder or computer is unavailable. See the [QNAP implementation and security design](docs/qnap-webdav-design.md) for supported gateway and authentication boundaries.

See the [native Google Drive connection design](docs/google-drive-native-design.md) and [product design](docs/product-design.md) for the storage and security model.

## Development

```bash
npm ci
npm test
npm run package
```

The packaged VSIX can be installed through **Extensions → … → Install from VSIX**.

## Privacy and security

- Workspace contents are written only to the destination you choose.
- The small SoloSync authorization service exchanges and refreshes Google credentials for browser and remote environments. It does not receive backup file names or contents; Drive uploads and downloads go directly to Google.
- Snapshot verification uses SHA-256.
- Full restore is non-destructive by default.

## License

MIT
