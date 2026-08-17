/**
 * TRIAŻ - deterministyczny krok per case PRZED agentem: składa kontekst
 * startowy (przypadek + opłacony już inwentarz POM + dopasowana wiedza
 * projektowa + wnioski z poprzedniej próby), żeby agent CZYTAŁ zamiast
 * odkrywać. Idempotentny - nadpisuje context.json.
 */
import type { NormalizedPlan, PlanCase } from '../domain/plan.js';
import type { PomIndex, PomIndexEntry } from '../domain/harvest.js';
import type { AppMapView, UiTrap } from '../domain/knowledge.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Ports } from '../ports/index.js';
import { withState } from '../machine/withState.js';
import { casesInStatus, transitionCase } from '../machine/pipeline.js';
import { PLAN_ARTIFACT_KEY, safeCaseId } from './filter.js';
import {
  effectiveChurnTypes,
  isChurnProne,
  loadAppMap,
  loadLearnedChurn,
  loadUiTraps,
  trapsForFlows,
  viewsForFlows,
} from '../knowledge/loader.js';
import { matchInventory, readPomIndex, unionIndexes } from '../harvest/inventory.js';
import { lastAttempt, readLedger } from '../ledger/store.js';

export interface TriageParams {
  runId: string;
  /** Pojedynczy case (np. przy retry); brak = wszystkie selected/triaged. */
  caseId?: string;
}

export interface TriageResult {
  contexts: { caseId: string; artifactKey: string }[];
}

/** Kontekst startowy agenta - zawartość cases/<caseId>/context.json. */
export interface CaseContext {
  case: PlanCase;
  envUrl: string;
  branch: string;
  /** Numer nadchodzącej próby (1-based). */
  attempt: number;
  /** POM-y/fixture'y pokrywające flow case'a - "opłacone odkrycia, użyj zamiast odkrywać". */
  inventory: PomIndexEntry[];
  uiTraps: UiTrap[];
  appMapViews: AppMapView[];
  /** Czy case podlega bezpiecznikowi seedu. */
  churnProne: boolean;
  previousAttempt?: {
    digest?: string;
    lastErrors: string[];
    commits: string[];
    humanNotes?: string;
  };
  /** Ścieżki plików golden-case (oracle) w repo testów. */
  oracleFiles: string[];
}

export function contextKey(caseId: string): string {
  return `cases/${safeCaseId(caseId)}/context.json`;
}

export async function runTriage(
  ports: Ports,
  config: GreenproofConfig,
  params: TriageParams,
): Promise<TriageResult> {
  const planBuf = await ports.artifacts.get(params.runId, PLAN_ARTIFACT_KEY);
  if (!planBuf) throw new Error(`Missing plan artifact for run ${params.runId} - run filter first`);
  const plan = JSON.parse(planBuf.toString('utf8')) as NormalizedPlan;

  return withState(ports, params.runId, async (state) => {
    const targets = params.caseId
      ? [state.cases[params.caseId] ?? missingCase(params.caseId)]
      : casesInStatus(state, 'selected', 'triaged');

    const ref = state.baseRef;
    // Indeks POM = UNIA baseRef + branch fixture'ów: dorobione w tym runie muszą
    // być widoczne przed acceptem, a wpisy z baseRef nie mogą zniknąć, gdy adapter
    // API-only nie ma zdalnego brancha fixture'ów (pusty indeks = cicha utrata
    // inwentarza). Wiedza i oracle zostają na baseRef.
    const fixturesRef = state.fixturesRef;
    const [baseIndex, traps, appMap, learned] = await Promise.all([
      readPomIndex(ports.scm, ref, config),
      loadUiTraps(ports.scm, ref, config, ports.logger),
      loadAppMap(ports.scm, ref, config, ports.logger),
      loadLearnedChurn(ports.scm, ref, config, ports.logger),
    ]);
    const pomIndex =
      fixturesRef !== undefined && fixturesRef !== ref
        ? unionIndexes(await readPomIndex(ports.scm, fixturesRef, config), baseIndex)
        : baseIndex;
    const churnTypes = effectiveChurnTypes(config, learned);
    const oracleFiles = config.oracle
      ? await ports.scm.listFiles(ref, `${config.oracle.goldenCasesDir}/**`)
      : [];

    const contexts: TriageResult['contexts'] = [];
    for (const cs of targets) {
      const pc = plan.cases.find((c) => c.caseId === cs.caseId);
      if (!pc) throw new Error(`Case ${cs.caseId} not present in plan artifact`);

      const context = await buildContext(ports, config, {
        state: { runId: state.runId, envUrl: state.envUrl },
        caseState: cs,
        planCase: pc,
        pomIndex,
        churnProne: isChurnProne(churnTypes, pc),
        uiTraps: trapsForFlows(traps, pc.flows),
        appMapViews: viewsForFlows(appMap, pc.flows),
        oracleFiles,
      });

      const key = contextKey(cs.caseId);
      await ports.artifacts.put(
        state.runId,
        key,
        Buffer.from(JSON.stringify(context, null, 2)),
      );
      if (cs.status === 'selected') transitionCase(state, cs.caseId, 'triaged');
      contexts.push({ caseId: cs.caseId, artifactKey: key });
    }
    return { contexts };
  });
}

function missingCase(caseId: string): never {
  throw new Error(`Unknown case ${caseId}`);
}

async function buildContext(
  ports: Ports,
  config: GreenproofConfig,
  input: {
    state: { runId: string; envUrl: string };
    caseState: { caseId: string; attempts: number; branch?: string; retryNotes?: string };
    planCase: PlanCase;
    pomIndex: PomIndex;
    churnProne: boolean;
    uiTraps: UiTrap[];
    appMapViews: AppMapView[];
    oracleFiles: string[];
  },
): Promise<CaseContext> {
  const { caseState, planCase } = input;
  const ledger = await readLedger(ports.artifacts, input.state.runId, caseState.caseId);
  const prev = lastAttempt(ledger);

  // Extra-inwentarz per case (np. fixture od fixture-author) - wchodzi w całości,
  // bez dopasowywania po flow.
  const extraBuf = await ports.artifacts.get(
    input.state.runId,
    `cases/${safeCaseId(caseState.caseId)}/extra-inventory.json`,
  );
  const extra: PomIndexEntry[] = extraBuf
    ? (JSON.parse(extraBuf.toString('utf8')) as PomIndex).entries
    : [];

  const matched = matchInventory(input.pomIndex, planCase);
  const context: CaseContext = {
    case: planCase,
    envUrl: input.state.envUrl,
    branch: caseState.branch ?? `author/${safeCaseId(caseState.caseId)}`,
    attempt: caseState.attempts + 1,
    inventory: [...matched.filter((e) => !extra.some((x) => x.name === e.name)), ...extra],
    uiTraps: input.uiTraps,
    appMapViews: input.appMapViews,
    churnProne: input.churnProne,
    oracleFiles: input.oracleFiles,
  };
  if (prev || caseState.retryNotes) {
    context.previousAttempt = {
      lastErrors: prev?.lastErrors ?? [],
      commits: prev?.commits ?? [],
      ...(prev?.digest !== undefined ? { digest: prev.digest } : {}),
      ...(caseState.retryNotes !== undefined ? { humanNotes: caseState.retryNotes } : {}),
    };
  }
  return context;
}
