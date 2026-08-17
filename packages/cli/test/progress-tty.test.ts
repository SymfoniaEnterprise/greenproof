/** Renderer TTY: treść tablicy, throttle przerysowań, NO_COLOR, printAbove. */
import { describe, expect, it } from 'vitest';
import type {
  CaseEndProgressEvent,
  CaseStartProgressEvent,
  PlaywrightRunProgressEvent,
  ProgressPlaywright,
  RunRollup,
  TurnProgressEvent,
} from '@greenproof/core';
import { createTtyRenderer } from '../src/progress/tty.js';
import type { RendererIo } from '../src/progress/types.js';

const RUN_ID = 'gp-bench-deepseek-20260815T10';

/** Bufor + przesuwalny zegar - testy nie dotykają prawdziwego stderr ani czasu. */
function makeIo(env: Record<string, string | undefined> = {}): {
  io: RendererIo;
  buf: () => string;
  tick: (ms: number) => void;
} {
  const chunks: string[] = [];
  let ms = 0;
  return {
    io: {
      write: (chunk) => {
        chunks.push(chunk);
      },
      env,
      isTTY: true,
      now: () => new Date(ms),
    },
    buf: () => chunks.join(''),
    tick: (delta) => {
      ms += delta;
    },
  };
}

const ROLLUP: RunRollup = {
  total: 10,
  byStatus: { delivered: 3, blocked: 1 },
  done: 4,
  remaining: 6,
  passed: 3,
  failed: 1,
  skipped: 0,
  costUsd: 1.84,
  turns: 212,
};

const PW: ProgressPlaywright = {
  assertUsed: 3,
  assertMax: 6,
  proofUsed: 0,
  proofMax: 4,
  greenRuns: 1,
};

function caseStart(): CaseStartProgressEvent {
  return {
    kind: 'case-start',
    runId: RUN_ID,
    at: '2026-08-15T10:00:00.000Z',
    caseId: 'UC-3',
    attempt: 2,
    model: 'deepseek-chat',
    caps: {
      maxTurns: 1000,
      maxTimeMinutes: 30,
      maxCostUsd: 6,
      maxPlaywrightRuns: 6,
      proofRuns: 4,
    },
    rollup: ROLLUP,
  };
}

function turn(over: Partial<TurnProgressEvent> = {}): TurnProgressEvent {
  return {
    kind: 'turn',
    runId: RUN_ID,
    at: '2026-08-15T10:06:12.000Z',
    caseId: 'UC-3',
    attempt: 2,
    phase: 'assert',
    turns: 14,
    maxTurns: 1000,
    elapsedSec: 372,
    maxTimeSec: 1800,
    costUsd: 0.42,
    maxCostUsd: 6,
    pw: PW,
    ...over,
  };
}

function playwrightRun(): PlaywrightRunProgressEvent {
  return {
    kind: 'playwright-run',
    runId: RUN_ID,
    at: '2026-08-15T10:06:30.000Z',
    caseId: 'UC-3',
    attempt: 2,
    runIndex: 3,
    purpose: 'assert-check',
    pool: 'assert',
    passed: 5,
    failed: 1,
    total: 6,
    pw: PW,
  };
}

function caseEnd(over: Partial<CaseEndProgressEvent> = {}): CaseEndProgressEvent {
  return {
    kind: 'case-end',
    runId: RUN_ID,
    at: '2026-08-15T10:07:00.000Z',
    caseId: 'UC-3',
    attempt: 2,
    status: 'delivered',
    costUsd: 0.42,
    turns: 14,
    rollup: { ...ROLLUP, passed: 4, done: 5, remaining: 5 },
    ...over,
  };
}

/** Ile razy tablica trafiła do bufora (każde rysowanie ma dokładnie jedną taką linię). */
function ileTablic(buf: string): number {
  return buf.split(' przypadki: ').length - 1;
}

describe('createTtyRenderer - tablica statusu', () => {
  it('pokazuje run, sesję, pule playwright i liczniki, a finalize oddaje kursor', () => {
    const { io, buf, tick } = makeIo();
    const r = createTtyRenderer(io);

    r.onEvent(caseStart());
    tick(300);
    r.onEvent(turn());
    tick(300);
    r.onEvent(playwrightRun());
    tick(300);
    r.onEvent(caseEnd());
    r.finalize();

    const out = buf();
    expect(out).toContain(RUN_ID);
    expect(out).toMatch(/model: .*deepseek-chat/);
    expect(out).toContain('UC-3');
    expect(out).toContain('próba 2');
    expect(out).toContain('faza: assert');
    expect(out).toContain('tury 14');
    expect(out).toContain('/1000');
    expect(out).toContain('czas 06:12');
    expect(out).toContain('/30:00');
    expect(out).toContain('$0.42');
    expect(out).toContain('assert 3/6');
    expect(out).toContain('proof 0/4');
    expect(out).toContain('green: 1');
    expect(out).toContain('run_playwright #3 (assert-check) → 5 passed / 1 failed');
    // liczniki rollup: w toku dopóki sesja żyje, po case-end już nie
    expect(out).toContain('3 ✓ dostarczone');
    expect(out).toContain('1 ✗ zablokowane');
    expect(out).toContain('1 ▶ w toku');
    expect(out).toContain('5 ○ czeka');
    expect(out).toContain('4 ✓ dostarczone');
    expect(out).toContain('koszt runu: $1.84');
    expect(out).toContain('tury łącznie: 212');
    // kursor: schowany na starcie, oddany na końcu
    expect(out).toContain('\x1b[?25l');
    expect(out.endsWith('\x1b[?25h')).toBe(true);
    // ostatnia tablica nie zawiera już bloku sesji
    expect(out.slice(out.lastIndexOf(' przypadki: '))).not.toContain('UC-3');
  });

  it('pokazuje pule playwright już od case-start, przed pierwszą turą', () => {
    // Bez kolorów: separatory ` · ` nie są wtedy owinięte w SGR i linia daje
    // się sprawdzić jednym toContain.
    const { io, buf } = makeIo({ NO_COLOR: '1' });
    const r = createTtyRenderer(io);

    r.onEvent(caseStart());

    // Capy przychodzą razem z case-start, więc linia pul jest w PIERWSZEJ
    // klatce; czekanie na pierwszy run kazałoby tablicy urosnąć w trakcie.
    expect(buf()).toContain('playwright: assert 0/6 · proof 0/4 · green: 0');
  });

  it('throttluje tury do jednej na 250 ms, ale case-start/case-end rysują zawsze', () => {
    const { io, buf, tick } = makeIo();
    const r = createTtyRenderer(io);

    r.onEvent(caseStart()); // 1. tablica (natychmiast)
    tick(300);
    r.onEvent(turn({ turns: 1 })); // 2. tablica
    tick(100);
    r.onEvent(turn({ turns: 2 })); // za wcześnie - bez przerysowania
    expect(ileTablic(buf())).toBe(2);
    expect(buf()).not.toContain('tury 2');

    tick(300);
    r.onEvent(turn({ turns: 3 })); // 3. tablica
    expect(ileTablic(buf())).toBe(3);
    expect(buf()).toContain('tury 3');

    r.onEvent(caseEnd()); // case-end omija throttle mimo 0 ms odstępu
    expect(ileTablic(buf())).toBe(4);
  });

  it('NO_COLOR=1 wyłącza kolory (żadnych sekwencji SGR)', () => {
    const { io, buf, tick } = makeIo({ NO_COLOR: '1' });
    const r = createTtyRenderer(io);

    r.onEvent(caseStart());
    tick(300);
    r.onEvent(turn());
    r.finalize();

    const out = buf();
    expect(out).toContain('UC-3');
    expect(out).not.toMatch(/\x1b\[[0-9;]*m/);
    // po odjęciu sekwencji sterowania kursorem nie zostaje żaden kod ANSI
    const bezKursora = out.replace(/\x1b\[\??[0-9]*[A-Za-z]/g, '');
    expect(bezKursora).not.toContain('\x1b[3');
    expect(bezKursora).not.toContain('\x1b[');
  });

  it('printAbove wypisuje linię nad tablicą i odrysowuje tablicę pod nią', () => {
    const { io, buf, tick } = makeIo();
    const r = createTtyRenderer(io);

    r.onEvent(caseStart());
    tick(50); // printAbove nie podlega throttlowi
    r.printAbove('greenproof warn: x');

    const out = buf();
    expect(out).toContain('greenproof warn: x\n');
    expect(ileTablic(out)).toBe(2);
    expect(out.lastIndexOf(' przypadki: ')).toBeGreaterThan(out.indexOf('greenproof warn: x'));
    // przed wypisaniem linii tablica została zdjęta z ekranu
    expect(out.slice(0, out.indexOf('greenproof warn: x'))).toContain('\x1b[0J');
  });

  it('bez TTY nie używa sekwencji kursora ani kolorów', () => {
    const { io, buf, tick } = makeIo();
    const r = createTtyRenderer({ ...io, isTTY: false });

    r.onEvent(caseStart());
    tick(300);
    r.onEvent(turn());
    r.finalize();

    const out = buf();
    expect(out).toContain('UC-3');
    expect(out).not.toContain('\x1b[');
  });

  it('kroki bez sesji pokazują pojedynczą linię, a onEvent nie rzuca na śmieciach', () => {
    const { io, buf } = makeIo();
    const r = createTtyRenderer(io);

    r.onEvent({ kind: 'step', runId: RUN_ID, at: '2026-08-15T10:00:00.000Z', name: 'triage', phase: 'start' });
    expect(buf()).toContain('krok triage…');

    // zdarzenia sesji bez case-start są ignorowane, ale nic nie wybucha
    expect(() => r.onEvent(turn())).not.toThrow();
    expect(() => r.onEvent(playwrightRun())).not.toThrow();
    r.finalize();
  });

  it('uzupełnia runId, gdy pierwszy krok zaczął się przed jego wygenerowaniem', () => {
    const { io, buf } = makeIo();
    const r = createTtyRenderer(io);

    r.onEvent({ kind: 'step', runId: '', at: '2026-08-15T10:00:00.000Z', name: 'run', phase: 'start' });
    r.onEvent(caseStart());

    const lastTable = buf().slice(buf().lastIndexOf('greenproof'));
    expect(lastTable).toContain(RUN_ID);
  });

  it('po case-end z blocked pokazuje minę końcową (⌜◔◕⌝), a nie idle (⌜◉◉⌝)', () => {
    const { io, buf } = makeIo();
    const r = createTtyRenderer(io);

    r.onEvent(caseStart());
    r.onEvent(caseEnd({ status: 'blocked' }));

    // Ostatnia tablica (już bez sesji) musi trzymać minę blocked, nie idle.
    // Awatar stoi w nagłówku (pierwsza linia), stąd szukamy od ostatniego `⌜`.
    const ostatniAwatar = buf().slice(buf().lastIndexOf('⌜'));
    expect(ostatniAwatar).toMatch(/^⌜◔◕⌝/);
    expect(ostatniAwatar).not.toMatch(/^⌜◉◉⌝/);
  });
});
