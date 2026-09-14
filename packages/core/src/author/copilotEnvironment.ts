import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COPILOT_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'TEMP',
  'TMP',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'PLAYWRIGHT_BROWSERS_PATH',
  'NODE_EXTRA_CA_CERTS',
] as const;

export function copilotEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of COPILOT_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function copilotAutopilotContinueCap(maxTurns: number, configured?: number): number {
  const cap = Math.max(0, maxTurns - 1);
  return configured === undefined ? cap : Math.min(cap, configured);
}

export const COPILOT_FIXTURE_SHELL_DENY_ARGS = [
  '--deny-tool=shell(git push*)',
  '--deny-tool=shell(rm*)',
  '--deny-tool=shell(gh*)',
] as const;

export function copilotRuntimeScriptPath(metaUrl: string, fileName: string): string {
  const localPath = fileURLToPath(new URL(`./${fileName}.js`, metaUrl));
  if (existsSync(localPath)) return localPath;
  const bundledPath = resolve(dirname(localPath), '../../dist/author', `${fileName}.js`);
  return existsSync(bundledPath) ? bundledPath : localPath;
}