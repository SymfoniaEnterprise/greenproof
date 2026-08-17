/** Schematy zod dla stanu pipeline'u (domain/state.ts). */
import { z } from 'zod';
import { CasePrioritySchema } from './plan.js';

export const BlockedReasonSchema = z.enum([
  'fixture-gap',
  'budget',
  'turns',
  'time',
  'playwright-runs',
  'infra',
  'other',
]);

export const CaseStatusSchema = z.enum([
  'pending',
  'skipped',
  'selected',
  'triaged',
  'authoring',
  'proving',
  'delivered',
  'in_review',
  'retry_requested',
  'accepted',
  'released',
  'blocked',
  'attempt_failed',
  'failed',
]);

export const LeaseSchema = z.object({
  owner: z.string().min(1),
  /** ISO 8601 - po tym czasie lease można przejąć. */
  expiresAt: z.iso.datetime({ offset: true }),
});

export const CaseArtifactsSchema = z.object({
  spec: z.string().min(1).exactOptional(),
  proof: z.string().min(1).exactOptional(),
  ledger: z.string().min(1),
});

export const CaseStateSchema = z.object({
  caseId: z.string().min(1),
  status: CaseStatusSchema,
  priority: CasePrioritySchema,
  attempts: z.number().int().nonnegative(),
  currentAttemptId: z.string().min(1).exactOptional(),
  branch: z.string().min(1).exactOptional(),
  blockedReason: BlockedReasonSchema.exactOptional(),
  blockedNote: z.string().exactOptional(),
  lease: LeaseSchema.exactOptional(),
  /** Uwagi człowieka z /retry - konsumowane przez następną próbę. */
  retryNotes: z.string().exactOptional(),
  artifacts: CaseArtifactsSchema,
  costUsd: z.number().nonnegative(),
  /** Zużyte auto-retry z puli maxAutoRetries. */
  autoRetriesUsed: z.number().int().nonnegative().exactOptional(),
  /** Pula ponowień z udanych fixture-authorów (poza maxAutoRetries). */
  fixtureRetryCredits: z.number().int().nonnegative().exactOptional(),
  /** Próby przerwane jako 'infra' - poza budżetami ponowień. */
  infraAttempts: z.number().int().nonnegative().exactOptional(),
});

export const PipelineStateSchema = z.object({
  runId: z.string().min(1),
  slug: z.string().min(1),
  planHash: z.string().min(1),
  envUrl: z.url(),
  baseRef: z.string().min(1),
  /** Branch z prewencyjnymi fixture'ami - baza branchy case'ów, gdy powstał. */
  fixturesRef: z.string().min(1).exactOptional(),
  runRef: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  cases: z.record(z.string(), CaseStateSchema),
  totals: z.object({
    costUsd: z.number().nonnegative(),
    turns: z.number().int().nonnegative(),
  }),
});
