/**
 * FILTR PLANU - pierwszy, w pełni deterministyczny krok (bez agenta).
 * Wybiera case'y poziomu E2E, odsiewa już pokryte (akcept w repo testów albo
 * gotowy draft na branchu autora), liczy dynamiczny timeout partii i melduje
 * roster człowiekowi. Idempotentny: ponowne wywołanie dla istniejącego runId
 * z tym samym planem zwraca istniejący roster.
 */
import type { NormalizedPlan, PlanCase } from '../domain/plan.js';
import type { PipelineState } from '../domain/state.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Ports } from '../ports/index.js';
import { initPipelineState, transitionCase } from '../machine/pipeline.js';
import { hashPlan } from '../util/hash.js';

export interface FilterParams {
  runId?: string;
  envUrl: string;
  /** Ref repo testów, z którego wychodzą branche autora. */
  ref: string;
  /** Miejsce rozmowy z człowiekiem (nr issue / id zadania platformy). */
  runRef: string;
  plan: NormalizedPlan;
}

export interface FilterResult {
  runId: string;
  selected: string[];
  skipped: string[];
  timeoutMinutes: number;
  warnings: string[];
}

export const PLAN_ARTIFACT_KEY = 'plan.json';

export function safeCaseId(caseId: string): string {
  return caseId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function authorBranch(caseId: string): string {
  return `author/${safeCaseId(caseId)}`;
}

export function batchTimeoutMinutes(config: GreenproofConfig, caseCount: number): number {
  const { timeoutBaseMin, timeoutPerCaseMin, timeoutCapMin } = config.batching;
  return Math.min(timeoutBaseMin + timeoutPerCaseMin * caseCount, timeoutCapMin);
}

/** Czy w repo testów istnieje już zaakceptowany spec tego case'a (po nazwie pliku). */
function hasAcceptedSpec(specPaths: string[], c: PlanCase): boolean {
  const id = safeCaseId(c.caseId);
  return specPaths.some((p) => p.includes(c.caseId) || p.includes(id));
}

/** Czy istnieje branch autora z draftem (listFiles na nieznanym refie może rzucić). */
async function hasDraftBranch(ports: Ports, config: GreenproofConfig, c: PlanCase): Promise<boolean> {
  try {
    const files = await ports.scm.listFiles(
      authorBranch(c.caseId),
      `${config.paths.specsDir}/**`,
    );
    return files.some((p) => p.includes(c.caseId) || p.includes(safeCaseId(c.caseId)));
  } catch {
    return false;
  }
}

export async function runFilter(
  ports: Ports,
  config: GreenproofConfig,
  params: FilterParams,
): Promise<FilterResult> {
  const plan = params.plan;
  const planHash = hashPlan(plan);
  const runId = params.runId ?? defaultRunId(plan.slug, planHash, ports);

  // Idempotencja: run już zainicjowany → zwróć istniejący roster.
  const existing = await ports.state.load(runId);
  if (existing) {
    if (existing.state.planHash !== planHash) {
      throw new Error(
        `Run ${runId} already exists with a different plan (hash ${existing.state.planHash} != ${planHash})`,
      );
    }
    return rosterFrom(existing.state, config);
  }

  const state = initPipelineState(plan, {
    runId,
    envUrl: params.envUrl,
    baseRef: params.ref,
    runRef: params.runRef,
  }, ports.clock);

  const warnings: string[] = [];
  const e2eCases = plan.cases.filter((c) => c.level === 'e2e');
  const specPaths = await ports.scm.listFiles(params.ref, `${config.paths.specsDir}/**`);

  // Liczniki pominięć - bez nich „skipped: N" wygląda jak awaria, a to deduplikacja.
  const skipPowody = { nieE2e: 0, spec: 0, draft: 0 };
  for (const c of plan.cases) {
    if (c.level !== 'e2e') {
      skipPowody.nieE2e += 1;
      transitionCase(state, c.caseId, 'skipped');
      continue;
    }
    if (hasAcceptedSpec(specPaths, c)) {
      skipPowody.spec += 1;
      transitionCase(state, c.caseId, 'skipped');
      continue;
    }
    if (await hasDraftBranch(ports, config, c)) {
      skipPowody.draft += 1;
      transitionCase(state, c.caseId, 'skipped');
      continue;
    }
    transitionCase(state, c.caseId, 'selected', { branch: authorBranch(c.caseId) });
  }

  const selectedCount = Object.values(state.cases).filter((c) => c.status === 'selected').length;
  // „Czemu nic się nie odpaliło?" - deduplikacja jest CELOWA, ale musi się
  // wytłumaczyć i podpowiedzieć wyjście.
  if (selectedCount === 0 && (skipPowody.spec > 0 || skipPowody.draft > 0)) {
    const czesci: string[] = [];
    if (skipPowody.spec > 0) czesci.push(`${skipPowody.spec} z zaakceptowanym specem w ${config.paths.specsDir}/`);
    if (skipPowody.draft > 0) czesci.push(`${skipPowody.draft} z draftem na branchu author/<caseId>`);
    warnings.push(
      `Nic do zrobienia - wszystkie case'y E2E są już pokryte w repo testów (${czesci.join(', ')}). ` +
        'To celowa deduplikacja: nie płacimy drugi raz za gotową pracę. Świeży przebieg: wskaż inne repo testów ' +
        '(--tests-repo) albo usuń pokrycie (branche author/* lub specy), którego nie chcesz zachować.',
    );
  }
  if (selectedCount > config.batching.splitWarnAt) {
    warnings.push(
      `Partia ma ${selectedCount} przypadków (> ${config.batching.splitWarnAt}) - rozważ podział planu na mniejsze przebiegi.`,
    );
  }
  if (e2eCases.length === 0) {
    warnings.push('Plan nie zawiera żadnych przypadków poziomu E2E.');
  }

  await ports.artifacts.put(runId, PLAN_ARTIFACT_KEY, Buffer.from(JSON.stringify(plan, null, 2)));
  await ports.state.save(runId, state, null);

  const result = rosterFrom(state, config, warnings);
  await ports.human.postReport(params.runRef, {
    kind: 'roster',
    reportId: `${runId}:roster`,
    title: `E2E roster - ${plan.slug} (${result.selected.length} przypadków)`,
    markdown: rosterMarkdown(result, plan),
    data: result,
  });
  return result;
}

function rosterFrom(
  state: PipelineState,
  config: GreenproofConfig,
  warnings: string[] = [],
): FilterResult {
  const selected = Object.values(state.cases)
    .filter((c) => c.status !== 'skipped' && c.status !== 'pending')
    .map((c) => c.caseId);
  const skipped = Object.values(state.cases)
    .filter((c) => c.status === 'skipped')
    .map((c) => c.caseId);
  return {
    runId: state.runId,
    selected,
    skipped,
    timeoutMinutes: batchTimeoutMinutes(config, selected.length),
    warnings,
  };
}

function rosterMarkdown(result: FilterResult, plan: NormalizedPlan): string {
  const rows = result.selected.map((id) => {
    const c = plan.cases.find((pc) => pc.caseId === id);
    return `| ${id} | ${c?.priority ?? '?'} | ${c?.title ?? ''} |`;
  });
  const lines = [
    `**Run:** \`${result.runId}\` · timeout autora: **${result.timeoutMinutes} min**`,
    '',
    '| Case | Prio | Tytuł |',
    '|---|---|---|',
    ...rows,
  ];
  if (result.skipped.length > 0) {
    lines.push('', `Pominięte (pokryte lub nie-E2E): ${result.skipped.map((s) => `\`${s}\``).join(', ')}`);
  }
  for (const w of result.warnings) lines.push('', `⚠️ ${w}`);
  return lines.join('\n');
}

function defaultRunId(slug: string, planHash: string, ports: Ports): string {
  const t = ports.clock.now().toISOString().replace(/[-:]/g, '').slice(0, 13);
  return `gp-${slug}-${planHash.slice(0, 8)}-${t}`;
}
