import { describe, expect, it } from 'vitest';
import { priceCopilotUsage, type CopilotUsage } from '../src/author/copilotUsage.js';
import { GreenproofConfigSchema } from '../src/schemas/index.js';

const usage: CopilotUsage = {
  costUsd: 4,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  modelUsage: {},
};

describe('priceCopilotUsage', () => {
  it('respects an explicit zero price instead of CLI-reported USD cost', () => {
    const config = GreenproofConfigSchema.parse({
      platform: 'fake',
      plan: { source: 'json' },
      model: {
        authTokenEnv: 'TOKEN',
        author: 'copilot-model',
        priceTable: { 'copilot-model': { inPerMTok: 0, outPerMTok: 0 } },
      },
      paths: { testsRepoDir: '/tmp/tests' },
    });

    expect(priceCopilotUsage(config, usage)).toBe(0);
  });

  it('uses CLI-reported cost when no configured model price applies', () => {
    const config = GreenproofConfigSchema.parse({
      platform: 'fake',
      plan: { source: 'json' },
      model: {
        authTokenEnv: 'TOKEN',
        author: 'copilot-model',
        priceTable: { 'other-model': { inPerMTok: 1, outPerMTok: 1 } },
      },
      paths: { testsRepoDir: '/tmp/tests' },
    });

    expect(priceCopilotUsage(config, usage)).toBe(4);
  });

  it('uses CLI-reported cost with the empty table generated for Copilot', () => {
    const config = GreenproofConfigSchema.parse({
      platform: 'fake',
      plan: { source: 'json' },
      model: {
        authTokenEnv: 'TOKEN',
        author: 'copilot-model',
        costModel: 'metered',
        priceTable: {},
      },
      paths: { testsRepoDir: '/tmp/tests' },
    });

    expect(priceCopilotUsage(config, usage)).toBe(4);
  });
});