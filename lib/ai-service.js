/* global AppEnv */

const CONFIG_PREFIX = 'ai-reply-drafts';

const DEFAULT_SYSTEM_PROMPT =
  'Du bist ein E-Mail-Assistent. Verfasse im Namen des Nutzers eine Antwort auf die ' +
  'folgende E-Mail. Antworte in derselben Sprache wie die Original-E-Mail. Gib nur den ' +
  'Fließtext der Antwort aus — keine Betreffzeile, keine Erklärungen, keine Signatur.';

const DEFAULT_NEW_EMAIL_SYSTEM_PROMPT =
  'Du bist ein E-Mail-Assistent. Verfasse im Namen des Nutzers eine E-Mail basierend auf ' +
  'den Vorgaben. Antworte in derselben Sprache wie die Vorgaben. Gib nur den ' +
  'Fließtext der E-Mail aus — keine Betreffzeile, keine Erklärungen, keine Signatur.';

const DEFAULTS = {
  apiKey: '',
  baseUrl: '',
  model: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  autoGenerate: true,
  sendThreadContext: true,
  extraParams: '',
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

// Lädt die verfügbaren Modelle vom Backend (GET /models, OpenAI-Format).
// Dient in den Einstellungen zugleich als Verbindungs-/API-Key-Test.
async function listModels() {
  const baseUrl = getSanitizedBaseUrl();
  if (!baseUrl) {
    throw new Error('Bitte zuerst eine Basis-URL eintragen.');
  }
  const apiKey = getConfig('apiKey').trim();

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
  return ids;
}

// Liest einen SSE-Stream (OpenAI-Format) und ruft onToken mit dem jeweils
// vollständigen bisherigen Text auf. Gibt den Gesamttext zurück.
async function readSseStream(resp, onToken, signal) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch (err) {
          continue; // unvollständige/fremde Zeile überspringen
        }
        const choice = chunk && chunk.choices && chunk.choices[0];
        const delta =
          (choice && choice.delta && choice.delta.content) ||
          (choice && choice.message && choice.message.content) ||
          '';
        if (delta) {
          full += delta;
          if (onToken) onToken(full);
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || (signal && signal.aborted)) {
      throw new Error('Generierung abgebrochen.');
    }
    throw err;
  }
  return full;
}

async function generateReply({
  subject,
  recipient,
  quotedText,
  userText,
  threadContext,
  isReply = true,
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
    '',
  ];

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

  // Streaming standardmäßig an; über die zusätzlichen Request-Parameter
  // ({"stream": false}) kann es für Backends ohne SSE-Support abgeschaltet
  // werden. Die Antwort wird ohnehin anhand des Content-Types erkannt.
  const body = Object.assign(
    {
      model: getConfig('model').trim(),
      messages: [
        { role: 'system', content: getSystemPrompt(isReply) },
        { role: 'user', content: contextParts.join('\n') },
      ],
      stream: true,
    },
    extra
  );

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  if (signal) {
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      controller.abort();
    });
  }

  let resp;
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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
    throw new Error(`API-Fehler ${resp.status}: ${text || resp.statusText}`);
  }

  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') && resp.body && resp.body.getReader) {
    const full = await readSseStream(resp, onToken, signal);
    if (!full.trim()) {
      throw new Error('Die API-Antwort enthielt keinen Text (leerer Stream).');
    }
    return full.trim();
  }

  // Fallback für Backends, die trotz stream:true (oder bei stream:false via
  // Extra-Parametern) eine normale JSON-Antwort liefern.
  const json = await resp.json();
  const content =
    json &&
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    json.choices[0].message.content;

  if (!content || !content.trim()) {
    throw new Error('Die API-Antwort enthielt keinen Text (choices[0].message.content leer).');
  }
  return content.trim();
}

module.exports = {
  CONFIG_PREFIX,
  DEFAULTS,
  getConfig,
  setConfig,
  isConfigured,
  listModels,
  generateReply,
};
