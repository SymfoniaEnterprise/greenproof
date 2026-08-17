/**
 * Współdzielenie harvestu WEWNĄTRZ runu: po dostarczeniu case'a jego POM-y/
 * fixture'y trafiają na wspólny branch fixture'ów, żeby kolejne case'y tego
 * runu widziały je w triażu bez czekania na accept. Używa commitFiles (bez
 * dotykania worktree), więc jest idempotentne (brak zmiany = brak commita).
 */
import type { PomIndex, PomIndexEntry } from '../domain/harvest.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Ports } from '../ports/index.js';
import { readPomIndex, upsertEntry } from './inventory.js';
import { fixturesBranchName } from '../steps/preventiveFixture.js';

export interface ShareCaseHarvestParams {
  runId: string;
  caseId: string;
  branch: string;
  baseRef: string;
  fixturesRef?: string;
}

/** Liczba ponowień przy przegranej CAS na wspólnym refie. */
const MAX_SHARE_ATTEMPTS = 3;

/**
 * Przegrana CAS na refie wspólnego brancha: adapter fs rzuca zwykły Error
 * ("... was modified concurrently ..."), adapter GitHub - ScmConflictError.
 * Rozpoznajemy OBYDWA sygnały, żeby ponowić dostawę zamiast traktować
 * wyścig jak dowolną awarię.
 */
function isCasConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'ScmConflictError' || /modified concurrently/i.test(err.message))
  );
}

/**
 * Wpisy case'a do przeniesienia na wspólny branch: nowe, o zmienionej ścieżce
 * ALBO o zmienionej treści pod tą samą ścieżką. Identyczna treść = pomijamy
 * (puste commity).
 */
async function collectMovedEntries(
  ports: Ports,
  params: ShareCaseHarvestParams,
  sharedIndex: PomIndex,
  caseIndex: PomIndex,
): Promise<{ entry: PomIndexEntry; content: string }[]> {
  const byName = new Map(sharedIndex.entries.map((e) => [e.name, e]));
  const sharedRef = params.fixturesRef ?? params.baseRef;
  const moved: { entry: PomIndexEntry; content: string }[] = [];
  for (const entry of caseIndex.entries) {
    const existing = byName.get(entry.name);
    const content = await ports.scm.readFile(params.branch, entry.path);
    if (content === null) {
      // Wpis bez pliku to fantom - nie wolno go rejestrować dla innych case'ów.
      ports.logger.warn(
        `Harvest ${params.caseId}: wpis "${entry.name}" bez pliku ${entry.path} - pominięty`,
      );
      continue;
    }
    if (existing !== undefined && existing.path === entry.path) {
      // Ta sama ścieżka: przenieś TYLKO przy zmianie treści; identyczna = wspólny
      // branch jest już aktualny, nie ma czego commitować.
      const sharedContent = await ports.scm.readFile(sharedRef, entry.path);
      if (sharedContent === content) continue;
    }
    moved.push({ entry, content });
  }
  return moved;
}

/**
 * Przenosi wpisy case'a na wspólny branch fixture'ów i aktualizuje tam indeks
 * POM. Przenosi WYŁĄCZNIE pliki z `path` wpisów i sam indeks - nigdy spec ani
 * inne pliki (inaczej spec case'a A wyciekłby do PR case'a B).
 */
export async function shareCaseHarvest(
  ports: Ports,
  config: GreenproofConfig,
  params: ShareCaseHarvestParams,
): Promise<{ branch: string; shared: PomIndexEntry[] }> {
  const targetBranch = params.fixturesRef ?? fixturesBranchName(params.runId);
  const caseIndex = await readPomIndex(ports.scm, params.branch, config);

  // Sekwencja "odczyt wspólnego indeksu → zbuduj → commitFiles" jest CAS-owana
  // przez adapter na wspólnym branchu. Przy równoległym dostarczeniu jeden
  // commit przegra - ponawiamy, czytając indeks od nowa i przeliczając, które
  // wpisy są nadal potrzebne.
  for (let attempt = 1; attempt <= MAX_SHARE_ATTEMPTS; attempt += 1) {
    const sharedRef = params.fixturesRef ?? params.baseRef;
    const sharedIndex = await readPomIndex(ports.scm, sharedRef, config);
    const moved = await collectMovedEntries(ports, params, sharedIndex, caseIndex);

    // Nic do udostępnienia: bez brancha ani commita (idempotencja).
    if (moved.length === 0) {
      return { branch: targetBranch, shared: [] };
    }

    await ports.scm.ensureBranch(targetBranch, params.baseRef);

    // nextIndex budujemy z indeksu przeczytanego PONOWNIE z targetBranch, nie
    // z sharedIndex: po ensureBranch targetBranch pokazuje aktualny stan wspólnego
    // brancha. Inaczej równoległy case przegrałby swój wpis, budując nextIndex
    // z tego samego starego baseRef.
    const sharedIndexNow = await readPomIndex(ports.scm, targetBranch, config);

    let nextIndex = sharedIndexNow;
    for (const { entry } of moved) {
      nextIndex = upsertEntry(
        nextIndex,
        {
          name: entry.name,
          path: entry.path,
          kind: entry.kind,
          description: entry.description,
          covers: entry.covers,
          keySelectors: entry.keySelectors,
          harvestedBy: entry.harvestedBy ?? params.caseId,
        },
        ports.clock,
      );
    }

    try {
      await ports.scm.commitFiles(
        targetBranch,
        [
          ...moved.map(({ entry, content }) => ({ path: entry.path, content })),
          { path: config.paths.pomIndex, content: JSON.stringify(nextIndex, null, 2) },
        ],
        `chore(greenproof): share harvest from ${params.caseId}`,
      );
      return { branch: targetBranch, shared: moved.map(({ entry }) => entry) };
    } catch (err) {
      // Wyczerpanie prób albo awaria inna niż wyścig CAS - propaguj błąd.
      if (!isCasConflict(err) || attempt === MAX_SHARE_ATTEMPTS) throw err;
      // Wspólny indeks mógł się zmienić - kolejna iteracja przeczyta go od nowa.
    }
  }

  // Pętla zawsze kończy się returnem albo rzuceniem błędu - to tylko dla TS.
  throw new Error(`shareCaseHarvest: wyczerpano ${MAX_SHARE_ATTEMPTS} prób bez rozstrzygnięcia`);
}
