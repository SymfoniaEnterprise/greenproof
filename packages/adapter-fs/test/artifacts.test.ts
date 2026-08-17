import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { FsArtifactStore } from '../src/index.js';
import { assertSafeKey } from '../src/internal.js';
import { cleanupTmp, tmpDir } from './helpers.js';

afterAll(cleanupTmp);

describe('FsArtifactStore', () => {
  it('zapisuje, czyta i listuje klucze (także z podkatalogami)', async () => {
    const dir = await tmpDir('gp-art-');
    const store = new FsArtifactStore({ dir });

    await store.put('run-1', 'proof/case-1.json', Buffer.from('{"ok":true}'), {
      contentType: 'application/json',
    });
    await store.put('run-1', 'ledger.jsonl', Buffer.from('{"turn":1}\n'));
    await store.put('run-1', 'a/b/c.txt', Buffer.from('deep'));
    await store.put('run-2', 'other.txt', Buffer.from('inny run'));

    expect((await store.get('run-1', 'proof/case-1.json'))?.toString()).toBe('{"ok":true}');
    expect((await store.get('run-1', 'a/b/c.txt'))?.toString()).toBe('deep');
    expect(await store.get('run-1', 'nie-ma.txt')).toBeNull();
    expect(await store.get('run-nieznany', 'x.txt')).toBeNull();

    // meta obok, ale nie w liście kluczy
    const meta = await readFile(join(dir, 'run-1', 'proof', 'case-1.json.meta.json'), 'utf8');
    expect(JSON.parse(meta)).toEqual({ contentType: 'application/json' });

    expect(await store.list('run-1')).toEqual(['a/b/c.txt', 'ledger.jsonl', 'proof/case-1.json']);
    expect(await store.list('run-1', 'proof/')).toEqual(['proof/case-1.json']);
    expect(await store.list('run-2')).toEqual(['other.txt']);
    expect(await store.list('run-bez-artefaktow')).toEqual([]);
  });

  it('przyjmuje strumień i nadpisuje istniejący klucz', async () => {
    const dir = await tmpDir('gp-art-');
    const store = new FsArtifactStore({ dir });
    await store.put('run-1', 'transcript.txt', Readable.from(['abc', 'def']));
    expect((await store.get('run-1', 'transcript.txt'))?.toString()).toBe('abcdef');
    await store.put('run-1', 'transcript.txt', Buffer.from('nowa treść'));
    expect((await store.get('run-1', 'transcript.txt'))?.toString()).toBe('nowa treść');
    expect(await store.list('run-1')).toEqual(['transcript.txt']);
  });

  it('delete usuwa plik z metą i opróżnione podkatalogi; brak pliku = no-op', async () => {
    const dir = await tmpDir('gp-art-');
    const store = new FsArtifactStore({ dir });
    await store.put('run-1', 'cases/c1/context.json', Buffer.from('{}'), { a: 'b' });
    await store.put('run-1', 'cases/c1/ledger.jsonl', Buffer.from('{}'));
    await store.put('run-1', 'cases/c2/context.json', Buffer.from('{}'));

    await store.delete('run-1', 'cases/c1/context.json');
    expect(await store.list('run-1')).toEqual(['cases/c1/ledger.jsonl', 'cases/c2/context.json']);
    // meta.json usunięta razem z plikiem, katalog c1 zostaje (niepusty).
    expect(await store.get('run-1', 'cases/c1/ledger.jsonl')).not.toBeNull();

    // Ostatni plik w c2 → katalog c2 znika, ale reszta drzewa zostaje.
    await store.delete('run-1', 'cases/c2/context.json');
    expect(await store.list('run-1')).toEqual(['cases/c1/ledger.jsonl']);

    // Nieistniejący klucz nie rzuca.
    await expect(store.delete('run-1', 'cases/nie-ma.json')).resolves.toBeUndefined();
  });

  it('delete odrzuca ucieczkę z katalogu', async () => {
    const dir = await tmpDir('gp-art-');
    const store = new FsArtifactStore({ dir });
    await expect(store.delete('run-1', '../poza.txt')).rejects.toThrow(/\.\./);
  });

  it('odrzuca ucieczkę z katalogu i puste klucze', async () => {
    const dir = await tmpDir('gp-art-');
    const store = new FsArtifactStore({ dir });
    await expect(store.put('run-1', '../poza.txt', Buffer.from('x'))).rejects.toThrow(/\.\./);
    await expect(store.put('run-1', 'a/../../poza.txt', Buffer.from('x'))).rejects.toThrow(/\.\./);
    await expect(store.get('run-1', '/etc/passwd')).rejects.toThrow(/relative/i);
    await expect(store.put('run-1', '', Buffer.from('x'))).rejects.toThrow(/empty/i);
    await expect(store.put('../run', 'a.txt', Buffer.from('x'))).rejects.toThrow(/runId/i);
  });
});

// Windows: 'C:\x' też jest ścieżką absolutną, a 'C:x' - drive-relative. Wzorzec
// `startsWith('/')` żadnej z nich nie łapał, więc klucz z literą dysku przechodził
// przez wartownika.
describe('assertSafeKey - ścieżki absolutne Windows', () => {
  it('odrzuca literę dysku w każdej postaci', () => {
    expect(() => assertSafeKey('C:/x')).toThrow(/relative/i);
    expect(() => assertSafeKey('C:x')).toThrow(/relative/i);
    expect(() => assertSafeKey('c:\\x')).toThrow(/relative/i);
  });

  it('nadal odrzuca POSIX-owe absolutne i ucieczkę katalogiem wyżej', () => {
    expect(() => assertSafeKey('/x')).toThrow(/relative/i);
    expect(() => assertSafeKey('../x')).toThrow(/\.\./);
    // UNC po normalizacji '\' → '/' zaczyna się od '/', więc łapie go ta sama bramka.
    expect(() => assertSafeKey('\\\\server\\share\\x')).toThrow(/relative/i);
  });

  it('przepuszcza klucze relatywne, także z dwukropkiem w segmencie', () => {
    expect(assertSafeKey('tests/support/pom/a.ts')).toBe('tests/support/pom/a.ts');
    // Dwukropek w środku ścieżki to legalna nazwa pliku na Linuksie - nie ścieżka
    // absolutna. Sprawdzenie litery dysku dotyczy TYLKO początku całej ścieżki.
    expect(assertSafeKey('a/b:c.ts')).toBe('a/b:c.ts');
  });
});
