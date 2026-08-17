/**
 * Inwentarz POM (pom-index.json w repo testów) - źródło prawdy triażu:
 * które flow są już "opłacone" i którym plikiem je reużyć.
 */
import type { PomIndex, PomIndexEntry } from '../domain/harvest.js';
import type { PlanCase } from '../domain/plan.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Clock, ScmPort } from '../ports/index.js';

export const EMPTY_INDEX: PomIndex = { version: 1, entries: [] };

export async function readPomIndex(
  scm: ScmPort,
  ref: string,
  config: GreenproofConfig,
): Promise<PomIndex> {
  const raw = await scm.readFile(ref, config.paths.pomIndex);
  if (raw === null) return EMPTY_INDEX;
  try {
    const parsed = JSON.parse(raw) as PomIndex;
    return parsed.version === 1 && Array.isArray(parsed.entries) ? parsed : EMPTY_INDEX;
  } catch {
    return EMPTY_INDEX;
  }
}

/** Dopasowanie tagów flow z hierarchią route'ów ("payroll" pokrywa "payroll/create"). */
function flowMatches(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la === lb || la.startsWith(`${lb}/`) || lb.startsWith(`${la}/`);
}

/** POM-y/fixture'y pokrywające flow case'a - sekcja `inventory` kontekstu triażu. */
export function matchInventory(index: PomIndex, planCase: PlanCase): PomIndexEntry[] {
  return index.entries.filter((e) =>
    e.covers.some((cov) => planCase.flows.some((f) => flowMatches(cov, f))),
  );
}

export interface RegisterEntryInput {
  name: string;
  path: string;
  kind: 'pom' | 'fixture';
  description: string;
  covers: string[];
  keySelectors: string[];
  harvestedBy: string;
}

export class HarvestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarvestValidationError';
  }
}

/**
 * Dodaje/aktualizuje wpis (klucz: name). Zwraca NOWY indeks - czysta funkcja,
 * zapis (commit na branchu case'a) robi wywołujący.
 */
export function upsertEntry(
  index: PomIndex,
  input: RegisterEntryInput,
  clock: Clock,
): PomIndex {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(input.name)) {
    throw new HarvestValidationError(`Nieprawidłowa nazwa wpisu inwentarza: ${input.name}`);
  }
  if (input.covers.length === 0) {
    throw new HarvestValidationError(
      `Wpis ${input.name} musi deklarować co najmniej jeden tag flow (covers) - bez tego triaż nigdy go nie dopasuje`,
    );
  }
  const existing = index.entries.find((e) => e.name === input.name);
  const entry: PomIndexEntry = {
    ...input,
    reuseCount: existing?.reuseCount ?? 0,
    addedAt: existing?.addedAt ?? clock.now().toISOString(),
  };
  return {
    version: 1,
    entries: [...index.entries.filter((e) => e.name !== input.name), entry],
  };
}

/**
 * Unia indeksów triażu/lintu: wpisy z `fresh` (branch fixture'ów, dorobione w
 * tym runie) wygrywają konflikt nazw z wpisami `base` (baseRef). Prosta unia
 * po nazwie - bez logiki liczników reuse (to robi mergeIndexes przy acceptach).
 */
export function unionIndexes(fresh: PomIndex, base: PomIndex): PomIndex {
  const byName = new Map<string, PomIndexEntry>();
  for (const e of base.entries) byName.set(e.name, e);
  for (const e of fresh.entries) byName.set(e.name, e);
  return { version: 1, entries: [...byName.values()] };
}

/**
 * Merge indeksów przy równoległych acceptach: po kluczu nazwy; przy konflikcie
 * wygrywa wpis z większym reuseCount, a liczniki są sumowane od bazy.
 */
export function mergeIndexes(base: PomIndex, ours: PomIndex, theirs: PomIndex): PomIndex {
  const byName = new Map<string, PomIndexEntry>();
  for (const e of base.entries) byName.set(e.name, e);
  for (const side of [ours, theirs]) {
    for (const e of side.entries) {
      const cur = byName.get(e.name);
      if (!cur) {
        byName.set(e.name, e);
        continue;
      }
      const baseCount = base.entries.find((b) => b.name === e.name)?.reuseCount ?? 0;
      const merged: PomIndexEntry = {
        ...(e.reuseCount >= cur.reuseCount ? e : cur),
        reuseCount: Math.max(baseCount, 0) + (cur.reuseCount - baseCount) + (e.reuseCount - baseCount),
      };
      byName.set(e.name, merged);
    }
  }
  return { version: 1, entries: [...byName.values()] };
}

/** Podbija reuseCount wpisom użytym w próbie - telemetria wartości. */
export function bumpReuse(index: PomIndex, usedNames: string[]): PomIndex {
  return {
    version: 1,
    entries: index.entries.map((e) =>
      usedNames.includes(e.name) ? { ...e, reuseCount: e.reuseCount + 1 } : e,
    ),
  };
}
