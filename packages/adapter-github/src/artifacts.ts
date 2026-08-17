/**
 * ArtifactStore na branchu (domyślnie `greenproof/artifacts`): ścieżka
 * `<runId>/<key>`, meta obok jako `<key>.meta.json`. Artefakty bywają binarne,
 * więc blob w base64. Zapis per plik; wyścig na refie rozwiązuje retry z
 * ponownym odczytem heada - kolejność nie ma znaczenia, powtórka commita jest bezpieczna.
 */
import type { Readable } from 'node:stream';
import type { ArtifactStore, Logger } from '@greenproof/core';
import type { BlobFile, GithubApi, RepoRef } from './internal.js';
import {
  assertSafeKey,
  assertSafeSegment,
  createCommitWithFiles,
  getBranchHead,
  getFileBuffer,
  isRefRaceError,
  listBlobPaths,
} from './internal.js';

export const DEFAULT_ARTIFACTS_BRANCH = 'greenproof/artifacts';
const META_SUFFIX = '.meta.json';
const MAX_ATTEMPTS = 3;

export interface GithubArtifactStoreOptions {
  octokit: GithubApi;
  owner: string;
  repo: string;
  logger: Logger;
  /** Branch artefaktów (orphan, tworzony przy pierwszym zapisie). */
  branch?: string | undefined;
}

export class GithubArtifactStore implements ArtifactStore {
  private readonly api: GithubApi;
  private readonly repoRef: RepoRef;
  private readonly logger: Logger;
  private readonly branch: string;

  constructor(options: GithubArtifactStoreOptions) {
    this.api = options.octokit;
    this.repoRef = { owner: options.owner, repo: options.repo };
    this.logger = options.logger;
    this.branch = options.branch ?? DEFAULT_ARTIFACTS_BRANCH;
  }

  async put(
    runId: string,
    key: string,
    data: Buffer | Readable,
    meta?: Record<string, string>,
  ): Promise<void> {
    const path = this.path(runId, key);
    const buf = await toBuffer(data);
    const files: BlobFile[] = [
      { path, content: buf.toString('base64'), encoding: 'base64' },
    ];
    if (meta !== undefined) {
      files.push({
        path: `${path}${META_SUFFIX}`,
        content: `${JSON.stringify(meta, null, 2)}\n`,
      });
    }
    await this.commitWithRetry(files, `greenproof: artifact ${path}`);
  }

  async get(runId: string, key: string): Promise<Buffer | null> {
    return getFileBuffer(this.api, this.repoRef, this.branch, this.path(runId, key));
  }

  async list(runId: string, prefix?: string): Promise<string[]> {
    const head = await getBranchHead(this.api, this.repoRef, this.branch);
    if (head === null) return [];
    const { paths, truncated } = await listBlobPaths(this.api, this.repoRef, head);
    if (truncated) {
      this.logger.warn('greenproof/github: artifact tree truncated, listing may be incomplete', {
        runId,
      });
    }
    const root = `${assertSafeSegment(runId, 'runId')}/`;
    const keys = paths
      .filter((p) => p.startsWith(root))
      .map((p) => p.slice(root.length))
      .filter((k) => !k.endsWith(META_SUFFIX))
      .filter((k) => prefix === undefined || k.startsWith(prefix));
    return keys.sort();
  }

  /**
   * Seam testowy: wywoływane po zbudowaniu commita, a przed CAS na ref.
   * Nadpisz w teście, żeby zasymulować równoległy zapis artefaktu.
   */
  protected async beforeUpdateRef(_attempt: number): Promise<void> {
    return;
  }

  private path(runId: string, key: string): string {
    return `${assertSafeSegment(runId, 'runId')}/${assertSafeKey(key, 'artifact key')}`;
  }

  private async commitWithRetry(files: BlobFile[], message: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const head = await getBranchHead(this.api, this.repoRef, this.branch);
      const baseTreeSha =
        head === null
          ? null
          : (await this.api.git.getCommit({ ...this.repoRef, commit_sha: head })).data.tree.sha;
      const { commitSha } = await createCommitWithFiles(this.api, this.repoRef, {
        parentSha: head,
        baseTreeSha,
        files,
        message,
      });
      await this.beforeUpdateRef(attempt);
      try {
        if (head === null) {
          await this.api.git.createRef({
            ...this.repoRef,
            ref: `refs/heads/${this.branch}`,
            sha: commitSha,
          });
        } else {
          await this.api.git.updateRef({
            ...this.repoRef,
            ref: `heads/${this.branch}`,
            sha: commitSha,
            force: false,
          });
        }
        return;
      } catch (err) {
        if (!isRefRaceError(err)) throw err;
        lastError = err;
        this.logger.debug('greenproof/github: artifact branch moved, retrying', {
          branch: this.branch,
          attempt,
        });
      }
    }
    throw new Error(
      `Failed to write artifacts to ${this.branch} after ${MAX_ATTEMPTS} attempts` +
        (lastError instanceof Error ? `: ${lastError.message}` : ''),
    );
  }
}

async function toBuffer(data: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  const chunks: Buffer[] = [];
  for await (const chunk of data) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}
