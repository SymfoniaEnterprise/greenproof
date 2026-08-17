/** Tabela mapowania wynik/błąd → kod wyjścia. Jedyne źródło prawdy CI. */
import { FilterInputSchema, RunNotFoundError, StateConflictError } from '@greenproof/core';
import { describe, expect, it } from 'vitest';
import {
  CliError,
  exitCodeFor,
  failureOutcome,
  successOutcome,
} from '../src/exit-codes.js';
import type { OutcomeCommand } from '../src/exit-codes.js';

function zodError(): unknown {
  try {
    FilterInputSchema.parse({});
    throw new Error('parse powinien rzucić');
  } catch (err) {
    return err;
  }
}

/** Błąd z "innej kopii" modułu - rozpoznanie po nazwie, nie po instanceof. */
function foreignConflict(): Error {
  const err = new Error('Pipeline state for run r was modified concurrently');
  err.name = 'StateConflictError';
  return err;
}

/** Bramka czystości repo testów - rozpoznawana po nazwie, jak konflikt stanu. */
function dirtyTestsRepo(): Error {
  const err = new Error('Repo testów /tmp/x ma niezacommitowane zmiany w plikach śledzonych');
  err.name = 'DirtyTestsRepoError';
  return err;
}

const successCases: [string, OutcomeCommand, unknown, number][] = [
  ['run bez wybranych case\'ów', 'run', { preflight: { ok: true }, filter: { selected: [] } }, 10],
  [
    'run bez niedomkniętych case\'ów',
    'run',
    { preflight: { ok: true }, filter: { selected: ['a'] }, status: { cases: { a: { status: 'in_review' } } } },
    0,
  ],
  ['filter bez wybranych case\'ów', 'filter', { selected: [], skipped: ['a'] }, 10],
  ['filter z wybranymi', 'filter', { selected: ['a'], skipped: [] }, 0],
  ['author w całości dostarczony', 'author', { results: [{ status: 'delivered' }] }, 0],
  [
    'author z blocked',
    'author',
    { results: [{ status: 'delivered' }, { status: 'blocked', blockedReason: 'budget' }] },
    3,
  ],
  ['retry z attempt_failed', 'retry', { results: [{ status: 'attempt_failed' }] }, 3],
  ['retry udany', 'retry', { results: [{ status: 'delivered' }], reported: ['c1'] }, 0],
  ['release poniżej bramek', 'release', { pass: false, gates: {} }, 5],
  ['release przechodzi', 'release', { pass: true, gates: {} }, 0],
  ['knowledge lint z błędami', 'knowledge', { action: 'lint', ok: false }, 2],
  ['knowledge lint czysty', 'knowledge', { action: 'lint', ok: true }, 0],
  ['knowledge init', 'knowledge', { action: 'init', created: [], skipped: [] }, 0],
  ['status', 'status', { runId: 'r', cases: {} }, 0],
  ['models bez listy (brama niedostępna)', 'models', { available: false, models: [], note: 'timeout' }, 0],
  ['triage', 'triage', { contexts: [] }, 0],
  ['deliver', 'deliver', { reported: [] }, 0],
  ['accept', 'accept', { prUrl: 'https://example.test/pr/1' }, 0],
];

describe('exitCodeFor - sukcesy', () => {
  it.each(successCases)('%s → %i', (_name, command, output, expected) => {
    expect(exitCodeFor(successOutcome(command, output))).toBe(expected);
  });
});

const failureCases: [string, unknown, number][] = [
  ['StateConflictError', new StateConflictError('run-1'), 4],
  ['StateConflictError z innej kopii modułu', foreignConflict(), 4],
  ['ZodError', zodError(), 2],
  ['RunNotFoundError', new RunNotFoundError('run-1'), 2],
  ['CliError (domyślnie walidacja)', new CliError('zły config'), 2],
  ['CliError z własnym kodem', new CliError('padło', 1), 1],
  ['DirtyTestsRepoError (repo testów do posprzątania, nie flak infra)', dirtyTestsRepo(), 2],
  ['nieznany błąd', new Error('boom'), 1],
  ['rzucony string', 'boom', 1],
];

describe('exitCodeFor - run', () => {
  it('preflight false → 2', () => {
    expect(
      exitCodeFor(
        successOutcome('run', { preflight: { ok: false }, filter: null, status: null }),
      ),
    ).toBe(2);
  });

  it('końcowy cmdStatus z blocked/attempt_failed/failed → 3', () => {
    for (const status of ['blocked', 'attempt_failed', 'failed']) {
      expect(
        exitCodeFor(
          successOutcome('run', {
            preflight: { ok: true },
            filter: { selected: ['a'] },
            status: { cases: { a: { status } } },
          }),
        ),
      ).toBe(3);
    }
  });
});

describe('exitCodeFor - błędy', () => {
  it.each(failureCases)('%s → %i', (_name, error, expected) => {
    expect(exitCodeFor(failureOutcome(error))).toBe(expected);
  });
});
