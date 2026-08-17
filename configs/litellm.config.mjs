// Gotowy config: BRAMA LITELLM (http://127.0.0.1:4000).
// Użycie:
//   gp run --config configs/litellm.config.mjs \
//     --in <plan.json> --app-url http://localhost:3132
// Token: plik configs/.env z linią `LITELLM_KEY=...` (CLI wczyta sam)
// albo zmienna środowiskowa. Repo testów: GREENPROOF_TESTS_REPO w env,
// domyślnie ~/.local/share/greenproof/manual-litellm/tests-repo
// (run tworzy je i scaffolduje automatycznie).
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = join(
  process.platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')),
  'greenproof',
  'manual-litellm',
);
const testsRepoDir = process.env.GREENPROOF_TESTS_REPO ?? join(home, 'tests-repo');

export default {
  platform: '@greenproof/adapter-fs',
  platformOptions: { repoDir: testsRepoDir, baseDir: join(home, 'platform') },
  plan: { source: 'json' },
  model: {
    baseUrl: 'http://127.0.0.1:4000',
    authTokenEnv: 'LITELLM_KEY',
    // ── TU WPISZ SWÓJ MODEL ── aliasy w bramie są instalacyjne (każdy nazywa
    // wpisy po swojemu), więc nie ma tu sensownego domyślnego. Listę nazw da
    // `gp models`; dopóki zostaje placeholder, preflight przerywa run.
    author: '<model-z-bramy>',
    // Eskalacja dziedziczy endpoint i token autora (ta sama brama).
    fixtureAuthor: { model: 'claude-sonnet-5' },
    // Stawki USD/MTok dla capów kosztowych - 0 = capy $ nie gryzą (zostają tury/czas).
    // Klucz MUSI się zgadzać z nazwą modelu wyżej.
    priceTable: {
      '<model-z-bramy>': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3 },
    },
  },
  caps: {
    maxTurns: 400,
    maxTimeMinutes: 30,
    maxCostUsd: 8,
    maxPlaywrightRuns: 12,
    proofRuns: 4,
    maxAutoRetries: 1,
    snapshotGating: 'enforce',
    fixtureSession: { maxTurns: 80, maxTimeMinutes: 30, maxCostUsd: 2.5 },
  },
  paths: { testsRepoDir },
};
