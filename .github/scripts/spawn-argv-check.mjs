// Pomocnik workflow `.github/workflows/windows.yml`.
//
// Sprawdza round-trip argv przez `spawnArgv()` i `mcpServerCommand()` z
// `@greenproof/core`: to, co wchodzi jako argument, ma wyjść z procesu
// potomnego bit w bit. Na Windows `spawnArgv` prowadzi przez PRAWDZIWY cmd.exe,
// więc to jedyny sposób zweryfikowania escapowania (metaznaki, procenty) bez
// odpalania modelu; `mcpServerCommand` cmd.exe omija i tego też pilnujemy.
// Poza Windowsem obie funkcje są tożsamościowe i skrypt pilnuje tylko, że nic
// się nie zepsuło.
//
// NIE pokrywa: komendy rozwiązującej się do pliku .cmd/.bat (npx.cmd, npm.cmd).
// Batch podstawia `%*` i parsuje linię DRUGI raz, więc tam escapowanie jednego
// poziomu nie wystarcza. run_playwright tej drogi na Windowsie nie używa
// (idzie przez npxDirect), ale `pw.command` z configu może ją przywrócić.
//
// Uruchomienie: GP_EXEC_MODULE=<…>/packages/core/dist/util/exec.js
//               node .github/workflows/spawn-argv-check.mjs [--percent|--mcp]
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modulePath = process.env['GP_EXEC_MODULE'];
if (modulePath === undefined || modulePath === '') {
  console.error('Brak GP_EXEC_MODULE (ścieżka do packages/core/dist/util/exec.js).');
  process.exit(2);
}
// pathToFileURL, bo import() absolutnej ścieżki Windows (C:\…) rzuca
// ERR_UNSUPPORTED_ESM_URL_SCHEME - sam ten krok jest już testem przenośności.
const { spawnArgv, mcpServerCommand, npxDirect } = await import(pathToFileURL(modulePath).href);

const self = fileURLToPath(import.meta.url);
const SEP = '\u0001';

// Wektory jak z realnego `run_playwright`: ścieżkę spec-a i wzorzec `--grep`
// podaje MODEL, więc spacja, `&` czy cudzysłów w argumencie to nie kosmetyka.
const HARD = [
  'zwykly',
  'wzorzec ze spacja',
  'a&b',
  'x|y',
  'c^d',
  'q"uote',
  '(nawias)',
  'gwiazd*ka?',
  'a;b,c',
  'ostre <znaki>',
  'C:\\katalog ze spacja\\spec.ts',
  'koncowy\\backslash\\',
  'tests/e2e/lista faktur.spec.ts',
];
// `%` - daszek PRZED procentem nie blokuje rozwinięcia zmiennej, dlatego
// escapeCmdMeta wstawia go ZARAZ ZA procentem (psuje nazwę). To jest bramka:
// wzorzec `--grep` podaje MODEL, więc rozwinięte `%PATH%` uruchomiłoby nie ten
// zestaw testów, co trzeba.
const PERCENT = ['%PATH%', '%NIE_MA_TAKIEJ_ZMIENNEJ%', '50%', '%%', '%PATH%!%CD%'];
// Kształt spawnu z SDK: `--output-dir` dostaje katalog próby, a ten potrafi mieć
// spację, nawias, a w najgorszym razie `&` (katalog roboczy użytkownika).
// Cytowanie zostaje po stronie Node (bez verbatim), więc metaznaki muszą przejść
// dlatego, że po drodze NIE MA cmd.exe - nie dlatego, że je escapujemy.
const MCP = [
  '--output-dir',
  'C:\\Users\\Runner Admin\\gp (x86)\\playwright',
  'C:\\repo&whoami\\out',
  '--headless',
];

const mode = process.argv[2];

if (mode === '--echo') {
  process.stdout.write(process.argv.slice(3).join(SEP));
  process.exit(0);
}

const cases = mode === '--percent' ? PERCENT : mode === '--mcp' ? MCP : HARD;
// W trybie --mcp wołamy node.exe wprost - dokładnie tak, jak `mcpServerCommand`
// woła node.exe z npx-cli.js. Cytowanie robi Node (libuv), parsuje
// CommandLineToArgvW w node.exe, cmd.exe nie ma po drodze wcale.
const spawned =
  mode === '--mcp'
    ? { ...mcpServerCommand(process.execPath, [self, '--echo', ...cases]), options: {} }
    : spawnArgv(process.execPath, [self, '--echo', ...cases]);

const got = execFileSync(spawned.command, spawned.args, {
  ...spawned.options,
  encoding: 'utf8',
}).split(SEP);

let bad = 0;

// Kształt komendy serwera MCP: na Windowsie ma iść przez node.exe + npx-cli.js.
// `cmd /c npx …` jest tu ZAKAZANE - opcji spawnu nie ustawiamy (robi to SDK),
// więc verbatim jest nieosiągalny, a cytowanie Node'a nie escapuje metaznaków
// cmd.exe (libuv cytuje tylko argumenty ze spacją, tabem lub cudzysłowem).
if (mode === '--mcp' && process.platform === 'win32') {
  const shape = mcpServerCommand('npx', ['@playwright/mcp@latest', '--output-dir', 'C:\\a&b']);
  const przezCmd = /(^|[\\/])cmd(\.exe)?$/i.test(shape.command);
  if (przezCmd) bad += 1;
  console.log(
    `${przezCmd ? 'BLAD' : 'ok  '} [kształt] mcpServerCommand -> ${shape.command} ${JSON.stringify(shape.args)}`,
  );
  const direct = npxDirect(['x']);
  if (direct === undefined) {
    console.log('UWAGA: nie znaleziono npx-cli.js obok node.exe - fallback na gole npx');
  }
}

for (const [i, want] of cases.entries()) {
  const ok = got[i] === want;
  if (!ok) bad += 1;
  console.log(
    `${ok ? 'ok  ' : 'BLAD'} [${i}] oczekiwano ${JSON.stringify(want)}, dostano ${JSON.stringify(got[i] ?? null)}`,
  );
}
if (got.length !== cases.length) {
  console.log(`BLAD liczba argumentow: oczekiwano ${cases.length}, dostano ${got.length}`);
  bad += 1;
}
console.log(bad === 0 ? `round-trip argv (${mode ?? '--hard'}): OK` : `round-trip argv (${mode ?? '--hard'}): ${bad} niezgodnosci`);
process.exit(bad === 0 ? 0 : 1);
