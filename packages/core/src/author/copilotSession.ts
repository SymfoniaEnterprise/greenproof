import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { GreenproofConfig } from '../config/types.js';
import type { BlockedReason } from '../domain/state.js';
import { emitProgress, type ProgressSink } from '../domain/progress.js';
import type { CaseContext } from '../steps/triage.js';
import { AuthorSessionState, type FinishInfo } from './state.js';
import { authorSystemPrompt, buildAuthorPrompt } from './prompt.js';
import {
  readAuthorSessionState,
  restoreAuthorSessionState,
  type CopilotMcpBootstrap,
} from './stateTransfer.js';
import { mcpServerCommand, runToCompletion, spawnArgv } from '../util/exec.js';
import type { AuthorSessionOptions, AuthorSessionResult } from './session.js';

interface CopilotEvent {
  type?: unknown;
  event?: unknown;
  kind?: unknown;
}

function eventType(value: CopilotEvent): string {
  return String(value.type ?? value.event ?? value.kind ?? '').toLowerCase();
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function emitTurn(
  state: AuthorSessionState,
  config: GreenproofConfig,
  context: CaseContext,
  runId: string,
  started: number,
  onProgress: ProgressSink | undefined,
): void {
  if (!onProgress) return;
  const now = Date.now();
  emitProgress(onProgress, {
    kind: 'turn',
    runId,
    at: new Date(now).toISOString(),
    caseId: context.case.caseId,
    attempt: context.attempt,
    phase: state.phase,
    turns: state.turns,
    maxTurns: config.caps.maxTurns,
    elapsedSec: Math.round((now - started) / 1000),
    maxTimeSec: config.caps.maxTimeMinutes * 60,
    costUsd: state.costUsd,
    maxCostUsd: config.caps.maxCostUsd,
    pw: {
      assertUsed: state.playwrightRunsByPhase.assert,
      assertMax: config.caps.maxPlaywrightRuns,
      proofUsed: state.proofRunsUsed,
      proofMax: config.caps.proofRuns,
      greenRuns: state.greenRuns,
    },
  });
}

function readNumeric(value: unknown, keys: string[]): number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

async function readCopilotCost(path: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return readNumeric(parsed, ['total_cost_usd', 'costUsd', 'cost_usd', 'credits']) ?? 0;
  } catch {
    return 0;
  }
}

function copilotArgs(
  config: GreenproofConfig,
  prompt: string,
  mcpConfigPath: string,
  usagePath: string,
  context: CaseContext,
): string[] {
  const cli = config.model.copilot;
  const args = [
    `--model=${config.model.author}`,
    '--mode=autopilot',
    '--allow-tool=write',
    '--allow-tool=greenproof',
    '--allow-tool=playwright',
    '--deny-tool=shell',
    '--excluded-tools=task,web_fetch',
    '--disable-builtin-mcps',
    '--no-ask-user',
    '--no-auto-update',
    '--no-color',
    '--no-remote',
    '--no-remote-export',
    '--allow-all-mcp-server-instructions',
    '--output-format=json',
    '--stream=on',
    '--silent',
    `--additional-mcp-config=@${mcpConfigPath}`,
    `--usage-output-file=${usagePath}`,
  ];
  const origin = originOf(context.envUrl);
  if (origin !== undefined) args.push(`--allow-url=${origin}`);
  if (cli?.maxAiCredits !== undefined) args.push(`--max-ai-credits=${cli.maxAiCredits}`);
  if (cli?.maxAutopilotContinues !== undefined) {
    args.push(`--max-autopilot-continues=${cli.maxAutopilotContinues}`);
  }
  args.push('-p', prompt);
  return args;
}

export async function runCopilotAuthorSession(
  opts: AuthorSessionOptions,
): Promise<AuthorSessionResult> {
  const { config, context } = opts;
  const started = Date.now();
  const state = new AuthorSessionState();
  await mkdir(opts.attemptDir, { recursive: true });

  const messagesPath = join(opts.attemptDir, 'messages.jsonl');
  const statePath = join(opts.attemptDir, 'copilot-state.json');
  const progressPath = join(opts.attemptDir, 'progress.jsonl');
  const bootstrapPath = join(opts.attemptDir, 'copilot-bootstrap.json');
  const mcpConfigPath = join(opts.attemptDir, 'copilot-mcp.json');
  const usagePath = join(opts.attemptDir, 'copilot-usage.json');
  const serverPath = fileURLToPath(new URL('./copilotMcpServer.js', import.meta.url));

  const bootstrap: CopilotMcpBootstrap = {
    config,
    context,
    cwd: opts.cwd,
    attemptDir: opts.attemptDir,
    runId: opts.runId,
    statePath,
    progressPath,
  };
  await writeFile(bootstrapPath, JSON.stringify(bootstrap));

  const playwright = mcpServerCommand('npx', [
    '@playwright/mcp@latest',
    '--isolated',
    '--headless',
    '--browser', 'chromium',
    '--snapshot-mode', 'none',
    '--output-dir', join(opts.attemptDir, 'playwright'),
    '--timeout-navigation', '15000',
  ]);
  await writeFile(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        greenproof: {
          type: 'stdio',
          command: process.execPath,
          args: [serverPath, '--bootstrap', bootstrapPath],
          cwd: opts.cwd,
          tools: ['*'],
        },
        playwright: {
          type: 'stdio',
          command: playwright.command,
          args: playwright.args,
          cwd: opts.cwd,
          tools: ['*'],
        },
      },
    }),
  );

  const prompt = `${authorSystemPrompt(config, context)}\n\n${buildAuthorPrompt(context)}`;
  const copilotCommand = config.model.copilot?.command ?? 'copilot';
  const rawArgs = copilotArgs(config, prompt, mcpConfigPath, usagePath, context);
  const spawned = spawnArgv(copilotCommand, rawArgs);
  const startedAt = Date.now();
  let partialLine = '';
  let lastProgressOffset = 0;
  let progressBusy = false;

  const processEvent = (line: string): void => {
    try {
      const event = JSON.parse(line) as CopilotEvent;
      const type = eventType(event);
      if (type === 'assistant.turn_start') {
        state.turns += 1;
        state.turnsByPhase[state.phase] += 1;
        emitTurn(state, config, context, opts.runId, startedAt, opts.onProgress);
      }
    } catch {
      /* Copilot may emit a human-readable line despite JSONL mode. Keep it in transcript. */
    }
  };

  const onStdout = (chunk: string): void => {
    appendFileSync(messagesPath, chunk);
    partialLine += chunk;
    const lines = partialLine.split(/\r?\n/);
    partialLine = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) processEvent(line);
  };
  const onStderr = (chunk: string): void => {
    appendFileSync(messagesPath, `{"stream":"stderr","text":${JSON.stringify(chunk)}}\n`);
  };

  const progressTimer = setInterval(async () => {
    if (!opts.onProgress || progressBusy) return;
    progressBusy = true;
    try {
      const content = await readFile(progressPath, 'utf8').catch(() => '');
      const fresh = content.slice(lastProgressOffset);
      lastProgressOffset = content.length;
      for (const line of fresh.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { opts.onProgress(JSON.parse(line) as Parameters<ProgressSink>[0]); } catch { /* partial line */ }
      }
    } finally {
      progressBusy = false;
    }
  }, 250);
  progressTimer.unref();

  const outcome = await runToCompletion(spawned.command, spawned.args, {
    cwd: opts.cwd,
    env: process.env,
    timeoutMs: config.caps.maxTimeMinutes * 60_000,
    firstOutputTimeoutMs: config.caps.firstTurnTimeoutMinutes * 60_000,
    ...spawned.options,
    onStdout,
    onStderr,
  });
  clearInterval(progressTimer);
  if (partialLine.trim()) processEvent(partialLine);

  if (outcome.spawnError) throw new Error(`Nie mogę uruchomić Copilot CLI: ${outcome.spawnError.message}`);
  const observedTurns = state.turns;
  const observedTurnsByPhase = { ...state.turnsByPhase };
  const snapshot = await readAuthorSessionState(statePath);
  if (snapshot) restoreAuthorSessionState(state, snapshot);
  state.turns = Math.max(state.turns, observedTurns);
  for (const phase of ['arrange', 'act', 'assert'] as const) {
    state.turnsByPhase[phase] = Math.max(state.turnsByPhase[phase], observedTurnsByPhase[phase]);
  }

  const costUsdSdk = await readCopilotCost(usagePath);
  const resultSubtype = outcome.timedOut ? 'aborted' : outcome.exitCode === 0 ? 'success' : 'error_during_execution';
  let cappedBy: BlockedReason | undefined = state.interruptReason;
  if (outcome.timedOutBeforeOutput) cappedBy = 'infra';
  else if (outcome.timedOut) cappedBy ??= 'time';

  const structured: FinishInfo | undefined = state.finish;
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