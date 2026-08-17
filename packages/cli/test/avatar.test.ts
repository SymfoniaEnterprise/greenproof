/**
 * Mikro-awatar tablicy postępu. Kluczowe niezmienniki są layoutowe, nie
 * estetyczne: stała szerokość i wysokość, wyłącznie glify jednokolumnowe.
 * Złamanie któregokolwiek rozjeżdża ramkę albo repaint kursorem w górę.
 */
import { describe, expect, it } from 'vitest';
import type { CaseStatus } from '@greenproof/core';
import {
  awatar,
  oczy,
  stanZFazy,
  stanZeStatusu,
  type StanAwatara,
} from '../src/progress/avatar.js';

const STANY: StanAwatara[] = [
  'arrange', 'act', 'assert', 'proof', 'delivered', 'blocked', 'failed', 'idle',
];

/**
 * Zakresy kodowe o szerokości 2 kolumn: East Asian Width F/W (pełna szerokość)
 * oraz A (Ambiguous) - Ambiguous traktujemy jako szerokie, bo to gorszy przypadek
 * (terminal z konfiguracją CJK renderuje je podwójnie). Tabela jest zawężona do
 * bloków, z których czerpie awatar (Latin-1, General Punctuation, Mathematical
 * Operators, Geometric Shapes, Dingbats + główne zakresy CJK/emoji), więc nie
 * udaje pełnej bazy Unicode - wystarcza na złapanie regresji „wpuść Ambiguous".
 */
const DWIE_KOLUMNY: ReadonlyArray<readonly [number, number]> = [
  // Latin-1: ¡ ¢ £ ¤ ¦ § ¨ ª « ¬ ® ¯ ° ± ² ³ ´ µ ¶ · ¸ ¹ º » ¼ ½ ¾ ¿ × ÷
  [0x00A1, 0x00A1], [0x00A4, 0x00A4], [0x00A7, 0x00A8], [0x00AA, 0x00AA],
  [0x00AD, 0x00AE], [0x00B0, 0x00B4], [0x00B6, 0x00BA], [0x00BC, 0x00BF],
  [0x00D7, 0x00D7], [0x00F7, 0x00F7],
  // General Punctuation: ‐ - - ‖ ‗ ‘’ “” † ‡ • … ‰
  [0x2010, 0x2010], [0x2013, 0x2016], [0x2018, 0x2019], [0x201C, 0x201D],
  [0x2020, 0x2022], [0x2024, 0x2027], [0x2030, 0x2030], [0x2032, 0x2033],
  [0x2035, 0x2035], [0x203B, 0x203B], [0x203E, 0x203E], [0x2103, 0x2103],
  [0x2105, 0x2105], [0x2109, 0x2109], [0x2113, 0x2113], [0x2116, 0x2116],
  [0x2121, 0x2122], [0x2126, 0x2126], [0x212B, 0x212B], [0x2160, 0x216B],
  [0x2170, 0x2179], [0x2190, 0x2199], [0x21B8, 0x21B9], [0x21D2, 0x21D2],
  [0x21D4, 0x21D4], [0x21E7, 0x21E7],
  // Mathematical Operators: ∑ ∏ √ − ∞ ∥ ∧ ∨ ∩ ∪ ∫ ∮ ∴ ∵ ∼ ∽ ≈ ≠ ≡ ≤ ≥ ≪ ≫ ≮ ≯ ⊂ ⊃ ⊆ ⊇ ⊙ ⊥
  [0x2200, 0x2200], [0x2202, 0x2203], [0x2207, 0x2208], [0x220B, 0x220B],
  [0x220F, 0x220F], [0x2211, 0x2211], [0x2215, 0x2215], [0x221A, 0x221A],
  [0x221D, 0x2220], [0x2223, 0x2223], [0x2225, 0x2225], [0x2227, 0x222C],
  [0x222E, 0x222E], [0x2234, 0x2237], [0x223C, 0x223D], [0x2248, 0x2248],
  [0x224C, 0x224C], [0x2252, 0x2252], [0x2260, 0x2261], [0x2264, 0x2267],
  [0x226A, 0x226B], [0x226E, 0x226F], [0x2282, 0x2283], [0x2286, 0x2287],
  [0x2295, 0x2295], [0x2299, 0x2299], [0x22A5, 0x22A5], [0x22BF, 0x22BF],
  // Box Drawing / Block Elements / Geometric Shapes - wyłącznie glify Ambiguous
  [0x2550, 0x2573], [0x2580, 0x258F], [0x2592, 0x2595],
  [0x25A0, 0x25A1], [0x25A3, 0x25A9], [0x25B2, 0x25B3], [0x25B6, 0x25B7],
  [0x25BC, 0x25BD], [0x25C0, 0x25C1], [0x25C6, 0x25C8], [0x25CB, 0x25CB],
  [0x25CE, 0x25D1], [0x25E2, 0x25E5], [0x25EF, 0x25EF],
  // Dingbats / Misc symbole
  [0x2605, 0x2606], [0x2609, 0x2609], [0x260E, 0x260F], [0x261C, 0x261C],
  [0x261E, 0x261E], [0x2640, 0x2640], [0x2642, 0x2642], [0x2660, 0x2661],
  [0x2663, 0x2665], [0x2667, 0x266A], [0x266C, 0x266D], [0x266F, 0x266F],
  [0x269E, 0x269F], [0x26BF, 0x26BF], [0x26C6, 0x26CD], [0x26CF, 0x26D3],
  [0x26D5, 0x26E1], [0x26E3, 0x26E3], [0x26E8, 0x26E9], [0x26EB, 0x26F1],
  [0x26F4, 0x26F4], [0x26F6, 0x26F9], [0x26FB, 0x26FC], [0x26FE, 0x26FF],
  [0x273D, 0x273D], [0x2776, 0x277F],
  // CJK / Hangul / fullwidth / emoji (F/W) - główne zakresy
  [0x1100, 0x115F], [0x2E80, 0xA4CF], [0xAC00, 0xD7A3], [0xF900, 0xFAFF],
  [0xFE10, 0xFE19], [0xFE30, 0xFE6F], [0xFF00, 0xFF60], [0xFFE0, 0xFFE6],
  [0x1F100, 0x1F1AC], [0x1F300, 0x1FAFF], [0x20000, 0x3FFFD],
];

/** Szerokość napisu w KOLUMNACH terminala (nie w punktach kodowych). */
function szerokoscKolumny(tekst: string): number {
  let szer = 0;
  for (const znak of tekst) {
    const cp = znak.codePointAt(0)!;
    szer += DWIE_KOLUMNY.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
  }
  return szer;
}

describe('awatar', () => {
  it('ma STAŁĄ szerokość 4 znaków w każdym stanie i każdej klatce', () => {
    for (const stan of STANY) {
      for (let t = 0; t < 6000; t += 37) {
        expect([...awatar(stan, t)], `${stan} @${t}`).toHaveLength(4);
      }
    }
  });

  it('jest jednowierszowy - żadnych znaków sterujących', () => {
    for (const stan of STANY) {
      expect(awatar(stan, 1234)).not.toMatch(/[\n\r\x1b]/);
    }
  });

  it('używa wyłącznie glifów jednokolumnowych (bez emoji i znaków fullwidth)', () => {
    // Zakresy podwójnej szerokości: CJK, Hangul, emoji, symbole ozdobne.
    const FULLWIDTH = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]/u;
    for (const stan of STANY) {
      for (let t = 0; t < 6000; t += 137) {
        expect(awatar(stan, t), `${stan} @${t}`).not.toMatch(FULLWIDTH);
      }
    }
  });

  it('stany w toku się animują, końcowe stoją', () => {
    const klatki = (stan: StanAwatara): Set<string> => {
      const out = new Set<string>();
      for (let t = 0; t < 4000; t += 50) out.add(oczy(stan, t));
      return out;
    };
    expect(klatki('arrange').size).toBeGreaterThan(1);
    expect(klatki('assert').size).toBeGreaterThan(1);
    // Koniec pracy = bezruch; to samo w sobie jest sygnałem dla patrzącego.
    expect(klatki('delivered')).toEqual(new Set(['◡◡']));
    expect(klatki('failed')).toEqual(new Set(['✕✕']));
    expect(klatki('blocked')).toEqual(new Set(['◔◕']));
  });

  it('mruga cyklicznie, ale tylko w stanach w toku', () => {
    const mrugniecia = (stan: StanAwatara): number => {
      let n = 0;
      for (let t = 0; t < 12000; t += 20) if (oczy(stan, t) === '‒‒') n += 1;
      return n;
    };
    expect(mrugniecia('act')).toBeGreaterThan(0);
    expect(mrugniecia('delivered')).toBe(0);
  });

  it('mapuje fazy autora, a nieznane traktuje jako idle', () => {
    expect(stanZFazy('arrange')).toBe('arrange');
    expect(stanZFazy('act')).toBe('act');
    expect(stanZFazy('assert')).toBe('assert');
    expect(stanZFazy('proving')).toBe('proof');
    expect(stanZFazy(undefined)).toBe('idle');
    expect(stanZFazy('cokolwiek')).toBe('idle');
  });

  it('ma STAŁĄ szerokość w KOLUMNACH (Ambiguous = 2) w każdej klatce, łącznie z mrugnięciem', () => {
    for (const stan of STANY) {
      const szerokosci = new Set<number>();
      for (let t = 0; t < 6000; t += 37) {
        szerokosci.add(szerokoscKolumny(awatar(stan, t)));
      }
      expect(szerokosci, stan).toEqual(new Set([4]));
    }
    // Klatka mrugnięcia (t w oknie 0..139 ms) też musi mieć 4 kolumny.
    expect(szerokoscKolumny(awatar('act', 0))).toBe(4);
    expect(szerokoscKolumny(awatar('act', 139))).toBe(4);
  });

  it('oczy() zwraca dokładnie 2 znaki dla każdego stanu i każdej chwili', () => {
    for (const stan of STANY) {
      for (let t = 0; t < 6000; t += 137) {
        expect([...oczy(stan, t)], `${stan} @${t}`).toHaveLength(2);
      }
    }
  });

  it('brzeg mrugnięcia: 139 ms mruga, 140 ms już nie', () => {
    expect(oczy('act', 139)).toBe('‒‒');
    expect(oczy('act', 140)).not.toBe('‒‒');
  });

  it('mapuje fazę fixture na stan pracy modelu (act), a nie idle', () => {
    expect(stanZFazy('fixture')).toBe('act');
  });

  it('mapuje każdy CaseStatus wyczerpująco - bez cichego idle', () => {
    const oczekiwane: Record<CaseStatus, StanAwatara> = {
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
    for (const [status, stan] of Object.entries(oczekiwane) as [CaseStatus, StanAwatara][]) {
      expect(stanZeStatusu(status), status).toBe(stan);
    }
  });
});
