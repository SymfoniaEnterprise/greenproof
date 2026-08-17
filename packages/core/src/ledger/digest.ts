/**
 * Digest próby - skondensowane wnioski wstrzykiwane do promptu następnej
 * próby. Dwustopniowo: deterministyczny ekstraktor (zawsze, zero kosztu)
 * + opcjonalnie tani model (fallback na ekstraktor).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AttemptRecord } from '../domain/attempt.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Logger, SecretsPort } from '../ports/index.js';

export function deterministicDigest(record: AttemptRecord): string {
  const lines: string[] = [
    `Próba ${record.attemptId}: ${record.outcome}${record.blockedReason ? ` (${record.blockedReason})` : ''} - ${record.turns} tur, $${record.costUsd.toFixed(2)}, ${record.playwrightRuns}× playwright test.`,
  ];

  const failedSeeds = (record.seedAttempts ?? []).filter((s) => s.outcome === 'failed');
  if (failedSeeds.length > 0) {
    lines.push(
      `Nieudane strategie seedu (NIE powtarzaj ich): ${failedSeeds
        .map((s) => `"${s.strategy}"${s.note ? ` (${s.note})` : ''}`)
        .join('; ')}.`,
    );
  }
  const okSeed = (record.seedAttempts ?? []).find((s) => s.outcome === 'ok');
  if (okSeed) lines.push(`Działająca strategia seedu: "${okSeed.strategy}".`);

  if (record.lastErrors.length > 0) {
    lines.push('Ostatnie błędy:');
    for (const err of record.lastErrors.slice(0, 3)) {
      lines.push(`- ${err.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
  }
  if (record.filesTouched.length > 0) {
    lines.push(`Pliki z poprzedniej próby: ${record.filesTouched.slice(0, 10).join(', ')}.`);
  }
  if (record.commits.length > 0) {
    lines.push(`Commity na branchu: ${record.commits.join(', ')} - obejrzyj zamiast zaczynać od zera.`);
  }
  return lines.join('\n');
}

const MODEL_DIGEST_PROMPT =
  'Streść poniższą próbę autorowania testu E2E w maksymalnie 15 zdaniach, po polsku, jako wnioski dla NASTĘPNEJ próby: co próbowano, co zawiodło i dlaczego, czego NIE robić ponownie, co reużyć. Bez wstępów i podsumowań.';

/**
 * Digest z opcjonalnym tanim modelem. transcriptTail - końcówka transcriptu
 * (przycięta przez wywołującego), dodatkowy sygnał ponad rekord.
 */
export async function generateDigest(
  config: GreenproofConfig,
  secrets: SecretsPort,
  logger: Logger,
  record: AttemptRecord,
  transcriptTail?: string,
): Promise<string> {
  const fallback = deterministicDigest(record);
  const digestModel = config.model.digest;
  if (!digestModel) return fallback;

  const token = secrets.get(config.model.authTokenEnv);
  if (!token) return fallback;

  try {
    const client = new Anthropic({
      authToken: token,
      ...(config.model.baseUrl !== undefined ? { baseURL: config.model.baseUrl } : {}),
      maxRetries: 1,
    });
    const input = [
      MODEL_DIGEST_PROMPT,
      '',
      '## Rekord próby',
      JSON.stringify({ ...record, agentResult: undefined }, null, 1).slice(0, 8_000),
      ...(transcriptTail ? ['', '## Końcówka transcriptu', transcriptTail.slice(-12_000)] : []),
    ].join('\n');
    const response = await client.messages.create({
      model: digestModel,
      max_tokens: 1024,
      messages: [{ role: 'user', content: input }],
    });
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } & typeof b => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text.length > 0 ? text : fallback;
  } catch (err) {
    logger.warn('Digest tanim modelem nie powiódł się - używam deterministycznego', err);
    return fallback;
  }
}
