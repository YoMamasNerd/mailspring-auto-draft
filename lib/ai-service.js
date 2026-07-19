/* global AppEnv */

const { version: PLUGIN_VERSION } = require('../package.json');

const CONFIG_PREFIX = 'ai-reply-drafts';

const MODEL_CACHE_TTL = 60 * 60 * 1000; // 1 Stunde
const MODEL_CACHE_KEY = 'ai-reply-drafts.modelCache';

// Preise in $ pro 1M Tokens (Stand 2025, ca. Werte)
// Format: { modelPattern: { input: $/1M, output: $/1M } }
const MODEL_PRICING = {
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 3.00, output: 15.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'o1': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 1.10, output: 4.40 },
  'o3-mini': { input: 1.10, output: 4.40 },
  
  // Anthropic
  'claude-3.5-sonnet': { input: 3.00, output: 15.00 },
  'claude-3.5-haiku': { input: 0.80, output: 4.00 },
  'claude-3-opus': { input: 15.00, output: 75.00 },
  
  // Google
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  
  // Mistral
  'mistral-large': { input: 3.00, output: 9.00 },
  'mistral-small': { input: 0.90, output: 2.70 },
  
  // DeepSeek
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-coder': { input: 0.14, output: 0.28 },
  
  // OpenRouter (kostenlos)
  ':free': { input: 0, output: 0 },
  
  // Lokal (Ollama, LM Studio, etc.)
  'local': { input: 0, output: 0 },
};

function getModelPricing(modelId) {
  if (!modelId) return { input: 0, output: 0, known: false };

  const lower = modelId.toLowerCase();

  // Free tier check
  if (lower.includes(':free') || lower.includes('free')) {
    return { input: 0, output: 0, known: true, free: true };
  }

  // Exact match first
  if (MODEL_PRICING[modelId]) {
    return { ...MODEL_PRICING[modelId], known: true };
  }

  // Pattern matching — längste Patterns zuerst, damit z.B. "gpt-4o-mini-…"
  // nicht fälschlich den "gpt-4o"-Preis bekommt.
  const patterns = Object.entries(MODEL_PRICING).sort((a, b) => b[0].length - a[0].length);
  for (const [pattern, pricing] of patterns) {
    if (lower.includes(pattern.toLowerCase())) {
      return { ...pricing, known: true };
    }
  }

  // Lokale Backends (heuristisch) — erst nach den bekannten Preisen prüfen,
  // sonst würden z.B. "mistral-large" (API) als lokal/kostenlos gelten.
  const localPatterns = ['ollama', 'lmstudio', 'local', 'llama', 'mistral', 'qwen', 'phi', 'gemma'];
  if (localPatterns.some(p => lower.includes(p))) {
    return { input: 0, output: 0, known: true, local: true };
  }

  return { input: 0, output: 0, known: false };
}

// Versionsvergleich (SemVer, Prerelease-Suffixe wie "-prerelease" werden für
// den numerischen Vergleich ignoriert). Return: 1 wenn a > b, -1 wenn a < b, 0 sonst.
function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// Rough token estimation: ~1 token per 4 chars for English, ~1 per 3 for German
function estimateTokens(text) {
  if (!text) return 0;
  const chars = text.length;
  // Conservative estimate: 1 token ≈ 3.5 chars for mixed DE/EN
  return Math.ceil(chars / 3.5);
}

function estimateCost(inputTokens, outputTokens, pricing) {
  if (!pricing.known) return { cost: null, unknown: true };
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return { cost: inputCost + outputCost, inputCost, outputCost, unknown: false };
}

const DEFAULT_SYSTEM_PROMPT =
  'Du bist ein E-Mail-Assistent. Verfasse im Namen des Nutzers eine Antwort auf die ' +
  'folgende E-Mail. Antworte in derselben Sprache wie die Original-E-Mail. Gib nur den ' +
  'Fließtext der Antwort aus — keine Betreffzeile, keine Erklärungen, keine Signatur.';

const DEFAULT_NEW_EMAIL_SYSTEM_PROMPT =
  'Du bist ein E-Mail-Assistent. Verfasse im Namen des Nutzers eine E-Mail basierend auf ' +
  'den Vorgaben. Antworte in derselben Sprache wie die Vorgaben. Gib nur den ' +
  'Fließtext der E-Mail aus — keine Betreffzeile, keine Erklärungen, keine Signatur.';

// Zusatzanweisungen der Ton-Schnellwahl im Composer-Panel.
const TONE_INSTRUCTIONS = {
  formell: 'Gewünschter Ton: betont formell und professionell.',
  locker: 'Gewünschter Ton: locker, freundlich und eher informell.',
  kurz: 'Fasse dich so kurz wie möglich — nur das Wesentliche in wenigen Sätzen.',
};

const DEFAULTS = {
  apiKey: '',
  baseUrl: '',
  model: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  autoGenerate: true,
  sendThreadContext: true,
  extraParams: '',
  replyLanguage: '',
  panelCollapsed: false,
  includeAttachments: false,
  shortcutKey: '', // Custom shortcut, empty = default (Ctrl+Shift+G)
  // Health Check / Failover
  healthCheckEnabled: true,
  healthCheckInterval: 5 * 60 * 1000, // 5 Minuten
  failoverEnabled: false, // Bei Fehler nächstes Modell probieren
  failoverModels: '', // Komma-getrennte Liste von Fallback-Modellen
  // Auto-Updater
  autoUpdateEnabled: true,
  autoUpdateChannel: 'stable', // 'stable' | 'prerelease'
  autoUpdateCheckInterval: 24 * 60 * 60 * 1000, // 24h
  autoUpdateLastCheck: 0,
  autoUpdateAvailableVersion: '',
  autoUpdateReleaseNotes: '',
};

function getConfig(key) {
  const value = AppEnv.config.get(`${CONFIG_PREFIX}.${key}`);
  return value === undefined || value === null ? DEFAULTS[key] : value;
}

function setConfig(key, value) {
  if (key === 'baseUrl') resolvedBaseUrl = null;
  AppEnv.config.set(`${CONFIG_PREFIX}.${key}`, value);
}

function getSanitizedBaseUrl() {
  let url = getConfig('baseUrl').trim().replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/, '');
  url = url.replace(/\/chat$/, '');
  url = url.replace(/\/completions$/, '');
  return url;
}

// Viele Backends hängen den OpenAI-kompatiblen Teil an einen Unterpfad
// (Ollama: /v1, AnythingLLM: /api/v1/openai). Wird unter der konfigurierten
// Basis-URL nichts gefunden (404), probieren wir diese Varianten durch,
// statt den Nutzer mit "Cannot POST /chat/completions" allein zu lassen.
const BASE_URL_SUFFIXES = ['', '/v1', '/api/v1/openai', '/v1/openai', '/openai', '/api'];

// Erfolgreich erkannte Basis (pro Sitzung); wird beim Ändern der Basis-URL
// und über invalidateModelCache() zurückgesetzt.
let resolvedBaseUrl = null;

function activeBaseUrl() {
  return resolvedBaseUrl || getSanitizedBaseUrl();
}

function baseUrlCandidates() {
  const base = getSanitizedBaseUrl();
  if (!base) return [];
  const candidates = [];
  const push = (url) => {
    if (url && !candidates.includes(url)) candidates.push(url);
  };
  if (resolvedBaseUrl) push(resolvedBaseUrl);
  for (const suffix of BASE_URL_SUFFIXES) {
    push(base.endsWith(suffix) && suffix ? base : `${base}${suffix}`);
  }
  return candidates;
}

function getSystemPrompt(isReply) {
  const current = getConfig('systemPrompt');
  if (!current || current === DEFAULT_SYSTEM_PROMPT) {
    return isReply ? DEFAULT_SYSTEM_PROMPT : DEFAULT_NEW_EMAIL_SYSTEM_PROMPT;
  }
  return current;
}

function isConfigured() {
  return getSanitizedBaseUrl().length > 0 && getConfig('model').trim().length > 0;
}

// Extra-Parameter erlauben backend-spezifische RAG-Anbindung (z.B. Open WebUI
// `files`, LiteLLM Metadaten) ohne Codeänderung.
function parsedExtraParams() {
  const raw = getConfig('extraParams').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    throw new Error(`Zusätzliche Request-Parameter sind kein gültiges JSON: ${err.message}`);
  }
}

// Model-Cache Funktionen
function getModelCache(baseUrl, apiKey) {
  try {
    const cache = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY) || '{}');
    const key = baseUrl + '|' + apiKey;
    const entry = cache[key];
    if (entry && Date.now() - entry.timestamp < MODEL_CACHE_TTL) {
      return entry.models;
    }
  } catch (e) {
    // Ignore cache errors
  }
  return null;
}

function setModelCache(baseUrl, apiKey, models) {
  try {
    const cache = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY) || '{}');
    const key = baseUrl + '|' + apiKey;
    cache[key] = { models, timestamp: Date.now() };
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    // Ignore cache errors (quota, etc.)
  }
}

function invalidateModelCache() {
  localStorage.removeItem(MODEL_CACHE_KEY);
  resolvedBaseUrl = null;
}

// Ein einzelner GET /models-Versuch gegen eine konkrete Basis-URL.
// Fehler, bei denen sich eine andere Pfad-Variante lohnt (404, kein JSON),
// tragen err.tryNextBase = true.
async function fetchModelIds(baseUrl, apiKey) {
  const headers = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let resp;
  try {
    resp = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Zeitüberschreitung (20s) — das Backend hat nicht geantwortet.');
    }
    throw new Error(`Verbindung zu ${baseUrl} fehlgeschlagen: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(
      `API-Key wurde abgelehnt (HTTP ${resp.status}). ` +
        'Bei AnythingLLM muss ein Developer-API-Key (Einstellungen → Developer-API) verwendet werden.'
    );
  }
  if (resp.status === 404) {
    const err = new Error(`Kein /models-Endpunkt unter ${baseUrl} (HTTP 404).`);
    err.tryNextBase = true;
    throw err;
  }
  if (!resp.ok) {
    const text = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`API-Fehler ${resp.status}: ${text || resp.statusText}`);
  }

  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    // z.B. eine HTML-Seite des Frontends — falscher Pfad, weiterprobieren.
    const err = new Error(`Antwort von ${baseUrl}/models war kein JSON.`);
    err.tryNextBase = true;
    throw err;
  }

  // OpenAI-Format: {data: [{id}]}; manche Backends liefern {models: [...]}
  const raw = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.models)
      ? json.models
      : [];
  const ids = raw
    .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  if (!ids.length) {
    throw new Error('Verbindung OK, aber die Antwort von /models enthielt keine Modelle.');
  }
  return ids;
}

// Lädt die verfügbaren Modelle vom Backend (GET /models, OpenAI-Format).
// Dient in den Einstellungen zugleich als Verbindungs-/API-Key-Test und
// erkennt dabei die richtige Pfad-Variante der Basis-URL (s. BASE_URL_SUFFIXES).
// forceRefresh umgeht den 1h-Cache (Button "Modelle laden" in den Einstellungen).
async function listModels(forceRefresh = false) {
  const baseUrl = getSanitizedBaseUrl();
  if (!baseUrl) {
    throw new Error('Bitte zuerst eine Basis-URL eintragen.');
  }
  const apiKey = getConfig('apiKey').trim();

  // 1. Cache prüfen
  if (!forceRefresh) {
    const cached = getModelCache(activeBaseUrl(), apiKey);
    if (cached) {
      return cached;
    }
  }

  const candidates = baseUrlCandidates();
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const ids = await fetchModelIds(candidate, apiKey);
      if (candidate !== baseUrl) {
        console.info(`[AI Drafts] Basis-URL automatisch ergänzt: ${baseUrl} → ${candidate}`);
      }
      resolvedBaseUrl = candidate;
      // 2. Cache speichern
      setModelCache(candidate, apiKey, ids);
      return ids;
    } catch (err) {
      lastError = err;
      if (!err.tryNextBase) throw err;
    }
  }
  throw new Error(
    `${lastError.message} Auch die üblichen Pfad-Varianten (${candidates.join(', ')}) ` +
      'liefern keinen OpenAI-kompatiblen /models-Endpunkt. Für AnythingLLM lautet die ' +
      'Basis-URL z.B. http://localhost:3001/api/v1/openai.'
  );
}

// Zieht den Textinhalt aus einem Stream-Chunk. Deckt neben dem
// OpenAI-Delta-Format auch verbreitete Abweichungen ab (vollständige
// message statt delta, Completions-`text`, Ollama-Nativformat).
function extractChunkText(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  const choice = chunk.choices && chunk.choices[0];
  return (
    (choice && choice.delta && choice.delta.content) ||
    (choice && choice.message && choice.message.content) ||
    (choice && choice.text) ||
    (chunk.message && chunk.message.content) ||
    chunk.response ||
    ''
  );
}

// Liest einen SSE-Stream und ruft onToken mit dem jeweils vollständigen
// bisherigen Text auf. Gibt { text, rawSample } zurück — rawSample dient
// der Diagnose, wenn kein Text extrahierbar konnte.
async function readSseStream(resp, onToken, signal) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let rawSample = '';

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line || !line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    if (rawSample.length < 500) {
      rawSample += data.slice(0, 500 - rawSample.length);
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch (err) {
      return; // fremde/unvollständige Zeile überspringen
    }
    // Fehler, die das Backend in den Stream schreibt, sichtbar machen.
    if (chunk && chunk.error) {
      const msg =
        typeof chunk.error === 'string'
          ? chunk.error
          : chunk.error.message || JSON.stringify(chunk.error);
      throw new Error(`API-Fehler im Stream: ${msg}`);
    }
    const delta = extractChunkText(chunk);
    if (delta) {
      full += delta;
      if (onToken) onToken(full);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
    // Rest ohne abschließenden Zeilenumbruch noch verarbeiten.
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
  } catch (err) {
    if (err.name === 'AbortError' || (signal && signal.aborted)) {
      throw new Error('Generierung abgebrochen.');
    }
    throw err;
  }
  return { text: full, rawSample };
}

// Trennt einen führenden "Betreff: …"-Vorschlag vom eigentlichen E-Mail-Text.
function splitSubject(text) {
  const match = /^Betreff:\s*(.+)\n+([\s\S]*)$/.exec(text || '');
  if (match) {
    return { subject: match[1].trim(), body: match[2].trim() };
  }
  return { subject: null, body: text || '' };
}

async function generateReply({
  subject,
  recipient,
  senderName,
  quotedText,
  userText,
  threadContext,
  isReply = true,
  tone,
  wantSubject = false,
  previousSuggestion,
  refineInstruction,
  draft,
  signal,
  onToken,
}) {
  if (!isConfigured()) {
    throw new Error('Bitte zuerst Basis-URL und Modell unter Einstellungen → AI Drafts setzen.');
  }

  const extra = parsedExtraParams();
  const apiKey = getConfig('apiKey').trim();

  const contextParts = [
    `Betreff: ${subject || '(kein Betreff)'}`,
    `Empfänger: ${recipient || 'unbekannt'}`,
  ];
  if (senderName) {
    // Damit Grußformel und Perspektive stimmen — gerade in Threads mit
    // mehreren Beteiligten verwechseln Modelle sonst gern die Rollen.
    contextParts.push(`Absender (der Nutzer, in dessen Namen du schreibst): ${senderName}`);
  }
  contextParts.push('');

  if (isReply) {
    if (threadContext) {
      contextParts.push(
        'Bisheriger E-Mail-Verlauf (chronologisch, beantwortet wird die letzte Nachricht):',
        '"""',
        threadContext,
        '"""'
      );
    } else {
      contextParts.push(
        'Original-E-Mail:',
        '"""',
        quotedText || '(kein zitierter Text gefunden)',
        '"""'
      );
    }
    if (userText && userText.trim()) {
      contextParts.push(
        '',
        'Der Nutzer hat bereits eigene Inhalte in das Antwortfeld geschrieben — das können Stichpunkte,',
        'Notizen oder ein angefangener Antworttext sein. Diese Vorgaben sind verbindlich für den Inhalt',
        'der Antwort: Formuliere Stichpunkte zu vollständigen, ausformulierten Sätzen aus, übernimm alle',
        'genannten Punkte und ergänze nur, was für eine stimmige Antwort nötig ist:',
        '"""',
        userText.trim(),
        '"""'
      );
    }
    
    // Anhänge als Kontext erwähnen (falls aktiviert). Mailspring hält
    // Anhänge als File-Objekte (draft.files) ohne Inhalt im Speicher —
    // mitgesendet werden daher Dateiname und Typ; die inhaltliche
    // RAG-Anbindung läuft backend-seitig (z.B. über extraParams.files).
    const includeAttachments = getConfig('includeAttachments');
    const attachments = (draft && (draft.files || draft.attachments)) || [];
    if (includeAttachments && attachments.length > 0) {
      const ALLOWED_MIME = /^(image\/|text\/)|^application\/(pdf|json|xml)/;
      const usable = attachments
        .filter((a) => a && a.contentType && ALLOWED_MIME.test(a.contentType))
        .filter((a) => !a.size || a.size <= 5 * 1024 * 1024) // Max 5 MB pro Anhang
        .slice(0, 3); // Max 3 Anhänge

      if (usable.length > 0) {
        contextParts.push(
          '',
          `Anhänge der E-Mail (${usable.length} als Kontext genutzt):`,
          ...usable.map((a) => `- ${a.filename || a.name || 'Anhang'} (${a.contentType})`)
        );
      }
    }
  } else {
    contextParts.push(
      'Erstelle eine neue E-Mail basierend auf folgenden Stichpunkten/Anweisungen des Nutzers:',
      '"""',
      userText && userText.trim() ? userText.trim() : 'Bitte verfasse eine passende E-Mail zu diesem Betreff.',
      '"""'
    );
  }

  if (tone && TONE_INSTRUCTIONS[tone]) {
    contextParts.push('', TONE_INSTRUCTIONS[tone]);
  }

  const replyLanguage = (getConfig('replyLanguage') || '').trim();
  if (replyLanguage) {
    contextParts.push(
      '',
      `Verfasse die E-Mail auf ${replyLanguage}, unabhängig von der Sprache des bisherigen Verlaufs.`
    );
  }

  if (wantSubject) {
    contextParts.push(
      '',
      'Gib in der allerersten Zeile einen passenden Betreff im Format "Betreff: …" aus,',
      'danach eine Leerzeile und dann den E-Mail-Text.'
    );
  }

  const messages = [
    { role: 'system', content: getSystemPrompt(isReply) },
    { role: 'user', content: contextParts.join('\n') },
  ];

  // Verfeinerung: der bisherige Vorschlag wird als Assistant-Nachricht
  // mitgeschickt, damit das Modell gezielt überarbeitet statt neu zu würfeln.
  if (previousSuggestion && refineInstruction) {
    messages.push({ role: 'assistant', content: previousSuggestion });
    messages.push({
      role: 'user',
      content:
        'Überarbeite deinen Vorschlag nach folgender Anweisung. Gib nur den ' +
        'vollständigen überarbeiteten Fließtext aus:\n' +
        refineInstruction,
    });
  }

  // Streaming standardmäßig an; über die zusätzlichen Request-Parameter
  // ({"stream": false}) kann es für Backends ohne SSE-Support abgeschaltet
  // werden. Die Antwort wird ohnehin anhand des Content-Types erkannt.
  const body = Object.assign(
    {
      model: getConfig('model').trim(),
      messages,
      stream: true,
    },
    extra
  );

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Führt einen Request aus und liefert { text, rawSample, usage } — unabhängig
  // davon, ob das Backend streamt oder eine normale JSON-Antwort schickt.
  // usage: { inputTokens, outputTokens, totalTokens, cost, costBreakdown }
  const requestOnce = async (requestBody, tokenCb) => {
    // Bei jedem Versuch neu lesen — eine 404-Pfad-Erkennung kann die
    // aufgelöste Basis zwischen zwei Versuchen ändern.
    const baseUrl = activeBaseUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout);
          controller.abort();
        },
        { once: true }
      );
    }

    let resp;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        if (signal && signal.aborted) {
          throw new Error('Generierung abgebrochen.');
        }
        throw new Error('Zeitüberschreitung (90s) — das Backend hat nicht geantwortet.');
      }
      throw new Error(`Verbindung zu ${baseUrl} fehlgeschlagen: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).slice(0, 300);
      // Vollständige Details für die Fehlersuche in die Entwicklerkonsole
      // (Ansicht → Entwickler → Developer Tools).
      try {
        console.error('[AI Drafts] Request fehlgeschlagen', {
          url: `${baseUrl}/chat/completions`,
          status: resp.status,
          statusText: resp.statusText,
          model: requestBody.model,
          stream: requestBody.stream,
          responseBody: text,
        });
      } catch (logErr) {
        // Logging darf nie den eigentlichen Fehler verschlucken.
      }
      let hint = '';
      if (resp.status === 404) {
        hint =
          ' Der /chat/completions-Endpunkt existiert dort nicht — vermutlich fehlt ein Pfad-Teil ' +
          'in der Basis-URL (AnythingLLM: http://localhost:3001/api/v1/openai, Ollama: …/v1).';
      } else if (resp.status === 401 || resp.status === 403) {
        hint =
          ' Prüfe den API-Key; bei AnythingLLM muss zudem der Modellname der Workspace-Slug sein ' +
          '(über "Modelle laden" auswählen).';
      }
      const apiError = new Error(
        `API-Fehler ${resp.status} (Modell "${requestBody.model}", ` +
          `${requestBody.stream ? 'mit' : 'ohne'} Streaming, ${baseUrl}/chat/completions): ` +
          `${text || resp.statusText || 'keine Details vom Backend'}${hint}`
      );
      apiError.status = resp.status;
      throw apiError;
    }

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') && resp.body && resp.body.getReader) {
      const streamResult = await readSseStream(resp, tokenCb, signal);
      // Try to extract usage from stream if available (some backends send it at the end)
      return { ...streamResult, usage: null };
    }

    // Normale JSON-Antwort (Backend ohne Streaming oder stream:false).
    const rawText = await resp.text();
    let json;
    try {
      json = JSON.parse(rawText);
    } catch (err) {
      throw new Error(
        `Antwort war kein gültiges JSON (Content-Type: ${contentType || 'unbekannt'}): ` +
          rawText.slice(0, 200)
      );
    }
    
    // Extract usage if available (OpenAI format)
    let usage = null;
    if (json.usage) {
      const modelId = requestBody.model;
      const pricing = getModelPricing(modelId);
      const inputTokens = json.usage.prompt_tokens || 0;
      const outputTokens = json.usage.completion_tokens || 0;
      const costData = estimateCost(inputTokens, outputTokens, pricing);
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: json.usage.total_tokens || (inputTokens + outputTokens),
        ...costData,
      };
    }
    
    return { text: (extractChunkText(json) || '').trim(), rawSample: rawText.slice(0, 500), usage };
  };

  let result;
  try {
    result = await requestOnce(body, onToken);
  } catch (err) {
    if (err.status === 404 && !(signal && signal.aborted)) {
      // 404 heißt fast immer: falsche Pfad-Variante der Basis-URL (z.B.
      // AnythingLLM ohne /api/v1/openai). Einmal die Varianten durchprobieren
      // und den Request gegen die erkannte Basis wiederholen.
      const previousBase = activeBaseUrl();
      try {
        await listModels(true);
      } catch (probeErr) {
        throw err; // Original-Fehler samt Hinweis ist aussagekräftiger
      }
      if (activeBaseUrl() === previousBase) throw err;
      result = await requestOnce(body, onToken);
    } else {
      // Manche Backends quittieren Streaming-Requests mit einem Serverfehler
      // (z.B. 500). Bei API-Fehlern einmal ohne Streaming nachfragen, bevor wir
      // aufgeben; Abbruch/Timeout/Verbindungsfehler werden nicht wiederholt.
      const retryable =
        body.stream !== false && !(signal && signal.aborted) && /^API-Fehler/.test(err.message);
      if (!retryable) throw err;
      result = { text: '', rawSample: '' };
    }
  }

  // Greift auch, wenn der Stream zwar ankam, aber kein Text extrahierbar war.
  if (!result.text.trim() && body.stream !== false && !(signal && signal.aborted)) {
    result = await requestOnce(Object.assign({}, body, { stream: false }), null);
    if (result.text.trim() && onToken) {
      onToken(result.text.trim());
    }
  }

  if (!result.text.trim()) {
    const hint = result.rawSample
      ? ` Antwort-Auszug zur Diagnose: ${result.rawSample.slice(0, 200)}`
      : '';
    throw new Error(`Die API-Antwort enthielt keinen Text.${hint}`);
  }

  const text = result.text.trim();

  // Token-/Kosteninfo fürs Panel: echte usage-Daten des Backends, sonst
  // Schätzung (Streaming-Antworten enthalten meist keine usage).
  const pricing = getModelPricing(body.model);
  let usage = result.usage;
  if (!usage) {
    const inputTokens = estimateTokens(messages.map((m) => m.content).join('\n'));
    const outputTokens = estimateTokens(text);
    usage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimated: true,
      ...estimateCost(inputTokens, outputTokens, pricing),
    };
  }
  usage.free = !!pricing.free;
  usage.local = !!pricing.local;

  return { text, usage };
}

module.exports = {
  CONFIG_PREFIX,
  DEFAULTS,
  getConfig,
  setConfig,
  isConfigured,
  listModels,
  invalidateModelCache,
  // Health-Check für "Verbindung testen" Button
  async healthCheck() {
    if (!getSanitizedBaseUrl()) {
      return { ok: false, error: 'Basis-URL fehlt' };
    }
    const baseUrl = activeBaseUrl();
    const apiKey = getConfig('apiKey').trim();
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let resp;
      try {
        resp = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
      } finally {
        // Auch bei Verbindungsfehlern aufräumen, sonst bleibt ein 10s-Timer zurück.
        clearTimeout(timeout);
      }
      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, error: 'API-Key ungültig (401/403)' };
      }
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
      }
      const json = await resp.json();
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
      const count = raw.filter(m => typeof m === 'string' || m?.id || m?.name).length;
      return { ok: true, models: count, message: `✓ Verbindung OK — ${count} Modelle gefunden` };
    } catch (err) {
      if (err.name === 'AbortError') return { ok: false, error: 'Timeout (10s) — Backend nicht erreichbar' };
      return { ok: false, error: `Verbindung fehlgeschlagen: ${err.message}` };
    }
  },
  // Periodischer Health Check (für Auto-Failover)
  async runPeriodicHealthCheck() {
    if (!getConfig('healthCheckEnabled')) return { ok: true, skipped: true };
    const result = await this.healthCheck();
    if (!result.ok && getConfig('failoverEnabled')) {
      const originalModel = getConfig('model');
      const failoverModels = getConfig('failoverModels')
        .split(',')
        .map(m => m.trim())
        .filter(Boolean);
      // Jeder Fallback wird pro Zyklus nur einmal probiert.
      for (const model of failoverModels) {
        setConfig('model', model);
        const retry = await this.healthCheck();
        if (retry.ok) {
          return { ok: true, failover: true, model, message: `Failover zu ${model} erfolgreich` };
        }
      }
      // Kein Fallback erreichbar — ursprüngliches Modell wiederherstellen,
      // sonst bleibt die Nutzer-Konfiguration auf dem letzten Fallback hängen.
      setConfig('model', originalModel);
      return { ok: false, error: result.error, failoverFailed: true };
    }
    return result;
  },
  // Auto-Updater: Prüft GitHub Releases auf neue Version
  async checkForUpdates(force = false) {
    if (!getConfig('autoUpdateEnabled')) return { updateAvailable: false, reason: 'disabled' };
    const now = Date.now();
    let interval = Number(getConfig('autoUpdateCheckInterval')) || 24 * 60 * 60 * 1000;
    // Ältere Configs speicherten Stunden statt Millisekunden.
    if (interval > 0 && interval < 1000) interval = interval * 60 * 60 * 1000;
    if (!force && now - getConfig('autoUpdateLastCheck') < interval) {
      return { updateAvailable: false, reason: 'interval', lastCheck: getConfig('autoUpdateLastCheck') };
    }
    setConfig('autoUpdateLastCheck', now);

    const currentVersion = PLUGIN_VERSION;
    const channel = getConfig('autoUpdateChannel') || 'stable';
    const includePrerelease = channel === 'prerelease';

    try {
      const resp = await fetch('https://api.github.com/repos/YoMamasNerd/mailspring-auto-draft/releases', {
        headers: { Accept: 'application/vnd.github.v3+json' },
      });
      if (!resp.ok) throw new Error(`GitHub API: ${resp.status}`);
      const releases = await resp.json();

      for (const release of releases) {
        if (!includePrerelease && release.prerelease) continue;
        if (release.draft) continue;

        const tag = release.tag_name.replace(/^v/, '');
        if (compareVersions(tag, currentVersion) > 0) {
          // Neues Release gefunden
          const asset = release.assets.find(a => a.name.endsWith('.zip'));
          setConfig('autoUpdateAvailableVersion', tag);
          setConfig('autoUpdateReleaseNotes', release.body || '');
          return {
            updateAvailable: true,
            version: tag,
            releaseNotes: release.body || '',
            downloadUrl: asset ? asset.browser_download_url : null,
            htmlUrl: release.html_url,
            publishedAt: release.published_at,
          };
        }
      }
      setConfig('autoUpdateAvailableVersion', '');
      setConfig('autoUpdateReleaseNotes', '');
      return { updateAvailable: false, reason: 'up-to-date' };
    } catch (err) {
      return { updateAvailable: false, reason: 'error', error: err.message };
    }
  },

  // Lädt Update-ZIP herunter und installiert es (Mailspring-Neustart nötig)
  async downloadAndInstallUpdate(downloadUrl) {
    try {
      const resp = await fetch(downloadUrl);
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
      const arrayBuffer = await resp.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // In Mailspring kann man Plugins zur Laufzeit nicht hot-reloaden.
      // Wir speichern das ZIP in den App-Daten und zeigen Anleitung.
      const fs = require('fs');
      const path = require('path');
      const appData = AppEnv.paths && AppEnv.paths.userData ? AppEnv.paths.userData : require('os').homedir();
      const updateDir = path.join(appData, 'mailspring-auto-draft-updates');
      if (!fs.existsSync(updateDir)) fs.mkdirSync(updateDir, { recursive: true });
      const zipPath = path.join(updateDir, `ai-reply-drafts-${getConfig('autoUpdateAvailableVersion')}.zip`);
      fs.writeFileSync(zipPath, Buffer.from(uint8Array));

      return {
        success: true,
        zipPath,
        message: `Update heruntergeladen. Bitte Mailspring neu starten und das ZIP manuell installieren: ${zipPath}`,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  // Exported for cost estimation
  getModelPricing,
  estimateTokens,
  estimateCost,
  generateReply,
  splitSubject,
  compareVersions,
};