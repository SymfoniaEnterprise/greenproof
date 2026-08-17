/**
 * Plain-text renderer - linie statusu na stderr, bez ANSI (bezpieczne dla CI).
 * Format `[gp HH:MM:SS] …`; eventy `turn` throttlowane do 1/30 s per case,
 * zdarzenia kluczowe zawsze.
 */
import type { ProgressEvent } from '@greenproof/core';
import type { ProgressRenderer, RendererIo } from './types.js';

function fmtTime(now: Date): string {
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function statusMark(status: string): string {
  const passed = ['delivered', 'in_review', 'accepted', 'released'];
  if (passed.includes(status)) return '✓';
  if (status === 'skipped') return '⏭️';
  return '✗';
}

export function createPlainRenderer(io: RendererIo): ProgressRenderer {
  const lastTurnAt = new Map<string, number>();

  const emitLine = (line: string): void => {
    io.write(line + '\n');
  };

  return {
    onEvent(event: ProgressEvent): void {
      switch (event.kind) {
        case 'turn': {
          const last = lastTurnAt.get(event.caseId) ?? 0;
          if (io.now().getTime() - last < 30_000) return;
          lastTurnAt.set(event.caseId, io.now().getTime());

          const ts = fmtTime(io.now());
          const pwPart = event.pw
            ? ` · pw ${event.pw.assertUsed}/${event.pw.assertMax}+${event.pw.proofUsed}/${event.pw.proofMax}`
            : '';
          emitLine(
            `[gp ${ts}] ${event.caseId} próba ${event.attempt} · ${event.phase} · ` +
              `tura ${event.turns}/${event.maxTurns} · ${fmtCost(event.costUsd)}/${fmtCost(event.maxCostUsd)}${pwPart}`,
          );
          break;
        }

        case 'case-start': {
          const ts = fmtTime(io.now());
          const modelPart = event.model ? ` (model: ${event.model})` : '';
          const rollup = event.rollup;
          const runPart = rollup
            ? `run ${rollup.done}/${rollup.total} (${rollup.passed}✓ ${rollup.failed}✗)`
            : '';
          emitLine(
            `[gp ${ts}] ▶ ${event.caseId} próba ${event.attempt} · start${modelPart}` +
              (runPart ? ` · ${runPart}` : ''),
          );
          break;
        }

        case 'case-end': {
          const ts = fmtTime(io.now());
          const mark = statusMark(event.status);
          const reasonPart = event.blockedReason ? ` (${event.blockedReason})` : '';
          const rollup = event.rollup;
          const runPart = rollup
            ? ` · run ${rollup.done}/${rollup.total} (${rollup.passed}✓ ${rollup.failed}✗)`
            : '';
          emitLine(
            `[gp ${ts}] ${mark} ${event.caseId} ${event.status}${reasonPart} · ` +
              `${fmtCost(event.costUsd)} · ${event.turns} tur${runPart}`,
          );
          break;
        }

        case 'playwright-run': {
          const ts = fmtTime(io.now());
          emitLine(
            `[gp ${ts}] ${event.caseId} playwright #${event.runIndex} (${event.purpose}, pula ${event.pool})` +
              ` → ${event.passed} passed / ${event.failed} failed`,
          );
          break;
        }

        case 'step': {
          const ts = fmtTime(io.now());
          const phaseLabel = event.phase === 'start' ? 'start' : 'koniec';
          const notePart = event.note ? `: ${event.note}` : '';
          emitLine(`[gp ${ts}] krok ${event.name} - ${phaseLabel}${notePart}`);
          break;
        }
      }
    },

    printAbove(line: string): void {
      io.write(line + '\n');
    },

    finalize(): void {
    },
  };
}
