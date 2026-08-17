/**
 * Uczenie listy churn-prone z ledgera. Lista ręczna (konfig) jest zawsze
 * aktywna; wpisy nauczone wchodzą w trybie `propose` (zatwierdza człowiek)
 * albo `auto` (aktywne od razu) i wygasają po N spokojnych runach.
 */
import type { LearnedChurnEntry, LearnedChurnList } from '../domain/knowledge.js';
import type { AttemptRecord } from '../domain/attempt.js';
import type { NormalizedPlan } from '../domain/plan.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Clock } from '../ports/index.js';

/** Klucz uczenia: typ biznesowy, w fallbacku pierwszy tag flow. */
function learnKey(plan: NormalizedPlan, caseId: string): string | undefined {
  const pc = plan.cases.find((c) => c.caseId === caseId);
  return pc?.type ?? pc?.flows[0];
}

/**
 * Incydenty runa kwalifikujące typ do listy churn-prone:
 * - uderzenie w bezpiecznik seedu (blocked: fixture-gap),
 * - >= maxFailedStrategies nieudanych strategii seedu,
 * - koszt case'a > 2× mediana kosztów runa (przy >= 3 case'ach).
 */
export function detectChurnIncidents(
  plan: NormalizedPlan,
  ledgers: Map<string, AttemptRecord[]>,
  config: GreenproofConfig,
  runId: string,
): LearnedChurnEntry['evidence'][] {
  const incidents: LearnedChurnEntry['evidence'][] = [];
  const caseCosts = new Map<string, number>();
  for (const [caseId, records] of ledgers) {
    caseCosts.set(caseId, records.reduce((s, r) => s + r.costUsd, 0));
  }

  const costs = [...caseCosts.values()].sort((a, b) => a - b);
  const median = costs.length >= 3 ? costs[Math.floor(costs.length / 2)]! : undefined;

  for (const [caseId, records] of ledgers) {
    const fuseHit = records.some(
      (r) => r.outcome === 'blocked' && r.blockedReason === 'fixture-gap',
    );
    if (fuseHit) {
      incidents.push({ caseId, runId, reason: 'seed-fuse' });
      continue;
    }
    const failedStrategies = new Set(
      records.flatMap((r) => (r.seedAttempts ?? []).filter((s) => s.outcome === 'failed').map((s) => s.strategy)),
    ).size;
    if (failedStrategies >= config.caps.seedFuse.maxFailedStrategies) {
      incidents.push({ caseId, runId, reason: 'failed-seed-strategies', failedStrategies });
      continue;
    }
    const cost = caseCosts.get(caseId) ?? 0;
    if (median !== undefined && median > 0 && cost > 2 * median) {
      incidents.push({ caseId, runId, reason: 'cost-outlier', costUsd: cost });
    }
  }
  return incidents;
}

export interface ChurnUpdate {
  list: LearnedChurnList;
  /** Nowe wpisy z tego runa (do raportu dla człowieka). */
  added: LearnedChurnEntry[];
  /** Typy wygaszone (N spokojnych runów). */
  expired: string[];
}

/**
 * Aktualizuje nauczoną listę: dodaje wpisy z incydentów (status wg trybu),
 * podbija quietRuns wpisom bez incydentu, wygasza po TTL.
 */
export function updateLearnedChurn(
  learned: LearnedChurnList,
  incidents: LearnedChurnEntry['evidence'][],
  plan: NormalizedPlan,
  config: GreenproofConfig,
  clock: Clock,
): ChurnUpdate {
  const mode = config.caps.seedFuse.learn;
  if (mode === 'off') return { list: learned, added: [], expired: [] };

  const incidentTypes = new Set<string>();
  const added: LearnedChurnEntry[] = [];
  const entries = [...learned.entries];

  for (const evidence of incidents) {
    const type = learnKey(plan, evidence.caseId);
    if (!type) continue;
    incidentTypes.add(type);
    const existing = entries.find((e) => e.type === type);
    if (existing) {
      existing.quietRuns = 0;
      continue;
    }
    const entry: LearnedChurnEntry = {
      type,
      evidence,
      addedAt: clock.now().toISOString(),
      status: mode === 'auto' ? 'active' : 'proposed',
      quietRuns: 0,
    };
    entries.push(entry);
    added.push(entry);
  }

  const ttl = config.caps.seedFuse.learnedEntryTtlRuns;
  const expired: string[] = [];
  const kept = entries.filter((e) => {
    if (!incidentTypes.has(e.type)) e.quietRuns += 1;
    if (e.quietRuns >= ttl) {
      expired.push(e.type);
      return false;
    }
    return true;
  });

  return { list: { version: 1, entries: kept }, added, expired };
}

/** Wywoływane z acceptu pliku / komendy platformy. */
export function approveChurnEntry(learned: LearnedChurnList, type: string): LearnedChurnList {
  return {
    version: 1,
    entries: learned.entries.map((e) =>
      e.type === type ? { ...e, status: 'active' as const } : e,
    ),
  };
}
