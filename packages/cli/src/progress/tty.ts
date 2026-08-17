/**
 * Renderer "tablica statusu" dla terminala interaktywnego: kilkulinijkowy widok
 * na stderr odświeżany W MIEJSCU (cursor-up + erase-down). Stanowość lokalna -
 * obraz składa wyłącznie ze zdarzeń `ProgressEvent`, nie zna configu.
 *
 * Bez TTY (albo z NO_COLOR) gasną kolory; bez TTY także sekwencje kursora -
 * tablica dopisuje się pod spodem. Normalnie TTY gwarantuje wybór w main.ts.
 */
import type { CaseStatus, ProgressEvent, ProgressPlaywright, RunRollup } from '@greenproof/core';
import type { ProgressRenderer, RendererIo } from './types.js';
import { awatar, stanZFazy, stanZeStatusu, type StanAwatara } from './avatar.js';

// Sekwencje ANSI trzymamy ręcznie - żadnych zewnętrznych zależności.
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const ERASE_DOWN = '\x1b[0J';

/** Minimalny odstęp między przerysowaniami dla zdarzeń "strumieniowych". */
const MIN_ODSTEP_MS = 250;
const DOMYSLNA_SZEROKOSC = 100;
/** Ramka nie rozciąga się na całą szerokość szerokiego terminala. */
const MAX_SZEROKOSC_RAMKI = 76;
const WHITE = '\x1b[97m';
/** Klatki spinnera „run żyje" - brajlowskie, jednokolumnowe. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** `⌜◉◉⌝` + spacja - stała szerokość mikro-awatara w nagłówku. */
const AWATAR_KOLUMNY = 5;
/** Okres przesuwu błysku na pasku postępu (i timer odświeżania w TTY). */
const BLYSK_MS = 120;

/** Fragment linii: treść + opcjonalny prefiks ANSI (może łączyć kilka kodów). */
interface Fragment {
  text: string;
  color?: string;
}

/** Migawka trwającej sesji autora - żyje od case-start do case-end. */
interface StanSesji {
  caseId: string;
  attempt: number;
  phase: string | undefined;
  turns: number;
  maxTurns: number;
  elapsedSec: number;
  maxTimeSec: number;
  costUsd: number;
  maxCostUsd: number;
  pw: ProgressPlaywright | undefined;
  lastEvent: string | undefined;
}

export function createTtyRenderer(io: RendererIo): ProgressRenderer {
  const kolory = io.isTTY && !io.env['NO_COLOR'];
  // Bez TTY nie ruszamy kursorem - zaśmieciłby plik z logiem.
  const kursor = io.isTTY;

  let runId: string | undefined;
  let model: string | undefined;
  let rollup: RunRollup | undefined;
  let sesja: StanSesji | undefined;
  let krok: string | undefined;
  /** Ostatni status z `case-end` - trzyma minę końcową aż do `case-start`. */
  let ostatniStatus: CaseStatus | undefined;
  /** Trwa dowód mutacyjny: `playwright-run` z `pool: 'proof'` do najbliższego turn. */
  let dowod = false;

  let narysowaneLinie = 0;
  let kursorUkryty = false;
  let ostatnieRysowanie = Number.NEGATIVE_INFINITY;
  /** Timer błysku paska - tylko w TTY; unref, żeby nie trzymał procesu. */
  let blysk: ReturnType<typeof setInterval> | undefined;

  function startBlysk(): void {
    if (!kursor || blysk !== undefined) return;
    blysk = setInterval(() => {
      try {
        rysuj(true);
      } catch {
        /* best-effort */
      }
    }, BLYSK_MS);
    (blysk as unknown as { unref?: () => void }).unref?.();
  }

  function stopBlysk(): void {
    if (blysk !== undefined) {
      clearInterval(blysk);
      blysk = undefined;
    }
  }

  function szerokosc(): number {
    // Źródła: żywe kolumny TTY → env COLUMNS → fallback. Margines -1: znak w
    // ostatniej kolumnie sam wymusza zawinięcie, które rozjeżdża licznik kursora.
    const zTty = io.columns?.();
    const raw = io.env['COLUMNS'];
    const zEnv = raw === undefined || raw === '' ? Number.NaN : Number(raw);
    const n = Number.isFinite(zTty) && (zTty as number) >= 20
      ? (zTty as number)
      : Number.isFinite(zEnv) && zEnv >= 20
        ? zEnv
        : DOMYSLNA_SZEROKOSC;
    return Math.max(20, Math.floor(n) - 1);
  }

  /**
   * Skleja fragmenty przycięte do wnętrza ramki; zwraca widoczną długość (bez
   * ANSI) do dopadowania prawej krawędzi. Liczy ZNAKI, nie kolumny - stąd w
   * tablicy wyłącznie glify jednokolumnowe.
   */
  function tresc(fragmenty: Fragment[]): { tekst: string; dlugosc: number } {
    let zostalo = szerokoscWnetrza();
    const out: string[] = [];
    let dlugosc = 0;
    for (const f of fragmenty) {
      if (zostalo <= 0) break;
      const text = f.text.length > zostalo ? f.text.slice(0, zostalo) : f.text;
      zostalo -= text.length;
      dlugosc += text.length;
      out.push(kolory && f.color ? `${f.color}${text}${RESET}` : text);
    }
    return { tekst: out.join(''), dlugosc };
  }

  function szerokoscRamki(): number {
    return Math.min(szerokosc(), MAX_SZEROKOSC_RAMKI);
  }

  /** Wnętrze = ramka minus `│ ` z lewej i ` │` z prawej. */
  function szerokoscWnetrza(): number {
    return szerokoscRamki() - 4;
  }

  function ramka(fragmenty: Fragment[]): string {
    const { tekst, dlugosc } = tresc(fragmenty);
    const pad = ' '.repeat(Math.max(0, szerokoscWnetrza() - dlugosc));
    const bok = kolory ? `${DIM}│${RESET}` : '│';
    return `${bok} ${tekst}${pad} ${bok}`;
  }

  function krawedz(typ: 'gora' | 'srodek' | 'dol'): string {
    const [l, r] = typ === 'gora' ? ['╭', '╮'] : typ === 'dol' ? ['╰', '╯'] : ['├', '┤'];
    const kreska = `${l}${'─'.repeat(Math.max(0, szerokoscRamki() - 2))}${r}`;
    return kolory ? `${DIM}${kreska}${RESET}` : kreska;
  }

  /**
   * W sesji wygrywa faza (lub `proof` przy dowodzie); po case-end mina z
   * ostatniego statusu aż do case-start.
   */
  function stanAwatara(): StanAwatara {
    if (sesja !== undefined) {
      if (dowod) return 'proof';
      return stanZFazy(sesja.phase);
    }
    return ostatniStatus !== undefined ? stanZeStatusu(ostatniStatus) : 'idle';
  }

  function zbudujTablice(): string[] {
    const linie: string[] = [];

    // Model ma PIERWSZEŃSTWO przy ciasnej ramce: długi runId dostaje wielokropek,
    // zamiast wypychać nazwę modelu za prawą krawędź.
    let pokazRunId = runId !== undefined && runId.length > 0 ? runId : 'start…';
    if (model !== undefined) {
      const stale =
        AWATAR_KOLUMNY + 'greenproof'.length + 3 + 3 + 'model: '.length + model.length + 2;
      const naRunId = szerokoscWnetrza() - stale;
      if (pokazRunId.length > naRunId && naRunId >= 9) {
        pokazRunId = `${pokazRunId.slice(0, naRunId - 1)}…`;
      }
    }
    const naglowek: Fragment[] = [
      // Mikro-awatar: 4 kolumny, stała wysokość, mimika niesie fazę.
      { text: `${awatar(stanAwatara(), io.now().getTime())} `, color: CYAN },
      { text: 'greenproof', color: `${GREEN}${BOLD}` },
      { text: ' · ', color: DIM },
      // Puste '' w step-eventach sprzed założenia runu.
      { text: pokazRunId, color: BOLD },
    ];
    if (model !== undefined) {
      naglowek.push({ text: ' · ', color: DIM }, { text: 'model: ', color: DIM }, { text: model, color: CYAN });
    }
    // Spinner kręci się CAŁY czas (timer) - bez niego przerwy między
    // zdarzeniami wyglądają jak zawieszenie.
    naglowek.push({
      text: ` ${SPINNER[Math.floor(io.now().getTime() / 100) % SPINNER.length]!}`,
      color: GREEN,
    });
    linie.push(krawedz('gora'), ramka(naglowek), krawedz('srodek'));

    linie.push(ramka(liczniki()));
    const bar = pasekPostepu();
    if (bar !== undefined) linie.push(ramka(bar));
    if (rollup) {
      linie.push(
        ramka([
          { text: `koszt runu: ${pieniadze(rollup.costUsd)}` },
          { text: ' · ', color: DIM },
          { text: `tury łącznie: ${rollup.turns}` },
        ]),
      );
    }

    if (sesja) {
      linie.push(ramka([]), ...blokSesji(sesja));
    } else if (krok !== undefined) {
      linie.push(ramka([]), ramka([{ text: `krok ${krok}…`, color: DIM }]));
    }

    linie.push(krawedz('dol'));
    return linie;
  }

  function liczniki(): Fragment[] {
    if (!rollup) return [{ text: 'przypadki: -', color: DIM }];
    const wToku = sesja ? 1 : 0;
    const czeka = Math.max(0, rollup.remaining - wToku);
    const out: Fragment[] = [
      { text: 'przypadki: ' },
      { text: `${rollup.passed} ✓ dostarczone`, color: GREEN },
      { text: ' · ', color: DIM },
      { text: `${rollup.failed} ✗ zablokowane`, color: RED },
    ];
    if (wToku > 0) {
      out.push({ text: ' · ', color: DIM }, { text: `${wToku} ▶ w toku`, color: YELLOW });
    }
    if (czeka > 0) {
      out.push({ text: ' · ', color: DIM }, { text: `${czeka} ○ czeka`, color: DIM });
    }
    return out;
  }

  /**
   * Pasek postępu: █ zielone dostarczone / czerwone zablokowane / przygaszone
   * pominięte / żółte bieżąca sesja, ░ czeka. Błysk: jedna komórka na biało,
   * pozycja z zegara - timer przesuwa go między zdarzeniami.
   */
  function pasekPostepu(): Fragment[] | undefined {
    if (!rollup || rollup.total === 0) return undefined;
    const etykieta = ` ${rollup.done}/${rollup.total}`;
    const szer = Math.max(10, Math.min(40, szerokoscWnetrza() - etykieta.length - 1));
    const total = rollup.total;
    const wToku = sesja ? 1 : 0;
    const granice = [
      (rollup.passed / total) * szer,
      ((rollup.passed + rollup.failed) / total) * szer,
      ((rollup.passed + rollup.failed + rollup.skipped) / total) * szer,
      ((rollup.passed + rollup.failed + rollup.skipped + wToku) / total) * szer,
    ];
    const blyskPoz = Math.floor(io.now().getTime() / BLYSK_MS) % szer;

    const komorki: Fragment[] = [];
    for (let i = 0; i < szer; i += 1) {
      const c = i + 0.5;
      let znak = '░';
      let kolor: string | undefined = DIM;
      if (c < granice[0]!) { znak = '█'; kolor = GREEN; }
      else if (c < granice[1]!) { znak = '█'; kolor = RED; }
      else if (c < granice[2]!) { znak = '█'; kolor = DIM; }
      else if (c < granice[3]!) { znak = '█'; kolor = YELLOW; }
      if (znak === '█' && i === blyskPoz) kolor = `${WHITE}${BOLD}`;
      const poprzednia = komorki[komorki.length - 1];
      if (poprzednia !== undefined && poprzednia.color === kolor) poprzednia.text += znak;
      else komorki.push({ text: znak, color: kolor });
    }
    return [...komorki, { text: etykieta, color: DIM }];
  }

  function blokSesji(s: StanSesji): string[] {
    const naglowek: Fragment[] = [
      { text: '▶ ', color: YELLOW },
      { text: s.caseId, color: YELLOW },
      { text: ' · ', color: DIM },
      { text: `próba ${s.attempt}` },
    ];
    if (s.phase !== undefined) {
      naglowek.push({ text: ' · ', color: DIM }, { text: `faza: ${s.phase}` });
    }

    const out = [
      ramka(naglowek),
      ramka([
        { text: `  tury ${s.turns}` },
        { text: `/${s.maxTurns}`, color: DIM },
        { text: ' · ', color: DIM },
        { text: `czas ${czas(s.elapsedSec)}` },
        { text: `/${czas(s.maxTimeSec)}`, color: DIM },
        { text: ' · ', color: DIM },
        { text: 'koszt ' },
        { text: pieniadze(s.costUsd), color: kolorKosztu(s.costUsd, s.maxCostUsd) },
        { text: `/${pieniadze(s.maxCostUsd)}`, color: DIM },
      ]),
    ];

    if (s.pw) {
      out.push(
        ramka([
          { text: '  playwright: ' },
          { text: `assert ${s.pw.assertUsed}/${s.pw.assertMax}` },
          { text: ' · ', color: DIM },
          { text: `proof ${s.pw.proofUsed}/${s.pw.proofMax}` },
          { text: ' · ', color: DIM },
          { text: `green: ${s.pw.greenRuns}`, color: s.pw.greenRuns > 0 ? GREEN : DIM },
        ]),
      );
    }
    if (s.lastEvent !== undefined) {
      out.push(ramka([{ text: '  ostatnio: ', color: DIM }, { text: s.lastEvent }]));
    }
    return out;
  }

  function kolorKosztu(costUsd: number, maxCostUsd: number): string {
    if (!(maxCostUsd > 0)) return GREEN;
    const udzial = costUsd / maxCostUsd;
    if (udzial > 0.8) return RED;
    if (udzial > 0.5) return YELLOW;
    return GREEN;
  }

  function wyczysc(): void {
    if (kursor && narysowaneLinie > 0) io.write(`\x1b[${narysowaneLinie}A${ERASE_DOWN}`);
    narysowaneLinie = 0;
  }

  function rysuj(natychmiast: boolean): void {
    const teraz = io.now().getTime();
    if (!natychmiast && teraz - ostatnieRysowanie < MIN_ODSTEP_MS) return;
    ostatnieRysowanie = teraz;
    wyczysc();
    if (kursor && !kursorUkryty) {
      io.write(CURSOR_HIDE);
      kursorUkryty = true;
    }
    const linie = zbudujTablice();
    io.write(`${linie.join('\n')}\n`);
    narysowaneLinie = linie.length;
    startBlysk();
  }

  function zastosuj(event: ProgressEvent): boolean {
    // `filter`/`run` startują zanim core wygeneruje runId - pusty identyfikator
    // nie może zablokować właściwego z case-start/case-end.
    if (runId === undefined || runId.length === 0) runId = event.runId;
    switch (event.kind) {
      case 'step':
        krok = event.note === undefined ? event.name : `${event.name} - ${event.note}`;
        return true;
      case 'case-start':
        rollup = event.rollup;
        if (event.model !== undefined) model = event.model;
        krok = undefined;
        ostatniStatus = undefined;
        dowod = false;
        sesja = {
          caseId: event.caseId,
          attempt: event.attempt,
          phase: undefined,
          turns: 0,
          maxTurns: event.caps.maxTurns,
          elapsedSec: 0,
          maxTimeSec: event.caps.maxTimeMinutes * 60,
          costUsd: 0,
          maxCostUsd: event.caps.maxCostUsd,
          // Pule znamy z capów już na starcie - pokazujemy od pierwszej klatki,
          // zamiast czekać na pierwszy run (inaczej tablica dorasta w trakcie).
          pw: {
            assertUsed: 0,
            assertMax: event.caps.maxPlaywrightRuns,
            proofUsed: 0,
            proofMax: event.caps.proofRuns,
            greenRuns: 0,
          },
          lastEvent: undefined,
        };
        return true;
      case 'turn': {
        // Spóźnione zdarzenie z poprzedniego case'a nie może nadpisać bieżącego.
        if (!sesja || sesja.caseId !== event.caseId) return false;
        dowod = false;
        sesja.phase = event.phase;
        sesja.turns = event.turns;
        sesja.maxTurns = event.maxTurns;
        sesja.elapsedSec = event.elapsedSec;
        sesja.maxTimeSec = event.maxTimeSec;
        sesja.costUsd = event.costUsd;
        sesja.maxCostUsd = event.maxCostUsd;
        if (event.pw) sesja.pw = event.pw;
        if (event.lastEvent !== undefined) sesja.lastEvent = event.lastEvent;
        return false;
      }
      case 'playwright-run': {
        if (!sesja || sesja.caseId !== event.caseId) return false;
        if (event.pool === 'proof') dowod = true;
        sesja.pw = event.pw;
        sesja.lastEvent =
          `run_playwright #${event.runIndex} (${event.purpose})` +
          ` → ${event.passed} passed / ${event.failed} failed`;
        return false;
      }
      case 'case-end':
        rollup = event.rollup;
        ostatniStatus = event.status;
        dowod = false;
        sesja = undefined;
        return true;
    }
  }

  return {
    onEvent(event: ProgressEvent): void {
      try {
        const natychmiast = zastosuj(event);
        rysuj(natychmiast);
      } catch {
        // Widok postępu jest best-effort - nigdy nie wywracamy komendy.
      }
    },

    hint(ctx: { model?: string }): void {
      // Podpowiedź z configu - zdarzenia z własnym modelem ją nadpiszą.
      if (ctx.model !== undefined && model === undefined) {
        model = ctx.model;
        rysuj(true);
      }
    },

    printAbove(line: string): void {
      try {
        wyczysc();
        io.write(`${line.replace(/\n+$/, '')}\n`);
        rysuj(true);
      } catch {
        // jw.
      }
    },

    finalize(): void {
      try {
        stopBlysk();
        rysuj(true);
        if (kursor && kursorUkryty) {
          io.write(CURSOR_SHOW);
          kursorUkryty = false;
        }
        // Finalna tablica zostaje na ekranie - kursor stoi już pod nią.
        narysowaneLinie = 0;
      } catch {
        // jw.
      }
    },
  };
}

/** Sekundy → mm:ss (minuty bez ograniczenia do 60). */
function czas(sekundy: number): string {
  const total = Math.max(0, Math.floor(sekundy));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function pieniadze(usd: number): string {
  return `$${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`;
}
