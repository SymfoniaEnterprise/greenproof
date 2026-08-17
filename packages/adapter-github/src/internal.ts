/**
 * Wspólne typy i helpery adaptera GitHub. Adapter rozmawia z GitHubem przez
 * wąski `GithubApi` (podzbiór @octokit/rest), nie przez klasę Octokit - w
 * testach wystarczy ręczny fake, zero sieci i mocków modułów.
 */

/** Wpis drzewa git; `sha: null` = usunięcie ścieżki względem base_tree. */
export interface TreeEntryInput {
  path: string;
  mode: '100644';
  type: 'blob';
  sha: string | null;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Plik w commicie; `content === null` = usunięcie. */
export interface BlobFile {
  path: string;
  content: string | null;
  /** Kodowanie przy tworzeniu blobu (domyślnie utf-8). */
  encoding?: 'utf-8' | 'base64';
}

/** Podzbiór REST API GitHuba; składnia metod (bivariance), by realny Octokit był przypisywalny mimo bogatszych typów parametrów. */
export interface GithubApi {
  git: {
    getRef(p: RepoRef & { ref: string }): Promise<{
      data: { object: { sha: string; type?: string } };
    }>;
    createRef(p: RepoRef & { ref: string; sha: string }): Promise<{
      data: { object: { sha: string } };
    }>;
    updateRef(p: RepoRef & { ref: string; sha: string; force?: boolean }): Promise<{
      data: { object: { sha: string } };
    }>;
    getCommit(p: RepoRef & { commit_sha: string }): Promise<{
      data: { sha: string; tree: { sha: string } };
    }>;
    createCommit(
      p: RepoRef & { message: string; tree: string; parents?: string[] },
    ): Promise<{ data: { sha: string } }>;
    createBlob(
      p: RepoRef & { content: string; encoding?: string },
    ): Promise<{ data: { sha: string } }>;
    getBlob(p: RepoRef & { file_sha: string }): Promise<{
      data: { content: string; encoding: string };
    }>;
    createTree(
      p: RepoRef & { tree: TreeEntryInput[]; base_tree?: string },
    ): Promise<{ data: { sha: string } }>;
    getTree(p: RepoRef & { tree_sha: string; recursive?: string }): Promise<{
      data: {
        sha: string;
        truncated?: boolean;
        tree: { path?: string; type?: string; sha?: string }[];
      };
    }>;
  };
  repos: {
    /** Zwraca plik/katalog/symlink/submoduł; narrowing po stronie adaptera. */
    getContent(p: RepoRef & { path: string; ref?: string }): Promise<{ data: unknown }>;
  };
  pulls: {
    create(
      p: RepoRef & { head: string; base: string; title: string; body?: string },
    ): Promise<{ data: { number: number; html_url: string } }>;
    list(
      p: RepoRef & { head?: string; base?: string; state?: 'open' | 'closed' | 'all' },
    ): Promise<{ data: { number: number; html_url: string }[] }>;
  };
  issues: {
    listComments(
      p: RepoRef & { issue_number: number; per_page?: number; page?: number },
    ): Promise<{ data: { id: number; body?: string }[] }>;
    createComment(
      p: RepoRef & { issue_number: number; body: string },
    ): Promise<{ data: { id: number } }>;
    updateComment(
      p: RepoRef & { comment_id: number; body: string },
    ): Promise<{ data: { id: number } }>;
  };
}

/** Status HTTP z Octokita (RequestError ma `.status`). */
export function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isNotFound(err: unknown): boolean {
  return statusOf(err) === 404;
}

/** Wyścig na refie: GitHub zwraca 422 ("not a fast forward"/"already exists") lub 409. */
export function isRefRaceError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 422 || status === 409;
}

export function isAlreadyExistsError(err: unknown): boolean {
  return statusOf(err) === 422 && /already exists/i.test(messageOf(err));
}

/**
 * Minimalny glob → RegExp: '**' (głębokość), '*' i '?' (bez '/').
 * Duplikat z adapter-fs - bez importu między adapterami.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:[^/]+/)*'; // '**/' pasuje też do zera katalogów
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += (c ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Prefiks dysku Windows. Sprawdzany tylko na początku ścieżki - `a/b:c.ts` to
 * legalna nazwa pliku na Linuksie i nie wolno jej odrzucić. UNC łapie wiodący
 * '/' po normalizacji '\' → '/'.
 */
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

/** Waliduje klucz relatywny (może zawierać '/'); odrzuca ucieczki z katalogu. */
export function assertSafeKey(key: string, label = 'key'): string {
  if (key.length === 0) throw new Error(`${label} must not be empty`);
  const normalized = key.replaceAll('\\', '/');
  if (normalized.startsWith('/') || WINDOWS_DRIVE_PREFIX.test(normalized)) {
    throw new Error(`${label} must be relative, got: ${key}`);
  }
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`${label} must not contain '.'/'..'/empty segments, got: ${key}`);
    }
  }
  return normalized;
}

export function assertSafeSegment(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new Error(`${label} must be a single safe path segment, got: ${value}`);
  }
  return value;
}

interface ContentFileResponse {
  type?: string;
  encoding?: string;
  content?: string;
  sha?: string;
}

/** Plik z repo: treść i sha blobu (wersja per plik, nie per commit). */
export interface RepoFile {
  content: Buffer;
  /** Sha blobu; `undefined` tylko gdy API go nie poda (GitHub zawsze podaje). */
  sha: string | undefined;
}

/** Jak `getFile`, ale bez sha blobu - dla wołających, którym wystarczy treść. */
export async function getFileBuffer(
  api: GithubApi,
  repo: RepoRef,
  ref: string,
  path: string,
): Promise<Buffer | null> {
  const file = await getFile(api, repo, ref, path);
  return file === null ? null : file.content;
}

/**
 * Odczyt pliku (treść + sha blobu); `null` = brak (404). Pliki >1MB: getContent
 * zwraca pustą treść (encoding 'none') - wtedy dociągamy blob po sha.
 */
export async function getFile(
  api: GithubApi,
  repo: RepoRef,
  ref: string,
  path: string,
): Promise<RepoFile | null> {
  let data: unknown;
  try {
    const res = await api.repos.getContent({ ...repo, path, ref });
    data = res.data;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  if (Array.isArray(data)) {
    throw new Error(`Path ${path} at ${ref} is a directory, not a file`);
  }
  const file = data as ContentFileResponse;
  if (file.type !== undefined && file.type !== 'file') {
    throw new Error(`Path ${path} at ${ref} is a ${file.type}, not a file`);
  }
  const content = file.content ?? '';
  if (content.replace(/\s/g, '').length > 0 && file.encoding === 'base64') {
    return { content: Buffer.from(content, 'base64'), sha: file.sha };
  }
  if (file.sha === undefined) {
    throw new Error(`GitHub returned no content and no sha for ${path} at ${ref}`);
  }
  // Duży plik: treść tylko przez blob.
  const blob = await api.git.getBlob({ ...repo, file_sha: file.sha });
  return { content: decodeBlob(blob.data.content, blob.data.encoding), sha: file.sha };
}

export function decodeBlob(content: string, encoding: string): Buffer {
  if (encoding === 'base64') return Buffer.from(content, 'base64');
  if (encoding === 'utf-8' || encoding === 'utf8') return Buffer.from(content, 'utf8');
  throw new Error(`Unsupported blob encoding: ${encoding}`);
}

/** Pliki → wpisy drzewa (blob per plik; usunięcie = sha null). */
export async function buildTreeEntries(
  api: GithubApi,
  repo: RepoRef,
  files: BlobFile[],
): Promise<TreeEntryInput[]> {
  const entries: TreeEntryInput[] = [];
  for (const file of files) {
    const path = assertSafeKey(file.path, 'file path');
    if (file.content === null) {
      entries.push({ path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await api.git.createBlob({
      ...repo,
      content: file.content,
      encoding: file.encoding ?? 'utf-8',
    });
    entries.push({ path, mode: '100644', type: 'blob', sha: blob.data.sha });
  }
  return entries;
}

/**
 * Commit z plikami na rodzicu; parentSha/baseTreeSha null+null = commit orphan.
 * Nie rusza refów - CAS po stronie wołającego. `entries` niesie sha blobów
 * (wołający potrzebuje ich jako wersji per plik).
 */
export async function createCommitWithFiles(
  api: GithubApi,
  repo: RepoRef,
  opts: {
    parentSha: string | null;
    baseTreeSha: string | null;
    files: BlobFile[];
    message: string;
  },
): Promise<{ commitSha: string; treeSha: string; entries: TreeEntryInput[] }> {
  const entries = await buildTreeEntries(api, repo, opts.files);
  const tree = await api.git.createTree({
    ...repo,
    tree: entries,
    ...(opts.baseTreeSha === null ? {} : { base_tree: opts.baseTreeSha }),
  });
  const commit = await api.git.createCommit({
    ...repo,
    message: opts.message,
    tree: tree.data.sha,
    ...(opts.parentSha === null ? {} : { parents: [opts.parentSha] }),
  });
  return { commitSha: commit.data.sha, treeSha: tree.data.sha, entries };
}

/** Head brancha albo `null`, gdy branch nie istnieje. */
export async function getBranchHead(
  api: GithubApi,
  repo: RepoRef,
  branch: string,
): Promise<string | null> {
  try {
    const res = await api.git.getRef({ ...repo, ref: `heads/${branch}` });
    return res.data.object.sha;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Lista ścieżek blobów w commicie (rekurencyjnie). */
export async function listBlobPaths(
  api: GithubApi,
  repo: RepoRef,
  commitSha: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const commit = await api.git.getCommit({ ...repo, commit_sha: commitSha });
  const tree = await api.git.getTree({
    ...repo,
    tree_sha: commit.data.tree.sha,
    recursive: '1',
  });
  const paths: string[] = [];
  for (const entry of tree.data.tree) {
    if (entry.type === 'blob' && entry.path !== undefined) paths.push(entry.path);
  }
  return { paths, truncated: tree.data.truncated === true };
}
