/**
 * Warstwa binarki bez spawnowania procesu: parser argv i run() z podmienionymi
 * strumieniami. Sprawdza też kontrakt "stdout = czysty JSON, logi na stderr".
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { helpText, parseArgs, run } from '../src/main.js';
import { listModels } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { cleanupTmp, configObject, initRepo, tmpDir, writeFileIn } from './helpers.js';

afterAll(cleanupTmp);

describe('parseArgs', () => {
  it('czyta komendę, pozycyjne i flagi w obu składniach', () => {
    const args = parseArgs([
      'step',
      'filter',
      '--config',
      'gp.json',
      '--in=in.json',
      '--out',
      'out.json',
      '--run',
      'gp-1',
    ]);

    expect(args).toMatchObject({
      command: 'step',
      positionals: ['filter'],
      config: 'gp.json',
      in: 'in.json',
      out: 'out.json',
      run: 'gp-1',
    });
  });

  it('czyta flagi boolowskie --force i --init-only bez wartości', () => {
    expect(
      parseArgs(['run', '--tests-repo', '/tmp/tests', '--config', 'gp.mjs', '--preset=codex-sub', '--init-only', '--force']),
    ).toMatchObject({
      command: 'run',
      preset: 'codex-sub',
      testsRepo: '/tmp/tests',
      config: 'gp.mjs',
      initOnly: true,
      force: true,
    });
    expect(() => parseArgs(['run', '--init-only=true'])).toThrow(/nie przyjmuje wartości/);
    expect(() => parseArgs(['run', '--force=true'])).toThrow(/nie przyjmuje wartości/);
  });

  it('czyta flagę --no-auto-accept jako boolowską', () => {
    expect(parseArgs(['run', '--no-auto-accept']).noAutoAccept).toBe(true);
    expect(parseArgs(['run']).noAutoAccept).toBe(false);
    expect(() => parseArgs(['run', '--no-auto-accept=x'])).toThrow(/nie przyjmuje wartości/);
  });

  it('zbiera podkomendę knowledge jako pozycyjną', () => {
    expect(parseArgs(['knowledge', 'lint', '--config', 'gp.json']).positionals).toEqual(['lint']);
  });

  it('odrzuca nieznaną flagę i flagę bez wartości', () => {
    expect(() => parseArgs(['step', '--nope', 'x'])).toThrow(/Nieznana flaga/);
    expect(() => parseArgs(['step', '--config'])).toThrow(/wymaga wartości/);
    expect(() => parseArgs(['step', '--config', '--in', 'x'])).toThrow(/wymaga wartości/);
  });

  it('rozpoznaje --help i --version', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--version']).version).toBe(true);
  });
});

/** Strumienie zbierane do tablic - stdout musi zostać czystym JSON-em. */
function capture(): {
  out: string[];
  err: string[];
  options: { stdout: (t: string) => void; stderr: (t: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    options: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
  };
}

/** Fake endpoint HTTP na wolnym porcie 127.0.0.1 - bez realnej sieci. */
async function startFakeServer(
  onRequest: (
    req: {
      url?: string;
      method?: string;
      headers: Record<string, string | string[] | undefined>;
    },
    res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void },
  ) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(onRequest);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake endpoint did not bind');
  return {
    port: address.port,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

describe('run', () => {
  it('--help idzie na stdout z kodem 0', async () => {
    const io = capture();
    expect(await run(['--help'], io.options)).toBe(0);
    expect(io.out.join('')).toBe(helpText());
    expect(io.err).toEqual([]);
  });

  it('nieznana komenda → 2', async () => {
    const io = capture();
    expect(await run(['zrób-magię', '--config', 'gp.json'], io.options)).toBe(2);
    expect(io.err.join('')).toMatch(/Nieznana komenda/);
    expect(io.out).toEqual([]);
  });

  it('step bez kroku albo z nieznanym krokiem → 2 z listą dozwolonych kroków', async () => {
    const missing = capture();
    expect(await run(['step'], missing.options)).toBe(2);
    expect(missing.err.join('')).toMatch(/filter \| triage \| author \| deliver/);
    expect(missing.out).toEqual([]);

    const unknown = capture();
    expect(await run(['step', 'magia'], unknown.options)).toBe(2);
    expect(unknown.err.join('')).toMatch(/filter \| triage \| author \| deliver/);
    expect(unknown.out).toEqual([]);
  });

  it('stara nazwa kroku → 2 z podpowiedzią migracji do gp step <krok>', async () => {
    const io = capture();
    expect(await run(['filter', '--config', 'gp.json'], io.options)).toBe(2);
    expect(io.err.join()).toMatch(/przeniesiona: użyj `gp step filter`/);
    expect(io.out).toEqual([]);
  });

  it('step filter działa jak dawny filter (selekcja z planu)', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-stepfilter-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.config.json',
      JSON.stringify(
        configObject({ platformOptions: { repoDir, baseDir: workDir }, paths: { testsRepoDir: repoDir } }),
      ),
    );
    const inFile = await writeFileIn(
      workDir,
      'filter-input.json',
      JSON.stringify({
        slug: 'demo',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: 'step-filter',
        plan: {
          slug: 'demo',
          cases: [{ caseId: 'D-E2E-1', title: 'demo', level: 'e2e', priority: 'P0', requirements: [], flows: [] }],
        },
      }),
    );
    const io = capture();
    const code = await run(['step', 'filter', '--config', configFile, '--in', inFile], io.options);
    expect(code).toBe(0);
    const out = JSON.parse(io.out.join('')) as { runId: string; selected: string[] };
    expect(out.selected).toEqual(['D-E2E-1']);
    expect(out.runId).toBeTruthy();
  });

  it('brak --config → 2', async () => {
    const io = capture();
    expect(await run(['status', '--run', 'gp-1'], io.options)).toBe(2);
    expect(io.err.join('')).toMatch(/--config/);
  });

  it('autodetekcja configu z cwd (greenproof.config.json), gdy brak --config i --tests-repo', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-autodetect-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.config.json',
      JSON.stringify(
        configObject({ platformOptions: { repoDir, baseDir: workDir }, paths: { testsRepoDir: repoDir } }),
      ),
    );
    const oldCwd = process.cwd();
    process.chdir(workDir);
    try {
      const io = capture();
      // Run nie istnieje → exit 2, ale config został autodetekowany z cwd.
      const code = await run(['status', '--run', 'gp-nie-ma'], io.options);
      expect(code).toBe(2);
      expect(io.err.join('')).toMatch(/autodetekcja z cwd/);
      expect(io.err.join('')).toContain(configFile);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it('--tests-repo bez --config dla komendy nie-run używa <repo>/greenproof.config.mjs', async () => {
    const repoDir = await initRepo();
    const baseDir = await tmpDir('gp-cli-base-');
    await writeFileIn(
      repoDir,
      'greenproof.config.mjs',
      `export default ${JSON.stringify(configObject({ platformOptions: { repoDir, baseDir }, paths: { testsRepoDir: '.' } }))};\n`,
    );
    const io = capture();
    const code = await run(['status', '--tests-repo', repoDir, '--run', 'gp-nie-ma'], io.options);
    // Config załadowany z repo (nie błąd configu) - pada dopiero na runie.
    expect(code).toBe(2);
    expect(io.err.join('')).toMatch(/not found in state store/);
    // Kotwica --tests-repo loguje użyty config, jak ścieżka autodetekcji.
    expect(io.err.join('')).toMatch(/config: .*greenproof\.config\.mjs \(--tests-repo\)/);
  });

  it('czytelny błąd, gdy --tests-repo (nie-run) nie zawiera greenproof.config.mjs', async () => {
    const repoDir = await initRepo(); // bez greenproof.config.mjs
    const io = capture();
    expect(await run(['status', '--tests-repo', repoDir, '--run', 'gp-1'], io.options)).toBe(2);
    const err = io.err.join('');
    expect(err).toMatch(/gp run --tests-repo/);
    expect(err).toMatch(/--init-only/);
    expect(err).toMatch(/--config/);
  });

  it('filter --in <plan> + --app-url składa FilterInput z planu', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-planin-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.config.json',
      JSON.stringify(
        configObject({ platformOptions: { repoDir, baseDir: workDir }, paths: { testsRepoDir: repoDir } }),
      ),
    );
    const planFile = await writeFileIn(workDir, 'plan.json', JSON.stringify({ slug: 'z-planu', cases: [] }));
    const io = capture();
    const code = await run(
      ['step', 'filter', '--config', configFile, '--in', planFile, '--app-url', 'https://app.example.test'],
      io.options,
    );
    expect(code).toBe(10);
    expect((JSON.parse(io.out.join('')) as { selected: unknown[] }).selected).toEqual([]);
  });

  it('filter --in z gotowym FilterInput działa bez --app-url', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-filterin-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.config.json',
      JSON.stringify(
        configObject({ platformOptions: { repoDir, baseDir: workDir }, paths: { testsRepoDir: repoDir } }),
      ),
    );
    const inFile = await writeFileIn(
      workDir,
      'filter-input.json',
      JSON.stringify({
        slug: 'empty',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: 'empty-run',
        plan: { slug: 'empty', cases: [] },
      }),
    );
    const io = capture();
    const code = await run(['step', 'filter', '--config', configFile, '--in', inFile], io.options);
    expect(code).toBe(10);
    expect((JSON.parse(io.out.join('')) as { selected: unknown[] }).selected).toEqual([]);
  });

  it('--in nie będący ani FilterInput, ani planem → jeden błąd z obiema przyczynami', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-badin-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.config.json',
      JSON.stringify(
        configObject({ platformOptions: { repoDir, baseDir: workDir }, paths: { testsRepoDir: repoDir } }),
      ),
    );
    const badFile = await writeFileIn(workDir, 'bad.json', JSON.stringify({ hello: 'world' }));
    const io = capture();
    const code = await run(
      ['step', 'filter', '--config', configFile, '--in', badFile, '--app-url', 'https://app.example.test'],
      io.options,
    );
    expect(code).toBe(2);
    const err = io.err.join('');
    expect(err).toMatch(/jako FilterInput/);
    expect(err).toMatch(/jako plan/);
  });

  it('pełny przebieg filter → status po runId, JSON na stdout i do --out', async () => {
    const repoDir = await initRepo();
    const baseDir = await tmpDir('gp-cli-base-');
    const workDir = await tmpDir('gp-cli-work-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.json',
      JSON.stringify(
        configObject({
          platformOptions: { repoDir, baseDir },
          paths: { testsRepoDir: repoDir },
        }),
      ),
    );
    const inFile = await writeFileIn(
      workDir,
      'filter-in.json',
      JSON.stringify({
        slug: 'demo',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: '7',
        plan: {
          slug: 'demo',
          cases: [
            {
              caseId: 'D-E2E-1',
              title: 'demo',
              level: 'e2e',
              priority: 'P0',
              requirements: [],
              flows: [],
            },
          ],
        },
      }),
    );
    const outFile = join(workDir, 'out', 'filter.json');

    const filterIo = capture();
    const code = await run(
      ['step', 'filter', '--config', configFile, '--in', inFile, '--out', outFile],
      filterIo.options,
    );

    expect(code).toBe(0);
    const stdout = JSON.parse(filterIo.out.join('')) as { runId: string; selected: string[] };
    expect(stdout.selected).toEqual(['D-E2E-1']);
    expect(JSON.parse(await readFile(outFile, 'utf8'))).toEqual(stdout);

    // status wystarcza z samym --run (bez pliku wejściowego)
    const statusIo = capture();
    const statusCode = await run(
      ['status', '--config', configFile, '--run', stdout.runId],
      statusIo.options,
    );

    expect(statusCode).toBe(0);
    const state = JSON.parse(statusIo.out.join('')) as { runId: string };
    expect(state.runId).toBe(stdout.runId);
  });

  it('status --cases czyta per-case rollup z ledgerów (read-only) po filtrze', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-work-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.json',
      JSON.stringify(
        configObject({
          platformOptions: { repoDir, baseDir: workDir },
          paths: { testsRepoDir: repoDir },
        }),
      ),
    );
    const inFile = await writeFileIn(
      workDir,
      'filter-in.json',
      JSON.stringify({
        slug: 'demo',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: '8',
        plan: {
          slug: 'demo',
          cases: [
            {
              caseId: 'D-E2E-2',
              title: 'demo',
              level: 'e2e',
              priority: 'P0',
              requirements: [],
              flows: [],
            },
          ],
        },
      }),
    );

    const filterIo = capture();
    await run(['step', 'filter', '--config', configFile, '--in', inFile], filterIo.options);
    const runId = (JSON.parse(filterIo.out.join('')) as { runId: string }).runId;

    const io = capture();
    const code = await run(['status', '--cases', '--config', configFile, '--run', runId], io.options);

    expect(code).toBe(0);
    const out = JSON.parse(io.out.join('')) as {
      runId: string;
      summary: { total: number };
      version: string;
      cases: unknown[];
      totals: { attempts: number; reusedPomsTop: unknown[] };
    };
    expect(out.runId).toBe(runId);
    expect(out.summary.total).toBe(1);
    expect(out.cases).toHaveLength(1);
    expect(out.totals.attempts).toBe(0); // po samym filtrze nie ma jeszcze ledgerów
    expect(out.totals.reusedPomsTop).toEqual([]);
    expect(typeof out.version).toBe('string');
  });

  it('status bez flagi nie dokłada sekcji cases/totals (kształt jak dotąd)', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-work-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.json',
      JSON.stringify(
        configObject({
          platformOptions: { repoDir, baseDir: workDir },
          paths: { testsRepoDir: repoDir },
        }),
      ),
    );
    const inFile = await writeFileIn(
      workDir,
      'filter-in.json',
      JSON.stringify({
        slug: 'demo',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: '9',
        plan: {
          slug: 'demo',
          cases: [{ caseId: 'D-E2E-3', title: 'demo', level: 'e2e', priority: 'P0', requirements: [], flows: [] }],
        },
      }),
    );

    const filterIo = capture();
    await run(['step', 'filter', '--config', configFile, '--in', inFile], filterIo.options);
    const runId = (JSON.parse(filterIo.out.join('')) as { runId: string }).runId;

    const io = capture();
    const code = await run(['status', '--config', configFile, '--run', runId], io.options);

    expect(code).toBe(0);
    const out = JSON.parse(io.out.join('')) as {
      runId: string;
      summary: Record<string, unknown>;
      version: string;
      cases: Record<string, unknown> | unknown[];
      totals: Record<string, unknown>;
    };
    expect(out.runId).toBe(runId);
    expect('summary' in out).toBe(true);
    // Kształt jak dotąd: cases to mapa stanu (nie tablica rollupu), totals to
    // proste { costUsd, turns } bez pól StatsTotals.
    expect(Array.isArray(out.cases)).toBe(false);
    expect('attempts' in out.totals).toBe(false);
    expect('reusedPomsTop' in out.totals).toBe(false);
  });

  it('stats daje exit 2 z podpowiedzią gp status --cases', async () => {
    const io = capture();
    expect(await run(['stats', '--config', 'gp.json', '--run', 'r'], io.options)).toBe(2);
    expect(io.err.join()).toMatch(/przeniesiona: użyj `gp status --cases`/);
    expect(io.out).toEqual([]);
  });

  it('--cases przy innej komendzie niż status → exit 2', async () => {
    const io = capture();
    expect(await run(['models', '--cases', '--config', 'gp.json'], io.options)).toBe(2);
    expect(io.err.join()).toMatch(/--cases.*status/);
    expect(io.out).toEqual([]);
  });

  it('--no-auto-accept przy innej komendzie niż run → exit 2', async () => {
    const io = capture();
    expect(await run(['status', '--no-auto-accept', '--config', 'gp.json', '--run', 'r'], io.options)).toBe(2);
    expect(io.err.join()).toMatch(/--no-auto-accept.*run/);
    expect(io.out).toEqual([]);
  });

  it('GREENPROOF_PROGRESS=json emituje step-eventy NDJSON na stderr, stdout czysty', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-work-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.json',
      JSON.stringify(
        configObject({
          platformOptions: { repoDir, baseDir: workDir },
          paths: { testsRepoDir: repoDir },
        }),
      ),
    );
    const inFile = await writeFileIn(
      workDir,
      'filter-in.json',
      JSON.stringify({
        slug: 'demo',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: '7',
        plan: { slug: 'demo', cases: [] },
      }),
    );

    const io = capture();
    const code = await run(['step', 'filter', '--config', configFile, '--in', inFile], {
      ...io.options,
      env: { GREENPROOF_PROGRESS: 'json' },
      isTTY: false,
    });

    expect(code).toBe(10); // pusta selekcja - ale postęp i tak zaraportowany
    const events = io.err
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { kind: string; name?: string; phase?: string });
    expect(events.some((e) => e.kind === 'step' && e.name === 'filter' && e.phase === 'start')).toBe(
      true,
    );
    expect(events.some((e) => e.kind === 'step' && e.name === 'filter' && e.phase === 'end')).toBe(
      true,
    );
    // stdout: wyłącznie JSON wyniku.
    expect(() => JSON.parse(io.out.join(''))).not.toThrow();
  });

  it('knowledge init/lint działa bez portów platformy', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-work-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.json',
      JSON.stringify(
        configObject({
          // Celowo niedziałająca platforma - knowledge nie może jej potrzebować.
          platform: './nie-ma-takiego-adaptera.mjs',
          paths: { testsRepoDir: repoDir },
          knowledge: { dir: 'docs/knowledge' },
        }),
      ),
    );

    const initIo = capture();
    expect(await run(['knowledge', 'init', '--config', configFile], initIo.options)).toBe(0);
    const init = JSON.parse(initIo.out.join('')) as { created: string[] };
    expect(init.created).toHaveLength(2);

    const lintIo = capture();
    expect(await run(['knowledge', 'lint', '--config', configFile], lintIo.options)).toBe(0);

    const bareIo = capture();
    expect(await run(['knowledge', '--config', configFile], bareIo.options)).toBe(2);
    expect(bareIo.err.join('')).toMatch(/init/);
  });

  it('run --init-only tworzy ładowalny config Luna, odmawia overwrite i honoruje --force', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-init-');
    const configFile = join(workDir, 'generated', 'greenproof.config.mjs');

    const io = capture();
    expect(
      await run(
        // --base-url na zamknięty port wymusza fallback auto → preset
        // (deterministycznie, bez zależności od tego, co słucha na :8317).
        ['run', '--tests-repo', repoDir, '--init-only', '--config', configFile, '--base-url', 'http://127.0.0.1:1'],
        io.options,
      ),
    ).toBe(0);
    const output = JSON.parse(io.out.join('')) as {
      path: string;
      preset: string;
      testsRepoDir: string;
      author: string;
      fixtureAuthor: string;
      fixtureAuthorSource: string;
    };
    expect(output).toMatchObject({
      path: configFile,
      preset: 'codex-sub',
      testsRepoDir: repoDir,
      author: 'gpt-5.6-luna(max)',
      fixtureAuthor: 'gpt-5.6-sol(high)',
      fixtureAuthorSource: 'preset',
    });

    const source = await readFile(configFile, 'utf8');
    expect(source).not.toMatch(/sk-[A-Za-z0-9]/);
    // Wygenerowany config bywa commitowany i uruchamiany na innej platformie
    // niż ta, na której powstał - musi rozgałęziać się W RUNTIME, a nie mieć
    // wpisanego wyniku dla platformy generującej.
    expect(source).toContain("process.platform === 'win32'");
    expect(source).toContain('LOCALAPPDATA');
    expect(source).toContain('XDG_DATA_HOME');
    expect(source).not.toMatch(/command: \['npx\.cmd'/);
    const loaded = await loadConfig(configFile);
    expect(loaded.config.platform).toBe('@greenproof/adapter-fs');
    expect(loaded.config.paths.testsRepoDir).toBe(repoDir);
    expect(loaded.config.model.authTokenEnv).toBe('CLIPROXY_TOKEN');
    expect(loaded.config.caps.maxTurns).toBe(400);
    expect(loaded.config.caps.fixtureSession).toEqual({
      maxTurns: 80,
      maxTimeMinutes: 30,
      maxCostUsd: 1,
    });

    const overwrite = capture();
    expect(await run(['run', '--tests-repo', repoDir, '--init-only', '--config', configFile], overwrite.options)).toBe(2);
    expect(overwrite.out).toEqual([]);
    expect(overwrite.err.join('')).toMatch(/już istnieje/);

    const forced = capture();
    expect(
      await run(
        ['run', '--tests-repo', repoDir, '--init-only', '--config', configFile, '--force', '--base-url', 'http://127.0.0.1:1'],
        forced.options,
      ),
    ).toBe(0);
  });

  it('run --init-only --preset litellm: model z bramy + eskalacja claude-sonnet-5 (też przez bramę)', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-init-');
    const configFile = join(workDir, 'litellm.config.mjs');

    const io = capture();
    expect(
      await run(
        // Zamknięty port: tryb auto nie ma listy → fallback na preset.
        ['run', '--tests-repo', repoDir, '--init-only', '--preset', 'litellm', '--config', configFile, '--base-url', 'http://127.0.0.1:1'],
        io.options,
      ),
    ).toBe(0);
    const output = JSON.parse(io.out.join('')) as {
      preset: string; author: string; tokenEnv: string; baseUrl: string | null; fixtureAuthor: string | null;
    };
    expect(output).toMatchObject({
      preset: 'litellm',
      // Preset bramy nie zgaduje nazwy modelu - aliasy LiteLLM są instalacyjne.
      author: '<model-z-bramy>',
      tokenEnv: 'LITELLM_KEY',
      baseUrl: 'http://127.0.0.1:1',
      fixtureAuthor: 'claude-sonnet-5',
    });

    const loaded = await loadConfig(configFile);
    expect(loaded.config.model.authTokenEnv).toBe('LITELLM_KEY');
    expect(loaded.config.model.fixtureAuthor).toEqual({ model: 'claude-sonnet-5' });
    expect(loaded.config.caps.fixtureSession.maxCostUsd).toBe(2.5);
  });

  it('run --init-only: flagi nadpisują preset pole po polu, "none" wyłącza eskalację', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-init-');
    const configFile = join(workDir, 'custom.config.mjs');

    const io = capture();
    expect(
      await run(
        [
          'run', '--tests-repo', repoDir, '--init-only', '--preset', 'litellm', '--config', configFile,
          '--author', 'gemini-3.7-openrouter', '--token-env', 'MOJ_KLUCZ',
          '--fixture-author', 'none',
        ],
        io.options,
      ),
    ).toBe(0);
    const output = JSON.parse(io.out.join('')) as { author: string; fixtureAuthor: string | null; fixtureAuthorSource: string };
    expect(output.author).toBe('gemini-3.7-openrouter');
    expect(output.fixtureAuthor).toBeNull();
    expect(output.fixtureAuthorSource).toBe('none');

    const loaded = await loadConfig(configFile);
    expect(loaded.config.model.author).toBe('gemini-3.7-openrouter');
    expect(loaded.config.model.authTokenEnv).toBe('MOJ_KLUCZ');
    expect(loaded.config.model.fixtureAuthor).toBeUndefined();
    // Nadpisany model dostaje zerowy wpis priceTable (miękkie capy $).
    expect(loaded.config.model.priceTable?.['gemini-3.7-openrouter']).toEqual({
      inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0,
    });
  });

  it('run --init-only: --fixture-author auto wybiera z listy /v1/models wg rankingu (case-insensitive, sufiks zachowany)', async () => {
    const server = await startFakeServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'GPT-5.6-LUNA' }, { id: 'GPT-5.6-SOL' }] }));
    });

    try {
      const repoDir = await initRepo();
      const workDir = await tmpDir('gp-cli-init-');
      const configFile = join(workDir, 'auto.config.mjs');

      const io = capture();
      expect(
        await run(
          [
            'run', '--tests-repo', repoDir, '--init-only', '--preset', 'codex-sub', '--config', configFile,
            '--base-url', `http://127.0.0.1:${server.port}`, '--fixture-author', 'auto',
          ],
          io.options,
        ),
      ).toBe(0);
      const output = JSON.parse(io.out.join('')) as { fixtureAuthor: string | null; fixtureAuthorSource: string };
      // Pierwszy z rankingu codex-sub (gpt-5.6-sol(high)) pasuje po nazwie bazowej
      // bez względu na wielkość liter; do configu idzie wpis rankingu (z sufiksem).
      expect(output).toMatchObject({ fixtureAuthor: 'gpt-5.6-sol(high)', fixtureAuthorSource: 'endpoint' });

      const loaded = await loadConfig(configFile);
      expect(loaded.config.model.fixtureAuthor).toEqual({ model: 'gpt-5.6-sol(high)' });
    } finally {
      await server.close();
    }
  });

  it('run --init-only: auto gdy żaden model z rankingu nie pasuje → fallback na preset', async () => {
    const server = await startFakeServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'kimi-k3' }] }));
    });

    try {
      const repoDir = await initRepo();
      const workDir = await tmpDir('gp-cli-init-');
      const configFile = join(workDir, 'auto-nopass.config.mjs');

      const io = capture();
      expect(
        await run(
          [
            'run', '--tests-repo', repoDir, '--init-only', '--preset', 'litellm', '--config', configFile,
            '--base-url', `http://127.0.0.1:${server.port}`,
          ],
          io.options,
        ),
      ).toBe(0);
      const output = JSON.parse(io.out.join('')) as { fixtureAuthor: string | null; fixtureAuthorSource: string };
      expect(output).toMatchObject({ fixtureAuthor: 'claude-sonnet-5', fixtureAuthorSource: 'preset' });
      expect(io.err.join('')).toMatch(/nie pasował/);
    } finally {
      await server.close();
    }
  });

  it('run --init-only: auto gdy lista niedostępna (404) → fallback na preset, powód w logu', async () => {
    const server = await startFakeServer((req, res) => {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'not found' }));
    });

    try {
      const repoDir = await initRepo();
      const workDir = await tmpDir('gp-cli-init-');
      const configFile = join(workDir, 'auto-404.config.mjs');

      const io = capture();
      expect(
        await run(
          [
            'run', '--tests-repo', repoDir, '--init-only', '--preset', 'codex-sub', '--config', configFile,
            '--base-url', `http://127.0.0.1:${server.port}`,
          ],
          io.options,
        ),
      ).toBe(0);
      const output = JSON.parse(io.out.join('')) as { fixtureAuthor: string | null; fixtureAuthorSource: string };
      expect(output).toMatchObject({ fixtureAuthor: 'gpt-5.6-sol(high)', fixtureAuthorSource: 'preset' });
      expect(io.err.join('')).toMatch(/lista modeli niedostępna/);
    } finally {
      await server.close();
    }
  });

  it('run --init-only: token wyłącznie w <tests-repo>/.env → tryb auto wybiera z listy (endpoint)', async () => {
    const TOKEN = 'sekret-z-dotenv';
    // Lista wymaga poprawnego tokenu (x-api-key) - bez wczytania .env tryb
    // auto dostałby 401 i cicho cofnął się do presetu.
    const server = await startFakeServer((req, res) => {
      if (req.headers['x-api-key'] === TOKEN) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }] }));
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    });

    const prev = process.env['LITELLM_KEY'];
    delete process.env['LITELLM_KEY'];
    try {
      const repoDir = await initRepo();
      await writeFileIn(repoDir, '.env', `LITELLM_KEY=${TOKEN}\n`);

      const io = capture();
      expect(
        await run(
          [
            'run', '--tests-repo', repoDir, '--init-only', '--preset', 'litellm',
            '--base-url', `http://127.0.0.1:${server.port}`,
          ],
          io.options,
        ),
      ).toBe(0);
      const output = JSON.parse(io.out.join('')) as { fixtureAuthor: string | null; fixtureAuthorSource: string };
      expect(output).toMatchObject({ fixtureAuthor: 'claude-sonnet-5', fixtureAuthorSource: 'endpoint' });
    } finally {
      if (prev === undefined) delete process.env['LITELLM_KEY'];
      else process.env['LITELLM_KEY'] = prev;
      await server.close();
    }
  });

  it('run --init-only: jawna nazwa modelu eskalacji → source flag (bez zapytania o listę)', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-init-');
    const configFile = join(workDir, 'flag.config.mjs');

    const io = capture();
    expect(
      await run(
        [
          'run', '--tests-repo', repoDir, '--init-only', '--preset', 'codex-sub', '--config', configFile,
          '--fixture-author', 'gpt-5.6-sol',
        ],
        io.options,
      ),
    ).toBe(0);
    const output = JSON.parse(io.out.join('')) as { fixtureAuthor: string | null; fixtureAuthorSource: string };
    expect(output).toMatchObject({ fixtureAuthor: 'gpt-5.6-sol', fixtureAuthorSource: 'flag' });
  });

  it('run --init-only: --fixture-author spoza presetu dokłada zerowy wpis priceTable (capy kosztowe gryzą)', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-init-');
    const configFile = join(workDir, 'fx-price.config.mjs');

    const io = capture();
    expect(
      await run(
        [
          'run', '--tests-repo', repoDir, '--init-only', '--preset', 'codex-sub', '--config', configFile,
          '--fixture-author', 'deepseek-v4-pro',
        ],
        io.options,
      ),
    ).toBe(0);

    const loaded = await loadConfig(configFile);
    expect(loaded.config.model.fixtureAuthor).toEqual({ model: 'deepseek-v4-pro' });
    expect(loaded.config.model.priceTable?.['deepseek-v4-pro']).toEqual({
      inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0,
    });
  });

  it('run --init-only: auto z listy endpointu dokłada zerowy wpis priceTable dla modelu spoza presetu', async () => {
    const server = await startFakeServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }));
    });

    try {
      const repoDir = await initRepo();
      const workDir = await tmpDir('gp-cli-init-');
      const configFile = join(workDir, 'fx-auto-price.config.mjs');

      const io = capture();
      expect(
        await run(
          [
            'run', '--tests-repo', repoDir, '--init-only', '--preset', 'litellm', '--config', configFile,
            '--base-url', `http://127.0.0.1:${server.port}`,
          ],
          io.options,
        ),
      ).toBe(0);
      const output = JSON.parse(io.out.join('')) as { fixtureAuthor: string | null; fixtureAuthorSource: string };
      expect(output).toMatchObject({ fixtureAuthor: 'claude-opus-5', fixtureAuthorSource: 'endpoint' });

      const loaded = await loadConfig(configFile);
      expect(loaded.config.model.fixtureAuthor).toEqual({ model: 'claude-opus-5' });
      expect(loaded.config.model.priceTable?.['claude-opus-5']).toEqual({
        inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0,
      });
    } finally {
      await server.close();
    }
  });

  it('models: niedostępny endpoint → available:false, pusta lista i exit 0', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-models-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.json',
      JSON.stringify(
        configObject({
          platformOptions: { repoDir, baseDir: workDir },
          paths: { testsRepoDir: repoDir },
          model: { baseUrl: 'http://127.0.0.1:1', authTokenEnv: 'GREENPROOF_TOKEN', author: 'claude-test' },
        }),
      ),
    );

    const io = capture();
    expect(await run(['models', '--config', configFile], io.options)).toBe(0);
    const out = JSON.parse(io.out.join('')) as {
      endpoint: string;
      available: boolean;
      models: unknown[];
      note?: string;
    };
    expect(out.available).toBe(false);
    expect(out.models).toEqual([]);
    expect(out.note).toBeTruthy();
  });

  it('models: endpoint z listą → available:true i modele z data[].id', async () => {
    const server = await startFakeServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'claude-opus-5' }, { id: 'deepseek-v4-pro' }] }));
    });

    try {
      const repoDir = await initRepo();
      const workDir = await tmpDir('gp-cli-models-');
      const configFile = await writeFileIn(
        workDir,
        'greenproof.json',
        JSON.stringify(
          configObject({
            platformOptions: { repoDir, baseDir: workDir },
            paths: { testsRepoDir: repoDir },
            model: { baseUrl: `http://127.0.0.1:${server.port}`, authTokenEnv: 'GREENPROOF_TOKEN', author: 'claude-test' },
          }),
        ),
      );

      const io = capture();
      expect(await run(['models', '--config', configFile], io.options)).toBe(0);
      const out = JSON.parse(io.out.join('')) as { available: boolean; models: string[] };
      expect(out.available).toBe(true);
      expect(out.models).toEqual(['claude-opus-5', 'deepseek-v4-pro']);
    } finally {
      await server.close();
    }
  });

  it('listModels: Authorization: Bearer tylko przy własnym baseUrl', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchMock = vi.fn(
      async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(JSON.stringify({ data: [{ id: 'm-1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await listModels({ baseUrl: 'http://127.0.0.1:4000', token: 'tok' });
      expect(calls[0]?.headers['x-api-key']).toBe('tok');
      expect(calls[0]?.headers['authorization']).toBe('Bearer tok');

      // Bez baseUrl (domyślny endpoint Anthropic): sam x-api-key, bez Bearera.
      await listModels({ token: 'tok' });
      expect(calls[1]?.headers['x-api-key']).toBe('tok');
      expect(calls[1]?.headers['authorization']).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('run --init-only: nieznany preset → exit 2 z listą dostępnych; flagi poza run → exit 2', async () => {
    const repoDir = await initRepo();
    const io = capture();
    expect(await run(['run', '--preset', 'zmyslony', '--tests-repo', repoDir, '--init-only'], io.options)).toBe(2);
    expect(io.err.join('')).toMatch(/codex-sub, litellm, claude-sub/);

    const misuse = capture();
    expect(await run(['status', '--author', 'x', '--config', 'nie-ma.json'], misuse.options)).toBe(2);
    expect(misuse.err.join('')).toMatch(/wyłącznie dla komendy run/);
  });

  it('init daje exit 2 z komunikatem migracyjnym; --init-only przy innej komendzie daje exit 2', async () => {
    const repoDir = await initRepo();
    const initIo = capture();
    expect(await run(['init', '--tests-repo', repoDir], initIo.options)).toBe(2);
    expect(initIo.err.join('')).toMatch(/Komenda `init` została przeniesiona: użyj `gp run --tests-repo <p> --init-only`/);

    const stepIo = capture();
    expect(await run(['step', 'filter', '--init-only', '--config', 'cfg.json'], stepIo.options)).toBe(2);
    expect(stepIo.err.join('')).toMatch(/Flaga --init-only jest dostępna wyłącznie dla komendy run/);

    const forceIo = capture();
    expect(await run(['run', '--config', 'cfg.json', '--in', 'in.json', '--force'], forceIo.options)).toBe(2);
    expect(forceIo.err.join('')).toMatch(/Flaga --force jest dostępna wyłącznie dla komendy run z flagą --init-only/);
  });

  it('run od zera: --tests-repo + flagi → scaffold, config i wejście z --app-url/--in', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { tools?: unknown };
        const response = parsed.tools
          ? { content: [{ type: 'tool_use', id: 'tool-1', name: 'get_status', input: {} }] }
          : { content: [{ type: 'text', text: 'pong' }] };
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(response));
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fake endpoint did not bind');
    process.env['GREENPROOF_SKIP_INSTALL'] = '1';
    process.env['FAKE_TOKEN'] = 'x';

    try {
      const workDir = await tmpDir('gp-cli-onecmd-');
      const testsRepo = join(workDir, 'testy'); // NIE istnieje - scaffold ma powstać sam
      const planFile = await writeFileIn(
        workDir,
        'plan.json',
        JSON.stringify({ slug: 'jednokomendowy', cases: [] }),
      );

      const io = capture();
      const code = await run(
        [
          'run',
          '--tests-repo', testsRepo,
          '--preset', 'litellm',
          // Preset bramy ma placeholder zamiast nazwy modelu (aliasy LiteLLM są
          // instalacyjne), więc autora podaje się flagą - bez niej preflight
          // celowo przerywa run.
          '--author', 'model-z-mojej-bramy',
          '--base-url', `http://127.0.0.1:${address.port}`,
          '--token-env', 'FAKE_TOKEN',
          '--fixture-author', 'none',
          '--app-url', 'https://app.example.test',
          '--in', planFile,
        ],
        io.options,
      );

      // Pusty plan → filter nic nie wybrał (exit 10), ale cała maszyneria zagrała.
      expect(code).toBe(10);
      const out = JSON.parse(io.out.join('')) as {
        preflight: { ok: boolean };
        filter: { selected: unknown[] } | null;
      };
      expect(out.preflight.ok).toBe(true);
      expect(out.filter?.selected).toEqual([]);
      // Scaffold + config powstały w repo testów.
      expect(existsSync(join(testsRepo, '.git'))).toBe(true);
      expect(existsSync(join(testsRepo, 'greenproof.config.mjs'))).toBe(true);
      const pwConfig = await readFile(join(testsRepo, 'playwright.config.ts'), 'utf8');
      expect(pwConfig).toContain('https://app.example.test');

      // Drugie uruchomienie reużywa config (bez --preset), wejście z tych samych flag.
      const again = capture();
      expect(
        await run(
          ['run', '--tests-repo', testsRepo, '--app-url', 'https://app.example.test', '--in', planFile],
          again.options,
        ),
      ).toBe(10);
    } finally {
      delete process.env['GREENPROOF_SKIP_INSTALL'];
      delete process.env['FAKE_TOKEN'];
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('run: --tests-repo z gotowym configiem ustawia GREENPROOF_TESTS_REPO (konwencja configów referencyjnych)', async () => {
    process.env['GREENPROOF_SKIP_INSTALL'] = '1';
    delete process.env['GREENPROOF_TESTS_REPO'];
    try {
      const workDir = await tmpDir('gp-cli-tr-');
      const testsRepo = join(workDir, 'wskazane-repo');
      // Config w stylu configs/*.config.mjs: repo testów z env.
      const configFile = join(workDir, 'ref.config.mjs');
      await writeFileIn(
        workDir,
        'ref.config.mjs',
        [
          "import { join } from 'node:path';",
          `const testsRepoDir = process.env.GREENPROOF_TESTS_REPO ?? ${JSON.stringify(join(workDir, 'domyslne-repo'))};`,
          'export default {',
          "  platform: '@greenproof/adapter-fs',",
          `  platformOptions: { repoDir: testsRepoDir, baseDir: ${JSON.stringify(join(workDir, 'platform'))} },`,
          "  plan: { source: 'json' },",
          "  model: { authTokenEnv: 'FAKE_TOKEN', author: 'fake', baseUrl: 'http://127.0.0.1:1' },",
          '  paths: { testsRepoDir },',
          '};',
        ].join('\n'),
      );

      const planFile = await writeFileIn(workDir, 'plan.json', JSON.stringify({ slug: 'ref', cases: [] }));
      const io = capture();
      // Preflight na porcie 1 padnie (ok=false, exit inny niż 2 walidacji) -
      // wystarcza nam, że scaffold poszedł we WSKAZANE repo, nie domyślne.
      await run(
        [
          'run', '--config', configFile, '--tests-repo', testsRepo,
          '--app-url', 'https://x.test', '--in', planFile,
        ],
        io.options,
      );
      expect(existsSync(join(testsRepo, '.git'))).toBe(true);
      expect(existsSync(join(workDir, 'domyslne-repo'))).toBe(false);
    } finally {
      delete process.env['GREENPROOF_SKIP_INSTALL'];
      delete process.env['GREENPROOF_TESTS_REPO'];
    }
  });

  it('run: czytelne błędy przy braku configu/wejścia', async () => {
    // Fail-fast: brak --in bije PRZED rozpoznaniem configu (zero scaffoldu).
    const io = capture();
    expect(await run(['run'], io.options)).toBe(2);
    expect(io.err.join('')).toMatch(/--in <filter-input\.json/);

    const workDir = await tmpDir('gp-cli-onecmd-');
    const repoDir = await initRepo();
    const configFile = await writeFileIn(
      workDir,
      'greenproof.json',
      JSON.stringify(
        configObject({
          platformOptions: { repoDir, baseDir: workDir },
          paths: { testsRepoDir: repoDir },
        }),
      ),
    );
    process.env['GREENPROOF_SKIP_INSTALL'] = '1';
    try {
      const noInput = capture();
      expect(await run(['run', '--config', configFile], noInput.options)).toBe(2);
      expect(noInput.err.join('')).toMatch(/--in <filter-input\.json/);
    } finally {
      delete process.env['GREENPROOF_SKIP_INSTALL'];
    }
  });

  it('run --tests-repo bez --in → exit 2, zero scaffoldu i configu (fail-fast przed scaffoldem)', async () => {
    const repoDir = await initRepo();
    const before = await readdir(repoDir);
    process.env['GREENPROOF_SKIP_INSTALL'] = '1';
    try {
      const io = capture();
      expect(await run(['run', '--tests-repo', repoDir], io.options)).toBe(2);
      expect(io.err.join('')).toMatch(/--in <filter-input\.json/);
      // Brak efektów ubocznych: katalog repo wygląda dokładnie jak przed runem
      // (żadnego greenproof.config.mjs ani artefaktów scaffoldu).
      const after = await readdir(repoDir);
      expect(after.sort()).toEqual(before);
      expect(existsSync(join(repoDir, 'greenproof.config.mjs'))).toBe(false);
      expect(existsSync(join(repoDir, 'package.json'))).toBe(false);
      expect(existsSync(join(repoDir, 'playwright.config.ts'))).toBe(false);
    } finally {
      delete process.env['GREENPROOF_SKIP_INSTALL'];
    }
  });

  it('run --tests-repo --in <nieistniejący plik> → exit 2, zero scaffoldu i configu', async () => {
    const repoDir = await initRepo();
    process.env['GREENPROOF_SKIP_INSTALL'] = '1';
    try {
      const io = capture();
      const missing = join(repoDir, 'nie-ma-takiego.json');
      expect(await run(['run', '--tests-repo', repoDir, '--in', missing], io.options)).toBe(2);
      expect(io.err.join('')).toMatch(/Nie mogę odczytać pliku wejściowego/);
      // Fail-fast przed scaffoldem/initem: żadnych artefaktów w repo testów.
      expect(existsSync(join(repoDir, 'package.json'))).toBe(false);
      expect(existsSync(join(repoDir, 'greenproof.config.mjs'))).toBe(false);
    } finally {
      delete process.env['GREENPROOF_SKIP_INSTALL'];
    }
  });

  it('run na pustym planie wykonuje fake preflight, zwraca czysty JSON i kod 10', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { tools?: unknown };
        const response = parsed.tools
          ? { content: [{ type: 'tool_use', id: 'tool-1', name: 'get_status', input: {} }] }
          : { content: [{ type: 'text', text: 'pong' }] };
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(response));
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fake endpoint did not bind');

    try {
      const repoDir = await initRepo();
      const workDir = await tmpDir('gp-cli-run-');
      const configFile = await writeFileIn(
        workDir,
        'greenproof.json',
        JSON.stringify(
          configObject({
            platformOptions: { repoDir, baseDir: workDir },
            paths: { testsRepoDir: repoDir },
            model: {
              baseUrl: `http://127.0.0.1:${address.port}`,
              authTokenEnv: 'FAKE_TOKEN',
              author: 'fake-author',
            },
          }),
        ),
      );
      const inputFile = await writeFileIn(
        workDir,
        'filter-input.json',
        JSON.stringify({
          slug: 'empty',
          envUrl: 'https://app.example.test',
          ref: 'main',
          runRef: 'empty-run',
          plan: { slug: 'empty', cases: [] },
        }),
      );

      const io = capture();
      const code = await run(['run', '--config', configFile, '--in', inputFile], {
        ...io.options,
        env: { GREENPROOF_PROGRESS: 'off' },
        isTTY: false,
      });
      expect(code).toBe(10);
      expect(io.out).toHaveLength(1);
      const output = JSON.parse(io.out.join('')) as {
        preflight: { ok: boolean };
        filter: { selected: string[] };
        triage: unknown;
        preventiveFixture: unknown;
        initialAuthor: unknown;
        fixtureEscalations: unknown[];
        deliver: unknown;
        status: { runId: string };
      };
      expect(output.preflight.ok).toBe(true);
      expect(output.filter.selected).toEqual([]);
      expect(output.triage).toBeNull();
      expect(output.preventiveFixture).toBeNull();
      expect(output.initialAuthor).toBeNull();
      expect(output.fixtureEscalations).toEqual([]);
      expect(output.deliver).toBeNull();
      expect(output.status.runId).toBeTruthy();
      expect(() => JSON.parse(io.out.join(''))).not.toThrow();
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('niepoprawny JSON wejścia → 2 bez śmieci na stdout', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-work-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.json',
      JSON.stringify(
        configObject({
          platformOptions: { repoDir, baseDir: workDir },
          paths: { testsRepoDir: repoDir },
        }),
      ),
    );
    const inFile = await writeFileIn(workDir, 'zle.json', '{ to nie jest json');

    const io = capture();
    expect(await run(['step', 'triage', '--config', configFile, '--in', inFile], io.options)).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err.join('')).toMatch(/Niepoprawny JSON/);
  });
});
