/** knowledge init/lint - szablony wiedzy i wykrywanie duplikatów. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppMapSchema, UiTrapsSchema } from '@greenproof/core';
import type { GreenproofConfig } from '@greenproof/core';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_MAP_FILE, UI_TRAPS_FILE, cmdKnowledge, knowledgeDir } from '../src/commands.js';
import type { KnowledgeInitOutput, KnowledgeLintOutput } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { exitCodeFor, successOutcome } from '../src/exit-codes.js';
import { cleanupTmp, configObject, initRepo, tmpDir, writeFileIn } from './helpers.js';

afterAll(cleanupTmp);

/** Config wskazujący na świeże repo testów z katalogiem wiedzy. */
async function setup(knowledge: unknown = { dir: 'docs/knowledge' }): Promise<GreenproofConfig> {
  const repoDir = await initRepo();
  const configDir = await tmpDir('gp-cli-cfg-');
  const file = await writeFileIn(
    configDir,
    'greenproof.json',
    JSON.stringify(
      configObject({
        platformOptions: { repoDir, baseDir: configDir },
        paths: { testsRepoDir: repoDir },
        ...(knowledge === null ? {} : { knowledge }),
      }),
    ),
  );
  const { config } = await loadConfig(file);
  return config;
}

describe('knowledge init', () => {
  it('tworzy oba pliki z poprawną pustą strukturą i przykładem w komentarzu', async () => {
    const config = await setup();

    const out = (await cmdKnowledge({ config, input: { action: 'init' } })) as KnowledgeInitOutput;

    const dir = knowledgeDir(config);
    expect(out.created.sort()).toEqual([join(dir, APP_MAP_FILE), join(dir, UI_TRAPS_FILE)].sort());
    expect(out.skipped).toEqual([]);

    const traps = parseYaml(await readFile(join(dir, UI_TRAPS_FILE), 'utf8'));
    const map = parseYaml(await readFile(join(dir, APP_MAP_FILE), 'utf8'));
    expect(UiTrapsSchema.parse(traps)).toEqual({ version: 1, traps: [] });
    expect(AppMapSchema.parse(map)).toEqual({ version: 1, views: [] });
    expect(await readFile(join(dir, UI_TRAPS_FILE), 'utf8')).toMatch(/^# Przykład wpisu/m);
  });

  it('nie nadpisuje istniejących plików', async () => {
    const config = await setup();
    const dir = knowledgeDir(config);
    await writeFileIn(dir, UI_TRAPS_FILE, 'version: 1\ntraps: []\n# moje\n');

    const out = (await cmdKnowledge({ config, input: { action: 'init' } })) as KnowledgeInitOutput;

    expect(out.skipped).toEqual([join(dir, UI_TRAPS_FILE)]);
    expect(out.created).toEqual([join(dir, APP_MAP_FILE)]);
    expect(await readFile(join(dir, UI_TRAPS_FILE), 'utf8')).toMatch(/# moje/);
  });

  it('bez sekcji knowledge w configu → CliError (exit 2)', async () => {
    const config = await setup(null);

    await expect(cmdKnowledge({ config, input: { action: 'init' } })).rejects.toMatchObject({
      name: 'CliError',
    });
  });

  it('nieznana podkomenda → ZodError (exit 2)', async () => {
    const config = await setup();

    await expect(cmdKnowledge({ config, input: { action: 'zrób' } })).rejects.toMatchObject({
      name: 'ZodError',
    });
  });
});

describe('knowledge lint', () => {
  it('świeżo zainicjowana wiedza jest czysta', async () => {
    const config = await setup();
    await cmdKnowledge({ config, input: { action: 'init' } });

    const out = (await cmdKnowledge({ config, input: { action: 'lint' } })) as KnowledgeLintOutput;

    expect(out.ok).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.counts).toEqual({ traps: 0, views: 0 });
    expect(exitCodeFor(successOutcome('knowledge', out))).toBe(0);
  });

  it('wykrywa duplikaty component+trap i route oraz błędy schematu', async () => {
    const config = await setup();
    const dir = knowledgeDir(config);
    await writeFileIn(
      dir,
      UI_TRAPS_FILE,
      [
        'version: 1',
        'traps:',
        '  - component: DatePicker',
        '    trap: pole nie otwiera kalendarza',
        '    workaround: klikaj ikonę',
        '    category: component-behavior',
        '    appliesTo: [contract/annex]',
        '  - component: DatePicker',
        '    trap: pole nie otwiera kalendarza',
        '    workaround: to samo, inny opis',
        '    category: component-behavior',
        '    appliesTo: [payroll/create]',
        '',
      ].join('\n'),
    );
    await writeFileIn(
      dir,
      APP_MAP_FILE,
      [
        'version: 1',
        'views:',
        '  - route: /payroll/new',
        '    navigationSteps: [zaloguj]',
        '    keySelectors: { submit: "role=button" }',
        '  - route: /payroll/new',
        '    navigationSteps: [zaloguj inaczej]',
        '    keySelectors: {}',
        '',
      ].join('\n'),
    );

    const out = (await cmdKnowledge({ config, input: { action: 'lint' } })) as KnowledgeLintOutput;

    expect(out.ok).toBe(false);
    expect(out.duplicates.traps).toEqual(['DatePicker::pole nie otwiera kalendarza']);
    expect(out.duplicates.routes).toEqual(['/payroll/new']);
    expect(out.counts).toEqual({ traps: 2, views: 2 });
    expect(exitCodeFor(successOutcome('knowledge', out))).toBe(2);
  });

  it('brak plików i zły schemat są zgłaszane per plik', async () => {
    const config = await setup();
    const dir = knowledgeDir(config);
    await writeFileIn(dir, UI_TRAPS_FILE, 'version: 2\ntraps: []\n');

    const out = (await cmdKnowledge({ config, input: { action: 'lint' } })) as KnowledgeLintOutput;

    expect(out.ok).toBe(false);
    expect(out.files[0]?.valid).toBe(false);
    expect(out.files[1]?.exists).toBe(false);
    expect(out.errors.join(' ')).toMatch(/brak pliku/);
  });
});
