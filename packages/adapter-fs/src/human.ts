/**
 * HumanChannelPort na plikach markdown: <dir>/<runRef>/<reportId>.md
 * (+ <reportId>.json z danymi strukturalnymi). Ten sam reportId = update,
 * nie duplikat - kontrakt idempotencji raportów.
 */
import { join } from 'node:path';
import type { Clock, HumanChannelPort, HumanReport } from '@greenproof/core';
import { sanitizeName, writeFileAtomic } from './internal.js';

export interface FsHumanChannelOptions {
  /** Katalog raportów (baseDir/reports). */
  dir: string;
  clock?: Clock | undefined;
}

export class FsHumanChannel implements HumanChannelPort {
  private readonly dir: string;
  private readonly clock: Clock;

  constructor(options: FsHumanChannelOptions) {
    this.dir = options.dir;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async postReport(runRef: string, report: HumanReport): Promise<void> {
    const runDir = join(this.dir, sanitizeName(runRef, 'runRef'));
    const name = sanitizeName(report.reportId, 'reportId');
    const frontMatter = [
      '---',
      `kind: ${JSON.stringify(report.kind)}`,
      `title: ${JSON.stringify(report.title)}`,
      `reportId: ${JSON.stringify(report.reportId)}`,
      `date: ${JSON.stringify(this.clock.now().toISOString())}`,
      '---',
      '',
    ].join('\n');
    const body = report.markdown.endsWith('\n') ? report.markdown : `${report.markdown}\n`;
    await writeFileAtomic(join(runDir, `${name}.md`), `${frontMatter}${body}`);
    await writeFileAtomic(
      join(runDir, `${name}.json`),
      `${JSON.stringify(report.data ?? null, null, 2)}\n`,
    );
  }
}
