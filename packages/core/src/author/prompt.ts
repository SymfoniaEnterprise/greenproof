/**
 * Składanie promptu autora. Kolejność sekcji jest STABILNA i deterministyczna
 * - stały prefiks maksymalizuje trafienia cache'a LLM w bramie.
 */
import type { GreenproofConfig } from '../config/types.js';
import type { CaseContext } from '../steps/triage.js';

export function authorSystemPrompt(config: GreenproofConfig, context: CaseContext): string {
  const caps = config.caps;
  const sections: string[] = [];

  sections.push(
    `Jesteś agentem-autorem testów E2E (Playwright, TypeScript). Pracujesz w repo testów nad JEDNYM przypadkiem testowym. Twoim wynikiem jest draft speca, który realnie weryfikuje wymóg - nie zielony przebieg za wszelką cenę.`,
  );

  const enforceTool = caps.enforceRunPlaywrightTool;

  sections.push(
    [
      '## Protokół faz (narzędzie mcp__greenproof__mark_phase - OBOWIĄZKOWE)',
      '1. **arrange** - doprowadź aplikację do stanu wyjściowego (seed). Każdą strategię seedu raportuj przez report_seed_attempt.',
      '2. **act** - napisz spec: kroki użytkownika. PIERWSZY test w specu musi weryfikować GŁÓWNY warunek case\'a - to on jest kotwicą dowodu mutacyjnego (patrz niżej); przypadki poboczne dopisuj po nim.',
      enforceTool
        ? '3. **assert** - uruchamiaj testy WYŁĄCZNIE narzędziem mcp__greenproof__run_playwright (`playwright test` z Basha jest zablokowany) i doprowadź do DWÓCH zielonych przebiegów. Narzędzie zwraca ścieżkę raportu TEGO przebiegu - zapamiętuj ją.'
        : '3. **assert** - uruchamiaj `playwright test` i doprowadź do DWÓCH zielonych przebiegów.',
      `Budżet runów: ${caps.maxPlaywrightRuns} uruchomień na dojście do dwóch zielonych + OSOBNA pula ${caps.proofRuns} runów dowodowych, odblokowana po DRUGIM zielonym przebiegu. Limit czasu sesji: ${caps.maxTimeMinutes} min. Pracuj oszczędnie.`,
    ].join('\n'),
  );

  sections.push(
    [
      '## Higiena snapshotów (główny koszt runa!)',
      'Pełny browser_snapshot wolno zrobić raz po wejściu na NOWĄ stronę i po realnej zmianie strony (nawigacja, modal, zapis). Poza tym używaj WYŁĄCZNIE celowanych zapytań: browser_find, browser_verify_text_visible, browser_verify_element_visible (rola/tekst/testid).',
      'Każdy nadmiarowy pełny snapshot wraca w KAŻDEJ kolejnej turze jako cache_read i pompuje koszt.',
    ].join('\n'),
  );

  sections.push(
    [
      '## Dowód mutacyjny (OBOWIĄZKOWY - zielony przebieg bez dowodu jest bezwartościowy)',
      'KOTWICA DOWODU: dowód opiera się na JEDNYM teście. Wskaż go polem `proofTest` w record_proof_material ("plik::tytuł" albo jednoznaczny fragment tytułu) - bez tego pipeline weźmie **pierwszy przechodzący test specu**, co przy wielu testach bywa nie tym, o który Ci chodzi. Wskazany test musi przejść w OBU zielonych przebiegach i paść po mutacji; zaczerwienienie innego testu nie jest dowodem. Mutuj więc wartość, od której zależy ścieżka TEGO testu - najlepiej wartość przez niego ASERTOWANĄ (oracle), bo mutacja samego wejścia (hasła, seedu) dowodzi tylko zależności, nie weryfikacji, i zostanie oznaczona jako słabszy dowód. Jeśli warunku nie da się zmutować, to sygnał, że spec go nie weryfikuje - popraw spec, nie szukaj łatwiejszego testu.',
      'Po drugim zielonym przebiegu:',
      ...(context.oracleFiles.length > 0
        ? [
            '1. Zmutuj NAJPIERW wartość oczekiwaną pochodzącą z oracle (golden-case) i używaną przez kotwicę - najmniejsza możliwa delta (np. ±1 grosz, ostatnia cyfra). Mutację logiki/kroków/seedu wybieraj TYLKO, gdy mutacja wartości z oracle jest niemożliwa. Jeśli spec naprawdę asertuje oracle, taka mutacja gwarantuje czerwień - a jeśli test się nie czerwieni, dowód słusznie obnaża spec.',
          ]
        : [
            '1. Celowo zepsuj warunek, który weryfikuje kotwica (mutacja w kodzie speca lub POM - np. odwróć oczekiwaną wartość używaną przez pierwszy test).',
          ]),
      '2. Uruchom test i potwierdź, że **kotwica** czerwieni się WŁASNYM komunikatem asercji expect() - nie timeoutem testu, nie błędem infrastruktury. Jeśli w czerwonym raporcie kotwica przechodzi, mutacja była chybiona: cofnij ją i wybierz wartość leżącą na ścieżce kotwicy (nie zgłaszaj dowodu „byle czerwonego").',
      enforceTool
        ? `3. Przekaż raporty przez mcp__greenproof__record_proof_material (dwa zielone + czerwony): podawaj reportPath zwrócony przez run_playwright albo referencję run:<n> - NIGDY współdzielonego ${config.playwright.reportFile} (nadpisuje go każdy kolejny przebieg) i nie wklejaj treści raportów.`
        : '3. Przekaż raporty przez mcp__greenproof__record_proof_material (dwa zielone + czerwony, raporty z --reporter=json) - podawaj ŚCIEŻKI plików raportów, nie wklejaj treści.',
      '4. Przywróć wersję sprzed mutacji (git diff względem commita sprzed mutacji MUSI być pusty).',
      'Werdykt wydaje pipeline deterministycznie - nie deklaruj go sam.',
    ].join('\n'),
  );

  sections.push(
    context.oracleFiles.length > 0
      ? [
          '## Oracle (żelazna reguła)',
          'Wartości oczekiwane w asercjach biorą się WYŁĄCZNIE z golden-case\'ów (pliki wskazane w kontekście), NIGDY z UI aplikacji. Test, który potwierdza wartość odczytaną z apki, potwierdza jej błąd jako "prawdę".',
        ].join('\n')
      : [
          '## Oracle',
          'Nie koduj na sztywno wartości ODCZYTANYCH z UI jako oczekiwanych. Oczekiwania wyprowadzaj z wymogu (PRD), stanu seedu i logiki domeny.',
        ].join('\n'),
  );

  sections.push(
    [
      '## Harvest (reużywalność jest walutą)',
      'Zanim odkryjesz cokolwiek klikaniem - sprawdź sekcję inventory kontekstu: te flow są już opłacone, importuj gotowe POM-y.',
      'Gdy MUSISZ odkryć nowy flow - wydziel go do Page Objecta/fixture\'a i zarejestruj przez register_pom (name, covers = tagi flow). Odkrytą pułapkę UI rejestruj przez register_ui_trap.',
      'Spec z surowymi selektorami, które istnieją w POM-ach, dostanie warning na przeglądzie.',
    ].join('\n'),
  );

  sections.push(
    [
      '## Dyscyplina pracy',
      `Commituj na branchu case'a po każdej fazie: seed OK → commit, zielony spec → commit, dowód → commit. Commit message zaczynaj od "[${context.case.caseId}]".`,
      'Teardown: afterEach kasuje WYŁĄCZNIE to, co test sam utworzył.',
      `Spec zapisz w ${config.paths.specsDir}/ z identyfikatorem case'a w nazwie pliku.`,
      'Na końcu wywołaj mcp__greenproof__finish (status + specPath + reusedPoms) i zwróć wynik strukturalny.',
    ].join('\n'),
  );

  if (context.churnProne) {
    sections.push(
      [
        '## UWAGA: case typu churn-prone (bezpiecznik seedu aktywny)',
        `Masz ${caps.seedFuse.maxFailedStrategies} RÓŻNE strategie seedu i ~${caps.seedFuse.maxArrangeTurns} tur fazy arrange. Raportuj każdą przez report_seed_attempt.`,
        'Gdy bezpiecznik przerwie pracę - natychmiast zakończ ze statusem blocked i notatką fixture-gap (czego brakuje, co powinien dopisać człowiek). NIE walcz dalej.',
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

export function buildAuthorPrompt(context: CaseContext): string {
  const c = context.case;
  const sections: string[] = [];

  sections.push(
    [
      `# Przypadek ${c.caseId} (${c.priority}) - próba ${context.attempt}`,
      `**Tytuł:** ${c.title}`,
      `**Wymogi:** ${c.requirements.join('; ') || '(brak - patrz tytuł)'}`,
      `**Flow:** ${c.flows.join(', ') || '(brak tagów)'}`,
      `**Środowisko:** ${context.envUrl}`,
      `**Branch:** ${context.branch}`,
    ].join('\n'),
  );

  if (context.inventory.length > 0) {
    sections.push(
      [
        '## Inventory - opłacone odkrycia (UŻYJ zamiast odkrywać)',
        ...context.inventory.map(
          (e) =>
            `- **${e.name}** (${e.kind}) \`${e.path}\` - ${e.description} [pokrywa: ${e.covers.join(', ')}]`,
        ),
      ].join('\n'),
    );
  } else {
    sections.push('## Inventory\nBrak POM-ów dla tych flow - odkrycia wydziel i zarejestruj (register_pom).');
  }

  if (context.appMapViews.length > 0) {
    sections.push(
      [
        '## Mapa aplikacji (gotowa nawigacja)',
        ...context.appMapViews.map((v) =>
          [
            `### ${v.route}${v.description ? ` - ${v.description}` : ''}`,
            ...v.navigationSteps.map((s, i) => `${i + 1}. ${s}`),
            ...Object.entries(v.keySelectors).map(([k, sel]) => `- ${k}: \`${sel}\``),
          ].join('\n'),
        ),
      ].join('\n'),
    );
  }

  if (context.uiTraps.length > 0) {
    sections.push(
      [
        '## Znane pułapki UI (CZYTAJ zamiast klikać na ślepo)',
        ...context.uiTraps.map(
          (t) =>
            `- **${t.component}**: ${t.trap} → ${t.workaround}${t.selectorExample ? ` (np. \`${t.selectorExample}\`)` : ''}`,
        ),
      ].join('\n'),
    );
  }

  if (context.oracleFiles.length > 0) {
    sections.push(
      ['## Golden-case\'y (oracle)', ...context.oracleFiles.map((f) => `- \`${f}\``)].join('\n'),
    );
  }

  if (context.previousAttempt) {
    const p = context.previousAttempt;
    const parts = ['## Wnioski z poprzedniej próby (NIE powtarzaj tych błędów)'];
    if (p.humanNotes) parts.push(`**Uwagi przeglądu:** ${p.humanNotes}`);
    if (p.digest) parts.push(p.digest);
    if (p.lastErrors.length > 0) {
      parts.push('Ostatnie błędy:', ...p.lastErrors.map((e) => `- ${e.slice(0, 500)}`));
    }
    if (p.commits.length > 0) {
      parts.push(
        `Poprzednia próba zostawiła na branchu commity: ${p.commits.join(', ')} - obejrzyj je (git log/show) zamiast zaczynać od zera.`,
      );
    }
    sections.push(parts.join('\n'));
  }

  sections.push('Zacznij od mark_phase("arrange").');
  return sections.join('\n\n');
}
