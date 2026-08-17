#!/usr/bin/env node
/**
 * Benchmark path: pełna pętla greenproof na TRUDNIEJSZEJ appce
 * (~/dev/hr-payroll-demo, plan examples/benchmark-plan.json, 10 case'ów)
 * z fallbackiem fixture-author (eskalacja per model).
 *
 * Użycie: node scripts/benchmark-path.mjs --model deepseek|luna|qwen38 [--keep]
 *  - deepseek: deepseek-v4-flash (brama LiteLLM) + fixture-author claude-opus-5 (subskrypcja)
 *  - luna:     gpt-5.6-luna (CLIProxyAPI)       + fixture-author gpt-5.6-sol (CLIProxyAPI)
 *  - qwen38:   qwen3.8 lokalnie (Lemonade→llama.cpp) + fixture-author z bramy (GP_FIXTURE_MODEL)
 */
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
/** Na Windows npm to skrypt .cmd, a Node od łatki CVE-2024-27980 odmawia
 *  spawnu .cmd bez powłoki (EINVAL) - dlatego uruchamiamy go przez cmd.exe.
 *  Poza Windowsem bez zmian. Argumenty są stałe, więc cytowanie zostawiamy Node. */
const npmArgv = (...args) =>
  process.platform === 'win32'
    ? [process.env.COMSPEC ?? 'cmd.exe', ['/d', '/c', 'npm', ...args]]
    : ['npm', args];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Alias modelu eskalacji w bramie LiteLLM jest INSTALACYJNY - u każdego wpis
 * nazywa się inaczej, więc skrypt nie zgaduje. Ustaw `GP_FIXTURE_MODEL`
 * (nazwy podejrzysz przez `gp models`); bez tego preflight przerwie run
 * komunikatem o niewypełnionym placeholderze.
 */
const FIXTURE_MODEL = process.env.GP_FIXTURE_MODEL ?? '<model-eskalacji-z-bramy>';
// Trudna appka HR-Payroll żyje POZA repo (przeniesiona z examples/) - env nadpisuje.
// Appka w repo (examples/apps); env nadpisuje, gdy mierzysz własną kopię.
const APP_DIR = process.env.GP_HR_APP_DIR ?? join(ROOT, 'examples/apps/hr-payroll');

const args = process.argv.slice(2);
const flag = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const MODEL_ARG = flag('model', 'deepseek');
if (args.includes('--keep')) console.error('[benchmark-path] --keep jest zbędne - workdir jest teraz trwały domyślnie');

/** Katalog danych aplikacji: %LOCALAPPDATA% na Windowsie, XDG (POSIX) poza nim. */
const dataHomeDir = () =>
  process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
/** Trwała lokalizacja workdirów runów (backlog §1) - reboot ich nie kasuje. */
const RUNS_DIR = join(dataHomeDir(), 'greenproof/runs');
/** runId z timestampem - trwałe workdiry nie mogą się zderzać między runami. */
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + Math.random().toString(36).slice(2, 6);

const MODELS = {
  deepseek: {
    // Run 2: DeepSeek V4 Flash przez kanał abonamentowy; wpis bramy z
    // wymuszonym reasoning_effort: max i fallbackiem na OpenRouterowego flasha.
    // priceTable = STAWKI OpenRoutera jako estymata: subskrypcja kosztuje $0,
    // ale capy kosztowe muszą gryźć, a koszty w raporcie być porównywalne z run 1.
    author: FIXTURE_MODEL, baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY',
    priceTable: { [FIXTURE_MODEL]: { inPerMTok: 0.075, outPerMTok: 0.3, cacheReadPerMTok: 0.0075 } },
    fixtureAuthor: { model: 'claude-opus-5' },
  },
  luna: {
    // costModel: subskrypcja - kwoty nie płacimy per token, ale limit
    // zużycia istnieje, więc odbojnik kosztowy SDK zostaje (inaczej niż przy
    // modelach lokalnych, gdzie fantomowa wycena SDK ubijała darmowe runy).
    author: 'gpt-5.6-luna(max)', baseUrl: 'http://127.0.0.1:8317', tokenEnv: 'CLIPROXY_TOKEN', costModel: 'subscription',
    priceTable: { 'gpt-5.6-luna': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 }, 'gpt-5.6-sol': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 } },
    // Sufiks (high) w nazwie = reasoning effort tłumaczony przez CLIProxyAPI.
    fixtureAuthor: { model: 'gpt-5.6-sol(high)', baseUrl: 'http://127.0.0.1:8317', authTokenEnv: 'CLIPROXY_TOKEN' },
  },
  qwen38: {
    // Lokalny Qwen3.8-27B przez Lemonade (llama.cpp) za bramą. costModel: local,
    // bo płacimy czasem GPU, nie kwotą - inaczej fantomowa wycena SDK ubija run.
    // qwen3.8 robi ~3 tury/min, a pierwsza tura to prefill ~50k tokenów, więc
    // domyślne capy chmurowe (30 min / brak firstTurnTimeout / brak maxOutputTokens)
    // są nierealne - stąd capsOverride i maxOutputTokens niżej.
    author: 'qwen3.8', baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'local',
    // llama.cpp: prompt + max_tokens ≤ ctx - 8192 rezerwy zostawia ~123k na prompt.
    maxOutputTokens: 8192,
    priceTable: {
      'qwen3.8': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      // Abonament = realnie $0; stawki OpenRoutera jako estymata,
      // żeby capy kosztowe gryzły i raport był porównywalny (ta sama konwencja
      // co w profilu deepseek).
      [FIXTURE_MODEL]: { inPerMTok: 0.075, outPerMTok: 0.3, cacheReadPerMTok: 0.0075 },
    },
    // Eskalacja fixture dziedziczy endpoint i token autora - bez baseUrl/authTokenEnv.
    fixtureAuthor: { model: FIXTURE_MODEL },
    capsOverride: { maxTimeMinutes: 90, firstTurnTimeoutMinutes: 15 },
    // Preload modelu: rejestr Lemonade trzyma dla tego modelu mniejszy kontekst
    // niż potrzebny (prompty planu sięgają 50k+), więc przed runem podbijamy go
    // przez POST /api/v1/load - bez tego run jest skazany.
    lemonade: { model_name: 'Qwen3.8-27B-GGUF-UD-Q4_K_XL', ctx_size: 131072 },
  },
};
const MODEL = MODELS[MODEL_ARG];
if (!MODEL) { console.error(`Nieznany model: ${MODEL_ARG} (dozwolone: ${Object.keys(MODELS).join(', ')})`); process.exit(2); }
if (!process.env[MODEL.tokenEnv]) { console.error(`Brak ${MODEL.tokenEnv} w env`); process.exit(2); }

const log = (m) => console.error(`[benchmark-path] ${m}`);
const git = async (cwd, ...a) =>
  (await execFileP('git', a, { cwd, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();

async function setupTestsRepo(work, baseURL) {
  const repo = join(work, 'tests-repo');
  for (const d of ['tests/e2e', 'tests/support/pom', 'tests/support/fixtures', 'knowledge/proposals']) {
    await mkdir(join(repo, d), { recursive: true });
  }
  await writeFile(join(repo, 'package.json'), JSON.stringify({
    name: 'benchmark-tests-repo', private: true, type: 'module',
    devDependencies: { '@playwright/test': '^1.55.0' },
  }, null, 2));
  await writeFile(join(repo, 'playwright.config.ts'), [
    "import { defineConfig } from '@playwright/test';",
    'export default defineConfig({',
    "  testDir: 'tests/e2e',",
    '  timeout: 60_000,',
    '  retries: 0,',
    "  reporter: [['json', { outputFile: 'pw-report.json' }], ['line']],",
    `  use: { baseURL: '${baseURL}', headless: true },`,
    '});',
  ].join('\n'));
  await writeFile(join(repo, 'tests/support/pom-index.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  await writeFile(join(repo, 'knowledge/ui-traps.yaml'), 'version: 1\ntraps: []\n');
  // README aplikacji do repo testów - czytany przez port SCM (config appDocs)
  // i wstrzykiwany do promptu fixture-authora.
  await mkdir(join(repo, 'docs/app'), { recursive: true });
  await cp(join(APP_DIR, 'README.md'), join(repo, 'docs/app/README.md'));
  // Minimalna mapa aplikacji z README benchmarku - konta, seed API, główne widoki.
  await writeFile(join(repo, 'knowledge/app-map.yaml'), [
    'version: 1',
    'views:',
    '  - route: login',
    '    description: "Logowanie; konta demo: admin/admin123, accountant/account123, employee/employee123 (role!)"',
    '    navigationSteps: ["goto /login", "wypełnij formularz", "submit"]',
    '    keySelectors: {}',
    '  - route: employees',
    '    description: "Pracownicy: paginacja serwerowa, sortowanie, walidacja PESEL Z CYFRĄ KONTROLNĄ, optimistic locking (pole version)"',
    '    navigationSteps: ["zaloguj jako admin", "goto /employees"]',
    '    keySelectors: {}',
    '  - route: payroll',
    '    description: "Listy płac (churn-prone): workflow statusów draft→approved→paid; seeduj przez POST /api/test/reset + POST /api/test/seed (akceptuje department_name/employee_pesel zamiast ID) - omija churn"',
    '    navigationSteps: ["zaloguj jako accountant", "goto /payroll"]',
    '    keySelectors: {}',
    '  - route: leaves',
    '    description: "Urlopy: nakładanie zakresów odrzucane; review przez admina"',
    '    navigationSteps: ["zaloguj", "goto /leaves"]',
    '    keySelectors: {}',
  ].join('\n'));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'greenproof');
  await git(repo, 'config', 'user.email', 'greenproof@localhost');
  log('instaluję @playwright/test…');
  await execFileP(...npmArgv('install', '--no-fund', '--no-audit'), { cwd: repo });
  await writeFile(join(repo, '.gitignore'), 'node_modules/\npw-report.json\ntest-results/\n.greenproof-runs/\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'init benchmark tests repo');
  return repo;
}

async function writeConfig(work, repo) {
  const configPath = join(work, 'greenproof.config.mjs');
  await writeFile(configPath, `export default ${JSON.stringify({
    platform: '@greenproof/adapter-fs',
    platformOptions: { repoDir: repo, baseDir: join(work, 'platform') },
    plan: { source: 'json' },
    model: {
      authTokenEnv: MODEL.tokenEnv,
      author: MODEL.author,
      baseUrl: MODEL.baseUrl,
      priceTable: MODEL.priceTable,
      ...(MODEL.costModel ? { costModel: MODEL.costModel } : {}),
      ...(MODEL.maxOutputTokens ? { maxOutputTokens: MODEL.maxOutputTokens } : {}),
      fixtureAuthor: MODEL.fixtureAuthor,
    },
    caps: {
      maxTurns: 400, maxTimeMinutes: 30, maxCostUsd: 8, maxPlaywrightRuns: 12, proofRuns: 4, maxAutoRetries: 1,
      snapshotGating: 'enforce',
      seedFuse: { churnProneTypes: ['payroll'], learn: 'propose', maxFailedStrategies: 3, maxArrangeTurns: 40, learnedEntryTtlRuns: 10 },
      fixtureSession: { maxTurns: 80, maxTimeMinutes: 30 },
      ...(MODEL.capsOverride ?? {}),
    },
    paths: { testsRepoDir: repo },
    knowledge: { dir: 'knowledge' },
    appDocs: { paths: ['docs/app/README.md'] },
  }, null, 2)};\n`);
  return configPath;
}

async function runPipeline({ work, repo, configPath, plan, runId }) {
  const cli = async (cmd, input, allowCodes = [0]) => {
    const words = cmd.split(' ');
    const name = words.join('-');
    const inPath = join(work, `${name}-in.json`);
    const outPath = join(work, `${name}-out.json`);
    await writeFile(inPath, JSON.stringify(input));
    log(`greenproof ${cmd}…`);
    const child = spawn('node', [join(ROOT, 'packages/cli/dist/main.js'), ...words,
      '--config', configPath, '--in', inPath, '--out', outPath], {
      cwd: repo, stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
    });
    const code = await new Promise((r) => child.on('close', r));
    if (![...allowCodes].includes(code)) throw new Error(`greenproof ${cmd} exit ${code}`);
    try { return JSON.parse(await readFile(outPath, 'utf8')); } catch { return null; }
  };

  const t0 = Date.now();
  const filter = await cli('step filter', {
    runId, slug: plan.slug, envUrl: plan.envUrl, ref: 'main', runRef: 'bench-issue', plan: plan.plan,
  });
  log(`filter: ${filter.selected.length} case'ów`);
  await cli('step triage', { runId });
  // Prewencyjne fixture'y per typ churn-prone PRZED partią (backlog 8.4);
  // exit 3 (część typów bez fixture) nie zatrzymuje partii - bezpiecznik
  // seedu i eskalacja per case dalej działają jak dotąd.
  const prev = await cli('fixture', { runId, mode: 'preventive' }, [0, 3]);
  for (const t of prev?.types ?? []) {
    log(`preventive[${t.type}]: ${t.status}${t.fixture ? ` - ${t.fixture.name}` : ''}${t.note ? ` (${t.note})` : ''}${t.error ? ` (${t.error})` : ''}`);
  }
  const author = await cli('step author', { runId }, [0, 3]);
  await cli('step deliver', { runId }, [0]);

  for (const r of author.results) {
    log(`case ${r.caseId}: ${r.status} - $${r.costUsd.toFixed(2)}, ${r.turns} tur`);
    if (r.status === 'delivered' || r.status === 'in_review') {
      await cli('accept', { runId, caseId: r.caseId, targetBranch: 'main' });
    } else if (r.status === 'blocked' && r.blockedReason === 'fixture-gap') {
      log(`fixture-author dla ${r.caseId} (eskalacja: ${MODEL.fixtureAuthor.model})…`);
      const fx = await cli('fixture', { runId, caseId: r.caseId }, [0, 3]);
      if (fx?.ok) {
        log(`fixture "${fx.fixture.name}" zweryfikowany ($${fx.costUsd.toFixed(2)}, ${fx.turns} tur)`);
        const rr = await cli('step author', { runId, caseIds: [r.caseId] }, [0, 3]);
        await cli('step deliver', { runId }, [0]);
        const rres = rr?.results?.find((x) => x.caseId === r.caseId);
        log(`ponowna próba ${r.caseId}: ${rres?.status ?? '?'}`);
        if (rres?.status === 'delivered' || rres?.status === 'in_review') {
          await cli('accept', { runId, caseId: r.caseId, targetBranch: 'main' });
        }
      } else {
        log(`fixture-author bez fixture: ${fx?.error ?? '?'}`);
      }
    }
  }
  const release = await cli('release', { runId }, [0, 5]);
  const status = await cli('status', { runId });
  console.log(JSON.stringify({
    model: MODEL_ARG, durationMin: ((Date.now() - t0) / 60000).toFixed(1),
    totals: status.totals,
    cases: Object.fromEntries(Object.entries(status.cases).map(([k, v]) => [k, { status: v.status, costUsd: v.costUsd, attempts: v.attempts, blockedReason: v.blockedReason }])),
    pass: release?.pass, workdir: work,
  }, null, 2));
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url, { redirect: 'manual' }); if (r.status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`app nie wstała: ${url}`);
}

// Preload modelu lokalnego przez Lemonade: rejestr trzyma dla niego mniejszy
// kontekst niż potrzebny, więc bez jawnego /api/v1/load z pełnym ctx_size run
// jest skazany (prompty nie mieszczą się w oknie). Ładowanie modelu trwa, stąd
// hojny timeout 120 s. Przy błędzie/niedostępnym Lemonade przerywamy - dalej nie ma sensu.
async function preloadLemonade() {
  if (!MODEL.lemonade) return;
  const { model_name, ctx_size } = MODEL.lemonade;
  const url = 'http://127.0.0.1:13305/api/v1/load';
  log(`preload Lemonade: ${model_name} (ctx_size=${ctx_size})…`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name, ctx_size }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    console.error(`[benchmark-path] Lemonade nieosiągalny pod ${url} (${e.name === 'AbortError' ? 'timeout 120 s' : e.message}) - bez preloadu modelu run jest skazany, przerywam.`);
    process.exit(2);
  }
  clearTimeout(timer);
  if (!res.ok) {
    console.error(`[benchmark-path] Lemonade odmówił preloadu (HTTP ${res.status}) - bez pełnego kontekstu run jest skazany, przerywam.`);
    process.exit(2);
  }
  log(`model załadowany w ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

async function main() {
  await preloadLemonade();
  const runId = `gp-bench-${MODEL_ARG}-${stamp}`;
  const work = join(RUNS_DIR, runId);
  await mkdir(work, { recursive: true });
  log(`workdir: ${work}`);
  const port = 3700 + Math.floor(Math.random() * 200);
  const baseURL = `http://127.0.0.1:${port}`;
  const repo = await setupTestsRepo(work, baseURL);
  const configPath = await writeConfig(work, repo);
  const planJson = JSON.parse(await readFile(join(ROOT, 'examples/benchmark-plan.json'), 'utf8'));

  log(`startuję appkę HR-Payroll na :${port}…`);
  const app = spawn('node', [join(APP_DIR, 'src/server.js')], {
    env: { ...process.env, DEMO_PORT: String(port), DEMO_DB_PATH: join(work, 'demo.db') },
    stdio: 'ignore',
  });
  try {
    await waitFor(`${baseURL}/login`, 15_000);
    await runPipeline({ work, repo, configPath, runId, plan: { slug: planJson.slug, plan: planJson, envUrl: baseURL } });
  } finally {
    app.kill();
  }
  log(`workdir zostaje (trwały): ${work} - sprzątanie: greenproof clean po release`);
}

main().catch((e) => { console.error(e); process.exit(1); });
