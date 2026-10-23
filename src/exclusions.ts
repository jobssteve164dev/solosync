import path from 'node:path';

export function isExcludedPath(relativePath: string, name: string, excludes: string[]): boolean {
  const portablePath = relativePath.split(path.sep).join('/');
  const segments = portablePath.split('/');
  return excludes.some((rule) => {
    const portableRule = rule.replaceAll('\\', '/');
    if (portableRule.startsWith('*.')) return name.toLowerCase().endsWith(portableRule.slice(1).toLowerCase());
    if (portableRule.includes('/')) return portablePath === portableRule;
    return name === portableRule || segments.includes(portableRule);
  });
}
