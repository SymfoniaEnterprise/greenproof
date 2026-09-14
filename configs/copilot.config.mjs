// Gotowy config: estymata kosztu z usage oficjalnego GitHub Copilot CLI.
// Użycie:
//   grp run --config configs/copilot.config.mjs \
//     --in <plan.json> --app-url http://localhost:3132
// Wymaga zalogowania: `copilot login` (token NIE trafia do .env ani configu).
// Model musi być dostępny w lokalnym CLI (model picker: "GPT-5.6 Luna" itd.).
// Repo testów: GREENPROOF_TESTS_REPO w env, domyślnie
// ~/.local/share/greenproof/manual-copilot/tests-repo (run scaffolduje sam).
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = join(
  process.platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')),
  'greenproof',
  'manual-copilot',
);
const testsRepoDir = process.env.GREENPROOF_TESTS_REPO ?? join(home, 'tests-repo');

export default {
  platform: '@greenproof/adapter-fs',
  platformOptions: { repoDir: testsRepoDir, baseDir: join(home, 'platform') },
  plan: { source: 'json' },
  model: {
    driver: 'copilot-cli',
    // Wymagane przez wspólny schemat, ale Copilot CLI używa własnego loginu.
    authTokenEnv: 'COPILOT_GITHUB_TOKEN',
    // ── TU ZMIENIASZ MODEL ── nazwa z katalogu Copilot (rodzina gpt-5.6-*):
    author: 'gpt-5.6-luna',
    // Eskalacja fixture-author: mocniejszy model z tej samej rodziny.
    fixtureAuthor: { model: 'gpt-5.6-terra' },
    costModel: 'metered',
    // Pusta tabela używa total_cost_usd raportowanego przez Copilot CLI.
    priceTable: {},
    copilot: {
      maxAutopilotContinues: 5,
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