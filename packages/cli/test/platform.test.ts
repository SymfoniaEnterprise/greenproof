/** resolvePlatform / resolvePlanSource / logger na stderr. */
import { afterAll, describe, expect, it } from 'vitest';
import type { GreenproofConfig } from '@greenproof/core';
import { loadConfig } from '../src/config.js';
import { CliError } from '../src/exit-codes.js';
import {
  createStderrLogger,
  envSecrets,
  jsonPlanSource,
  resolvePlanSource,
  resolvePlatform,
} from '../src/platform.js';
import { cleanupTmp, configObject, tmpDir, writeFileIn } from './helpers.js';

afterAll(cleanupTmp);

const FAKE_PLATFORM = `
const noop = async () => undefined;
export default ({ config, secrets, logger }) => ({
  scm: { ensureBranch: noop, commitFiles: noop, readFile: noop, listFiles: noop, openPullRequest: noop },
  artifacts: { put: noop, get: noop, list: noop },
  human: { postReport: noop },
  state: { load: noop, save: noop },
  secrets,
  logger,
  clock: { now: () => new Date(0) },
  seen: config,
});
`;

const FAKE_PARSER = `
export default {
  format: 'fake',
  parse: (input) => ({ slug: 'z-parsera', cases: [], source: { format: 'fake' } }),
};
`;

async function configWith(overrides: Record<string, unknown>): Promise<GreenproofConfig> {
  const dir = await tmpDir('gp-cli-plat-');
  await writeFileIn(dir, 'platform.mjs', FAKE_PLATFORM);
  await writeFileIn(dir, 'parser.mjs', FAKE_PARSER);
  const file = await writeFileIn(
    dir,
    'greenproof.json',
    JSON.stringify(configObject({ paths: { testsRepoDir: '.' }, ...overrides })),
  );
  const { config } = await loadConfig(file);
  return config;
}

describe('resolvePlatform', () => {
  it('woła fabrykę modułu wskazanego ścieżką względną i przekazuje platformOptions', async () => {
    const config = await configWith({
      platform: './platform.mjs',
      platformOptions: { repoDir: '/x', baseDir: '/y' },
    });
    const dir = config.paths.testsRepoDir;

    const ports = (await resolvePlatform(config, {
      secrets: envSecrets,
      logger: createStderrLogger(() => undefined),
      clock: { now: () => new Date(0) },
      baseDir: dir,
    })) as unknown as { seen: unknown; secrets: unknown };

    expect(ports.seen).toEqual({ repoDir: '/x', baseDir: '/y' });
    expect(ports.secrets).toBe(envSecrets);
  });

  it('moduł bez default typu funkcja → CliError', async () => {
    const dir = await tmpDir('gp-cli-plat-');
    await writeFileIn(dir, 'zly.mjs', 'export default { nie: "funkcja" };\n');
    const file = await writeFileIn(
      dir,
      'greenproof.json',
      JSON.stringify(configObject({ platform: './zly.mjs', paths: { testsRepoDir: '.' } })),
    );
    const { config, dir: baseDir } = await loadConfig(file);

    await expect(
      resolvePlatform(config, {
        secrets: envSecrets,
        logger: createStderrLogger(() => undefined),
        clock: { now: () => new Date(0) },
        baseDir,
      }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('nieistniejący moduł → CliError (exit 2), nie surowy ERR_MODULE_NOT_FOUND', async () => {
    const config = await configWith({ platform: './nie-ma.mjs' });

    await expect(
      resolvePlatform(config, {
        secrets: envSecrets,
        logger: createStderrLogger(() => undefined),
        clock: { now: () => new Date(0) },
        baseDir: config.paths.testsRepoDir,
      }),
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe('resolvePlanSource', () => {
  it('source=json waliduje plan schematem', async () => {
    const config = await configWith({ plan: { source: 'json' } });
    const source = await resolvePlanSource(config, config.paths.testsRepoDir);

    expect(source.format).toBe('json');
    expect(source.parse('{"slug":"s","cases":[]}')).toEqual({ slug: 's', cases: [] });
    expect(() => source.parse('{"cases":[]}')).toThrow();
    expect(() => jsonPlanSource().parse('nie-json')).toThrow(CliError);
  });

  it('source=parser ładuje plugin z modułu', async () => {
    const config = await configWith({ plan: { source: 'parser', module: './parser.mjs' } });
    const source = await resolvePlanSource(config, config.paths.testsRepoDir);

    expect(source.format).toBe('fake');
    expect(source.parse('cokolwiek').slug).toBe('z-parsera');
  });
});

describe('logger', () => {
  it('pisze na wskazany strumień, debug tylko po włączeniu', () => {
    const lines: string[] = [];
    const quiet = createStderrLogger((line) => lines.push(line), false);
    quiet.debug('niewidoczne');
    quiet.info('widoczne', { a: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('greenproof info: widoczne {"a":1}');

    const loud = createStderrLogger((line) => lines.push(line), true);
    loud.debug('teraz widać');
    expect(lines).toHaveLength(2);
  });
});
