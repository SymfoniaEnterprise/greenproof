/** Schematy zod dla znormalizowanego planu testów (domain/plan.ts). */
import { z } from 'zod';

export const CasePrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);

export const CaseLevelSchema = z.enum(['e2e', 'integration', 'unit']);

export const PlanCaseSchema = z.object({
  caseId: z.string().min(1),
  title: z.string().min(1),
  level: CaseLevelSchema,
  priority: CasePrioritySchema,
  requirements: z.array(z.string()),
  flows: z.array(z.string()),
  type: z.string().min(1).exactOptional(),
  notes: z.string().exactOptional(),
});

export const NormalizedPlanSchema = z.object({
  slug: z.string().min(1),
  /** Pusta lista case'ów jest legalna (plan bez nic do zrobienia). */
  cases: z.array(PlanCaseSchema),
  source: z
    .object({
      format: z.string().min(1),
      path: z.string().min(1).exactOptional(),
    })
    .exactOptional(),
});
