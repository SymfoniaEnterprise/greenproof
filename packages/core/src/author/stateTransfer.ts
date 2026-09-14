import { readFile, writeFile } from 'node:fs/promises';
import type { GreenproofConfig } from '../config/types.js';
import type { CaseContext } from '../steps/triage.js';
import { AuthorSessionState } from './state.js';

export interface CopilotMcpBootstrap {
  config: GreenproofConfig;
  context: CaseContext;
  cwd: string;
  attemptDir: string;
  runId: string;
  statePath: string;
  progressPath?: string;
}

export interface SerializedAuthorSessionState extends Omit<AuthorSessionState, 'filesTouched'> {
  filesTouched: string[];
}

export function serializeAuthorSessionState(state: AuthorSessionState): SerializedAuthorSessionState {
  return {
    ...(state as Omit<AuthorSessionState, 'filesTouched'>),
    filesTouched: [...state.filesTouched],
  };
}

export function restoreAuthorSessionState(
  state: AuthorSessionState,
  snapshot: Partial<SerializedAuthorSessionState>,
): void {
  const { filesTouched, ...rest } = snapshot;
  Object.assign(state, rest);
  state.filesTouched = new Set(filesTouched ?? []);
}

export async function writeAuthorSessionState(
  path: string,
  state: AuthorSessionState,
): Promise<void> {
  await writeFile(path, JSON.stringify(serializeAuthorSessionState(state), null, 2));
}

export async function readAuthorSessionState(path: string): Promise<Partial<SerializedAuthorSessionState> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Partial<SerializedAuthorSessionState>;
  } catch {
    return undefined;
  }
}