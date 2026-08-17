/**
 * RELEASE - bramki jakości (własne, z konfigu - niezależne od źródła planu),
 * telemetria runa i domknięcie uczenia listy churn-prone. Przenosi
 * accepted → released.
 */
import type { CasePriority, NormalizedPlan } from '../domain/plan.js';
import type { AttemptRecord } from '../domain/attempt.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Ports } from '../ports/index.js';
import { withState } from '../machine/withState.js';
import { casesInStatus, transitionCase } from '../machine/pipeline.js';
import { PLAN_ARTIFACT_KEY } from './filter.js';
import { readLedger } from '../ledger/store.js';
import { LEARNED_CHURN_FILE, loadLearnedChurn } from '../knowledge/loader.js';
import { detectChurnIncidents, updateLearnedChurn } from '../knowledge/churn.js';

export interface ReleaseParams {
  runId: string;
  /** Waivery dla niedomkniętych case'ów P1 (wymagane, żeby bramka P1 przeszła). */
  waivers?: { caseId: string; reason: string }[];
}

export interface ReleaseGateResult {
  required: number;
  actual: number;
  total: number;
  done: number;
  pass: boolean;
  /** Case'y niedomknięte; przy P1 z waiverem - odnotowane. */
  missing: { caseId: string; waived: boolean }[];
}

export interface ReleaseResult {
  gates: Record<CasePriority, ReleaseGateResult>;
  pass: boolean;
  released: string[];
  churn: { added: string[]; expired: string[] };
}

const PRIORITIES: CasePriority[] = ['P0', 'P1', 'P2', 'P3'];
/** Bramki informacyjne - nie blokują release. */
const INFORMATIONAL: ReadonlySet<CasePriority> = new Set(['P2', 'P3']);

export async function runRelease(
  ports: Ports,
  config: GreenproofConfig,
  params: ReleaseParams,
): Promise<ReleaseResult> {
  const planBuf = await ports.artifacts.get(params.runId, PLAN_ARTIFACT_KEY);
  if (!planBuf) throw new Error(`Missing plan artifact for run ${params.runId}`);
  const plan = JSON.parse(planBuf.toString('utf8')) as NormalizedPlan;
  const waivers = new Map((params.waivers ?? []).map((w) => [w.caseId, w.reason]));

  return withState(ports, params.runId, async (state) => {
    const gates = {} as Record<CasePriority, ReleaseGateResult>;
    for (const prio of PRIORITIES) {
      const inScope = Object.values(state.cases).filter(
        (c) => c.priority === prio && c.status !== 'skipped' && c.status !== 'pending',
      );
      const done = inScope.filter((c) => c.status === 'accepted' || c.status === 'released');
      const missing = inScope
        .filter((c) => c.status !== 'accepted' && c.status !== 'released')
        .map((c) => ({ caseId: c.caseId, waived: waivers.has(c.caseId) }));
      const actual = inScope.length === 0 ? 1 : done.length / inScope.length;
      const required = config.qualityGates[prio];

      let pass = actual >= required;
      if (!pass && prio === 'P1') {
        // P1: fail wymaga waivera na KAŻDY niedomknięty case.
        pass = missing.every((m) => m.waived);
      }
      if (!pass && INFORMATIONAL.has(prio)) pass = true;
      if (prio === 'P0' && missing.length > 0) pass = false; // P0 bez wyjątków

      gates[prio] = { required, actual, total: inScope.length, done: done.length, pass, missing };
    }
    const pass = PRIORITIES.every((p) => gates[p].pass);

    // Uczenie churn-prone z ledgerów tego runa.
    const ledgers = new Map<string, AttemptRecord[]>();
    for (const cs of Object.values(state.cases)) {
      if (cs.status === 'skipped' || cs.status === 'pending') continue;
      ledgers.set(cs.caseId, await readLedger(ports.artifacts, state.runId, cs.caseId));
    }
    const learned = await loadLearnedChurn(ports.scm, state.baseRef, config, ports.logger);
    const incidents = detectChurnIncidents(plan, ledgers, config, state.runId);
    const update = updateLearnedChurn(learned, incidents, plan, config, ports.clock);

    if (config.knowledge && config.caps.seedFuse.learn !== 'off') {
      const path = `${config.knowledge.dir}/${LEARNED_CHURN_FILE}`;
      const content = JSON.stringify(update.list, null, 2);
      if (config.caps.seedFuse.learn === 'auto') {
        // Tryb auto: wpisy aktywne od razu - commit prosto do gałęzi bazowej.
        await ports.scm.commitFiles(
          state.baseRef,
          [{ path, content }],
          `chore(greenproof): update learned churn-prone list (run ${state.runId})`,
        );
      } else {
        // Tryb propose: plik jako artefakt + raport - człowiek zatwierdza.
        await ports.artifacts.put(state.runId, LEARNED_CHURN_FILE, Buffer.from(content));
      }
    }

    const released: string[] = [];
    for (const cs of casesInStatus(state, 'accepted')) {
      transitionCase(state, cs.caseId, 'released');
      released.push(cs.caseId);
    }

    const result: ReleaseResult = {
      gates,
      pass,
      released,
      churn: { added: update.added.map((e) => e.type), expired: update.expired },
    };
    await ports.human.postReport(state.runRef, {
      kind: 'released',
      reportId: `${state.runId}:released`,
      title: `Release ${state.slug}: ${pass ? 'bramki OK' : 'bramki NIE przeszły'}`,
      markdown: releaseMarkdown(result, state.totals, ledgers),
      data: result,
    });
    return result;
  });
}

function releaseMarkdown(
  result: ReleaseResult,
  totals: { costUsd: number; turns: number },
  ledgers: Map<string, AttemptRecord[]>,
): string {
  const gateRows = PRIORITIES.map((p) => {
    const g = result.gates[p];
    const missing = g.missing
      .map((m) => `${m.caseId}${m.waived ? ' (waiver)' : ''}`)
      .join(', ');
    return `| ${p} | ${(g.required * 100).toFixed(0)}% | ${(g.actual * 100).toFixed(0)}% (${g.done}/${g.total}) | ${g.pass ? '✅' : '❌'} | ${missing} |`;
  });

  // Telemetria wartości harvestu: ile odkryć zaoszczędzono dzięki reuse.
  const reuseTotal = [...ledgers.values()]
    .flat()
    .reduce((s, r) => s + r.reusedPoms.length, 0);

  const lines = [
    `Wynik: **${result.pass ? 'PASS' : 'FAIL'}** · koszt runa: **$${totals.costUsd.toFixed(2)}** · tury: ${totals.turns} · reuse POM: ${reuseTotal}×`,
    '',
    '| Bramka | Próg | Pokrycie | Wynik | Braki |',
    '|---|---|---|---|---|',
    ...gateRows,
  ];
  if (result.churn.added.length > 0) {
    lines.push('', `🧠 Nowe typy churn-prone (${result.churn.added.length}): ${result.churn.added.map((t) => `\`${t}\``).join(', ')}`);
  }
  if (result.churn.expired.length > 0) {
    lines.push('', `Wygaszone typy churn-prone: ${result.churn.expired.map((t) => `\`${t}\``).join(', ')}`);
  }
  if (result.released.length > 0) {
    lines.push('', `Released: ${result.released.map((c) => `\`${c}\``).join(', ')}`);
  }
  return lines.join('\n');
}
