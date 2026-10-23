export type GoogleAuthMode = 'desktop' | 'hosted';

export function googleAuthMode(environment: { uiKind: 'desktop' | 'web'; remoteName?: string }): GoogleAuthMode {
  return environment.uiKind === 'desktop' && !environment.remoteName ? 'desktop' : 'hosted';
}

export function shouldRequestGoogleSignIn(backupReason: string): boolean {
  return backupReason === 'Manual backup';
}
