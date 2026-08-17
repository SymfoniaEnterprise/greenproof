// setup-cli.mjs - zaklada wrappery `grp` i `greenproof` wskazujace na build
// dist monorepo. Repo moze stac gdziekolwiek - sciezke ustalamy z polozenia
// TEGO skryptu (import.meta.url), nie z process.cwd().
//
// Na Windowsie wrappery to pliki `.cmd` w %LOCALAPPDATA%\greenproof\bin.
// Skrypt bywa uruchamiany BEZ builda (`node scripts/setup-cli.mjs`), więc nie
// importuje niczego z `@greenproof/core` - potrzebne obejścia Windowsa
// (`spawnArgv` z packages/core/src/util/exec.ts) ma zduplikowane lokalnie.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const FORCE = process.argv.includes("--force");
const IS_WINDOWS = process.platform === "win32";

const scriptPath = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(scriptPath), "..");
const mainJs = path.join(repoDir, "packages", "cli", "dist", "main.js");

/**
 * Katalog na wrappery. Poza Windowsem konwencja XDG (`~/.local/bin`).
 * Na Windowsie XDG nie istnieje, a %LOCALAPPDATA% to właściwe miejsce na
 * rzeczy per-maszyna: wrapper zawiera ABSOLUTNĄ ścieżkę do tej kopii repo,
 * więc %APPDATA% (roaming, synchronizowany między maszynami) rozniósłby po
 * innych komputerach ścieżkę, której tam nie ma. Ten sam wybór co katalog
 * danych runu w `packages/cli/src/commands.ts`.
 */
function defaultBinDir() {
  if (IS_WINDOWS) {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "greenproof", "bin");
  }
  return path.join(os.homedir(), ".local", "bin");
}

const targetDir = process.env.XDG_BIN_HOME || defaultBinDir();
const wrapperNames = ["grp", "greenproof"];

/** Nazwa pliku wrappera - na Windowsie PATHEXT wymaga rozszerzenia. */
function wrapperFile(name) {
  return IS_WINDOWS ? `${name}.cmd` : name;
}

function expandHome(str) {
  if (str === "~") return os.homedir();
  if (str.startsWith("~/")) return path.join(os.homedir(), str.slice(2));
  const expanded = str
    .replace(/\$\{HOME\}/g, os.homedir())
    .replace(/\$HOME\b/g, os.homedir());
  // Windowsowy odpowiednik $HOME w ręcznie napisanym wrapperze.
  return IS_WINDOWS ? expanded.replace(/%USERPROFILE%/gi, os.homedir()) : expanded;
}

function canonicalize(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Porównanie ścieżek - Windowsowy filesystem jest case-insensitive. */
function samePath(a, b) {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function displayPath(p) {
  const home = os.homedir();
  if (p === home) return "$HOME";
  if (p.startsWith(home + path.sep)) return "$HOME" + p.slice(home.length);
  return p;
}

// --- Obejście Windowsa dla spawnu (kopia packages/core/src/util/exec.ts) -----
// Od łatki CVE-2024-27980 (Node 18.20.2/20.12.2/21.7.3) spawn/spawnSync ODMAWIA
// uruchomienia pliku `.bat`/`.cmd` bez powłoki i rzuca EINVAL. Jedyne wyjście:
// oddać komendę interpreterowi cmd.exe i samemu złożyć linię poleceń.
// Procent NIE jest na liscie metaznakow: daszek PRZED nim nie blokuje
// rozwijania %ZMIENNEJ% (rozwijanie idzie faze wczesniej niz zdejmowanie
// daszkow). Blokuje dopiero daszek ZARAZ ZA procentem - psuje nazwe zmiennej,
// a nierozwiniety tekst w linii polecen zostaje bez zmian.
const CMD_META = /[()\][!^"`<>&|;, *?]/;

function escapeCmdMeta(text) {
  let out = "";
  let caretOwed = false;
  for (const ch of text) {
    if (caretOwed || CMD_META.test(ch)) out += "^";
    caretOwed = ch === "%";
    out += ch;
  }
  return out;
}

function escapeCommand(command) {
  return escapeCmdMeta(command);
}

function escapeArgument(arg) {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return escapeCmdMeta(quoted);
}

function spawnArgv(command, args) {
  if (!IS_WINDOWS) return { command, args: [...args], options: {} };
  const line = [escapeCommand(command), ...args.map(escapeArgument)].join(" ");
  return {
    command: process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
// ----------------------------------------------------------------------------

// Wyciaga sciezke docelowa z istniejacego wrappera (pierwszy cudzyslow z main.js)
// i kanonizuje ja, zeby moc porownac z naszym dist/main.js. Wrapper .cmd trzyma
// sciezke w tych samych cudzyslowach co bashowy, wiec wzorzec jest wspolny.
function extractTarget(content, wrapperDir) {
  const match = content.match(/(["'])([^"']*main\.js[^"']*)\1/);
  if (!match) return null;
  return canonicalize(path.resolve(wrapperDir, expandHome(match[2])));
}

/**
 * Treść wrappera. Windowsowy wariant:
 * - `%*` przekazuje ogon linii poleceń VERBATIM, więc cytowanie argumentów ze
 *   spacjami zostaje nietknięte, a podstawiony tekst nie jest już ponownie
 *   skanowany za `%ZMIENNYMI%` (podstawienie parametrów idzie po rozwijaniu
 *   procentów) - `--grep "100% ok"` przechodzi w całości;
 * - `exit /b %ERRORLEVEL%` zwraca kod wyjścia node'a wołającemu. To nie jest
 *   kosmetyka: kody 3/5/10 greenproofa sterują przepływem CI;
 * - CRLF, bo cmd.exe potrafi się zakrztusić plikiem .cmd z samymi LF.
 */
function wrapperContent() {
  if (IS_WINDOWS) {
    return ["@echo off", `node "${mainJs}" %*`, "exit /b %ERRORLEVEL%", ""].join("\r\n");
  }
  return `#!/usr/bin/env bash\nexec node "${mainJs}" "$@"\n`;
}

function isOnPath(dir) {
  const dirCanonical = canonicalize(dir);
  return (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    // Wpisy PATH na Windowsie bywaja cytowane; poza Windowsem cudzyslow jest
    // legalnym znakiem nazwy pliku, wiec nie ruszamy.
    .map((entry) => (IS_WINDOWS ? entry.replace(/^"(.*)"$/, "$1") : entry))
    .filter(Boolean)
    .some((entry) => samePath(canonicalize(entry), dirCanonical));
}

function pathHint() {
  if (IS_WINDOWS) {
    return (
      `\n[setup-cli] UWAGA: katalog ${targetDir} nie jest w PATH.` +
      `\n  Dopisz go do PATH uzytkownika (PowerShell, jednorazowo):\n` +
      `\n  [Environment]::SetEnvironmentVariable('Path',` +
      ` [Environment]::GetEnvironmentVariable('Path','User') + ';${targetDir}', 'User')\n` +
      `\n  Potem otworz NOWE okno terminala. Nie uzywaj "setx PATH" - obcina PATH do 1024 znakow.\n`
    );
  }
  return (
    `\n[setup-cli] UWAGA: katalog ${targetDir} nie jest w PATH.` +
    `\n  Dopisz ponizsza linijke do ~/.bashrc lub ~/.zshrc:\n` +
    `\n  export PATH="${displayPath(targetDir)}:$PATH"\n`
  );
}

function runWrapper(name) {
  const dest = path.join(targetDir, wrapperFile(name));
  const argv = spawnArgv(dest, ["--version"]);
  const res = spawnSync(argv.command, argv.args, {
    encoding: "utf8",
    ...argv.options,
  });
  if (res.error) {
    console.error(`[setup-cli] nie udalo sie uruchomic ${name}: ${res.error.message}`);
    process.exit(1);
  }
  const out = (res.stdout || "").trim();
  if (res.status !== 0 || !out) {
    console.error(`[setup-cli] ${name} --version zawiodl (exit ${res.status})`);
    process.exit(1);
  }
  return out;
}

/** chmod ma sens tylko na POSIX - na Windowsie przestawia jedynie read-only. */
function writeWrapper(dest) {
  fs.writeFileSync(dest, wrapperContent());
  if (!IS_WINDOWS) fs.chmodSync(dest, 0o755);
}

if (!fs.existsSync(mainJs)) {
  console.error(`[setup-cli] Brak ${mainJs}. Zbuduj najpierw: pnpm build`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

const targetCanonical = canonicalize(mainJs);
let conflict = false;

for (const name of wrapperNames) {
  const dest = path.join(targetDir, wrapperFile(name));
  if (fs.existsSync(dest)) {
    const existingTarget = extractTarget(fs.readFileSync(dest, "utf8"), targetDir);
    if (existingTarget && samePath(existingTarget, targetCanonical)) {
      console.log(`[setup-cli] ${name}: juz aktualny (${mainJs})`);
      continue;
    }
    if (FORCE) {
      writeWrapper(dest);
      console.log(`[setup-cli] ${name}: nadpisano (--force) -> ${mainJs}`);
      continue;
    }
    console.error(
      `[setup-cli] ${name}: istnieje i wskazuje gdzies indziej (inna kopia repo).\n` +
        `  Nie nadpisuje. Uruchom ponownie z --force, zeby nadpisac: node scripts/setup-cli.mjs --force`
    );
    conflict = true;
    continue;
  }
  writeWrapper(dest);
  console.log(`[setup-cli] ${name}: utworzono -> ${mainJs}`);
}

if (conflict) {
  process.exit(2);
}

if (!isOnPath(targetDir)) {
  console.log(pathHint());
}

const grpVersion = runWrapper("grp");
const greenproofVersion = runWrapper("greenproof");
console.log(`\n[setup-cli] OK. grp --version -> ${grpVersion}`);
console.log(`[setup-cli] OK. greenproof --version -> ${greenproofVersion}`);
