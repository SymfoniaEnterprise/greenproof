/**
 * Schemat konfiguracji. Waliduje wejście i aplikuje domyślne z DEFAULT_CONFIG -
 * wynik parse jest zawsze kompletnym GreenproofConfig.
 */
import { z } from 'zod';
import { DEFAULT_CONFIG } from '../config/types.js';

const D = DEFAULT_CONFIG;

export const ModelPriceSchema = z.object({
  inPerMTok: z.number().nonnegative(),
  outPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative().exactOptional(),
  cacheWritePerMTok: z.number().nonnegative().exactOptional(),
});

export const FixtureAuthorModelConfigSchema = z.object({
  model: z.string().min(1),
  baseUrl: z.url().exactOptional(),
  authTokenEnv: z.string().min(1).exactOptional(),
});

export const ModelConfigSchema = z.object({
  baseUrl: z.url().exactOptional(),
  authTokenEnv: z.string().min(1),
  author: z.string().min(1),
  digest: z.string().min(1).exactOptional(),
  fixtureAuthor: FixtureAuthorModelConfigSchema.exactOptional(),
  maxOutputTokens: z.number().int().positive().exactOptional(),
  priceTable: z.record(z.string(), ModelPriceSchema).exactOptional(),
  costModel: z.enum(['local', 'subscription', 'metered']).exactOptional(),
});

export const SeedFuseConfigSchema = z.object({
  /** Funkcja, nie stała - żeby parse nigdy nie oddał referencji do DEFAULT_CONFIG. */
  churnProneTypes: z.array(z.string()).default(() => [...D.caps.seedFuse.churnProneTypes]),
  learn: z.enum(['propose', 'auto', 'off']).default(D.caps.seedFuse.learn),
  maxFailedStrategies: z.number().int().positive().default(D.caps.seedFuse.maxFailedStrategies),
  maxArrangeTurns: z.number().int().positive().default(D.caps.seedFuse.maxArrangeTurns),
  learnedEntryTtlRuns: z.number().int().positive().default(D.caps.seedFuse.learnedEntryTtlRuns),
});

export const CapsConfigSchema = z.object({
  maxTurns: z.number().int().positive().default(D.caps.maxTurns),
  maxTimeMinutes: z.number().positive().default(D.caps.maxTimeMinutes),
  maxCostUsd: z.number().positive().default(D.caps.maxCostUsd),
  maxPlaywrightRuns: z.number().int().positive().default(D.caps.maxPlaywrightRuns),
  proofRuns: z.number().int().positive().default(D.caps.proofRuns),
  maxAutoRetries: z.number().int().nonnegative().default(D.caps.maxAutoRetries),
  firstTurnTimeoutMinutes: z.number().positive().default(D.caps.firstTurnTimeoutMinutes),
  maxInfraRetries: z.number().int().nonnegative().default(D.caps.maxInfraRetries),
  maxCostUsdPerCase: z.number().positive().exactOptional(),
  /** prefault, nie default - pusty obiekt przechodzi przez parse i zbiera defaulty pól. */
  seedFuse: SeedFuseConfigSchema.prefault({}),
  snapshotMaxChars: z.number().int().positive().default(D.caps.snapshotMaxChars),
  snapshotGating: z.enum(['warn', 'enforce']).default(D.caps.snapshotGating),
  enforceRunPlaywrightTool: z.boolean().default(D.caps.enforceRunPlaywrightTool),
  fixtureSession: z
    .object({
      maxTurns: z.number().int().positive().default(D.caps.fixtureSession.maxTurns),
      maxTimeMinutes: z.number().positive().default(D.caps.fixtureSession.maxTimeMinutes),
      maxCostUsd: z.number().positive().default(D.caps.fixtureSession.maxCostUsd),
    })
    .prefault({}),
});

/** Progi pokrycia per priorytet (0..1). */
export const QualityGatesSchema = z.object({
  P0: z.number().min(0).max(1).default(D.qualityGates.P0),
  P1: z.number().min(0).max(1).default(D.qualityGates.P1),
  P2: z.number().min(0).max(1).default(D.qualityGates.P2),
  P3: z.number().min(0).max(1).default(D.qualityGates.P3),
});

/** Bramki zachowania pipeline'u - auto-akceptacja włączona domyślnie. */
export const GatesConfigSchema = z.object({
  autoAccept: z.boolean().default(D.gates.autoAccept),
});

export const BatchingConfigSchema = z.object({
  timeoutBaseMin: z.number().positive().default(D.batching.timeoutBaseMin),
  timeoutPerCaseMin: z.number().positive().default(D.batching.timeoutPerCaseMin),
  timeoutCapMin: z.number().positive().default(D.batching.timeoutCapMin),
  splitWarnAt: z.number().int().positive().default(D.batching.splitWarnAt),
});

export const PathsConfigSchema = z.object({
  /** Jedyna ścieżka bez domyślnej wartości - musi ją podać użytkownik. */
  testsRepoDir: z.string().min(1),
  pomDir: z.string().min(1).default('tests/support/pom'),
  fixturesDir: z.string().min(1).default('tests/support/fixtures'),
  pomIndex: z.string().min(1).default('tests/support/pom-index.json'),
  specsDir: z.string().min(1).default('tests/e2e'),
});

export const KnowledgeConfigSchema = z.object({
  dir: z.string().min(1),
});

export const OracleConfigSchema = z.object({
  goldenCasesDir: z.string().min(1),
});

export const PlaywrightConfigSchema = z.object({
  /** Funkcja, nie stała - parse nie może oddać referencji do DEFAULT_CONFIG. */
  command: z.array(z.string().min(1)).min(1).default(() => [...D.playwright.command]),
  runTimeoutMinutes: z.number().positive().default(D.playwright.runTimeoutMinutes),
  reportFile: z.string().min(1).default(D.playwright.reportFile),
  reportEnvVar: z.string().min(1).default(D.playwright.reportEnvVar),
});

export const AppDocsConfigSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  maxChars: z.number().int().positive().default(20_000),
});

export const PlanSourceConfigSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('json') }),
  z.object({ source: z.literal('parser'), module: z.string().min(1) }),
]);

export const GreenproofConfigSchema = z.object({
  platform: z.string().min(1),
  platformOptions: z.unknown().exactOptional(),
  plan: PlanSourceConfigSchema,
  model: ModelConfigSchema,
  caps: CapsConfigSchema.prefault({}),
  qualityGates: QualityGatesSchema.prefault({}),
  gates: GatesConfigSchema.prefault({}),
  batching: BatchingConfigSchema.prefault({}),
  playwright: PlaywrightConfigSchema.prefault({}),
  paths: PathsConfigSchema,
  knowledge: KnowledgeConfigSchema.exactOptional(),
  oracle: OracleConfigSchema.exactOptional(),
  appDocs: AppDocsConfigSchema.exactOptional(),
});
