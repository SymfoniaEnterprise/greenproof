/**
 * Minimalny fake REST API GitHuba: refs, blobs, trees, commits, contents,
 * pulls i komentarze issue trzymane w Map-ach. ZERO sieci - testy adaptera
 * sprawdzają realne zachowanie (CAS na refie, 404, paginację), a nie mocki.
 */
import { createHash } from 'node:crypto';
import type { Logger } from '@greenproof/core';
import type { GithubApi, RepoRef, TreeEntryInput } from '../src/internal.js';

/** Błąd w kształcie octokitowego RequestError - liczy się `.status`. */
export class FakeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
}

interface FakeComment {
  id: number;
  body: string;
}

interface FakePull {
  number: number;
  html_url: string;
  head: string;
  base: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
}

export interface FakeOctokitOptions {
  owner?: string;
  repo?: string;
  /** Powyżej tylu bajtów `repos.getContent` zwraca pustą treść (jak >1MB na GH). */
  largeFileThreshold?: number;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

export class FakeOctokit implements GithubApi {
  readonly owner: string;
  readonly repo: string;
  /** 'heads/<branch>' | 'tags/<tag>' → sha commita (lub obiektu tagu). */
  readonly refs = new Map<string, string>();
  readonly blobs = new Map<string, Buffer>();
  /** treeSha → (ścieżka → blobSha). */
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, FakeCommit>();
  readonly pulls_ = new Map<number, FakePull>();
  readonly comments = new Map<number, FakeComment[]>();
  /** Licznik wywołań endpointów - do asercji o retry/paginacji. */
  readonly calls = new Map<string, number>();

  private readonly largeFileThreshold: number;
  private commitSeq = 0;
  private prSeq = 0;
  private commentSeq = 0;

  constructor(options: FakeOctokitOptions = {}) {
    this.owner = options.owner ?? 'acme';
    this.repo = options.repo ?? 'tests';
    this.largeFileThreshold = options.largeFileThreshold ?? 1024 * 1024;
  }

  // --- API --------------------------------------------------------

  readonly git = {
    getRef: async (p: RepoRef & { ref: string }) => {
      this.count('git.getRef');
      const sha = this.refs.get(normalizeRef(p.ref));
      if (sha === undefined) throw new FakeHttpError(404, 'Not Found');
      return { data: { object: { sha, type: 'commit' } } };
    },
    createRef: async (p: RepoRef & { ref: string; sha: string }) => {
      this.count('git.createRef');
      const ref = normalizeRef(p.ref);
      if (this.refs.has(ref)) {
        throw new FakeHttpError(422, 'Reference already exists');
      }
      if (!this.commits.has(p.sha)) throw new FakeHttpError(422, 'Object does not exist');
      this.refs.set(ref, p.sha);
      return { data: { object: { sha: p.sha } } };
    },
    updateRef: async (p: RepoRef & { ref: string; sha: string; force?: boolean }) => {
      this.count('git.updateRef');
      const ref = normalizeRef(p.ref);
      const current = this.refs.get(ref);
      if (current === undefined) throw new FakeHttpError(422, 'Reference does not exist');
      if (p.force !== true && !this.isAncestor(current, p.sha)) {
        throw new FakeHttpError(422, 'Update is not a fast forward');
      }
      this.refs.set(ref, p.sha);
      return { data: { object: { sha: p.sha } } };
    },
    getCommit: async (p: RepoRef & { commit_sha: string }) => {
      this.count('git.getCommit');
      const commit = this.commits.get(p.commit_sha);
      if (commit === undefined) throw new FakeHttpError(404, 'Not Found');
      return { data: { sha: commit.sha, tree: { sha: commit.tree } } };
    },
    createCommit: async (
      p: RepoRef & { message: string; tree: string; parents?: string[] },
    ) => {
      this.count('git.createCommit');
      if (!this.trees.has(p.tree)) throw new FakeHttpError(422, 'Tree does not exist');
      const parents = p.parents ?? [];
      for (const parent of parents) {
        if (!this.commits.has(parent)) throw new FakeHttpError(422, 'Parent does not exist');
      }
      this.commitSeq += 1;
      // Licznik w hashu = odpowiednik timestampu commitera (unikalne sha).
      const sha = sha1(`commit:${p.tree}:${parents.join(',')}:${p.message}:${this.commitSeq}`);
      this.commits.set(sha, { sha, tree: p.tree, parents, message: p.message });
      return { data: { sha } };
    },
    createBlob: async (p: RepoRef & { content: string; encoding?: string }) => {
      this.count('git.createBlob');
      const encoding = p.encoding ?? 'utf-8';
      const buf =
        encoding === 'base64'
          ? Buffer.from(p.content, 'base64')
          : Buffer.from(p.content, 'utf8');
      const sha = sha1(`blob:${buf.toString('base64')}`);
      this.blobs.set(sha, buf);
      return { data: { sha } };
    },
    getBlob: async (p: RepoRef & { file_sha: string }) => {
      this.count('git.getBlob');
      const buf = this.blobs.get(p.file_sha);
      if (buf === undefined) throw new FakeHttpError(404, 'Not Found');
      return { data: { content: buf.toString('base64'), encoding: 'base64' } };
    },
    createTree: async (p: RepoRef & { tree: TreeEntryInput[]; base_tree?: string }) => {
      this.count('git.createTree');
      const base =
        p.base_tree === undefined ? new Map<string, string>() : this.treeOf(p.base_tree);
      const next = new Map(base);
      for (const entry of p.tree) {
        if (entry.sha === null) {
          next.delete(entry.path);
          continue;
        }
        if (!this.blobs.has(entry.sha)) throw new FakeHttpError(422, 'Blob does not exist');
        next.set(entry.path, entry.sha);
      }
      const sha = treeSha(next);
      this.trees.set(sha, next);
      return { data: { sha } };
    },
    getTree: async (p: RepoRef & { tree_sha: string; recursive?: string }) => {
      this.count('git.getTree');
      const tree = this.treeOf(p.tree_sha);
      const entries = [...tree.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, sha]) => ({ path, type: 'blob', sha, mode: '100644' }));
      return { data: { sha: p.tree_sha, truncated: false, tree: entries } };
    },
  };

  readonly repos = {
    getContent: async (p: RepoRef & { path: string; ref?: string }) => {
      this.count('repos.getContent');
      const commitSha = this.tryResolve(p.ref ?? 'main');
      if (commitSha === null) throw new FakeHttpError(404, 'Not Found');
      const tree = this.treeOfCommit(commitSha);
      const blobSha = tree.get(p.path);
      if (blobSha === undefined) {
        const dirPrefix = `${p.path}/`;
        const children = [...tree.keys()].filter((k) => k.startsWith(dirPrefix));
        if (children.length === 0) throw new FakeHttpError(404, 'Not Found');
        return {
          data: children.map((path) => ({ type: 'file', path, name: path.split('/').pop() })),
        };
      }
      const buf = this.blobs.get(blobSha) ?? Buffer.alloc(0);
      // Duże pliki: GitHub oddaje pustą treść i wymusza pobranie blobu.
      if (buf.byteLength > this.largeFileThreshold) {
        return {
          data: { type: 'file', encoding: 'none', content: '', sha: blobSha, size: buf.byteLength },
        };
      }
      return {
        data: {
          type: 'file',
          encoding: 'base64',
          content: buf.toString('base64'),
          sha: blobSha,
          size: buf.byteLength,
        },
      };
    },
  };

  readonly pulls = {
    create: async (
      p: RepoRef & { head: string; base: string; title: string; body?: string },
    ) => {
      this.count('pulls.create');
      for (const pr of this.pulls_.values()) {
        if (pr.state === 'open' && pr.head === p.head) {
          throw new FakeHttpError(
            422,
            `Validation Failed: A pull request already exists for ${this.owner}:${p.head}.`,
          );
        }
      }
      this.prSeq += 1;
      const pr: FakePull = {
        number: this.prSeq,
        html_url: `https://github.com/${this.owner}/${this.repo}/pull/${this.prSeq}`,
        head: p.head,
        base: p.base,
        title: p.title,
        body: p.body ?? '',
        state: 'open',
      };
      this.pulls_.set(pr.number, pr);
      return { data: { number: pr.number, html_url: pr.html_url } };
    },
    list: async (
      p: RepoRef & { head?: string; base?: string; state?: 'open' | 'closed' | 'all' },
    ) => {
      this.count('pulls.list');
      const wanted = p.state ?? 'open';
      const data = [...this.pulls_.values()]
        .filter((pr) => wanted === 'all' || pr.state === wanted)
        .filter((pr) => p.head === undefined || p.head === `${this.owner}:${pr.head}`)
        .filter((pr) => p.base === undefined || p.base === pr.base)
        .map((pr) => ({ number: pr.number, html_url: pr.html_url }));
      return { data };
    },
  };

  readonly issues = {
    listComments: async (
      p: RepoRef & { issue_number: number; per_page?: number; page?: number },
    ) => {
      this.count('issues.listComments');
      const all = this.comments.get(p.issue_number) ?? [];
      const perPage = p.per_page ?? 30;
      const page = p.page ?? 1;
      const start = (page - 1) * perPage;
      return { data: all.slice(start, start + perPage).map((c) => ({ ...c })) };
    },
    createComment: async (p: RepoRef & { issue_number: number; body: string }) => {
      this.count('issues.createComment');
      this.commentSeq += 1;
      const comment: FakeComment = { id: this.commentSeq, body: p.body };
      const list = this.comments.get(p.issue_number) ?? [];
      list.push(comment);
      this.comments.set(p.issue_number, list);
      return { data: { id: comment.id } };
    },
    updateComment: async (p: RepoRef & { comment_id: number; body: string }) => {
      this.count('issues.updateComment');
      for (const list of this.comments.values()) {
        const found = list.find((c) => c.id === p.comment_id);
        if (found !== undefined) {
          found.body = p.body;
          return { data: { id: found.id } };
        }
      }
      throw new FakeHttpError(404, 'Not Found');
    },
  };

  // --- Helpery testowe --------------------------------------------

  /** Tworzy commit z plikami na branchu (tworzy branch, gdy nie istnieje). */
  seed(branch: string, files: Record<string, string>, message = 'seed'): string {
    const head = this.refs.get(`heads/${branch}`);
    const base = head === undefined ? new Map<string, string>() : this.treeOfCommit(head);
    const next = new Map(base);
    for (const [path, content] of Object.entries(files)) {
      const buf = Buffer.from(content, 'utf8');
      const sha = sha1(`blob:${buf.toString('base64')}`);
      this.blobs.set(sha, buf);
      next.set(path, sha);
    }
    const tree = treeSha(next);
    this.trees.set(tree, next);
    this.commitSeq += 1;
    const commitSha = sha1(`commit:${tree}:${head ?? ''}:${message}:${this.commitSeq}`);
    this.commits.set(commitSha, {
      sha: commitSha,
      tree,
      parents: head === undefined ? [] : [head],
      message,
    });
    this.refs.set(`heads/${branch}`, commitSha);
    return commitSha;
  }

  /** Tag wskazujący na commit (do testu resolve fromRef). */
  seedTag(tag: string, sha: string): void {
    this.refs.set(`tags/${tag}`, sha);
  }

  seedComment(issueNumber: number, body: string): number {
    this.commentSeq += 1;
    const list = this.comments.get(issueNumber) ?? [];
    list.push({ id: this.commentSeq, body });
    this.comments.set(issueNumber, list);
    return this.commentSeq;
  }

  commentBodies(issueNumber: number): string[] {
    return (this.comments.get(issueNumber) ?? []).map((c) => c.body);
  }

  /** Treść pliku na branchu - do asercji bez przechodzenia przez adapter. */
  fileAt(branch: string, path: string): string | null {
    const head = this.refs.get(`heads/${branch}`);
    if (head === undefined) return null;
    const blobSha = this.treeOfCommit(head).get(path);
    if (blobSha === undefined) return null;
    return (this.blobs.get(blobSha) ?? Buffer.alloc(0)).toString('utf8');
  }

  parentsOf(sha: string): string[] {
    return this.commits.get(sha)?.parents ?? [];
  }

  callCount(endpoint: string): number {
    return this.calls.get(endpoint) ?? 0;
  }

  // --- Wewnętrzne -------------------------------------------------

  private count(endpoint: string): void {
    this.calls.set(endpoint, (this.calls.get(endpoint) ?? 0) + 1);
  }

  private treeOf(sha: string): Map<string, string> {
    const tree = this.trees.get(sha);
    if (tree === undefined) throw new FakeHttpError(404, 'Not Found');
    return tree;
  }

  private treeOfCommit(commitSha: string): Map<string, string> {
    const commit = this.commits.get(commitSha);
    if (commit === undefined) throw new FakeHttpError(404, 'Not Found');
    return this.treeOf(commit.tree);
  }

  private tryResolve(ref: string): string | null {
    if (this.commits.has(ref)) return ref;
    return this.refs.get(`heads/${ref}`) ?? this.refs.get(`tags/${ref}`) ?? null;
  }

  /** Czy `candidate` leży na ścieżce przodków `sha` (fast-forward check). */
  private isAncestor(candidate: string, sha: string): boolean {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === candidate) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(this.commits.get(current)?.parents ?? []));
    }
    return false;
  }
}

function normalizeRef(ref: string): string {
  return ref.startsWith('refs/') ? ref.slice('refs/'.length) : ref;
}

function treeSha(tree: Map<string, string>): string {
  const body = [...tree.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, sha]) => `${path}\0${sha}`)
    .join('\n');
  return sha1(`tree:${body}`);
}

/** Logger zbierający wpisy - testy nie hałasują na konsoli. */
export function fakeLogger(): Logger & { entries: { level: string; msg: string }[] } {
  const entries: { level: string; msg: string }[] = [];
  const push = (level: string) => (msg: string) => {
    entries.push({ level, msg });
  };
  return {
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}
