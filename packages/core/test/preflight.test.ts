import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { runPreflight } from '../src/preflight/check.js';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import { EnvSecrets } from '@greenproof/testing';

/** Fake endpoint Anthropic: tryb sterowany nagłówkiem modelu w body. */
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; tools?: unknown[]; max_tokens?: number };
      const respond = (code: number, json: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (body.model === 'broken') return respond(400, { error: 'invalid model' });
      if (body.tools && body.model === 'no-tools') {
        // Mostek, który "odpowiada", ale gubi tool-calling.
        return respond(200, { content: [{ type: 'text', text: 'status ok' }] });
      }
      if (body.tools && body.model === 'myslacy') {
        // Model z rozumowaniem: przy ciasnym budżecie tokenów całość idzie na
        // myślenie i odpowiedź wraca PUSTA - dokładnie tak wyglądał fałszywy
        // negatyw preflightu na qwen36-27b-mtp (128 tokenów).
        return (body.max_tokens ?? 0) >= 512
          ? respond(200, { content: [{ type: 'tool_use', id: 't1', name: 'get_status', input: {} }] })
          : respond(200, { stop_reason: 'end_turn', content: [] });
      }
      if (body.tools) {
        return respond(200, {
          content: [{ type: 'tool_use', id: 't1', name: 'get_status', input: {} }],
        });
      }
      return respond(200, { content: [{ type: 'text', text: 'pong' }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(() => server.close());

function makeConfig(model: string) {
  return GreenproofConfigSchema.parse({
    platform: 'x',
    plan: { source: 'json' },
    model: { authTokenEnv: 'T', author: model, baseUrl: `http://127.0.0.1:${port}` },
    paths: { testsRepoDir: '/tmp/x' },
  });
}

const secrets = new EnvSecrets(new Map([['T', 'sekret']]));

describe('preflight', () => {
  it('zdrowy endpoint: ping + tool_use → ok', async () => {
    const r = await runPreflight(makeConfig('dobry'), secrets);
    expect(r.ping.ok).toBe(true);
    expect(r.toolUse.ok).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('endpoint bez tool-callingu → ok=false z czytelnym powodem', async () => {
    const r = await runPreflight(makeConfig('no-tools'), secrets);
    expect(r.ping.ok).toBe(true);
    expect(r.toolUse.ok).toBe(false);
    expect(r.toolUse.error).toMatch(/tool_use/);
    expect(r.ok).toBe(false);
  });

  it('błąd HTTP na pingu → ok=false, tool-check pominięty', async () => {
    const r = await runPreflight(makeConfig('broken'), secrets);
    expect(r.ping.ok).toBe(false);
    expect(r.ping.error).toMatch(/HTTP 400/);
    expect(r.toolUse.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('model z rozumowaniem: sonda ma budżet tokenów na myślenie PRZED tool_use', async () => {
    const wynik = await runPreflight(makeConfig('myslacy'), secrets);
    expect(wynik.toolUse.ok).toBe(true);
    expect(wynik.ok).toBe(true);
  });

  // Preset `litellm` zapisuje placeholder, bo aliasy bramy są instalacyjne.
  // Bez tej bramki run szedł do bramy z dosłownym „<model-z-bramy>" i wracał
  // surowym 400/404, po którym nie widać, że brakuje jednego pola w configu.
  it('niewypełniony placeholder modelu → ok=false z instrukcją, bez ruszania sieci', async () => {
    const wynik = await runPreflight(makeConfig('<model-z-bramy>'), secrets);
    expect(wynik.ok).toBe(false);
    expect(wynik.ping.error).toMatch(/placeholder/);
    expect(wynik.ping.error).toMatch(/grp models/);
    expect(wynik.ping.latencyMs).toBeUndefined();
  });
});
