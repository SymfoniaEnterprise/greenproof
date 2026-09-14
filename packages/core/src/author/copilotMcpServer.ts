import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGreenproofTools } from './tools.js';
import { AuthorSessionState } from './state.js';
import type { CopilotMcpBootstrap, CopilotParentState } from './stateTransfer.js';
import { writeAuthorSessionState } from './stateTransfer.js';

async function loadBootstrap(): Promise<CopilotMcpBootstrap> {
  const index = process.argv.indexOf('--bootstrap');
  const path = index >= 0 ? process.argv[index + 1] : undefined;
  if (!path) throw new Error('Brak argumentu --bootstrap dla greenproof MCP server');
  return JSON.parse(await readFile(path, 'utf8')) as CopilotMcpBootstrap;
}

async function main(): Promise<void> {
  const bootstrap = await loadBootstrap();
  const state = new AuthorSessionState();

  const persist = async (): Promise<void> => {
    await writeAuthorSessionState(bootstrap.statePath, state);
  };
  const persistSync = (): void => {
    writeFileSync(
      bootstrap.statePath,
      JSON.stringify({ ...state, filesTouched: [...state.filesTouched] }, null, 2),
    );
  };

  const syncParentState = async (): Promise<void> => {
    if (bootstrap.parentStatePath === undefined) return;
    try {
      const parent = JSON.parse(await readFile(bootstrap.parentStatePath, 'utf8')) as CopilotParentState;
      state.turns = Math.max(state.turns, parent.turns);
      for (const phase of ['arrange', 'act', 'assert'] as const) {
        state.turnsByPhase[phase] = Math.max(state.turnsByPhase[phase], parent.turnsByPhase[phase] ?? 0);
      }
    } catch {
      /* The parent may not have written the first turn yet. */
    }
  };

  const onProgress = bootstrap.progressPath
    ? (event: unknown): void => {
        appendFileSync(bootstrap.progressPath!, `${JSON.stringify(event)}\n`);
      }
    : undefined;

  const definitions = createGreenproofTools({
    state,
    config: bootstrap.config,
    context: bootstrap.context,
    cwd: bootstrap.cwd,
    attemptDir: bootstrap.attemptDir,
    clock: { now: () => new Date() },
    runId: bootstrap.runId,
    ...(onProgress !== undefined ? { onProgress } : {}),
  });

  const server = new McpServer({ name: 'greenproof', version: '0.1.0' });
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description: string; inputSchema: Record<string, unknown> },
    handler: (args: unknown, extra: unknown) => Promise<unknown>,
  ) => unknown;
  for (const definition of definitions) {
    const handler = definition.handler as (
      args: unknown,
      extra: unknown,
    ) => Promise<unknown>;
    registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema as Record<string, unknown>,
      },
      async (args: unknown, extra: unknown) => {
        await syncParentState();
        if (state.fuseTripped && definition.name !== 'finish' && definition.name !== 'report_seed_attempt') {
          return {
            content: [{
              type: 'text' as const,
              text: 'Bezpiecznik seedu przerwał pracę - wywołaj narzędzie finish ze statusem blocked.',
            }],
          };
        }
        const result = await handler(args, extra);
        await persist();
        return result as never;
      },
    );
  }

  await persist();
  process.once('SIGTERM', () => {
    persistSync();
    process.exit(143);
  });
  process.once('SIGINT', () => {
    persistSync();
    process.exit(130);
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`greenproof MCP server error: ${String(error)}\n`);
  try {
    const index = process.argv.indexOf('--bootstrap');
    const path = index >= 0 ? process.argv[index + 1] : undefined;
    if (path) {
      const bootstrap = JSON.parse(readFileSync(path, 'utf8')) as CopilotMcpBootstrap;
      writeFileSync(bootstrap.statePath, JSON.stringify({ error: String(error) }));
    }
  } catch {
    /* The parent process reports the MCP startup failure. */
  }
  process.exitCode = 1;
});