/**
 * RETRY - oznacza case do ponownej próby. Uwagi człowieka trafiają do stanu
 * (retryNotes) i zostaną złożone przez triaż z automatycznym digestem
 * poprzedniej próby. Samo autorowanie odpala komenda author.
 */
import type { Ports } from '../ports/index.js';
import { withState } from '../machine/withState.js';
import { getCase, releaseLease, transitionCase } from '../machine/pipeline.js';

export interface RetryParams {
  runId: string;
  caseId: string;
  notes?: string;
}

export interface RetryResult {
  caseId: string;
  attempt: number;
}

export async function runRetry(ports: Ports, params: RetryParams): Promise<RetryResult> {
  return withState(ports, params.runId, (state) => {
    const cs = getCase(state, params.caseId);
    releaseLease(state, params.caseId);
    // in_review przechodzi przez retry_requested; pozostałe wracają wprost do triaged.
    if (cs.status === 'in_review') {
      transitionCase(state, params.caseId, 'retry_requested');
    }
    transitionCase(state, params.caseId, 'triaged', {
      ...(params.notes !== undefined ? { retryNotes: params.notes } : {}),
    });
    delete cs.blockedReason;
    delete cs.blockedNote;
    return { caseId: params.caseId, attempt: cs.attempts + 1 };
  });
}
