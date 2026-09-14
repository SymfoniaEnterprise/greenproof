import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prefiksy kluczy, których NIE przekazujemy do podprocesu Copilot CLI:
 * poświadczenia i wewnętrzne kanały IPC Claude/Anthropic (obecne tylko, gdy
 * greenproof biegnie z wnętrza Claude Code). Poza tym kontekstem denylista jest
 * pustą operacją.
 */
const COPILOT_ENVIRONMENT_DENY_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'CLAUDECODE'] as const;

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
 * Dlatego dziedziczymy PEŁNE środowisko rodzica i wycinamy tylko to, czego
 * copilotowi dawać nie chcemy (patrz denylista wyżej). Tokeny, których copilot
 * potrzebuje (GH_TOKEN / GITHUB_TOKEN / COPILOT_GITHUB_TOKEN) oraz PLAYWRIGHT_*
 * / NODE_EXTRA_CA_CERTS przechodzą naturalnie.
 */
export function copilotEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (COPILOT_ENVIRONMENT_DENY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
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