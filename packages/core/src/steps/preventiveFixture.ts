/**
 * PREWENCYJNE FIXTURE'Y - sesje fixture-authora per churn-prone TYP, PRZED
 * partią autora. Jedna sesja na TYP dostarcza fixture wszystkim case'om typu,
 * zamiast by każdy case palił nieudaną próbę, by wybić bezpiecznik seedu.
 *
 * Różnice wobec ścieżki po fixture-gapie (steps/fixtureAuthor.ts):
 * - jednostką jest TYP, nie case (reprezentant wiezie kontekst sesji),
 * - fixture'y lądują na DEDYKOWANYM branchu greenproof/fixtures/<runId>,
 *   z którego wychodzą branche case'ów (state.fixturesRef),
 * - ŻADNYCH przejść stanu, retryNotes ani kredytów - nic nie zawiodło, a
 *   kredyty są walutą ścieżki po porażce.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { NormalizedPlan, PlanCase } from '../domain/plan.js';
import type { PomIndex, PomIndexEntry } from '../domain/harvest.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Ports } from '../ports/index.js';
import { emitProgress, summarizeRun } from '../domain/progress.js';
import { withState } from '../machine/withState.js';
import { casesInStatus } from '../machine/pipeline.js';
import { PLAN_ARTIFACT_KEY, safeCaseId } from './filter.js';
import {
  extraInventoryKey,
  loadFixtureContextBase,
  upsertExtraInventory,
  verifyFixtureScript,
} from './fixtureAuthor.js';
import { matchInventory, readPomIndex } from '../harvest/inventory.js';
import { effectiveChurnTypes, loadLearnedChurn } from '../knowledge/loader.js';
import {
  assertTestsRepoClean,
  checkoutCaseBranch,
  checkoutRef,
  commitAll,
  forceBranchHere,
  headSha,
  resetBranchTo,
} from '../util/localGit.js';
import {
  runFixtureSession,
  type FixtureSessionDeps,
  type FixtureSessionResult,
} from '../author/fixtureSession.js';

export interface PreventiveFixtureParams {
  runId: string;
  /** Jawna lista typów (pomija listę churn-prone z configu i nauczoną). */
  types?: string[];
  /** Wstrzykiwalny runner sesji (testy). */
  sessionRunner?: (deps: FixtureSessionDeps) => Promise<FixtureSessionResult>;
  workDir?: string;
}

export interface PreventiveTypeResult {
  type: string;
  status: 'delivered' | 'skipped' | 'failed';
  /** Case reprezentujący typ w sesji (brak przy pominięciu bez reprezentanta). */
  caseId?: string;
  fixture?: { name: string; path: string; covers: string[] };
  /** Powód pominięcia (status 'skipped'). */
  note?: string;
  /** Powód porażki (status 'failed'). */
  error?: string;
  costUsd: number;
  turns: number;
}

export interface PreventiveFixtureResult {
  types: PreventiveTypeResult[];
  costUsd: number;
  turns: number;
  /** Brak wpisów 'failed' - pominięcia są normalnym, dobrym wynikiem. */
  ok: boolean;
}

/** Branch, na którym żyje warstwa prewencyjnych fixture'ów tego przebiegu. */
export function fixturesBranchName(runId: string): string {
  return `greenproof/fixtures/${safeCaseId(runId)}`;
}

/** Bocznica na nieudaną sesję - praca zostaje do wglądu, wspólny branch czysty. */
function scrapBranchName(runId: string, type: string): string {
  return `greenproof/fixtures-failed/${safeCaseId(runId)}/${safeCaseId(type)}`;
}

/**
 * Reprezentant typu: pierwszy w planie z preferencją P0/P1 - wysoki priorytet
 * ma najlepiej opisany kontekst, a fixture i tak trafia do WSZYSTKICH case'ów.
 */
function representative(cases: PlanCase[]): PlanCase {
  return cases.find((c) => c.priority === 'P0' || c.priority === 'P1') ?? cases[0]!;
}

export async function runPreventiveFixtures(
  ports: Ports,
  config: GreenproofConfig,
  params: PreventiveFixtureParams,
): Promise<PreventiveFixtureResult> {
  const runner = params.sessionRunner ?? runFixtureSession;
  const planBuf = await ports.artifacts.get(params.runId, PLAN_ARTIFACT_KEY);
  if (!planBuf) throw new Error(`Missing plan artifact for run ${params.runId}`);
  const plan = JSON.parse(planBuf.toString('utf8')) as NormalizedPlan;

  // Odczyt bez mutacji - stan zapisujemy dopiero po udanej dostawie (CAS na typ).
  const pre = await withState(ports, params.runId, (state) => ({
    envUrl: state.envUrl,
    baseRef: state.baseRef,
    pending: new Set(casesInStatus(state, 'selected', 'triaged').map((c) => c.caseId)),
  }));

  const learned = await loadLearnedChurn(ports.scm, pre.baseRef, config, ports.logger);
  const churnTypes = params.types ? new Set(params.types) : effectiveChurnTypes(config, learned);

  // Grupowanie po typie w kolejności planu; tylko case'y czekające na autora
  // (selected/triaged) - dostarczone/zablokowane nic nie zyskają.
  const byType = new Map<string, PlanCase[]>();
  for (const pc of plan.cases) {
    if (pc.type === undefined || !churnTypes.has(pc.type) || !pre.pending.has(pc.caseId)) continue;
    const group = byType.get(pc.type);
    if (group) group.push(pc);
    else byType.set(pc.type, [pc]);
  }
  if (byType.size === 0) {
    ports.logger.info('Prewencyjne fixture\'y: brak case\'ów churn-prone w tym przebiegu - nic do zrobienia');
    return { types: [], costUsd: 0, turns: 0, ok: true };
  }

  const cwd = config.paths.testsRepoDir;
  // Prewencja jest zwykle PIERWSZą mutacją repo testów w przebiegu - bramka
  // czystości stoi tu (raz na partię), tak samo jak na wejściu autora.
  await assertTestsRepoClean(cwd, ports.logger);
  const fixturesBranch = fixturesBranchName(params.runId);
  const pomIndex = await readPomIndex(ports.scm, pre.baseRef, config);

  const ctx: PreventiveCtx = {
    ports, config, runId: params.runId, runner, cwd, fixturesBranch, pomIndex,
    envUrl: pre.envUrl, baseRef: pre.baseRef, delivered: [],
    ...(params.workDir !== undefined ? { workDir: params.workDir } : {}),
  };
  const results: PreventiveTypeResult[] = [];
  for (const [type, cases] of byType) {
    results.push(await preventiveOneType(ctx, type, cases));
  }

  return {
    types: results,
    costUsd: results.reduce((s, r) => s + r.costUsd, 0),
    turns: results.reduce((s, r) => s + r.turns, 0),
    ok: !results.some((r) => r.status === 'failed'),
  };
}

/** Stałe otoczenie jednej partii prewencyjnej - wspólne dla wszystkich typów. */
interface PreventiveCtx {
  ports: Ports;
  config: GreenproofConfig;
  runId: string;
  runner: (deps: FixtureSessionDeps) => Promise<FixtureSessionResult>;
  cwd: string;
  fixturesBranch: string;
  pomIndex: PomIndex;
  envUrl: string;
  baseRef: string;
  /** Fixture'y dostarczone przez WCZEŚNIEJSZE typy tej partii (kolejne mają ich nie dublować). */
  delivered: PomIndexEntry[];
  workDir?: string;
}

/** Otoczka zdarzeń postępu: jeden typ = para step start/end, niezależnie od gałęzi. */
async function preventiveOneType(
  ctx: PreventiveCtx,
  type: string,
  cases: PlanCase[],
): Promise<PreventiveTypeResult> {
  const { ports, runId } = ctx;
  const name = `preventive:${type}`;
  emitProgress(ports.progress, {
    kind: 'step',
    runId,
    at: ports.clock.now().toISOString(),
    name,
    phase: 'start',
  });
  const result = await deliverPreventiveType(ctx, type, cases);
  emitProgress(ports.progress, {
    kind: 'step',
    runId,
    at: ports.clock.now().toISOString(),
    name,
    phase: 'end',
    note:
      result.status === 'delivered'
        ? `fixture: ${result.fixture?.path ?? '?'}`
        : result.status === 'skipped'
          ? `skip: ${result.note ?? '-'}`
          : 'failed',
  });
  return result;
}

async function deliverPreventiveType(
  ctx: PreventiveCtx,
  type: string,
  cases: PlanCase[],
): Promise<PreventiveTypeResult> {
  const { ports, config, runId, cwd } = ctx;
  const rep = representative(cases);
  const base: PreventiveTypeResult = { type, caseId: rep.caseId, costUsd: 0, turns: 0, status: 'skipped' };

  // Bramka pokrycia - dwa powody, by nie płacić za sesję: (1) inwentarz ma już
  // fixture dla flow reprezentanta, (2) ten przebieg dostarczył go wcześniej.
  const covering = matchInventory(ctx.pomIndex, rep).filter((e) => e.kind === 'fixture');
  if (covering.length > 0) {
    const note = `Inwentarz pokrywa już flow ${rep.flows.join(', ')}: ${covering.map((e) => e.name).join(', ')}`;
    ports.logger.info(`Prewencyjny fixture ${type}: pominięty - ${note}`);
    return { ...base, note };
  }
  if ((await ports.artifacts.get(runId, extraInventoryKey(rep.caseId))) !== null) {
    const note = `Fixture dla ${rep.caseId} dostarczono już w tym przebiegu`;
    ports.logger.info(`Prewencyjny fixture ${type}: pominięty - ${note}`);
    return { ...base, note };
  }

  // Warstwa rośnie na JEDNYM branchu z baseRef: kolejne typy dokładają się,
  // branche case'ów wychodzą z całości.
  await checkoutCaseBranch(cwd, ctx.fixturesBranch, ctx.baseRef);

  const attemptDir = join(
    ctx.workDir ?? join(cwd, '.greenproof-runs', runId),
    safeCaseId(rep.caseId),
    'preventive-fixture',
  );

  // Cykl życia dla rendererów: bez case-start długa sesja wygląda na bezczynność.
  // Status case-end to zawsze 'triaged' - prewencja nie zmienia stanów case'ów.
  const startRollup = summarizeRun((await ports.state.load(runId))!.state);
  const fixtureCaps = config.caps.fixtureSession;
  emitProgress(ports.progress, {
    kind: 'case-start',
    runId,
    at: ports.clock.now().toISOString(),
    caseId: rep.caseId,
    attempt: 0,
    ...(config.model.fixtureAuthor !== undefined ? { model: config.model.fixtureAuthor.model } : {}),
    caps: {
      maxTurns: fixtureCaps.maxTurns,
      maxTimeMinutes: fixtureCaps.maxTimeMinutes,
      maxCostUsd: fixtureCaps.maxCostUsd,
      maxPlaywrightRuns: 0,
      proofRuns: 0,
    },
    rollup: startRollup,
  });
  // Rollup do case-end: startowy dopóki nic nie ruszyło stanu, potem ten po
  // ostatnim zapisie (koszt sesji, fixturesRef).
  let rollupNow = startRollup;
  const emitEnd = (spent: { costUsd: number; turns: number }, rollup = rollupNow): void => {
    emitProgress(ports.progress, {
      kind: 'case-end',
      runId,
      at: ports.clock.now().toISOString(),
      caseId: rep.caseId,
      attempt: 0,
      status: 'triaged',
      ...spent,
      rollup,
    });
  };

  let session: FixtureSessionResult;
  try {
    const contextBase = await loadFixtureContextBase(ports, config, ctx.baseRef, rep.flows, ctx.pomIndex);
    session = await ctx.runner({
      config,
      context: {
        caseId: rep.caseId,
        flows: rep.flows,
        envUrl: ctx.envUrl,
        // Nic jeszcze nie zawiodło: brak nieudanych strategii i brak digestu.
        failedStrategies: [],
        ...contextBase,
        inventory: [...contextBase.inventory, ...ctx.delivered],
      },
      secrets: ports.secrets,
      logger: ports.logger,
      cwd,
      attemptDir,
      runId,
      // Sesja prewencyjna nie należy do żadnej próby autora - attempt 0.
      attempt: 0,
      ...(ports.progress !== undefined ? { onProgress: ports.progress } : {}),
    });
  } catch (err) {
    // Sesja rzuciła zamiast zwrócić wynik - koszt jest NIEZNANY (runner rzuca
    // tylko wtedy, gdy pętla SDK padła przed resultem), więc zero.
    await parkFailedSession(ctx, type);
    ports.logger.error(`Prewencyjna sesja fixture dla typu ${type} padła`, err);
    emitEnd({ costUsd: 0, turns: 0 });
    return { ...base, status: 'failed', error: String(err) };
  }

  // Sesja się ODBYŁA - jej koszt idzie do sumy przebiegu NATYCHMIAST, przed
  // weryfikacją, commitem i wpisami do inwentarza. Każdy z tych kroków może
  // skończyć się porażką albo wyjątkiem, a realnie wydane pieniądze nie mogą
  // wtedy wyparować z sumy runu. Koszt WYŁĄCZNIE do state.totals: doliczenie
  // reprezentantowi zjadałoby jego cap per case przed pierwszą próbą, a sesja
  // pracuje na cały TYP, nie na jeden case.
  rollupNow = await withState(ports, runId, (state) => {
    state.totals.costUsd += session.costUsd;
    return summarizeRun(state);
  });

  // Transcript do artefaktów (pod reprezentantem - tam szuka go człowiek).
  try {
    const messages = await readFile(session.messagesPath, 'utf8');
    await ports.artifacts.put(
      runId,
      `cases/${safeCaseId(rep.caseId)}/preventive-fixture.messages.jsonl`,
      Buffer.from(messages),
    );
  } catch { /* brak transcriptu nie blokuje */ }

  const spent = { costUsd: session.costUsd, turns: session.turns };
  const fail = async (reason: string): Promise<PreventiveTypeResult> => {
    const error = session.cappedBy !== undefined ? `${reason} [przerwane: ${session.cappedBy}]` : reason;
    await parkFailedSession(ctx, type);
    ports.logger.warn(`Prewencyjny fixture ${type}: ${error}`);
    emitEnd(spent);
    return { ...base, ...spent, status: 'failed', error };
  };

  const out = session.structured;
  if (!out || out.status !== 'delivered' || !out.fixturePath || !out.verifyScriptPath || !out.name) {
    return fail(
      `Sesja nie dostarczyła kompletnego fixture (status=${out?.status ?? session.resultSubtype})${out?.notes ? `: ${out.notes}` : ''}`,
    );
  }

  const verify = await verifyFixtureScript(cwd, out.verifyScriptPath, ctx.envUrl);
  if (verify.exitCode !== 0) {
    return fail(`Skrypt weryfikacyjny ${out.verifyScriptPath} zakończył się kodem ${verify.exitCode}`);
  }

  // Odbiór OK: commit na branchu fixture'ów + wpis do inwentarza KAŻDEGO case'a
  // tego typu.
  const preCommitSha = await headSha(cwd);
  await commitAll(cwd, `[preventive:${type}] fixture-author: ${out.name} (zweryfikowany)`);

  let fixture: PreventiveTypeResult['fixture'];
  // Migawki do rollbacku: porażka wpisu nie może zostawić wpisów wskazujących
  // na cofnięty fixture.
  const written: { caseId: string; prev: Buffer | null }[] = [];
  try {
    for (const pc of cases) {
      written.push({ caseId: pc.caseId, prev: await ports.artifacts.get(runId, extraInventoryKey(pc.caseId)) });
      const entry = await upsertExtraInventory(ports, runId, pc.caseId, {
        name: out.name,
        path: out.fixturePath,
        kind: 'fixture',
        description: out.description ?? `Fixture seedu dla ${rep.flows.join(', ')}`,
        covers: out.covers && out.covers.length > 0 ? out.covers : rep.flows,
        keySelectors: [],
        harvestedBy: `preventive-fixture:${type}`,
      });
      if (fixture === undefined) {
        fixture = { name: entry.name, path: entry.path, covers: entry.covers };
        ctx.delivered.push(entry);
      }
    }
  } catch (err) {
    // Np. nazwa wpisu odrzucona przez walidację - fixture scommitowany, ale bez
    // wpisu nikt go nie użyje, więc to porażka typu. Commit NIE może zostać na
    // wspólnym branchu: fixturesRef wciągnąłby niezarejestrowane pliki do
    // KAŻDEGO brancha case'a. Odstawiamy na bocznicę i cofamy branch.
    ports.logger.warn(`Prewencyjny fixture ${type}: wpis do inwentarza odrzucony`, err);
    // Rollback wpisów - inaczej triaż karmiłby case'y fixture'em, którego nie ma
    // na fixturesRef.
    for (const w of written) {
      try {
        if (w.prev !== null) await ports.artifacts.put(runId, extraInventoryKey(w.caseId), w.prev);
        else if (ports.artifacts.delete) await ports.artifacts.delete(runId, extraInventoryKey(w.caseId));
        // Brak delete: pusty indeks NIE wchodzi w grę (bramka myli go z pokryciem).
        else ports.logger.warn(`Brak delete w ArtifactStore - wpis extra-inventory ${w.caseId} do ręcznego usunięcia`);
      } catch (rollbackErr) {
        ports.logger.warn(`Rollback extra-inventory ${w.caseId} nie powiódł się`, rollbackErr);
      }
    }
    if (fixture !== undefined) ctx.delivered.pop();
    try {
      await forceBranchHere(cwd, scrapBranchName(runId, type));
      await resetBranchTo(cwd, ctx.fixturesBranch, preCommitSha);
      await checkoutRef(cwd, ctx.baseRef);
    } catch (gitErr) {
      ports.logger.warn(`Nie udało się cofnąć commita fixture (${type}) z brancha wspólnego`, gitErr);
    }
    emitEnd(spent);
    return { ...base, ...spent, status: 'failed', error: String(err) };
  }

  const doneRollup = await withState(ports, runId, (state) => {
    // Ref ustawiany RAZ (pierwszy udany typ). Koszt sesji jest już policzony
    // (zapis zaraz po jej zakończeniu, niezależnie od wyniku).
    state.fixturesRef ??= ctx.fixturesBranch;
    return summarizeRun(state);
  });
  emitEnd(spent, doneRollup);

  ports.logger.info(
    `Prewencyjny fixture ${type}: dostarczono "${out.name}" dla ${cases.length} case'ów (${ctx.fixturesBranch})`,
  );
  return { ...base, ...spent, status: 'delivered', ...(fixture !== undefined ? { fixture } : {}) };
}

/**
 * Nieudana sesja zostawia niedokończoną pracę. Odstawiamy ją na bocznicę i
 * wracamy na baseRef: wspólny branch nie łapie śmieci, które trafiłyby do
 * KAŻDEGO brancha case'a.
 */
async function parkFailedSession(ctx: PreventiveCtx, type: string): Promise<void> {
  try {
    await forceBranchHere(ctx.cwd, scrapBranchName(ctx.runId, type));
    await commitAll(ctx.cwd, `[preventive:${type}] nieudana sesja fixture (praca do wglądu)`);
    await checkoutRef(ctx.cwd, ctx.baseRef);
  } catch (err) {
    ctx.ports.logger.warn(`Nie udało się odstawić nieudanej sesji fixture (${type})`, err);
  }
}
