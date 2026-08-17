/** Schematy zod dla ledgera prób (domain/attempt.ts). */
import { z } from 'zod';
import { BlockedReasonSchema } from './state.js';

export const AttemptTriggerSchema = z.enum(['initial', 'auto-retry', 'human-retry']);

export const AttemptOutcomeSchema = z.enum([
  'delivered',
  'blocked',
  'attempt_failed',
  'interrupted',
]);

export const AuthorPhaseSchema = z.enum(['arrange', 'act', 'assert']);

export const PhaseStatsSchema = z.object({
  turns: z.number().int().nonnegative(),
  playwrightRuns: z.number().int().nonnegative(),
});

export const SeedAttemptSchema = z.object({
  strategy: z.string().min(1),
  outcome: z.enum(['ok', 'failed']),
  note: z.string().exactOptional(),
});

export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheCreation: z.number().int().nonnegative(),
});

/** Partial<Record<AuthorPhase, PhaseStats>> - każda faza opcjonalna. */
export const PhasesSchema = z.object({
  arrange: PhaseStatsSchema.exactOptional(),
  act: PhaseStatsSchema.exactOptional(),
  assert: PhaseStatsSchema.exactOptional(),
});

export const AttemptRecordSchema = z.object({
  attemptId: z.string().min(1),
  caseId: z.string().min(1),
  runId: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }),
  trigger: AttemptTriggerSchema,
  humanNotes: z.string().exactOptional(),
  outcome: AttemptOutcomeSchema,
  blockedReason: BlockedReasonSchema.exactOptional(),
  costUsd: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  playwrightRuns: z.number().int().nonnegative(),
  proofRuns: z.number().int().nonnegative().exactOptional(),
  tokens: TokenUsageSchema,
  phases: PhasesSchema,
  seedAttempts: z.array(SeedAttemptSchema).exactOptional(),
  lastErrors: z.array(z.string()),
  filesTouched: z.array(z.string()),
  commits: z.array(z.string()),
  reusedPoms: z.array(z.string()),
  /** Kształt zna wyłącznie schemat wyjściowy agenta - core go nie interpretuje. */
  agentResult: z.unknown().exactOptional(),
  digest: z.string().exactOptional(),
  transcriptKey: z.string().min(1).exactOptional(),
});
