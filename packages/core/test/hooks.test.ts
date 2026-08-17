import { describe, expect, it } from 'vitest';
import { TestLogger } from '@greenproof/testing';
import { buildAuthorHooks, truncateToolResponse } from '../src/author/hooks.js';
import { AuthorSessionState } from '../src/author/state.js';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import type { GreenproofConfig } from '../src/config/types.js';

function makeConfig(overrides?: {
  snapshotGating?: 'warn' | 'enforce';
  maxPlaywrightRuns?: number;
  enforceRunPlaywrightTool?: boolean;
}): GreenproofConfig {
  return GreenproofConfigSchema.parse({
    platform: '@greenproof/adapter-fs',
    plan: { source: 'json' },
    model: { authTokenEnv: 'TOKEN', author: 'test-model' },
    paths: { testsRepoDir: '/tmp/x' },
    caps: {
      maxPlaywrightRuns: overrides?.maxPlaywrightRuns ?? 2,
      ...(overrides?.snapshotGating !== undefined ? { snapshotGating: overrides.snapshotGating } : {}),
      ...(overrides?.enforceRunPlaywrightTool !== undefined
        ? { enforceRunPlaywrightTool: overrides.enforceRunPlaywrightTool }
        : {}),
    },
  });
}

async function callPre(hooks: ReturnType<typeof buildAuthorHooks>, toolName: string, toolInput: unknown) {
  const cb = hooks.PreToolUse![0]!.hooks[0]!;
  return cb(
    { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '/' } as never,
    't1',
    { signal: new AbortController().signal },
  );
}

async function callPost(hooks: ReturnType<typeof buildAuthorHooks>, toolName: string, toolInput: unknown, toolResponse: unknown) {
  const cb = hooks.PostToolUse![0]!.hooks[0]!;
  return cb(
    { hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: toolInput, tool_response: toolResponse, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '/' } as never,
    't1',
    { signal: new AbortController().signal },
  );
}

function decisionOf(out: unknown): string | undefined {
  return (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision;
}

describe('egzekwowanie narzędzia run_playwright (domyślnie włączone)', () => {
  it('każda forma `playwright test` z Basha jest deny i NIE rusza liczników', async () => {
    const state = new AuthorSessionState();
    const hooks = buildAuthorHooks(state, makeConfig(), new TestLogger());
    state.markPhase('assert');

    for (const command of [
      'npx playwright test',
      'playwright test --reporter=json',
      'pnpm exec playwright test specs/pay.spec.ts',
      'pnpm playwright test',
      './node_modules/.bin/playwright test --grep netto',
      'yarn playwright test',
      'cd apps/web && npx playwright test',
      'node node_modules/@playwright/test/cli.js test',
      'node ./node_modules/@playwright/test/cli.mjs test --grep netto',
      'npx @playwright/test test',
      // Skrypty pakietowe wołają playwright pośrednio - też deny przy egzekwowaniu.
      'npm test',
      'pnpm test',
      'yarn run test:e2e',
    ]) {
      const out = await callPre(hooks, 'Bash', { command });
      expect(decisionOf(out), command).toBe('deny');
      expect(
        (out as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput
          .permissionDecisionReason,
      ).toContain('mcp__greenproof__run_playwright');
    }
    // Budżet prowadzi wyłącznie narzędzie procesowe - hook niczego nie liczy.
    expect(state.playwrightRunsByPhase.assert).toBe(0);
  });

  it('komendy niebędące uruchomieniem testów przechodzą', async () => {
    const state = new AuthorSessionState();
    const hooks = buildAuthorHooks(state, makeConfig(), new TestLogger());
    expect(decisionOf(await callPre(hooks, 'Bash', { command: 'npx playwright install' }))).toBeUndefined();
    expect(decisionOf(await callPre(hooks, 'Bash', { command: 'cat pw-report.json' }))).toBeUndefined();
  });
});

describe('cap uruchomień playwright test (tryb legacy: enforceRunPlaywrightTool=false)', () => {
  it('liczy tylko fazę assert i odcina po limicie', async () => {
    const state = new AuthorSessionState();
    const hooks = buildAuthorHooks(
      state,
      makeConfig({ enforceRunPlaywrightTool: false }),
      new TestLogger(),
    );

    state.markPhase('arrange');
    await callPre(hooks, 'Bash', { command: 'npx playwright test x.spec.ts' });
    expect(state.playwrightRunsByPhase.arrange).toBe(1);

    state.markPhase('assert');
    expect(decisionOf(await callPre(hooks, 'Bash', { command: 'npx playwright test' }))).toBeUndefined();
    expect(decisionOf(await callPre(hooks, 'Bash', { command: 'playwright test --reporter=json' }))).toBeUndefined();
    const third = await callPre(hooks, 'Bash', { command: 'npx playwright test' });
    expect(decisionOf(third)).toBe('deny');
    expect(state.playwrightRunsByPhase.assert).toBe(2);
  });

  it('sandbox: git push i gh są zablokowane', async () => {
    const state = new AuthorSessionState();
    const hooks = buildAuthorHooks(state, makeConfig(), new TestLogger());
    expect(decisionOf(await callPre(hooks, 'Bash', { command: 'git push origin main' }))).toBe('deny');
    expect(decisionOf(await callPre(hooks, 'Bash', { command: 'gh pr create' }))).toBe('deny');
    expect(decisionOf(await callPre(hooks, 'Bash', { command: 'git commit -m x' }))).toBeUndefined();
  });
});

describe('bezpiecznik seedu w hookach', () => {
  it('po zadziałaniu bezpiecznika wszystko poza finish i report_seed_attempt jest deny', async () => {
    const state = new AuthorSessionState();
    state.fuseTripped = true;
    const hooks = buildAuthorHooks(state, makeConfig(), new TestLogger());
    expect(decisionOf(await callPre(hooks, 'Bash', { command: 'ls' }))).toBe('deny');
    expect(decisionOf(await callPre(hooks, 'mcp__playwright__browser_snapshot', {}))).toBe('deny');
    expect(decisionOf(await callPre(hooks, 'mcp__greenproof__finish', { status: 'blocked' }))).toBeUndefined();
    // Spóźnione potwierdzenie seedu MUSI przejść - zdejmuje bezpiecznik.
    expect(
      decisionOf(await callPre(hooks, 'mcp__greenproof__report_seed_attempt', { strategy: 'api', outcome: 'ok' })),
    ).toBeUndefined();
  });
});

describe('bramka higieny snapshotów', () => {
  it('warn: przepuszcza, ale liczy trafienia', async () => {
    const state = new AuthorSessionState();
    const logger = new TestLogger();
    const hooks = buildAuthorHooks(state, makeConfig({ snapshotGating: 'warn' }), logger);
    await callPost(hooks, 'mcp__playwright__browser_snapshot', {}, 'snap');
    expect(state.pageChangedSinceSnapshot).toBe(false);
    const out = await callPre(hooks, 'mcp__playwright__browser_snapshot', {});
    expect(decisionOf(out)).toBeUndefined();
    expect(state.snapshotGateHits).toBe(1);
  });

  it('enforce: deny bez realnej zmiany strony, allow po zmianie', async () => {
    const state = new AuthorSessionState();
    const hooks = buildAuthorHooks(state, makeConfig({ snapshotGating: 'enforce' }), new TestLogger());
    await callPost(hooks, 'mcp__playwright__browser_snapshot', {}, 'snap');
    expect(decisionOf(await callPre(hooks, 'mcp__playwright__browser_snapshot', {}))).toBe('deny');
    // Celowane odczyty nie odblokowują pełnego snapshotu...
    await callPost(hooks, 'mcp__playwright__browser_find', {}, 'x');
    expect(decisionOf(await callPre(hooks, 'mcp__playwright__browser_snapshot', {}))).toBe('deny');
    // ...ale nawigacja tak.
    await callPost(hooks, 'mcp__playwright__browser_navigate', { url: 'x' }, 'ok');
    expect(decisionOf(await callPre(hooks, 'mcp__playwright__browser_snapshot', {}))).toBeUndefined();
  });
});

describe('przycinanie wyników', () => {
  it('string ponad limit jest przycinany z notą', () => {
    const out = truncateToolResponse('a'.repeat(100), 10) as string;
    expect(out).toContain('[greenproof: wynik przycięty');
    expect(out.length).toBeLessThan(100);
    expect(truncateToolResponse('krótki', 10)).toBeUndefined();
  });

  it('bloki content[].text są przycinane niezależnie', () => {
    const out = truncateToolResponse(
      { content: [{ type: 'text', text: 'x'.repeat(50) }, { type: 'text', text: 'ok' }] },
      10,
    ) as { content: { text: string }[] };
    expect(out.content[0]!.text).toContain('przycięty');
    expect(out.content[1]!.text).toBe('ok');
  });
});
