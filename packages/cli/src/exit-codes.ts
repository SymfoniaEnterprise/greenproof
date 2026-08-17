/**
 * Kody wyjścia CLI - jedyne miejsce, gdzie wynik/błąd zamienia się w liczbę.
 * Platforma CI steruje przepływem joba wyłącznie tymi kodami.
 */
import { RunNotFoundError, StateConflictError } from '@greenproof/core';

export const EXIT_OK = 0;
/** Błąd infra/nieznany - platforma może ponowić krok. */
export const EXIT_INFRA = 1;
/** Walidacja wejścia albo konfigu. */
export const EXIT_VALIDATION = 2;
/** Częściowy sukces: ≥1 case blocked / attempt_failed. */
export const EXIT_PARTIAL = 3;
/** Konflikt optimistic lockingu stanu - ponowienie ma sens od razu. */
export const EXIT_STATE_CONFLICT = 4;
/** Release nie przeszedł bramek jakości. */
export const EXIT_GATE_FAILED = 5;
/** Filtr nie wybrał żadnego case'a. */
export const EXIT_EMPTY_SELECTION = 10;

export const EXIT_CODES = {
  ok: EXIT_OK,
  infra: EXIT_INFRA,
  validation: EXIT_VALIDATION,
  partial: EXIT_PARTIAL,
  stateConflict: EXIT_STATE_CONFLICT,
  gateFailed: EXIT_GATE_FAILED,
  emptySelection: EXIT_EMPTY_SELECTION,
} as const;

export const COMMAND_NAMES = [
  'run',
  'step',
  'retry',
  'accept',
  'release',
  'status',
  'models',
  'knowledge',
  'preflight',
  'fixture',
  'clean',
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}

/** Kroki pipeline'u dostępne pod `grp step <krok>`. */
export const STEP_NAMES = ['filter', 'triage', 'author', 'deliver'] as const;

export type StepName = (typeof STEP_NAMES)[number];

export function isStepName(value: string): value is StepName {
  return (STEP_NAMES as readonly string[]).includes(value);
}

/**
 * Stare komendy top-level → nowa forma. Jedna mapa; `run` buduje z niej
 * komunikat migracyjny.
 */
export const STEP_COMMAND_MIGRATIONS: Readonly<Record<string, string>> = {
  init: 'run --tests-repo <p> --init-only',
  filter: 'step filter',
  triage: 'step triage',
  author: 'step author',
  deliver: 'step deliver',
  stats: 'status --cases',
};

/** Komenda top-level albo krok - po niej `exitCodeFor` ustala kod. */
export type OutcomeCommand = CommandName | StepName;

/**
 * Błąd winy użytkownika z własnym kodem wyjścia - nie mylić z awarią infra
 * (EXIT_INFRA).
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT_VALIDATION, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export interface CommandSuccess {
  readonly ok: true;
  readonly command: OutcomeCommand;
  readonly output: unknown;
}

export interface CommandFailure {
  readonly ok: false;
  readonly error: unknown;
}

export type CommandOutcome = CommandSuccess | CommandFailure;

export function successOutcome(command: OutcomeCommand, output: unknown): CommandSuccess {
  return { ok: true, command, output };
}

export function failureOutcome(error: unknown): CommandFailure {
  return { ok: false, error };
}

/**
 * ZodError bywa instancją z INNEJ kopii zod (core i CLI mogą mieć osobne
 * instancje modułu), więc rozpoznajemy go po kształcie, nie po instanceof.
 */
export function isZodError(error: unknown): error is Error & { issues: { path: PropertyKey[]; message: string }[] } {
  return (
    error instanceof Error &&
    error.name === 'ZodError' &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/** Kod wyjścia dla BŁĘDU (bez patrzenia na wynik komendy). */
export function exitCodeForError(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof StateConflictError || isNamed(error, 'StateConflictError')) {
    return EXIT_STATE_CONFLICT;
  }
  if (error instanceof RunNotFoundError || isNamed(error, 'RunNotFoundError')) {
    return EXIT_VALIDATION;
  }
  // Brudne repo testów to stan po stronie użytkownika, nie flaki infra -
  // ponawianie kroku przez CI nigdy tego nie naprawi.
  if (isNamed(error, 'DirtyTestsRepoError')) return EXIT_VALIDATION;
  if (isZodError(error)) return EXIT_VALIDATION;
  if (isNamed(error, 'PlanParseError')) return EXIT_VALIDATION;
  if (isNamed(error, 'ArtifactDeleteUnsupportedError')) return EXIT_VALIDATION;
  return EXIT_INFRA;
}

/** Czy w wyniku author/retry jest case, który nie doszedł do dostawy. */
function hasUnfinishedCase(output: unknown): boolean {
  const results = (output as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) return false;
  return results.some((r) => {
    const status = (r as { status?: unknown }).status;
    return status === 'blocked' || status === 'attempt_failed' || status === 'failed';
  });
}

/** Końcowy stan jednokomendowego runa (cmdStatus). */
function hasUnfinishedRunStatus(output: unknown): boolean {
  const status = (output as { status?: unknown } | null | undefined)?.status;
  const cases = (status as { cases?: unknown } | null | undefined)?.cases;
  if (cases === null || typeof cases !== 'object' || Array.isArray(cases)) return false;
  return Object.values(cases as Record<string, unknown>).some((c) => {
    const value = (c as { status?: unknown } | null | undefined)?.status;
    return value === 'blocked' || value === 'attempt_failed' || value === 'failed';
  });
}

/** Kod wyjścia dla całego rezultatu komendy (sukces albo błąd). */
export function exitCodeFor(outcome: CommandOutcome): number {
  if (!outcome.ok) return exitCodeForError(outcome.error);
  const output = outcome.output;
  switch (outcome.command) {
    case 'run': {
      const preflight = (output as { preflight?: { ok?: unknown } } | null | undefined)?.preflight;
      if (preflight?.ok === false) return EXIT_VALIDATION;
      const selected = (output as { filter?: { selected?: unknown } } | null | undefined)?.filter
        ?.selected;
      if (Array.isArray(selected) && selected.length === 0) return EXIT_EMPTY_SELECTION;
      return hasUnfinishedRunStatus(output) ? EXIT_PARTIAL : EXIT_OK;
    }
    case 'filter': {
      const selected = (output as { selected?: unknown }).selected;
      return Array.isArray(selected) && selected.length === 0 ? EXIT_EMPTY_SELECTION : EXIT_OK;
    }
    case 'author':
    case 'retry':
      return hasUnfinishedCase(output) ? EXIT_PARTIAL : EXIT_OK;
    case 'release':
      return (output as { pass?: unknown }).pass === false ? EXIT_GATE_FAILED : EXIT_OK;
    case 'knowledge':
      // lint z błędami raportuje ok=false; init nigdy nie ustawia tej flagi na false.
      return (output as { ok?: unknown }).ok === false ? EXIT_VALIDATION : EXIT_OK;
    case 'preflight':
      // Endpoint niezdatny dla silnika autora (ping albo tool-calling poległ).
      return (output as { ok?: unknown }).ok === false ? EXIT_VALIDATION : EXIT_OK;
    case 'fixture':
      // ok=false w obu trybach: 'case' - nie dostarczono fixture albo weryfikacja
      // padła (case blocked); 'preventive' - ≥1 typ się nie powiódł (pominięcia nie).
      return (output as { ok?: unknown }).ok === false ? EXIT_PARTIAL : EXIT_OK;
    default:
      return EXIT_OK;
  }
}
