import type { BackupLocationKind } from './backupLocation';

export type BackupSettingsAction = 'location' | 'qnapConnection' | 'googleConnection' | 'pendingBackup' | 'sensitiveFiles' | 'commitTiming' | 'idleTiming' | 'exclusions';

export interface BackupSettingsOption {
  action: BackupSettingsAction;
  label: string;
  description: string;
  detail: string;
}

interface BackupSettingsState {
  kind?: BackupLocationKind;
  kindLabel?: string;
  destination?: string;
  qnapUsername?: string;
  googleAccount?: string;
  googleConnected?: boolean;
  qnapPasswordSaved: boolean;
  backupAfterCommit: boolean;
  idleBackupMinutes: number;
  exclusionCount: number;
  sensitiveDecisionCount?: number;
  pendingBackup?: { state: string; occupiedBytes: number; createdAt: string };
}

export function buildBackupSettingsOptions(state: BackupSettingsState): BackupSettingsOption[] {
  const locationDescription = state.kind
    ? `${state.kindLabel}${state.destination ? ` · ${state.destination}` : ''}`
    : 'Not selected';
  const options: BackupSettingsOption[] = [
    {
      action: 'location',
      label: '$(folder-opened) Backup location',
      description: locationDescription,
      detail: 'Choose where SoloSync stores snapshots.',
    },
  ];
  if (state.kind === 'qnap' && state.destination && state.qnapUsername) {
    options.push({
      action: 'qnapConnection',
      label: '$(lock) QNAP connection and sign-in',
      description: state.destination,
      detail: `Account: ${state.qnapUsername} · ${state.qnapPasswordSaved ? 'Password saved in VS Code secure storage' : 'Password needs to be entered'} · Basic or Digest selected automatically`,
    });
  } else if (state.kind === 'googleDrive') {
    options[0].detail = 'SoloSync stores snapshots in the SoloSync Backups folder in Google Drive.';
    options.push({
      action: 'googleConnection',
      label: '$(cloud) Google Drive connection',
      description: state.googleConnected === false ? 'Sign in again' : state.googleAccount ?? 'Connected',
      detail: state.googleConnected === false
        ? 'Your saved connection has expired. Open this setting to sign in again.'
        : 'Connected · Sign out or revoke access from the command menu.',
    });
    if ((state.sensitiveDecisionCount ?? 0) > 0) {
      options.push({
        action: 'sensitiveFiles',
        label: '$(shield) Sensitive file choices',
        description: `${state.sensitiveDecisionCount} remembered choices`,
        detail: 'Clear these choices to review the files again before the next Google Drive backup.',
      });
    }
  } else if (state.kind === 'nas') {
    options[0].detail = 'SoloSync writes to this mounted folder. Your operating system manages the NAS connection and sign-in.';
  }
  if (state.pendingBackup) {
    const size = state.pendingBackup.occupiedBytes < 1024 * 1024
      ? `${(state.pendingBackup.occupiedBytes / 1024).toFixed(1)} KB`
      : `${(state.pendingBackup.occupiedBytes / (1024 * 1024)).toFixed(1)} MB`;
    const status = state.pendingBackup.state === 'publishing' ? 'Finishing' : state.pendingBackup.state === 'verified' ? 'Checked' : 'Ready to continue';
    options.push({
      action: 'pendingBackup',
      label: '$(sync) Pending Google Drive backup',
      description: `${size} · ${status}`,
      detail: 'Open to reconnect its Google account, then continue or abandon this frozen backup safely.',
    });
  }
  options.push(
    {
      action: 'commitTiming',
      label: '$(git-commit) Back up after Git commits',
      description: state.backupAfterCommit ? 'On' : 'Off',
      detail: 'Open this setting in VS Code Settings.',
    },
    {
      action: 'idleTiming',
      label: '$(watch) Back up when idle',
      description: state.idleBackupMinutes > 0 ? `${state.idleBackupMinutes} minutes` : 'Off',
      detail: 'Open this setting in VS Code Settings.',
    },
    {
      action: 'exclusions',
      label: '$(exclude) Excluded files and folders',
      description: `${state.exclusionCount} rules`,
      detail: 'Open this setting in VS Code Settings.',
    },
  );
  return options;
}
