/**
 * Minimalny loader `.env` z katalogu configu - żeby nietechniczna osoba nie
 * musiała robić `export TOKEN=...` przed każdą komendą. Istniejące zmienne env
 * zawsze wygrywają.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@greenproof/core';

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const noExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = noExport.indexOf('=');
    if (eq <= 0) continue;
    const key = noExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = noExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function applyDotenv(dir: string, logger: Logger): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(dir, '.env'), 'utf8');
  } catch {
    return;
  }
  const vars = parseDotenv(text);
  let applied = 0;
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied += 1;
    }
  }
  if (applied > 0) {
    logger.info(`wczytano ${applied} zmiennych z ${join(dir, '.env')} (istniejące env wygrywa)`);
  }
}
