// Testumgebung: leitet require('mailspring-exports') auf den Stub um und
// stellt die Renderer-Globals (AppEnv, localStorage) bereit.

const Module = require('module');
const path = require('path');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'mailspring-exports') {
    return path.join(__dirname, '..', 'stubs', 'mailspring-exports.js');
  }
  return originalResolve.call(this, request, ...args);
};

const configStore = {};
global.AppEnv = {
  config: {
    get: (key) => configStore[key],
    set: (key, value) => {
      configStore[key] = value;
    },
  },
  paths: {},
};

const localStorageStore = {};
global.localStorage = {
  getItem: (key) => (key in localStorageStore ? localStorageStore[key] : null),
  setItem: (key, value) => {
    localStorageStore[key] = String(value);
  },
  removeItem: (key) => {
    delete localStorageStore[key];
  },
};

function resetConfig(values = {}) {
  for (const key of Object.keys(configStore)) delete configStore[key];
  for (const key of Object.keys(localStorageStore)) delete localStorageStore[key];
  for (const [key, value] of Object.entries(values)) {
    configStore[`ai-reply-drafts.${key}`] = value;
  }
}

// Baut eine fetch-Antwort im JSON-Format (nicht streamend).
function jsonResponse(payload, { status = 200, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: { get: () => contentType },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

// Baut eine fetch-Antwort als SSE-Stream aus den übergebenen data-Zeilen.
function sseResponse(dataLines) {
  const encoder = new TextEncoder();
  const chunks = dataLines.map((line) => encoder.encode(`data: ${line}\n`));
  return {
    ok: true,
    status: 200,
    statusText: 'HTTP 200',
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () =>
          chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined },
      }),
    },
  };
}

module.exports = { configStore, resetConfig, jsonResponse, sseResponse };
