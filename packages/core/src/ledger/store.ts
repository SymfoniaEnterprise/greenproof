/** Ledger prób - jsonl w ArtifactStore, jeden wpis per attempt. */
import type { AttemptRecord } from '../domain/attempt.js';
import type { ArtifactStore } from '../ports/index.js';
import { safeCaseId } from '../steps/filter.js';

export function ledgerKey(caseId: string): string {
  return `cases/${safeCaseId(caseId)}/ledger.jsonl`;
}

export async function readLedger(
  artifacts: ArtifactStore,
  runId: string,
  caseId: string,
): Promise<AttemptRecord[]> {
  const buf = await artifacts.get(runId, ledgerKey(caseId));
  if (!buf) return [];
  return buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AttemptRecord);
}

export async function appendAttempt(
  artifacts: ArtifactStore,
  runId: string,
  record: AttemptRecord,
): Promise<void> {
  const existing = await artifacts.get(runId, ledgerKey(record.caseId));
  const line = `${JSON.stringify(record)}\n`;
  const next = existing ? Buffer.concat([existing, Buffer.from(line)]) : Buffer.from(line);
  await artifacts.put(runId, ledgerKey(record.caseId), next);
}

export function lastAttempt(records: AttemptRecord[]): AttemptRecord | undefined {
  return records[records.length - 1];
}
