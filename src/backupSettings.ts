import type { BackupLocationKind } from './backupLocation';

export type BackupSettingsAction = 'location' | 'qnapConnection' | 'commitTiming' | 'idleTiming' | 'exclusions';

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
  qnapPasswordSaved: boolean;
  backupAfterCommit: boolean;
  idleBackupMinutes: number;
  exclusionCount: number;
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
    options[0].detail = 'SoloSync writes to this folder. Google Drive for desktop manages transfer and sign-in.';
  } else if (state.kind === 'nas') {
    options[0].detail = 'SoloSync writes to this mounted folder. Your operating system manages the NAS connection and sign-in.';
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
