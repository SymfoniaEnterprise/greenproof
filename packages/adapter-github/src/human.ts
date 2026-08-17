/**
 * HumanChannelPort na komentarzach do issue (`runRef` = numer issue).
 * Idempotencja: niewidoczny marker w pierwszym wierszu; ten sam reportId =
 * update istniejącego komentarza, nie duplikat.
 */
import type { HumanChannelPort, HumanReport, Logger } from '@greenproof/core';
import type { GithubApi, RepoRef } from './internal.js';

/** Limit JSON-a w <details> (komentarz ma limit ~65k). */
const MAX_DATA_CHARS = 8_000;
const DEFAULT_PAGE_SIZE = 100;
/** Bezpiecznik paginacji. */
const MAX_PAGES = 100;

export interface GithubHumanChannelOptions {
  octokit: GithubApi;
  owner: string;
  repo: string;
  logger: Logger;
  /** Rozmiar strony listowania komentarzy. */
  commentsPageSize?: number | undefined;
}

export class GithubHumanChannel implements HumanChannelPort {
  private readonly api: GithubApi;
  private readonly repoRef: RepoRef;
  private readonly logger: Logger;
  private readonly pageSize: number;

  constructor(options: GithubHumanChannelOptions) {
    this.api = options.octokit;
    this.repoRef = { owner: options.owner, repo: options.repo };
    this.logger = options.logger;
    this.pageSize = options.commentsPageSize ?? DEFAULT_PAGE_SIZE;
  }

  async postReport(runRef: string, report: HumanReport): Promise<void> {
    const issueNumber = parseIssueNumber(runRef);
    const marker = reportMarker(report.reportId);
    const body = renderBody(marker, report);

    const existing = await this.findComment(issueNumber, marker);
    if (existing !== null) {
      await this.api.issues.updateComment({ ...this.repoRef, comment_id: existing, body });
      this.logger.debug('greenproof/github: updated existing report comment', {
        issueNumber,
        reportId: report.reportId,
      });
      return;
    }
    await this.api.issues.createComment({ ...this.repoRef, issue_number: issueNumber, body });
    this.logger.debug('greenproof/github: created report comment', {
      issueNumber,
      reportId: report.reportId,
    });
  }

  /** Przechodzi wszystkie strony - marker może być głęboko w wątku. */
  private async findComment(issueNumber: number, marker: string): Promise<number | null> {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await this.api.issues.listComments({
        ...this.repoRef,
        issue_number: issueNumber,
        per_page: this.pageSize,
        page,
      });
      for (const comment of res.data) {
        if (comment.body !== undefined && comment.body.includes(marker)) return comment.id;
      }
      if (res.data.length < this.pageSize) return null; // ostatnia (niepełna) strona
    }
    this.logger.warn('greenproof/github: stopped paginating issue comments at the page cap', {
      issueNumber,
    });
    return null;
  }
}

export function reportMarker(reportId: string): string {
  return `<!-- greenproof:report:${reportId} -->`;
}

function renderBody(marker: string, report: HumanReport): string {
  const markdown = report.markdown.endsWith('\n')
    ? report.markdown.slice(0, -1)
    : report.markdown;
  // Dane strukturalne w zwijanej sekcji, nie w treści raportu.
  const raw = JSON.stringify(report.data ?? null, null, 2) ?? 'null';
  const json =
    raw.length > MAX_DATA_CHARS ? `${raw.slice(0, MAX_DATA_CHARS)}\n… (truncated)` : raw;
  return [
    marker,
    `## ${report.title}`,
    '',
    markdown,
    '',
    '<details>',
    `<summary>greenproof data (${report.kind})</summary>`,
    '',
    '```json',
    json,
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
}

function parseIssueNumber(runRef: string): number {
  const n = Number(runRef);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `@greenproof/adapter-github: runRef must be a GitHub issue number, got: ${runRef}`,
    );
  }
  return n;
}
