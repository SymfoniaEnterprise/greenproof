import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FixtureSessionDeps, FixtureSessionOutput, FixtureSessionResult } from './fixtureSession.js';
import { fixturePrompt, fixtureSystemPrompt } from './fixtureSession.js';
import { emitProgress } from '../domain/progress.js';
import { copilotAutopilotContinueCap, copilotEnvironment, copilotRuntimeScriptPath, COPILOT_FIXTURE_SHELL_DENY_ARGS } from './copilotEnvironment.js';
import { priceCopilotUsage, readCopilotUsage } from './copilotUsage.js';
import { mcpServerCommand, runToCompletion, spawnArgv } from '../util/exec.js';

interface CopilotEvent { type?: unknown; event?: unknown; kind?: unknown }

function eventType(value: CopilotEvent): string {
  return String(value.type ?? value.event ?? value.kind ?? '').toLowerCase();
}

async function readFixtureState(path: string): Promise<FixtureSessionOutput | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as FixtureSessionOutput;
  } catch {
    return undefined;
  }
}

export async function runCopilotFixtureSession(
  deps: FixtureSessionDeps,
): Promise<FixtureSessionResult> {
  await mkdir(deps.attemptDir, { recursive: true });
  const messagesPath = join(deps.attemptDir, 'messages.jsonl');
  const statePath = join(deps.attemptDir, 'copilot-fixture-state.json');
  const bootstrapPath = join(deps.attemptDir, 'copilot-fixture-bootstrap.json');
  const mcpConfigPath = join(deps.attemptDir, 'copilot-fixture-mcp.json');
  const usagePath = join(deps.attemptDir, 'copilot-fixture-usage.json');
  const playwrightStatePath = join(deps.attemptDir, 'copilot-fixture-playwright-state.json');
  const playwrightBootstrapPath = join(deps.attemptDir, 'copilot-fixture-playwright-bootstrap.json');
  const fixtureServerPath = copilotRuntimeScriptPath(import.meta.url, 'copilotFixtureMcpServer');
  const playwrightProxyPath = copilotRuntimeScriptPath(import.meta.url, 'copilotPlaywrightMcpServer');
  await writeFile(bootstrapPath, JSON.stringify({ statePath, attemptDir: deps.attemptDir }));

  const playwright = mcpServerCommand('npx', [
    '@playwright/mcp@latest', '--isolated', '--headless', '--browser', 'chromium',
    '--snapshot-mode', 'none', '--output-dir', join(deps.attemptDir, 'playwright'),
  ]);
  await writeFile(
    playwrightBootstrapPath,
    JSON.stringify({
      command: playwright.command,
      args: playwright.args,
      cwd: deps.cwd,
      snapshotMaxChars: deps.config.caps.snapshotMaxChars,
      snapshotGating: deps.config.caps.snapshotGating,
      includeCopilotCredentials: false,
      playwrightStatePath,
    }),
  );
  await writeFile(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        'greenproof-fixture': {
          type: 'stdio',
          command: process.execPath,
          args: [fixtureServerPath, '--bootstrap', bootstrapPath],
          cwd: deps.cwd,
          tools: ['*'],
        },
        playwright: {
          type: 'stdio',
          command: process.execPath,
          args: [playwrightProxyPath, '--bootstrap', playwrightBootstrapPath],
          cwd: deps.cwd,
          tools: ['*'],
        },
      },
    }),
  );

  const prompt = `${fixtureSystemPrompt(deps.context)}\n\nNa końcu wywołaj narzędzie greenproof-fixture-finish_fixture (status + fixturePath + verifyScriptPath + covers), a potem zakończ turę.\n\n${fixturePrompt(deps.context)}`;
  const cli = deps.config.model.copilot;
  const args = [
    `--model=${deps.config.model.fixtureAuthor?.model ?? deps.config.model.author}`,
    '--mode=autopilot',
    '--allow-tool=write',
    '--allow-tool=greenproof-fixture',
    '--allow-tool=playwright',
    '--allow-tool=shell',
    ...COPILOT_FIXTURE_SHELL_DENY_ARGS,
    '--excluded-tools=task,web_fetch',
    '--disable-builtin-mcps',
    '--no-ask-user', '--no-auto-update', '--no-color', '--no-remote', '--no-remote-export',
    '--allow-all-mcp-server-instructions',
    '--output-format=json', '--stream=on', '--silent',
    `--additional-mcp-config=@${mcpConfigPath}`,
    `--usage-output-file=${usagePath}`,
  ];
  try {
    args.push(`--allow-url=${new URL(deps.context.envUrl).origin}`);
  } catch {
    /* The application URL is validated by the pipeline before this session. */
  }
  if (cli?.maxAiCredits !== undefined) args.push(`--max-ai-credits=${cli.maxAiCredits}`);
  args.push(
    `--max-autopilot-continues=${copilotAutopilotContinueCap(deps.config.caps.fixtureSession.maxTurns, cli?.maxAutopilotContinues)}`,
  );
  args.push('-p', prompt);

  const spawned = spawnArgv(cli?.command ?? 'copilot', args);
  const controller = new AbortController();
  const started = Date.now();
  const fixtureModel = deps.config.model.fixtureAuthor?.model ?? deps.config.model.author;
  let cappedBy: 'time' | 'infra' | 'turns' | 'budget' | undefined;
  let costUsd = 0;
  let usageBusy = false;
  let turns = 0;
  let firstTurnSeen = false;
  let partialLine = '';
  const onStdout = (chunk: string): void => {
    appendFileSync(messagesPath, chunk);
    partialLine += chunk;
    const lines = partialLine.split(/\r?\n/);
    partialLine = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const type = eventType(JSON.parse(line) as CopilotEvent);
        if (type === 'assistant.turn_start') {
          firstTurnSeen = true;
          turns += 1;
          emitProgress(deps.onProgress, {
            kind: 'turn',
            runId: deps.runId,
            at: new Date().toISOString(),
            caseId: deps.context.caseId,
            attempt: deps.attempt,
            phase: 'fixture',
            turns,
            maxTurns: deps.config.caps.fixtureSession.maxTurns,
            elapsedSec: Math.round((Date.now() - started) / 1000),
            maxTimeSec: deps.config.caps.fixtureSession.maxTimeMinutes * 60,
            costUsd,
            maxCostUsd: deps.config.caps.fixtureSession.maxCostUsd,
          });
          if (turns >= deps.config.caps.fixtureSession.maxTurns) {
            cappedBy ??= 'turns';
            controller.abort();
          }
        }
      } catch { /* human-readable CLI line */ }
    }
  };
  const onStderr = (chunk: string): void => {
    appendFileSync(messagesPath, `{"stream":"stderr","text":${JSON.stringify(chunk)}}\n`);
  };
  const usageTimer = setInterval(async () => {
    if (usageBusy || controller.signal.aborted) return;
    usageBusy = true;
    try {
      const usage = await readCopilotUsage(usagePath);
      costUsd = Math.max(costUsd, priceCopilotUsage(deps.config, usage, fixtureModel));
      if (costUsd > deps.config.caps.fixtureSession.maxCostUsd) {
        cappedBy ??= 'budget';
        controller.abort();
      }
    } finally {
      usageBusy = false;
    }
  }, 250);
  usageTimer.unref();
  const outcome = await runToCompletion(spawned.command, spawned.args, {
    cwd: deps.cwd,
    env: copilotEnvironment({ includeCopilotCredentials: false }),
    timeoutMs: deps.config.caps.fixtureSession.maxTimeMinutes * 60_000,
    firstOutputTimeoutMs: deps.config.caps.firstTurnTimeoutMinutes * 60_000,
    firstOutputReady: () => firstTurnSeen,
    abortSignal: controller.signal,
    ...spawned.options,
    onStdout,
    onStderr,
  });
  clearInterval(usageTimer);
  const usage = await readCopilotUsage(usagePath);
  costUsd = Math.max(costUsd, priceCopilotUsage(deps.config, usage, fixtureModel));
  if (costUsd > deps.config.caps.fixtureSession.maxCostUsd) cappedBy ??= 'budget';
  const structured = await readFixtureState(statePath);
  if (outcome.timedOutBeforeOutput) cappedBy = 'infra';
  else if (outcome.timedOut) cappedBy ??= 'time';
  if (outcome.spawnError) throw new Error(`Nie mogę uruchomić Copilot CLI dla fixture-authora: ${outcome.spawnError.message}`);
  const cleanExit = outcome.exitCode === 0 && outcome.signal === null && !outcome.timedOut && cappedBy === undefined;
  return {
    resultSubtype: outcome.timedOut || cappedBy !== undefined ? 'aborted' : outcome.exitCode === 0 ? 'success' : 'error_during_execution',
    ...(cappedBy !== undefined ? { cappedBy } : {}),
    ...(cleanExit && structured !== undefined ? { structured } : {}),
    costUsd,
    turns,
    messagesPath,
  };
}