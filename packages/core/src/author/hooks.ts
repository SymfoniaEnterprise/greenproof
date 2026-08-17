/**
 * Hooki sesji autora - techniczne egzekwowanie know-how kosztowego:
 * cap uruchomień `playwright test`, sandbox Bash, bramka higieny snapshotów
 * i twarde przycinanie wyników narzędzi. Deny ma priorytet nad wolą modelu -
 * to egzekwowanie, nie prompt engineering.
 */
import type {
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { GreenproofConfig } from '../config/types.js';
import type { Logger } from '../ports/index.js';
import type { AuthorSessionState } from './state.js';

/**
 * Regex łapie bezpośrednie odpalenia `playwright test` przez powłokę. To sito
 * pierwszej linii - indirekcję (skrypt npm wołający playwright w środku) i tak
 * zatrzymuje odrzucenie niewersjonowanego raportu w record_proof_material oraz
 * kasowanie stęchłych raportów przed każdym run_playwright.
 */
const PLAYWRIGHT_TEST_RE =
  /(?:(?:npx\s+|pnpm\s+(?:dlx\s+|exec\s+|run\s+)?|yarn\s+(?:dlx\s+)?|bunx\s+|node_modules\/\.bin\/)?(?:@playwright\/test|playwright)(?:@[\w.^~-]+)?|node\s+\S*@playwright\/test\/cli\.[cm]?js)\s+test\b/;

/**
 * Skrypty pakietowe (`npm test`, …) uruchamiają playwright pośrednio - regex
 * nie widzi ich wnętrza, więc przy egzekwowaniu run_playwright blokujemy je
 * w całości. Druga linia obrony: record_proof_material przyjmuje wtedy
 * wyłącznie raporty z run_playwright.
 */
const PACKAGE_TEST_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/;

const NON_MUTATING_BROWSER_TOOLS = new Set([
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_find',
  'mcp__playwright__browser_verify_element_visible',
  'mcp__playwright__browser_verify_text_visible',
  'mcp__playwright__browser_verify_list_visible',
  'mcp__playwright__browser_verify_value',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_network_requests',
  'mcp__playwright__browser_generate_locator',
  'mcp__playwright__browser_take_screenshot',
]);

/**
 * Po zadziałaniu bezpiecznika dozwolone: formalne zakończenie ORAZ
 * report_seed_attempt - spóźnione potwierdzenie seedu (outcome ok) ZDEJMUJE
 * bezpiecznik.
 */
const ALLOWED_AFTER_FUSE = [
  /^mcp__greenproof__finish$/,
  /^mcp__greenproof__report_seed_attempt$/,
  /structured.?output/i,
];

const DENY_COMMAND_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /git\s+push/, reason: 'Push do repo testów wykonuje wyłącznie krok accept' },
  { re: /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+[/~]/, reason: 'Destrukcyjne rm poza katalogiem roboczym' },
  { re: /\bgh\s+(pr|release|repo)\b/, reason: 'Operacje na platformie wykonuje pipeline, nie agent' },
];

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function allow(): HookJSONOutput {
  return { continue: true };
}

export function buildAuthorHooks(
  state: AuthorSessionState,
  config: GreenproofConfig,
  logger: Logger,
): Partial<Record<'PreToolUse' | 'PostToolUse', HookCallbackMatcher[]>> {
  const caps = config.caps;
  const gating = caps.snapshotGating;

  const preToolUse = async (raw: HookInput): Promise<HookJSONOutput> => {
    const input = raw as PreToolUseHookInput;
    const tool = input.tool_name;

    if (state.fuseTripped && !ALLOWED_AFTER_FUSE.some((re) => re.test(tool))) {
      return deny(
        'Bezpiecznik seedu przerwał pracę - zgłoś wynik BLOCKED przez zakończenie sesji (structured output), nie próbuj dalej.',
      );
    }

    if (tool === 'Bash') {
      const command = String((input.tool_input as { command?: unknown })?.command ?? '');
      for (const { re, reason } of DENY_COMMAND_PATTERNS) {
        if (re.test(command)) return deny(reason);
      }
      if (PLAYWRIGHT_TEST_RE.test(command)) {
        // Runy wyłącznie narzędziem procesowym: ono wersjonuje raport i pilnuje
        // obu pul budżetu. Kill switch (false) zostawia stare liczenie dla
        // modeli, które nie wołają narzędzi MCP.
        if (caps.enforceRunPlaywrightTool) {
          return deny(
            'Uruchamianie `playwright test` z Basha jest zablokowane - użyj narzędzia mcp__greenproof__run_playwright. Ono wersjonuje raport JSON per przebieg (współdzielony plik raportu nadpisuje każdy kolejny run) i pilnuje budżetu runów. Ścieżkę zwróconą przez to narzędzie podajesz do record_proof_material.',
          );
        }
        if (state.phase === 'assert') {
          if (state.playwrightRunsByPhase.assert >= caps.maxPlaywrightRuns) {
            return deny(
              `Limit ${caps.maxPlaywrightRuns} uruchomień playwright test w fazie assert wyczerpany - zakończ sesję z aktualnym wynikiem zamiast iterować dalej.`,
            );
          }
        }
        state.playwrightRunsByPhase[state.phase] += 1;
      }
      // Skrypt pakietowy może wołać playwright w środku - przy egzekwowaniu
      // narzędzia procesowego nie ma legalnego powodu odpalać `... test` z Basha.
      if (caps.enforceRunPlaywrightTool && PACKAGE_TEST_RE.test(command)) {
        return deny(
          'Uruchamianie skryptów testowych pakietu (npm/pnpm/yarn/bun test) jest zablokowane - testy playwright odpalasz WYŁĄCZNIE narzędziem mcp__greenproof__run_playwright (wersjonowany raport + budżet runów).',
        );
      }
      return allow();
    }

    if (tool === 'mcp__playwright__browser_snapshot') {
      if (!state.pageChangedSinceSnapshot) {
        state.snapshotGateHits += 1;
        const hint =
          'Strona nie zmieniła się od ostatniego pełnego snapshotu - użyj celowanych zapytań: browser_find / browser_verify_text_visible (rola/tekst/testid). Pełny snapshot pompuje cache_read, główny koszt runa.';
        if (gating === 'enforce') return deny(hint);
        logger.warn(`[snapshot-gate] ${hint}`);
      }
      return allow();
    }

    return allow();
  };

  const postToolUse = async (raw: HookInput): Promise<HookJSONOutput> => {
    const input = raw as PostToolUseHookInput;
    const tool = input.tool_name;

    // Śledzenie realnych zmian strony dla bramki snapshotów.
    if (tool.startsWith('mcp__playwright__')) {
      if (tool === 'mcp__playwright__browser_snapshot') {
        state.pageChangedSinceSnapshot = false;
      } else if (!NON_MUTATING_BROWSER_TOOLS.has(tool)) {
        state.pageChangedSinceSnapshot = true;
      }
    }

    if (tool === 'Write' || tool === 'Edit') {
      const path = (input.tool_input as { file_path?: unknown })?.file_path;
      if (typeof path === 'string') state.filesTouched.add(path);
    }

    // Twarde przycięcie rozdętych wyników - każdy nadmiarowy bajt wraca w
    // KAŻDEJ kolejnej turze jako cache_read.
    const truncated = truncateToolResponse(input.tool_response, caps.snapshotMaxChars);
    if (truncated !== undefined) {
      return {
        hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: truncated },
      };
    }
    return allow();
  };

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
  };
}

const TRUNCATION_NOTE = '\n\n[greenproof: wynik przycięty do limitu snapshotMaxChars]';

/** Zwraca przyciętą odpowiedź albo undefined, gdy limit nie jest przekroczony. */
export function truncateToolResponse(response: unknown, maxChars: number): unknown {
  if (typeof response === 'string') {
    return response.length > maxChars ? response.slice(0, maxChars) + TRUNCATION_NOTE : undefined;
  }
  if (response !== null && typeof response === 'object' && 'content' in response) {
    const content = (response as { content?: unknown }).content;
    if (!Array.isArray(content)) return undefined;
    let changed = false;
    const newContent = content.map((block) => {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string' &&
        ((block as { text: string }).text.length > maxChars)
      ) {
        changed = true;
        return { ...block, text: (block as { text: string }).text.slice(0, maxChars) + TRUNCATION_NOTE };
      }
      return block;
    });
    return changed ? { ...(response as object), content: newContent } : undefined;
  }
  return undefined;
}
