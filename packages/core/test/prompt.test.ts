/** Warunkowe fragmenty promptu autora: mutacja oracle-first tylko z oracle. */
import { describe, expect, it } from 'vitest';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import { authorSystemPrompt } from '../src/author/prompt.js';
import type { CaseContext } from '../src/steps/triage.js';

const config = GreenproofConfigSchema.parse({
  platform: 'fake',
  plan: { source: 'json' },
  model: { authTokenEnv: 'T', author: 'm' },
  paths: { testsRepoDir: '/tmp/x' },
});

function ctx(oracleFiles: string[]): CaseContext {
  return {
    case: {
      caseId: 'C-1', title: 't', level: 'e2e', priority: 'P1',
      requirements: [], flows: [], type: 'zwykly',
    },
    envUrl: 'http://127.0.0.1:9',
    branch: 'author/C-1',
    attempt: 1,
    inventory: [],
    uiTraps: [],
    appMapViews: [],
    churnProne: false,
    oracleFiles,
  };
}

describe('authorSystemPrompt - dowód mutacyjny', () => {
  it('z oracle: mutacja wartości oczekiwanej jako pierwszy wybór', () => {
    const p = authorSystemPrompt(config, ctx(['docs/golden-cases/g1.json']));
    expect(p).toMatch(/Zmutuj NAJPIERW wartość oczekiwaną/);
    expect(p).not.toMatch(/Celowo zepsuj warunek/);
  });

  it('bez oracle: dotychczasowa mutacja logiki', () => {
    const p = authorSystemPrompt(config, ctx([]));
    expect(p).toMatch(/Celowo zepsuj warunek/);
    expect(p).not.toMatch(/Zmutuj NAJPIERW/);
  });

  // Reguła kotwicy była dotąd egzekwowana przez walidator, ale nigdzie nie
  // wypowiedziana - słabszy autor mutował stałą używaną tylko przez drugi
  // test i tracił obie próby (run qwen36-27b-mtp, 2026-08-16).
  it('zawsze: reguła kotwicy w prompcie, niezależnie od oracle', () => {
    for (const p of [authorSystemPrompt(config, ctx([])),
                     authorSystemPrompt(config, ctx(['docs/golden-cases/g1.json']))]) {
      expect(p).toMatch(/KOTWICA DOWODU/);
      expect(p).toMatch(/pierwszy test w specu/i);
      expect(p).toMatch(/PIERWSZY test w specu musi weryfikować GŁÓWNY warunek/);
    }
  });
});

describe('authorSystemPrompt - uruchamianie testów', () => {
  const withEnforce = (enforceRunPlaywrightTool: boolean) =>
    GreenproofConfigSchema.parse({
      platform: 'fake',
      plan: { source: 'json' },
      model: { authTokenEnv: 'T', author: 'm' },
      paths: { testsRepoDir: '/tmp/x' },
      caps: { maxPlaywrightRuns: 6, proofRuns: 4, enforceRunPlaywrightTool },
    });

  it('domyślnie: run_playwright + zakaz współdzielonego raportu + obie pule', () => {
    const p = authorSystemPrompt(withEnforce(true), ctx([]));
    expect(p).toMatch(/mcp__greenproof__run_playwright/);
    expect(p).toMatch(/run:<n>/);
    expect(p).toMatch(/NIGDY współdzielonego pw-report\.json/);
    expect(p).toMatch(/6 uruchomień.*4 runów dowodowych/s);
  });

  // Prompt MUSI opisywać realne zachowanie hooka - kill switch zdejmuje deny,
  // więc zdejmuje też zdanie o zablokowanym Bashu.
  it('kill switch: wraca dotychczasowe brzmienie `playwright test`', () => {
    const p = authorSystemPrompt(withEnforce(false), ctx([]));
    expect(p).not.toMatch(/run_playwright/);
    expect(p).toMatch(/uruchamiaj `playwright test`/);
    expect(p).toMatch(/podawaj ŚCIEŻKI plików raportów/);
  });
});
