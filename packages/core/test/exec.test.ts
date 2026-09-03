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
    writeFileSync(join(binDir, 'npm-cli.js'), '');
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

  it('na Windows uruchamia npx przez node.exe bez cmd.exe', () => {
    stubPlatform('win32');
    const exe = stubNodeInstall(true);
    const r = spawnArgv('npx', ['playwright', 'test']);
    expect(r.command).toBe(exe);
    expect(r.args).toEqual([join(exe, '..', 'node_modules', 'npm', 'bin', 'npx-cli.js'), 'playwright', 'test']);
    expect(r.options).toEqual({});
  });

  it('na Windows uruchamia npm przez node.exe bez cmd.exe', () => {
    stubPlatform('win32');
    const exe = stubNodeInstall(true);
    expect(spawnArgv('npm', ['install']).command).toBe(exe);
  });

  it('na Windows nie zmienia niepowłokowych komend', () => {
    stubPlatform('win32');
    expect(spawnArgv('playwright.exe', ['--grep', 'logowanie & wylogowanie'])).toEqual({
      command: 'playwright.exe',
      args: ['--grep', 'logowanie & wylogowanie'],
      options: {},
    });
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
