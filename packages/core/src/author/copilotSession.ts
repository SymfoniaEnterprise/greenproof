import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GreenproofConfig } from '../config/types.js';
import type { BlockedReason } from '../domain/state.js';
import type { AuthorPhase, TokenUsage } from '../domain/attempt.js';
import { emitProgress, type ProgressSink } from '../domain/progress.js';
import type { CaseContext } from '../steps/triage.js';
import { AuthorSessionState, type FinishInfo } from './state.js';
import { authorSystemPrompt, buildAuthorPrompt } from './prompt.js';
import {
  readAuthorSessionState,
  restoreAuthorSessionState,
  type CopilotMcpBootstrap,
} from './stateTransfer.js';
import { copilotAutopilotContinueCap, copilotEnvironment, copilotRuntimeScriptPath } from './copilotEnvironment.js';
import { mcpServerCommand, runToCompletion, spawnArgv } from '../util/exec.js';
import type { AuthorSessionOptions, AuthorSessionResult } from './session.js';

const execFileAsync = promisify(execFile);

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

interface CopilotUsage {
  costUsd: number;
  tokens: TokenUsage;
  modelUsage: Record<string, TokenUsage>;
}

function tokenUsage(value: unknown): TokenUsage {
  return {
    input: readNumeric(value, ['input_tokens', 'inputTokens']) ?? 0,
    output: readNumeric(value, ['output_tokens', 'outputTokens']) ?? 0,
    cacheRead: readNumeric(value, ['cache_read_input_tokens', 'cacheReadInputTokens']) ?? 0,
    cacheCreation: readNumeric(value, ['cache_creation_input_tokens', 'cacheCreationInputTokens']) ?? 0,
  };
}

function addTokens(target: TokenUsage, source: TokenUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheCreation += source.cacheCreation;
}

function parseCopilotUsage(value: unknown): CopilotUsage {
  const root = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const nestedUsage = root['usage'] ?? root['tokenUsage'];
  const tokens = tokenUsage(nestedUsage ?? root);
  const modelUsage: Record<string, TokenUsage> = {};
  const rawModelUsage = root['modelUsage'];
  if (rawModelUsage !== null && typeof rawModelUsage === 'object') {
    tokens.input = 0;
    tokens.output = 0;
    tokens.cacheRead = 0;
    tokens.cacheCreation = 0;
    for (const [model, usage] of Object.entries(rawModelUsage)) {
      const parsed = tokenUsage(usage);
      modelUsage[model] = parsed;
      addTokens(tokens, parsed);
    }
  }
  return {
    costUsd:
      readNumeric(root, ['total_cost_usd', 'costUsd', 'cost_usd']) ??
      readNumeric(nestedUsage, ['total_cost_usd', 'costUsd', 'cost_usd']) ??
      0,
    tokens,
    modelUsage,
  };
}

async function readCopilotUsage(path: string): Promise<CopilotUsage> {
  try {
    return parseCopilotUsage(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return { costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {} };
  }
}

function priceUsage(config: GreenproofConfig, usage: CopilotUsage): number {
  if (config.model.priceTable === undefined) return usage.costUsd;
  const per = 1 / 1_000_000;
  let cost = 0;
  for (const [model, tokens] of Object.entries(usage.modelUsage)) {
    const price = config.model.priceTable[model] ?? config.model.priceTable[config.model.author];
    if (!price) continue;
    cost +=
      tokens.input * price.inPerMTok * per +
      tokens.output * price.outPerMTok * per +
      tokens.cacheRead * (price.cacheReadPerMTok ?? price.inPerMTok * 0.1) * per +
      tokens.cacheCreation * (price.cacheWritePerMTok ?? price.inPerMTok * 1.25) * per;
  }
  if (Object.keys(usage.modelUsage).length === 0) {
    const price = config.model.priceTable[config.model.author];
    if (price) {
      cost =
        usage.tokens.input * price.inPerMTok * per +
        usage.tokens.output * price.outPerMTok * per +
        usage.tokens.cacheRead * (price.cacheReadPerMTok ?? price.inPerMTok * 0.1) * per +
        usage.tokens.cacheCreation * (price.cacheWritePerMTok ?? price.inPerMTok * 1.25) * per;
    }
  }
  return cost > 0 ? cost : usage.costUsd;
}

function phaseFromState(path: string, fallback: AuthorPhase): AuthorPhase {
  try {
    const phase = (JSON.parse(readFileSync(path, 'utf8')) as { phase?: unknown }).phase;
    return phase === 'arrange' || phase === 'act' || phase === 'assert' ? phase : fallback;
  } catch {
    return fallback;
  }
}

function syncChildSafetyState(path: string, state: AuthorSessionState): void {
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as {
      fuseTripped?: unknown;
      fuseTrippedAtTurn?: unknown;
      fuseNote?: unknown;
      seedConfirmed?: unknown;
    };
    if (typeof snapshot.fuseTripped === 'boolean') state.fuseTripped = snapshot.fuseTripped;
    if (typeof snapshot.fuseTrippedAtTurn === 'number') state.fuseTrippedAtTurn = snapshot.fuseTrippedAtTurn;
    if (typeof snapshot.fuseNote === 'string') state.fuseNote = snapshot.fuseNote;
    if (typeof snapshot.seedConfirmed === 'boolean') state.seedConfirmed = snapshot.seedConfirmed;
  } catch {
    /* The MCP server may not have persisted a snapshot for this turn yet. */
  }
}

function collectTouchedPaths(value: unknown, touched: Set<string>, depth = 0): void {
  if (depth > 5 || value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === 'string' &&
      /^(?:path|filePath|file_path|filename)$/i.test(key) &&
      !child.startsWith('http://') &&
      !child.startsWith('https://')
    ) {
      touched.add(child);
    } else if (child !== null && typeof child === 'object') {
      collectTouchedPaths(child, touched, depth + 1);
    }
  }
}

async function reconcileTouchedFiles(cwd: string, touched: Set<string>): Promise<void> {
  for (const args of [
    ['diff', '--name-only', 'HEAD', '--'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    try {
      const result = await execFileAsync('git', args, { cwd });
      for (const path of result.stdout.split(/\r?\n/)) if (path.trim()) touched.add(path.trim());
    } catch {
      /* The test repository may not expose git to the child environment. */
    }
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
  args.push(
    `--max-autopilot-continues=${copilotAutopilotContinueCap(config.caps.maxTurns, cli?.maxAutopilotContinues)}`,
  );
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
  const parentStatePath = join(opts.attemptDir, 'copilot-parent-state.json');
  const playwrightStatePath = join(opts.attemptDir, 'copilot-playwright-state.json');
  const playwrightBootstrapPath = join(opts.attemptDir, 'copilot-playwright-bootstrap.json');
  const serverPath = copilotRuntimeScriptPath(import.meta.url, 'copilotMcpServer');
  const playwrightProxyPath = copilotRuntimeScriptPath(import.meta.url, 'copilotPlaywrightMcpServer');

  const parentState = (): void => {
    try {
      writeFileSync(parentStatePath, JSON.stringify({ turns: state.turns, turnsByPhase: state.turnsByPhase }));
    } catch {
      /* The child will continue with its last synchronized state. */
    }
  };
  parentState();

  const bootstrap: CopilotMcpBootstrap = {
    config,
    context,
    cwd: opts.cwd,
    attemptDir: opts.attemptDir,
    runId: opts.runId,
    statePath,
    progressPath,
    parentStatePath,
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
    playwrightBootstrapPath,
    JSON.stringify({
      command: playwright.command,
      args: playwright.args,
      cwd: opts.cwd,
      snapshotMaxChars: config.caps.snapshotMaxChars,
      snapshotGating: config.caps.snapshotGating,
      authorStatePath: statePath,
      playwrightStatePath,
    }),
  );
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
          command: process.execPath,
          args: [playwrightProxyPath, '--bootstrap', playwrightBootstrapPath],
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
  const controller = new AbortController();
  const startedAt = Date.now();
  let partialLine = '';
  let lastProgressOffset = 0;
  let progressBusy = false;
  let firstTurnSeen = false;

  const processEvent = (line: string): void => {
    try {
      const event = JSON.parse(line) as CopilotEvent;
      const type = eventType(event);
      collectTouchedPaths(event, state.filesTouched);
      if (type === 'assistant.turn_start') {
        firstTurnSeen = true;
        syncChildSafetyState(statePath, state);
        state.turns += 1;
        const phase = phaseFromState(statePath, state.phase);
        state.phase = phase;
        state.turnsByPhase[phase] += 1;
        parentState();
        emitTurn(state, config, context, opts.runId, startedAt, opts.onProgress);
        if (state.turns >= config.caps.maxTurns) {
          state.interruptReason ??= 'turns';
          controller.abort();
        }
        if (
          state.fuseTripped &&
          state.fuseTrippedAtTurn !== undefined &&
          state.turns > state.fuseTrippedAtTurn + 3
        ) {
          state.interruptReason ??= 'fixture-gap';
          controller.abort();
        }
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

  let usageBusy = false;
  const usageTimer = config.model.priceTable === undefined
    ? undefined
    : setInterval(async () => {
        if (usageBusy || controller.signal.aborted) return;
        usageBusy = true;
        try {
          const usage = await readCopilotUsage(usagePath);
          const cost = priceUsage(config, usage);
          if (cost > state.costUsd) state.costUsd = cost;
          if (state.costUsd > config.caps.maxCostUsd) {
            state.interruptReason ??= 'budget';
            controller.abort();
          }
        } finally {
          usageBusy = false;
        }
      }, 250);
  usageTimer?.unref();

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
    env: copilotEnvironment(),
    timeoutMs: config.caps.maxTimeMinutes * 60_000,
    firstOutputTimeoutMs: config.caps.firstTurnTimeoutMinutes * 60_000,
    firstOutputReady: () => firstTurnSeen,
    abortSignal: controller.signal,
    ...spawned.options,
    onStdout,
    onStderr,
  });
  if (usageTimer !== undefined) clearInterval(usageTimer);
  clearInterval(progressTimer);
  if (partialLine.trim()) processEvent(partialLine);

  if (outcome.spawnError) throw new Error(`Nie mogę uruchomić Copilot CLI: ${outcome.spawnError.message}`);
  const observedTurns = state.turns;
  const observedTurnsByPhase = { ...state.turnsByPhase };
  const observedFiles = new Set(state.filesTouched);
  const parentInterruptReason = state.interruptReason;
  const snapshot = await readAuthorSessionState(statePath);
  if (snapshot) restoreAuthorSessionState(state, snapshot);
  for (const path of observedFiles) state.filesTouched.add(path);
  state.turns = Math.max(state.turns, observedTurns);
  for (const phase of ['arrange', 'act', 'assert'] as const) {
    state.turnsByPhase[phase] = Math.max(state.turnsByPhase[phase], observedTurnsByPhase[phase]);
  }
  if (parentInterruptReason !== undefined) state.interruptReason = parentInterruptReason;
  try {
    const playwrightState = JSON.parse(await readFile(playwrightStatePath, 'utf8')) as {
      pageChangedSinceSnapshot?: unknown;
      snapshotGateHits?: unknown;
    };
    if (typeof playwrightState.pageChangedSinceSnapshot === 'boolean') {
      state.pageChangedSinceSnapshot = playwrightState.pageChangedSinceSnapshot;
    }
    if (typeof playwrightState.snapshotGateHits === 'number') {
      state.snapshotGateHits = Math.max(state.snapshotGateHits, playwrightState.snapshotGateHits);
    }
  } catch {
    /* The proxy may not have started when Copilot failed during bootstrap. */
  }
  await reconcileTouchedFiles(opts.cwd, state.filesTouched);

  const usage = await readCopilotUsage(usagePath);
  if (usage.tokens.input + usage.tokens.output + usage.tokens.cacheRead + usage.tokens.cacheCreation > 0) {
    state.tokens = usage.tokens;
  }
  if (config.model.priceTable !== undefined) {
    state.costUsd = Math.max(state.costUsd, priceUsage(config, usage));
    if (state.costUsd > config.caps.maxCostUsd) state.interruptReason ??= 'budget';
  }
  const costUsdSdk = usage.costUsd;
  const resultSubtype = outcome.timedOut
    ? 'aborted'
    : state.interruptReason !== undefined
      ? 'aborted'
      : outcome.exitCode === 0
        ? 'success'
        : 'error_during_execution';
  let cappedBy: BlockedReason | undefined = state.interruptReason;
  if (outcome.timedOutBeforeOutput) cappedBy = 'infra';
  else if (outcome.timedOut) cappedBy ??= 'time';

  const cleanExit = outcome.exitCode === 0 && outcome.signal === null && !outcome.timedOut && outcome.spawnError === undefined;
  const structured: FinishInfo | undefined = cleanExit && cappedBy === undefined ? state.finish : undefined;
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