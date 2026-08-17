/**
 * Porty adapterów platformy. Core nie importuje niczego platformowego -
 * GitHub, filesystem i customowe platformy firmowe implementują te same
 * kontrakty. Wszystkie operacje muszą być idempotentne (komendy CLI mogą
 * być ponawiane po padzie runnera).
 */
import type { Readable } from 'node:stream';
import type { PipelineState } from '../domain/state.js';
import type { HumanReport } from '../domain/report.js';
import type { ProgressSink } from '../domain/progress.js';

export interface FileChange {
  path: string;
  /** null = usunięcie pliku. */
  content: string | null;
}

/** Repozytorium testów (SCM). */
export interface ScmPort {
  ensureBranch(name: string, fromRef: string): Promise<void>;
  commitFiles(
    branch: string,
    files: FileChange[],
    message: string,
  ): Promise<{ sha: string }>;
  readFile(ref: string, path: string): Promise<string | null>;
  listFiles(ref: string, glob: string): Promise<string[]>;
  openPullRequest(p: {
    from: string;
    to: string;
    title: string;
    body: string;
  }): Promise<{ url: string; id: string }>;
  /** No-op w adapterach czysto API-owych (GitHub commituje przez data API). */
  push?(branch: string): Promise<void>;
  /**
   * OPCJONALNE - platformy z własnym cyklem życia branchy (GitHub z auto-delete
   * po merge'u) nie implementują; `greenproof clean` wtedy tylko odnotowuje.
   */
  deleteBranch?(name: string): Promise<void>;
  /** Lista branchy o prefiksie (do sprzątania bocznic run-scoped). OPCJONALNE. */
  listBranches?(prefix: string): Promise<string[]>;
}

/** Trwałe artefakty przebiegu: draft spec, dowód, ledger, transcript, trace. */
export interface ArtifactStore {
  put(
    runId: string,
    key: string,
    data: Buffer | Readable,
    meta?: Record<string, string>,
  ): Promise<void>;
  get(runId: string, key: string): Promise<Buffer | null>;
  list(runId: string, prefix?: string): Promise<string[]>;
  /**
   * OPCJONALNE - platformy z własną retencją (GitHub Actions) nie implementują;
   * `greenproof clean` wtedy odmawia zamiast po cichu nic nie robić.
   */
  delete?(runId: string, key: string): Promise<void>;
}

/**
 * Kanał wychodzący do człowieka. Biblioteka NIGDY nie nasłuchuje - komendy
 * (/retry, /accept) to zdarzenia platformy tłumaczone na wywołania CLI.
 */
export interface HumanChannelPort {
  /**
   * Publikuje raport w "miejscu rozmowy" przebiegu (issue / zadanie platformy).
   * Przez report.reportId aktualizuje istniejący raport zamiast duplikatu.
   */
  postReport(runRef: string, report: HumanReport): Promise<void>;
}

export class StateConflictError extends Error {
  constructor(readonly runId: string) {
    super(`Pipeline state for run ${runId} was modified concurrently`);
    this.name = 'StateConflictError';
  }
}

/** Trwały stan pipeline'u z optimistic lockingiem. */
export interface StateStore {
  load(runId: string): Promise<{ state: PipelineState; version: string } | null>;
  /**
   * expectedVersion = null przy tworzeniu; rzuca StateConflictError, gdy
   * wersja w storze różni się od oczekiwanej.
   */
  save(
    runId: string,
    state: PipelineState,
    expectedVersion: string | null,
  ): Promise<{ version: string }>;
}

/** Minimalny dostęp do sekretów - w CI zwykle po prostu env. */
export interface SecretsPort {
  get(name: string): string | undefined;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** Abstrakcja czasu - testowalność i determinizm. */
export interface Clock {
  now(): Date;
}

export interface Ports {
  scm: ScmPort;
  artifacts: ArtifactStore;
  human: HumanChannelPort;
  state: StateStore;
  secrets: SecretsPort;
  logger: Logger;
  clock: Clock;
  /**
   * Odbiornik zdarzeń postępu (live progress). Dostarcza HOST (CLI/CI), nie
   * adapter; brak = brak emisji. Emisja na stderr hosta - nigdy do stdout
   * (kontrakt JSON CLI).
   */
  progress?: ProgressSink;
}

/** Kontrakt modułu adaptera (`platform` w konfigu): eksportuje default fabrykę o tym kształcie. */
export type PlatformFactory = (options: {
  config: unknown;
  secrets: SecretsPort;
  logger: Logger;
}) => Promise<Ports> | Ports;
