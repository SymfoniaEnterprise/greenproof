#!/usr/bin/env node
/**
 * Golden path: pełna pętla greenproof (filter → triage → author → deliver →
 * accept → release) na adapter-fs przeciw appce DemoPay (~/dev/demopay-demo).
 *
 * Użycie: node scripts/golden-path.mjs --model deepseek|qwen|opus|gemini|luna [--cases 1|2]
 * Workdir jest trwały: ~/.local/share/greenproof/runs/<runId> (backlog §1).
 *  - deepseek: przez bramę LiteLLM (env LITELLM_KEY albo GREENPROOF_GATEWAY_KEY)
 *  - opus: poświadczenia Claude z HOME (subskrypcja), model claude-opus-latest
 *  - gemini: gemini-3.6-flash z darmowego progu AI Studio przez bramę LiteLLM
 *  - luna: gpt-5.6-luna przez lokalny CLIProxyAPI (subskrypcja OAuth, bez LiteLLM)
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Aliasy modeli w bramie LiteLLM są INSTALACYJNE - u każdego nazywają się
 * inaczej, więc nazwy naszych wpisów nie mają czego robić w skrypcie. Ustaw
 * raz w środowisku (np. w ~/.bashrc), nazwy podejrzysz przez `gp models`:
 *   GP_FIXTURE_MODEL - model eskalacji fixture przez bramę
 *   GP_GLM_MODEL     - wpis GLM 5.2 przez bramę
 */
const FIXTURE_MODEL = process.env.GP_FIXTURE_MODEL ?? '<model-eskalacji-z-bramy>';
const GLM_MODEL = process.env.GP_GLM_MODEL ?? '<model-glm-z-bramy>';
/** Na Windows npm to skrypt .cmd, a Node od łatki CVE-2024-27980 odmawia
 *  spawnu .cmd bez powłoki (EINVAL) - dlatego uruchamiamy go przez cmd.exe.
 *  Poza Windowsem bez zmian. Argumenty są stałe, więc cytowanie zostawiamy Node. */
const npmArgv = (...args) =>
  process.platform === 'win32'
    ? [process.env.COMSPEC ?? 'cmd.exe', ['/d', '/c', 'npm', ...args]]
    : ['npm', args];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Łatwa appka DemoPay żyje POZA repo (przeniesiona z examples/) - env nadpisuje.
// Appka w repo (examples/apps); env nadpisuje, gdy mierzysz własną kopię.
const APP_DIR = process.env.GP_DEMOPAY_APP_DIR ?? join(ROOT, 'examples/apps/demopay');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MODEL_ARG = flag('model', 'deepseek');
if (args.includes('--keep')) console.error('[golden-path] --keep jest zbędne - workdir jest teraz trwały domyślnie');
const CASES = Number(flag('cases', '2'));

/** Katalog danych aplikacji: %LOCALAPPDATA% na Windowsie, XDG (POSIX) poza nim. */
const dataHomeDir = () =>
  process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
/** Trwała lokalizacja workdirów runów (backlog §1) - reboot ich nie kasuje. */
const RUNS_DIR = join(dataHomeDir(), 'greenproof/runs');
/** runId z timestampem - trwałe workdiry nie mogą się zderzać między runami. */
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + Math.random().toString(36).slice(2, 6);

// priceTable: przybliżone ceny do telemetrii porównawczej (i własnego capu).
const MODELS = {
  deepseek: {
    author: 'deepseek-v4-flash', baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'metered',
    priceTable: { 'deepseek-v4-flash': { inPerMTok: 0.075, outPerMTok: 0.3, cacheReadPerMTok: 0.0075 } },
  },
  // Lokalny Qwen3.8-27B przez Lemonade (ctx 64k, tool-calling) - koszt $0.
  // Lokalny 27B robi ~2 tury/min: cap czasu podniesiony (koszt = tylko czas GPU).
  qwen: {
    author: 'qwen3.8', baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'local',
    priceTable: {
      'qwen3.8': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      [FIXTURE_MODEL]: { inPerMTok: 0.3, outPerMTok: 1.0, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
    },
    // Lokalny 27B: pierwsza tura to prefill ~50k tok + thinking przy ~14 tok/s
    // ≈ 10 min - domyślny watchdog 5 min fałszywie klasyfikował żywą sesję
    // jako 'infra'. 15 min tylko dla lokalnych; chmurowe zostają na 5.
    caps: { maxTimeMinutes: 90, firstTurnTimeoutMinutes: 15 },
    // llama.cpp: prompt + max_tokens ≤ ctx (64k) - mniejsza rezerwa wyjścia
    // zostawia ~57k na prompt zamiast ~33k.
    maxOutputTokens: 8192,
    fixtureAuthor: { model: FIXTURE_MODEL, baseUrl: 'http://127.0.0.1:4000', authTokenEnv: 'LITELLM_KEY' },
  },
  // Qwen3.6-27B gęsty Q5 z MTP (spekulatywne dekodowanie) przez Lemonade -
  // powtórka runu `qwen` z podmienionym autorem, ten sam fallback fixture-author.
  // Kontekst: rejestr Lemonade dawał 32k (za mało - prompty runu sięgały 53k),
  // podniesiony do 131072 przez POST /api/v1/load {ctx_size}; zweryfikować
  // cmdline llama-server (--ctx-size) przed startem. MTP daje ~44 t/s vs 14 t/s
  // qwen3.8, więc tura nie rozciąga się do 10 min jak w poprzednim runie.
  qwen36: {
    author: 'qwen36-27b-mtp', baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'local',
    priceTable: {
      'qwen36-27b-mtp': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      [FIXTURE_MODEL]: { inPerMTok: 0.3, outPerMTok: 1.0, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
    },
    caps: { maxTimeMinutes: 90, firstTurnTimeoutMinutes: 15 },
    maxOutputTokens: 8192,
    fixtureAuthor: { model: FIXTURE_MODEL, baseUrl: 'http://127.0.0.1:4000', authTokenEnv: 'LITELLM_KEY' },
  },
  // Ornith 1.0 35B MoE Q4 (ornith-ai) - coder agentowy, SWE-bench Verified 75,6.
  // Wybrany po runach qwen3.8/qwen3.6: wąskim gardłem nie było tempo, tylko
  // jakość asercji (dowód mutacyjny odrzucał specy „na zielono"). Szablon
  // froggeric w rejestrze Lemonade - oficjalny wywala tool calling.
  // Kontekst podniesiony z 32k do 131072 (POST /api/v1/load {ctx_size}).
  ornith: {
    author: 'ornith-35b', baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'local',
    priceTable: {
      'ornith-35b': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      [FIXTURE_MODEL]: { inPerMTok: 0.3, outPerMTok: 1.0, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
    },
    caps: { maxTimeMinutes: 90, firstTurnTimeoutMinutes: 15 },
    maxOutputTokens: 8192,
    fixtureAuthor: { model: FIXTURE_MODEL, baseUrl: 'http://127.0.0.1:4000', authTokenEnv: 'LITELLM_KEY' },
  },
  // Laguna XS 2.1 33B-A3B Q4_K_M - najszybszy lokalny coder (92 t/s zmierzone),
  // MoE ~3B aktywnych. Rozumowanie włączone jawnie w recipe_options Lemonade
  // (szablon modelu domyślnie je gasi). Cel wszystkich fallbacków bramy przed
  // przepięciem ich na deepseeka, więc tool calling ma sprawdzony w boju.
  laguna: {
    author: 'laguna-xs-21', baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'local',
    priceTable: {
      'laguna-xs-21': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      [FIXTURE_MODEL]: { inPerMTok: 0.3, outPerMTok: 1.0, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
    },
    caps: { maxTimeMinutes: 90, firstTurnTimeoutMinutes: 15 },
    maxOutputTokens: 8192,
    fixtureAuthor: { model: FIXTURE_MODEL, baseUrl: 'http://127.0.0.1:4000', authTokenEnv: 'LITELLM_KEY' },
  },
  // Qwen3.6-35B-A3B MoE Q8 - najszybszy z rodziny 3.6 (42 t/s zmierzone).
  // UWAGA: wpis w bramie ma JAWNIE wyłączone myślenie (enable_thinking:false
  // + profil samplingu non-thinking), a wąskim gardłem lokalnych autorów jest
  // właśnie jakość asercji - wynik czytać z tą świadomością.
  // Kontekst do podniesienia z 32k przed startem (POST /api/v1/load).
  qwen36a3b: {
    author: 'qwen36-35b-a3b', baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'local',
    priceTable: {
      'qwen36-35b-a3b': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      [FIXTURE_MODEL]: { inPerMTok: 0.3, outPerMTok: 1.0, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
    },
    caps: { maxTimeMinutes: 90, firstTurnTimeoutMinutes: 15 },
    maxOutputTokens: 8192,
    fixtureAuthor: { model: FIXTURE_MODEL, baseUrl: 'http://127.0.0.1:4000', authTokenEnv: 'LITELLM_KEY' },
  },
  // Meta Muse Glimmer 30B (K-Quant) - agentowy, tool calling + wizja.
  // UWAGA: wpis `glimmer` w bramie wskazywał na nieistniejącą wariację
  // (…KQuant-17GB-Q4_K_M) - w rejestrze Lemonade jest …KQuant-Dynamic-Q4_K_XL.
  // Bez naprawy nazwy żądanie leci w fallback (cicha podmiana modelu).
  glimmer: {
    author: 'glimmer', baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'local',
    priceTable: {
      glimmer: { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      [FIXTURE_MODEL]: { inPerMTok: 0.3, outPerMTok: 1.0, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
    },
    caps: { maxTimeMinutes: 90, firstTurnTimeoutMinutes: 15 },
    maxOutputTokens: 8192,
    fixtureAuthor: { model: FIXTURE_MODEL, baseUrl: 'http://127.0.0.1:4000', authTokenEnv: 'LITELLM_KEY' },
  },
  // GLM 5.2 przez kanał abonamentowy - realnie $0, ale limit zużycia
  // istnieje, stąd costModel: subscription (odbojnik kosztowy SDK zostaje).
  // UWAGA przy runach równoległych: brama ma kaskadę
  // GLM z bramy → glm-5.2 (OpenRouter) → qwen36-35b-a3b (LOKALNY), więc dwa
  // poziomy błędu dzielą ten run od eksmisji modelu lokalnego z GPU.
  glm: {
    author: GLM_MODEL, baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'subscription',
    priceTable: {
      [GLM_MODEL]: { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      [FIXTURE_MODEL]: { inPerMTok: 0.3, outPerMTok: 1.0, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
    },
    fixtureAuthor: { model: FIXTURE_MODEL, baseUrl: 'http://127.0.0.1:4000', authTokenEnv: 'LITELLM_KEY' },
  },
  // Gemini 3.7 Flash przez OpenRouter (brama LiteLLM), ceny wg OpenRouter 2026-08.
  gemini37: {
    author: 'gemini-3.7-openrouter', baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'metered',
    priceTable: {
      'gemini-3.7-openrouter': { inPerMTok: 0.375, outPerMTok: 1.875, cacheReadPerMTok: 0.0375 },
      [FIXTURE_MODEL]: { inPerMTok: 0.3, outPerMTok: 1.0, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
    },
    fixtureAuthor: { model: FIXTURE_MODEL, baseUrl: 'http://127.0.0.1:4000', authTokenEnv: 'LITELLM_KEY' },
  },
  // Gemini 3.6 Flash na darmowym progu AI Studio (8 RPM) - cap czasu podniesiony do 90 min.
  gemini: {
    author: 'gemini-3.6-flash', baseUrl: 'http://127.0.0.1:4000', tokenEnv: 'LITELLM_KEY', costModel: 'metered',
    priceTable: { 'gemini-3.6-flash': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 } },
    caps: { maxTimeMinutes: 90 },
  },
  luna: {
    author: 'gpt-5.6-luna', baseUrl: 'http://127.0.0.1:8317', tokenEnv: 'CLIPROXY_TOKEN', costModel: 'subscription',
    priceTable: { 'gpt-5.6-luna': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 } },
  },
  opus: { author: 'claude-opus-5', costModel: 'subscription' },
  // Sonnet 5 tą samą drogą co Opus: poświadczenia Claude z HOME, bez bramy.
  sonnet: { author: 'claude-sonnet-5', costModel: 'subscription' },
};
const MODEL = MODELS[MODEL_ARG];
if (!MODEL) {
  console.error(`Nieznany model: ${MODEL_ARG} (dozwolone: ${Object.keys(MODELS).join(', ')})`);
  process.exit(2);
}
if (MODEL.tokenEnv && !process.env[MODEL.tokenEnv] && process.env.GREENPROOF_GATEWAY_KEY) {
  process.env[MODEL.tokenEnv] = process.env.GREENPROOF_GATEWAY_KEY;
}
if (MODEL.tokenEnv && !process.env[MODEL.tokenEnv]) {
  console.error(`Brak ${MODEL.tokenEnv} w env - ustaw klucz wirtualny bramy LiteLLM.`);
  process.exit(2);
}

const log = (msg) => console.error(`[golden-path] ${msg}`);

async function git(cwd, ...a) {
  return (await execFileP('git', a, { cwd, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();
}

async function setupTestsRepo(work, baseURL) {
  const repo = join(work, 'tests-repo');
  await mkdir(join(repo, 'tests/e2e'), { recursive: true });
  await mkdir(join(repo, 'tests/support/pom'), { recursive: true });
  await mkdir(join(repo, 'tests/support/fixtures'), { recursive: true });
  await mkdir(join(repo, 'knowledge/proposals'), { recursive: true });
  await mkdir(join(repo, 'docs/golden-cases'), { recursive: true });

  await writeFile(join(repo, 'package.json'), JSON.stringify({
    name: 'golden-tests-repo', private: true, type: 'module',
    devDependencies: { '@playwright/test': '^1.55.0' },
  }, null, 2));
  await writeFile(join(repo, 'playwright.config.ts'), [
    "import { defineConfig } from '@playwright/test';",
    'export default defineConfig({',
    "  testDir: 'tests/e2e',",
    '  timeout: 45_000,',
    '  retries: 0,',
    "  reporter: [['json', { outputFile: 'pw-report.json' }], ['line']],",
    `  use: { baseURL: '${baseURL}', headless: true },`,
    '});',
  ].join('\n'));
  await writeFile(join(repo, 'tests/support/pom-index.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  await writeFile(join(repo, 'knowledge/ui-traps.yaml'), 'version: 1\ntraps: []\n');
  await writeFile(join(repo, 'knowledge/app-map.yaml'), [
    'version: 1',
    'views:',
    '  - route: auth/login',
    '    description: Logowanie',
    '    navigationSteps: ["goto /login", "wpisz demo/demo123", "kliknij login-submit"]',
    '    keySelectors:',
    "      username: getByTestId('login-username')",
    "      password: getByTestId('login-password')",
    "      submit: getByTestId('login-submit')",
    '  - route: payroll',
    '    description: Lista płac (churn-prone - tworzenie bywa wolne i zwraca 503 przy pierwszej próbie; seeduj przez POST /api/test/seed, omija opóźnienie)',
    '    navigationSteps: ["zaloguj się", "goto /payroll", "wybierz miesiąc payroll-month", "kliknij payroll-create"]',
    '    keySelectors:',
    "      month: getByTestId('payroll-month')",
    "      create: getByTestId('payroll-create')",
    "      net: getByTestId('payroll-net')",
  ].join('\n'));
  try {
    await cp(join(APP_DIR, 'docs/golden-cases'), join(repo, 'docs/golden-cases'), { recursive: true });
    // README aplikacji do repo testów - port SCM czyta go dla promptu fixture-authora.
    await mkdir(join(repo, 'docs/app'), { recursive: true });
    await cp(join(APP_DIR, 'README.md'), join(repo, 'docs/app/README.md'));
  } catch {
    log('UWAGA: brak docs/golden-cases w demo-app - oracle będzie pusty');
  }
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'greenproof');
  await git(repo, 'config', 'user.email', 'greenproof@localhost');

  log('instaluję @playwright/test w repo testów…');
  await execFileP(...npmArgv('install', '--no-fund', '--no-audit'), { cwd: repo });
  await writeFile(join(repo, '.gitignore'), 'node_modules/\npw-report.json\ntest-results/\n.greenproof-runs/\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'init tests repo');
  return repo;
}

async function writeConfig(work, repo) {
  const configPath = join(work, 'greenproof.config.mjs');
  await writeFile(configPath, `export default ${JSON.stringify({
    platform: '@greenproof/adapter-fs',
    platformOptions: { repoDir: repo, baseDir: join(work, 'platform') },
    plan: { source: 'json' },
    model: {
      authTokenEnv: MODEL.tokenEnv ?? 'UNUSED_TOKEN',
      author: MODEL.author,
      ...(MODEL.baseUrl ? { baseUrl: MODEL.baseUrl } : {}),
      ...(MODEL.priceTable ? { priceTable: MODEL.priceTable } : {}),
      ...(MODEL.costModel ? { costModel: MODEL.costModel } : {}),
      ...(MODEL.maxOutputTokens ? { maxOutputTokens: MODEL.maxOutputTokens } : {}),
      // Eskalacja fixture-gap: model fallbackowy uzupełnia lukę,
      // autor wraca do case'a z gotowym fixture.
      fixtureAuthor: MODEL.fixtureAuthor ?? { model: 'claude-opus-5' },
    },
    caps: {
      // maxAutoRetries=1: nieudana próba dostaje automatyczne ponowienie
      // z digestem wniosków - to też test mechanizmu retry-z-wnioskami.
      maxTimeMinutes: 25, maxCostUsd: 3, maxPlaywrightRuns: 12, proofRuns: 4, maxAutoRetries: 1,
      snapshotGating: 'enforce',
      seedFuse: { churnProneTypes: ['lista-plac'], learn: 'propose', maxFailedStrategies: 3, maxArrangeTurns: 40, learnedEntryTtlRuns: 10 },
      ...(MODEL.caps ?? {}),
    },
    paths: { testsRepoDir: repo },
    knowledge: { dir: 'knowledge' },
    oracle: { goldenCasesDir: 'docs/golden-cases' },
    appDocs: { paths: ['docs/app/README.md'] },
  }, null, 2)};\n`);
  return configPath;
}

function buildPlan() {
  return {
    slug: 'demo-golden',
    cases: [
      {
        caseId: 'E2E-LOGIN-001', title: 'Poprawne logowanie i odrzucenie złego hasła',
        level: 'e2e', priority: 'P0',
        requirements: ['Użytkownik demo/demo123 loguje się i widzi /employees; złe hasło pokazuje login-error'],
        flows: ['auth/login'],
      },
      {
        caseId: 'E2E-PAYROLL-002', title: 'Lista płac wylicza netto zgodnie z golden-case',
        level: 'e2e', priority: 'P1',
        requirements: ['Netto na liście płac dla pracownika z brutto 5000 zgadza się z docs/golden-cases/netto.yaml co do grosza'],
        flows: ['payroll'], type: 'lista-plac',
      },
    ].slice(0, CASES),
  };
}

async function runPipeline({ work, repo, baseURL, configPath }) {
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
    const code = await new Promise((res) => child.on('close', res));
    if (![...allowCodes].includes(code)) throw new Error(`greenproof ${cmd} exit ${code}`);
    try { return JSON.parse(await readFile(outPath, 'utf8')); } catch { return null; }
  };

  const plan = buildPlan();
  const t0 = Date.now();
  const filter = await cli('step filter', {
    runId: `gp-golden-${MODEL_ARG}-${stamp}`, slug: plan.slug, envUrl: baseURL,
    ref: 'main', runRef: 'golden-issue', plan,
  });
  log(`filter: selected=${JSON.stringify(filter.selected)}`);
  await cli('step triage', { runId: filter.runId });
  // Prewencyjne fixture'y per typ churn-prone PRZED partią (backlog 8.4).
  const prev = await cli('fixture', { runId: filter.runId, mode: 'preventive' }, [0, 3]);
  for (const t of prev?.types ?? []) {
    log(`preventive[${t.type}]: ${t.status}${t.fixture ? ` - ${t.fixture.name}` : ''}`);
  }
  const author = await cli('step author', { runId: filter.runId }, [0, 3]);
  await cli('step deliver', { runId: filter.runId }, [0]);

  for (const r of author.results) {
    log(`case ${r.caseId}: ${r.status} - $${r.costUsd.toFixed(2)}, ${r.turns} tur`);
    if (r.status === 'delivered' || r.status === 'in_review') {
      await cli('accept', { runId: filter.runId, caseId: r.caseId, targetBranch: 'main' });
    } else if (r.status === 'blocked' && r.blockedReason === 'fixture-gap') {
      // Samodzielna ścieżka wyjścia z fixture-gap: mocny model dostarcza fixture,
      // tani autor ponawia case z gotowym klockiem.
      log(`fixture-author dla ${r.caseId} (eskalacja do ${(MODEL.fixtureAuthor ?? { model: 'claude-opus-5' }).model})…`);
      const fx = await cli('fixture', { runId: filter.runId, caseId: r.caseId }, [0, 3]);
      if (fx?.ok) {
        log(`fixture "${fx.fixture.name}" zweryfikowany ($${fx.costUsd.toFixed(2)}, ${fx.turns} tur) - ponowna próba autorem`);
        // Fixture-author zostawił case w triaged z retryNotes - author podejmuje go wprost.
        const rr = await cli('step author', { runId: filter.runId, caseIds: [r.caseId] }, [0, 3]);
        await cli('step deliver', { runId: filter.runId }, [0]);
        const rres = rr?.results?.find((x) => x.caseId === r.caseId);
        log(`ponowna próba ${r.caseId}: ${rres?.status ?? '?'} - $${(rres?.costUsd ?? 0).toFixed(2)}`);
        if (rres?.status === 'delivered' || rres?.status === 'in_review') {
          await cli('accept', { runId: filter.runId, caseId: r.caseId, targetBranch: 'main' });
        }
      } else {
        log(`fixture-author nie dostarczył fixture: ${fx?.error ?? '?'}`);
      }
    }
  }
  const release = await cli('release', { runId: filter.runId }, [0, 5]);
  const status = await cli('status', { runId: filter.runId });

  console.log(JSON.stringify({
    model: MODEL_ARG,
    durationMin: ((Date.now() - t0) / 60000).toFixed(1),
    totals: status.totals,
    cases: Object.fromEntries(Object.entries(status.cases).map(([k, v]) => [k, { status: v.status, costUsd: v.costUsd, attempts: v.attempts, blockedReason: v.blockedReason }])),
    gates: release?.gates, pass: release?.pass,
    reportsDir: join(work, 'platform', 'reports'),
    workdir: work,
  }, null, 2));
}

async function waitFor(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch { /* jeszcze nie wstał */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`demo-app nie wstał pod ${url}`);
}

async function main() {
  const work = join(RUNS_DIR, `gp-golden-${MODEL_ARG}-${stamp}`);
  await mkdir(work, { recursive: true });
  log(`workdir: ${work}`);

  const port = 3131 + Math.floor(Math.random() * 500);
  const baseURL = `http://127.0.0.1:${port}`;
  const repo = await setupTestsRepo(work, baseURL);
  const configPath = await writeConfig(work, repo);

  // Demo-app bez dziedziczenia stdio - sierota nie może trzymać pipe'a rodzica.
  log(`startuję demo-app na :${port}…`);
  const app = spawn('node', [join(APP_DIR, 'src/server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(work, 'demo.db') },
    stdio: 'ignore',
  });
  try {
    await waitFor(baseURL, 15_000);
    await runPipeline({ work, repo, baseURL, configPath });
  } finally {
    app.kill();
  }

  log(`workdir zostaje (trwały): ${work} - sprzątanie: greenproof clean po release`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
