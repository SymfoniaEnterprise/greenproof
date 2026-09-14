import { readFile } from 'node:fs/promises';
import type { GreenproofConfig } from '../config/types.js';
import type { TokenUsage } from '../domain/attempt.js';

export interface CopilotUsage {
  costUsd: number;
  tokens: TokenUsage;
  modelUsage: Record<string, TokenUsage>;
}

function readNumeric(value: unknown, keys: string[]): number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function tokenUsage(value: unknown): TokenUsage {
  return {
    input: readNumeric(value, ['input_tokens', 'inputTokens']) ?? 0,
    output: readNumeric(value, ['output_tokens', 'outputTokens']) ?? 0,
    cacheRead: readNumeric(value, ['cache_read_input_tokens', 'cacheReadInputTokens']) ?? 0,
    cacheCreation: readNumeric(value, ['cache_creation_input_tokens', 'cacheCreationInputTokens']) ?? 0,
  };
}

function addTokens(target: TokenUsage, source: TokenUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheCreation += source.cacheCreation;
}

function parseCopilotUsage(value: unknown): CopilotUsage {
  const root = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const nestedUsage = root['usage'] ?? root['tokenUsage'];
  const tokens = tokenUsage(nestedUsage ?? root);
  const modelUsage: Record<string, TokenUsage> = {};
  const rawModelUsage = root['modelUsage'];
  if (rawModelUsage !== null && typeof rawModelUsage === 'object') {
    tokens.input = 0;
    tokens.output = 0;
    tokens.cacheRead = 0;
    tokens.cacheCreation = 0;
    for (const [model, usage] of Object.entries(rawModelUsage)) {
      const parsed = tokenUsage(usage);
      modelUsage[model] = parsed;
      addTokens(tokens, parsed);
    }
  }
  return {
    costUsd:
      readNumeric(root, ['total_cost_usd', 'costUsd', 'cost_usd']) ??
      readNumeric(nestedUsage, ['total_cost_usd', 'costUsd', 'cost_usd']) ??
      0,
    tokens,
    modelUsage,
  };
}

export async function readCopilotUsage(path: string): Promise<CopilotUsage> {
  try {
    return parseCopilotUsage(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return {
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      modelUsage: {},
    };
  }
}

function modelPrice(
  config: GreenproofConfig,
  model: string,
): { inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number } | undefined {
  const table = config.model.priceTable;
  if (table === undefined) return undefined;
  const baseName = model.replace(/\([^)]*\)$/, '').trim();
  return table[model] ?? table[baseName];
}

export function priceCopilotUsage(
  config: GreenproofConfig,
  usage: CopilotUsage,
  fallbackModel = config.model.author,
): number {
  if (config.model.priceTable === undefined) return usage.costUsd;
  const per = 1 / 1_000_000;
  let cost = 0;
  for (const [model, tokens] of Object.entries(usage.modelUsage)) {
    const price = modelPrice(config, model) ?? modelPrice(config, fallbackModel);
    if (!price) continue;
    cost +=
      tokens.input * price.inPerMTok * per +
      tokens.output * price.outPerMTok * per +
      tokens.cacheRead * (price.cacheReadPerMTok ?? price.inPerMTok * 0.1) * per +
      tokens.cacheCreation * (price.cacheWritePerMTok ?? price.inPerMTok * 1.25) * per;
  }
  if (Object.keys(usage.modelUsage).length === 0) {
    const price = modelPrice(config, fallbackModel);
    if (price) {
      cost =
        usage.tokens.input * price.inPerMTok * per +
        usage.tokens.output * price.outPerMTok * per +
        usage.tokens.cacheRead * (price.cacheReadPerMTok ?? price.inPerMTok * 0.1) * per +
        usage.tokens.cacheCreation * (price.cacheWritePerMTok ?? price.inPerMTok * 1.25) * per;
    }
  }
  return cost > 0 ? cost : usage.costUsd;
}