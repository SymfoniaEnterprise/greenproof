/**
 * Maszyna stanów pipeline'u. Stan jest trwały (StateStore z CAS), przejścia
 * walidowane przez CASE_TRANSITIONS, a długotrwała praca autora chroniona
 * lease'ami - po padzie runnera wygasły lease pozwala przejąć case bez
 * utraty pracy (checkpointy są commitami na branchu case'a).
 */
import type { NormalizedPlan } from '../domain/plan.js';
import {
  CASE_TRANSITIONS,
  InvalidTransitionError,
  type CaseState,
  type CaseStatus,
  type PipelineState,
} from '../domain/state.js';
import type { Clock } from '../ports/index.js';
import { hashPlan } from '../util/hash.js';

export interface InitParams {
  runId: string;
  envUrl: string;
  baseRef: string;
  runRef: string;
}

export function initPipelineState(
  plan: NormalizedPlan,
  params: InitParams,
  clock: Clock,
): PipelineState {
  const cases: Record<string, CaseState> = {};
  for (const c of plan.cases) {
    cases[c.caseId] = {
      caseId: c.caseId,
      status: 'pending',
      priority: c.priority,
      attempts: 0,
      artifacts: { ledger: `cases/${c.caseId}/ledger.jsonl` },
      costUsd: 0,
    };
  }
  return {
    runId: params.runId,
    slug: plan.slug,
    planHash: hashPlan(plan),
    envUrl: params.envUrl,
    baseRef: params.baseRef,
    runRef: params.runRef,
    createdAt: clock.now().toISOString(),
    cases,
    totals: { costUsd: 0, turns: 0 },
  };
}

export function getCase(state: PipelineState, caseId: string): CaseState {
  const c = state.cases[caseId];
  if (!c) throw new Error(`Unknown case ${caseId} in run ${state.runId}`);
  return c;
}

/** Jedyna dozwolona droga zmiany pola status (mutuje przekazany PipelineState). */
export function transitionCase(
  state: PipelineState,
  caseId: string,
  to: CaseStatus,
  patch?: Partial<Omit<CaseState, 'caseId' | 'status'>>,
): CaseState {
  const c = getCase(state, caseId);
  const allowed = CASE_TRANSITIONS[c.status];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(caseId, c.status, to);
  }
  Object.assign(c, patch, { status: to });
  return c;
}

/** Wygasły lease - case porzucony przez padnięty run. */
export function hasExpiredLease(c: CaseState, clock: Clock): boolean {
  return (
    c.lease !== undefined && new Date(c.lease.expiresAt).getTime() <= clock.now().getTime()
  );
}

export class LeaseHeldError extends Error {
  constructor(
    readonly caseId: string,
    readonly owner: string,
  ) {
    super(`Case ${caseId} is leased by ${owner}`);
    this.name = 'LeaseHeldError';
  }
}

/**
 * Aktywny cudzy lease → LeaseHeldError. Wygasły → przejęcie: stan roboczy
 * (authoring/proving) wraca do 'triaged'; wywołujący dopisuje do ledgera
 * notatkę o przerwanej próbie.
 */
export function acquireLease(
  state: PipelineState,
  caseId: string,
  owner: string,
  ttlMinutes: number,
  clock: Clock,
): { reclaimed: boolean } {
  const c = getCase(state, caseId);
  let reclaimed = false;
  if (c.lease) {
    if (!hasExpiredLease(c, clock) && c.lease.owner !== owner) {
      throw new LeaseHeldError(caseId, c.lease.owner);
    }
    if (hasExpiredLease(c, clock)) {
      reclaimed = true;
      if (c.status === 'authoring' || c.status === 'proving') {
        // Porzucona próba - wracamy do triaged; praca przetrwała jako
        // commity na branchu case'a.
        c.status = 'triaged';
      }
    }
  }
  c.lease = {
    owner,
    expiresAt: new Date(clock.now().getTime() + ttlMinutes * 60_000).toISOString(),
  };
  return { reclaimed };
}

export function releaseLease(state: PipelineState, caseId: string): void {
  const c = getCase(state, caseId);
  delete c.lease;
}

/** Stabilna kolejność wg wstawienia do planu. */
export function casesInStatus(
  state: PipelineState,
  ...statuses: CaseStatus[]
): CaseState[] {
  return Object.values(state.cases).filter((c) => statuses.includes(c.status));
}
