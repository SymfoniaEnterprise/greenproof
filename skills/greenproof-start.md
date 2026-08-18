# Skill: greenproof-start - pierwsza konfiguracja i pierwszy run

Scenariusz wywiadu onboardingowego dla asystenta AI. Twoim celem jest przeprowadzenie użytkownika krok po kroku od zera do działającej, zweryfikowanej konfiguracji greenproof oraz przygotowania pierwszego uruchomienia.

## Zasady naczelne wywiadu

1. **Zadawaj JEDNO pytanie naraz i czekaj na odpowiedź.** Nigdy nie wyrzucaj formularza z kilkoma pytaniami naraz.
2. **Najpierw WYKRYJ, potem pytaj.** Jeśli informację da się sprawdzić poleceniem (czy binarka działa, czy endpoint odpowiada, czy katalog jest repozytorium git, jakie modele zwraca brama), wykonaj sprawdzenie i pokaż wynik, zamiast kazać użytkownikowi zgadywać.
3. **NIGDY nie wypisuj wartości tokenów ani nie wklejaj ich do komend widocznych w transkrypcie.** Token trafia wyłącznie do pliku `.env`, o którym informujesz, że jest dodany do `.gitignore`.
4. **NIGDY nie uruchamiaj `grp run` samodzielnie bez wyraźnej zgody użytkownika.** Skill kończy się przygotowaniem gotowej komendy i pytaniem, czy ją odpalić.
5. **Gdy warunek wstępny nie jest spełniony (aplikacja nie odpowiada, preflight zwraca exit 2), ZATRZYMAJ SIĘ i wytłumacz, co naprawić.** Nie idź dalej na oślep.

---

## Scenariusz wywiadu krok po kroku

### Krok 1: Weryfikacja CLI

**Cel**: Upewnić się, że binarka `grp` działa i pokazać wersję.

**Jak wykryć**:
Wykonaj polecenie:
```sh
grp --version
```

Gdy nie ma binarki na PATH, załóż wrappery jedną komendą (z korzenia repo):

```sh
pnpm setup-cli
```

**Co pokazać użytkownikowi**:
- Pokaż wykrytą wersję CLI (np. `grp 0.1.12`).
- Gdy nie ma binarki na PATH, zaproponuj założenie wrappera (jedna komenda powyżej) i dopiero potem kontynuuj.
- Przejdź do Kroku 2.

---

### Krok 2: Repozytorium testów

**Cel**: Ustalić ścieżkę do repozytorium, w którym powstaną testy Playwright.

**Działanie**:
1. Wyjaśnij użytkownikowi różnicę: **Repozytorium testów to OSOBNE repozytorium** (nie kod źródłowy testowanej aplikacji). To tam greenproof zapisze specy testowe, Page Object Models (POM), fixture'y i utworzy branche robocze w formacie `author/<caseId>`.
2. Zapytaj użytkownika o ścieżkę do katalogu repozytorium testów (np. `~/dev/moje-testy-e2e`).

**Jak sprawdzić odpowiedź**:
Po podaniu ścieżki sprawdź na dysku:
```sh
git -C <sciezka> rev-parse --is-inside-work-tree
```
- Jeśli katalog nie istnieje lub nie jest repozytorium git, poinformuj użytkownika i zaproponuj utworzenie:
  ```sh
  mkdir -p <sciezka> && git -C <sciezka> init
  ```
- Po potwierdzeniu zainicjalizuj repozytorium git i przejdź do Kroku 3.

---

### Krok 3: Aplikacja testowana

**Cel**: Ustalić adres działającej aplikacji (`--app-url`) i zweryfikować jej dostępność.

**Działanie**:
1. Zapytaj użytkownika o adres URL uruchomionej aplikacji (np. `http://localhost:3132` lub `http://127.0.0.1:8080`).

**Jak wykryć i sprawdzić**:
Po podaniu adresu wykonaj:
```sh
curl -sSf -o /dev/null -w '%{http_code}\n' <adres-appki>
```
- **Jeśli zwróci kod 200/301/302/itp.**: Aplikacja działa poprawnie. Pokaż potwierdzenie i przejdź do Kroku 4.
- **Jeśli curl zwróci błąd (brak połączenia)**: **ZATRZYMAJ SIĘ**. Wyjaśnij, że greenproof steruje żywą przeglądarką przeciwko działającemu środowisku. Poproś użytkownika o uruchomienie aplikacji w osobnym terminalu i powtórz curl po potwierdzeniu.

---

### Krok 4: Wybór platformy

**Cel**: Wybrać adapter platformy: lokalny filesystem (`adapter-fs`) czy GitHub (`adapter-github`).

**Działanie**:
Przed zadaniem pytania przedstaw konsekwencje obu wariantów:
- **Lokalnie (`adapter-fs`, domyślnie i rekomendowane na start)**: Wyniki zapisywane w plikach JSON na dysku, branche testowe tworzone lokalnie w repozytorium testów, brak potrzeby integracji z API GitHuba.
- **GitHub (`adapter-github`)**: Wyniki raportowane jako komentarze w Issue GitHuba, gałęzie pushowane na zdalne repozytorium, otwieranie Pull Requestów przez API. Wymaga uprawnień GitHub Token oraz parametru `owner/repo`.

**Pytanie**:
Zapytaj: „Czy konfigurujemy środowisko do pracy lokalnej (adapter-fs), czy integrację z GitHubem (adapter-github)?".
(W 95% przypadków pierwszego startu właściwym wyborem jest praca lokalna).

---

### Krok 5: Kanał i provider modelu

**Cel**: Wybrać preset providera dla agenta-autora.

**Jak wykryć przed pytaniem**:
Sprawdź w tle, które lokalne mostki i bramy faktycznie odpowiadają na maszynie:
```sh
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/v1/models   # Brama LiteLLM
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8317/v1/models   # CLIProxyAPI (mostek OAuth)
```

**Działanie**:
Przedstaw dostępne presety i zaznacz, które endpointy odpowiedziały na maszynie:
1. `litellm` - Brama LiteLLM (`http://127.0.0.1:4000`): dostęp do modeli chmurowych, lokalnych lub abonamentowych; domyślna eskalacja fixture do Claude Sonnet. (Status portu 4000: *dostępny / niedostępny*).
2. `codex-sub` - Mostek CLIProxyAPI (`http://127.0.0.1:8317`): subskrypcja przez OAuth z modelami `gpt-5.6-luna(max)` + eskalacja `gpt-5.6-sol(high)`. (Status portu 8317: *dostępny / niedostępny*).
3. `claude-sub` - API Anthropic wprost: subskrypcja z logowania Claude Code w katalogu domowym lub bezpośredni token Anthropic; domyślnie `claude-opus-5`, bez eskalacji fixture.

Zapytaj użytkownika o wybór presetu.

---

### Krok 6: Konfiguracja tokenu uwierzytelniającego

**Cel**: Upewnić się, że token dla wybranego providera jest skonfigurowany, bez ujawniania jego wartości.

**Zmienne per preset**:
- Dla `litellm`: `LITELLM_KEY`
- Dla `codex-sub`: `CLIPROXY_TOKEN`
- Dla `claude-sub`: `ANTHROPIC_AUTH_TOKEN` (opcjonalny, jeśli użytkownik jest zalogowany w Claude Code lokalnie)

**Jak wykryć**:
Sprawdź, czy zmienna jest już zdefiniowana w środowisku:
```sh
test -n "${NAZWA_ZMIENNEJ}" && echo "USTAWIONA" || echo "BRAK"
```
Sprawdź też, czy istnieje już plik `.env` w repozytorium testów lub katalogu roboczym.

**Działanie**:
- Jeśli zmienna jest ustawiona: poinformuj użytkownika, że zmienna `${NAZWA_ZMIENNEJ}` jest już obecna w środowisku.
- Jeśli zmiennej brakuje: poproś użytkownika o podanie wartości tokenu. Po otrzymaniu zapisz go do pliku `<repo-testow>/.env`:
  ```sh
  echo "NAZWA_ZMIENNEJ=wartosc" >> <repo-testow>/.env
  ```
  Wyjaśnij użytkownikowi:
  - CLI automatycznie wczytuje plik `.env` znajdujący się obok configu.
  - Plik `.env` znajduje się w `.gitignore` i **nigdy nie wolno go commitować**.
  - Wartość tokenu nie zostanie wyświetlona w logach.

---

### Krok 7: Wybór modelu autora

**Cel**: Wybrać model LLM generujący testy i poinformować o cenniku `priceTable`.

**Jak wykryć**:
Jeśli używany jest preset z endpointem (np. LiteLLM), pobierz listę dostępnych modeli:
```sh
grp models --preset <preset>
# lub jeśli config jeszcze nie istnieje:
curl -s http://127.0.0.1:4000/v1/models
```

**Działanie**:
Pokaż użytkownikowi 2-3 rekomendowane modele w zależności od presetu:
- Dla `litellm`:
  - **Najpierw pokaż realną listę**: `grp models` - aliasy w bramie są instalacyjne,
    więc nazwy zgadnięte z pamięci zwykle nie istnieją. Preset zapisuje
    placeholder `<model-z-bramy>`, który MUSI zostać wypełniony.
  - Z listy: tani flash na start, `claude-sonnet-5` przy wysokiej skuteczności w Playwrighcie.
- Dla `codex-sub`: `gpt-5.6-luna(max)` (w ramach abonamentu).
- Dla `claude-sub`: `claude-opus-5` lub `claude-sonnet-5`.

Wyjaśnij zasadę `priceTable`:
- Modele domyślne z presetów mają wpisane stawki estymowane.
- Model nadpisany flagą otrzymuje wpis zerowy ($0) w tabeli kosztów - dzięki temu limity budżetowe (`caps.costUsd`) nie blokują uruchomienia, dopóki użytkownik nie uzupełni realnych stawek w configu.

Zapytaj o wybór modelu (lub zatwierdzenie domyślnego dla danego presetu).

---

### Krok 8: Eskalacja fixture

**Cel**: Ustalić strategię eskalacji modeli przy trudnych problemach infrastruktury testowej.

**Działanie**:
1. Wyjaśnij krótko: Eskalacja fixture uruchamia się automatycznie, gdy słabszy model autora nie radzi sobie ze stworzeniem trudnego selektora lub Page Object Modelu (`fixture-gap`) - mocniejszy model jednorazowo przygotowuje brakujący fixture.
2. Przedstaw opcje:
   - **`auto` (domyślnie i zalecane)**: CLI automatycznie wybierze najlepszy model z listy endpointu wg preferencji presetu (np. `claude-sonnet-5` lub `claude-opus-5`).
   - **Jawny model**: np. `--fixture-author claude-opus-5`.
   - **`none`**: `--fixture-author none` - całkowite wyłączenie eskalacji fixture.

Zapytaj, czy zostawić tryb automatyczny `auto`, czy użytkownik woli inną wartość.

---

### Krok 9: Plan testów

**Cel**: Upewnić się, że istnieje poprawny plik `plan.json` zgodny ze schematem `NormalizedPlan`.

**Działanie**:
Zapytaj użytkownika: „Czy posiadasz już gotowy plik planu testów (np. JSON lub BMAD)?".

- **Wariant A: Użytkownik posiada plan**:
  Poproś o ścieżkę do pliku i sprawdź jego istnienie.

- **Wariant B: Użytkownik NIE MA planu**:
  1. Zapytaj o 1-2 podstawowe scenariusze w aplikacji (np. „Co robi użytkownik i jaki stan strony powinien zostać potwierdzony asercją?").
  2. Wygeneruj minimalny, w 100% poprawny plik `plan.json` w katalogu repozytorium testów, zgodny ze schematem `NormalizedPlanSchema`:

```json
{
  "slug": "pierwszy-przebieg",
  "cases": [
    {
      "caseId": "E2E-SMOKE-001",
      "title": "Logowanie i widok główny aplikacji",
      "level": "e2e",
      "priority": "P0",
      "requirements": [
        "Użytkownik może zalogować się poprawnymi danymi",
        "Po zalogowaniu widoczny jest panel główny"
      ],
      "flows": [
        "Otwórz stronę główną",
        "Wprowadź dane logowania w formularzu",
        "Kliknij przycisk Zaloguj",
        "Potwierdź asercją obecność nagłówka panelu"
      ]
    }
  ]
}
```

Pokaż zawartość pliku użytkownikowi i wskaż, że jest to punkt wyjścia do dalszej edycji.

---

### Krok 10: Generowanie pliku konfiguracyjnego (`grp run --init-only`)

**Cel**: Utworzyć i zweryfikować plik `greenproof.config.mjs`.

**Działanie**:
Zbuduj polecenie `grp run --init-only` z zebranych wcześniej informacji:

```sh
grp run \
  --tests-repo <sciezka-repo-testow> \
  --init-only \
  --preset <wybrany-preset> \
  --author <wybrany-model> \
  --fixture-author <auto|none|model>
```

Uruchom polecenie. Pokaż użytkownikowi ścieżkę do wygenerowanego pliku konfiguracyjnego oraz wskaż wyraźnie oznaczone miejsce w kodzie pliku, w którym można w przyszłości zmienić model lub limity budżetowe (`caps`).

---

### Krok 11: Obowiązkowy Preflight

**Cel**: Przetestować komunikację z endpointem modelu przed uruchomieniem pipeline'u.

**Działanie**:
Uruchom:
```sh
grp preflight --config <sciezka-do-configu>
```

Wyjaśnij użytkownikowi, co sprawdza preflight:
1. **Ping `/v1/messages`**: Czy endpoint odpowiada w formacie Anthropic i czy token jest poprawny.
2. **Wymuszony Tool-Call**: Czy model i brama poprawnie obsługują przekazywanie i wywoływanie narzędzi (`tool_use`).

**Interpretacja wyniku**:
- **Zielony (ok: true)**: Połączenie i narzędzia działają. Przejdź do Kroku 12.
- **Czerwony (exit 2 / błąd)**: **ZATRZYMAJ SIĘ**.
  - Błąd 401/403: Nieprawidłowy lub wygasły token w `.env`.
  - Błąd braku `tool_use`: Mostek lub model gubi wywołania narzędzi (sesje autora nie będą działać).
  - Wyjaśnij przyczynę i pomóż użytkownikowi skorygować konfigurację przed pójściem dalej.

---

### Krok 12: Gotowa komenda uruchomienia

**Cel**: Przedstawić pełną komendę `grp run` i zapytać o zgodę na uruchomienie.

**Działanie**:
Złóż kompletną komendę uruchomieniową:

```sh
grp run \
  --config <sciezka-do-configu> \
  --in <sciezka-do-plan.json> \
  --app-url <adres-appki> \
  --out run-result.json
```

Wyjaśnij użytkownikowi:
- Komenda `grp run` wykonuje całą orkiestrację w jednym procesie: `preflight → filter → triage → fixture → author → deliver → auto-accept`.
- Case'y spełniające deterministyczne kryterium (dowód mutacyjny `valid` +
  bez ostrzeżeń walidatora, czysty lint) pipeline akceptuje SAM; reszta
  czeka na człowieka. Auto-akceptację wyłącza `--no-auto-accept`.
- Czas trwania zależy od liczby case'ów i wybranego modelu (zwykle od 1 do kilku minut per case).
- **ZAPYTAJ**: „Czy chcesz uruchomić ten przebieg teraz?".

#### Uruchomienie przebiegu - ZAWSZE w terminalu użytkownika
Przebieg uruchamia **człowiek w swojej sesji terminala**, nigdy asystent w tle
własnej sesji (uzasadnienie i pełna zasada: `skills/greenproof-cli.md`, §0a).
Rola asystenta: sprawdzić warunki wstępne i **podać gotową komendę do wklejenia**.
Po starcie asystent czyta stan z plików (`grp status --run <runId>`, `--out`),
a nie ze stdout procesu.


### Krok 13: Co dalej po zakończeniu runu

**Cel**: Wskazać użytkownikowi kolejne kroki i komendy operacyjne.

**Działanie**:
Przedstaw krótką mapę postępowania:
1. **Sprawdzenie statusu**:
   ```sh
   grp status --config <config> --run <runId>
   grp status --cases --config <config> --run <runId>
   ```
2. **Co robi pipeline sam, a co decyduje człowiek**:
   - Wyniki kończą się stanami raportów: `draft_delivered` (gotowy test; raport rozróżnia „zaakceptowane automatycznie" od „czeka na Ciebie"), `case_blocked` (blokada środowiska/aplikacji), `app_defect_suspected` (podejrzenie błędu w aplikacji).
   - Case'y z dowodem `valid` + czystym lintem pipeline zaakceptował automatycznie (`run.autoAccept.accepted`); nie wymagają akcji poza release.
   - Ręczna akceptacja case'a, którego pipeline NIE przyjął (dowód invalid, duplikat selektora, auto-accept wyłączona):
     ```sh
     grp accept --config <config> --run <runId> --case <caseId>
     ```
   - Ostateczne wydanie przebiegu po spełnieniu bramek (decyzja człowieka):
     ```sh
     grp release --config <config> --run <runId>
     ```

**Odsyłacze do skilli**:
- Interpretacja wyników, diagnoza blokad i retry: `skills/greenproof-operator.md`
- Zaawansowane flagi i codzienne uruchomienia: `skills/greenproof-cli.md`
- Zmiana modeli, cenników `priceTable` i limitów `caps`: `skills/greenproof-config.md`

---

## Typowe zacięcia i diagnoza

| Objaw | Przyczyna | Co zrobić |
|---|---|---|
| `curl` do `--app-url` zwraca błąd połączenia | Aplikacja testowana nie została uruchomiona | Uruchom serwer testowanej aplikacji w osobnym terminalu przed startem runu. |
| Preflight zwraca `exit 2` z brakiem `tool_use` | Model lub brama/mostek nie obsługuje formatu narzędzi Anthropic | Zmień model na wspierający tool-calling lub sprawdź konfigurację mostka (np. CLIProxyAPI). |
| Błąd HTTP 401 / 403 podczas preflightu | Brakujący, błędny lub wygasły token API | Sprawdź zmienną w `.env` (`LITELLM_KEY`, `CLIPROXY_TOKEN` lub `ANTHROPIC_AUTH_TOKEN`). |
| `grp run --init-only` zgłasza błąd o brakującym `.git` | Wskazany katalog testów nie jest repozytorium git | Wykonaj `git init <sciezka>` w katalogu testów (greenproof commituje na gałęziach `author/*`). |
| `grp run` odrzuca plik wejściowy `--in` | Plik planu nie spełnia schematu `NormalizedPlan` | Upewnij się, że plan zawiera pola `slug` oraz tablicę `cases` z wymaganymi polami (`caseId`, `title`, `level`, `priority`, `requirements`, `flows`). |
| Pusta lista modeli w `grp models` | Brama nie jest uruchomiona lub nie udostępnia endpointu `/v1/models` | Uruchom bramę LiteLLM / CLIProxyAPI lub podaj nazwę modelu jawnie flagą `--author <nazwa>`. |
