/**
 * Preflight endpointu modelu - walidacja PRZED odpaleniem sesji autora.
 * Dwa stopnie: (1) zwykły ping /v1/messages, (2) wymuszony tool-call -
 * silnik autora żyje z narzędzi, a to właśnie tool-calling najczęściej
 * kuleje w bramach i mostkach subskrypcyjnych (np. CLIProxyAPI).
 */
import type { GreenproofConfig } from '../config/types.js';
import type { SecretsPort } from '../ports/index.js';

export interface PreflightResult {
  endpoint: string;
  model: string;
  ping: { ok: boolean; latencyMs?: number; error?: string };
  toolUse: { ok: boolean; latencyMs?: number; error?: string };
  ok: boolean;
}

const PING_BODY = (model: string) => ({
  model,
  // Zapas na modele z wymuszonym reasoningiem: thinking konsumuje budżet
  // ZANIM powstanie blok text - przy 24 tokenach ping fałszywie padał
  // (stop_reason: max_tokens, content: []).
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Odpowiedz jednym słowem: pong' }],
});

const TOOL_BODY = (model: string) => ({
  model,
  // 128 tokenów wystarczało modelom bez rozumowania, ale model MYŚLĄCY zjada
  // ten budżet na rozumowanie, zanim dojdzie do wywołania narzędzia - sonda
  // wracała wtedy PUSTA (`stop_reason: end_turn`, zero bloków) i preflight
  // fałszywie orzekał „endpoint nie przenosi tool-callingu". Zmierzone na
  // qwen36-27b-mtp: 128 → brak bloków, 1024 → poprawny `tool_use`.
  // To jedno wywołanie na cały run, więc zapas jest darmowy.
  max_tokens: 1024,
  tools: [
    {
      name: 'get_status',
      description: 'Zwraca status systemu. Użyj tego narzędzia, żeby odpowiedzieć.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
  tool_choice: { type: 'tool', name: 'get_status' },
  messages: [{ role: 'user', content: 'Sprawdź status systemu narzędziem get_status.' }],
});

async function callMessages(
  endpoint: string,
  token: string | undefined,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown; latencyMs: number }> {
  const started = Date.now();
  const res = await fetch(`${endpoint.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(token !== undefined ? { 'x-api-key': token } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json, latencyMs: Date.now() - started };
}

function hasContentBlock(json: unknown, type: string): boolean {
  const content = (json as { content?: unknown })?.content;
  return Array.isArray(content) && content.some((b) => (b as { type?: string })?.type === type);
}

/**
 * Ping sprawdza TRANSPORT (endpoint mówi formatem Anthropic), nie elokwencję:
 * model z reasoningiem potrafi spalić cały budżet na thinking i nie zdążyć
 * z blokiem text - to wciąż żywy, poprawny endpoint. Zdolności egzekwuje
 * dopiero test tool-calla.
 */
function hasAnyContent(json: unknown): boolean {
  const content = (json as { content?: unknown })?.content;
  return Array.isArray(content) && content.length > 0;
}

/**
 * Preset bramy nie zna nazwy modelu - aliasy w LiteLLM są instalacyjne, więc
 * `gp run --init-only --preset litellm` zapisuje placeholder `<model-z-bramy>`.
 * Bez tej bramki run szedłby do bramy z dosłownym „<model-z-bramy>" i wracał
 * z surowym 400/404, po którym nie widać, że wystarczy uzupełnić jedno pole.
 */
const PLACEHOLDER_RE = /^<.*>$/;

export async function runPreflight(
  config: GreenproofConfig,
  secrets: SecretsPort,
  opts?: { timeoutMs?: number },
): Promise<PreflightResult> {
  const endpoint = config.model.baseUrl ?? 'https://api.anthropic.com';
  const token = secrets.get(config.model.authTokenEnv);
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const result: PreflightResult = {
    endpoint,
    model: config.model.author,
    ping: { ok: false },
    toolUse: { ok: false },
    ok: false,
  };

  if (PLACEHOLDER_RE.test(config.model.author.trim())) {
    const err =
      `Model autora to niewypełniony placeholder "${config.model.author}". ` +
      'Wpisz nazwę modelu ze SWOJEJ bramy: `gp models` wypisze dostępne, ' +
      'potem ustaw ją w `model.author` w configu albo podaj flagą --author. ' +
      'Pamiętaj też o wpisie w `priceTable` pod tą nazwą - bez niego capy kosztowe nie gryzą.';
    result.ping = { ok: false, error: err };
    result.toolUse = { ok: false, error: err };
    return result;
  }

  try {
    const r = await callMessages(endpoint, token, PING_BODY(config.model.author), timeoutMs);
    if (r.status === 200 && (hasContentBlock(r.json, 'text') || hasAnyContent(r.json))) {
      result.ping = { ok: true, latencyMs: r.latencyMs };
    } else {
      result.ping = {
        ok: false,
        latencyMs: r.latencyMs,
        error: `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`,
      };
    }
  } catch (err) {
    result.ping = { ok: false, error: String(err) };
  }

  if (result.ping.ok) {
    try {
      const r = await callMessages(endpoint, token, TOOL_BODY(config.model.author), timeoutMs);
      if (r.status === 200 && hasContentBlock(r.json, 'tool_use')) {
        result.toolUse = { ok: true, latencyMs: r.latencyMs };
      } else {
        result.toolUse = {
          ok: false,
          latencyMs: r.latencyMs,
          error:
            r.status === 200
              ? 'Odpowiedź bez bloku tool_use - endpoint nie przenosi tool-callingu w formacie Anthropic (sesje autora NIE będą działać)'
              : `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`,
        };
      }
    } catch (err) {
      result.toolUse = { ok: false, error: String(err) };
    }
  }

  result.ok = result.ping.ok && result.toolUse.ok;
  return result;
}
