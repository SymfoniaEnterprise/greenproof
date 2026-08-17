/** Schematy zod dla wiedzy projektowej (domain/knowledge.ts). */
import { z } from 'zod';

export const UiTrapCategorySchema = z.enum(['component-behavior', 'domain-knowledge']);

export const UiTrapSchema = z.object({
  component: z.string().min(1),
  trap: z.string().min(1),
  workaround: z.string().min(1),
  selectorExample: z.string().min(1).exactOptional(),
  category: UiTrapCategorySchema,
  appliesTo: z.array(z.string()),
  evidence: z
    .object({
      caseId: z.string().min(1),
      attemptId: z.string().min(1),
    })
    .exactOptional(),
});

export const UiTrapsSchema = z.object({
  version: z.literal(1),
  traps: z.array(UiTrapSchema),
});

export const AppMapViewSchema = z.object({
  route: z.string().min(1),
  description: z.string().exactOptional(),
  navigationSteps: z.array(z.string()),
  keySelectors: z.record(z.string(), z.string()),
});

export const AppMapSchema = z.object({
  version: z.literal(1),
  views: z.array(AppMapViewSchema),
});

export const LearnedChurnEntrySchema = z.object({
  type: z.string().min(1),
  evidence: z.object({
    caseId: z.string().min(1),
    runId: z.string().min(1),
    reason: z.enum(['seed-fuse', 'cost-outlier', 'failed-seed-strategies']),
    costUsd: z.number().nonnegative().exactOptional(),
    failedStrategies: z.number().int().nonnegative().exactOptional(),
  }),
  addedAt: z.iso.datetime({ offset: true }),
  status: z.enum(['proposed', 'active']),
  quietRuns: z.number().int().nonnegative(),
});

export const LearnedChurnListSchema = z.object({
  version: z.literal(1),
  entries: z.array(LearnedChurnEntrySchema),
});
