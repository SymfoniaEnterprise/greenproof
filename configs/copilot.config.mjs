// Oficjalny GitHub Copilot CLI jako procesowy agent autora.
// Wymaga zalogowania: `copilot login`.
// Model musi być dostępny w lokalnym CLI (`copilot --help` / model picker).
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
    // Zmień na model dostępny w lokalnym `copilot`.
    author: 'gpt-5.4',
    costModel: 'subscription',
    priceTable: {
      'gpt-5.4': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
    },
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