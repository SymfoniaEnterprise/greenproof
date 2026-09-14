import { describe, expect, it } from 'vitest';
import { AuthorSessionState } from '../src/author/state.js';
import { restoreAuthorSessionState, serializeAuthorSessionState } from '../src/author/stateTransfer.js';

describe('Copilot MCP state transfer', () => {
  it('serializuje i odtwarza Set filesTouched oraz wynik finish', () => {
    const source = new AuthorSessionState();
    source.turns = 4;
    source.markPhase('assert');
    source.filesTouched.add('tests/e2e/payroll.spec.ts');
    source.finish = { status: 'delivered', specPath: 'tests/e2e/payroll.spec.ts', reusedPoms: [] };

    const snapshot = serializeAuthorSessionState(source);
    expect(snapshot.filesTouched).toEqual(['tests/e2e/payroll.spec.ts']);

    const restored = new AuthorSessionState();
    restoreAuthorSessionState(restored, snapshot);
    expect(restored.turns).toBe(4);
    expect(restored.phase).toBe('assert');
    expect([...restored.filesTouched]).toEqual(['tests/e2e/payroll.spec.ts']);
    expect(restored.finish?.status).toBe('delivered');
  });
});