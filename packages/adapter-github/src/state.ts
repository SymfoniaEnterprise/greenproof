/**
 * StateStore na orphan branchu (domyślnie `greenproof/state`): plik
 * `<runId>.json` per przebieg, wersja = sha BLOBU tego pliku, CAS przez
 * porównanie sha blobu + `updateRef(force:false)`. Wersja jest per run, więc
 * zapis innego runu nie unieważnia naszej wersji - przegrany wyścig na refie to
 * fałszywy konflikt i adapter go pochłania (retry z przeładowaniem heada, ale z
 * ponownym sprawdzeniem NASZEGO blobu). Zmiana naszego pliku przez kogoś innego
 * nadal leci wyżej jako StateConflictError. Wersja pozostaje weryfikowalna na
 * GitHubie (sha blobu z drzewa), a historia stanu audytowalna commit po commicie.
 */
import type { Logger, PipelineState, StateStore } from '@greenproof/core';
import { StateConflictError } from '@greenproof/core';
import type { GithubApi, RepoFile, RepoRef, TreeEntryInput } from './internal.js';
import {
  assertSafeSegment,
  createCommitWithFiles,
  getBranchHead,
  getFile,
  isRefRaceError,
} from './internal.js';

export const DEFAULT_STATE_BRANCH = 'greenproof/state';

/** Próby po przegranym wyścigu na refie (cudzy run przesunął head). */
const MAX_ATTEMPTS = 5;

export interface GithubStateStoreOptions {
  octokit: GithubApi;
  owner: string;
  repo: string;
  logger: Logger;
  /** Branch trzymający stan (orphan, tworzony przy pierwszym zapisie). */
  branch?: string | undefined;
}

export class GithubStateStore implements StateStore {
  private readonly api: GithubApi;
  private readonly repoRef: RepoRef;
  private readonly logger: Logger;
  private readonly branch: string;

  constructor(options: GithubStateStoreOptions) {
    this.api = options.octokit;
    this.repoRef = { owner: options.owner, repo: options.repo };
    this.logger = options.logger;
    this.branch = options.branch ?? DEFAULT_STATE_BRANCH;
  }

  async load(runId: string): Promise<{ state: PipelineState; version: string } | null> {
    const head = await getBranchHead(this.api, this.repoRef, this.branch);
    if (head === null) return null;
    // Odczyt po sha commita, nie po nazwie brancha - treść i sha blobu z tej samej migawki.
    const file = await getFile(this.api, this.repoRef, head, this.file(runId));
    if (file === null) return null;
    return {
      state: JSON.parse(file.content.toString('utf8')) as PipelineState,
      version: blobSha(file, this.file(runId)),
    };
  }

  async save(
    runId: string,
    state: PipelineState,
    expectedVersion: string | null,
  ): Promise<{ version: string }> {
    const path = this.file(runId);
    const content = `${JSON.stringify(state, null, 2)}\n`;
    const message = `greenproof: state ${runId}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const head = await getBranchHead(this.api, this.repoRef, this.branch);

      if (head === null) {
        // Branch stanu nie istnieje: to może być tylko tworzenie.
        if (expectedVersion !== null) throw new StateConflictError(runId);
        const created = await this.createOrphan(path, content, message, attempt);
        if (created !== null) return created;
        // Ktoś utworzył branch równolegle - kolejna próba już na jego headzie.
        continue;
      }

      // CAS na WŁASNYM pliku - stan cudzych runów jest nam obojętny.
      const current = await getFile(this.api, this.repoRef, head, path);
      if (expectedVersion === null) {
        // Plik już istnieje = ktoś nas ubiegł z tworzeniem tego runu.
        if (current !== null) throw new StateConflictError(runId);
      } else if (current === null || blobSha(current, path) !== expectedVersion) {
        throw new StateConflictError(runId);
      }

      const saved = await this.commitOn(head, path, content, message, attempt);
      if (saved !== null) return saved;
      // Przegrany wyścig na refie: cudzy commit przesunął head. Pętla przeładuje
      // head i ZNOWU sprawdzi nasz blob - prawdziwy konflikt dalej wybuchnie.
    }

    // Nie udało się dopiąć CAS-u mimo prób - uczciwie oddajemy konflikt wyżej
    // (kontrakt portu: exit 4 = ponów krok), zamiast forsować zapis.
    this.logger.warn('greenproof/github: state branch too busy, giving up', {
      branch: this.branch,
      runId,
      attempts: MAX_ATTEMPTS,
    });
    throw new StateConflictError(runId);
  }

  /**
   * Seam testowy: wywoływane po zbudowaniu commita, a przed CAS na ref.
   * Nadpisz w teście, żeby zasymulować równoległy zapis do brancha stanu.
   */
  protected async beforeUpdateRef(_attempt: number): Promise<void> {
    return;
  }

  private file(runId: string): string {
    return `${assertSafeSegment(runId, 'runId')}.json`;
  }

  /** Commit na rodzicu + CAS na refie; `null` = przegrany wyścig na refie. */
  private async commitOn(
    parentSha: string,
    path: string,
    content: string,
    message: string,
    attempt: number,
  ): Promise<{ version: string } | null> {
    const parent = await this.api.git.getCommit({ ...this.repoRef, commit_sha: parentSha });
    const { commitSha, entries } = await createCommitWithFiles(this.api, this.repoRef, {
      parentSha,
      baseTreeSha: parent.data.tree.sha,
      files: [{ path, content }],
      message,
    });
    const version = writtenBlobSha(entries, path);
    await this.beforeUpdateRef(attempt);
    try {
      await this.api.git.updateRef({
        ...this.repoRef,
        ref: `heads/${this.branch}`,
        sha: commitSha,
        force: false,
      });
    } catch (err) {
      if (!isRefRaceError(err)) throw err;
      this.logger.debug('greenproof/github: state branch moved, retrying', {
        branch: this.branch,
        attempt,
      });
      return null;
    }
    return { version };
  }

  /** Pierwszy zapis: commit bez rodziców + createRef; `null` = branch powstał równolegle. */
  private async createOrphan(
    path: string,
    content: string,
    message: string,
    attempt: number,
  ): Promise<{ version: string } | null> {
    const { commitSha, entries } = await createCommitWithFiles(this.api, this.repoRef, {
      parentSha: null,
      baseTreeSha: null,
      files: [{ path, content }],
      message,
    });
    const version = writtenBlobSha(entries, path);
    await this.beforeUpdateRef(attempt);
    try {
      await this.api.git.createRef({
        ...this.repoRef,
        ref: `refs/heads/${this.branch}`,
        sha: commitSha,
      });
    } catch (err) {
      // Branch stanu powstał równolegle - dopiszemy się do niego w kolejnej próbie.
      if (!isRefRaceError(err)) throw err;
      this.logger.debug('greenproof/github: state branch created concurrently, retrying', {
        branch: this.branch,
        attempt,
      });
      return null;
    }
    this.logger.info('greenproof/github: created orphan state branch', { branch: this.branch });
    return { version };
  }
}

/** Sha blobu jako wersja stanu; brak sha = nie da się zrobić CAS-u. */
function blobSha(file: RepoFile, path: string): string {
  if (file.sha === undefined) {
    throw new Error(`GitHub returned no blob sha for ${path}`);
  }
  return file.sha;
}

/** Sha blobu, który właśnie zapisaliśmy - wersja zwracana z `save`. */
function writtenBlobSha(entries: TreeEntryInput[], path: string): string {
  const sha = entries.find((e) => e.path === path)?.sha;
  if (sha === undefined || sha === null) {
    throw new Error(`GitHub returned no blob sha for ${path}`);
  }
  return sha;
}
