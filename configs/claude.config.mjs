// Gotowy config: API ANTHROPIC wprost (bez bramy i mostków).
// Użycie:
//   gp run --config configs/claude.config.mjs \
//     --in <plan.json> --app-url http://localhost:3132
// Token: configs/.env z linią `ANTHROPIC_AUTH_TOKEN=...` albo zmienna
// środowiskowa. (Wariant subskrypcyjny: sesje SDK potrafią użyć poświadczeń
// Claude z HOME - wtedy token bywa zbędny, ale pole authTokenEnv musi zostać.)
// Repo testów: GREENPROOF_TESTS_REPO w env, domyślnie
// ~/.local/share/greenproof/manual-claude/tests-repo (run scaffolduje sam).
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = join(
  process.platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')),
  'greenproof',
  'manual-claude',
);
const testsRepoDir = process.env.GREENPROOF_TESTS_REPO ?? join(home, 'tests-repo');

export default {
  platform: '@greenproof/adapter-fs',
  platformOptions: { repoDir: testsRepoDir, baseDir: join(home, 'platform') },
  plan: { source: 'json' },
  model: {
    authTokenEnv: 'ANTHROPIC_AUTH_TOKEN',
    // ── TU ZMIENIASZ MODEL ──
    author: 'claude-opus-5',
    // Bez eskalacji fixture (autor sam jest mocnym modelem). Chcesz taniej?
    // author: 'claude-haiku-4-5-20251001' + odkomentuj eskalację:
    // fixtureAuthor: { model: 'claude-opus-5' },
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
