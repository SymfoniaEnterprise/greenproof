/**
 * Lint anty-duplikacji: spec nie powinien zawierać surowych selektorów
 * istniejących już w POM-ie - kolejne case'y reużywają opłacone odkrycia.
 */
import type { DuplicationFinding, PomIndex } from '../domain/harvest.js';

function normalizeSelector(sel: string): string {
  return sel.replace(/\s+/g, ' ').replace(/["']/g, "'").trim().toLowerCase();
}

/** Ignoruje selektory w liniach importujących POM - to legalne reużycie. */
export function findSelectorDuplication(
  specPath: string,
  specContent: string,
  index: PomIndex,
): DuplicationFinding[] {
  const findings: DuplicationFinding[] = [];
  const lines = specContent.split('\n');
  for (const entry of index.entries) {
    for (const selector of entry.keySelectors) {
      const needle = normalizeSelector(selector);
      if (needle.length < 6) continue; // zbyt krótkie selektory dają fałszywe trafienia
      const hit = lines.some(
        (line) =>
          !/^\s*import\b/.test(line) && normalizeSelector(line).includes(needle),
      );
      if (hit) {
        findings.push({ specPath, selector, pomName: entry.name, pomPath: entry.path });
      }
    }
  }
  return findings;
}

export function lintMarkdown(findings: DuplicationFinding[]): string {
  if (findings.length === 0) return '';
  const rows = findings.map(
    (f) => `| \`${f.selector}\` | ${f.pomName} | \`${f.pomPath}\` |`,
  );
  return [
    '⚠️ **Duplikacja selektorów** - te selektory istnieją już w POM-ach; spec powinien reużyć POM zamiast surowego selektora:',
    '',
    '| Selektor | POM | Plik |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}
