/**
 * In-memory ScmPort: drzewo plików per branch + historia commitów.
 * Deterministyczny - te same operacje dają te same sha.
 */
import type { FileChange, ScmPort } from '@greenproof/core';

export interface FakeCommit {
  sha: string;
  message: string;
  /** Zmiany wchodzące w commit (content === null oznacza usunięcie). */
  files: FileChange[];
}

export interface FakePullRequest {
  id: string;
  url: string;
  from: string;
  to: string;
  title: string;
  body: string;
}

/** Znaki specjalne regexa poza obsługiwanymi wildcardami. */
const RE_SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * Minimalny glob: `**` (segmenty), `*` i `?` (bez `/`); "**" + "/" dopuszcza
 * zero katalogów, więc łapie `a.spec.ts` i `tests/a.spec.ts`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      continue;
    }
    re += ch.replace(RE_SPECIAL, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Normalizacja ścieżki: bez `./` i wiodącego `/`. */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** FNV-1a 32-bit → 8 hex; powtórzone 5x daje coś o kształcie sha1. */
function fakeSha(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex = h.toString(16).padStart(8, '0');
  return hex.repeat(5);
}

export class InMemoryScm implements ScmPort {
  /** Otwarte PR-y - publiczne pole do asercji w testach. */
  readonly pullRequests: FakePullRequest[] = [];
  /** Branche, na których wywołano push(). */
  readonly pushed: string[] = [];

  private readonly trees = new Map<string, Map<string, string>>();
  private readonly history = new Map<string, FakeCommit[]>();
  private commitCounter = 0;
  private prCounter = 0;

  constructor(initial?: Record<string, Record<string, string>>) {
    for (const [branch, files] of Object.entries(initial ?? {})) {
      this.seedBranch(branch, files);
    }
  }

  // --- pomocnicze dla testów -------------------------------------------------

  /** Tworzy/nadpisuje branch podanym zestawem plików (bez commita). */
  seedBranch(name: string, files: Record<string, string>): void {
    const tree = new Map<string, string>();
    for (const [path, content] of Object.entries(files)) {
      tree.set(normalizePath(path), content);
    }
    this.trees.set(name, tree);
    if (!this.history.has(name)) this.history.set(name, []);
  }

  /** Migawka drzewa brancha jako zwykły obiekt (posortowana po ścieżce). */
  getFiles(branch: string): Record<string, string> {
    const tree = this.trees.get(branch);
    const out: Record<string, string> = {};
    if (!tree) return out;
    for (const path of [...tree.keys()].sort()) {
      out[path] = tree.get(path) as string;
    }
    return out;
  }

  /** Historia commitów brancha (od najstarszego). */
  getCommits(branch: string): FakeCommit[] {
    return [...(this.history.get(branch) ?? [])];
  }

  hasBranch(name: string): boolean {
    return this.trees.has(name);
  }

  branches(): string[] {
    return [...this.trees.keys()].sort();
  }

  // --- ScmPort ---------------------------------------------------------------

  /** Idempotentne: brak brancha = no-op (clean może być ponawiany). */
  async deleteBranch(name: string): Promise<void> {
    this.trees.delete(name);
    this.history.delete(name);
  }

  async listBranches(prefix: string): Promise<string[]> {
    return [...this.trees.keys()].filter((b) => b.startsWith(prefix)).sort();
  }

  /** Idempotentne: istniejący branch zostaje bez zmian. */
  async ensureBranch(name: string, fromRef: string): Promise<void> {
    if (this.trees.has(name)) return;
    const base = this.trees.get(fromRef);
    this.trees.set(name, new Map(base ?? []));
    this.history.set(name, [...(this.history.get(fromRef) ?? [])]);
  }

  async commitFiles(
    branch: string,
    files: FileChange[],
    message: string,
  ): Promise<{ sha: string }> {
    const tree = this.trees.get(branch);
    if (!tree) throw new Error(`InMemoryScm: nieznany branch "${branch}"`);
    for (const change of files) {
      const path = normalizePath(change.path);
      if (change.content === null) tree.delete(path);
      else tree.set(path, change.content);
    }
    this.commitCounter += 1;
    const sha = fakeSha(`${this.commitCounter}:${branch}:${message}`);
    const commits = this.history.get(branch) ?? [];
    commits.push({ sha, message, files: files.map((f) => ({ ...f })) });
    this.history.set(branch, commits);
    return { sha };
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    return this.trees.get(ref)?.get(normalizePath(path)) ?? null;
  }

  async listFiles(ref: string, glob: string): Promise<string[]> {
    const tree = this.trees.get(ref);
    if (!tree) return [];
    const re = globToRegExp(normalizePath(glob));
    return [...tree.keys()].filter((p) => re.test(p)).sort();
  }

  /** Idempotentne: powtórne otwarcie PR-a z tej samej pary refów aktualizuje wpis. */
  async openPullRequest(p: {
    from: string;
    to: string;
    title: string;
    body: string;
  }): Promise<{ url: string; id: string }> {
    const existing = this.pullRequests.find((pr) => pr.from === p.from && pr.to === p.to);
    if (existing) {
      existing.title = p.title;
      existing.body = p.body;
      return { url: existing.url, id: existing.id };
    }
    this.prCounter += 1;
    const pr: FakePullRequest = {
      id: String(this.prCounter),
      url: `fake://pr/${this.prCounter}`,
      from: p.from,
      to: p.to,
      title: p.title,
      body: p.body,
    };
    this.pullRequests.push(pr);
    return { url: pr.url, id: pr.id };
  }

  async push(branch: string): Promise<void> {
    this.pushed.push(branch);
  }
}
