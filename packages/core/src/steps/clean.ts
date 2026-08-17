/**
 * CLEAN - świadome sprzątanie artefaktów runu, NIGDY efekt uboczny innego
 * kroku. Twarda retencja: artefakty case'a wolno usuwać dopiero po release.
 * Domyślnie znikają tylko ciężkie, odtwarzalne rzeczy (transcripty, kontekst
 * triażu, extra-inventory); ślad audytowy (ledger, spec, dowód) zostaje -
 * jego usunięcie wymaga jawnego `purge`.
 */
import type { CaseStatus } from '../domain/state.js';
import type { Ports } from '../ports/index.js';
import { RunNotFoundError } from '../machine/withState.js';
import { safeCaseId } from './filter.js';

export interface CleanParams {
  runId: string;
  /** Podzbiór case'ów (domyślnie wszystkie w stanie released). */
  caseIds?: string[];
  /** Usuń też ledger/spec/proof (niszczy ślad audytowy). */
  purge?: boolean;
  dryRun?: boolean;
  /**
   * Sprzątanie branchy (domyślnie true): author/<caseId> case'ów released,
   * a gdy cały run jest terminalny - także greenproof/fixtures/<runId>;
   * z purge dodatkowo bocznice greenproof/fixtures-failed/<runId>/*.
   */
  branches?: boolean;
}

export interface CleanResult {
  runId: string;
  /** Klucze artefaktów usunięte (przy dryRun: do usunięcia). */
  deleted: string[];
  /** Branche usunięte (przy dryRun: do usunięcia). */
  deletedBranches: string[];
  /** Case'y pominięte z powodem (retencja). */
  kept: { caseId: string; status: CaseStatus; reason: string }[];
  /** Wyjaśnienie, gdy branchy nie ruszono (brak wsparcia portu / run w toku). */
  branchNote?: string;
  dryRun: boolean;
}

/** Platforma bez ArtifactStore.delete - retencją zarządza sama platforma. */
export class ArtifactDeleteUnsupportedError extends Error {
  constructor() {
    super(
      'ArtifactStore tej platformy nie wspiera usuwania - retencją artefaktów zarządza platforma, nie greenproof clean',
    );
    this.name = 'ArtifactDeleteUnsupportedError';
  }
}

/** Domyślnie czyszczone: odtwarzalne i ciężkie. Ledger/spec/proof zostają. */
function deletableByDefault(key: string): boolean {
  return (
    key.endsWith('.messages.jsonl') ||
    key.endsWith('/context.json') ||
    key.endsWith('/extra-inventory.json')
  );
}

export async function runClean(ports: Ports, params: CleanParams): Promise<CleanResult> {
  const artifacts = ports.artifacts;
  if (artifacts.delete === undefined) throw new ArtifactDeleteUnsupportedError();

  // Czysty odczyt stanu - sprzątanie nie mutuje pipeline'u (nie używa withState).
  const loaded = await ports.state.load(params.runId);
  if (!loaded) throw new RunNotFoundError(params.runId);
  const cases = Object.values(loaded.state.cases).filter(
    (c) => params.caseIds === undefined || params.caseIds.includes(c.caseId),
  );

  const deleted: string[] = [];
  const kept: CleanResult['kept'] = [];
  for (const cs of cases) {
    if (cs.status !== 'released') {
      kept.push({
        caseId: cs.caseId,
        status: cs.status,
        reason: 'artefakty wolno usuwać dopiero po release',
      });
      continue;
    }
    const keys = await artifacts.list(params.runId, `cases/${safeCaseId(cs.caseId)}/`);
    for (const key of keys) {
      if (!(params.purge ?? false) && !deletableByDefault(key)) continue;
      if (!(params.dryRun ?? false)) await artifacts.delete!(params.runId, key);
      deleted.push(key);
    }
  }

  // Branche: praca released case'ów jest zmergowana przez PR (accept), ich
  // author/<caseId> to osad historii. Ref fixtures wolno usunąć, gdy ŻADEN
  // case nie będzie z niego ciął nowych branchy.
  const dryRun = params.dryRun ?? false;
  const deletedBranches: string[] = [];
  let branchNote: string | undefined;
  if (params.branches ?? true) {
    if (ports.scm.deleteBranch === undefined) {
      branchNote =
        'platforma nie wspiera usuwania branchy (ScmPort.deleteBranch) - ich cyklem życia zarządza platforma';
      ports.logger.warn(`Clean ${params.runId}: ${branchNote}`);
    } else {
      const candidates: string[] = [];
      for (const cs of cases) {
        if (cs.status === 'released' && cs.branch !== undefined) candidates.push(cs.branch);
      }
      const TERMINAL: readonly CaseStatus[] = ['released', 'skipped', 'failed'];
      const runTerminal = Object.values(loaded.state.cases).every((c) => TERMINAL.includes(c.status));
      if (runTerminal) {
        if (loaded.state.fixturesRef !== undefined) candidates.push(loaded.state.fixturesRef);
        if ((params.purge ?? false) && ports.scm.listBranches !== undefined) {
          candidates.push(
            ...(await ports.scm.listBranches(`greenproof/fixtures-failed/${safeCaseId(params.runId)}/`)),
          );
        }
      } else if (loaded.state.fixturesRef !== undefined) {
        branchNote = `branch ${loaded.state.fixturesRef} zostaje - run ma niedokończone case'y, które tną z niego swoje branche`;
      }
      for (const branch of candidates) {
        try {
          if (!dryRun) await ports.scm.deleteBranch(branch);
          deletedBranches.push(branch);
        } catch (err) {
          ports.logger.warn(`Clean ${params.runId}: nie udało się usunąć brancha ${branch}`, err);
        }
      }
    }
  }

  ports.logger.info(
    `Clean ${params.runId}: ${deleted.length} artefaktów, ${deletedBranches.length} branchy${dryRun ? ' (dry-run)' : ''}, pominiętych case'ów: ${kept.length}`,
  );
  return {
    runId: params.runId,
    deleted: deleted.sort(),
    deletedBranches: deletedBranches.sort(),
    kept,
    ...(branchNote !== undefined ? { branchNote } : {}),
    dryRun,
  };
}
