/**
 * Wczytywanie konfiguracji z pliku --config. Formaty: .json, .yaml/.yml,
 * .mjs/.js/.cjs; .ts nie jest obsługiwany.
 */
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { GreenproofConfigSchema } from '@greenproof/core';
import type { GreenproofConfig } from '@greenproof/core';
import { CliError } from './exit-codes.js';

export const SUPPORTED_CONFIG_EXTENSIONS = [
  '.json',
  '.yaml',
  '.yml',
  '.mjs',
  '.js',
  '.cjs',
] as const;

export interface LoadedConfig {
  /** Komplet pól z defaultami (po GreenproofConfigSchema.parse). */
  config: GreenproofConfig;
  path: string;
  /** Katalog pliku configu - baza ścieżek względnych i importów. */
  dir: string;
}

export function resolveFromConfigDir(configDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(configDir, path);
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const abs = resolve(path);
  const dir = dirname(abs);
  const raw = await readRawConfig(abs);
  const parsed = GreenproofConfigSchema.parse(raw) as GreenproofConfig;
  // testsRepoDir może być względny wobec configu, a core potrzebuje bezwzględnego.
  const config: GreenproofConfig = {
    ...parsed,
    paths: {
      ...parsed.paths,
      testsRepoDir: resolveFromConfigDir(dir, parsed.paths.testsRepoDir),
    },
  };
  return { config, path: abs, dir };
}

async function readRawConfig(abs: string): Promise<unknown> {
  const ext = extname(abs).toLowerCase();
  if (ext === '.ts') {
    throw new CliError(
      `Konfiguracja .ts nie jest obsługiwana (${abs}) - skompiluj ją do .mjs albo użyj .json/.yaml.`,
    );
  }
  switch (ext) {
    case '.json':
      return parseJsonConfig(await readText(abs), abs);
    case '.yaml':
    case '.yml':
      return parseYamlConfig(await readText(abs), abs);
    case '.mjs':
    case '.js':
    case '.cjs':
      return importConfig(abs);
    default:
      throw new CliError(
        `Nieznane rozszerzenie pliku konfiguracyjnego: ${ext || '(brak)'} (${abs}). ` +
          `Obsługiwane: ${SUPPORTED_CONFIG_EXTENSIONS.join(', ')}.`,
      );
  }
}

async function readText(abs: string): Promise<string> {
  try {
    return await readFile(abs, 'utf8');
  } catch (err) {
    throw new CliError(`Nie mogę odczytać pliku konfiguracyjnego ${abs}: ${message(err)}`, 2, {
      cause: err,
    });
  }
}

function parseJsonConfig(text: string, abs: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`Niepoprawny JSON w ${abs}: ${message(err)}`, 2, { cause: err });
  }
}

function parseYamlConfig(text: string, abs: string): unknown {
  try {
    return parseYaml(text);
  } catch (err) {
    throw new CliError(`Niepoprawny YAML w ${abs}: ${message(err)}`, 2, { cause: err });
  }
}

async function importConfig(abs: string): Promise<unknown> {
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
  } catch (err) {
    throw new CliError(`Nie mogę zaimportować konfiguracji ${abs}: ${message(err)}`, 2, {
      cause: err,
    });
  }
  if (mod.default === undefined) {
    throw new CliError(`Moduł konfiguracyjny ${abs} nie ma domyślnego eksportu (export default).`);
  }
  return mod.default;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
