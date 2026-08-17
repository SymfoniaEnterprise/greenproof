/**
 * AUTHOR - orkiestracja sesji agenta per case, sekwencyjnie. Checkpoint stanu
 * po każdym casie (CAS), lease chroni przed równoległym przejęciem, a po
 * padzie runnera wygasły lease + commity na branchu pozwalają wznowić bez
 * utraty pracy. Tu też zapada deterministyczny werdykt dowodu mutacyjnego.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AttemptRecord, AuthorPhase, PhaseStats } from '../domain/attempt.js';
import type { BlockedReason, CaseState, CaseStatus } from '../domain/state.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Ports } from '../ports/index.js';
import { emitProgress, summarizeRun, type RunRollup } from '../domain/progress.js';
import { withState } from '../machine/withState.js';
import { acquireLease, casesInStatus, getCase, releaseLease, transitionCase } from '../machine/pipeline.js';
import {
  runAuthorSession,
  type AuthorSessionOptions,
  type AuthorSessionResult,
} from '../author/session.js';
import { validateProof } from '../proof/validator.js';
import { appendAttempt } from '../ledger/store.js';
import { generateDigest } from '../ledger/digest.js';
import { runTriage, contextKey, type CaseContext } from './triage.js';
import { proofArtifactKey, specArtifactKey } from './deliver.js';
import { shareCaseHarvest } from '../harvest/share.js';
import { safeCaseId } from './filter.js';
import {
  assertTestsRepoClean,
  checkoutCaseBranch,
  commitAll,
  commitsSince,
  fetchRefBestEffort,
  headSha,
  isWorktreeClean,
  refExists,
} from '../util/localGit.js';

export interface AuthorParams {
  runId: string;
  /** Podzbiór case'ów (domyślnie wszystkie w stanie triaged). */
  caseIds?: string[];
  /** Identyfikator joba trzymającego lease (domyślnie greenproof-<pid>). */
  owner?: string;
  /** Katalog roboczy na pliki prób (transcripty, output playwright). */
  workDir?: string;
  /** Wstrzykiwalny runner sesji (testy) - nie wystawiany przez CLI. */
  sessionRunner?: (opts: AuthorSessionOptions) => Promise<AuthorSessionResult>;
}

export interface AuthorCaseResult {
  caseId: string;
  status: CaseStatus;
  costUsd: number;
  turns: number;
  blockedReason?: BlockedReason;
}

export interface AuthorResult {
  results: AuthorCaseResult[];
}

const LEASE_TTL_MINUTES = 45;

/** Pule, z których może pochodzić ponowienie po attempt_failed. */
type RetryPool = 'infra' | 'fixture' | 'regular';

const RETRY_POOL_LABEL: Readonly<Record<RetryPool, string>> = {
  infra: 'Ponowienie po awarii infrastruktury (poza budżetem auto-retry)',
  fixture: 'Auto-retry z puli po fixture-authorze',
  regular: 'Auto-retry',
};

/**
 * Zużyte zwykłe auto-retry. Stany sprzed jawnej puli wyliczamy z attempts, żeby
 * stary stan NIE dostał darmowych ponowień; po pierwszej decyzji pole jest
 * materializowane (attempts liczy też próby 'infra').
 */
function autoRetriesUsed(cs: CaseState): number {
  return cs.autoRetriesUsed ?? Math.max(0, cs.attempts - 1);
}

/**
 * Test treści przywrócenia: żadna DODANA linia diffa mutacji nie może
 * występować w plikach z nagłówków diffa (fallback: specPath). Odporne na brak
 * dyscypliny commitowej agenta.
 */
export async function checkMutationRestoredByContent(
  cwd: string,
  mutationDiff: string,
  specPath: string | undefined,
): Promise<boolean> {
  const files = new Set<string>();
  for (const m of mutationDiff.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]!.trim());
  if (files.size === 0 && specPath) files.add(specPath);
  if (files.size === 0) return false;

  const mutatedLines = mutationDiff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1).trim())
    .filter((l) => l.length >= 6);
  if (mutatedLines.length === 0) return false;

  let contents = '';
  for (const file of files) {
    try {
      contents += `\n${await readFile(join(cwd, file), 'utf8')}`;
    } catch {
      /* plik mógł zostać usunięty przy przywracaniu */
    }
  }
  const normalized = contents.replace(/\s+/g, ' ');
  return mutatedLines.every((l) => !normalized.includes(l.replace(/\s+/g, ' ')));
}

export async function runAuthor(
  ports: Ports,
  config: GreenproofConfig,
  params: AuthorParams,
): Promise<AuthorResult> {
  const owner = params.owner ?? `greenproof-${process.pid}`;
  const workDir = params.workDir ?? join(config.paths.testsRepoDir, '.greenproof-runs', params.runId);

  // Lista celów czytana raz; obejmuje też case'y porzucone w 'authoring'
  // (wygasły lease przejmie authorOneCase).
  const targets = await withState(ports, params.runId, (state) => {
    const pending = casesInStatus(state, 'triaged', 'authoring').map((c) => c.caseId);
    return params.caseIds ? pending.filter((id) => params.caseIds!.includes(id)) : pending;
  });

  // Bramka czystości PRZED pierwszą mutacją repo testów i tylko wtedy, gdy jest
  // co robić: pusta partia niczego nie dotyka. RAZ na partię - nie per case.
  if (targets.length > 0) {
    await assertTestsRepoClean(config.paths.testsRepoDir, ports.logger);
  }

  const ctx: AuthorCaseCtx = {
    ports,
    config,
    runId: params.runId,
    owner,
    workDir,
    runner: params.sessionRunner ?? runAuthorSession,
  };
  const results: AuthorCaseResult[] = [];
  for (const caseId of targets) {
    results.push(await authorOneCase(ctx, caseId));
  }
  return { results };
}

/** Stałe otoczenie jednej partii autora - wspólne dla wszystkich case'ów. */
interface AuthorCaseCtx {
  ports: Ports;
  config: GreenproofConfig;
  runId: string;
  owner: string;
  workDir: string;
  runner: (opts: AuthorSessionOptions) => Promise<AuthorSessionResult>;
}

async function authorOneCase(ctx: AuthorCaseCtx, caseId: string): Promise<AuthorCaseResult> {
  const { ports, config, runId, owner, workDir, runner } = ctx;
  // Faza 1: lease + przejście do authoring (checkpoint przed sesją).
  const pre = await withState(ports, runId, async (state) => {
    const cs = getCase(state, caseId);
    if (cs.status !== 'triaged' && cs.status !== 'authoring') {
      return { skip: { caseId, status: cs.status, costUsd: cs.costUsd, turns: 0 } };
    }
    // acquireLease: aktywny cudzy lease rzuca; wygasły przejmowany, porzucone
    // 'authoring' wraca do 'triaged'.
    const { reclaimed } = acquireLease(state, caseId, owner, LEASE_TTL_MINUTES, ports.clock);
    if (reclaimed) {
      ports.logger.warn(`Przejęto wygasły lease case'a ${caseId} - poprzedni run padł`);
    }
    if (cs.status !== 'triaged') {
      // 'authoring' z żywym lease'em tego samego ownera - nie dublujemy.
      return { skip: { caseId, status: cs.status, costUsd: cs.costUsd, turns: 0 } };
    }
    transitionCase(state, caseId, 'authoring');
    return {
      env: {
        envUrl: state.envUrl,
        baseRef: state.baseRef,
        fixturesRef: state.fixturesRef,
        attempt: cs.attempts + 1,
        branch: cs.branch ?? `author/${safeCaseId(caseId)}`,
        // Rollup PO przejściu - renderer widzi case'a jako w toku.
        rollup: summarizeRun(state),
      },
    };
  });
  if ('skip' in pre && pre.skip) return pre.skip;
  const { envUrl, baseRef, fixturesRef, attempt, branch, rollup } = pre.env!;
  void envUrl;

  const caps = config.caps;
  emitProgress(ports.progress, {
    kind: 'case-start',
    runId,
    at: ports.clock.now().toISOString(),
    caseId,
    attempt,
    model: config.model.author,
    caps: {
      maxTurns: caps.maxTurns,
      maxTimeMinutes: caps.maxTimeMinutes,
      maxCostUsd: caps.maxCostUsd,
      maxPlaywrightRuns: caps.maxPlaywrightRuns,
      proofRuns: caps.proofRuns,
    },
    rollup,
  });

  /** Jedno domknięcie case-end - ten sam kształt w każdej ścieżce. */
  const emitCaseEnd = (e: {
    status: CaseStatus;
    blockedReason?: BlockedReason;
    costUsd: number;
    turns: number;
    rollup: RunRollup;
  }): void => {
    emitProgress(ports.progress, {
      kind: 'case-end',
      runId,
      at: ports.clock.now().toISOString(),
      caseId,
      attempt,
      ...e,
    });
  };

  const attemptId = `attempt-${attempt}`;
  const attemptDir = join(workDir, safeCaseId(caseId), attemptId);
  const cwd = config.paths.testsRepoDir;

  const startedAt = ports.clock.now().toISOString();
  let session: AuthorSessionResult;
  let baseSha: string;
  let context: CaseContext;
  try {
    // Branch case'a: istniejący = kontynuacja. Wychodzi z warstwy prewencyjnych
    // fixture'ów (inaczej sesja nie widzi fixture'ów opłaconych przed partią).
    // Na adapterze API-only (GitHub) wspólny branch jest tylko ZDALNIE - dociągamy
    // best-effort, a gdy się nie uda, case startuje z baseRef.
    let checkoutBase = fixturesRef ?? baseRef;
    if (fixturesRef !== undefined && !(await refExists(cwd, fixturesRef))) {
      await fetchRefBestEffort(cwd, fixturesRef);
      if (!(await refExists(cwd, fixturesRef))) {
        ports.logger.warn(
          `Wspólny branch fixture'ów ${fixturesRef} nie istnieje w lokalnym checkoutcie ` +
            `i nie udało się go dociągnąć z remote - case startuje z ${baseRef} ` +
            `bez współdzielonych plików`,
        );
        checkoutBase = baseRef;
      }
    }
    await checkoutCaseBranch(cwd, branch, checkoutBase);
    baseSha = await headSha(cwd);

    // Triaż odświeżany ZAWSZE przed sesją (tani, deterministyczny, idempotentny)
    // - inaczej ponowna próba po fixture-authorze nie widzi extra-inwentarza.
    // W TYM SAMYM try co sesja: padnięty triaż nie zostawi żywego lease.
    await runTriage(ports, config, { runId, caseId });
    const contextBuf = await ports.artifacts.get(runId, contextKey(caseId));
    if (!contextBuf) throw new Error(`Brak kontekstu triażu dla ${caseId}`);
    context = JSON.parse(contextBuf.toString('utf8')) as CaseContext;

    session = await runner({
      config,
      context,
      secrets: ports.secrets,
      logger: ports.logger,
      clock: ports.clock,
      cwd,
      attemptDir,
      runId,
      // Sesja buduje eventy sama - runId stąd, caseId/attempt z kontekstu triażu.
      ...(ports.progress !== undefined ? { onProgress: ports.progress } : {}),
    });
  } catch (err) {
    // Checkout/triaż/sesja padły twardo: checkpoint + attempt_failed. Wyjątek
    // przed zwrotem sesji (connection reset, 5xx mostka, błąd SCM) to awaria
    // infrastruktury, nie case'a - konsumuje maxInfraRetries jak watchdog
    // pierwszej tury, zamiast ją po cichu omijać.
    // Checkpoint best-effort: przy padzie checkoutu commit może polec, a
    // sprzątanie stanu (lease!) MUSI się wykonać.
    await commitAll(cwd, `[${caseId}] wip: sesja przerwana błędem (auto-checkpoint)`).catch(() => {});
    const capPerCase = config.caps.maxCostUsdPerCase;
    const failed = await withState(ports, runId, (state) => {
      const cs = getCase(state, caseId);
      // Materializacja zwykłej puli PRZED attempts - inaczej fallback `attempts-1`
      // policzyłby próby infra jako zwykłe ponowienia.
      cs.autoRetriesUsed = autoRetriesUsed(cs);
      transitionCase(state, caseId, 'attempt_failed', { attempts: attempt });
      releaseLease(state, caseId);
      let retry = false;
      const underCap = capPerCase === undefined || cs.costUsd < capPerCase;
      if (underCap && (cs.infraAttempts ?? 0) < config.caps.maxInfraRetries) {
        cs.infraAttempts = (cs.infraAttempts ?? 0) + 1;
        transitionCase(state, caseId, 'triaged');
        retry = true;
      }
      return { rollup: summarizeRun(state), retry };
    });
    await appendAttempt(ports.artifacts, runId, {
      attemptId,
      caseId,
      runId,
      startedAt,
      endedAt: ports.clock.now().toISOString(),
      trigger: attempt === 1 ? 'initial' : 'human-retry',
      outcome: 'interrupted',
      costUsd: 0,
      turns: 0,
      playwrightRuns: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      phases: {},
      lastErrors: [String(err)],
      filesTouched: [],
      commits: [],
      reusedPoms: [],
    });
    ports.logger.error(`Sesja autora ${caseId} padła`, err);
    // case-start bez case-end = renderer z wiecznie "trwającym" casem.
    emitCaseEnd({
      status: 'attempt_failed',
      blockedReason: 'infra',
      costUsd: 0,
      turns: 0,
      rollup: failed.rollup,
    });
    if (failed.retry) {
      ports.logger.info(`retry z puli infra ${caseId} po twardym błędzie sesji (próba ${attempt + 1})`);
      return authorOneCase(ctx, caseId);
    }
    return { caseId, status: 'attempt_failed', blockedReason: 'infra', costUsd: 0, turns: 0 };
  }

  // Przywrócenie mutacji: czysty worktree ALBO - gdy agent nie scommitował
  // (częste u słabszych modeli) - test treści: zmutowane linie nie występują.
  const cleanAfterSession = await isWorktreeClean(cwd);
  const st = session.state;
  const mutationRestored =
    cleanAfterSession ||
    (st.proofMaterial
      ? await checkMutationRestoredByContent(cwd, st.proofMaterial.mutation.diff, session.structured?.specPath ?? st.finish?.specPath)
      : false);
  if (!cleanAfterSession) {
    await commitAll(cwd, `[${caseId}] wip: niedokończona praca (auto-checkpoint)`);
  }
  const commits = await commitsSince(cwd, baseSha);

  const finish = session.structured ?? st.finish;
  const declaredStatus = finish?.status;
  // Z priceTable NASZ licznik jest źródłem prawdy także przy 0: model lokalny
  // legalnie kosztuje $0, a wycena SDK (cennik Claude'a za model spoza Anthropic)
  // daje fantomy rzędu $60. Bez priceTable: własny licznik, gdy pusty - SDK.
  const ownCostAuthoritative = config.model.priceTable !== undefined || st.costUsd > 0;
  const costUsd = ownCostAuthoritative ? st.costUsd : session.costUsdSdk;

  // Werdykt dowodu - wyłącznie deterministyczny walidator, nigdy deklaracja agenta.
  let proofVerdictValid = false;
  let proofReasons: string[] = [];
  if (declaredStatus === 'delivered' && st.proofMaterial) {
    try {
      const proof = validateProof(st.proofMaterial, {
        caseId,
        attemptId,
        gitDiffEmpty: mutationRestored,
        restoredVerified: mutationRestored,
      });
      proofVerdictValid = proof.verdict === 'valid';
      proofReasons = proof.reasons;
      await ports.artifacts.put(runId, proofArtifactKey(caseId), Buffer.from(JSON.stringify(proof, null, 2)));
    } catch (err) {
      // Nieparsowalny surowiec dowodu = dowód invalid, nigdy wywrotka partii.
      proofReasons = [`Surowiec dowodu nieparsowalny: ${String(err)}`];
    }
  } else if (declaredStatus === 'delivered') {
    proofReasons = ['Agent nie przekazał surowca dowodu mutacyjnego (record_proof_material)'];
  }

  // Spec do artefaktu (plik wskazany przez agenta).
  let specSaved = false;
  if (declaredStatus === 'delivered' && finish?.specPath) {
    try {
      const spec = await readFile(join(cwd, finish.specPath), 'utf8');
      await ports.artifacts.put(runId, specArtifactKey(caseId), Buffer.from(spec));
      specSaved = true;
    } catch {
      proofReasons.push(`Zadeklarowany spec ${finish.specPath} nie istnieje`);
    }
  }

  let outcome: AttemptRecord['outcome'];
  let blockedReason: BlockedReason | undefined;
  if (session.cappedBy === 'infra') {
    // Sesja nie wystartowała - awaria backendu/bramy. Case ponawialny, próba
    // nie obciąża zwykłej puli auto-retry.
    outcome = 'interrupted';
    blockedReason = 'infra';
  } else if (session.cappedBy) {
    outcome = 'blocked';
    blockedReason = session.cappedBy;
  } else if (st.fuseTripped || declaredStatus === 'blocked') {
    outcome = 'blocked';
    blockedReason = st.fuseTripped ? 'fixture-gap' : 'other';
  } else if (declaredStatus === 'delivered' && proofVerdictValid && specSaved) {
    outcome = 'delivered';
  } else if (session.resultSubtype === 'aborted') {
    outcome = 'interrupted';
    blockedReason = 'time';
  } else {
    outcome = 'attempt_failed';
  }

  // Push brancha do platformy. PRZED zapisem próby i przejściem stanu, bo jego
  // wynik zmienia werdykt: bez commitów na zdalnym "dostarczony" case oznaczałby
  // PR do brancha, którego tam NIE MA.
  // Brak metody push (adapter fs, GitHub bez lokalnego checkoutu) to POPRAWNY
  // no-op, nie awaria - port ma ją opcjonalnie.
  let deliveryBlockedByPush = false;
  if (ports.scm.push) {
    try {
      await ports.scm.push(branch);
    } catch (err) {
      // Poza dostawą push jest wygodą (człowiek obejrzy branch) - case i tak
      // nie udaje sukcesu, więc wystarczy ostrzeżenie.
      if (outcome === 'delivered') {
        deliveryBlockedByPush = true;
        outcome = 'attempt_failed';
        blockedReason = 'infra';
        proofReasons.unshift(
          `Push brancha ${branch} nie powiódł się - dostawa wstrzymana, commity zostały tylko lokalnie: ${String(err)}`,
        );
        ports.logger.error(
          `Push brancha ${branch} nie powiódł się - case ${caseId} NIE jest dostarczony. ` +
            `Praca jest lokalnie na branchu ${branch}; napraw dostęp do zdalnego repo ` +
            `i ponów case (\`greenproof retry\`).`,
          err,
        );
      } else {
        ports.logger.warn(`Push brancha ${branch} nie powiódł się`, err);
      }
    }
  }

  // Transcript do artefaktów - sesja SDK jest efemeryczna.
  let transcriptTail: string | undefined;
  try {
    const messages = await readFile(session.messagesPath, 'utf8');
    await ports.artifacts.put(
      runId,
      `cases/${safeCaseId(caseId)}/${attemptId}.messages.jsonl`,
      Buffer.from(messages),
    );
    transcriptTail = messages.slice(-20_000);
  } catch {
    /* brak transcriptu nie blokuje */
  }

  const phases: Partial<Record<AuthorPhase, PhaseStats>> = {};
  for (const phase of ['arrange', 'act', 'assert'] as const) {
    if (st.turnsByPhase[phase] > 0 || st.playwrightRunsByPhase[phase] > 0) {
      phases[phase] = { turns: st.turnsByPhase[phase], playwrightRuns: st.playwrightRunsByPhase[phase] };
    }
  }

  const record: AttemptRecord = {
    attemptId,
    caseId,
    runId,
    startedAt,
    endedAt: ports.clock.now().toISOString(),
    trigger: attempt === 1 ? 'initial' : context.previousAttempt?.humanNotes ? 'human-retry' : 'auto-retry',
    ...(context.previousAttempt?.humanNotes !== undefined
      ? { humanNotes: context.previousAttempt.humanNotes }
      : {}),
    outcome,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
    costUsd,
    turns: st.turns,
    playwrightRuns:
      st.playwrightRunsByPhase.arrange + st.playwrightRunsByPhase.act + st.playwrightRunsByPhase.assert,
    ...(st.proofRunsUsed > 0 ? { proofRuns: st.proofRunsUsed } : {}),
    tokens: st.tokens,
    phases,
    ...(st.seedAttempts.length > 0 ? { seedAttempts: st.seedAttempts } : {}),
    lastErrors: [...(finish?.errors ?? []), ...proofReasons].slice(0, 5),
    filesTouched: [...st.filesTouched],
    commits,
    reusedPoms: finish?.reusedPoms ?? [],
  };
  record.digest = await generateDigest(config, ports.secrets, ports.logger, record, transcriptTail);
  await appendAttempt(ports.artifacts, runId, record);

  // Faza 3: przejścia stanu + checkpoint (CAS).
  const saved = await withState(ports, runId, (state) => {
    const cs = getCase(state, caseId);
    cs.attempts = attempt;
    cs.currentAttemptId = attemptId;
    cs.costUsd += costUsd;
    state.totals.costUsd += costUsd;
    state.totals.turns += st.turns;
    delete cs.retryNotes; // skonsumowane przez tę próbę

    if (outcome === 'delivered') {
      transitionCase(state, caseId, 'proving');
      transitionCase(state, caseId, 'delivered', {
        artifacts: { ...cs.artifacts, spec: specArtifactKey(caseId), proof: proofArtifactKey(caseId) },
      });
    } else if (outcome === 'blocked') {
      transitionCase(state, caseId, 'blocked', {
        blockedReason: blockedReason ?? 'other',
        ...(st.fuseNote !== undefined
          ? { blockedNote: st.fuseNote }
          : finish?.notes !== undefined
            ? { blockedNote: finish.notes }
            : {}),
      });
    } else {
      transitionCase(state, caseId, 'attempt_failed');
    }
    releaseLease(state, caseId);
    // Rollup PO zapisie próby - to on trafia do case-end.
    return { status: getCase(state, caseId).status, rollup: summarizeRun(state) };
  });
  const finalStatus = saved.status;
  emitCaseEnd({
    status: finalStatus,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
    costUsd,
    turns: st.turns,
    rollup: saved.rollup,
  });

  // Współdzielenie harvestu WEWNĄTRZ runu: po dostarczonym case'ie jego
  // POM-y/fixture'y trafiają na wspólny branch. Wyjątek nie wywróci case'a.
  if (finalStatus === 'delivered') {
    try {
      const shared = await shareCaseHarvest(ports, config, {
        runId,
        caseId,
        branch,
        baseRef,
        ...(fixturesRef !== undefined ? { fixturesRef } : {}),
      });
      if (shared.shared.length > 0) {
        await withState(ports, runId, (state) => {
          state.fixturesRef ??= shared.branch;
        });
        ports.logger.info(
          `Udostępniono ${shared.shared.length} wpis(ów) harvestu z ${caseId} na ${shared.branch}`,
        );
      }
    } catch (err) {
      ports.logger.warn(`Współdzielenie harvestu ${caseId} nie powiodło się`, err);
    }
  }

  // Auto-retry: tylko po attempt_failed, pod capem kosztu case'a. Drabinka pul
  // w jednej transakcji CAS (koszt + decyzja + przejście).
  const capPerCase = config.caps.maxCostUsdPerCase;
  const gate = await withState(ports, runId, (state) => {
    const cs = getCase(state, caseId);
    const totalCaseCost = cs.costUsd;
    if (finalStatus !== 'attempt_failed') return { totalCaseCost };
    // Zepsuty push jest systemowy (token/uprawnienia/sieć), nie casowy: auto-retry
    // spaliłby CAŁĄ sesję pod ścianą, i tak samo dla każdego kolejnego case'a.
    // Spec i dowód są w artefaktach, praca na lokalnym branchu - człowiek ponawia
    // po naprawie zdalnego.
    if (deliveryBlockedByPush) return { totalCaseCost };
    if (capPerCase !== undefined && totalCaseCost >= capPerCase) return { totalCaseCost };

    // Materializacja: pule jawne w stanie, próby nie wracają do attempts
    // (które liczy też 'infra').
    const used = autoRetriesUsed(cs);
    cs.autoRetriesUsed = used;

    let pool: RetryPool | undefined;
    if (blockedReason === 'infra' && (cs.infraAttempts ?? 0) < config.caps.maxInfraRetries) {
      cs.infraAttempts = (cs.infraAttempts ?? 0) + 1;
      pool = 'infra';
    } else if ((cs.fixtureRetryCredits ?? 0) > 0) {
      cs.fixtureRetryCredits = (cs.fixtureRetryCredits ?? 0) - 1;
      pool = 'fixture';
    } else if (used < config.caps.maxAutoRetries) {
      cs.autoRetriesUsed = used + 1;
      pool = 'regular';
    }
    if (pool) transitionCase(state, caseId, 'triaged');
    return { totalCaseCost, ...(pool !== undefined ? { pool } : {}) };
  });
  const totalCaseCost = gate.totalCaseCost;
  if (gate.pool) {
    ports.logger.info(`${RETRY_POOL_LABEL[gate.pool]} ${caseId} (próba ${attempt + 1})`);
    return authorOneCase(ctx, caseId);
  }

  return {
    caseId,
    status: finalStatus,
    costUsd: totalCaseCost,
    turns: st.turns,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
  };
}
