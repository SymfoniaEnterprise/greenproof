/**
 * Adapter platformy GitHub: branche i PR-y przez git data API, komentarze do
 * issue jako kanał do człowieka, stan i artefakty na osobnych branchach.
 * Wszystko przez REST, bez lokalnego checkoutu (wyjątek: opcjonalny push).
 */
import { Octokit } from '@octokit/rest';
import type { Clock, Logger, PlatformFactory, Ports, SecretsPort } from '@greenproof/core';
import { GithubArtifactStore } from './artifacts.js';
import { GithubHumanChannel } from './human.js';
import { GithubScm } from './scm.js';
import { GithubStateStore } from './state.js';
import type { GithubApi } from './internal.js';

export { GithubArtifactStore, DEFAULT_ARTIFACTS_BRANCH } from './artifacts.js';
export type { GithubArtifactStoreOptions } from './artifacts.js';
export { GithubHumanChannel, reportMarker } from './human.js';
export type { GithubHumanChannelOptions } from './human.js';
export { GithubScm, ScmConflictError } from './scm.js';
export type { GithubScmOptions } from './scm.js';
export { GithubStateStore, DEFAULT_STATE_BRANCH } from './state.js';
export type { GithubStateStoreOptions } from './state.js';
export { globToRegExp } from './internal.js';
export type { GithubApi, RepoRef, TreeEntryInput, BlobFile } from './internal.js';

/** Kształt `platformOptions` z konfigu greenproof. */
export interface GithubPlatformOptions {
  owner: string;
  repo: string;
  /** Zmienna env/sekretu z tokenem (domyślnie GITHUB_TOKEN). */
  tokenEnv?: string;
  stateBranch?: string;
  artifactsBranch?: string;
  /** Lokalny checkout w CI - włącza realny `push()`. */
  repoDir?: string;
  /** Baza REST API dla GitHub Enterprise (np. https://ghe.firma.pl/api/v3). */
  baseUrl?: string;
}

export const DEFAULT_TOKEN_ENV = 'GITHUB_TOKEN';

export interface CreateGithubPortsOptions {
  /** Gotowy klient (Octokit albo fake w testach). */
  octokit: GithubApi;
  owner: string;
  repo: string;
  logger: Logger;
  secrets: SecretsPort;
  clock?: Clock | undefined;
  stateBranch?: string | undefined;
  artifactsBranch?: string | undefined;
  repoDir?: string | undefined;
}

/** Fabryka portów na gotowym kliencie - też dla testów (fake octokit, zero sieci). */
export function createGithubPorts(options: CreateGithubPortsOptions): Ports {
  const { octokit, owner, repo, logger, secrets } = options;
  const clock: Clock = options.clock ?? { now: () => new Date() };
  return {
    scm: new GithubScm({ octokit, owner, repo, logger, repoDir: options.repoDir }),
    artifacts: new GithubArtifactStore({
      octokit,
      owner,
      repo,
      logger,
      branch: options.artifactsBranch,
    }),
    human: new GithubHumanChannel({ octokit, owner, repo, logger }),
    state: new GithubStateStore({ octokit, owner, repo, logger, branch: options.stateBranch }),
    secrets,
    logger,
    clock,
  };
}

/**
 * Fabryka platformy (config `platform: '@greenproof/adapter-github'`); token
 * z portu sekretów, nigdy z configu.
 */
const createGithubPlatform: PlatformFactory = ({ config, secrets, logger }): Ports => {
  const options = parseOptions(config);
  const tokenEnv = options.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const token = secrets.get(tokenEnv);
  if (token === undefined || token.length === 0) {
    throw new Error(
      `@greenproof/adapter-github: missing GitHub token - set ${tokenEnv} ` +
        '(or point platformOptions.tokenEnv at the variable that holds it)',
    );
  }
  const octokit = new Octokit({
    auth: token,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  return createGithubPorts({
    // Typy Octokita (OpenAPI) są szersze niż GithubApi - nie da się pogodzić bez rzutowania.
    octokit: octokit as unknown as GithubApi,
    owner: options.owner,
    repo: options.repo,
    logger,
    secrets,
    stateBranch: options.stateBranch,
    artifactsBranch: options.artifactsBranch,
    repoDir: options.repoDir,
  });
};

export default createGithubPlatform;

function parseOptions(config: unknown): GithubPlatformOptions {
  const root = asRecord(config);
  const raw = root !== null && 'platformOptions' in root ? root['platformOptions'] : config;
  const options = asRecord(raw);
  if (options === null) {
    throw new Error(
      '@greenproof/adapter-github: platformOptions must be an object { owner, repo }',
    );
  }
  const missing = (['owner', 'repo'] as const).filter(
    (key) => typeof options[key] !== 'string' || (options[key] as string).length === 0,
  );
  if (missing.length > 0) {
    throw new Error(
      `@greenproof/adapter-github: platformOptions is missing required string field(s): ${missing.join(', ')}`,
    );
  }
  const optional = (key: keyof GithubPlatformOptions): string | undefined => {
    const value = options[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const tokenEnv = optional('tokenEnv');
  const stateBranch = optional('stateBranch');
  const artifactsBranch = optional('artifactsBranch');
  const repoDir = optional('repoDir');
  const baseUrl = optional('baseUrl');
  return {
    owner: options['owner'] as string,
    repo: options['repo'] as string,
    ...(tokenEnv === undefined ? {} : { tokenEnv }),
    ...(stateBranch === undefined ? {} : { stateBranch }),
    ...(artifactsBranch === undefined ? {} : { artifactsBranch }),
    ...(repoDir === undefined ? {} : { repoDir }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
