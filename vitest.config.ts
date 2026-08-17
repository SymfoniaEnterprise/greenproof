import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@greenproof/core': p('./packages/core/src/index.ts'),
      '@greenproof/plan-parser-bmad': p('./packages/plan-parser-bmad/src/index.ts'),
      '@greenproof/adapter-fs': p('./packages/adapter-fs/src/index.ts'),
      '@greenproof/adapter-github': p('./packages/adapter-github/src/index.ts'),
      '@greenproof/testing': p('./packages/testing/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
