import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prefiksy kluczy, których NIE przekazujemy do podprocesu Copilot CLI:
 * poświadczenia i wewnętrzne kanały IPC Claude/Anthropic (obecne tylko, gdy
 * greenproof biegnie z wnętrza Claude Code). Poza tym kontekstem denylista jest
 * pustą operacją.
 */
const COPILOT_SYSTEM_ENV_KEYS = new Set([
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PSMODULEPATH',
  'PUBLIC',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
]);
const COPILOT_CREDENTIAL_KEYS = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN']);

export interface CopilotEnvironmentOptions {
  /** Fixture-author nie potrzebuje tokenu Copilota, bo może użyć loginu z HOME. */
  includeCopilotCredentials?: boolean;
}

/**
 * Środowisko dla podprocesu Copilot CLI - preflight ORAZ sesje autora
 * (copilotSession / copilotFixtureSession / copilotPlaywrightMcpServer).
 *
 * Copilot to proces Node: na Windowsie potrzebuje KOMPLETNEGO środowiska
 * systemowego (SystemRoot, COMSPEC, PATHEXT, ProgramData, ProgramFiles*,
 * HOMEDRIVE/HOMEPATH, PROCESSOR_*, …). Wcześniejsza wąska allowlista w stylu
 * POSIX (PATH/HOME/XDG_*) gubiła tę bazę - spawn `copilot` (nawet `--version`)
 * wieszał się zamiast zwrócić wynik i preflight/sesja biły w timeout. Nie
 * wystarcza dorzucenie jednej zmiennej (samo SystemRoot nie ratuje); potrzebna
 * jest cała baza systemowa, a jej pełny skład różni się między maszynami.
 *
 * Dlatego przekazujemy tylko bazę systemową oraz jawnie dozwolone credentiale
 * Copilota. Nie dziedziczymy `process.env`: zmienne aplikacji, CI i innych
 * providerów (np. LITELLM_KEY/CLIPROXY_TOKEN) pozostają poza procesem.
 */
export function copilotEnvironment(options: CopilotEnvironmentOptions = {}): Record<string, string> {
  const includeCopilotCredentials = options.includeCopilotCredentials ?? true;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const normalizedKey = key.toUpperCase();
    if (!COPILOT_SYSTEM_ENV_KEYS.has(normalizedKey)) {
      if (!includeCopilotCredentials || !COPILOT_CREDENTIAL_KEYS.has(normalizedKey)) continue;
    }
    env[key] = value;
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