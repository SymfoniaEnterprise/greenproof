#!/usr/bin/env node
/**
 * Stempluje wersję aplikacji z liczby commitów: n = `git rev-list --count HEAD`,
 * wersja = versionFromCommitCount(n). Wstawia wartość w:
 *   - packages/cli/package.json (pole `version`),
 *   - pozostałe package.json w packages/ (każdy, który ma pole `version`),
 *   - JEDNO oznaczonym miejscu w README.md (linijka `**Wersja: …**` pod tytułem).
 *
 * Skrypt idempotentny: rusza wyłącznie pojedynczą linijkę w każdym pliku,
 * niczego innego nie zmienia. Wywołanie: `pnpm stamp-version`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionFromCommitCount } from './version.mjs';

const execFileP = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function isShallowRepository() {
  const { stdout } = await execFileP('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT });
  return stdout.trim() === 'true';
}

async function commitCount() {
  if (await isShallowRepository()) {
    throw new Error(
      'Płytki klon (git clone --depth 1): liczba commitów jest nieznana, więc wstemplowana wersja byłaby fałszywa. ' +
      'Wykonaj pełny klon (git fetch --unshallow) i spróbuj ponownie.',
    );
  }
  const { stdout } = await execFileP('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT });
  const n = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(n)) throw new Error(`Nieczytelny wynik git rev-list: "${stdout}"`);
  return n;
}

/** Zamienia wartość `version` w JSON-ie, nie ruszając niczego innego. Brak miejsca → undefined. */
function stampJson(text, version) {
  const pattern = /^(\s*"version"\s*:\s*)"[^"]*"(\s*,?\s*)$/m;
  if (!pattern.test(text)) return undefined;
  return text.replace(pattern, `$1"${version}"$2`);
}

/** Zamienia liczbę w linijce `**Wersja: X**` w README, zostawiając resztę. Brak miejsca → undefined. */
function stampReadme(text, version) {
  const pattern = /^(\*\*Wersja:\s*)\d+\.\d+\.\d+(\*\*.*)$/m;
  if (!pattern.test(text)) return undefined;
  return text.replace(pattern, `$1${version}$2`);
}

async function main() {
  const n = await commitCount();
  const version = versionFromCommitCount(n);

  // Pakiety: cli + wszystkie z polem version (oprócz cli, bo jest już wyżej).
  const pkgsDir = join(ROOT, 'packages');
  const dirs = (await readdir(pkgsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => join(pkgsDir, d.name, 'package.json'));

  let stamped = 0;
  let readmeStamped = false;
  let foundPlace = false;
  for (const file of dirs) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue; // brak package.json w pakiecie
    }
    if (!/"version"\s*:/.test(text)) continue; // bez pola version - nie ruszamy
    const next = stampJson(text, version);
    if (next === undefined) {
      console.warn(`[stamp-version] Ostrzeżenie: brak pola "version" do ostemplowania w ${file}.`);
      continue;
    }
    foundPlace = true;
    if (next !== text) {
      await writeFile(file, next, 'utf8');
      stamped += 1;
    }
  }

  const readmePath = join(ROOT, 'README.md');
  const readme = await readFile(readmePath, 'utf8');
  const readmeNext = stampReadme(readme, version);
  if (readmeNext === undefined) {
    console.warn('[stamp-version] Ostrzeżenie: brak linijki `**Wersja: …**` w README.md do ostemplowania.');
  } else {
    foundPlace = true;
    if (readmeNext !== readme) {
      await writeFile(readmePath, readmeNext, 'utf8');
      readmeStamped = true;
    }
  }

  if (!foundPlace) {
    throw new Error(
      'Nigdzie nie znaleziono miejsca do ostemplowania (żaden package.json z polem "version" ani README.md z linijką `**Wersja: …**`).',
    );
  }
  console.log(`stamp-version: ${n} commitów → wersja ${version} (${stamped} pakietów + ${readmeStamped ? 'README' : 'README już aktualny'})`);
}

main().catch((err) => {
  console.error(`[stamp-version] BŁĄD: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
