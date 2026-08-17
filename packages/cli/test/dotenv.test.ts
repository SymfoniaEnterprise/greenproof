/**
 * Loader .env obok configu: parser + integracja (CLI wczytuje plik przed
 * komendą, istniejące zmienne środowiska wygrywają).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDotenv } from '../src/dotenv.js';
import { run } from '../src/main.js';
import { cleanupTmp, configObject, tmpDir, writeFileIn } from './helpers.js';

afterEach(cleanupTmp);

describe('parseDotenv', () => {
  it('czyta pary, komentarze, export i cudzysłowy', () => {
    const parsed = parseDotenv(
      [
        '# komentarz',
        '',
        'PLAIN=abc',
        'export EXPORTED=def',
        'QUOTED="z spacją"',
        "SINGLE='pojedyncze'",
        'EQENV=a=b',
        'zły klucz=x',
        'BEZ_WARTOSCI=',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      PLAIN: 'abc',
      EXPORTED: 'def',
      QUOTED: 'z spacją',
      SINGLE: 'pojedyncze',
      EQENV: 'a=b',
      BEZ_WARTOSCI: '',
    });
  });
});

describe('integracja z CLI', () => {
  const KEY = 'GREENPROOF_TEST_DOTENV_VAR';

  afterEach(() => {
    delete process.env[KEY];
  });

  it('.env obok configu jest wczytywany; istniejący env wygrywa', async () => {
    const workDir = await tmpDir('gp-dotenv-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.json',
      JSON.stringify(configObject({ paths: { testsRepoDir: workDir } })),
    );
    await writeFile(join(workDir, '.env'), `${KEY}=z-pliku\n`);

    // Komenda pada na nieistniejącym runie (exit 2) - ale .env ładuje się wcześniej.
    const errIo: string[] = [];
    await run(['status', '--config', configFile, '--run', 'gp-nie-ma'], {
      stdout: () => {},
      stderr: (t) => void errIo.push(t),
    });
    expect(process.env[KEY]).toBe('z-pliku');

    process.env[KEY] = 'z-env';
    await run(['status', '--config', configFile, '--run', 'gp-nie-ma'], {
      stdout: () => {},
      stderr: () => {},
    });
    expect(process.env[KEY]).toBe('z-env');
  });
});
