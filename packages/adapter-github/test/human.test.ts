import type { HumanReport } from '@greenproof/core';
import { describe, expect, it } from 'vitest';
import { GithubHumanChannel, reportMarker } from '../src/index.js';
import { FakeOctokit, fakeLogger } from './fake-octokit.js';

function makeReport(overrides: Partial<HumanReport> = {}): HumanReport {
  return {
    kind: 'draft_delivered',
    title: 'Draft dostarczony: case-1',
    markdown: 'PR: https://github.com/acme/tests/pull/1\n',
    data: { caseId: 'case-1', attempts: 2 },
    reportId: 'run-1:case-1:draft_delivered',
    ...overrides,
  };
}

function setup(pageSize?: number): { fake: FakeOctokit; human: GithubHumanChannel } {
  const fake = new FakeOctokit();
  return {
    fake,
    human: new GithubHumanChannel({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
      ...(pageSize === undefined ? {} : { commentsPageSize: pageSize }),
    }),
  };
}

describe('GithubHumanChannel.postReport', () => {
  it('tworzy komentarz, a przy tym samym reportId aktualizuje istniejący', async () => {
    const { fake, human } = setup();
    const report = makeReport();
    await human.postReport('42', report);

    let bodies = fake.commentBodies(42);
    expect(bodies).toHaveLength(1);
    const first = bodies[0] as string;
    expect(first.startsWith(reportMarker(report.reportId))).toBe(true);
    expect(first).toContain('## Draft dostarczony: case-1');
    expect(first).toContain('PR: https://github.com/acme/tests/pull/1');
    expect(first).toContain('<details>');
    expect(first).toContain('"caseId": "case-1"');

    await human.postReport('42', makeReport({ markdown: 'Zaktualizowany opis\n' }));
    bodies = fake.commentBodies(42);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('Zaktualizowany opis');
    expect(fake.callCount('issues.updateComment')).toBe(1);
    expect(fake.callCount('issues.createComment')).toBe(1);
  });

  it('inny reportId to osobny komentarz', async () => {
    const { fake, human } = setup();
    await human.postReport('42', makeReport());
    await human.postReport('42', makeReport({ reportId: 'run-1:case-2:draft_delivered' }));
    expect(fake.commentBodies(42)).toHaveLength(2);
  });

  it('przechodzi przez wszystkie strony komentarzy', async () => {
    const { fake, human } = setup(2);
    const report = makeReport();
    fake.seedComment(42, 'szum 1');
    fake.seedComment(42, 'szum 2');
    const target = fake.seedComment(42, `${reportMarker(report.reportId)}\n## stara wersja`);
    fake.seedComment(42, 'szum 3');

    await human.postReport('42', report);

    // Marker leżał na drugiej stronie - komentarz zaktualizowany, nie zduplikowany.
    expect(fake.commentBodies(42)).toHaveLength(4);
    expect(fake.callCount('issues.listComments')).toBe(2);
    expect(fake.callCount('issues.createComment')).toBe(0);
    const updated = fake.commentBodies(42)[2] as string;
    expect(updated).toContain('## Draft dostarczony: case-1');
    expect(fake.comments.get(42)?.[2]?.id).toBe(target);
  });

  it('skraca dane do 8000 znaków', async () => {
    const { fake, human } = setup();
    const big = { blob: 'x'.repeat(50_000) };
    await human.postReport('42', makeReport({ data: big }));
    const body = fake.commentBodies(42)[0] as string;
    expect(body).toContain('(truncated)');
    expect(body.length).toBeLessThan(9_000);
  });

  it('odrzuca runRef, który nie jest numerem issue', async () => {
    const { human } = setup();
    await expect(human.postReport('nie-numer', makeReport())).rejects.toThrow(
      /issue number/i,
    );
  });
});
