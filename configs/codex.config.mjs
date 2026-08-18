// Gotowy config: SUBSKRYPCJA CODEX przez mostek CLIProxyAPI (http://127.0.0.1:8317).
// Użycie:
//   grp run --config configs/codex.config.mjs \
//     --in <plan.json> --app-url http://localhost:3132
// Token: configs/.env z linią `CLIPROXY_TOKEN=...` (klucz z ~/.config/cliproxyapi/config.yaml)
// albo zmienna środowiskowa. Repo testów: GREENPROOF_TESTS_REPO w env,
// domyślnie ~/.local/share/greenproof/manual-codex/tests-repo (run scaffolduje sam).
// Efforty: sufiks w nazwie modelu, np. gpt-5.6-luna(max) - patrz docs/model-bridges.md §4a.
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = join(
  process.platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')),
  'greenproof',
  'manual-codex',
);
const testsRepoDir = process.env.GREENPROOF_TESTS_REPO ?? join(home, 'tests-repo');

export default {
  platform: '@greenproof/adapter-fs',
  platformOptions: { repoDir: testsRepoDir, baseDir: join(home, 'platform') },
  plan: { source: 'json' },
  model: {
    baseUrl: 'http://127.0.0.1:8317',
    authTokenEnv: 'CLIPROXY_TOKEN',
    // ── TU ZMIENIASZ MODEL ── (sufiks (low|medium|high|max) = reasoning effort):
    author: 'gpt-5.6-luna(max)',
    fixtureAuthor: { model: 'gpt-5.6-sol(high)' },
    // Subskrypcja = realnie $0; zera zostawiają capy tur/czasu jako jedyne.
    priceTable: {
      'gpt-5.6-luna': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      'gpt-5.6-sol': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
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
    fixtureSession: { maxTurns: 80, maxTimeMinutes: 30, maxCostUsd: 1 },
  },
  paths: { testsRepoDir },
};
