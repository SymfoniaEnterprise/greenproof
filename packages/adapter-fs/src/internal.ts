/** Wspólne helpery adaptera fs - bez zależności zewnętrznych. */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hasErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
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
  const segments = normalized.split('/');
  for (const segment of segments) {
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

export function sanitizeName(raw: string, label: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) {
    throw new Error(`${label} sanitizes to an empty/invalid name, got: ${raw}`);
  }
  return cleaned;
}

/** Zapis atomowy: tmp w tym samym katalogu, potem rename. */
export async function writeFileAtomic(
  file: string,
  data: Buffer | string | Readable,
): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
