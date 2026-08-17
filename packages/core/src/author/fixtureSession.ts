/**
 * Wąska sesja fixture-author: jedyny cel = działający fixture seedu dla flow
 * z fixture-gapem. Bez faz, bez dowodu mutacyjnego, mały cap. Opcjonalnie
 * mocniejszy model niż autor (config.model.fixtureAuthor) - drogi model płaci
 * za odkrycie raz, tani autor reużywa je przy retry.
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { GreenproofConfig } from '../config/types.js';
import type { Logger, SecretsPort } from '../ports/index.js';
import { emitProgress, type ProgressSink } from '../domain/progress.js';
import type { SeedAttempt } from '../domain/attempt.js';
import type { AppMapView, UiTrap } from '../domain/knowledge.js';
import type { PomIndexEntry } from '../domain/harvest.js';
import { truncateToolResponse } from './hooks.js';
import { mcpServerCommand } from '../util/exec.js';

export interface FixtureSessionOutput {
  status: 'delivered' | 'failed';
  name?: string;
  fixturePath?: string;
  /** Skrypt weryfikacyjny: `node <ścieżka> <envUrl>` musi wyjść kodem 0. */
  verifyScriptPath?: string;
  description?: string;
  covers?: string[];
  notes?: string;
}

const FIXTURE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['delivered', 'failed'] },
    name: { type: 'string', description: 'Nazwa fixture w inwentarzu, np. payrollSeed' },
    fixturePath: { type: 'string', description: 'Ścieżka fixture względem repo testów' },
    verifyScriptPath: {
      type: 'string',
      description: 'Ścieżka skryptu weryfikacyjnego (node <skrypt> <envUrl> → exit 0)',
    },
    description: { type: 'string' },
    covers: { type: 'array', items: { type: 'string' }, description: 'Tagi flow pokrywane przez fixture' },
    notes: { type: 'string' },
  },
  required: ['status'],
  additionalProperties: false,
} as const;

export interface FixtureContext {
  caseId: string;
  flows: string[];
  envUrl: string;
  /** Nieudane strategie seedu z poprzednich prób (czego NIE próbować). */
  failedStrategies: SeedAttempt[];
  digest?: string;
  appMapViews: AppMapView[];
  uiTraps: UiTrap[];
  inventory: PomIndexEntry[];
  fixturesDir: string;
  /** Dokumentacja aplikacji (config appDocs) - wstrzykiwana wprost do promptu. */
  docs?: { path: string; content: string }[];
}

export interface FixtureSessionResult {
  resultSubtype: string;
  /** Powód przerwania przez NASZE liczniki: cap czasu albo brak startu sesji. */
  cappedBy?: 'time' | 'infra';
  structured?: FixtureSessionOutput;
  costUsd: number;
  turns: number;
  messagesPath: string;
}

function fixtureSystemPrompt(ctx: FixtureContext): string {
  return [
    'Jesteś fixture-authorem. Masz JEDNO zadanie: dostarczyć działający, reużywalny fixture SEEDU dla wskazanego flow aplikacji. NIE piszesz testów, NIE robisz dowodu mutacyjnego, NIE budujesz POM-ów nawigacyjnych.',
    '',
    'Protokół:',
    ctx.docs !== undefined && ctx.docs.length > 0
      ? '1. Ustal, jak deterministycznie doprowadzić aplikację do stanu wyjściowego dla flow - dokumentacja aplikacji jest NIŻEJ w prompcie (sekcja „Dokumentacja aplikacji"); z dysku doczytuj tylko, czego tam brak. API testowe (curl) przed przeglądarką.'
      : '1. Ustal, jak deterministycznie doprowadzić aplikację do stanu wyjściowego dla flow - ZACZNIJ od przeczytania README aplikacji i dokumentacji jej API testowego (curl), dopiero potem ewentualnie przeglądarka.',
    `2. Napisz fixture w ${ctx.fixturesDir}/ (TypeScript, eksportowane funkcje z JSDoc: co robi, jakie ma pułapki domenowe).`,
    `3. Napisz skrypt weryfikacyjny obok fixture (.verify.mjs): \`node <skrypt> <envUrl>\` ma UŻYĆ fixture (lub odtworzyć jego wywołania), potwierdzić realny stan aplikacji i wyjść kodem 0; niezerowy kod = fixture nie działa. Pipeline uruchomi ten skrypt po sesji - werdykt jest poza Twoją kontrolą.`,
    '4. Uruchom skrypt sam, popraw aż działa, zrób commit (git add + commit na bieżącym branchu).',
    '5. Zakończ wynikiem strukturalnym: status delivered + name/fixturePath/verifyScriptPath/description/covers.',
    '',
    'Zakazy: żadnego git push; nie zmieniaj aplikacji; nie twórz speców testowych. Pracuj oszczędnie - masz mały budżet tur.',
  ].join('\n');
}

function fixturePrompt(ctx: FixtureContext): string {
  const s: string[] = [
    `# Fixture-gap: ${ctx.caseId}`,
    `Flow: ${ctx.flows.join(', ')} · Aplikacja: ${ctx.envUrl}`,
  ];
  if (ctx.failedStrategies.length > 0) {
    s.push(
      '',
      '## Nieudane strategie seedu z poprzednich prób (NIE powtarzaj):',
      ...ctx.failedStrategies.map((f) => `- "${f.strategy}"${f.note ? ` - ${f.note}` : ''}`),
    );
  }
  if (ctx.digest) s.push('', '## Wnioski z nieudanej próby autora', ctx.digest);
  if (ctx.appMapViews.length > 0) {
    s.push(
      '',
      '## Mapa aplikacji dla flow',
      ...ctx.appMapViews.map((v) => `- ${v.route}: ${v.description ?? ''} (kroki: ${v.navigationSteps.join(' → ')})`),
    );
  }
  if (ctx.uiTraps.length > 0) {
    s.push('', '## Znane pułapki', ...ctx.uiTraps.map((t) => `- ${t.component}: ${t.trap} → ${t.workaround}`));
  }
  if (ctx.inventory.length > 0) {
    s.push('', '## Istniejący inwentarz (nie dubluj)', ...ctx.inventory.map((e) => `- ${e.name} (${e.kind}): ${e.path}`));
  }
  if (ctx.docs !== undefined && ctx.docs.length > 0) {
    s.push('', '## Dokumentacja aplikacji (czytaj TU, nie zgaduj)');
    for (const d of ctx.docs) s.push('', `### ${d.path}`, d.content);
  }
  return s.join('\n');
}

const DENY_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /git\s+push/, reason: 'Push wykonuje wyłącznie pipeline' },
  { re: /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+[/~]/, reason: 'Destrukcyjne rm poza katalogiem roboczym' },
];

export interface FixtureSessionDeps {
  config: GreenproofConfig;
  context: FixtureContext;
  secrets: SecretsPort;
  logger: Logger;
  cwd: string;
  attemptDir: string;
  runId: string;
  /** Numer próby autora tej sesji; 0 = sesja prewencyjna poza próbami. */
  attempt: number;
  /** Odbiornik zdarzeń postępu; brak = brak emisji. */
  onProgress?: ProgressSink;
}

export async function runFixtureSession(deps: FixtureSessionDeps): Promise<FixtureSessionResult> {
  const { config, context, secrets, logger } = deps;
  const caps = config.caps.fixtureSession;
  const fa = config.model.fixtureAuthor;
  const model = fa?.model ?? config.model.author;
  const baseUrl = fa?.baseUrl ?? config.model.baseUrl;
  const tokenEnv = fa?.authTokenEnv ?? config.model.authTokenEnv;
  const authToken = tokenEnv !== undefined ? secrets.get(tokenEnv) : undefined;
  if (!authToken && baseUrl !== undefined) {
    throw new Error(`Brak sekretu ${tokenEnv} (token endpointu fixture-author)`);
  }

  await mkdir(deps.attemptDir, { recursive: true });
  const messagesPath = join(deps.attemptDir, 'messages.jsonl');
  const started = Date.now();
  const controller = new AbortController();
  let cappedBy: 'time' | 'infra' | undefined;
  const timeCap = setTimeout(() => {
    cappedBy ??= 'time';
    controller.abort();
  }, caps.maxTimeMinutes * 60_000);

  // Watchdog startu: brak pierwszej tury w oknie znaczy awarię backendu/bramy,
  // nie porażkę fixture-authora.
  let firstTurnTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    cappedBy ??= 'infra';
    controller.abort();
  }, config.caps.firstTurnTimeoutMinutes * 60_000);
  const clearFirstTurnTimer = (): void => {
    if (firstTurnTimer !== undefined) {
      clearTimeout(firstTurnTimer);
      firstTurnTimer = undefined;
    }
  };

  const options: Options = {
    model,
    cwd: deps.cwd,
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      ...(authToken !== undefined
        ? { CLAUDE_CONFIG_DIR: join(deps.attemptDir, 'claude-config'), ANTHROPIC_AUTH_TOKEN: authToken }
        : { ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] }),
      ...(baseUrl !== undefined ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
    },
    maxTurns: caps.maxTurns,
    maxBudgetUsd: config.model.priceTable ? caps.maxCostUsd * 20 : caps.maxCostUsd,
    abortController: controller,
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: fixtureSystemPrompt(context),
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__playwright'],
    disallowedTools: ['WebSearch', 'WebFetch', 'Task', 'NotebookEdit'],
    mcpServers: {
      // Spawn robi SDK - na Windows `node …\npx-cli.js` (patrz mcpServerCommand).
      playwright: mcpServerCommand('npx', [
        '@playwright/mcp@latest', '--isolated', '--headless', '--browser', 'chromium',
        '--snapshot-mode', 'none', '--output-dir', join(deps.attemptDir, 'playwright'),
      ]),
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (raw) => {
              const input = raw as { tool_name: string; tool_input: unknown };
              if (input.tool_name === 'Bash') {
                const cmd = String((input.tool_input as { command?: unknown })?.command ?? '');
                for (const { re, reason } of DENY_PATTERNS) {
                  if (re.test(cmd)) {
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason: reason,
                      },
                    };
                  }
                }
              }
              return { continue: true };
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (raw) => {
              const input = raw as { tool_response: unknown };
              const truncated = truncateToolResponse(input.tool_response, config.caps.snapshotMaxChars);
              return truncated !== undefined
                ? { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, updatedToolOutput: truncated } }
                : { continue: true };
            },
          ],
        },
      ],
    },
    outputFormat: { type: 'json_schema', schema: FIXTURE_RESULT_SCHEMA as unknown as Record<string, unknown> },
  };

  const q = query({ prompt: fixturePrompt(context), options });
  let resultSubtype = 'aborted';
  let structured: FixtureSessionOutput | undefined;
  let costUsd = 0;
  let turns = 0;

  try {
    for await (const msg of q as AsyncGenerator<SDKMessage, void>) {
      appendFileSync(messagesPath, `${JSON.stringify(msg)}\n`);
      if (msg.type === 'assistant') {
        clearFirstTurnTimer();
        turns += 1;
        // Sesja fixture nie ma faz ani pul playwright - stąd stała faza
        // 'fixture' i brak `pw`.
        if (deps.onProgress) {
          const now = Date.now();
          emitProgress(deps.onProgress, {
            kind: 'turn',
            runId: deps.runId,
            at: new Date(now).toISOString(),
            caseId: context.caseId,
            attempt: deps.attempt,
            phase: 'fixture',
            turns,
            maxTurns: caps.maxTurns,
            elapsedSec: Math.round((now - started) / 1000),
            maxTimeSec: caps.maxTimeMinutes * 60,
            // Sesja fixture wycenia się dopiero z resultu - do tego czasu 0.
            costUsd,
            maxCostUsd: caps.maxCostUsd,
          });
        }
      }
      if (msg.type === 'result') {
        resultSubtype = msg.subtype;
        costUsd = msg.total_cost_usd;
        if (msg.subtype === 'success' && msg.structured_output !== undefined) {
          structured = msg.structured_output as FixtureSessionOutput;
        }
        const modelUsage = (msg as { modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }> }).modelUsage;
        if (modelUsage && config.model.priceTable) {
          let cost = 0;
          for (const [m, u] of Object.entries(modelUsage)) {
            const price = config.model.priceTable[m];
            if (price) {
              const per = 1 / 1_000_000;
              cost +=
                u.inputTokens * price.inPerMTok * per +
                u.outputTokens * price.outPerMTok * per +
                u.cacheReadInputTokens * (price.cacheReadPerMTok ?? price.inPerMTok * 0.1) * per;
            }
          }
          if (cost > 0) costUsd = cost;
        }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted && resultSubtype === 'aborted') throw err;
    if (!controller.signal.aborted) logger.warn('Pętla SDK rzuciła po result - ignoruję', err);
  } finally {
    clearTimeout(timeCap);
    clearFirstTurnTimer();
  }

  return {
    resultSubtype,
    ...(cappedBy !== undefined ? { cappedBy } : {}),
    ...(structured !== undefined ? { structured } : {}),
    costUsd,
    turns,
    messagesPath,
  };
}
