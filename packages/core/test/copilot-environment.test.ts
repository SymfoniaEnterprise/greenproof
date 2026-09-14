/**
 * Regresja: `copilotEnvironment()` musi przekazać podprocesowi Copilot CLI
 * KOMPLETNE środowisko systemowe (na Windowsie brak bazy systemowej wieszał
 * `copilot --version` do timeoutu preflightu/sesji autora), wycinając wyłącznie
 * poświadczenia i kanały IPC Claude/Anthropic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { copilotEnvironment } from '../src/author/copilotEnvironment.js';

const SAVED = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, SAVED);
});

describe('copilotEnvironment', () => {
  it('przekazuje dowolne zmienne bazowe i tokeny copilota (nie tylko wąską allowlistę)', () => {
    // Klucze próbne o unikatowej nazwie - omijają case-insensitivity process.env
    // na Windowsie (SystemRoot vs SYSTEMROOT) i dowodzą passthrough dla zmiennych
    // spoza dawnej allowlisty.
    process.env['GP_SYS_PROBE'] = 'sys-value';
    process.env['GP_ANOTHER_PROBE'] = 'another';
    process.env['GH_TOKEN'] = 'gh-abc';
    process.env['COPILOT_GITHUB_TOKEN'] = 'cop-xyz';

    const env = copilotEnvironment();

    expect(env['GP_SYS_PROBE']).toBe('sys-value');
    expect(env['GP_ANOTHER_PROBE']).toBe('another');
    expect(env['GH_TOKEN']).toBe('gh-abc');
    expect(env['COPILOT_GITHUB_TOKEN']).toBe('cop-xyz');
  });

  it('wycina poświadczenia i IPC Claude/Anthropic', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-secret';
    process.env['ANTHROPIC_BASE_URL'] = 'https://example';
    process.env['CLAUDE_CODE_MESSAGING_TOKEN'] = 'tok';
    process.env['CLAUDE_EFFORT'] = 'high';
    process.env['CLAUDECODE'] = '1';

    const env = copilotEnvironment();

    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(env['CLAUDE_CODE_MESSAGING_TOKEN']).toBeUndefined();
    expect(env['CLAUDE_EFFORT']).toBeUndefined();
    expect(env['CLAUDECODE']).toBeUndefined();
  });

  it('pomija zmienne o wartości undefined', () => {
    delete process.env['DOES_NOT_EXIST_GP'];
    const env = copilotEnvironment();
    expect('DOES_NOT_EXIST_GP' in env).toBe(false);
  });
});
