/** loadConfig: formaty plików, defaulty ze schematu, ścieżki względne. */
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { CliError } from '../src/exit-codes.js';
import { cleanupTmp, configObject, tmpDir, writeFileIn } from './helpers.js';

afterAll(cleanupTmp);

describe('loadConfig', () => {
  it('czyta .json, aplikuje defaulty i rozwiązuje testsRepoDir względem configu', async () => {
    const dir = await tmpDir('gp-cfg-');
    const file = await writeFileIn(
      dir,
      'cfg/greenproof.json',
      JSON.stringify(configObject({ paths: { testsRepoDir: '../repo' } })),
    );

    const loaded = await loadConfig(file);

    expect(loaded.path).toBe(file);
    expect(loaded.dir).toBe(join(dir, 'cfg'));
    expect(loaded.config.paths.testsRepoDir).toBe(resolve(dir, 'repo'));
    // Defaulty ze schematu - CLI nigdy nie widzi "brakującego pola".
    expect(loaded.config.paths.specsDir).toBe('tests/e2e');
    expect(loaded.config.caps.maxTurns).toBeGreaterThan(0);
    expect(loaded.config.caps.seedFuse.learn).toBe('propose');
    expect(loaded.config.qualityGates.P0).toBe(1);
  });

  it('czyta .yaml', async () => {
    const dir = await tmpDir('gp-cfg-');
    const file = await writeFileIn(
      dir,
      'greenproof.yaml',
      [
        'platform: "@greenproof/adapter-fs"',
        'plan:',
        '  source: json',
        'model:',
        '  authTokenEnv: GREENPROOF_TOKEN',
        '  author: claude-test',
        'paths:',
        '  testsRepoDir: ./repo',
        'caps:',
        '  maxTurns: 7',
        '',
      ].join('\n'),
    );

    const { config } = await loadConfig(file);

    expect(config.platform).toBe('@greenproof/adapter-fs');
    expect(config.caps.maxTurns).toBe(7);
    expect(config.paths.testsRepoDir).toBe(resolve(dir, 'repo'));
  });

  it('czyta .mjs przez dynamic import (default export)', async () => {
    const dir = await tmpDir('gp-cfg-');
    const file = await writeFileIn(
      dir,
      'greenproof.config.mjs',
      `export default ${JSON.stringify(configObject({ paths: { testsRepoDir: 'repo' } }))};\n`,
    );

    const { config } = await loadConfig(file);

    expect(config.paths.testsRepoDir).toBe(join(dir, 'repo'));
  });

  it('odrzuca .ts z podpowiedzią', async () => {
    const dir = await tmpDir('gp-cfg-');
    const file = await writeFileIn(dir, 'greenproof.config.ts', 'export default {};\n');

    await expect(loadConfig(file)).rejects.toBeInstanceOf(CliError);
    await expect(loadConfig(file)).rejects.toThrow(/\.ts nie jest obsługiwana/);
  });

  it('odrzuca nieznane rozszerzenie i brakujący plik', async () => {
    const dir = await tmpDir('gp-cfg-');
    const weird = await writeFileIn(dir, 'greenproof.conf', 'x');

    await expect(loadConfig(weird)).rejects.toThrow(/Nieznane rozszerzenie/);
    await expect(loadConfig(join(dir, 'nie-ma.json'))).rejects.toBeInstanceOf(CliError);
  });

  it('niepoprawny config kończy się ZodError', async () => {
    const dir = await tmpDir('gp-cfg-');
    const file = await writeFileIn(dir, 'bad.json', JSON.stringify({ platform: '@x/y' }));

    await expect(loadConfig(file)).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('niepoprawny JSON kończy się CliError, nie SyntaxError', async () => {
    const dir = await tmpDir('gp-cfg-');
    const file = await writeFileIn(dir, 'broken.json', '{ nie-json ');

    await expect(loadConfig(file)).rejects.toBeInstanceOf(CliError);
  });
});
