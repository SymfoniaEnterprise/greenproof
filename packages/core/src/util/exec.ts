/**
 * Przenośne uruchamianie narzędzi CLI - obejście Windowsa i ubijanie drzewa
 * procesów.
 *
 * Na Windows npm/npx/pnpm to skrypty `.cmd`, a od CVE-2024-27980
 * `spawn`/`execFile` ODMAWIA uruchomienia `.bat`/`.cmd` bez powłoki (EINVAL).
 * Nie przekazujemy danych do `cmd.exe`: dla npm/npx omijamy wrapper `.cmd` i
 * wywołujemy wprost `node.exe` ze skryptem CLI. Pozostałe komendy trafiają do
 * `spawn` jako rozdzielone argv, bez powłoki.
 */
import { createRequire } from 'node:module';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const crossSpawn = createRequire(import.meta.url)('cross-spawn') as typeof nodeSpawn;

function isWindows(): boolean {
  return process.platform === 'win32';
}

export interface SpawnArgvOptions {}

export interface SpawnArgv {
  command: string;
  args: string[];
  options: SpawnArgvOptions;
}

/**
 * Komenda dla `execFile`/`spawn`, bez przekazywania argumentów przez powłokę.
 * Zwrócone `options` rozpakowujesz do opcji spawnu:
 * `execFileP(command, args, { cwd, ...options })`.
 */
export function spawnArgv(command: string, args: readonly string[]): SpawnArgv {
  if (/\.(?:c|m)?js$/i.test(command)) {
    return { command: process.execPath, args: [command, ...args], options: {} };
  }
  const direct = packageManagerDirect(command, args);
  return direct === undefined ? { command, args: [...args], options: {} } : { ...direct, options: {} };
}

function packageManagerDirect(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } | undefined {
  if (!isWindows()) return undefined;
  const script = command === 'npx' ? 'npx-cli.js' : command === 'npm' ? 'npm-cli.js' : undefined;
  if (script === undefined) return undefined;
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', script);
  return existsSync(cli) ? { command: process.execPath, args: [cli, ...args] } : undefined;
}

/**
 * `npx` na Windowsie BEZ cmd.exe: wprost `node.exe <…>\npm\bin\npx-cli.js …`,
 * czyli dokładnie to, co robi wrapper npx.cmd. Cel: żaden argument nie przechodzi
 * przez parser cmd.exe, więc `&`, `%` czy cudzysłów w ścieżce nie mają jak
 * rozjechać komendy. EINVAL z CVE-2024-27980 też nie dotyczy - to `.exe` i `.js`,
 * nie `.cmd`.
 *
 * Zwraca `undefined`, gdy nie ma czego uruchomić (nie-Windows albo npm nie leży
 * obok bieżącego node'a) - wtedy wołający zostaje przy swojej dotychczasowej
 * drodze.
 */
export function npxDirect(
  args: readonly string[],
): { command: string; args: string[] } | undefined {
  return packageManagerDirect('npx', args);
}

/**
 * Komenda dla spawnu, nad którego opcjami NIE mamy kontroli - w praktyce
 * `mcpServers` w Claude Agent SDK.
 *
 * Na Windowsie NIE wolno tu użyć `spawnArgv`: ręcznie złożona linia poleceń
 * wymaga `windowsVerbatimArguments`, a tej opcji nie ustawimy. Odrzucona została
 * też konwencja `cmd /c npx …`: Node cytuje argumenty ze spacjami, ale metaznaków
 * cmd.exe NIE escapuje (libuv cytuje wyłącznie argumenty ze spacją, tabem lub
 * cudzysłowem), więc `&` w ścieżce `--output-dir` rozdzieliłby komendę.
 *
 * Zostaje `npxDirect` - node.exe ze skryptem npx-cli.js, bez cmd.exe po drodze.
 * Gdy npx-cli.js nie da się znaleźć, oddajemy gołe `npx`: klient MCP w SDK
 * spawnuje przez cross-spawn, a ten sam wykrywa `.cmd` i owija je w
 * `cmd.exe /d /s /c` z verbatim i własnym escapowaniem.
 */
export function mcpServerCommand(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const direct = command === 'npx' ? npxDirect(args) : undefined;
  return direct ?? { command, args: [...args] };
}

export interface RunOutcome {
  /** Kod wyjścia procesu; `null`, gdy zginął od sygnału. */
  exitCode: number | null;
  /** Sygnał, który go ubił (jeśli był). */
  signal: NodeJS.Signals | null;
  /** Ubity przez NASZ limit czasu - razem z całym drzewem potomków. */
  timedOut: boolean;
  /** Awaria samego SPAWNU (ENOENT/EINVAL) - to nie to samo, co niezerowy kod. */
  spawnError?: NodeJS.ErrnoException;
  /** Proces nie wyemitował żadnych danych przed watchdogiem startu. */
  timedOutBeforeOutput?: boolean;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Twardy limit czasu; po nim leci cała grupa procesów, nie samo dziecko. */
  timeoutMs: number;
  /** Z `spawnArgv` - linia poleceń złożona ręcznie. */
  windowsVerbatimArguments?: true;
  /** Przechwyć stdout procesu przez callback zamiast kierować go do `ignore`. */
  onStdout?: (chunk: string) => void;
  /** Przechwyć stderr procesu przez callback zamiast kierować go do `ignore`. */
  onStderr?: (chunk: string) => void;
  /** Twardy watchdog startu; osobny od limitu całej sesji. */
  firstOutputTimeoutMs?: number;
  /** Dla sesji strumieniowych: dane są wyjściem dopiero po spełnieniu predykatu. */
  firstOutputReady?: () => boolean;
  /** Zewnętrzny kill switch, np. cap tur sesji Copilot. */
  abortSignal?: AbortSignal;
}

/** Żywe drzewa procesów - do sprzątnięcia, gdy host dostanie sygnał. */
const liveTrees = new Set<ChildProcess>();
let hostSignalsHooked = false;

/** Ile czekamy na łagodne zejście grupy, zanim pójdzie SIGKILL. */
const HARD_KILL_DELAY_MS = 5_000;

/**
 * Ubija CAŁE drzewo, nie samo dziecko. Bez tego timeout zdejmuje `npx`, a jego
 * potomkowie (node → playwright → przeglądarki) żyją dalej i następny przebieg
 * dzieli z sierotą aplikację, przeglądarkę i pliki raportów.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows()) {
    // Windows nie ma grup procesów w sensie POSIX - drzewo po PPID zdejmuje
    // taskkill /T. Sam `child.kill()` osierociłby potomków, zanim taskkill
    // zdąży ich policzyć, więc leci dopiero jako fallback.
    try {
      const tk = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      tk.once('error', () => {
        try {
          child.kill();
        } catch {
          /* już nie żyje */
        }
      });
      tk.unref();
    } catch {
      try {
        child.kill();
      } catch {
        /* już nie żyje */
      }
    }
    return;
  }
  // POSIX: dziecko poszło z `detached`, więc jest liderem własnej grupy i `-pid`
  // trafia w całą grupę (nigdy w nas - my mamy inne pgid).
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* już nie żyje */
    }
  }
}

/**
 * Ctrl+C w terminalu hosta nie dosięga procesu odłączonego do własnej grupy -
 * bez tego poprawka na sieroty po timeoucie zamieniłaby jeden wyciek na drugi.
 */
function hookHostSignals(): void {
  if (hostSignalsHooked) return;
  hostSignalsHooked = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      for (const child of liveTrees) killTree(child, 'SIGKILL');
      // Własny handler ZDEJMUJE domyślne zakończenie procesu przez Node - i tylko
      // wtedy je odtwarzamy. Gdy host ma swój handler, sprzątanie należy do niego.
      if (process.listenerCount(signal) === 1) process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
  process.on('exit', () => {
    for (const child of liveTrees) killTree(child, 'SIGKILL');
  });
}

/**
 * Uruchamia proces do końca i NIGDY nie rzuca: niezerowy kod wyjścia to normalny
 * wynik (czerwone testy), a awaria spawnu i timeout mają własne pola.
 *
 * Wyjście procesu idzie do `ignore`: raport czytamy z pliku, a nieczytana rura
 * potrafiłaby zablokować proces potomny (i po co nam bufor na megabajty logów).
 */
export function runToCompletion(
  command: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let timedOutBeforeOutput = false;
    let timedOut = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let firstOutputSeen = false;
    let firstOutputTimer: ReturnType<typeof setTimeout> | undefined;
    const markOutput = (chunk: Buffer | string, callback?: (value: string) => void): void => {
      callback?.(chunk.toString());
      if (firstOutputSeen || (opts.firstOutputReady !== undefined && !opts.firstOutputReady())) return;
      firstOutputSeen = true;
      if (firstOutputTimer !== undefined) {
        clearTimeout(firstOutputTimer);
        firstOutputTimer = undefined;
      }
    };

    try {
      child = crossSpawn(command, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: opts.onStdout !== undefined || opts.onStderr !== undefined
          ? ['ignore', opts.onStdout !== undefined ? 'pipe' : 'ignore', opts.onStderr !== undefined ? 'pipe' : 'ignore']
          : 'ignore',
        // POSIX: własna grupa procesów, żeby dało się ubić CAŁE drzewo.
        detached: !isWindows(),
        ...(opts.windowsVerbatimArguments !== undefined
          ? { windowsVerbatimArguments: opts.windowsVerbatimArguments }
          : {}),
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: err as NodeJS.ErrnoException,
      });
      return;
    }

    liveTrees.add(child);
    hookHostSignals();

    if (opts.onStdout !== undefined && child.stdout !== null) {
      child.stdout.on('data', (chunk: Buffer | string) => markOutput(chunk, opts.onStdout));
    }
    if (opts.onStderr !== undefined && child.stderr !== null) {
      child.stderr.on('data', (chunk: Buffer | string) => markOutput(chunk, opts.onStderr));
    }
    if (opts.firstOutputTimeoutMs !== undefined) {
      firstOutputTimer = setTimeout(() => {
        if (firstOutputSeen) return;
        timedOutBeforeOutput = true;
        timedOut = true;
        killTree(child, 'SIGTERM');
        hardKill = setTimeout(() => killTree(child, 'SIGKILL'), HARD_KILL_DELAY_MS);
        hardKill.unref();
      }, opts.firstOutputTimeoutMs);
      firstOutputTimer.unref();
    }

    let softKill: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      hardKill = setTimeout(() => killTree(child, 'SIGKILL'), HARD_KILL_DELAY_MS);
      hardKill.unref();
    }, opts.timeoutMs);
    softKill.unref();

    let settled = false;
    const abortChild = (): void => {
      if (settled) return;
      if (softKill !== undefined) {
        clearTimeout(softKill);
        softKill = undefined;
      }
      killTree(child, 'SIGTERM');
      hardKill = setTimeout(() => killTree(child, 'SIGKILL'), HARD_KILL_DELAY_MS);
      hardKill.unref();
    };
    const settle = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      if (softKill !== undefined) clearTimeout(softKill);
      if (hardKill !== undefined) clearTimeout(hardKill);
      if (firstOutputTimer !== undefined) clearTimeout(firstOutputTimer);
      if (opts.abortSignal !== undefined && abortListener !== undefined) {
        opts.abortSignal.removeEventListener('abort', abortListener);
      }
      liveTrees.delete(child);
      resolve({ ...outcome, ...(timedOutBeforeOutput ? { timedOutBeforeOutput: true } : {}) });
    };

    const abortListener = (): void => abortChild();
    if (opts.abortSignal !== undefined) {
      if (opts.abortSignal.aborted) abortChild();
      else opts.abortSignal.addEventListener('abort', abortListener, { once: true });
    }

    child.once('error', (err) => {
      settle({
        exitCode: null,
        signal: null,
        timedOut,
        spawnError: err as NodeJS.ErrnoException,
      });
    });
    child.once('close', (code, signal) => {
      settle({ exitCode: code, signal, timedOut });
    });
  });
}
