/**
 * Odbojnik kosztowy SDK vs modele darmowe.
 *
 * Regresja z runu ornith-35b (2026-08-16): payroll dowożony przez model
 * lokalny został ubity po 387 turach komunikatem „Reached maximum budget
 * ($60)", mimo że realny koszt wynosił $0 - odbojnik ×20 liczony był
 * cennikiem SDK (stawki Claude'a za model spoza Anthropic).
 */
import { describe, expect, it } from 'vitest';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import { sdkBudgetUsd } from '../src/author/session.js';

const base = {
  platform: 'fake',
  plan: { source: 'json' as const },
  paths: { testsRepoDir: '/tmp/x' },
  caps: { maxCostUsd: 3 },
};

const withModel = (model: Record<string, unknown>) =>
  GreenproofConfigSchema.parse({ ...base, model: { authTokenEnv: 'T', ...model } });

describe('sdkBudgetUsd', () => {
  it('model lokalny (cennik zerowy) → BRAK capu SDK; granicą są tury i czas', () => {
    const config = withModel({
      author: 'qwen3.8',
      priceTable: { 'qwen3.8': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 } },
    });
    expect(sdkBudgetUsd(config, config.caps)).toBeUndefined();
  });

  it('model płatny z priceTable → odbojnik ×20 (nasz licznik jest źródłem prawdy)', () => {
    const config = withModel({
      author: 'deepseek-v4-flash',
      priceTable: { 'deepseek-v4-flash': { inPerMTok: 0.075, outPerMTok: 0.3 } },
    });
    expect(sdkBudgetUsd(config, config.caps)).toBe(60);
  });

  it('bez priceTable → twardy cap SDK równy maxCostUsd', () => {
    const config = withModel({ author: 'claude-opus-5' });
    expect(sdkBudgetUsd(config, config.caps)).toBe(3);
  });

  it('cennik zerowy dla INNEGO modelu niż autor → autor nie jest darmowy', () => {
    const config = withModel({
      author: 'platny-model',
      priceTable: { 'inny-model': { inPerMTok: 0, outPerMTok: 0 } },
    });
    expect(sdkBudgetUsd(config, config.caps)).toBe(60);
  });

  // Jawny znacznik bije heurystykę z cennika - modele z subskrypcji bywają
  // wpisane z zerowym priceTable, a mimo to mają zachować odbojnik.
  it('costModel: subscription przy zerowym cenniku → odbojnik ZOSTAJE', () => {
    const config = withModel({
      author: 'gpt-5.6-luna',
      costModel: 'subscription',
      priceTable: { 'gpt-5.6-luna': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 } },
    });
    expect(sdkBudgetUsd(config, config.caps)).toBe(60);
  });

  it('costModel: local przy NIEzerowym cenniku → brak capu (znacznik decyduje)', () => {
    const config = withModel({
      author: 'lokalny-z-estymata',
      costModel: 'local',
      priceTable: { 'lokalny-z-estymata': { inPerMTok: 0.5, outPerMTok: 1.5 } },
    });
    expect(sdkBudgetUsd(config, config.caps)).toBeUndefined();
  });

  it('costModel: subscription bez priceTable → twardy cap maxCostUsd', () => {
    const config = withModel({ author: 'claude-opus-5', costModel: 'subscription' });
    expect(sdkBudgetUsd(config, config.caps)).toBe(3);
  });

  it('zerowe stawki wejścia/wyjścia, ale niezerowy cache → NIE traktujemy jako darmowego', () => {
    const config = withModel({
      author: 'dziwny-model',
      priceTable: { 'dziwny-model': { inPerMTok: 0, outPerMTok: 0, cacheWritePerMTok: 0.5 } },
    });
    expect(sdkBudgetUsd(config, config.caps)).toBe(60);
  });
});
