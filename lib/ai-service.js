/* global AppEnv */

const CONFIG_PREFIX = 'ai-reply-drafts';

const MODEL_CACHE_TTL = 60 * 60 * 1000; // 1 Stunde
const MODEL_CACHE_KEY = 'ai-reply-drafts.modelCache';

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
};

function getConfig(key) {
  const value = AppEnv.config.get(`${CONFIG_PREFIX}.${key}`);
  return value === undefined || value === null ? DEFAULTS[key] : value;
}

function setConfig(key, value) {
  AppEnv.config.set(`${CONFIG_PREFIX}.${key}`, value);
}

function getSanitizedBaseUrl() {
  let url = getConfig('baseUrl').trim().replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/, '');
  url = url.replace(/\/chat$/, '');
  url = url.replace(/\/completions$/, '');
  return url;
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
}

// Lädt die verfügbaren Modelle vom Backend (GET /models, OpenAI-Format).
// Dient in den Einstellungen zugleich als Verbindungs-/API-Key-Test.
async function listModels() {
  const baseUrl = getSanitizedBaseUrl();
  if (!baseUrl) {
    throw new Error('Bitte zuerst eine Basis-URL eintragen.');
  }
  const apiKey = getConfig('apiKey').trim();

  // 1. Cache prüfen
  const cached = getModelCache(baseUrl, apiKey);
  if (cached) {
    return cached;
  }

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
    throw new Error(`API-Key wurde abgelehnt (HTTP ${resp.status}).`);
  }
  if (!resp.ok) {
    const text = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`API-Fehler ${resp.status}: ${text || resp.statusText}`);
  }

  const json = await resp.json();
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

  // 2. Cache speichern
  setModelCache(baseUrl, apiKey, ids);
  return ids;
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
  signal,
  onToken,
}) {
  if (!isConfigured()) {
    throw new Error('Bitte zuerst Basis-URL und Modell unter Einstellungen → AI Drafts setzen.');
  }

  const extra = parsedExtraParams();
  const baseUrl = getSanitizedBaseUrl();
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

  // Führt einen Request aus und liefert { text, rawSample } — unabhängig
  // davon, ob das Backend streamt oder eine normale JSON-Antwort schickt.
  const requestOnce = async (requestBody, tokenCb) => {
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
      throw new Error(
        `API-Fehler ${resp.status} (Modell "${requestBody.model}", ` +
          `${requestBody.stream ? 'mit' : 'ohne'} Streaming, ${baseUrl}/chat/completions): ` +
          `${text || resp.statusText || 'keine Details vom Backend'}`
      );
    }

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') && resp.body && resp.body.getReader) {
      return readSseStream(resp, tokenCb, signal);
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
    return { text: (extractChunkText(json) || '').trim(), rawSample: rawText.slice(0, 500) };
  };

  let result;
  try {
    result = await requestOnce(body, onToken);
  } catch (err) {
    // Manche Backends quittieren Streaming-Requests mit einem Serverfehler
    // (z.B. 500). Bei API-Fehlern einmal ohne Streaming nachfragen, bevor wir
    // aufgeben; Abbruch/Timeout/Verbindungsfehler werden nicht wiederholt.
    const retryable =
      body.stream !== false && !(signal && signal.aborted) && /^API-Fehler/.test(err.message);
    if (!retryable) throw err;
    result = { text: '', rawSample: '' };
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
  return result.text.trim();
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
    const baseUrl = getSanitizedBaseUrl();
    if (!baseUrl) {
      return { ok: false, error: 'Basis-URL fehlt' };
    }
    const apiKey = getConfig('apiKey').trim();
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
      clearTimeout(timeout);
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
  generateReply,
  splitSubject,
};