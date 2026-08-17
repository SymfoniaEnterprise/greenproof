/**
 * Mikro-awatar postępu: para oczu w daszku, `⌜◉◉⌝`.
 *
 * JEDEN wiersz - repaint kursorem w górę się nie rozjeżdża. Wyłącznie glify
 * East Asian Width Narrow (N/Na), zero emoji: ramka liczy szerokość po
 * widocznej długości, a znak „Ambiguous" (◐ ◑ ● ◎ ○ × -) w terminalu CJK
 * renderuje się podwójnie i rozwala prawą krawędź.
 *
 * Stan niesie MIMIKA, nie kolor - czerwień i żółć zarezerwowane dla paska
 * postępu (pass/fail/w toku).
 */

import type { CaseStatus } from '@greenproof/core';

/** Faza sesji autora albo stan końcowy case'a. */
export type StanAwatara =
  | 'arrange'
  | 'act'
  | 'assert'
  | 'proof'
  | 'delivered'
  | 'blocked'
  | 'failed'
  | 'idle';

/** Klatki per stan: fazy w toku po 4 (ruch), stany końcowe po 1 (bezruch). */
const KLATKI: Readonly<Record<StanAwatara, readonly string[]>> = {
  // Rozglądanie.
  arrange: ['◔◔', '◓◓', '◕◕', '◒◒'],
  // Skupienie.
  act: ['◉◉', '⊝⊝', '◉◉', '◌◌'],
  // Badanie - tu agent uruchamia testy.
  assert: ['◉◉', '⊚⊚', '◉◉', '◦◦'],
  // Zwężone kółka - „mruży oczy".
  proof: ['◕◕', '◉◉', '◕◕', '◉◉'],
  delivered: ['◡◡'],
  blocked: ['◔◕'],
  failed: ['✕✕'],
  idle: ['◉◉'],
};

const MRUGNIECIE = '‒‒';

/** Fallback, gdy stan nie ma klatek - nigdy nie wpuszczamy `undefined` w napis. */
const OCZY_FALLBACK = '◉◉';
const OKRES_MRUGNIECIA_MS = 4000;
const DLUGOSC_MRUGNIECIA_MS = 140;
const KLATKA_MS = 250;

const RUCHOME: ReadonlySet<StanAwatara> = new Set(['arrange', 'act', 'assert', 'proof', 'idle']);

/**
 * Oczy dla stanu i chwili (`teraz` w ms). Czysta - renderer woła ją przy
 * każdym repaincie bez licznika.
 */
export function oczy(stan: StanAwatara, teraz: number): string {
  // Ujemny zegar (cofnięty) dałby wieczne mrugnięcie i ujemny indeks klatki.
  const t = Math.max(0, teraz);
  const klatki = KLATKI[stan];
  if (klatki.length === 0) return OCZY_FALLBACK;
  if (!RUCHOME.has(stan)) return klatki[0] ?? OCZY_FALLBACK;
  if (t % OKRES_MRUGNIECIA_MS < DLUGOSC_MRUGNIECIA_MS) return MRUGNIECIE;
  return klatki[Math.floor(t / KLATKA_MS) % klatki.length] ?? OCZY_FALLBACK;
}

export function awatar(stan: StanAwatara, teraz: number): string {
  return `⌜${oczy(stan, teraz)}⌝`;
}



/**
 * Mapowanie fazy na stan awatara. Nieznana faza → `idle` - awatar żyje,
 * sygnalizując, że proces nie zamarł.
 */
export function stanZFazy(faza: string | undefined): StanAwatara {
  switch (faza) {
    case 'arrange':
    case 'act':
    case 'assert':
      return faza;
    case 'proof':
    case 'proving':
      return 'proof';
    case 'fixture':
      // Fixture to też praca modelu - reużywamy klatek `act`, nie `idle`.
      return 'act';
    default:
      return 'idle';
  }
}

/**
 * Wyczerpujące mapowanie `CaseStatus` na stan, BEZ `default`. `Record` zamiast
 * `switch`: nowy status w core wymusi błąd kompilacji, nie ciche `idle`.
 */
const STATUS_NA_STAN: Readonly<Record<CaseStatus, StanAwatara>> = {
  pending: 'idle',
  skipped: 'idle',
  selected: 'idle',
  triaged: 'idle',
  authoring: 'idle',
  proving: 'idle',
  retry_requested: 'idle',
  delivered: 'delivered',
  in_review: 'delivered',
  accepted: 'delivered',
  released: 'delivered',
  blocked: 'blocked',
  attempt_failed: 'failed',
  failed: 'failed',
};

export function stanZeStatusu(status: CaseStatus): StanAwatara {
  return STATUS_NA_STAN[status];
}
