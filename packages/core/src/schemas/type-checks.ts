/**
 * Strażnik zgodności: schemat musi wnioskować DOKŁADNIE typ domenowy - rozjazd
 * = błąd kompilacji. Plik nie eksportuje wartości, istnieje wyłącznie dla tsc.
 *
 * Pola opcjonalne używają `.exactOptional()` (zod v4), bo repo ma
 * exactOptionalPropertyTypes - `.optional()` dokłada `| undefined` i łamie
 * równość typów.
 */
import type { z } from 'zod';

import type { NormalizedPlan, PlanCase } from '../domain/plan.js';
import type { CaseArtifacts, CaseState, Lease, PipelineState } from '../domain/state.js';
import type {
  AttemptRecord,
  PhaseStats,
  SeedAttempt,
  TokenUsage,
} from '../domain/attempt.js';
import type {
  MutationInfo,
  MutationProof,
  ProofMaterial,
  RedRunAnalysis,
  RunSummary,
} from '../domain/proof.js';
import type { DuplicationFinding, PomIndex, PomIndexEntry } from '../domain/harvest.js';
import type {
  AppMap,
  AppMapView,
  LearnedChurnEntry,
  LearnedChurnList,
  UiTrap,
  UiTraps,
} from '../domain/knowledge.js';
import type { GreenproofConfig } from '../config/types.js';

import type { NormalizedPlanSchema, PlanCaseSchema } from './plan.js';
import type {
  CaseArtifactsSchema,
  CaseStateSchema,
  LeaseSchema,
  PipelineStateSchema,
} from './state.js';
import type {
  AttemptRecordSchema,
  PhaseStatsSchema,
  SeedAttemptSchema,
  TokenUsageSchema,
} from './attempt.js';
import type {
  MutationInfoSchema,
  MutationProofSchema,
  ProofMaterialSchema,
  RedRunAnalysisSchema,
  RunSummarySchema,
} from './proof.js';
import type {
  DuplicationFindingSchema,
  PomIndexEntrySchema,
  PomIndexSchema,
} from './harvest.js';
import type {
  AppMapSchema,
  AppMapViewSchema,
  LearnedChurnEntrySchema,
  LearnedChurnListSchema,
  UiTrapSchema,
  UiTrapsSchema,
} from './knowledge.js';
import type { GreenproofConfigSchema } from './config.js';

/** Ścisła równość typów (niezmienność wariancji). */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

/** Wyjście schematu = to, co dostajemy z .parse(). */
type Out<S extends z.ZodType> = z.output<S>;

// --- plan ---
type _CheckPlanCase = Expect<Equal<Out<typeof PlanCaseSchema>, PlanCase>>;
type _CheckNormalizedPlan = Expect<Equal<Out<typeof NormalizedPlanSchema>, NormalizedPlan>>;

// --- state ---
type _CheckLease = Expect<Equal<Out<typeof LeaseSchema>, Lease>>;
type _CheckCaseArtifacts = Expect<Equal<Out<typeof CaseArtifactsSchema>, CaseArtifacts>>;
type _CheckCaseState = Expect<Equal<Out<typeof CaseStateSchema>, CaseState>>;
type _CheckPipelineState = Expect<Equal<Out<typeof PipelineStateSchema>, PipelineState>>;

// --- attempt ---
type _CheckPhaseStats = Expect<Equal<Out<typeof PhaseStatsSchema>, PhaseStats>>;
type _CheckSeedAttempt = Expect<Equal<Out<typeof SeedAttemptSchema>, SeedAttempt>>;
type _CheckTokenUsage = Expect<Equal<Out<typeof TokenUsageSchema>, TokenUsage>>;
type _CheckAttemptRecord = Expect<Equal<Out<typeof AttemptRecordSchema>, AttemptRecord>>;

// --- proof ---
type _CheckRunSummary = Expect<Equal<Out<typeof RunSummarySchema>, RunSummary>>;
type _CheckMutationInfo = Expect<Equal<Out<typeof MutationInfoSchema>, MutationInfo>>;
type _CheckRedRunAnalysis = Expect<Equal<Out<typeof RedRunAnalysisSchema>, RedRunAnalysis>>;
type _CheckMutationProof = Expect<Equal<Out<typeof MutationProofSchema>, MutationProof>>;
type _CheckProofMaterial = Expect<Equal<Out<typeof ProofMaterialSchema>, ProofMaterial>>;

// --- harvest ---
type _CheckPomIndexEntry = Expect<Equal<Out<typeof PomIndexEntrySchema>, PomIndexEntry>>;
type _CheckPomIndex = Expect<Equal<Out<typeof PomIndexSchema>, PomIndex>>;
type _CheckDuplicationFinding = Expect<
  Equal<Out<typeof DuplicationFindingSchema>, DuplicationFinding>
>;

// --- knowledge ---
type _CheckUiTrap = Expect<Equal<Out<typeof UiTrapSchema>, UiTrap>>;
type _CheckUiTraps = Expect<Equal<Out<typeof UiTrapsSchema>, UiTraps>>;
type _CheckAppMapView = Expect<Equal<Out<typeof AppMapViewSchema>, AppMapView>>;
type _CheckAppMap = Expect<Equal<Out<typeof AppMapSchema>, AppMap>>;
type _CheckLearnedChurnEntry = Expect<
  Equal<Out<typeof LearnedChurnEntrySchema>, LearnedChurnEntry>
>;
type _CheckLearnedChurnList = Expect<
  Equal<Out<typeof LearnedChurnListSchema>, LearnedChurnList>
>;

// --- config ---
type _CheckConfig = Expect<Equal<Out<typeof GreenproofConfigSchema>, GreenproofConfig>>;
