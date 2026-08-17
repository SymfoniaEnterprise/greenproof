/**
 * HumanChannelPort w pamięci; powtórny reportId nadpisuje wpis, tak jak realny
 * adapter aktualizuje komentarz zamiast tworzyć duplikat.
 */
import type { HumanChannelPort, HumanReport, HumanReportKind } from '@greenproof/core';

export interface CapturedReport {
  runRef: string;
  report: HumanReport;
}

export class CapturingHumanChannel implements HumanChannelPort {
  /** Wszystkie aktualne raporty w kolejności pierwszej publikacji. */
  readonly reports: CapturedReport[] = [];
  /** Liczba wywołań postReport (łącznie z nadpisaniami) - do asercji idempotencji. */
  posts = 0;

  async postReport(runRef: string, report: HumanReport): Promise<void> {
    this.posts += 1;
    const index = this.reports.findIndex((r) => r.report.reportId === report.reportId);
    const entry: CapturedReport = { runRef, report };
    if (index >= 0) this.reports[index] = entry;
    else this.reports.push(entry);
  }

  // --- pomocnicze dla testów -------------------------------------------------

  byKind(kind: HumanReportKind): HumanReport[] {
    return this.reports.filter((r) => r.report.kind === kind).map((r) => r.report);
  }

  byId(reportId: string): HumanReport | null {
    return this.reports.find((r) => r.report.reportId === reportId)?.report ?? null;
  }

  last(): HumanReport | null {
    return this.reports.at(-1)?.report ?? null;
  }

  clear(): void {
    this.reports.length = 0;
    this.posts = 0;
  }
}
