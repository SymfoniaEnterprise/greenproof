import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { FixtureSessionDeps, FixtureSessionOutput, FixtureSessionResult } from './fixtureSession.js';
import { fixturePrompt, fixtureSystemPrompt } from './fixtureSession.js';
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
  const fixtureServerPath = fileURLToPath(new URL('./copilotFixtureMcpServer.js', import.meta.url));
  await writeFile(bootstrapPath, JSON.stringify({ statePath }));

  const playwright = mcpServerCommand('npx', [
    '@playwright/mcp@latest', '--isolated', '--headless', '--browser', 'chromium',
    '--snapshot-mode', 'none', '--output-dir', join(deps.attemptDir, 'playwright'),
  ]);
  await writeFile(mcpConfigPath, JSON.stringify({
    mcpServers: {
      'greenproof-fixture': {
        type: 'stdio',
        command: process.execPath,
        args: [fixtureServerPath, '--bootstrap', bootstrapPath],
        cwd: deps.cwd,
        tools: ['*'],
      },
      playwright: { type: 'stdio', command: playwright.command, args: playwright.args, cwd: deps.cwd, tools: ['*'] },
    },
  }));

  const prompt = `${fixtureSystemPrompt(deps.context)}\n\nNa końcu wywołaj narzędzie greenproof-fixture-finish_fixture (status + fixturePath + verifyScriptPath + covers), a potem zakończ turę.\n\n${fixturePrompt(deps.context)}`;
  const cli = deps.config.model.copilot;
  const args = [
    `--model=${deps.config.model.fixtureAuthor?.model ?? deps.config.model.author}`,
    '--mode=autopilot',
    '--allow-tool=write',
    '--allow-tool=greenproof-fixture',
    '--allow-tool=playwright',
    '--allow-tool=shell',
    '--deny-tool=shell(git push)',
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
  if (cli?.maxAutopilotContinues !== undefined) args.push(`--max-autopilot-continues=${cli.maxAutopilotContinues}`);
  args.push('-p', prompt);

  const spawned = spawnArgv(cli?.command ?? 'copilot', args);
  let turns = 0;
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
        if (type === 'assistant.turn_start') turns += 1;
      } catch { /* human-readable CLI line */ }
    }
  };
  const onStderr = (chunk: string): void => {
    appendFileSync(messagesPath, `{"stream":"stderr","text":${JSON.stringify(chunk)}}\n`);
  };
  const outcome = await runToCompletion(spawned.command, spawned.args, {
    cwd: deps.cwd,
    env: process.env,
    timeoutMs: deps.config.caps.fixtureSession.maxTimeMinutes * 60_000,
    firstOutputTimeoutMs: deps.config.caps.firstTurnTimeoutMinutes * 60_000,
    ...spawned.options,
    onStdout,
    onStderr,
  });
  const structured = await readFixtureState(statePath);
  const cappedBy = outcome.timedOutBeforeOutput ? 'infra' : outcome.timedOut ? 'time' : undefined;
  if (outcome.spawnError) throw new Error(`Nie mogę uruchomić Copilot CLI dla fixture-authora: ${outcome.spawnError.message}`);
  return {
    resultSubtype: outcome.timedOut ? 'aborted' : outcome.exitCode === 0 ? 'success' : 'error_during_execution',
    ...(cappedBy !== undefined ? { cappedBy } : {}),
    ...(structured !== undefined ? { structured } : {}),
    costUsd: 0,
    turns,
    messagesPath,
  };
}