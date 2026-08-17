/**
 * Kontrakt wejść/wyjść komend CLI - podstawa integracji z platformą.
 * Zmiana schematu jest zmianą łamiącą dla adapterów.
 */
import { z } from 'zod';
import { NormalizedPlanSchema } from './plan.js';

/** Plan podany inline albo wskazany ścieżką w repo testów. */
export const PlanRefSchema = z.union([
  NormalizedPlanSchema,
  z.object({ path: z.string().min(1) }),
]);

export const FilterInputSchema = z.object({
  /** Pominięte = core wygeneruje nowy runId. */
  runId: z.string().min(1).exactOptional(),
  slug: z.string().min(1),
  envUrl: z.url(),
  /** Ref repo testów, z którego wychodzą branche autora. */
  ref: z.string().min(1),
  /** Identyfikator "miejsca rozmowy" z człowiekiem. */
  runRef: z.string().min(1),
  plan: PlanRefSchema,
});

export const FilterOutputSchema = z.object({
  runId: z.string().min(1),
  selected: z.array(z.string()),
  skipped: z.array(z.string()),
  timeoutMinutes: z.number().positive(),
  warnings: z.array(z.string()),
});

export const TriageInputSchema = z.object({
  runId: z.string().min(1),
  /** Pominięte = triaż wszystkich wybranych case'ów. */
  caseId: z.string().min(1).exactOptional(),
});

export const TriageOutputSchema = z.object({
  contexts: z.array(
    z.object({
      caseId: z.string().min(1),
      artifactKey: z.string().min(1),
    }),
  ),
});

export const AuthorInputSchema = z.object({
  runId: z.string().min(1),
  /** Pominięte = wszystkie case'y po triażu. */
  caseIds: z.array(z.string().min(1)).exactOptional(),
});

export const AuthorOutputSchema = z.object({
  results: z.array(
    z.object({
      caseId: z.string().min(1),
      status: z.string().min(1),
      costUsd: z.number().nonnegative(),
      turns: z.number().int().nonnegative(),
      blockedReason: z.string().min(1).exactOptional(),
    }),
  ),
});

export const DeliverInputSchema = z.object({
  runId: z.string().min(1),
});

export const DeliverOutputSchema = z.object({
  reported: z.array(z.string()),
});

export const RetryInputSchema = z.object({
  runId: z.string().min(1),
  caseId: z.string().min(1),
  /** Uwagi testerki do następnej próby. */
  notes: z.string().exactOptional(),
});

export const AcceptInputSchema = z.object({
  runId: z.string().min(1),
  caseId: z.string().min(1),
  targetBranch: z.string().min(1),
});

export const AcceptOutputSchema = z.object({
  prUrl: z.url(),
});

export const ReleaseInputSchema = z.object({
  runId: z.string().min(1),
  waivers: z
    .array(
      z.object({
        caseId: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .exactOptional(),
});

export const GateResultSchema = z.object({
  required: z.number().min(0).max(1),
  actual: z.number().min(0).max(1),
  pass: z.boolean(),
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  missing: z.array(z.object({ caseId: z.string().min(1), waived: z.boolean() })),
});

export const ReleaseOutputSchema = z.object({
  /** Klucz = priorytet (P0..P3); Record, bo bramki mogą rosnąć. */
  gates: z.record(z.string(), GateResultSchema),
  pass: z.boolean(),
  released: z.array(z.string()),
  churn: z.object({ added: z.array(z.string()), expired: z.array(z.string()) }),
});

export const FixtureInputSchema = z
  .object({
    runId: z.string().min(1),
    /**
     * 'case' (domyślnie, wejście zgodne wstecz) = fixture-author dla case'a
     * blocked(fixture-gap); 'preventive' = sesje per churn-prone TYP przed partią autora.
     */
    mode: z.enum(['case', 'preventive']).default('case'),
    /** Wymagane w trybie 'case'; w 'preventive' ignorowane. */
    caseId: z.string().min(1).exactOptional(),
    /** Tryb 'preventive': zawężenie typów (domyślnie churn-prone z configu + nauczone). */
    types: z.array(z.string().min(1)).exactOptional(),
  })
  .check((ctx) => {
    if (ctx.value.mode === 'case' && ctx.value.caseId === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value.caseId,
        path: ['caseId'],
        message: "caseId jest wymagane w trybie 'case'",
      });
    }
  });

export const FixtureOutputSchema = z.object({
  ok: z.boolean(),
  caseId: z.string().min(1),
  fixture: z
    .object({ name: z.string(), path: z.string(), covers: z.array(z.string()) })
    .exactOptional(),
  verify: z.object({ exitCode: z.number().int(), output: z.string() }).exactOptional(),
  error: z.string().exactOptional(),
  costUsd: z.number(),
  turns: z.number().int(),
});

/**
 * Wyjście trybu 'preventive' - OSOBNY kształt, żeby JSON trybu 'case'
 * (FixtureOutput) pozostał niezmieniony dla istniejących adapterów.
 */
export const PreventiveFixtureOutputSchema = z.object({
  types: z.array(
    z.object({
      type: z.string().min(1),
      status: z.enum(['delivered', 'skipped', 'failed']),
      caseId: z.string().min(1).exactOptional(),
      fixture: z
        .object({ name: z.string(), path: z.string(), covers: z.array(z.string()) })
        .exactOptional(),
      note: z.string().exactOptional(),
      error: z.string().exactOptional(),
      costUsd: z.number(),
      turns: z.number().int(),
    }),
  ),
  costUsd: z.number(),
  turns: z.number().int(),
  ok: z.boolean(),
});

export const StatusInputSchema = z.object({
  runId: z.string().min(1),
});

export const StatsInputSchema = z.object({
  runId: z.string().min(1),
});

export const CleanInputSchema = z.object({
  runId: z.string().min(1),
  caseIds: z.array(z.string().min(1)).exactOptional(),
  /** Usuń też ledger/spec/proof (niszczy ślad audytowy). */
  purge: z.boolean().exactOptional(),
  dryRun: z.boolean().exactOptional(),
  /** false = zostaw branche (domyślnie sprzątane po released). */
  branches: z.boolean().exactOptional(),
});

export const CleanOutputSchema = z.object({
  runId: z.string().min(1),
  deleted: z.array(z.string()),
  deletedBranches: z.array(z.string()),
  kept: z.array(z.object({ caseId: z.string(), status: z.string(), reason: z.string() })),
  branchNote: z.string().exactOptional(),
  dryRun: z.boolean(),
});

export type PlanRef = z.infer<typeof PlanRefSchema>;
export type FilterInput = z.infer<typeof FilterInputSchema>;
export type FilterOutput = z.infer<typeof FilterOutputSchema>;
export type TriageInput = z.infer<typeof TriageInputSchema>;
export type TriageOutput = z.infer<typeof TriageOutputSchema>;
export type AuthorInput = z.infer<typeof AuthorInputSchema>;
export type AuthorOutput = z.infer<typeof AuthorOutputSchema>;
export type DeliverInput = z.infer<typeof DeliverInputSchema>;
export type DeliverOutput = z.infer<typeof DeliverOutputSchema>;
export type RetryInput = z.infer<typeof RetryInputSchema>;
export type AcceptInput = z.infer<typeof AcceptInputSchema>;
export type AcceptOutput = z.infer<typeof AcceptOutputSchema>;
export type ReleaseInput = z.infer<typeof ReleaseInputSchema>;
export type GateResult = z.infer<typeof GateResultSchema>;
export type ReleaseOutput = z.infer<typeof ReleaseOutputSchema>;
export type StatusInput = z.infer<typeof StatusInputSchema>;
export type StatsInput = z.infer<typeof StatsInputSchema>;
export type FixtureInput = z.infer<typeof FixtureInputSchema>;
export type FixtureOutput = z.infer<typeof FixtureOutputSchema>;
export type PreventiveFixtureOutput = z.infer<typeof PreventiveFixtureOutputSchema>;
export type CleanInput = z.infer<typeof CleanInputSchema>;
export type CleanOutput = z.infer<typeof CleanOutputSchema>;
