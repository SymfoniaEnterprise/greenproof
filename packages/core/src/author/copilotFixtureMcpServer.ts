import { readFile, writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

interface FixtureBootstrap {
  statePath: string;
  attemptDir?: string;
}

interface FixtureState {
  status: 'delivered' | 'failed';
  name?: string;
  fixturePath?: string;
  verifyScriptPath?: string;
  description?: string;
  covers?: string[];
  notes?: string;
}

async function main(): Promise<void> {
  const index = process.argv.indexOf('--bootstrap');
  const bootstrapPath = index >= 0 ? process.argv[index + 1] : undefined;
  if (!bootstrapPath) throw new Error('Brak argumentu --bootstrap dla fixture MCP server');
  const bootstrap = JSON.parse(await readFile(bootstrapPath, 'utf8')) as FixtureBootstrap;
  const server = new McpServer({ name: 'greenproof-fixture', version: '0.1.0' });

  server.registerTool(
    'finish_fixture',
    {
      description: 'Formalnie zakończ sesję fixture-authora i zwróć wynik dostarczonego fixture.',
      inputSchema: {
        status: z.enum(['delivered', 'failed']),
        name: z.string().optional(),
        fixturePath: z.string().optional(),
        verifyScriptPath: z.string().optional(),
        description: z.string().optional(),
        covers: z.array(z.string()).optional(),
        notes: z.string().optional(),
      },
    },
    async (input) => {
      await writeFile(bootstrap.statePath, JSON.stringify(input, null, 2));
      return { content: [{ type: 'text', text: 'Przyjęto wynik fixture. Zakończ turę.' }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`greenproof fixture MCP server error: ${String(error)}\n`);
  process.exitCode = 1;
});