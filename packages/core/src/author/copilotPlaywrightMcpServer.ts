import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { copilotEnvironment } from './copilotEnvironment.js';
import { NON_MUTATING_BROWSER_TOOLS, truncateToolResponse } from './hooks.js';

interface PlaywrightBootstrap {
  command: string;
  args: string[];
  cwd: string;
  snapshotMaxChars: number;
  snapshotGating: 'warn' | 'enforce';
  authorStatePath?: string;
  playwrightStatePath: string;
}

interface PlaywrightState {
  pageChangedSinceSnapshot: boolean;
  snapshotGateHits: number;
}

function text(message: string, isError = false) {
  return { content: [{ type: 'text' as const, text: message }], ...(isError ? { isError: true } : {}) };
}

async function readBootstrap(): Promise<PlaywrightBootstrap> {
  const index = process.argv.indexOf('--bootstrap');
  const path = index >= 0 ? process.argv[index + 1] : undefined;
  if (!path) throw new Error('Brak argumentu --bootstrap dla Copilot Playwright MCP proxy');
  return JSON.parse(await readFile(path, 'utf8')) as PlaywrightBootstrap;
}

async function isFuseTripped(path: string | undefined): Promise<boolean> {
  if (path === undefined) return false;
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as { fuseTripped?: unknown };
    return state.fuseTripped === true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const bootstrap = await readBootstrap();
  let state: PlaywrightState = { pageChangedSinceSnapshot: true, snapshotGateHits: 0 };
  const persist = async (): Promise<void> => {
    await writeFile(bootstrap.playwrightStatePath, JSON.stringify(state, null, 2));
  };

  const upstreamTransport = new StdioClientTransport({
    command: bootstrap.command,
    args: bootstrap.args,
    cwd: bootstrap.cwd,
    env: copilotEnvironment(),
    stderr: 'ignore',
  });
  const client = new Client({ name: 'greenproof-copilot-playwright-proxy', version: '0.1.0' });
  await client.connect(upstreamTransport);
  const listedTools = await client.listTools();

  const server = new Server(
    { name: 'greenproof-copilot-playwright-proxy', version: '0.1.0' },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => listedTools);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    if (await isFuseTripped(bootstrap.authorStatePath)) {
      return text('Bezpiecznik seedu przerwał pracę - zakończ sesję narzędziem finish ze statusem blocked.', true);
    }
    if (toolName === 'browser_snapshot' && !state.pageChangedSinceSnapshot) {
      state.snapshotGateHits += 1;
      await persist();
      if (bootstrap.snapshotGating === 'enforce') {
        return text(
          'Strona nie zmieniła się od ostatniego snapshotu - użyj celowanego narzędzia browser_find albo browser_verify_*. ',
          true,
        );
      }
    }

    try {
      const result = await client.callTool({ name: toolName, arguments: request.params.arguments });
      if (toolName === 'browser_snapshot') {
        state.pageChangedSinceSnapshot = false;
      } else if (!NON_MUTATING_BROWSER_TOOLS.has(toolName)) {
        state.pageChangedSinceSnapshot = true;
      }
      await persist();
      return (truncateToolResponse(result, bootstrap.snapshotMaxChars) ?? result) as never;
    } catch (error) {
      await persist();
      throw error;
    }
  });

  await persist();
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`greenproof Playwright MCP proxy error: ${String(error)}\n`);
  process.exitCode = 1;
});