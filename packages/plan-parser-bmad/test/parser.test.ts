import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PlanParseError } from '@greenproof/core';
import bmadTeaPlanSource, { parseWithDiagnostics } from '../src/index.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Numer linii (1-based) pierwszego/ostatniego wystąpienia fragmentu. */
function lineOf(text: string, needle: string, last = false): number {
  const lines = text.split('\n');
  const index = last
    ? lines.map((l) => l.includes(needle)).lastIndexOf(true)
    : lines.findIndex((l) => l.includes(needle));
  return index + 1;
}

describe('bmad-tea plan source', () => {
  it('eksponuje format bmad-tea', () => {
    expect(bmadTeaPlanSource.format).toBe('bmad-tea');
  });

  it('parsuje kanoniczny dokument z dwóch tabel', () => {
    const raw = fixture('canonical.md');
    const plan = bmadTeaPlanSource.parse(raw, { path: 'docs/qa/whatever/test-design.md' });

    expect(plan.slug).toBe('aneks-ubezpieczenia');
    expect(plan.source).toEqual({ format: 'bmad-tea', path: 'docs/qa/whatever/test-design.md' });
    expect(plan.cases.map((c) => c.caseId)).toEqual([
      '3.2-E2E-019',
      '3.2-UNIT-004',
      '1.1-INT-002',
      '1.1-INTEGRATION-003',
    ]);

    expect(plan.cases[0]).toEqual({
      caseId: '3.2-E2E-019',
      title: 'Dodanie aneksu ubezpieczenia z poziomu listy',
      level: 'e2e',
      priority: 'P0',
      requirements: ['AC-1', 'AC-2'],
      flows: ['contract/annex', 'insurance/add'],
      type: 'aneks',
    });

    // Escapowany pipe trafia do tytułu jako zwykły znak; brak Flow/Type.
    expect(plan.cases[1]).toEqual({
      caseId: '3.2-UNIT-004',
      title: 'Walidacja daty obowiązywania | granice zakresu',
      level: 'unit',
      priority: 'P1',
      requirements: ['AC-3'],
      flows: [],
    });
    expect(plan.cases[1]?.type).toBeUndefined();

    // Druga tabela: polskie nagłówki kolumn.
    expect(plan.cases[2]).toEqual({
      caseId: '1.1-INT-002',
      title: 'Import listy płac z pliku',
      level: 'integration',
      priority: 'P2',
      requirements: ['AC-4'],
      flows: ['payroll/import'],
      type: 'lista płac',
    });

    // Brak opisu i wymogu → tytułem zostaje caseId.
    expect(plan.cases[3]).toEqual({
      caseId: '1.1-INTEGRATION-003',
      title: '1.1-INTEGRATION-003',
      level: 'integration',
      priority: 'P3',
      requirements: [],
      flows: [],
    });

    // Sekcja Quality Gate Criteria jest ignorowana mimo kolumn ID/Priority.
    expect(plan.cases.some((c) => c.caseId === '9.9-E2E-999')).toBe(false);
    expect(lineOf(raw, '9.9-E2E-999')).toBeGreaterThan(0);
  });

  it('poziom z ID wygrywa z kolumną Level (z ostrzeżeniem)', () => {
    const { plan, warnings } = parseWithDiagnostics(fixture('canonical.md'));
    const int = plan.cases.find((c) => c.caseId === '1.1-INT-002');
    expect(int?.level).toBe('integration');
    expect(warnings.some((w) => w.includes('1.1-INT-002') && w.includes('integration'))).toBe(true);
  });

  it('pomija wiersze spoza macierzy z ostrzeżeniem', () => {
    const raw = fixture('canonical.md');
    const { warnings } = parseWithDiagnostics(raw);
    const skipped = warnings.find((w) => w.includes('TBD-1'));
    expect(skipped).toBeDefined();
    expect(skipped).toContain(`linii ${lineOf(raw, '| TBD-1 |')}`);
  });

  it('parse() z PlanSource odrzuca ostrzeżenia', () => {
    const plan = bmadTeaPlanSource.parse(fixture('canonical.md'));
    expect(Object.keys(plan)).toEqual(['slug', 'cases', 'source']);
    expect(plan.source).toEqual({ format: 'bmad-tea' });
  });

  it('obsługuje macierz o minimalnym zestawie kolumn i slug ze ścieżki', () => {
    const plan = bmadTeaPlanSource.parse(fixture('minimal.md'), {
      path: 'docs/qa/lista-plac/test-design.md',
    });

    expect(plan.slug).toBe('lista-plac');
    expect(plan.cases).toEqual([
      {
        caseId: '2.4-E2E-001',
        title: 'AC-1',
        level: 'e2e',
        priority: 'P0',
        requirements: ['AC-1'],
        flows: [],
      },
      {
        caseId: '2.4-UNIT-002',
        title: 'AC-2',
        level: 'unit',
        priority: 'P1',
        requirements: ['AC-2'],
        flows: [],
      },
    ]);
  });

  it('duplikat caseId → PlanParseError z numerem linii', () => {
    const raw = fixture('duplicate-id.md');
    const duplicateLine = lineOf(raw, '5.1-E2E-001', true);

    try {
      bmadTeaPlanSource.parse(raw, { path: 'test-design.md' });
      expect.unreachable('oczekiwano PlanParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanParseError);
      const e = err as PlanParseError;
      expect(e.message).toContain('5.1-E2E-001');
      expect(e.details).toEqual({ path: 'test-design.md', line: duplicateLine });
    }
  });

  it('brak macierzy → PlanParseError (Quality Gate nie jest macierzą)', () => {
    expect(() => bmadTeaPlanSource.parse(fixture('no-matrix.md'))).toThrow(PlanParseError);
    expect(() => bmadTeaPlanSource.parse(fixture('no-matrix.md'))).toThrow(/macierzy pokrycia/i);
  });

  it('brak priorytetu → PlanParseError z numerem linii', () => {
    const doc = ['# Test Design: Brak Priorytetu', '', '| ID | AC | Priority |', '| --- | --- | --- |', '| 4.1-E2E-001 | AC-1 |  |', ''].join('\n');
    try {
      parseWithDiagnostics(doc);
      expect.unreachable('oczekiwano PlanParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanParseError);
      expect((err as PlanParseError).details?.line).toBe(5);
      expect((err as PlanParseError).message).toMatch(/priorytet/i);
    }
  });
});
