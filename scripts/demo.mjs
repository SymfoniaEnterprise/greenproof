#!/usr/bin/env node
/**
 * JEDNA komenda dla osoby nietechnicznej: pełny przebieg greenproof na
 * trudnej appce demo (~/dev/hr-payroll-demo).
 *
 *   pnpm demo                  # autor: sonnet 5 przez bramę LiteLLM
 *   pnpm demo --model deepseek # autor: deepseek flash przez bramę LiteLLM
 *   pnpm demo --dry-run        # tylko przygotowanie + preflight, bez sesji modeli
 *
 * Skrypt sam: znajduje token providera w lokalnej konfiguracji, stawia appkę
 * demo na wolnym porcie, przygotowuje świeże repo testów (playwright), generuje
 * config przez `greenproof run --init-only` i odpala `greenproof run` z żywą tablicą
 * postępu. Wyniki i workdir wypisuje na końcu. `accept`/`release` pozostają
 * świadomą decyzją człowieka (komendy wypisane w podsumowaniu).
 *
 * To warstwa harnessu (zna TĘ maszynę: ścieżki tokenów i bramę LiteLLM) -
 * biblioteka i CLI pozostają agnostyczne.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
/** Na Windows npm to skrypt .cmd, a Node od łatki CVE-2024-27980 odmawia
 *  spawnu .cmd bez powłoki (EINVAL) - dlatego uruchamiamy go przez cmd.exe.
 *  Poza Windowsem bez zmian. Argumenty są stałe, więc cytowanie zostawiamy Node. */
const npmArgv = (...args) =>
  process.platform === 'win32'
    ? [process.env.COMSPEC ?? 'cmd.exe', ['/d', '/c', 'npm', ...args]]
    : ['npm', args];
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Trudna appka HR-Payroll żyje POZA repo (przeniesiona z examples/) - env nadpisuje.
// Appka jest w repo (examples/apps) - demo działa u każdego, nie tylko tam,
// gdzie ktoś ma ją w ~/dev. Env nadal wygrywa, gdy testujesz własną kopię.
const APP_DIR = process.env.GP_HR_APP_DIR ?? join(ROOT, 'examples/apps/hr-payroll');
const CLI = join(ROOT, 'packages/cli/dist/main.js');
/** Katalog danych aplikacji: %LOCALAPPDATA% na Windowsie, XDG (POSIX) poza nim. */
const dataHomeDir = () =>
  process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
const RUNS_DIR = join(dataHomeDir(), 'greenproof/demo');

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};
const MODEL = flagValue('--model') ?? 'sonnet';
/** Dowolny inny model w bramie (nadpisuje wybór --model). */
const AUTHOR = flagValue('--author');
const DRY_RUN = argv.includes('--dry-run');

const log = (msg) => console.log(`[demo] ${msg}`);
const fail = (msg) => { console.error(`[demo] BŁĄD: ${msg}`); process.exit(2); };

/** Nazwa modelu w bramie LiteLLM (http://127.0.0.1:4000). */
const MODEL_BY_NAME = {
  sonnet: 'claude-sonnet-5',
  deepseek: 'deepseek-v4-flash',
};

/** Preset + odkrycie tokenu w lokalnej konfiguracji tej maszyny. */
async function providerFor(model) {
  const author = MODEL_BY_NAME[model];
  if (!author) fail(`nieznany model '${model}' - dostępne: sonnet, deepseek`);
  let token;
  try {
    const env = await readFile(join(homedir(), '.config/litellm/virtual-keys.env'), 'utf8');
    token = env.match(/^delegate-claude=(.+)$/m)?.[1];
  } catch { /* diagnoza niżej */ }
  if (!token) fail('nie znalazłem klucza delegate-claude (~/.config/litellm/virtual-keys.env) - brama LiteLLM nieskonfigurowana?');
  return { preset: 'litellm', tokenEnv: 'LITELLM_KEY', token, author };
}

/**
 * Zależności appki demo (fastify) - appka leży w repo, ale jej node_modules
 * jest ignorowane, więc po świeżym klonie trzeba je doinstalować. Idempotentne:
 * przy istniejącym node_modules nie robi nic.
 */
async function ensureAppDeps(dir) {
  if (existsSync(join(dir, 'node_modules'))) return;
  log('instaluję zależności appki demo (jednorazowo)…');
  await execFileP(...npmArgv('install', '--no-fund', '--no-audit'), { cwd: dir });
}

/** Świeże repo testów playwright - identyczny seed jak w benchmark-path. */
async function setupTestsRepo(work, baseURL) {
  const repo = join(work, 'tests-repo');
  for (const d of ['tests/e2e', 'tests/support/pom', 'tests/support/fixtures', 'knowledge/proposals']) {
    await mkdir(join(repo, d), { recursive: true });
  }
  await writeFile(join(repo, 'package.json'), JSON.stringify({
    name: 'demo-tests-repo', private: true, type: 'module',
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
  await mkdir(join(repo, 'docs/app'), { recursive: true });
  await cp(join(APP_DIR, 'README.md'), join(repo, 'docs/app/README.md'));
  const git = (...a) => execFileP('git', a, { cwd: repo });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'greenproof');
  await git('config', 'user.email', 'greenproof@localhost');
  log('instaluję @playwright/test w repo testów (chwilę potrwa)…');
  await execFileP(...npmArgv('install', '--no-fund', '--no-audit'), { cwd: repo });
  await writeFile(join(repo, '.gitignore'), 'node_modules/\npw-report.json\ntest-results/\n.greenproof-runs/\n');
  await git('add', '-A');
  await git('commit', '-m', 'init demo tests repo');
  return repo;
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url, { redirect: 'manual' }); if (r.status < 500) return; } catch { /* jeszcze nie */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`appka nie wstała: ${url}`);
}

function cli(args, env, allowCodes = [0]) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [CLI, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'], // stderr = żywy postęp (tablica w TTY)
      env: { ...process.env, ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.on('close', (code) => {
      if (!allowCodes.includes(code)) reject(new Error(`greenproof ${args[0]} exit ${code}`));
      else resolvePromise({ code, out });
    });
  });
}

async function main() {
  const provider = await providerFor(MODEL);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) +
    '-' + Math.random().toString(36).slice(2, 6);
  const work = join(RUNS_DIR, `demo-${MODEL}-${stamp}`);
  await mkdir(work, { recursive: true });
  log(`workdir: ${work}`);

  const port = 3900 + Math.floor(Math.random() * 100);
  const baseURL = `http://127.0.0.1:${port}`;
  const repo = await setupTestsRepo(work, baseURL);

  await ensureAppDeps(APP_DIR);
  log(`startuję appkę demo na :${port}…`);
  const app = spawn('node', [join(APP_DIR, 'src/server.js')], {
    env: { ...process.env, DEMO_PORT: String(port), DEMO_DB_PATH: join(work, 'demo.db') },
    stdio: 'ignore',
  });
  try {
    await waitFor(`${baseURL}/login`, 15_000);

    const configPath = join(work, 'greenproof.config.mjs');
    await cli([
      'run', '--tests-repo', repo, '--init-only', '--preset', provider.preset, '--config', configPath,
      '--author', AUTHOR ?? provider.author,
    ]);
    // Token do .env obok configu - CLI wczyta go sam; zero exportów dla użytkownika.
    await writeFile(join(work, '.env'), `${provider.tokenEnv}=${provider.token}\n`);

    const filterInput = JSON.parse(await readFile(join(ROOT, 'examples/benchmark-filter-input.json'), 'utf8'));
    filterInput.envUrl = baseURL;
    filterInput.runRef = `demo-${stamp}`;
    const inPath = join(work, 'filter-input.json');
    await writeFile(inPath, JSON.stringify(filterInput, null, 2));

    if (DRY_RUN) {
      const { out } = await cli(['preflight', '--config', configPath], {}, [0, 2]);
      log(`dry-run: preflight → ${JSON.parse(out).ok ? 'OK' : 'PORAŻKA'}; run pominięty`);
      log(`gotowe do startu: node ${CLI} run --config ${configPath} --in ${inPath}`);
      return;
    }

    log(`odpalam pełny przebieg (${MODEL}) - postęp poniżej…`);
    const outPath = join(work, 'result.json');
    // run: preflight→filter→triage→prewencja→author→deliver→eskalacje. Exit 3 =
    // częściowy sukces (część case'ów niedowieziona) - pokazujemy, nie wywalamy.
    const { code } = await cli(['run', '--config', configPath, '--in', inPath, '--out', outPath], {}, [0, 3, 10]);

    const result = JSON.parse(await readFile(outPath, 'utf8'));
    const s = result.status?.summary;
    log('────────────────────────────────────────');
    if (s) log(`wynik: ${s.passed}✓ / ${s.failed}✗ z ${s.total} · koszt $${s.costUsd.toFixed(2)} · ${s.turns} tur`);
    log(`szczegóły: ${outPath}`);
    log(`stan runu:  node ${CLI} status --config ${configPath} --run ${result.runId}`);
    log(`akceptacja: node ${CLI} accept --config ${configPath} --in '{"runId":"${result.runId}","caseId":"<case>"}'`);
    process.exitCode = code;
  } finally {
    app.kill();
  }
}

main().catch((err) => { console.error('[demo] BŁĄD:', err.message ?? err); process.exit(1); });
