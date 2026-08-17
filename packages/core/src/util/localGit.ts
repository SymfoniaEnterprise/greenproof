/**
 * Lokalne operacje git w katalogu roboczym repo testów (cwd agenta).
 * To NIE jest ScmPort - to warsztat autora: branch case'a, checkpointy,
 * kontrola czystości po dowodzie mutacyjnym.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../ports/index.js';

const execFileP = promisify(execFile);

/** Surowe stdout - bez trim, gdy format jest znaczący (porcelain -z: " M plik"). */
async function gitRaw(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitRaw(cwd, ...args)).trim();
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, 'rev-parse', '--verify', '--quiet', ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort dociągnięcie refu z "origin": najpierw `fetch origin <ref>:<ref>`,
 * potem `fetch origin <ref>`. Brak remote'a/refu NIE jest błędem (typowe dla
 * adaptera fs) - zwraca false bez rzucania.
 */
export async function fetchRefBestEffort(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, 'fetch', 'origin', `${ref}:${ref}`);
    return true;
  } catch {
    try {
      await git(cwd, 'fetch', 'origin', ref);
      return true;
    } catch {
      return false;
    }
  }
}

/** Przełącza na branch case'a; tworzy go z baseRef, jeśli nie istnieje. */
export async function checkoutCaseBranch(
  cwd: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  if (await refExists(cwd, branch)) {
    await git(cwd, 'checkout', branch);
  } else {
    await git(cwd, 'checkout', '-B', branch, baseRef);
  }
}

/** Przełącza worktree na istniejący ref (bez tworzenia brancha). */
export async function checkoutRef(cwd: string, ref: string): Promise<void> {
  await git(cwd, 'checkout', ref);
}

/**
 * Tworzy (albo przestawia) branch na bieżącym HEAD, ZABIERAJĄC niescommitowaną
 * pracę - odstawia nieudaną sesję na bocznicę, a wspólny branch nie łapie śmieci.
 */
export async function forceBranchHere(cwd: string, branch: string): Promise<void> {
  await git(cwd, 'checkout', '-B', branch);
}

export async function headSha(cwd: string): Promise<string> {
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * Przestawia branch na wskazany commit BEZ checkoutu (git branch -f) - cofa
 * współdzielony branch po odrzuconej dostawie; commit zostaje na bocznicy.
 */
export async function resetBranchTo(cwd: string, branch: string, sha: string): Promise<void> {
  await git(cwd, 'branch', '-f', branch, sha);
}

/** Skrócone SHA commitów od `since` do HEAD (najstarszy pierwszy). */
export async function commitsSince(cwd: string, since: string): Promise<string[]> {
  const out = await git(cwd, 'log', '--format=%h', '--reverse', `${since}..HEAD`);
  return out.length === 0 ? [] : out.split('\n');
}

export async function isWorktreeClean(cwd: string): Promise<boolean> {
  return (await git(cwd, 'status', '--porcelain')) === '';
}

/** Co dokładnie brudzi worktree repo testów (pliki ignorowane pomijamy). */
export interface WorktreeDirt {
  /** Zmiany w plikach ŚLEDZONYCH - "XY ścieżka" jak w `git status --porcelain`. */
  tracked: string[];
  /** Pliki NIEŚLEDZONE (bez ignorowanych) - `git add -A` zabiera także je. */
  untracked: string[];
}

/**
 * Rozbiór `git status --porcelain -z`. Format -z NIE cytuje ścieżek (żadnego
 * odwracania \" i \\), a przy zmianie nazwy stara ścieżka jest OSOBNYM polem
 * zaraz za nową - trzeba je przeskoczyć, inaczej wygląda jak kolejny wpis.
 */
export async function worktreeDirt(cwd: string): Promise<WorktreeDirt> {
  const raw = await gitRaw(cwd, 'status', '--porcelain', '-z');
  const fields = raw.split('\0');
  const dirt: WorktreeDirt = { tracked: [], untracked: [] };
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue; // ogon po ostatnim NUL
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // pole ze starą ścieżką
    if (xy === '??') dirt.untracked.push(path);
    else if (xy !== '!!') dirt.tracked.push(`${xy} ${path}`);
  }
  return dirt;
}

/** Świadome wymuszenie startu na brudnym repo testów (operator wie, co robi). */
export const ALLOW_DIRTY_ENV = 'GREENPROOF_ALLOW_DIRTY_TESTS_REPO';

export class DirtyTestsRepoError extends Error {
  constructor(
    readonly cwd: string,
    readonly dirt: WorktreeDirt,
    message: string,
  ) {
    super(message);
    this.name = 'DirtyTestsRepoError';
  }
}

/** Lista dla człowieka - bez zalewania konsoli przy setkach plików. */
function sample(paths: string[], limit = 20): string {
  const shown = paths.slice(0, limit).map((p) => `    ${p}`);
  if (paths.length > limit) shown.push(`    … i ${paths.length - limit} więcej`);
  return shown.join('\n');
}

/**
 * BRAMKA: repo testów bez niezacommitowanych zmian w plikach ŚLEDZONYCH.
 * Autor pracuje w worktree użytkownika - `git checkout` przeniósłby jego pracę
 * na branch case'a (albo padł w połowie), a `git add -A` zamiótłby ją do
 * commitu case'a. To jedyna operacja, która może ZNISZCZYĆ cudzą pracę, więc
 * odmawiamy startu, zamiast ratować się po fakcie.
 *
 * Pliki NIEŚLEDZONE tylko ostrzegają: w domyślnym `gp run --tests-repo` adapter
 * fs trzyma swoje `state/`, `artifacts/`, `reports/` w repo testów, więc twarda
 * bramka na nieśledzonych odmawiałaby startu KAŻDEMU przebiegowi. Checkout ich
 * nie rusza (a kolizję z plikiem z brancha git i tak zgłasza sam).
 *
 * Wołana RAZ na partię (wejście autora / prewencyjnych fixture'ów), nigdy per
 * case - przy 10 case'ach to jedno `git status`, nie dziesięć.
 */
export async function assertTestsRepoClean(
  cwd: string,
  logger: Logger,
  opts?: { allowDirty?: boolean },
): Promise<void> {
  const dirt = await worktreeDirt(cwd);
  if (dirt.untracked.length > 0) {
    logger.warn(
      `Repo testów ${cwd} ma ${dirt.untracked.length} nieśledzonych plików - ` +
        `commit case'a (\`git add -A\`) zabierze także je. Dopisz robocze katalogi ` +
        `do .gitignore, jeśli nie mają trafiać na branche autora:\n${sample(dirt.untracked, 10)}`,
    );
  }
  if (dirt.tracked.length === 0) return;

  const message =
    `Repo testów ${cwd} ma niezacommitowane zmiany w plikach śledzonych - ` +
    `greenproof odmawia startu, żeby nie przenieść ich na branch autora i nie ` +
    `zamieść do commitu case'a:\n${sample(dirt.tracked)}\n` +
    `Zrób jedno z:\n` +
    `  - scommituj:  git -C ${cwd} add -A && git -C ${cwd} commit -m "wip"\n` +
    `  - odłóż:      git -C ${cwd} stash push -u\n` +
    `  - porzuć:     git -C ${cwd} checkout -- .   (NIEODWRACALNE)\n` +
    `Świadome wymuszenie: ${ALLOW_DIRTY_ENV}=1 (zmiany trafią na branch autora).`;

  const allowDirty = opts?.allowDirty ?? process.env[ALLOW_DIRTY_ENV] === '1';
  if (allowDirty) {
    logger.warn(`${ALLOW_DIRTY_ENV}=1 - startuję mimo brudnego repo testów.\n${message}`);
    return;
  }
  throw new DirtyTestsRepoError(cwd, dirt, message);
}

/** Commit wszystkiego, co zostało - checkpoint odporności po padzie/przerwaniu. */
export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, 'add', '-A');
  try {
    await git(cwd, '-c', 'user.name=greenproof', '-c', 'user.email=greenproof@localhost',
      'commit', '-m', message, '--no-verify');
  } catch {
    // Nic do commitowania - OK.
  }
}
