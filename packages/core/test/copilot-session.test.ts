import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvSecrets, TestLogger } from '@greenproof/testing';
import { runCopilotFixtureSession } from '../src/author/copilotFixtureSession.js';
import { runCopilotAuthorSession } from '../src/author/copilotSession.js';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import type { CaseContext } from '../src/steps/triage.js';
import type { FixtureContext } from '../src/author/fixtureSession.js';

const FAKE_COPILOT = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const configArg = process.argv.find((arg) => arg.startsWith('--additional-mcp-config=@'));
if (!configArg) throw new Error('missing MCP config');
const config = JSON.parse(readFileSync(configArg.slice('--additional-mcp-config=@'.length), 'utf8'));
const serverName = config.mcpServers.greenproof ? 'greenproof' : 'greenproof-fixture';
const greenproof = config.mcpServers[serverName];
const bootstrapArg = greenproof.args.indexOf('--bootstrap');
const bootstrap = JSON.parse(readFileSync(greenproof.args[bootstrapArg + 1], 'utf8'));
if (serverName === 'greenproof-fixture') {
  writeFileSync(
    join(bootstrap.attemptDir, 'fake-copilot-env.json'),
    JSON.stringify({ copilotGithubToken: process.env.COPILOT_GITHUB_TOKEN ?? null }),
  );
}
const mode = bootstrap.attemptDir ? readFileSync(join(bootstrap.attemptDir, 'fake-mode'), 'utf8').trim() : 'success';
const usageArg = process.argv.find((arg) => arg.startsWith('--usage-output-file='));
const finishArguments = serverName === 'greenproof'
  ? { status: 'delivered', specPath: 'tests/e2e/fake.spec.ts' }
  : {
      status: 'delivered',
      name: 'fakeFixture',
      fixturePath: 'tests/support/fixtures/fake.ts',
      verifyScriptPath: 'tests/support/fixtures/fake.verify.mjs',
      covers: ['fake'],
    };
const server = spawn(greenproof.command, greenproof.args, {
  cwd: greenproof.cwd,
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buffer = '';
let sentFinish = false;
const send = (message) => server.stdin.write(JSON.stringify(message) + '\n');
const finish = () => {
  if (sentFinish) return;
  sentFinish = true;
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: serverName === 'greenproof' ? 'finish' : 'finish_fixture', arguments: finishArguments },
  });
};
server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      finish();
    } else if (message.id === 2) {
      if (usageArg) {
        writeFileSync(
          usageArg.slice('--usage-output-file='.length),
          JSON.stringify({ total_cost_usd: serverName === 'greenproof-fixture' ? 0.25 : 0.75 }),
        );
      }
      process.stdout.write(JSON.stringify({ type: 'assistant.turn_start' }) + '\n');
      server.stdin.end();
      server.kill();
      process.exit(mode === 'error' ? 2 : 0);
    }
  }
});
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fake-copilot', version: '0.1.0' },
  },
});
`;

function context(): CaseContext {
  return {
    case: {
      caseId: 'E2E-FAKE-1',
      title: 'fake case',
      level: 'e2e',
      priority: 'P1',
      requirements: ['fake'],
      flows: ['fake'],
    },
    envUrl: 'http://127.0.0.1:9',
    branch: 'author/E2E-FAKE-1',
    attempt: 1,
    inventory: [],
    uiTraps: [],
    appMapViews: [],
    churnProne: false,
    oracleFiles: [],
  };
}

async function makeLauncher(root: string): Promise<string> {
  const script = join(root, 'fake-copilot.mjs');
  await writeFile(script, FAKE_COPILOT, { mode: 0o755 });
  return script;
}

async function runFake(mode: 'success' | 'error', launcher: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'gp-copilot-repo-'));
  const attemptDir = await mkdtemp(join(tmpdir(), 'gp-copilot-attempt-'));
  await mkdir(join(cwd, 'tests/e2e'), { recursive: true });
  await writeFile(join(attemptDir, 'fake-mode'), mode);
  const config = GreenproofConfigSchema.parse({
    platform: 'fake',
    plan: { source: 'json' },
    model: {
      driver: 'copilot-cli',
      authTokenEnv: 'IGNORED',
      author: 'fake-model',
      copilot: { command: launcher },
    },
    caps: { maxTurns: 5, maxTimeMinutes: 1, firstTurnTimeoutMinutes: 1 },
    paths: { testsRepoDir: cwd },
  });
  return runCopilotAuthorSession({
    config,
    context: context(),
    secrets: new EnvSecrets(),
    logger: new TestLogger(),
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    cwd,
    attemptDir,
    runId: 'r-copilot-test',
  });
}

function fixtureContext(): FixtureContext {
  return {
    caseId: 'E2E-FAKE-FIXTURE',
    flows: ['fake'],
    envUrl: 'http://127.0.0.1:9',
    failedStrategies: [],
    appMapViews: [],
    uiTraps: [],
    inventory: [],
    fixturesDir: 'tests/support/fixtures',
  };
}

async function runFixtureFake(mode: 'success' | 'error', launcher: string, maxCostUsd = 1) {
  const cwd = await mkdtemp(join(tmpdir(), 'gp-copilot-fixture-repo-'));
  const attemptDir = await mkdtemp(join(tmpdir(), 'gp-copilot-fixture-attempt-'));
  await writeFile(join(attemptDir, 'fake-mode'), mode);
  const config = GreenproofConfigSchema.parse({
    platform: 'fake',
    plan: { source: 'json' },
    model: {
      driver: 'copilot-cli',
      authTokenEnv: 'IGNORED',
      author: 'fake-model',
      fixtureAuthor: { model: 'fake-fixture-model' },
      copilot: { command: launcher },
    },
    caps: {
      maxTurns: 5,
      maxTimeMinutes: 1,
      firstTurnTimeoutMinutes: 1,
      fixtureSession: { maxTurns: 5, maxTimeMinutes: 1, maxCostUsd },
    },
    paths: { testsRepoDir: cwd },
  });
  const result = await runCopilotFixtureSession({
    config,
    context: fixtureContext(),
    secrets: new EnvSecrets(),
    logger: new TestLogger(),
    cwd,
    attemptDir,
    runId: 'r-copilot-fixture-test',
    attempt: 0,
  });
  return { result, attemptDir };
}

describe('runCopilotAuthorSession - granica CLI/MCP', () => {
  it('przywraca finish z procesu potomnego po czystym wyjściu', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gp-fake-copilot-'));
    const launcher = await makeLauncher(root);
    const result = await runFake('success', launcher);

    expect(result.resultSubtype).toBe('success');
    expect(result.structured).toMatchObject({ status: 'delivered', specPath: 'tests/e2e/fake.spec.ts' });
    expect(result.state.turns).toBe(1);
    expect(result.state.costUsd).toBeCloseTo(0.75);
  });

  it('nie dostarcza finish, gdy CLI kończy się kodem niezerowym', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gp-fake-copilot-'));
    const launcher = await makeLauncher(root);
    const result = await runFake('error', launcher);

    expect(result.resultSubtype).toBe('error_during_execution');
    expect(result.structured).toBeUndefined();
    expect(result.state.finish?.status).toBe('delivered');
  });

  it('fixture-author odtwarza wynik i koszt z osobnego serwera MCP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gp-fake-copilot-'));
    const launcher = await makeLauncher(root);
    const { result } = await runFixtureFake('success', launcher);

    expect(result.resultSubtype).toBe('success');
    expect(result.costUsd).toBeCloseTo(0.25);
    expect(result.structured).toMatchObject({
      status: 'delivered',
      fixturePath: 'tests/support/fixtures/fake.ts',
    });
  });

  it('fixture-author nie dostarcza stanu po niezerowym wyjściu CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gp-fake-copilot-'));
    const launcher = await makeLauncher(root);
    const { result } = await runFixtureFake('error', launcher);

    expect(result.resultSubtype).toBe('error_during_execution');
    expect(result.structured).toBeUndefined();
    expect(result.costUsd).toBeCloseTo(0.25);
  });

  it('fixture-author klasyfikuje przekroczenie kosztu jako budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gp-fake-copilot-'));
    const launcher = await makeLauncher(root);
    const { result } = await runFixtureFake('success', launcher, 0.1);

    expect(result.resultSubtype).toBe('aborted');
    expect(result.cappedBy).toBe('budget');
    expect(result.structured).toBeUndefined();
  });

  it('fixture-author zachowuje token Copilota, a bootstrap Playwrighta go odcina', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gp-fake-copilot-'));
    const launcher = await makeLauncher(root);
    const previousToken = process.env.COPILOT_GITHUB_TOKEN;
    process.env.COPILOT_GITHUB_TOKEN = 'fixture-token';
    try {
      const { result, attemptDir } = await runFixtureFake('success', launcher);
      const childEnv = JSON.parse(await readFile(join(attemptDir, 'fake-copilot-env.json'), 'utf8')) as {
        copilotGithubToken?: string | null;
      };
      const playwrightBootstrap = JSON.parse(
        await readFile(join(attemptDir, 'copilot-fixture-playwright-bootstrap.json'), 'utf8'),
      ) as { includeCopilotCredentials?: boolean };

      expect(result.resultSubtype).toBe('success');
      expect(childEnv.copilotGithubToken).toBe('fixture-token');
      expect(playwrightBootstrap.includeCopilotCredentials).toBe(false);
    } finally {
      if (previousToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
      else process.env.COPILOT_GITHUB_TOKEN = previousToken;
    }
  });

});