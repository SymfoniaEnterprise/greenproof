/**
 * Plugin PlanSource dla dokumentu BMAD TEA `test-design.md`.
 *
 * Cała wiedza o formacie BMAD żyje tutaj - core zna wyłącznie NormalizedPlan.
 * Parser jest tolerancyjny na warianty nazw kolumn (PL/EN, wielkość liter),
 * a wiersze, których nie rozumie, pomija z ostrzeżeniem (patrz
 * {@link parseWithDiagnostics}). Sekcje "Quality Gate Criteria" są ignorowane -
 * bramki jakości to własny mechanizm konfiguracji greenproof.
 */

import { PlanParseError } from '@greenproof/core';
import type {
  CaseLevel,
  CasePriority,
  NormalizedPlan,
  PlanCase,
  PlanSource,
} from '@greenproof/core';

/** Wzorzec identyfikatora przypadku BMAD, np. `3.2-E2E-019`. */
const CASE_ID_RE = /^\d+\.\d+-(E2E|UNIT|INT|INTEGRATION)-\d+$/i;

/** Nagłówek sekcji, której tabele są celowo pomijane. */
const IGNORED_SECTION_RE = /quality\s*gate/i;

export interface ParseDiagnostics {
  plan: NormalizedPlan;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Tabele markdown - mini-parser bez zależności zewnętrznych
// ---------------------------------------------------------------------------

interface TableRow {
  cells: string[];
  /** Numer linii w dokumencie (1-based). */
  line: number;
}

interface RawTable {
  headers: string[];
  rows: TableRow[];
}

/**
 * Dzieli wiersz tabeli na komórki. Obsługuje escapowany `\|` (staje się
 * literalnym `|`) oraz puste komórki; wynikowe komórki są przycięte.
 */
function splitCells(raw: string): string[] {
  const line = raw.trim();
  const cells: string[] = [];
  let cur = '';
  let lastWasPipe = false;
  let i = line.startsWith('|') ? 1 : 0;
  for (; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === '\\' && line.charAt(i + 1) === '|') {
      cur += '|';
      i++;
      lastWasPipe = false;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      lastWasPipe = true;
      continue;
    }
    cur += ch;
    lastWasPipe = false;
  }
  // Domykający pipe nie tworzy pustej komórki na końcu.
  if (!lastWasPipe) cells.push(cur.trim());
  return cells;
}

function isTableLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.length > 1;
}

/** Wiersz separatora, np. `|---|:---:|`. */
function isSeparatorLine(line: string): boolean {
  if (!isTableLine(line)) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every(isSeparatorCell);
}

function isSeparatorCell(cell: string): boolean {
  const value = cell.trim();
  let start = 0;
  let end = value.length;
  if (value.startsWith(':')) start++;
  if (value.endsWith(':')) end--;
  if (end - start < 1) return false;
  for (let index = start; index < end; index++) {
    if (value.charAt(index) !== '-') return false;
  }
  return true;
}

/** Zbiera wszystkie tabele markdown poza sekcjami ignorowanymi. */
function collectTables(lines: string[]): RawTable[] {
  const tables: RawTable[] = [];
  // Poziom nagłówka sekcji ignorowanej (0 = nie jesteśmy w takiej sekcji).
  let skippedAtLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const level = (heading[1] ?? '').length;
      const text = heading[2] ?? '';
      if (skippedAtLevel > 0 && level <= skippedAtLevel) skippedAtLevel = 0;
      if (IGNORED_SECTION_RE.test(text)) skippedAtLevel = level;
      continue;
    }
    if (!isTableLine(line) || !isSeparatorLine(lines[i + 1] ?? '')) continue;

    const headers = splitCells(line);
    const rows: TableRow[] = [];
    let j = i + 2;
    for (; j < lines.length && isTableLine(lines[j] ?? ''); j++) {
      const body = lines[j] ?? '';
      if (isSeparatorLine(body)) continue;
      rows.push({ cells: splitCells(body), line: j + 1 });
    }
    if (skippedAtLevel === 0) tables.push({ headers, rows });
    i = j - 1;
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Rozpoznawanie kolumn
// ---------------------------------------------------------------------------

type ColumnKey = 'id' | 'priority' | 'level' | 'requirement' | 'type' | 'flow' | 'title';

/** Usuwa ozdobniki markdown i diakrytyki - do porównań, nie do prezentacji. */
function normalizeHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[`*_#:]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Zdejmuje ozdobniki markdown z wartości komórki (ID, priorytet, poziom). */
function cleanCell(value: string): string {
  return value.replace(/[`*_]/g, '').trim();
}

const COLUMN_MATCHERS: ReadonlyArray<{ key: ColumnKey; re: RegExp }> = [
  { key: 'id', re: /^((test|case)\s*)?id$|^id\s*(testu|przypadku)$|^identyfikator$/ },
  { key: 'priority', re: /^(priority|prio|priorytet)$/ },
  { key: 'level', re: /^((test)\s*)?(level|poziom)$/ },
  {
    key: 'requirement',
    re: /^(requirement|requirements|req|reqs|ac|acs|acceptance criteria|acceptance criterion|wymog|wymogi|wymaganie|wymagania|kryterium|kryteria)$/,
  },
  { key: 'type', re: /^(type|typ|business type|typ biznesowy)$/ },
  { key: 'flow', re: /^(flow|flows|route|routes|tag|tags|tagi|przeplyw|przeplywy|sciezka)$/ },
  {
    key: 'title',
    re: /^((test|case)\s*)?(description|desc|scenario|scenariusz|opis|title|tytul|nazwa)$|^test$|^test case$/,
  },
];

type ColumnMap = Partial<Record<ColumnKey, number>>;

function mapColumns(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  headers.forEach((header, index) => {
    const norm = normalizeHeader(header);
    if (norm === '') return;
    for (const { key, re } of COLUMN_MATCHERS) {
      if (re.test(norm) && map[key] === undefined) {
        map[key] = index;
        return;
      }
    }
  });
  return map;
}

/** Awaryjne wykrycie kolumny ID po zawartości (gdy nagłówek jest nietypowy). */
function detectIdColumn(table: RawTable): number | undefined {
  const width = Math.max(table.headers.length, ...table.rows.map((r) => r.cells.length), 0);
  for (let c = 0; c < width; c++) {
    if (table.rows.some((row) => CASE_ID_RE.test(cleanCell(row.cells[c] ?? '')))) return c;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Mapowanie wierszy na PlanCase
// ---------------------------------------------------------------------------

function levelFromCaseId(caseId: string): CaseLevel {
  const segment = (CASE_ID_RE.exec(caseId)?.[1] ?? '').toUpperCase();
  if (segment === 'E2E') return 'e2e';
  if (segment === 'UNIT') return 'unit';
  return 'integration';
}

function levelFromColumn(value: string): CaseLevel | undefined {
  const v = cleanCell(value).toUpperCase();
  if (v === 'E2E') return 'e2e';
  if (v === 'UNIT') return 'unit';
  if (v === 'INT' || v === 'INTEGRATION') return 'integration';
  return undefined;
}

function priorityOf(value: string): CasePriority | undefined {
  const m = /\bP([0-3])\b/i.exec(cleanCell(value));
  return m ? (`P${m[1]}` as CasePriority) : undefined;
}

/** Rozbija listę rozdzieloną przecinkami; puste elementy odpadają. */
function splitList(value: string): string[] {
  return cleanCell(value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function cell(row: TableRow, index: number | undefined): string {
  return index === undefined ? '' : (row.cells[index] ?? '').trim();
}

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Etykieta dokumentu przed dwukropkiem nie jest częścią nazwy feature. */
function withoutTitleLabel(value: string): string {
  const separator = value.indexOf(':');
  if (separator === -1) return value;
  const label = value.slice(0, separator).trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(' ', '')
    .replaceAll('\t', '')
    .replaceAll('-', '');
  return ['testdesign', 'testplan', 'plantestow', 'projekttestow'].includes(label)
    ? value.slice(separator + 1).trim()
    : value;
}

function slugFromHeading(lines: string[]): string | undefined {
  for (const line of lines) {
    const heading = line.trim();
    if (!heading.startsWith('# ')) continue;
    const raw = heading.slice(2).trim().replace(/[`*_]/g, '');
    const slug = slugify(withoutTitleLabel(raw));
    return slug === '' ? undefined : slug;
  }
  return undefined;
}

/** Slug z katalogu nadrzędnego pliku, np. `docs/qa/aneks/test-design.md`. */
function slugFromPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const parts = path.split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  const dir = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  if (dir === undefined) return undefined;
  const slug = slugify(dir);
  return slug === '' ? undefined : slug;
}

// ---------------------------------------------------------------------------
// Parser właściwy
// ---------------------------------------------------------------------------

/**
 * Parsuje dokument i zwraca plan wraz z ostrzeżeniami (pominięte wiersze,
 * konflikty poziomu itp.). Interfejs PlanSource nie ma miejsca na ostrzeżenia,
 * więc {@link bmadTeaPlanSource}.parse() je odrzuca.
 */
export function parseWithDiagnostics(input: string, opts?: { path?: string }): ParseDiagnostics {
  const path = opts?.path;
  const lines = input.split(/\r\n|\r|\n/);
  const warnings: string[] = [];

  const matrices = collectTables(lines)
    .map((table) => {
      const columns = mapColumns(table.headers);
      const idIndex = columns.id ?? detectIdColumn(table);
      return { table, columns, idIndex };
    })
    .filter((t) => t.idIndex !== undefined && t.columns.priority !== undefined);

  if (matrices.length === 0) {
    throw new PlanParseError(
      'Nie znaleziono macierzy pokrycia (tabeli z kolumną ID przypadku i priorytetem).',
      path === undefined ? {} : { path },
    );
  }

  const cases: PlanCase[] = [];
  const seen = new Map<string, number>();

  for (const { table, columns, idIndex } of matrices) {
    for (const row of table.rows) {
      const rawId = cleanCell(cell(row, idIndex));
      if (!CASE_ID_RE.test(rawId)) {
        warnings.push(
          `Pominięto wiersz w linii ${row.line}: identyfikator "${rawId}" nie pasuje do wzorca macierzy.`,
        );
        continue;
      }

      const key = rawId.toUpperCase();
      const previous = seen.get(key);
      if (previous !== undefined) {
        throw new PlanParseError(
          `Zduplikowany identyfikator przypadku "${rawId}" (pierwsze wystąpienie w linii ${previous}).`,
          path === undefined ? { line: row.line } : { path, line: row.line },
        );
      }
      seen.set(key, row.line);

      const priority = priorityOf(cell(row, columns.priority));
      if (priority === undefined) {
        throw new PlanParseError(
          `Brak lub nierozpoznany priorytet (oczekiwano P0-P3) dla przypadku "${rawId}".`,
          path === undefined ? { line: row.line } : { path, line: row.line },
        );
      }

      // ID jest źródłem prawdy dla poziomu - kolumna Level tylko informuje.
      const level = levelFromCaseId(rawId);
      const declared = levelFromColumn(cell(row, columns.level));
      if (declared !== undefined && declared !== level) {
        warnings.push(
          `Linia ${row.line}: kolumna poziomu ("${declared}") kłóci się z identyfikatorem "${rawId}" - użyto "${level}".`,
        );
      }

      const requirementRaw = cell(row, columns.requirement);
      const description = cell(row, columns.title);
      const title =
        description !== '' ? description : requirementRaw !== '' ? requirementRaw : rawId;
      const type = cleanCell(cell(row, columns.type));

      const planCase: PlanCase = {
        caseId: rawId,
        title,
        level,
        priority,
        requirements: splitList(requirementRaw),
        flows: splitList(cell(row, columns.flow)),
        ...(type === '' ? {} : { type }),
      };
      cases.push(planCase);
    }
  }

  if (cases.length === 0) {
    throw new PlanParseError(
      'Macierz pokrycia nie zawiera żadnego poprawnego przypadku testowego.',
      path === undefined ? {} : { path },
    );
  }

  let slug = slugFromHeading(lines) ?? slugFromPath(path);
  if (slug === undefined) {
    slug = 'test-design';
    warnings.push('Brak nagłówka H1 i ścieżki - slug planu ustawiono na "test-design".');
  }

  return {
    plan: {
      slug,
      cases,
      source: path === undefined ? { format: 'bmad-tea' } : { format: 'bmad-tea', path },
    },
    warnings,
  };
}

/** Źródło planu dla dokumentów BMAD TEA. */
export const bmadTeaPlanSource: PlanSource = {
  format: 'bmad-tea',
  parse(input: string, opts?: { path?: string }): NormalizedPlan {
    return parseWithDiagnostics(input, opts).plan;
  },
};

export default bmadTeaPlanSource;
