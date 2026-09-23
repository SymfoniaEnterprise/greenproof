// Gotowy config: Claude Code natywnie - sesja autora dziedziczy logowanie z
// ~/.claude/settings.json operatora (subskrypcja indywidualna, Team/Enterprise
// OAuth, albo firmowe proxy LiteLLM przez env.ANTHROPIC_BASE_URL w tym pliku).
// Użycie:
//   grp run --config configs/claude-native.config.mjs \
//     --in <plan.json> --app-url http://localhost:3132
// NIE ustawiaj ANTHROPIC_AUTH_TOKEN - to jest cały sens tego trybu. Ustawienie
// tokenu przełączy sesję z powrotem w izolowany tryb bramy (settingSources: []),
// który nie widzi ANTHROPIC_BASE_URL/nagłówków proxy operatora z tego pliku.
// Preflight (`grp preflight`) sprawdza dostępność binarki `claude` i obecność
// ANTHROPIC_BASE_URL w ~/.claude/settings.json, bez requestu sieciowego -
// szczegóły i znane problemy: docs/model-bridges.md, sekcja "Preset claude-native".
// Repo testów: GREENPROOF_TESTS_REPO w env, domyślnie
// ~/.local/share/greenproof/manual-claude-native/tests-repo (run scaffolduje sam).
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = join(
  process.platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')),
  'greenproof',
  'manual-claude-native',
);
const testsRepoDir = process.env.GREENPROOF_TESTS_REPO ?? join(home, 'tests-repo');

export default {
  platform: '@greenproof/adapter-fs',
  platformOptions: { repoDir: testsRepoDir, baseDir: join(home, 'platform') },
  plan: { source: 'json' },
  model: {
    authTokenEnv: 'ANTHROPIC_AUTH_TOKEN',
    // ── TU ZMIENIASZ MODEL ── nazwa aliasu z TWOJEGO ~/.claude/settings.json
    // (pole "availableModels" albo "model") - aliasy typu *-byok są instalacyjne.
    author: 'claude-sonnet-5-byok',
    // Eskalacja fixture-gap: mocniejszy model tej samej rodziny.
    fixtureAuthor: { model: 'claude-opus-5-5-byok' },
    costModel: 'subscription',
    priceTable: {},
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
