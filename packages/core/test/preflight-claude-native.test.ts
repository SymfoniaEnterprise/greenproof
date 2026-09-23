import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvSecrets } from '@greenproof/testing';

/**
 * Tryb `claude-native` (brak authTokenEnv/baseUrl w configu): runPreflight
 * rozpoznaje ten warunek i deleguje do runClaudeNativePreflight, która NIE
 * pinguje sieci - sprawdza tylko binarkę `claude` (przez runToCompletion,
 * zmockowaną tu) i obecność ANTHROPIC_BASE_URL w ~/.claude/settings.json
 * (homedir() zmockowany na katalog tymczasowy tego testu).
 */
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHome };
});

vi.mock('../src/util/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/util/exec.js')>();
  return { ...actual, runToCompletion: (...args: Parameters<typeof actual.runToCompletion>) => mockRunToCompletion(...args) };
});

let mockHome = '';
let mockRunToCompletion: typeof import('../src/util/exec.js').runToCompletion = () => {
  throw new Error('mockRunToCompletion nieustawiony w tym teście');
};

async function claudeBinaryAvailable(): ReturnType<typeof import('../src/util/exec.js').runToCompletion> {
  return { exitCode: 0, signal: null, timedOut: false };
}

async function claudeBinaryMissing(): ReturnType<typeof import('../src/util/exec.js').runToCompletion> {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    spawnError: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException,
  };
}

const secrets = new EnvSecrets(new Map());

function makeConfig(overrides: { authTokenEnv?: string; baseUrl?: string } = {}) {
  return {
    platform: 'x',
    plan: { source: 'json' as const },
    model: { authTokenEnv: overrides.authTokenEnv ?? 'ANTHROPIC_AUTH_TOKEN', author: 'claude-sonnet-5-byok', ...overrides },
    paths: { testsRepoDir: '/tmp/x' },
  };
}

describe('preflight claude-native (HOME-inherited, brak baseUrl/token)', () => {
  afterEach(async () => {
    if (mockHome) await rm(mockHome, { recursive: true, force: true });
    mockHome = '';
  });

  it('binarka dostępna + settings.json ma ANTHROPIC_BASE_URL → ok', async () => {
    mockHome = await mkdtemp(join(tmpdir(), 'gp-claude-native-'));
    await mkdir(join(mockHome, '.claude'), { recursive: true });
    await writeFile(
      join(mockHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://ai-proxy.example.com' } }),
      'utf8',
    );
    mockRunToCompletion = claudeBinaryAvailable;

    const { runPreflight } = await import('../src/preflight/check.js');
    const { GreenproofConfigSchema } = await import('../src/schemas/index.js');
    const r = await runPreflight(GreenproofConfigSchema.parse(makeConfig()), secrets);

    expect(r.endpoint).toBe('claude-native');
    expect(r.ok).toBe(true);
    expect(r.ping.ok).toBe(true);
    expect(r.toolUse.error).toMatch(/sesji autora/);
  });

  it('binarka niedostępna → ok=false z czytelnym błędem', async () => {
    mockHome = await mkdtemp(join(tmpdir(), 'gp-claude-native-'));
    mockRunToCompletion = claudeBinaryMissing;

    const { runPreflight } = await import('../src/preflight/check.js');
    const { GreenproofConfigSchema } = await import('../src/schemas/index.js');
    const r = await runPreflight(GreenproofConfigSchema.parse(makeConfig()), secrets);

    expect(r.endpoint).toBe('claude-native');
    expect(r.ok).toBe(false);
    expect(r.ping.error).toMatch(/ENOENT/);
  });

  it('binarka dostępna, ale ~/.claude/settings.json brak ANTHROPIC_BASE_URL → ok=false z wyjaśnieniem', async () => {
    mockHome = await mkdtemp(join(tmpdir(), 'gp-claude-native-'));
    await mkdir(join(mockHome, '.claude'), { recursive: true });
    await writeFile(join(mockHome, '.claude', 'settings.json'), JSON.stringify({}), 'utf8');
    mockRunToCompletion = claudeBinaryAvailable;

    const { runPreflight } = await import('../src/preflight/check.js');
    const { GreenproofConfigSchema } = await import('../src/schemas/index.js');
    const r = await runPreflight(GreenproofConfigSchema.parse(makeConfig()), secrets);

    expect(r.ok).toBe(false);
    expect(r.ping.error).toMatch(/ANTHROPIC_BASE_URL/);
  });

  it('binarka dostępna, brak pliku settings.json → ok=false z wyjaśnieniem nieblokującym', async () => {
    mockHome = await mkdtemp(join(tmpdir(), 'gp-claude-native-'));
    mockRunToCompletion = claudeBinaryAvailable;

    const { runPreflight } = await import('../src/preflight/check.js');
    const { GreenproofConfigSchema } = await import('../src/schemas/index.js');
    const r = await runPreflight(GreenproofConfigSchema.parse(makeConfig()), secrets);

    expect(r.ok).toBe(false);
    expect(r.ping.error).toMatch(/Nie udało się odczytać/);
  });

  it('token I baseUrl ustawione → NIE trafia w ścieżkę claude-native (idzie generyczną, HTTP)', async () => {
    mockHome = await mkdtemp(join(tmpdir(), 'gp-claude-native-'));
    mockRunToCompletion = claudeBinaryAvailable;
    const tokenSecrets = new EnvSecrets(new Map([['ANTHROPIC_AUTH_TOKEN', 'sk-token']]));

    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stub' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const { runPreflight } = await import('../src/preflight/check.js');
      const { GreenproofConfigSchema } = await import('../src/schemas/index.js');
      const r = await runPreflight(
        GreenproofConfigSchema.parse(makeConfig({ baseUrl: `http://127.0.0.1:${port}` })),
        tokenSecrets,
      );

      // Endpoint generyczny (baseUrl configu), nie 'claude-native' - token
      // ustawiony wyklucza tryb HOME-inherited niezależnie od braku baseUrl
      // domyślnego. runToCompletion (binarka claude) NIE powinno być wołane
      // na tej ścieżce - to potwierdza, że dispatch faktycznie ominął
      // runClaudeNativePreflight, a nie że oba się zgadzają przypadkiem.
      expect(r.endpoint).toBe(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  });
});
