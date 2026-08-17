/**
 * Referencyjny adapter platformy na lokalnym filesystemie i lokalnym gicie.
 * Do devu, testów integracyjnych i platform CI, które same montują storage.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Clock, PlatformFactory, Ports } from '@greenproof/core';
import { FsArtifactStore } from './artifacts.js';
import { FsHumanChannel } from './human.js';
import { FsScm } from './scm.js';
import { FsStateStore } from './state.js';

export { FsArtifactStore } from './artifacts.js';
export type { FsArtifactStoreOptions } from './artifacts.js';
export { FsHumanChannel } from './human.js';
export type { FsHumanChannelOptions } from './human.js';
export { FsScm, globToRegExp } from './scm.js';
export type { FsScmOptions } from './scm.js';
export { FsStateStore } from './state.js';
export type { FsStateStoreOptions } from './state.js';

/** Kształt `platformOptions` z konfigu greenproof. */
export interface FsPlatformOptions {
  /** Lokalne repo git z testami. */
  repoDir: string;
  /** Katalog roboczy adaptera: artifacts/, state/, reports/, prs/. */
  baseDir: string;
}

/** Ścieżki wyprowadzone z baseDir - przydatne w testach integracyjnych. */
export function fsPlatformPaths(baseDir: string): {
  artifactsDir: string;
  stateDir: string;
  reportsDir: string;
  prDir: string;
} {
  const base = resolve(baseDir);
  return {
    artifactsDir: join(base, 'artifacts'),
    stateDir: join(base, 'state'),
    reportsDir: join(base, 'reports'),
    prDir: join(base, 'prs'),
  };
}

/**
 * Fabryka portów. Przyjmuje albo cały config greenproof (czyta
 * `platformOptions`), albo bezpośrednio `FsPlatformOptions`.
 */
const createFsPlatform: PlatformFactory = ({ config, secrets, logger }): Ports => {
  const options = parseOptions(config);
  const repoDir = resolve(options.repoDir);
  const paths = fsPlatformPaths(options.baseDir);
  if (!existsSync(repoDir)) {
    throw new Error(`@greenproof/adapter-fs: repoDir does not exist: ${repoDir}`);
  }
  const clock: Clock = { now: () => new Date() };
  return {
    scm: new FsScm({ repoDir, prDir: paths.prDir, clock }),
    artifacts: new FsArtifactStore({ dir: paths.artifactsDir }),
    human: new FsHumanChannel({ dir: paths.reportsDir, clock }),
    state: new FsStateStore({ dir: paths.stateDir }),
    secrets,
    logger,
    clock,
  };
};

export default createFsPlatform;

function parseOptions(config: unknown): FsPlatformOptions {
  const root = asRecord(config);
  const raw = root !== null && 'platformOptions' in root ? root['platformOptions'] : config;
  const options = asRecord(raw);
  if (options === null) {
    throw new Error(
      '@greenproof/adapter-fs: platformOptions must be an object { repoDir, baseDir }',
    );
  }
  const missing = (['repoDir', 'baseDir'] as const).filter(
    (key) => typeof options[key] !== 'string' || (options[key] as string).length === 0,
  );
  if (missing.length > 0) {
    throw new Error(
      `@greenproof/adapter-fs: platformOptions is missing required string field(s): ${missing.join(', ')}`,
    );
  }
  return { repoDir: options['repoDir'] as string, baseDir: options['baseDir'] as string };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
