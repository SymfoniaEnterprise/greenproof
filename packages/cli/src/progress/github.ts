import { appendFileSync } from 'node:fs';
import type { CaseEndProgressEvent, ProgressEvent } from '@greenproof/core';
import type { ProgressRenderer, RendererIo } from './types.js';
import { createPlainRenderer } from './plain.js';

function statusEmoji(status: string): string {
  const passed = ['delivered', 'in_review', 'accepted', 'released'];
  if (passed.includes(status)) return '✅';
  if (status === 'skipped') return '⏭️';
  return '❌';
}

export function createGithubRenderer(io: RendererIo): ProgressRenderer {
  const plain = createPlainRenderer({
    write: io.write,
    env: io.env,
    isTTY: io.isTTY,
    now: io.now,
  });

  const caseEnds: CaseEndProgressEvent[] = [];

  return {
    onEvent(event: ProgressEvent): void {
      if (event.kind === 'case-start') {
        io.write(`::group::case ${event.caseId} (próba ${event.attempt})\n`);
      }

      plain.onEvent(event);

      if (event.kind === 'case-end') {
        io.write('::endgroup::\n');
        caseEnds.push(event);
      }
    },

    printAbove(line: string): void {
      plain.printAbove(line);
    },

    finalize(): void {
      const summaryPath = io.env['GITHUB_STEP_SUMMARY'];
      if (!summaryPath || caseEnds.length === 0) return;

      // Rollup z ostatniego case-end = stan runu na koniec komendy (koszt
      // łącznie, nie suma kosztów tej partii).
      const lastRollup = caseEnds.at(-1)?.rollup;

      let md = `### greenproof - ${caseEnds[0]?.runId ?? 'run'}\n\n`;
      md += '| Case | Status | Koszt | Tury |\n';
      md += '| --- | --- | --- | --- |\n';

      for (const ce of caseEnds) {
        const emoji = statusEmoji(ce.status);
        let statusStr = '';
        if (ce.status === 'blocked' && ce.blockedReason) {
          statusStr = `${emoji} ${ce.status} (${ce.blockedReason})`;
        } else {
          statusStr = `${emoji} ${ce.status}`;
        }
        md += `| ${ce.caseId} | ${statusStr} | $${ce.costUsd.toFixed(2)} | ${ce.turns} |\n`;
      }

      if (lastRollup) {
        md += `\n**Razem:** ${lastRollup.done}/${lastRollup.total} done · `;
        md += `${lastRollup.passed}✓ · ${lastRollup.failed}✗ · $${lastRollup.costUsd.toFixed(2)}\n`;
      }

      // Best-effort: błąd zapisu summary nie może zamienić udanej komendy w
      // porażkę (finalize leci z finally).
      try {
        appendFileSync(summaryPath, md, 'utf8');
      } catch {
        io.write('greenproof warn: nie udało się dopisać Job Summary (GITHUB_STEP_SUMMARY)\n');
      }
    },
  };
}
