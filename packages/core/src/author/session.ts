/**
 * Sesja agenta-autora: jedna świeża sesja query() per (case, attempt).
 * Egzekwuje capy: tury i koszt (natywnie + własny licznik z priceTable - brama
 * może liczyć błędnie), czas (AbortController), runy playwright i bezpiecznik
 * seedu (hooki + narzędzia + watchdog).
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { GreenproofConfig } from '../config/types.js';
import type { Clock, Logger, SecretsPort } from '../ports/index.js';
import type { BlockedReason } from '../domain/state.js';
import { emitProgress, type ProgressSink } from '../domain/progress.js';
import type { CaseContext } from '../steps/triage.js';
import { AuthorSessionState, type FinishInfo } from './state.js';
import { buildAuthorHooks } from './hooks.js';
import { createGreenproofServer } from './tools.js';
import { authorSystemPrompt, buildAuthorPrompt } from './prompt.js';
import { mcpServerCommand } from '../util/exec.js';

const AUTHOR_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['delivered', 'blocked', 'failed'] },
    specPath: { type: 'string', description: 'Ścieżka draftu speca względem repo testów' },
    notes: { type: 'string', description: 'Notatka dla przeglądu (przy blocked: opis fixture-gap)' },
    reusedPoms: { type: 'array', items: { type: 'string' }, description: 'Nazwy reużytych POM-ów z inventory' },
    errors: { type: 'array', items: { type: 'string' }, description: 'Najważniejsze napotkane błędy' },
  },
  required: ['status'],
  additionalProperties: false,
} as const;

export interface AuthorSessionOptions {
  config: GreenproofConfig;
  context: CaseContext;
  secrets: SecretsPort;
  logger: Logger;
  clock: Clock;
  /** Katalog roboczy repo testów (cwd agenta). */
  cwd: string;
  /** Katalog na pliki robocze próby (transcript jsonl, output playwright-mcp). */
  attemptDir: string;
  /** Identyfikator przebiegu (do zdarzeń postępu). */
  runId: string;
  /**
   * Odbiornik zdarzeń postępu (host CLI/CI). Sesja emituje `turn` per tura i
   * przekazuje odbiornik narzędziom; caseId/attempt bierze z kontekstu. Brak =
   * brak emisji.
   */
  onProgress?: ProgressSink;
}

export interface AuthorSessionResult {
  /** Wynik pętli SDK: success | error_max_turns | error_max_budget_usd | error_during_execution | aborted. */
  resultSubtype: string;
  /** Powód przerwania przez NASZE liczniki (jeśli dotyczy). */
  cappedBy?: BlockedReason;
  structured?: FinishInfo;
  state: AuthorSessionState;
  costUsdSdk: number;
  durationMs: number;
  /** Ścieżka lokalnego jsonl ze wszystkimi wiadomościami sesji (nasz transcript). */
  messagesPath: string;
}

/** Cena tokenów wg priceTable; brak wpisu = 0 (wtedy licznikiem jest SDK). */
function messageCost(
  config: GreenproofConfig,
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null },
): number {
  const price = config.model.priceTable?.[config.model.author];
  if (!price) return 0;
  const per = 1 / 1_000_000;
  return (
    (usage.input_tokens ?? 0) * price.inPerMTok * per +
    (usage.output_tokens ?? 0) * price.outPerMTok * per +
    (usage.cache_read_input_tokens ?? 0) * (price.cacheReadPerMTok ?? price.inPerMTok * 0.1) * per +
    (usage.cache_creation_input_tokens ?? 0) * (price.cacheWritePerMTok ?? price.inPerMTok * 1.25) * per
  );
}

/**
 * Natywny cap kosztu SDK. Z priceTable źródłem prawdy jest nasz licznik, więc
 * cap SDK zostaje odbojnikiem na runaway (SDK wycenia modele za bramą własnym,
 * zawyżonym cennikiem).
 *
 * Model lokalny (`costModel: 'local'`) płaci czasem GPU, nie kwotą - a odbojnik
 * ×20 liczony cennikiem SDK i tak go ubija (darmowy run padł na „maximum
 * budget"). Dla takich modeli granicą są `maxTurns` i `maxTimeMinutes` -
 * zwracamy undefined.
 *
 * Bez jawnego `costModel` wnioskujemy z cennika (zerowy = lokalny). To
 * heurystyka ratunkowa: modele z subskrypcji bywają wpisane z zerowym cennikiem,
 * więc ustaw `costModel: 'subscription'` - limit abonamentu istnieje, choć nie
 * per token.
 */
export function sdkBudgetUsd(
  config: GreenproofConfig,
  caps: GreenproofConfig['caps'],
): number | undefined {
  const price = config.model.priceTable?.[config.model.author];
  const priceTableAllZero =
    price !== undefined &&
    price.inPerMTok === 0 &&
    price.outPerMTok === 0 &&
    (price.cacheReadPerMTok ?? 0) === 0 &&
    (price.cacheWritePerMTok ?? 0) === 0;
  const isLocal =
    config.model.costModel !== undefined
      ? config.model.costModel === 'local'
      : priceTableAllZero;
  if (isLocal) return undefined;
  return config.model.priceTable ? caps.maxCostUsd * 20 : caps.maxCostUsd;
}

export async function runAuthorSession(opts: AuthorSessionOptions): Promise<AuthorSessionResult> {
  const { config, context, secrets, logger, clock } = opts;
  const caps = config.caps;
  const state = new AuthorSessionState();
  const started = Date.now();

  await mkdir(opts.attemptDir, { recursive: true });
  const messagesPath = join(opts.attemptDir, 'messages.jsonl');

  /**
   * Jedna tura = jedno zdarzenie `turn`. Źródło czasu takie samo, jak dla capu
   * czasu - inaczej elapsed pokazywałby inny moment niż realne ucięcie sesji.
   * Bez throttlingu - częstotliwość odrysowania to sprawa renderera hosta.
   */
  const emitTurn = (): void => {
    if (!opts.onProgress) return;
    const now = Date.now();
    const last = state.playwrightRuns[state.playwrightRuns.length - 1];
    emitProgress(opts.onProgress, {
      kind: 'turn',
      runId: opts.runId,
      at: new Date(now).toISOString(),
      caseId: context.case.caseId,
      attempt: context.attempt,
      phase: state.phase,
      turns: state.turns,
      maxTurns: caps.maxTurns,
      elapsedSec: Math.round((now - started) / 1000),
      maxTimeSec: caps.maxTimeMinutes * 60,
      costUsd: state.costUsd,
      maxCostUsd: caps.maxCostUsd,
      pw: {
        assertUsed: state.playwrightRunsByPhase.assert,
        assertMax: caps.maxPlaywrightRuns,
        proofUsed: state.proofRunsUsed,
        proofMax: caps.proofRuns,
        greenRuns: state.greenRuns,
      },
      ...(last !== undefined
        ? {
            lastEvent: `run_playwright #${last.index} (${last.purpose}) → ${last.passed}/${last.total} passed`,
          }
        : {}),
    });
  };

  const controller = new AbortController();
  const timeCap = setTimeout(() => {
    state.interruptReason ??= 'time';
    controller.abort();
  }, caps.maxTimeMinutes * 60_000);

  // Watchdog startu: brak pierwszej tury w oknie = awaria backendu/bramy, nie
  // wina case'a - stąd osobny powód 'infra' i osobna pula ponowień.
  let firstTurnTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    state.interruptReason ??= 'infra';
    controller.abort();
  }, caps.firstTurnTimeoutMinutes * 60_000);
  const clearFirstTurnTimer = (): void => {
    if (firstTurnTimer !== undefined) {
      clearTimeout(firstTurnTimer);
      firstTurnTimer = undefined;
    }
  };

  // Token wymagany tylko przy bramie (baseUrl); bez bramy sesja dziedziczy
  // poświadczenia Claude z HOME (subskrypcja / ANTHROPIC_API_KEY w CI).
  const authToken = secrets.get(config.model.authTokenEnv);
  if (!authToken && config.model.baseUrl !== undefined) {
    clearTimeout(timeCap);
    clearFirstTurnTimer();
    throw new Error(`Brak sekretu ${config.model.authTokenEnv} (token bramy modelu)`);
  }

  const env: Record<string, string | undefined> = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
    ...(authToken !== undefined
      ? {
          // Sesja efemeryczna - konfiguracja Claude w katalogu roboczym próby.
          CLAUDE_CONFIG_DIR: join(opts.attemptDir, 'claude-config'),
          ANTHROPIC_AUTH_TOKEN: authToken,
        }
      : { ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] }),
    ...(config.model.baseUrl !== undefined ? { ANTHROPIC_BASE_URL: config.model.baseUrl } : {}),
    ...(config.model.maxOutputTokens !== undefined
      ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(config.model.maxOutputTokens) }
      : {}),
  };

  const sdkBudget = sdkBudgetUsd(config, caps);

  const options: Options = {
    model: config.model.author,
    cwd: opts.cwd,
    env,
    maxTurns: caps.maxTurns,
    ...(sdkBudget !== undefined ? { maxBudgetUsd: sdkBudget } : {}),
    abortController: controller,
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: authorSystemPrompt(config, context),
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite',
      'mcp__playwright', 'mcp__greenproof',
    ],
    disallowedTools: ['WebSearch', 'WebFetch', 'Task', 'NotebookEdit'],
    mcpServers: {
      // Spawn robi SDK i nie kontrolujemy jego opcji - na Windows dostajemy
      // `node …\npx-cli.js` (patrz mcpServerCommand), poza Windowsem czyste `npx`.
      playwright: mcpServerCommand('npx', [
        '@playwright/mcp@latest',
        '--isolated',
        '--headless',
        // Bundled chromium - bez tego MCP szuka systemowego Chrome'a.
        '--browser', 'chromium',
        // Największa dźwignia kosztowa: narzędzia interakcyjne nie zwracają
        // pełnego snapshotu strony.
        '--snapshot-mode', 'none',
        '--output-dir', join(opts.attemptDir, 'playwright'),
        '--timeout-navigation', '15000',
      ]),
      greenproof: createGreenproofServer({
        state,
        config,
        context,
        cwd: opts.cwd,
        attemptDir: opts.attemptDir,
        clock,
        runId: opts.runId,
        ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      }),
    },
    hooks: buildAuthorHooks(state, config, logger),
    outputFormat: { type: 'json_schema', schema: AUTHOR_RESULT_SCHEMA as unknown as Record<string, unknown> },
  };

  const q = query({ prompt: buildAuthorPrompt(context), options });

  let resultSubtype = 'aborted';
  let costUsdSdk = 0;
  let structured: FinishInfo | undefined;

  try {
    for await (const msg of q as AsyncGenerator<SDKMessage, void>) {
      appendFileSync(messagesPath, `${JSON.stringify(msg)}\n`);

      if (msg.type === 'assistant') {
        clearFirstTurnTimer();
        state.turns += 1;
        state.turnsByPhase[state.phase] += 1;
        const usage = msg.message.usage;
        if (usage) {
          state.tokens.input += usage.input_tokens ?? 0;
          state.tokens.output += usage.output_tokens ?? 0;
          state.tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
          state.tokens.cacheCreation += usage.cache_creation_input_tokens ?? 0;
          state.costUsd += messageCost(config, usage);
        }
        emitTurn();

        // Własny cap kosztowy - źródło prawdy przy bramie z fałszywym cennikiem.
        if (config.model.priceTable && state.costUsd > caps.maxCostUsd) {
          state.interruptReason ??= 'budget';
          logger.warn(`Własny licznik kosztu przekroczył cap ($${state.costUsd.toFixed(2)}) - interrupt`);
          await q.interrupt().catch(() => {});
          continue;
        }

        // Watchdog fazy arrange dla churn-prone: limit tur bez potwierdzonego seedu.
        if (
          context.churnProne &&
          !state.fuseTripped &&
          state.phase === 'arrange' &&
          !state.seedConfirmed &&
          state.turnsInArrange > caps.seedFuse.maxArrangeTurns
        ) {
          state.fuseTripped = true;
          state.fuseTrippedAtTurn = state.turns;
          state.fuseNote = `fixture-gap: ${state.turnsInArrange} tur fazy arrange bez potwierdzonego stanu wyjściowego`;
        }

        // Watchdog po bezpieczniku: limit tur na formalne zakończenie sesji.
        if (
          state.fuseTripped &&
          state.fuseTrippedAtTurn !== undefined &&
          state.turns > state.fuseTrippedAtTurn + 3
        ) {
          state.interruptReason ??= 'fixture-gap';
          await q.interrupt().catch(() => {});
        }
      }

      if (msg.type === 'result') {
        resultSubtype = msg.subtype;
        costUsdSdk = msg.total_cost_usd;
        if (msg.subtype === 'success' && msg.structured_output !== undefined) {
          structured = msg.structured_output as FinishInfo;
        }
        // Brama często nie zwraca usage w streamie - jedynym wiarygodnym źródłem
        // tokenów jest modelUsage z resultu. Przeliczamy własnym cennikiem.
        const modelUsage = (msg as { modelUsage?: Record<string, {
          inputTokens: number; outputTokens: number;
          cacheReadInputTokens: number; cacheCreationInputTokens: number;
        }> }).modelUsage;
        if (modelUsage && config.model.priceTable) {
          let cost = 0;
          const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
          for (const [model, u] of Object.entries(modelUsage)) {
            tokens.input += u.inputTokens;
            tokens.output += u.outputTokens;
            tokens.cacheRead += u.cacheReadInputTokens;
            tokens.cacheCreation += u.cacheCreationInputTokens;
            const price = config.model.priceTable[model] ?? config.model.priceTable[config.model.author];
            if (price) {
              const per = 1 / 1_000_000;
              cost +=
                u.inputTokens * price.inPerMTok * per +
                u.outputTokens * price.outPerMTok * per +
                u.cacheReadInputTokens * (price.cacheReadPerMTok ?? price.inPerMTok * 0.1) * per +
                u.cacheCreationInputTokens * (price.cacheWritePerMTok ?? price.inPerMTok * 1.25) * per;
            }
          }
          if (state.tokens.input + state.tokens.output === 0) state.tokens = tokens;
          state.costUsd = Math.max(state.costUsd, cost);
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      // Abort czasu/startu - wynik pozostaje 'aborted' z cappedBy z interruptReason.
    } else if (resultSubtype !== 'aborted') {
      // SDK potrafi rzucić po wyemitowaniu error-resultu (np. max budget) -
      // result już mamy, więc to normalne zakończenie, nie awaria sesji.
      logger.warn(`Pętla SDK rzuciła po result (${resultSubtype}) - ignoruję`, err);
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeCap);
    clearFirstTurnTimer();
  }

  // Mapowanie natywnych limitów SDK na powody blokady.
  let cappedBy: BlockedReason | undefined =
    state.interruptReason ??
    (resultSubtype === 'error_max_turns'
      ? 'turns'
      : resultSubtype === 'error_max_budget_usd'
        ? 'budget'
        : undefined);

  // Brak surowca dowodu + przepalona pula runów = blokada budżetem runów, nie
  // "zwykła" porażka. Gdy dowód jest, ocenia go dowód (pula mogła się wyczerpać
  // już po jego zapisaniu).
  if (!state.proofMaterial && state.playwrightRunsExhausted) cappedBy ??= 'playwright-runs';

  return {
    resultSubtype,
    ...(cappedBy !== undefined ? { cappedBy } : {}),
    ...(structured !== undefined ? { structured } : {}),
    state,
    costUsdSdk,
    durationMs: Date.now() - started,
    messagesPath,
  };
}
