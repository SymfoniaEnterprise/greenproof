// Gotowy config: BRAMA LITELLM (https://ai-proxy.szybkafaktura.pl).
// Użycie:
//   grp run --config configs/litellm.config.mjs \
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
    baseUrl: 'https://ai-proxy.szybkafaktura.pl',
    authTokenEnv: 'LITELLM_KEY',
    costModel: 'metered',
    // ── TU ZMIENIASZ MODEL ── nazwy to aliasy z bramy (lista: `grp models`).
    author: 'claude-sonnet-5',
    // Eskalacja dziedziczy endpoint i token autora (ta sama brama).
    fixtureAuthor: { model: 'claude-opus-5' },
    // Stawki USD/MTok dla capów kosztowych (brama metered - realne koszty).
    // Klucz MUSI się zgadzać z nazwą modelu wyżej.
    priceTable: {
      'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3 },
      'claude-opus-5': { inPerMTok: 15, outPerMTok: 75, cacheReadPerMTok: 1.5 },
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
