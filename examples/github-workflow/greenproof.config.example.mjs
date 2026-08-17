/**
 * Przykładowa konfiguracja greenproof (adapter GitHub).
 * CLI: greenproof <cmd> --config greenproof.config.mjs --in in.json
 */
export default {
  platform: '@greenproof/adapter-github',
  platformOptions: {
    owner: 'moja-firma',
    repo: 'testy-e2e',
    tokenEnv: 'GITHUB_TOKEN',
    // Lokalny checkout w jobie CI - push brancha autora robi git, commity API.
    repoDir: '.',
  },

  // Natywne wejście: znormalizowany JSON. Plan z test-design.md (BMAD TEA)
  // włącza się opcjonalnym parserem:
  plan: { source: 'parser', module: '@greenproof/plan-parser-bmad' },

  model: {
    baseUrl: 'https://litellm.moja-firma.pl',
    authTokenEnv: 'LITELLM_KEY',
    author: 'claude-sonnet',
    digest: 'tani-model',
    // Własne liczenie kosztu - total_cost_usd z SDK bywa błędne za bramą.
    priceTable: {
      'claude-sonnet': { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    },
  },

  caps: {
    maxTurns: 1000,
    maxTimeMinutes: 30,
    maxCostUsd: 6,
    maxPlaywrightRuns: 6,
    maxAutoRetries: 1,
    maxCostUsdPerCase: 15,
    seedFuse: {
      // Sztywna, ręcznie rozszerzana lista typów churn-prone…
      churnProneTypes: ['lista-plac', 'ubezpieczenia-aneksu', 'lista-zamknieta'],
      // …plus uczenie z ledgera: propozycje do zatwierdzenia przez człowieka.
      learn: 'propose',
      maxFailedStrategies: 3,
      maxArrangeTurns: 40,
      learnedEntryTtlRuns: 10,
    },
    snapshotMaxChars: 30_000,
    // Zaczynaj od 'warn'; po strojeniu na realnych runach przełącz na 'enforce'.
    snapshotGating: 'warn',
  },

  qualityGates: { P0: 1.0, P1: 0.95, P2: 0.9, P3: 0.9 },

  paths: {
    testsRepoDir: '.',
    pomDir: 'tests/support/pom',
    fixturesDir: 'tests/support/fixtures',
    pomIndex: 'tests/support/pom-index.json',
    specsDir: 'tests/e2e',
  },

  knowledge: { dir: 'knowledge' },
  oracle: { goldenCasesDir: 'docs/golden-cases' },
};
