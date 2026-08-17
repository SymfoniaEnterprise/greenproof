/**
 * greenproof clean - twarda retencja: tylko case'y released, domyślnie bez
 * ledgera/speca/proofa (ślad audytowy), purge/dryRun jawnie.
 */
import { describe, expect, it } from 'vitest';
import { makeFakePorts } from '@greenproof/testing';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import { runFilter } from '../src/steps/filter.js';
import { runClean, ArtifactDeleteUnsupportedError } from '../src/steps/clean.js';
import { transitionCase } from '../src/machine/pipeline.js';
import type { NormalizedPlan } from '../src/domain/plan.js';

const plan: NormalizedPlan = {
  slug: 'cl',
  cases: [
    { caseId: 'C-REL', title: 'a', level: 'e2e', priority: 'P1', requirements: [], flows: [], type: 't' },
    { caseId: 'C-DEL', title: 'b', level: 'e2e', priority: 'P1', requirements: [], flows: [], type: 't' },
  ],
};

const config = GreenproofConfigSchema.parse({
  platform: 'fake',
  plan: { source: 'json' },
  model: { authTokenEnv: 'T', author: 'm' },
  paths: { testsRepoDir: '/tmp/x' },
});

async function setup(opts: { allReleased?: boolean } = {}) {
  const f = makeFakePorts();
  f.scm.seedBranch('main', {});
  await runFilter(f.ports, config, { runId: 'r-cl', envUrl: 'http://127.0.0.1:9', ref: 'main', runRef: 'x', plan });

  // C-REL przechodzi do released; C-DEL zostaje delivered (albo released przy allReleased).
  const st = await f.state.load('r-cl');
  st!.state.fixturesRef = 'greenproof/fixtures/r-cl';
  for (const [id, target] of [
    ['C-REL', 'released'],
    ['C-DEL', opts.allReleased ? 'released' : 'delivered'],
  ] as const) {
    transitionCase(st!.state, id, 'triaged');
    transitionCase(st!.state, id, 'authoring', { branch: `author/${id}` });
    transitionCase(st!.state, id, 'proving');
    transitionCase(st!.state, id, 'delivered');
    if (target === 'released') {
      transitionCase(st!.state, id, 'in_review');
      transitionCase(st!.state, id, 'accepted');
      transitionCase(st!.state, id, 'released');
    }
  }
  await f.state.save('r-cl', st!.state, st!.version);

  for (const branch of ['author/C-REL', 'author/C-DEL', 'greenproof/fixtures/r-cl', 'greenproof/fixtures-failed/r-cl/t']) {
    f.scm.seedBranch(branch, {});
  }

  for (const id of ['C-REL', 'C-DEL']) {
    await f.artifacts.putText('r-cl', `cases/${id}/context.json`, '{}');
    await f.artifacts.putText('r-cl', `cases/${id}/extra-inventory.json`, '{}');
    await f.artifacts.putText('r-cl', `cases/${id}/attempt-1.messages.jsonl`, '{}');
    await f.artifacts.putText('r-cl', `cases/${id}/ledger.jsonl`, '{}');
    await f.artifacts.putText('r-cl', `cases/${id}/draft-spec.ts`, '// spec');
    await f.artifacts.putText('r-cl', `cases/${id}/proof.json`, '{}');
  }
  return f;
}

describe('runClean', () => {
  it('released: czyści odtwarzalne, zostawia ledger/spec/proof; delivered nietknięty', async () => {
    const f = await setup();
    const res = await runClean(f.ports, { runId: 'r-cl' });

    expect(res.deleted).toEqual([
      'cases/C-REL/attempt-1.messages.jsonl',
      'cases/C-REL/context.json',
      'cases/C-REL/extra-inventory.json',
    ]);
    expect(res.kept).toEqual([
      { caseId: 'C-DEL', status: 'delivered', reason: expect.stringMatching(/release/) },
    ]);
    expect(await f.artifacts.list('r-cl', 'cases/C-REL/')).toEqual([
      'cases/C-REL/draft-spec.ts',
      'cases/C-REL/ledger.jsonl',
      'cases/C-REL/proof.json',
    ]);
    expect(await f.artifacts.list('r-cl', 'cases/C-DEL/')).toHaveLength(6);
  });

  it('purge usuwa wszystko z released', async () => {
    const f = await setup();
    const res = await runClean(f.ports, { runId: 'r-cl', purge: true });
    expect(res.deleted).toHaveLength(6);
    expect(await f.artifacts.list('r-cl', 'cases/C-REL/')).toEqual([]);
  });

  it('dryRun niczego nie usuwa, ale raportuje', async () => {
    const f = await setup();
    const res = await runClean(f.ports, { runId: 'r-cl', dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.deleted).toHaveLength(3);
    expect(await f.artifacts.list('r-cl', 'cases/C-REL/')).toHaveLength(6);
  });

  it('store bez delete → typowany błąd (retencją rządzi platforma)', async () => {
    const f = await setup();
    // Symulacja adaptera bez delete (np. GitHub Artifacts).
    const stripped = Object.create(f.artifacts) as typeof f.artifacts;
    Object.defineProperty(stripped, 'delete', { value: undefined });
    const ports = { ...f.ports, artifacts: stripped };
    await expect(runClean(ports, { runId: 'r-cl' })).rejects.toThrow(ArtifactDeleteUnsupportedError);
  });

  it('branche: released znika, delivered zostaje; fixturesRef chroniony przy runie w toku', async () => {
    const f = await setup();
    const res = await runClean(f.ports, { runId: 'r-cl' });

    expect(res.deletedBranches).toEqual(['author/C-REL']);
    expect(f.scm.hasBranch('author/C-REL')).toBe(false);
    expect(f.scm.hasBranch('author/C-DEL')).toBe(true);
    // C-DEL wciąż żyje - warstwa fixtures musi zostać jako baza jego branchy.
    expect(f.scm.hasBranch('greenproof/fixtures/r-cl')).toBe(true);
    expect(res.branchNote).toMatch(/niedokończone case'y/);
  });

  it('run terminalny: fixturesRef znika, bocznice fixtures-failed dopiero z purge', async () => {
    const f = await setup({ allReleased: true });
    const res = await runClean(f.ports, { runId: 'r-cl' });

    expect(res.deletedBranches).toEqual(['author/C-DEL', 'author/C-REL', 'greenproof/fixtures/r-cl']);
    expect(f.scm.hasBranch('greenproof/fixtures-failed/r-cl/t')).toBe(true);

    const purged = await runClean(f.ports, { runId: 'r-cl', purge: true });
    expect(purged.deletedBranches).toContain('greenproof/fixtures-failed/r-cl/t');
    expect(f.scm.hasBranch('greenproof/fixtures-failed/r-cl/t')).toBe(false);
  });

  it('branches:false i dryRun nie ruszają branchy; port bez deleteBranch → branchNote', async () => {
    const off = await setup({ allReleased: true });
    const resOff = await runClean(off.ports, { runId: 'r-cl', branches: false });
    expect(resOff.deletedBranches).toEqual([]);
    expect(off.scm.hasBranch('author/C-REL')).toBe(true);

    const dry = await setup({ allReleased: true });
    const resDry = await runClean(dry.ports, { runId: 'r-cl', dryRun: true });
    expect(resDry.deletedBranches).toContain('author/C-REL');
    expect(dry.scm.hasBranch('author/C-REL')).toBe(true);

    const noDel = await setup({ allReleased: true });
    (noDel.ports.scm as { deleteBranch?: unknown }).deleteBranch = undefined;
    const resNoDel = await runClean(noDel.ports, { runId: 'r-cl' });
    expect(resNoDel.deletedBranches).toEqual([]);
    expect(resNoDel.branchNote).toMatch(/deleteBranch/);
  });
});
