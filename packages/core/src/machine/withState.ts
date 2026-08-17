import type { PipelineState } from '../domain/state.js';
import type { Ports } from '../ports/index.js';

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} not found in state store`);
    this.name = 'RunNotFoundError';
  }
}

/**
 * Wzorzec komendy: load → mutacja → save z CAS. Konflikt (StateConflictError)
 * propaguje - CLI mapuje go na exit code 4, platforma ponawia.
 */
export async function withState<T>(
  ports: Ports,
  runId: string,
  fn: (state: PipelineState) => Promise<T> | T,
): Promise<T> {
  const loaded = await ports.state.load(runId);
  if (!loaded) throw new RunNotFoundError(runId);
  const result = await fn(loaded.state);
  await ports.state.save(runId, loaded.state, loaded.version);
  return result;
}
