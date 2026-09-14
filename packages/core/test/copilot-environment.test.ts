/**
 * Regresja: `copilotEnvironment()` musi przekazać podprocesowi Copilot CLI
 * KOMPLETNE środowisko systemowe (na Windowsie brak bazy systemowej wiesza
 * `copilot --version` do timeoutu preflightu/sesji autora), bez dziedziczenia
 * sekretów niezwiązanych z Copilotem.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { copilotEnvironment } from '../src/author/copilotEnvironment.js';

const SAVED = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, SAVED);
});

describe('copilotEnvironment', () => {
  it('przekazuje bazę systemową i jawnie dozwolone tokeny Copilota', () => {
    process.env['PATH'] = 'path-value';
    process.env['SystemRoot'] = 'system-root';
    process.env['GH_TOKEN'] = 'gh-abc';
    process.env['COPILOT_GITHUB_TOKEN'] = 'cop-xyz';
    process.env['LITELLM_KEY'] = 'litellm-secret';
    process.env['CLIPROXY_TOKEN'] = 'cliproxy-secret';

    const env = copilotEnvironment();

    expect(env['PATH']).toBe('path-value');
    const systemRootKey = Object.keys(env).find((key) => key.toUpperCase() === 'SYSTEMROOT');
    expect(systemRootKey === undefined ? undefined : env[systemRootKey]).toBe('system-root');
    expect(env['GH_TOKEN']).toBe('gh-abc');
    expect(env['COPILOT_GITHUB_TOKEN']).toBe('cop-xyz');
    expect(env['LITELLM_KEY']).toBeUndefined();
    expect(env['CLIPROXY_TOKEN']).toBeUndefined();
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

  it('fixture mode omits także credentials Copilota', () => {
    process.env['GH_TOKEN'] = 'gh-abc';
    process.env['GITHUB_TOKEN'] = 'github-abc';
    process.env['COPILOT_GITHUB_TOKEN'] = 'cop-xyz';

    const env = copilotEnvironment({ includeCopilotCredentials: false });

    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['COPILOT_GITHUB_TOKEN']).toBeUndefined();
  });

  it('porównuje nazwy zmiennych bez rozróżniania wielkości liter', () => {
    process.env['anthropic_lower_probe'] = 'secret';
    process.env['claude_lower_probe'] = 'secret';

    const env = copilotEnvironment();

    expect(env['anthropic_lower_probe']).toBeUndefined();
    expect(env['claude_lower_probe']).toBeUndefined();
  });

  it('pomija zmienne o wartości undefined', () => {
    delete process.env['DOES_NOT_EXIST_GP'];
    const env = copilotEnvironment();
    expect('DOES_NOT_EXIST_GP' in env).toBe(false);
  });
});
