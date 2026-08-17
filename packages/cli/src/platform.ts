/**
 * Rozwiązywanie pluginów z konfigu (adapter `platform`, źródło planu
 * `plan.module`) oraz domyślne SecretsPort/Logger/Clock procesu CLI.
 */
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NormalizedPlanSchema } from '@greenproof/core';
import type {
  Clock,
  GreenproofConfig,
  Logger,
  NormalizedPlan,
  PlanSource,
  PlatformFactory,
  Ports,
  SecretsPort,
} from '@greenproof/core';
import { CliError } from './exit-codes.js';

/** Sekrety w CI to po prostu env procesu joba. */
export const envSecrets: SecretsPort = { get: (name) => process.env[name] };

export const systemClock: Clock = { now: () => new Date() };

/**
 * Logger piszący WYŁĄCZNIE na stderr - stdout zarezerwowany na czysty JSON
 * wyniku. Debug tylko przy GREENPROOF_DEBUG=1.
 */
export function createStderrLogger(
  write: (line: string) => void = (line) => void process.stderr.write(line),
  debugEnabled: boolean = process.env['GREENPROOF_DEBUG'] === '1',
): Logger {
  const emit = (level: string, msg: string, data?: unknown): void => {
    const suffix = data === undefined ? '' : ` ${formatData(data)}`;
    write(`greenproof ${level}: ${msg}${suffix}\n`);
  };
  return {
    debug: (msg, data) => {
      if (debugEnabled) emit('debug', msg, data);
    },
    info: (msg, data) => emit('info', msg, data),
    warn: (msg, data) => emit('warn', msg, data),
    error: (msg, data) => emit('error', msg, data),
  };
}

function formatData(data: unknown): string {
  if (data instanceof Error) return `${data.name}: ${data.message}`;
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

export interface PlatformDeps {
  secrets: SecretsPort;
  logger: Logger;
  clock: Clock;
  /** Baza rozwiązywania specyfikatorów modułów (zwykle katalog configu). */
  baseDir: string;
}

export function defaultPlatformDeps(baseDir: string = process.cwd()): PlatformDeps {
  return { secrets: envSecrets, logger: createStderrLogger(), clock: systemClock, baseDir };
}

/**
 * Import modułu pluginu: ścieżki względne od baseDir, nazwy pakietów najpierw
 * z baseDir (własny adapter projektu), dopiero potem z kontekstu CLI.
 */
export async function importPluginModule(
  specifier: string,
  baseDir: string,
): Promise<Record<string, unknown>> {
  const target = toModuleUrl(specifier, baseDir);
  try {
    return (await import(target)) as Record<string, unknown>;
  } catch (err) {
    throw new CliError(
      `Nie mogę zaimportować modułu '${specifier}' (baza: ${baseDir}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      2,
      { cause: err },
    );
  }
}

function toModuleUrl(specifier: string, baseDir: string): string {
  if (specifier.startsWith('.') || isAbsolute(specifier) || specifier.startsWith('file:')) {
    return specifier.startsWith('file:')
      ? specifier
      : pathToFileURL(resolve(baseDir, specifier)).href;
  }
  try {
    // Sztuczny "plik" w baseDir - createRequire potrzebuje punktu zaczepienia.
    const req = createRequire(join(resolve(baseDir), '__greenproof__.js'));
    return pathToFileURL(req.resolve(specifier)).href;
  } catch {
    // Pakiet nie leży w drzewie projektu - niech ESM spróbuje z kontekstu CLI.
    return specifier;
  }
}

/**
 * Buduje porty przez fabrykę adaptera. Adapter dostaje surowe platformOptions
 * oraz nasze secrets/logger; oddaje komplet portów (własny clock) - nie
 * nadpisujemy go.
 */
export async function resolvePlatform(
  config: GreenproofConfig,
  deps: PlatformDeps = defaultPlatformDeps(),
): Promise<Ports> {
  const mod = await importPluginModule(config.platform, deps.baseDir);
  const factory = mod['default'];
  if (typeof factory !== 'function') {
    throw new CliError(
      `Moduł platformy '${config.platform}' musi eksportować default typu PlatformFactory (funkcja).`,
    );
  }
  const ports = await (factory as PlatformFactory)({
    config: config.platformOptions,
    secrets: deps.secrets,
    logger: deps.logger,
  });
  return ports;
}

/** Wbudowane źródło planu: JSON walidowany schematem NormalizedPlan. */
export function jsonPlanSource(): PlanSource {
  return {
    format: 'json',
    parse(input: string, opts?: { path?: string }): NormalizedPlan {
      let raw: unknown;
      try {
        raw = JSON.parse(input);
      } catch (err) {
        throw new CliError(
          `Plan ${opts?.path ?? '(inline)'} nie jest poprawnym JSON-em: ${
            err instanceof Error ? err.message : String(err)
          }`,
          2,
          { cause: err },
        );
      }
      return NormalizedPlanSchema.parse(raw) as NormalizedPlan;
    },
  };
}

/** Źródło planu z konfigu: passthrough JSON albo plugin `plan.module`. */
export async function resolvePlanSource(
  config: GreenproofConfig,
  baseDir: string,
): Promise<PlanSource> {
  if (config.plan.source === 'json') return jsonPlanSource();
  const mod = await importPluginModule(config.plan.module, baseDir);
  const source = mod['default'];
  if (!isPlanSource(source)) {
    throw new CliError(
      `Moduł planu '${config.plan.module}' musi eksportować default typu PlanSource (z metodą parse).`,
    );
  }
  return source;
}

function isPlanSource(value: unknown): value is PlanSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PlanSource).parse === 'function'
  );
}
