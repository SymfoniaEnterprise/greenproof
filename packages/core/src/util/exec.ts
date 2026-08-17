/**
 * Przenośne uruchamianie narzędzi CLI - obejście Windowsa i ubijanie drzewa
 * procesów.
 *
 * Na Windows npm/npx/pnpm to skrypty `.cmd`, a od CVE-2024-27980
 * `spawn`/`execFile` ODMAWIA uruchomienia `.bat`/`.cmd` bez powłoki (EINVAL).
 * Doklejenie ".cmd" zamienia tylko ENOENT na EINVAL - zostają dwa wyjścia:
 * oddać komendę interpreterowi `cmd.exe` (`spawnArgv`) albo ominąć wrapper
 * `.cmd` i wywołać wprost `node.exe` ze skryptem (`npxDirect`). Drugie jest
 * lepsze wszędzie, gdzie się da: nie ma cmd.exe, nie ma parsera metaznaków.
 *
 * Poza Windowsem funkcje escapujące są tożsamościowe.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Metaznaki, które cmd.exe interpretuje także wewnątrz komendy. `%` NIE jest na
 * liście świadomie - daszek PRZED procentem niczego nie blokuje, patrz
 * `escapeCmdMeta`.
 */
const CMD_META = /[()\][!^"`<>&|;, *?]/;

function isWindows(): boolean {
  return process.platform === 'win32';
}

/** Interpreter poleceń - COMSPEC bywa przestawiony, ale cmd.exe to fallback. */
function comspec(): string {
  const fromEnv = process.env['COMSPEC'];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : 'cmd.exe';
}

/**
 * Neutralizacja metaznaków cmd.exe. Zwykłe metaznaki dostają daszek PRZED sobą,
 * ale procent trzeba odwrotnie: rozwijanie `%ZMIENNA%` idzie w cmd FAZĘ WCZEŚNIEJ
 * niż zdejmowanie daszków, więc `^%PATH^%` nadal rozwija się do zawartości PATH
 * (nazwa `PATH` pozostaje nietknięta). Działa dopiero zepsucie NAZWY: daszek
 * wstawiony ZARAZ ZA procentem sprawia, że cmd szuka zmiennej `^PATH^`, żadnej
 * takiej nie znajduje, a w linii poleceń (inaczej niż w pliku .bat) nierozwinięty
 * tekst zostaje bez zmian - po zdjęciu daszków wraca dokładnie `%PATH%`.
 *
 * Ten sam daszek escapuje przy okazji następny znak, więc nie dokładamy drugiego.
 * Procent na SAMYM KOŃCU tekstu zostaje goły (daszek na końcu linii to sklejenie
 * wierszy) - jest bezpieczny, bo nie ma już czym domknąć nazwy zmiennej.
 */
function escapeCmdMeta(text: string): string {
  let out = '';
  let caretOwed = false;
  for (const ch of text) {
    if (caretOwed || CMD_META.test(ch)) out += '^';
    caretOwed = ch === '%';
    out += ch;
  }
  return out;
}

/** Nazwa komendy: sam escape metaznaków, bez cudzysłowów - inaczej cmd nie
 *  rozwinie PATHEXT i nie znajdzie npx.cmd po samej nazwie. */
function escapeCommand(command: string): string {
  return escapeCmdMeta(command);
}

/**
 * Argument: najpierw cudzysłowy wg CommandLineToArgvW (backslashe przed
 * cudzysłowem i na końcu argumentu się podwajają), potem escape metaznaków.
 * Algorytm jak w cross-spawn / https://qntm.org/cmd, plus poprawka na procenty.
 * Stawką jest wstrzyknięcie komendy: argv `run_playwright` niesie wzorzec
 * `--grep` pochodzący OD MODELU.
 */
function escapeArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return escapeCmdMeta(quoted);
}

/** Opcje, które MUSZĄ trafić do execFile/spawn razem z wynikiem `spawnArgv`. */
export interface SpawnArgvOptions {
  /** Na Windows linię poleceń składamy sami - Node nie może jej cytować drugi raz. */
  windowsVerbatimArguments?: true;
}

export interface SpawnArgv {
  command: string;
  args: string[];
  options: SpawnArgvOptions;
}

/**
 * Komenda dla `execFile`/`spawn` tam, gdzie KONTROLUJEMY opcje wywołania.
 * Na Windows owija w `cmd.exe /d /s /c "…"` z ręcznym escapowaniem, więc
 * działa dla dowolnych argumentów (także ze spacjami).
 *
 * Zwrócone `options` rozpakowujesz do opcji spawnu:
 * `execFileP(command, args, { cwd, ...options })`.
 */
export function spawnArgv(command: string, args: readonly string[]): SpawnArgv {
  if (!isWindows()) return { command, args: [...args], options: {} };
  const line = [escapeCommand(command), ...args.map(escapeArgument)].join(' ');
  return {
    command: comspec(),
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
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
  if (!isWindows()) return undefined;
  // Układ instalacji npm na Windowsie (oficjalny instalator, nvm-windows, fnm,
  // volta): npx-cli.js leży w node_modules\npm\bin obok samego node.exe.
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (!existsSync(cli)) return undefined;
  return { command: process.execPath, args: [cli, ...args] };
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
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Twardy limit czasu; po nim leci cała grupa procesów, nie samo dziecko. */
  timeoutMs: number;
  /** Z `spawnArgv` - linia poleceń złożona ręcznie. */
  windowsVerbatimArguments?: true;
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
      const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
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
    try {
      child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: 'ignore',
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

    let timedOut = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const softKill = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      hardKill = setTimeout(() => killTree(child, 'SIGKILL'), HARD_KILL_DELAY_MS);
      hardKill.unref();
    }, opts.timeoutMs);

    let settled = false;
    const settle = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(softKill);
      if (hardKill !== undefined) clearTimeout(hardKill);
      liveTrees.delete(child);
      resolve(outcome);
    };

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
