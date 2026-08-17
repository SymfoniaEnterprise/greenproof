/**
 * DELIVER - melduje człowiekowi drafty (z lintem anty-duplikacji i werdyktem
 * dowodu), case'y BLOCKED (z notatką fixture-gap) oraz propozycje wiedzy
 * zebrane na branchach case'ów. Przenosi delivered → in_review.
 */
import type { GreenproofConfig } from '../config/types.js';
import type { MutationProof } from '../domain/proof.js';
import type { Ports } from '../ports/index.js';
import type { UiTrap } from '../domain/knowledge.js';
import { parse as parseYaml } from 'yaml';
import { withState } from '../machine/withState.js';
import { casesInStatus, transitionCase } from '../machine/pipeline.js';
import { readPomIndex, unionIndexes } from '../harvest/inventory.js';
import { findSelectorDuplication, lintMarkdown } from '../harvest/lint.js';
import { lastAttempt, readLedger } from '../ledger/store.js';
import { safeCaseId } from './filter.js';

export interface DeliverParams {
  runId: string;
  /**
   * Auto-akceptacja włączona (wpływa TYLKO na treść raportu). Domyślnie false -
   * `grp step deliver` i `retry` nie auto-akceptują, tylko `run`.
   */
  autoAccept?: boolean;
}

export interface DeliverResult {
  reported: string[];
}

export function specArtifactKey(caseId: string): string {
  return `cases/${safeCaseId(caseId)}/spec.ts`;
}

export function proofArtifactKey(caseId: string): string {
  return `cases/${safeCaseId(caseId)}/proof.json`;
}

export async function runDeliver(
  ports: Ports,
  config: GreenproofConfig,
  params: DeliverParams,
): Promise<DeliverResult> {
  return withState(ports, params.runId, async (state) => {
    const reported: string[] = [];
    // Unia baseRef + branch fixture'ów - jak w triażu: wpis dorobiony wygrywa
    // konflikt nazw, a bazowy inwentarz nie znika bez zdalnego indeksu.
    const baseIndex = await readPomIndex(ports.scm, state.baseRef, config);
    const fixturesRef = state.fixturesRef;
    const pomIndex =
      fixturesRef !== undefined && fixturesRef !== state.baseRef
        ? unionIndexes(await readPomIndex(ports.scm, fixturesRef, config), baseIndex)
        : baseIndex;
    const proposals: { caseId: string; traps: UiTrap[] }[] = [];

    for (const cs of casesInStatus(state, 'delivered')) {
      const specBuf = cs.artifacts.spec
        ? await ports.artifacts.get(state.runId, cs.artifacts.spec)
        : null;
      const proofBuf = cs.artifacts.proof
        ? await ports.artifacts.get(state.runId, cs.artifacts.proof)
        : null;
      const proof = proofBuf ? (JSON.parse(proofBuf.toString('utf8')) as MutationProof) : null;
      const spec = specBuf?.toString('utf8') ?? '';
      const lint = findSelectorDuplication(cs.artifacts.spec ?? '', spec, pomIndex);
      // KWALIFIKACJA do auto-akceptacji, nie fakt dokonany: to samo kryterium
      // co w autoAccept.ts (dowód valid, zero ostrzeżeń, czysty lint), ale PR
      // otwiera dopiero autoAccept i może mu się nie udać. Raport nie ma prawa
      // twierdzić, że case jest zaakceptowany.
      const autoAccepted =
        params.autoAccept === true &&
        proof?.verdict === 'valid' &&
        proof.warnings.length === 0 &&
        lint.length === 0;

      const reportId = `${state.runId}:${safeCaseId(cs.caseId)}:draft_delivered`;
      await ports.human.postReport(state.runRef, {
        kind: 'draft_delivered',
        reportId,
        title: `Draft ${cs.caseId} gotowy do przeglądu`,
        markdown: draftMarkdown(cs.caseId, cs.branch, spec, proof, lintMarkdown(lint), cs.costUsd, autoAccepted),
        data: { caseId: cs.caseId, branch: cs.branch, proofVerdict: proof?.verdict, lint, costUsd: cs.costUsd, autoAccepted },
      });
      transitionCase(state, cs.caseId, 'in_review');
      reported.push(reportId);

      const trapProposals = await readTrapProposals(ports, config, cs.branch, cs.caseId);
      if (trapProposals.length > 0) proposals.push({ caseId: cs.caseId, traps: trapProposals });
    }

    for (const cs of casesInStatus(state, 'blocked')) {
      const note = cs.blockedNote?.trim() ?? '';
      // blocked(other) z notatką = deklaracja agenta o blokującym kontrakcie -
      // najcenniejszy wynik dostaje własny raport, nie ginie w case_blocked.
      if (cs.blockedReason === 'other' && note) {
        const ledger = await readLedger(ports.artifacts, state.runId, cs.caseId);
        const lastErrors = (lastAttempt(ledger)?.lastErrors ?? []).slice(0, 5);
        const reportId = `${state.runId}:${safeCaseId(cs.caseId)}:app_defect_suspected`;
        await ports.human.postReport(state.runRef, {
          kind: 'app_defect_suspected',
          reportId,
          title: `${cs.caseId}: możliwy defekt aplikacji (do przeglądu)`,
          markdown: appDefectMarkdown(cs.caseId, note, cs.branch, cs.costUsd, lastErrors),
          data: { caseId: cs.caseId, note, branch: cs.branch, costUsd: cs.costUsd, lastErrors },
        });
        reported.push(reportId);
        continue;
      }
      const reportId = `${state.runId}:${safeCaseId(cs.caseId)}:case_blocked`;
      await ports.human.postReport(state.runRef, {
        kind: 'case_blocked',
        reportId,
        title: `${cs.caseId} BLOCKED (${cs.blockedReason ?? 'other'})`,
        markdown: blockedMarkdown(cs.caseId, cs.blockedReason, cs.blockedNote, cs.costUsd),
        data: { caseId: cs.caseId, reason: cs.blockedReason, note: cs.blockedNote, costUsd: cs.costUsd },
      });
      reported.push(reportId);
    }

    if (proposals.length > 0) {
      const reportId = `${state.runId}:knowledge_proposals`;
      await ports.human.postReport(state.runRef, {
        kind: 'knowledge_proposals',
        reportId,
        title: `Propozycje wiedzy projektowej (${proposals.reduce((s, p) => s + p.traps.length, 0)})`,
        markdown: proposalsMarkdown(proposals),
        data: { proposals },
      });
      reported.push(reportId);
    }

    return { reported };
  });
}

/** Propozycje ui-traps zostawione przez autora na branchu case'a. */
async function readTrapProposals(
  ports: Ports,
  config: GreenproofConfig,
  branch: string | undefined,
  caseId: string,
): Promise<UiTrap[]> {
  if (!config.knowledge || !branch) return [];
  const path = `${config.knowledge.dir}/proposals/${safeCaseId(caseId)}.yaml`;
  try {
    const raw = await ports.scm.readFile(branch, path);
    if (!raw) return [];
    const parsed = parseYaml(raw) as { traps?: UiTrap[] };
    return parsed.traps ?? [];
  } catch {
    return [];
  }
}

function draftMarkdown(
  caseId: string,
  branch: string | undefined,
  spec: string,
  proof: MutationProof | null,
  lintSection: string,
  costUsd: number,
  autoAccepted: boolean,
): string {
  const excerpt = spec.length > 3000 ? `${spec.slice(0, 3000)}\n// … (przycięte)` : spec;
  const proofLine = proof
    ? proof.verdict === 'valid'
      ? `✅ Dowód mutacyjny: **valid** - czerwieni się własną asercją („${proof.redRun.assertionMessage?.slice(0, 120) ?? ''}…")`
      : `❌ Dowód mutacyjny: **invalid** - ${proof.reasons.join('; ')}`
    : '⚠️ Brak dowodu mutacyjnego';
  // Zastrzeżenia nie blokują, ale MUSZĄ trafić do człowieka - jedyne miejsce,
  // gdzie ktoś patrzy przed akceptacją.
  const warningLines = (proof?.warnings ?? []).map((w) => `⚠️ ${w}`);
  // Raport mówi wprost, czy case przyjął pipeline, czy czeka na człowieka.
  const decision = autoAccepted
    ? '✅ **Kwalifikuje się do auto-akceptacji** - dowód `valid` bez ostrzeżeń i czysty lint. PR otwiera krok auto-accept; gdy się nie powiedzie, case zostaje w `in_review`.'
    : '⏳ **Czeka na Ciebie** - decyzja: `/retry <uwagi>` albo `/accept`.';
  return [
    `Branch: \`${branch ?? '?'}\` · koszt: **$${costUsd.toFixed(2)}**`,
    '',
    proofLine,
    ...(warningLines.length > 0 ? ['', ...warningLines] : []),
    '',
    lintSection,
    '',
    '```ts',
    excerpt,
    '```',
    '',
    decision,
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

function blockedMarkdown(
  caseId: string,
  reason: string | undefined,
  note: string | undefined,
  costUsd: number,
): string {
  const lines = [
    `Case **${caseId}** zablokowany: **${reason ?? 'other'}** (koszt do tej pory: $${costUsd.toFixed(2)}).`,
  ];
  if (reason === 'fixture-gap') {
    lines.push(
      '',
      'Bezpiecznik seedu przerwał pracę - brakuje POM/fixture\'a do doprowadzenia stanu wyjściowego. To sygnał do dopisania go przez człowieka, nie do dalszego palenia budżetu modelem.',
    );
  }
  if (reason === 'infra') {
    lines.push(
      '',
      'Awaria infrastruktury sesji (sesja nie wystartowała) - do ponowienia; to nie jest wina case\'a ani modelu.',
    );
  }
  if (note) lines.push('', `Notatka agenta: ${note}`);
  lines.push('', 'Po uzupełnieniu: `/retry <uwagi>`.');
  return lines.join('\n');
}

/** Raport „podejrzenie defektu aplikacji" - deklaracja agenta; wymaga werdyktu człowieka (defekt albo wymówka modelu). */
function appDefectMarkdown(
  caseId: string,
  note: string,
  branch: string | undefined,
  costUsd: number,
  lastErrors: string[],
): string {
  const lines = [
    `Case **${caseId}**: agent zadeklarował, że aplikacja/kontrakt API blokuje flow. To DEKLARACJA AGENTA - wymaga werdyktu człowieka: albo prawdziwy defekt aplikacji (najcenniejszy wynik testera), albo wymówka modelu.`,
    '',
    `Notatka agenta: ${note}`,
    '',
    `Branch: \`${branch ?? '?'}\` · koszt: **$${costUsd.toFixed(2)}**`,
  ];
  if (lastErrors.length > 0) {
    lines.push('', 'Ostatnie błędy asercji:');
    for (const err of lastErrors) lines.push(`- ${err}`);
  }
  lines.push('', 'Decyzja: zgłoszenie defektu aplikacji albo `/retry <uwagi>`.');
  return lines.join('\n');
}

function proposalsMarkdown(proposals: { caseId: string; traps: UiTrap[] }[]): string {
  const lines: string[] = [
    'Autor odkrył (i opłacił) nowe pułapki UI. Zatwierdzenie = merge propozycji do `ui-traps.yaml` przy akcepcie case\'a.',
    '',
  ];
  for (const p of proposals) {
    lines.push(`**${p.caseId}:**`);
    for (const t of p.traps) {
      lines.push(`- \`${t.component}\` - ${t.trap} → _${t.workaround}_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
