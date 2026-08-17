/** Drobne fake'i: zegar, logger, sekrety. */
import type { Clock, Logger, SecretsPort } from '@greenproof/core';

/** Zegar sterowany ręcznie - bez niego testy timeoutów są niedeterministyczne. */
export class FixedClock implements Clock {
  private ms: number;

  constructor(start: Date | string | number = '2025-01-01T00:00:00.000Z') {
    this.ms = typeof start === 'number' ? start : new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  /** Przesuwa czas o podaną liczbę milisekund. */
  advance(ms: number): void {
    this.ms += ms;
  }

  /** Ustawia czas na konkretny moment. */
  set(at: Date | string | number): void {
    this.ms = typeof at === 'number' ? at : new Date(at).getTime();
  }

  /** Bieżący czas jako ISO 8601 - wygodne przy budowie stanów. */
  iso(): string {
    return new Date(this.ms).toISOString();
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  msg: string;
  data?: unknown;
}

/** Logger zbierający wpisy zamiast pisać na stdout. */
export class TestLogger implements Logger {
  readonly entries: LogEntry[] = [];

  debug(msg: string, data?: unknown): void {
    this.push('debug', msg, data);
  }

  info(msg: string, data?: unknown): void {
    this.push('info', msg, data);
  }

  warn(msg: string, data?: unknown): void {
    this.push('warn', msg, data);
  }

  error(msg: string, data?: unknown): void {
    this.push('error', msg, data);
  }

  /** Komunikaty (opcjonalnie filtrowane po poziomie). */
  messages(level?: LogLevel): string[] {
    return this.entries.filter((e) => !level || e.level === level).map((e) => e.msg);
  }

  clear(): void {
    this.entries.length = 0;
  }

  private push(level: LogLevel, msg: string, data: unknown): void {
    // exactOptionalPropertyTypes: nie wstawiamy klucza `data` z wartością undefined.
    this.entries.push(data === undefined ? { level, msg } : { level, msg, data });
  }
}

/** Sekrety z mapy/obiektu - odpowiednik env w CI. */
export class EnvSecrets implements SecretsPort {
  private readonly values: Map<string, string>;

  constructor(values: Map<string, string> | Record<string, string> = {}) {
    this.values =
      values instanceof Map ? new Map(values) : new Map(Object.entries(values));
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
  }
}
