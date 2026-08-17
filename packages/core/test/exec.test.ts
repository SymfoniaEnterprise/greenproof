import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpServerCommand, npxDirect, spawnArgv } from '../src/util/exec.js';

/** process.platform to getter na prototypie - stubujemy deskryptor właściwości. */
function stubPlatform(value: NodeJS.Platform) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(value);
}

const realExecPath = process.execPath;

/** Udaje układ instalacji Node/npm: <dir>\node.exe + <dir>\node_modules\npm\bin. */
function stubNodeInstall(withNpm: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'gp-node-'));
  const exe = join(dir, 'node.exe');
  writeFileSync(exe, '');
  if (withNpm) {
    const binDir = join(dir, 'node_modules', 'npm', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'npx-cli.js'), '');
  }
  process.execPath = exe;
  return exe;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.execPath = realExecPath;
});

describe('spawnArgv', () => {
  it('poza Windowsem przepuszcza komendę i argumenty bez zmian', () => {
    stubPlatform('linux');
    const r = spawnArgv('npx', ['playwright', 'test', '--reporter=json']);
    expect(r.command).toBe('npx');
    expect(r.args).toEqual(['playwright', 'test', '--reporter=json']);
    expect(r.options).toEqual({});
  });

  it('poza Windowsem nie ustawia windowsVerbatimArguments', () => {
    stubPlatform('darwin');
    expect(spawnArgv('npm', ['install']).options.windowsVerbatimArguments).toBeUndefined();
  });

  it('na Windows owija komendę w cmd.exe /d /s /c i włącza tryb verbatim', () => {
    stubPlatform('win32');
    vi.stubEnv('COMSPEC', '');
    const r = spawnArgv('npx', ['playwright', 'test']);
    expect(r.command).toBe('cmd.exe');
    expect(r.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(r.args).toHaveLength(4);
    expect(r.options).toEqual({ windowsVerbatimArguments: true });
  });

  it('na Windows nie cytuje samej nazwy komendy - inaczej cmd nie rozwinie PATHEXT', () => {
    stubPlatform('win32');
    const line = spawnArgv('npx', []).args[3] ?? '';
    expect(line).toBe('"npx"');
  });

  it('na Windows honoruje COMSPEC', () => {
    stubPlatform('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    expect(spawnArgv('npm', ['install']).command).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('na Windows cytuje argumenty ze spacjami', () => {
    stubPlatform('win32');
    const line = spawnArgv('npx', ['tests/moje testy/a.spec.ts']).args[3] ?? '';
    // Argument dostaje cudzysłowy, a spacja - jak każdy metaznak cmd - daszek.
    expect(line).toContain('^"tests/moje^ testy/a.spec.ts^"');
  });

  it('na Windows escapuje metaznaki cmd we wzorcu --grep', () => {
    stubPlatform('win32');
    const line = spawnArgv('npx', ['--grep', 'logowanie & wylogowanie']).args[3] ?? '';
    // & musi zostać zneutralizowane, inaczej cmd potraktuje je jako separator komend
    expect(line).toContain('^&');
    expect(line).not.toMatch(/[^^]&/);
  });

  it('na Windows psuje nazwę zmiennej po procencie (daszek PRZED % nie działa)', () => {
    stubPlatform('win32');
    const line = spawnArgv('npx', ['--grep', '%PATH%']).args[3] ?? '';
    // `^%PATH^%` cmd i tak rozwinie - nazwa PATH zostaje nietknięta. Blokuje
    // dopiero daszek ZARAZ ZA procentem: cmd szuka zmiennej `^PATH^`, nie znajduje,
    // a w linii poleceń nierozwinięty tekst zostaje - po zdjęciu daszków wraca `%PATH%`.
    expect(line).toContain('^"%^PATH%^"');
    // Niezmiennik: po ŻADNYM procencie nie stoi znak, który mógłby zacząć nazwę zmiennej.
    expect(line).not.toMatch(/%(?!\^)/);
  });

  it('na Windows radzi sobie z podwójnym procentem i procentem na końcu', () => {
    stubPlatform('win32');
    expect(spawnArgv('npx', ['--grep', '%%']).args[3] ?? '').toContain('^"%^%^"');
    expect(spawnArgv('npx', ['--grep', '100%']).args[3] ?? '').toContain('^"100%^"');
  });

  it('na Windows podwaja backslashe przed cudzysłowem w argumencie', () => {
    stubPlatform('win32');
    const line = spawnArgv('npx', ['a\\"b']).args[3] ?? '';
    expect(line).toContain('a\\\\\\^"b');
  });

  it('cała linia poleceń jest opakowana w cudzysłowy dla /s', () => {
    stubPlatform('win32');
    const line = spawnArgv('npx', ['playwright', 'test']).args[3] ?? '';
    expect(line.startsWith('"')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
  });
});

describe('npxDirect', () => {
  it('poza Windowsem nie ma czego omijać - undefined', () => {
    stubPlatform('linux');
    stubNodeInstall(true);
    expect(npxDirect(['@playwright/mcp@latest'])).toBeUndefined();
  });

  it('na Windows wskazuje node.exe i npx-cli.js obok niego', () => {
    stubPlatform('win32');
    const exe = stubNodeInstall(true);
    const r = npxDirect(['@playwright/mcp@latest', '--headless']);
    expect(r?.command).toBe(exe);
    expect(r?.args).toEqual([
      join(exe, '..', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
      '@playwright/mcp@latest',
      '--headless',
    ]);
  });

  it('bez npx-cli.js obok node.exe zwraca undefined', () => {
    stubPlatform('win32');
    stubNodeInstall(false);
    expect(npxDirect(['@playwright/mcp@latest'])).toBeUndefined();
  });
});

describe('mcpServerCommand', () => {
  const args = ['@playwright/mcp@latest', '--isolated', '--browser', 'chromium'];

  it('poza Windowsem zwraca komendę i argumenty bez zmian', () => {
    stubPlatform('linux');
    expect(mcpServerCommand('npx', args)).toEqual({ command: 'npx', args });
  });

  it('na Windows omija cmd.exe: node.exe + npx-cli.js, argumenty co do jednego', () => {
    stubPlatform('win32');
    const exe = stubNodeInstall(true);
    const r = mcpServerCommand('npx', args);
    // Kluczowe: ŻADNEGO cmd.exe. Opcji spawnu tu nie ustawiamy (robi to SDK),
    // więc verbatim jest nieosiągalny, a `cmd /c` z cytowaniem Node'a przepuszcza
    // metaznaki (`&` w --output-dir rozdzieliłby komendę).
    expect(r.command).toBe(exe);
    expect(r.args.slice(1)).toEqual(args);
  });

  it('na Windows bez npx-cli.js zostaje gołe npx - nigdy cmd /c', () => {
    stubPlatform('win32');
    stubNodeInstall(false);
    const r = mcpServerCommand('npx', args);
    expect(r).toEqual({ command: 'npx', args });
  });

  it('nie mutuje wejściowej tablicy argumentów', () => {
    stubPlatform('win32');
    stubNodeInstall(true);
    const input = [...args];
    mcpServerCommand('npx', input);
    expect(input).toEqual(args);
  });
});
