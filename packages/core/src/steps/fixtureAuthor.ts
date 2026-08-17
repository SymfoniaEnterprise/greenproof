/**
 * FIXTURE-AUTHOR - samodzielna ścieżka wyjścia z fixture-gap: wąska sesja
 * (opcjonalnie mocniejszym modelem) dostarcza fixture seedu, pipeline odbiera
 * go DETERMINISTYCZNIE (skrypt weryfikacyjny musi wyjść kodem 0 przeciwko
 * żywej aplikacji), a case wraca do triaged gotowy na retry taniego autora.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { NormalizedPlan } from '../domain/plan.js';
import type { PomIndex, PomIndexEntry } from '../domain/harvest.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Ports } from '../ports/index.js';
import { emitProgress, summarizeRun } from '../domain/progress.js';
import { withState } from '../machine/withState.js';
import { getCase, transitionCase } from '../machine/pipeline.js';
import { PLAN_ARTIFACT_KEY, safeCaseId } from './filter.js';
import { readPomIndex, upsertEntry, type RegisterEntryInput } from '../harvest/inventory.js';
import { lastAttempt, readLedger } from '../ledger/store.js';
import {
  effectiveChurnTypes,
  loadAppMap,
  loadLearnedChurn,
  loadUiTraps,
  trapsForFlows,
  viewsForFlows,
} from '../knowledge/loader.js';
import { assertTestsRepoClean, checkoutCaseBranch, commitAll } from '../util/localGit.js';
import {
  runFixtureSession,
  type FixtureContext,
  type FixtureSessionDeps,
  type FixtureSessionResult,
} from '../author/fixtureSession.js';

const execFileP = promisify(execFile);

export interface FixtureParams {
  runId: string;
  caseId: string;
  /** Wstrzykiwalny runner sesji (testy). */
  sessionRunner?: (deps: FixtureSessionDeps) => Promise<FixtureSessionResult>;
  workDir?: string;
}

export interface FixtureResult {
  ok: boolean;
  caseId: string;
  fixture?: { name: string; path: string; covers: string[] };
  verify?: { exitCode: number; output: string };
  error?: string;
  costUsd: number;
  turns: number;
}

/** Klucz artefaktu z dodatkowym inwentarzem per case (merge'owany w triażu). */
export function extraInventoryKey(caseId: string): string {
  return `cases/${safeCaseId(caseId)}/extra-inventory.json`;
}

/**
 * Dokumentacja aplikacji (appDocs) przez port SCM - agnostycznie wobec
 * platformy. Suma przycięta do maxChars; brakujące pliki tylko logujemy
 * (dokumentacja jest pomocą, nie warunkiem).
 */
async function loadAppDocs(
  ports: Ports,
  baseRef: string,
  config: GreenproofConfig,
): Promise<{ path: string; content: string }[] | undefined> {
  const appDocs = config.appDocs;
  if (!appDocs) return undefined;
  const docs: { path: string; content: string }[] = [];
  let budget = appDocs.maxChars;
  for (const path of appDocs.paths) {
    if (budget <= 0) break;
    const content = await ports.scm.readFile(baseRef, path);
    if (content === null) {
      ports.logger.warn(`appDocs: brak pliku ${path} na ${baseRef} - pomijam`);
      continue;
    }
    docs.push({ path, content: content.slice(0, budget) });
    budget -= content.length;
  }
  return docs.length > 0 ? docs : undefined;
}

/**
 * Kontekst sesji fixture NIEZALEŻNY od ledgera (wiedza projektowa, inwentarz,
 * dokumentacja). Ścieżka prewencyjna używa tego samego - bez historii prób
 * (failedStrategies puste, brak digestu).
 */
export type FixtureContextBase = Pick<
  FixtureContext,
  'appMapViews' | 'uiTraps' | 'inventory' | 'fixturesDir' | 'docs'
>;

export async function loadFixtureContextBase(
  ports: Ports,
  config: GreenproofConfig,
  ref: string,
  flows: string[],
  /** Wczytany wcześniej indeks POM (oszczędza powtórny odczyt przy wielu typach). */
  pomIndex?: PomIndex,
): Promise<FixtureContextBase> {
  const [traps, appMap, inventory, docs] = await Promise.all([
    loadUiTraps(ports.scm, ref, config, ports.logger),
    loadAppMap(ports.scm, ref, config, ports.logger),
    pomIndex ?? readPomIndex(ports.scm, ref, config),
    loadAppDocs(ports, ref, config),
  ]);
  return {
    appMapViews: viewsForFlows(appMap, flows),
    uiTraps: trapsForFlows(traps, flows),
    inventory: inventory.entries,
    fixturesDir: config.paths.fixturesDir,
    ...(docs !== undefined ? { docs } : {}),
  };
}

/**
 * DETERMINISTYCZNY odbiór: `node <skrypt> <envUrl>` przeciwko żywej aplikacji.
 * Kod !== 0 (albo brak skryptu) = fixture nie działa - deklaracja agenta nie wystarcza.
 */
export async function verifyFixtureScript(
  cwd: string,
  verifyScriptPath: string,
  envUrl: string,
): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileP('node', [verifyScriptPath, envUrl], {
      cwd, timeout: 90_000, maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, output: `${stdout}\n${stderr}`.trim().slice(0, 2_000) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      output: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim().slice(0, 2_000),
    };
  }
}

/**
 * Dopisuje fixture do extra-inwentarza case'a (triaż go merge'uje). Klucz to
 * nazwa wpisu - powtórna dostawa nadpisuje poprzednią.
 */
export async function upsertExtraInventory(
  ports: Ports,
  runId: string,
  caseId: string,
  input: RegisterEntryInput,
): Promise<PomIndexEntry> {
  const fresh = upsertEntry({ version: 1, entries: [] }, input, ports.clock);
  const existingBuf = await ports.artifacts.get(runId, extraInventoryKey(caseId));
  const existing: PomIndex = existingBuf
    ? (JSON.parse(existingBuf.toString('utf8')) as PomIndex)
    : { version: 1, entries: [] };
  const merged: PomIndex = {
    version: 1,
    entries: [...existing.entries.filter((e) => e.name !== input.name), ...fresh.entries],
  };
  await ports.artifacts.put(runId, extraInventoryKey(caseId), Buffer.from(JSON.stringify(merged, null, 2)));
  return merged.entries.find((e) => e.name === input.name)!;
}

export async function runFixtureAuthor(
  ports: Ports,
  config: GreenproofConfig,
  params: FixtureParams,
): Promise<FixtureResult> {
  const runner = params.sessionRunner ?? runFixtureSession;
  // Ten krok też przełącza branche i robi `git add -A`. W ścieżce eskalacji
  // stoi za bramką autora, ale `gp fixture --case <id>` wywołane wprost
  // startuje bez niej - i bez tego sprawdzenia zamiatałoby cudzą pracę.
  await assertTestsRepoClean(config.paths.testsRepoDir, ports.logger);
  const planBuf = await ports.artifacts.get(params.runId, PLAN_ARTIFACT_KEY);
  if (!planBuf) throw new Error(`Missing plan artifact for run ${params.runId}`);
  const plan = JSON.parse(planBuf.toString('utf8')) as NormalizedPlan;
  const pc = plan.cases.find((c) => c.caseId === params.caseId);
  if (!pc) throw new Error(`Case ${params.caseId} not present in plan`);

  // Warunek wejścia + zebranie kontekstu - bez mutacji stanu (sesja może trwać długo).
  const pre = await withState(ports, params.runId, async (state) => {
    const cs = getCase(state, params.caseId);
    if (cs.status !== 'blocked' || cs.blockedReason !== 'fixture-gap') {
      throw new Error(
        `Fixture-author działa tylko dla case'ów blocked(fixture-gap); ${params.caseId} jest ${cs.status}(${cs.blockedReason ?? '-'})`,
      );
    }
    return {
      envUrl: state.envUrl,
      baseRef: state.baseRef,
      fixturesRef: state.fixturesRef,
      branch: cs.branch ?? `author/${safeCaseId(params.caseId)}`,
      /** Próba autora, po której zawiódł seed - kotwica zdarzeń postępu. */
      attempt: cs.attempts,
      rollup: summarizeRun(state),
    };
  });

  // Cykl życia dla rendererów: bez case-start sesja fixture wygląda na bezczynność.
  const fixtureCaps = config.caps.fixtureSession;
  emitProgress(ports.progress, {
    kind: 'case-start',
    runId: params.runId,
    at: ports.clock.now().toISOString(),
    caseId: params.caseId,
    attempt: pre.attempt,
    ...(config.model.fixtureAuthor !== undefined ? { model: config.model.fixtureAuthor.model } : {}),
    caps: {
      maxTurns: fixtureCaps.maxTurns,
      maxTimeMinutes: fixtureCaps.maxTimeMinutes,
      maxCostUsd: fixtureCaps.maxCostUsd,
      maxPlaywrightRuns: 0,
      proofRuns: 0,
    },
    rollup: pre.rollup,
  });

  const cwd = config.paths.testsRepoDir;
  // Branch case'a z warstwy prewencyjnej (jeśli powstała) - sesja widzi fixture'y
  // dostarczone przed partią.
  await checkoutCaseBranch(cwd, pre.branch, pre.fixturesRef ?? pre.baseRef);

  const [ledger, learned, base] = await Promise.all([
    readLedger(ports.artifacts, params.runId, params.caseId),
    loadLearnedChurn(ports.scm, pre.baseRef, config, ports.logger),
    loadFixtureContextBase(ports, config, pre.baseRef, pc.flows),
  ]);
  void effectiveChurnTypes(config, learned);
  const prev = lastAttempt(ledger);
  const failedStrategies = ledger.flatMap((r) => (r.seedAttempts ?? []).filter((s) => s.outcome === 'failed'));

  const attemptDir = join(
    params.workDir ?? join(cwd, '.greenproof-runs', params.runId),
    safeCaseId(params.caseId),
    'fixture-session',
  );

  const session = await runner({
    config,
    context: {
      caseId: params.caseId,
      flows: pc.flows,
      envUrl: pre.envUrl,
      failedStrategies,
      ...(prev?.digest !== undefined ? { digest: prev.digest } : {}),
      ...base,
    },
    secrets: ports.secrets,
    logger: ports.logger,
    cwd,
    attemptDir,
    runId: params.runId,
    attempt: pre.attempt,
    ...(ports.progress !== undefined ? { onProgress: ports.progress } : {}),
  });

  // Sesja się ODBYŁA - jej koszt trafia do stanu NATYCHMIAST, przed
  // weryfikacją, commitem i wpisem do inwentarza. Każdy z tych kroków może
  // skończyć się porażką albo wyjątkiem, a realnie wydane pieniądze nie mogą
  // wtedy wyparować z sumy przebiegu (to ona jest kosztem runu w rollupie,
  // raportach i tabelach benchmarków). Pole to samo co u autora
  // (cs.costUsd + state.totals.costUsd) - sesja pracowała na tym case'ie,
  // więc obciąża jego budżet, tak jak przy dostawie fixture'a.
  const spentRollup = await withState(ports, params.runId, (state) => {
    const cs = getCase(state, params.caseId);
    cs.costUsd += session.costUsd;
    state.totals.costUsd += session.costUsd;
    return summarizeRun(state);
  });

  try {
    const messages = await readFile(session.messagesPath, 'utf8');
    await ports.artifacts.put(
      params.runId,
      `cases/${safeCaseId(params.caseId)}/fixture-session.messages.jsonl`,
      Buffer.from(messages),
    );
  } catch { /* brak transcriptu nie blokuje */ }

  const fail = async (reason: string, verify?: FixtureResult['verify']): Promise<FixtureResult> => {
    // Powód przerwania przez liczniki trafia do komunikatu - inaczej 'infra'
    // wygląda jak porażka merytoryczna.
    const error = session.cappedBy !== undefined ? `${reason} [przerwane: ${session.cappedBy}]` : reason;
    ports.logger.warn(`Fixture-author ${params.caseId}: ${error}`);
    // Case zostaje blocked, ale koszt sesji jest już w stanie - rollup po
    // zapisie kosztu (spentRollup), nie ten sprzed sesji.
    emitProgress(ports.progress, {
      kind: 'case-end',
      runId: params.runId,
      at: ports.clock.now().toISOString(),
      caseId: params.caseId,
      attempt: pre.attempt,
      status: 'blocked',
      blockedReason: 'fixture-gap',
      costUsd: session.costUsd,
      turns: session.turns,
      rollup: spentRollup,
    });
    return {
      ok: false, caseId: params.caseId, error,
      ...(verify !== undefined ? { verify } : {}),
      costUsd: session.costUsd, turns: session.turns,
    };
  };

  const out = session.structured;
  if (!out || out.status !== 'delivered' || !out.fixturePath || !out.verifyScriptPath || !out.name) {
    return fail(
      `Sesja nie dostarczyła kompletnego fixture (status=${out?.status ?? session.resultSubtype})${out?.notes ? `: ${out.notes}` : ''}`,
    );
  }

  // DETERMINISTYCZNY odbiór: skrypt weryfikacyjny przeciwko żywej aplikacji.
  const verify = await verifyFixtureScript(cwd, out.verifyScriptPath, pre.envUrl);
  if (verify.exitCode !== 0) {
    return fail(`Skrypt weryfikacyjny ${out.verifyScriptPath} zakończył się kodem ${verify.exitCode}`, verify);
  }

  // Odbiór OK: commit na branchu case'a + wpis do dodatkowego inwentarza case'a.
  await commitAll(cwd, `[${params.caseId}] fixture-author: ${out.name} (zweryfikowany)`);

  const fixtureEntry = await upsertExtraInventory(ports, params.runId, params.caseId, {
    name: out.name,
    path: out.fixturePath,
    kind: 'fixture',
    description: out.description ?? `Fixture seedu dla ${pc.flows.join(', ')}`,
    covers: out.covers && out.covers.length > 0 ? out.covers : pc.flows,
    keySelectors: [],
    harvestedBy: `fixture-author:${params.caseId}`,
  });

  // Case wraca do triaged z gotową wskazówką dla retry autora.
  const doneRollup = await withState(ports, params.runId, (state) => {
    transitionCase(state, params.caseId, 'triaged', {
      retryNotes: `Fixture-author dostarczył zweryfikowany fixture "${out.name}" (${out.fixturePath}) - użyj go do seedu ZAMIAST odkrywania. Zweryfikowany wywołaniem: node ${out.verifyScriptPath} <envUrl>.`,
    });
    const cs = getCase(state, params.caseId);
    delete cs.blockedReason;
    delete cs.blockedNote;
    // Kredyt POZA maxAutoRetries: odkrycie fixture'a jest opłacone, więc tania
    // próba autora z gotowym seedem należy się zawsze.
    cs.fixtureRetryCredits = (cs.fixtureRetryCredits ?? 0) + 1;
    // Koszt sesji jest już policzony (zapis zaraz po jej zakończeniu).
    return summarizeRun(state);
  });
  emitProgress(ports.progress, {
    kind: 'case-end',
    runId: params.runId,
    at: ports.clock.now().toISOString(),
    caseId: params.caseId,
    attempt: pre.attempt,
    status: 'triaged',
    costUsd: session.costUsd,
    turns: session.turns,
    rollup: doneRollup,
  });

  return {
    ok: true,
    caseId: params.caseId,
    fixture: { name: fixtureEntry.name, path: fixtureEntry.path, covers: fixtureEntry.covers },
    verify,
    costUsd: session.costUsd,
    turns: session.turns,
  };
}
