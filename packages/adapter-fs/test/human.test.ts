import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HumanReport } from '@greenproof/core';
import { afterAll, describe, expect, it } from 'vitest';
import { FsHumanChannel } from '../src/index.js';
import { cleanupTmp, tmpDir } from './helpers.js';

afterAll(cleanupTmp);

function makeReport(overrides: Partial<HumanReport> = {}): HumanReport {
  return {
    kind: 'draft_delivered',
    title: 'Draft dla case-1',
    markdown: '# Draft\n\n- spec: specs/a.spec.ts\n',
    data: { caseId: 'case-1', attempts: 1 },
    reportId: 'run-1:case-1:draft_delivered',
    ...overrides,
  };
}

describe('FsHumanChannel', () => {
  it('zapisuje markdown z front matterem i dane obok', async () => {
    const dir = await tmpDir('gp-reports-');
    const channel = new FsHumanChannel({ dir, clock: { now: () => new Date('2026-01-02T03:04:05Z') } });
    await channel.postReport('42', makeReport());

    // reportId sanityzowany: ':' → '_'
    const runDir = join(dir, '42');
    expect((await readdir(runDir)).sort()).toEqual([
      'run-1_case-1_draft_delivered.json',
      'run-1_case-1_draft_delivered.md',
    ]);

    const md = await readFile(join(runDir, 'run-1_case-1_draft_delivered.md'), 'utf8');
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('kind: "draft_delivered"');
    expect(md).toContain('title: "Draft dla case-1"');
    expect(md).toContain('date: "2026-01-02T03:04:05.000Z"');
    expect(md).toContain('# Draft');

    const data = JSON.parse(
      await readFile(join(runDir, 'run-1_case-1_draft_delivered.json'), 'utf8'),
    ) as { caseId: string };
    expect(data.caseId).toBe('case-1');
  });

  it('ten sam reportId = update jednego pliku, nie duplikat', async () => {
    const dir = await tmpDir('gp-reports-');
    const channel = new FsHumanChannel({ dir });
    await channel.postReport('42', makeReport({ markdown: 'wersja 1\n' }));
    await channel.postReport(
      '42',
      makeReport({ markdown: 'wersja 2\n', title: 'Draft (retry)', data: { attempts: 2 } }),
    );

    const runDir = join(dir, '42');
    const files = (await readdir(runDir)).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);

    const md = await readFile(join(runDir, files[0] as string), 'utf8');
    expect(md).toContain('wersja 2');
    expect(md).not.toContain('wersja 1');
    expect(md).toContain('title: "Draft (retry)"');
  });

  it('różne runRef trafiają do osobnych katalogów, reportId bez znaków ścieżki', async () => {
    const dir = await tmpDir('gp-reports-');
    const channel = new FsHumanChannel({ dir });
    await channel.postReport('run/42', makeReport({ reportId: '../../ucieczka', kind: 'roster' }));
    expect((await readdir(dir)).sort()).toEqual(['run_42']);
    expect((await readdir(join(dir, 'run_42'))).sort()).toEqual([
      '.._.._ucieczka.json',
      '.._.._ucieczka.md',
    ]);
  });
});
