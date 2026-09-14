/**
 * authoring.branchStrategy - opcja gałęzi autora: 'per-case' (domyślnie, gałąź
 * author/<caseId>) vs 'single' (jedna wspólna gałąź author/<slug> na cały run).
 * Pokrywa: default configu (prefault), resolveAuthorBranch, filter (wspólna vs
 * per-case gałąź + dedup draftu), clean (guard wspólnej gałęzi) i accept
 * (jeden PR na run + runPrUrl).
 */
import { describe, expect, it } from 'vitest';
import { makeFakePorts } from '@greenproof/testing';
import { DEFAULT_CONFIG } from '../src/config/types.js';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import { runFilter, resolveAuthorBranch } from '../src/steps/filter.js';
import { runClean } from '../src/steps/clean.js';
import { runAccept } from '../src/steps/accept.js';
import { transitionCase } from '../src/machine/pipeline.js';
import type { PipelineState, CaseStatus } from '../src/domain/state.js';
import type { NormalizedPlan } from '../src/domain/plan.js';

const base = {
  platform: 'fake',
  plan: { source: 'json' },
  model: { authTokenEnv: 'T', author: 'm' },
  paths: { testsRepoDir: '/tmp/x' },
} as const;

// per-case = domyślnie (bez klucza authoring); single = jawnie przełączone.
const perCase = GreenproofConfigSchema.parse(base);
const single = GreenproofConfigSchema.parse({ ...base, authoring: { branchStrategy: 'single' } });

const SLUG = 'dodawanie-pracownika';
const BRANCH_SINGLE = `author/${SLUG}`;

const plan: NormalizedPlan = {
  slug: SLUG,
  cases: [
    { caseId: 'E2E-001', title: 'a', level: 'e2e', priority: 'P0', requirements: [], flows: [] },
    { caseId: 'E2E-002', title: 'b', level: 'e2e', priority: 'P1', requirements: [], flows: [] },
    { caseId: 'E2E-003', title: 'c', level: 'e2e', priority: 'P1', requirements: [], flows: [] },
  ],
};

const FILTER_BASE = { envUrl: 'http://127.0.0.1:9', ref: 'main', runRef: 'x' } as const;

function selectedBranches(state: PipelineState): string[] {
  return Object.values(state.cases)
    .filter((c) => c.status === 'selected')
    .map((c) => c.branch as string);
}

/** Przeprowadź case przez łańcuch przejść (gałąź z filtra zostaje - patch scala). */
function advance(state: PipelineState, id: string, to: CaseStatus): void {
  const chain: CaseStatus[] = ['triaged', 'authoring', 'proving', 'delivered', 'in_review', 'accepted', 'released'];
  for (const step of chain) {
    transitionCase(state, id, step);
    if (step === to) return;
  }
}

describe('authoring.branchStrategy', () => {
  describe('config default (prefault)', () => {
    it('brak klucza authoring → per-case/author/ (jak DEFAULT_CONFIG)', () => {
      expect(perCase.authoring).toEqual({ branchStrategy: 'per-case', branchPrefix: 'author/' });
      expect(perCase.authoring).toEqual(DEFAULT_CONFIG.authoring);
    });

    it('single dziedziczy domyślny prefiks author/', () => {
      expect(single.authoring).toEqual({ branchStrategy: 'single', branchPrefix: 'author/' });
    });
  });

  describe('resolveAuthorBranch', () => {
    it('per-case → author/<caseId>, single → author/<slug> niezależnie od case\'a', () => {
      expect(resolveAuthorBranch(perCase, 'E2E-001', SLUG)).toBe('author/E2E-001');
      expect(resolveAuthorBranch(perCase, 'E2E-002', SLUG)).toBe('author/E2E-002');
      expect(resolveAuthorBranch(single, 'E2E-001', SLUG)).toBe(BRANCH_SINGLE);
      expect(resolveAuthorBranch(single, 'E2E-002', SLUG)).toBe(BRANCH_SINGLE);
    });

    it('sanityzuje niebezpieczne znaki w kluczu gałęzi', () => {
      expect(resolveAuthorBranch(single, 'x', 'a/b c')).toBe('author/a_b_c');
    });
  });

  describe('filter', () => {
    it('single → wszystkie wybrane case\'y dzielą jedną gałąź author/<slug>', async () => {
      const f = makeFakePorts();
      f.scm.seedBranch('main', {});
      await runFilter(f.ports, single, { ...FILTER_BASE, runId: 'r-s', plan });
      const st = await f.state.load('r-s');
      const branches = selectedBranches(st!.state);
      expect(branches).toHaveLength(3);
      expect(new Set(branches)).toEqual(new Set([BRANCH_SINGLE]));
    });

    it('per-case (domyślnie) → author/<caseId> per case (regresja)', async () => {
      const f = makeFakePorts();
      f.scm.seedBranch('main', {});
      await runFilter(f.ports, perCase, { ...FILTER_BASE, runId: 'r-p', plan });
      const st = await f.state.load('r-p');
      expect(st!.state.cases['E2E-001']!.branch).toBe('author/E2E-001');
      expect(st!.state.cases['E2E-002']!.branch).toBe('author/E2E-002');
      expect(st!.state.cases['E2E-003']!.branch).toBe('author/E2E-003');
    });

    it('single → dedup po caseId: case z draftem na wspólnej gałęzi skipped, reszta selected', async () => {
      const f = makeFakePorts();
      f.scm.seedBranch('main', {});
      // Wspólna gałąź ma już draft TYLKO case'a #1 (jego caseId w nazwie pliku).
      f.scm.seedBranch(BRANCH_SINGLE, { 'tests/e2e/E2E-001-dodaj.spec.ts': '// spec' });
      const out = await runFilter(f.ports, single, { ...FILTER_BASE, runId: 'r-d', plan });
      expect(out.selected.sort()).toEqual(['E2E-002', 'E2E-003']);
      expect(out.skipped).toEqual(['E2E-001']);
    });
  });

  describe('clean - guard wspólnej gałęzi', () => {
    async function seedRun(): Promise<ReturnType<typeof makeFakePorts>> {
      const f = makeFakePorts();
      f.scm.seedBranch('main', {});
      f.scm.seedBranch(BRANCH_SINGLE, {});
      await runFilter(f.ports, single, { ...FILTER_BASE, runId: 'r-cl', plan });
      return f;
    }

    it('część case\'ów released, jeden delivered → wspólna gałąź NIE usunięta', async () => {
      const f = await seedRun();
      const st = await f.state.load('r-cl');
      advance(st!.state, 'E2E-001', 'released');
      advance(st!.state, 'E2E-002', 'released');
      advance(st!.state, 'E2E-003', 'delivered'); // nieterminalny → wspólna gałąź w użyciu
      await f.state.save('r-cl', st!.state, st!.version);

      const res = await runClean(f.ports, { runId: 'r-cl' });
      expect(res.deletedBranches).not.toContain(BRANCH_SINGLE);
      expect(f.scm.hasBranch(BRANCH_SINGLE)).toBe(true);
    });

    it('run terminalny → wspólna gałąź usunięta DOKŁADNIE raz (dedup)', async () => {
      const f = await seedRun();
      const st = await f.state.load('r-cl');
      advance(st!.state, 'E2E-001', 'released');
      advance(st!.state, 'E2E-002', 'released');
      advance(st!.state, 'E2E-003', 'released');
      await f.state.save('r-cl', st!.state, st!.version);

      const res = await runClean(f.ports, { runId: 'r-cl' });
      expect(res.deletedBranches.filter((b) => b === BRANCH_SINGLE)).toHaveLength(1);
      expect(f.scm.hasBranch(BRANCH_SINGLE)).toBe(false);
    });
  });

  describe('accept - jeden PR na run', () => {
    /** Zlicz wywołania openPullRequest (guard 'single' ma otworzyć PR tylko raz). */
    function countPr(f: ReturnType<typeof makeFakePorts>): () => number {
      let n = 0;
      const orig = f.ports.scm.openPullRequest.bind(f.ports.scm);
      f.ports.scm.openPullRequest = async (p) => {
        n += 1;
        return orig(p);
      };
      return () => n;
    }

    async function prepareInReview(
      f: ReturnType<typeof makeFakePorts>,
      config: typeof single,
      runId: string,
    ): Promise<void> {
      f.scm.seedBranch('main', {});
      await runFilter(f.ports, config, { ...FILTER_BASE, runId, plan });
      const st = await f.state.load(runId);
      for (const id of ['E2E-001', 'E2E-002', 'E2E-003']) advance(st!.state, id, 'in_review');
      await f.state.save(runId, st!.state, st!.version);
    }

    it('single → openPullRequest raz, ten sam url, runPrUrl zapisany, tytuł batch', async () => {
      const f = makeFakePorts();
      const prCalls = countPr(f);
      await prepareInReview(f, single, 'r-as');

      const urls: string[] = [];
      for (const id of ['E2E-001', 'E2E-002', 'E2E-003']) {
        const r = await runAccept(f.ports, single, { runId: 'r-as', caseId: id, targetBranch: 'main' });
        urls.push(r.prUrl);
      }

      expect(prCalls()).toBe(1);
      expect(new Set(urls)).toEqual(new Set([urls[0]]));
      expect(f.scm.pullRequests).toHaveLength(1);
      expect(f.scm.pullRequests[0]!.from).toBe(BRANCH_SINGLE);
      expect(f.scm.pullRequests[0]!.title).toContain(SLUG);
      expect(f.scm.pullRequests[0]!.title).toContain('batch');

      const st = await f.state.load('r-as');
      expect(st!.state.runPrUrl).toBe(urls[0]);
      for (const id of ['E2E-001', 'E2E-002', 'E2E-003']) {
        expect(st!.state.cases[id]!.status).toBe('accepted');
      }
    });

    it('per-case (regresja) → PR per case, brak runPrUrl', async () => {
      const f = makeFakePorts();
      const prCalls = countPr(f);
      await prepareInReview(f, perCase, 'r-ap');

      for (const id of ['E2E-001', 'E2E-002', 'E2E-003']) {
        await runAccept(f.ports, perCase, { runId: 'r-ap', caseId: id, targetBranch: 'main' });
      }

      expect(prCalls()).toBe(3);
      expect(f.scm.pullRequests).toHaveLength(3);
      expect(f.scm.pullRequests.map((p) => p.title).sort()).toEqual([
        'test(e2e): E2E-001',
        'test(e2e): E2E-002',
        'test(e2e): E2E-003',
      ]);
      const st = await f.state.load('r-ap');
      expect(st!.state.runPrUrl).toBeUndefined();
    });
  });
});
