/**
 * JSON renderer - NDJSON na stderr; stdout zostaje czystym wynikiem komendy.
 */
import type { ProgressEvent } from '@greenproof/core';
import type { ProgressRenderer, RendererIo } from './types.js';

export function createJsonRenderer(io: RendererIo): ProgressRenderer {
  return {
    onEvent(event: ProgressEvent): void {
      io.write(JSON.stringify(event) + '\n');
    },

    printAbove(line: string): void {
      io.write(JSON.stringify({ kind: 'log' as const, line }) + '\n');
    },

    finalize(): void {
    },
  };
}
