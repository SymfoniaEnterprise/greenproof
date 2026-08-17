import { describe, expect, it } from 'vitest';
import { FixedClock } from '@greenproof/testing';
import {
  bumpReuse,
  HarvestValidationError,
  matchInventory,
  mergeIndexes,
  unionIndexes,
  upsertEntry,
} from '../src/harvest/inventory.js';
import { findSelectorDuplication } from '../src/harvest/lint.js';
import type { PomIndex } from '../src/domain/harvest.js';
import type { PlanCase } from '../src/domain/plan.js';

const clock = new FixedClock(new Date('2026-08-14T10:00:00Z'));

const index: PomIndex = {
  version: 1,
  entries: [
    {
      name: 'PayrollPage',
      path: 'tests/support/pom/payroll.page.ts',
      kind: 'pom',
      description: 'Lista płac',
      covers: ['payroll'],
      keySelectors: ["getByTestId('payroll-create')"],
      reuseCount: 2,
      addedAt: '2026-08-01T00:00:00Z',
    },
    {
      name: 'AnnexPage',
      path: 'tests/support/pom/annex.page.ts',
      kind: 'pom',
      description: 'Aneks',
      covers: ['contract/annex'],
      keySelectors: [],
      reuseCount: 0,
      addedAt: '2026-08-01T00:00:00Z',
    },
  ],
};

function planCase(flows: string[]): PlanCase {
  return { caseId: 'C-1', title: 't', level: 'e2e', priority: 'P1', requirements: [], flows };
}

describe('matchInventory', () => {
  it('dopasowuje dokładnie i hierarchicznie (payroll pokrywa payroll/create)', () => {
    expect(matchInventory(index, planCase(['payroll/create'])).map((e) => e.name)).toEqual(['PayrollPage']);
    expect(matchInventory(index, planCase(['contract'])).map((e) => e.name)).toEqual(['AnnexPage']);
    expect(matchInventory(index, planCase(['insurance']))).toEqual([]);
  });
});

describe('upsertEntry', () => {
  const input = {
    name: 'NewPage',
    path: 'tests/support/pom/new.page.ts',
    kind: 'pom' as const,
    description: 'x',
    covers: ['a'],
    keySelectors: [],
    harvestedBy: 'C-9',
  };

  it('dodaje wpis z zerowym reuse i datą z zegara', () => {
    const out = upsertEntry(index, input, clock);
    const added = out.entries.find((e) => e.name === 'NewPage')!;
    expect(added.reuseCount).toBe(0);
    expect(added.addedAt).toBe('2026-08-14T10:00:00.000Z');
    expect(index.entries).toHaveLength(2); // czysta funkcja
  });

  it('aktualizacja zachowuje reuseCount i addedAt', () => {
    const out = upsertEntry(index, { ...input, name: 'PayrollPage', description: 'nowy opis' }, clock);
    const updated = out.entries.find((e) => e.name === 'PayrollPage')!;
    expect(updated.reuseCount).toBe(2);
    expect(updated.addedAt).toBe('2026-08-01T00:00:00Z');
    expect(updated.description).toBe('nowy opis');
  });

  it('wymaga covers i poprawnej nazwy', () => {
    expect(() => upsertEntry(index, { ...input, covers: [] }, clock)).toThrow(HarvestValidationError);
    expect(() => upsertEntry(index, { ...input, name: '../zle' }, clock)).toThrow(HarvestValidationError);
  });
});

describe('mergeIndexes / bumpReuse', () => {
  it('merge po nazwie: nowe wpisy z obu stron, liczniki sumowane od bazy', () => {
    const ours = bumpReuse(index, ['PayrollPage']); // 2 -> 3
    const theirs = upsertEntry(bumpReuse(index, ['PayrollPage']), // 2 -> 3
      { name: 'TheirPage', path: 'p.ts', kind: 'pom', description: 'x', covers: ['t'], keySelectors: [], harvestedBy: 'C' },
      clock,
    );
    const merged = mergeIndexes(index, ours, theirs);
    expect(merged.entries.find((e) => e.name === 'PayrollPage')!.reuseCount).toBe(4); // 2 + 1 + 1
    expect(merged.entries.map((e) => e.name)).toContain('TheirPage');
  });
});

describe('unionIndexes', () => {
  it('unia po nazwie: wpis świeższy (fixtures) wygrywa konflikt, bazowy zostaje', () => {
    const fresh = upsertEntry(
      { version: 1, entries: [] },
      {
        name: 'PayrollPage', path: 'tests/support/pom/payroll.v2.page.ts', kind: 'pom',
        description: 'nowy opis', covers: ['payroll'], keySelectors: [], harvestedBy: 'C-2',
      },
      clock,
    );
    const out = unionIndexes(fresh, index);
    const payroll = out.entries.find((e) => e.name === 'PayrollPage')!;
    expect(payroll.path).toBe('tests/support/pom/payroll.v2.page.ts'); // wygrywa świeższy
    expect(out.entries.map((e) => e.name)).toContain('AnnexPage'); // bazowy wpis zachowany
  });

  it('pusty świeży indeks (brak indeksu na branchu fixtures) nie gubi bazowego inwentarza', () => {
    const out = unionIndexes({ version: 1, entries: [] }, index);
    expect(out.entries.map((e) => e.name)).toEqual(['PayrollPage', 'AnnexPage']);
  });
});

describe('lint anty-duplikacji', () => {
  it('łapie surowy selektor z POM, ignoruje importy i krótkie selektory', () => {
    const spec = [
      "import { PayrollPage } from '../support/pom/payroll.page.ts';",
      "await page.getByTestId('payroll-create').click();",
    ].join('\n');
    const findings = findSelectorDuplication('x.spec.ts', spec, index);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.pomName).toBe('PayrollPage');
  });

  it('spec używający POM przechodzi czysto', () => {
    const spec = [
      "import { PayrollPage } from '../support/pom/payroll.page.ts';",
      'await new PayrollPage(page).create();',
    ].join('\n');
    expect(findSelectorDuplication('x.spec.ts', spec, index)).toHaveLength(0);
  });
});
