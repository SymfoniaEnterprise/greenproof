/** Schematy zod dla dowodu mutacyjnego (domain/proof.ts). */
import { z } from 'zod';

export const FailureKindSchema = z.enum(['own-assertion', 'timeout', 'infra', 'other']);

export const RunSummarySchema = z.object({
  testId: z.string().min(1),
  status: z.enum(['passed', 'failed']),
  durationMs: z.number().nonnegative().exactOptional(),
  errorMessage: z.string().exactOptional(),
});

export const MutationInfoSchema = z.object({
  description: z.string().min(1),
  diff: z.string().min(1),
  targetCondition: z.string().min(1),
});

export const RedRunAnalysisSchema = RunSummarySchema.extend({
  failedInSameTest: z.boolean(),
  failureKind: FailureKindSchema,
  assertionMessage: z.string().exactOptional(),
});

export const MutationProofSchema = z.object({
  caseId: z.string().min(1),
  attemptId: z.string().min(1),
  greenRuns: z.tuple([RunSummarySchema, RunSummarySchema]),
  mutation: MutationInfoSchema,
  redRun: RedRunAnalysisSchema,
  restored: z.object({
    verified: z.boolean(),
    gitDiffEmpty: z.boolean(),
  }),
  verdict: z.enum(['valid', 'invalid']),
  reasons: z.array(z.string()),
  /** Zastrzeżenia nieunieważniające dowodu - do przeglądu przy `accept`. */
  warnings: z.array(z.string()),
});

/** Surowiec od agenta - przed werdyktem walidatora. */
export const ProofMaterialSchema = z.object({
  greenRunReports: z.tuple([z.string().min(1), z.string().min(1)]),
  mutation: MutationInfoSchema,
  redRunReport: z.string().min(1),
  /** Test dowodowy wskazany przez agenta (`plik::tytuł` albo fragment tytułu). */
  proofTest: z.string().min(1).exactOptional(),
});
