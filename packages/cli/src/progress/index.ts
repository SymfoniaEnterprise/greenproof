import type { ProgressRenderer, RendererIo } from './types.js';
import { createTtyRenderer } from './tty.js';
import { createPlainRenderer } from './plain.js';
import { createGithubRenderer } from './github.js';
import { createJsonRenderer } from './json.js';

export type { ProgressRenderer, RendererIo } from './types.js';

export type ProgressMode = 'auto' | 'tty' | 'plain' | 'github' | 'json' | 'off';

const MODES: readonly ProgressMode[] = ['auto', 'tty', 'plain', 'github', 'json', 'off'];

/** Normalizacja env - nieznana wartość działa jak `auto` (nie wywala CLI). */
export function resolveProgressMode(io: RendererIo): Exclude<ProgressMode, 'auto'> {
  const raw = (io.env['GREENPROOF_PROGRESS'] ?? 'auto').toLowerCase();
  const mode = (MODES as readonly string[]).includes(raw) ? (raw as ProgressMode) : 'auto';
  if (mode !== 'auto') return mode;
  if (io.env['GITHUB_ACTIONS'] === 'true') return 'github';
  return io.isTTY ? 'tty' : 'plain';
}

export function createProgressRenderer(io: RendererIo): ProgressRenderer | null {
  switch (resolveProgressMode(io)) {
    case 'tty':
      return createTtyRenderer(io);
    case 'plain':
      return createPlainRenderer(io);
    case 'github':
      return createGithubRenderer(io);
    case 'json':
      return createJsonRenderer(io);
    case 'off':
      return null;
  }
}
