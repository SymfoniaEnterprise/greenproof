/**
 * AUTO-ACCEPT - deterministyczna bramka zastępująca per-case decyzję człowieka.
 * Case w `in_review` dostaje akceptację, gdy: (1) werdykt dowodu = `valid`
 * (wyłącznie z walidatora, nigdy deklaracja agenta), (2) walidator nie zgłosił
 * ŻADNEGO ostrzeżenia, ORAZ (3) lint anty-duplikacji selektorów bez konfliktu
 * (ta sama funkcja co w deliver).
 *
 * OSOBNY krok, nie rozszerzenie delivera: deliver melduje drafty i blokady
 * człowiekowi, akceptacja to odrębna faza wywoływana TYLKO z `run` (retry i
 * `grp step deliver` nie auto-akceptują). `accept` zostaje ręcznym narzędziem.
 *
 * Reużycie `runAccept` (nie duplikacja): otwarcie PR, bump reuse i promocja
 * ui-traps zostają tam, gdzie są. Awaria jednego case'a jest logowana i NIE
 * przerywa pozostałych.
 */
import type { GreenproofConfig } from '../config/types.js';
import type { MutationProof } from '../domain/proof.js';
import type { CaseState, PipelineState } from '../domain/state.js';
import type { PomIndex } from '../domain/harvest.js';
import type { Ports } from '../ports/index.js';
import { RunNotFoundError } from '../machine/withState.js';
import { readPomIndex, unionIndexes } from '../harvest/inventory.js';
import { findSelectorDuplication } from '../harvest/lint.js';
import { runAccept } from './accept.js';

export interface AutoAcceptParams {
  runId: string;
}

export interface AutoAcceptResult {
  /** Case'y zaakceptowane automatycznie (kryterium spełnione i PR otwarty). */
  accepted: string[];
  /** Case'y nadal czekające na człowieka (in_review bez kryterium / blocked / awaria akceptacji). */
  waiting: string[];
}

export async function runAutoAccept(
  ports: Ports,
  config: GreenproofConfig,
  params: AutoAcceptParams,
): Promise<AutoAcceptResult> {
  // Odczyt bez withState: mutacje robi runAccept własnym CAS-em; tu wystarczy migawka.
  const loaded = await ports.state.load(params.runId);
  if (!loaded) throw new RunNotFoundError(params.runId);
  const state = loaded.state;

  // targetBranch = state.baseRef: `ref` z filtra jest jedynym źródłem prawdy o
  // gałęzi bazowej (tam żyje pom-index.json i wracają PR-y). Ręczny `accept`
  // bierze targetBranch z wejścia; tu nie ma człowieka, więc baseRef.
  const targetBranch = state.baseRef;

  // Unia indeksu baseRef + branch fixture'ów, żeby lint widział POM-y z tego runu.
  const baseIndex = await readPomIndex(ports.scm, state.baseRef, config);
  const fixturesRef = state.fixturesRef;
  const pomIndex =
    fixturesRef !== undefined && fixturesRef !== state.baseRef
      ? unionIndexes(await readPomIndex(ports.scm, fixturesRef, config), baseIndex)
      : baseIndex;

  const accepted: string[] = [];
  const waiting: string[] = [];

  for (const cs of Object.values(state.cases)) {
    if (cs.status === 'in_review') {
      const meets = await meetsAutoAcceptCriterion(ports, state, cs, pomIndex);
      if (!meets) {
        waiting.push(cs.caseId);
        continue;
      }
      try {
        await runAccept(ports, config, {
          runId: params.runId,
          caseId: cs.caseId,
          targetBranch,
          acceptedBy: 'pipeline',
        });
        accepted.push(cs.caseId);
        ports.logger.info(`Auto-akceptacja ${cs.caseId}: PR do ${targetBranch} otwarty`);
      } catch (err) {
        // Awaria jednego case'a nie wywraca runu: logujemy, case zostaje in_review.
        ports.logger.warn(`Auto-akceptacja ${cs.caseId} nie powiodła się - zostaje in_review`, err);
        waiting.push(cs.caseId);
      }
    } else if (cs.status === 'blocked') {
      waiting.push(cs.caseId);
    }
  }

  return { accepted, waiting };
}

/** Determinystyczne kryterium: artefakt dowodu + lint tą samą funkcją co deliver. */
async function meetsAutoAcceptCriterion(
  ports: Ports,
  state: PipelineState,
  cs: CaseState,
  pomIndex: PomIndex,
): Promise<boolean> {
  // (1) Werdykt dowodu mutacyjnego = valid.
  const proofBuf = cs.artifacts.proof
    ? await ports.artifacts.get(state.runId, cs.artifacts.proof)
    : null;
  if (!proofBuf) return false;
  let proof: MutationProof;
  try {
    proof = JSON.parse(proofBuf.toString('utf8')) as MutationProof;
  } catch {
    return false;
  }
  if (proof.verdict !== 'valid') return false;

  // (2) Zero ostrzeżeń walidatora. Ostrzeżenie z definicji znaczy "dowód ważny
  // mechanicznie, ale słabszy - niech człowiek spojrzy przy akceptacji"
  // (proof/validator.ts, słabe powiązanie komunikatu asercji z mutacją).
  // Auto-akceptacja takiego case'a kasowałaby jedyny moment, w którym ktokolwiek
  // to ostrzeżenie przeczyta.
  if (proof.warnings.length > 0) return false;

  // (3) Lint anty-duplikacji selektorów bez konfliktu.
  const specBuf = cs.artifacts.spec
    ? await ports.artifacts.get(state.runId, cs.artifacts.spec)
    : null;
  const spec = specBuf?.toString('utf8') ?? '';
  const lint = findSelectorDuplication(cs.artifacts.spec ?? '', spec, pomIndex);
  return lint.length === 0;
}
