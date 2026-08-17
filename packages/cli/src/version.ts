/**
 * Źródło wersji CLI: pole `version` w packages/cli/package.json (stemplowane
 * przez `pnpm stamp-version`). `--version` i `status` czytają tę samą funkcję.
 */
import { createRequire } from 'node:module';

export function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
