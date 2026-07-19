// Smoke-Tests: laufen ohne Mailspring und ohne Dependencies mit Nodes
// eingebautem Test-Runner (node --test tests/). Sie decken die Fehlerklassen
// ab, die das Plugin komplett lahmlegen (Load-Crashes) oder Kernpfade brechen
// (Request-/Antwortformat, Streaming, Cache, Failover, Updater).

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetConfig, configStore, jsonResponse, sseResponse } = require('./helpers/bootstrap');

const AIService = require('../lib/ai-service');

const BASE_CONFIG = {
  baseUrl: 'http://localhost:9999/v1',
  model: 'test-model',
};

// Setzt Config UND den Modul-Zustand (Model-Cache, aufgelöste Basis-URL) zurück.
function reset(values = {}) {
  resetConfig(values);
  AIService.invalidateModelCache();
}

test('alle lib-Module laden ohne Fehler', () => {
  reset();
  // Ein ReferenceError beim require() würde das gesamte Plugin lahmlegen.
  assert.ok(require('../lib/ai-service'));
  assert.ok(require('../lib/text-utils'));
  assert.ok(require('../lib/thread-context'));
  assert.ok(require('../lib/ai-draft-panel'));
  assert.ok(require('../lib/preferences'));
  const main = require('../lib/main');
  assert.equal(typeof main.activate, 'function');
  assert.equal(typeof main.deactivate, 'function');
  main.activate();
  main.deactivate();
});

test('compareVersions: SemVer inkl. Prerelease-Suffix', () => {
  assert.equal(AIService.compareVersions('0.4.1', '0.4.0'), 1);
  assert.equal(AIService.compareVersions('0.4.1', '0.4.0-prerelease'), 1);
  assert.equal(AIService.compareVersions('0.4.0', '0.4.0-prerelease'), 0);
  assert.equal(AIService.compareVersions('0.3.9', '0.4.0'), -1);
  assert.equal(AIService.compareVersions('1.0', '1.0.0'), 0);
});

test('getModelPricing: bekannte Preise vor Lokal-Heuristik', () => {
  assert.equal(AIService.getModelPricing('mistral-large').input, 3.0);
  assert.equal(AIService.getModelPricing('gpt-4o-mini-2024-07-18').input, 0.15);
  assert.equal(AIService.getModelPricing('ollama/mycustom-model').local, true);
  assert.equal(AIService.getModelPricing('some/model:free').free, true);
  assert.equal(AIService.getModelPricing('totally-unknown-xyz').known, false);
});

test('splitSubject trennt Betreffvorschlag vom Text', () => {
  const split = AIService.splitSubject('Betreff: Angebot\n\nHallo Welt');
  assert.equal(split.subject, 'Angebot');
  assert.equal(split.body, 'Hallo Welt');
  const none = AIService.splitSubject('Hallo Welt');
  assert.equal(none.subject, null);
  assert.equal(none.body, 'Hallo Welt');
});

test('generateReply (JSON-Backend): liefert { text, usage } und filtert Anhänge', async () => {
  reset({ ...BASE_CONFIG, includeAttachments: true });
  let requestBody = null;
  global.fetch = async (url, opts = {}) => {
    requestBody = JSON.parse(opts.body);
    return jsonResponse({
      choices: [{ message: { content: 'Hallo, das ist die Antwort.' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  };

  const result = await AIService.generateReply({
    subject: 'Test',
    recipient: 'a@b.de',
    senderName: 'Jonny',
    quotedText: 'Original',
    userText: 'Stichpunkte',
    isReply: true,
    draft: {
      files: [
        { filename: 'doc.pdf', contentType: 'application/pdf', size: 1024 },
        { filename: 'huge.pdf', contentType: 'application/pdf', size: 99 * 1024 * 1024 },
        { filename: 'x.exe', contentType: 'application/octet-stream', size: 10 },
      ],
    },
  });

  assert.equal(result.text, 'Hallo, das ist die Antwort.');
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.outputTokens, 20);

  const prompt = requestBody.messages[1].content;
  assert.ok(prompt.includes('doc.pdf'), 'doc.pdf muss im Prompt stehen');
  assert.ok(!prompt.includes('huge.pdf'), 'huge.pdf (>5MB) darf nicht im Prompt stehen');
  assert.ok(!prompt.includes('x.exe'), 'x.exe (falscher MIME-Typ) darf nicht im Prompt stehen');
});

test('generateReply (SSE-Streaming): setzt Tokens zusammen und schätzt usage', async () => {
  reset(BASE_CONFIG);
  global.fetch = async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'Hallo ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'Welt' } }] }),
      '[DONE]',
    ]);

  const partials = [];
  const result = await AIService.generateReply({
    subject: 'Test',
    recipient: 'a@b.de',
    quotedText: 'Original',
    userText: '',
    isReply: true,
    onToken: (text) => partials.push(text),
  });

  assert.equal(result.text, 'Hallo Welt');
  assert.deepEqual(partials, ['Hallo ', 'Hallo Welt']);
  assert.equal(result.usage.estimated, true, 'ohne Backend-usage muss geschätzt werden');
  assert.ok(result.usage.inputTokens > 0);
  assert.ok(result.usage.outputTokens > 0);
});

test('generateReply: Retry ohne Streaming nach API-Fehler', async () => {
  reset(BASE_CONFIG);
  const bodies = [];
  let call = 0;
  global.fetch = async (url, opts = {}) => {
    bodies.push(JSON.parse(opts.body));
    call++;
    if (call === 1) {
      return {
        ok: false,
        status: 500,
        statusText: 'Server Error',
        headers: { get: () => 'application/json' },
        text: async () => 'streaming not supported',
      };
    }
    return jsonResponse({ choices: [{ message: { content: 'Fallback-Antwort' } }] });
  };

  const result = await AIService.generateReply({
    subject: 'Test',
    recipient: 'a@b.de',
    quotedText: 'Original',
    userText: '',
    isReply: true,
  });

  assert.equal(result.text, 'Fallback-Antwort');
  assert.equal(bodies.length, 2, 'genau ein Retry');
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[1].stream, false, 'Retry muss ohne Streaming laufen');
});

test('listModels: Cache greift, forceRefresh umgeht ihn', async () => {
  reset(BASE_CONFIG);
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return jsonResponse({ data: [{ id: 'm2' }, { id: 'm1' }] });
  };

  assert.deepEqual(await AIService.listModels(), ['m1', 'm2']);
  await AIService.listModels();
  assert.equal(calls, 1, 'zweiter Aufruf muss aus dem Cache kommen');
  await AIService.listModels(true);
  assert.equal(calls, 2, 'forceRefresh muss den Cache umgehen');
});

test('listModels: leere Modell-Liste ist ein Fehler', async () => {
  reset(BASE_CONFIG);
  global.fetch = async () => jsonResponse({ data: [] });
  await assert.rejects(() => AIService.listModels(true), /keine Modelle/);
});

test('listModels: erkennt AnythingLLM-Basis-URL ohne /api/v1/openai automatisch', async () => {
  reset({ baseUrl: 'http://localhost:3001', model: 'my-workspace' });
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(url);
    if (url === 'http://localhost:3001/api/v1/openai/models') {
      return jsonResponse({ data: [{ id: 'my-workspace' }] });
    }
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => 'text/html' },
      text: async () => 'Cannot GET /models',
    };
  };

  const models = await AIService.listModels(true);
  assert.deepEqual(models, ['my-workspace']);
  assert.ok(requestedUrls.includes('http://localhost:3001/models'), 'Basis selbst wird zuerst probiert');

  // Folge-Requests (auch chat/completions) müssen die erkannte Basis nutzen.
  requestedUrls.length = 0;
  global.fetch = async (url, opts = {}) => {
    requestedUrls.push(url);
    return jsonResponse({ choices: [{ message: { content: 'Antwort aus dem Workspace' } }] });
  };
  const result = await AIService.generateReply({
    subject: 'Test',
    recipient: 'a@b.de',
    quotedText: 'Original',
    userText: '',
    isReply: true,
  });
  assert.equal(result.text, 'Antwort aus dem Workspace');
  assert.equal(requestedUrls[0], 'http://localhost:3001/api/v1/openai/chat/completions');
});

test('generateReply: 404 auf /chat/completions stößt Pfad-Erkennung an', async () => {
  reset({ baseUrl: 'http://localhost:3001', model: 'my-workspace' });
  const postUrls = [];
  global.fetch = async (url, opts = {}) => {
    const isPost = opts.method === 'POST';
    if (isPost) postUrls.push(url);
    if (url === 'http://localhost:3001/api/v1/openai/models') {
      return jsonResponse({ data: [{ id: 'my-workspace' }] });
    }
    if (url === 'http://localhost:3001/api/v1/openai/chat/completions') {
      return jsonResponse({ choices: [{ message: { content: 'Antwort nach Auto-Korrektur' } }] });
    }
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => 'text/html' },
      text: async () => `Cannot ${isPost ? 'POST' : 'GET'} ${url}`,
    };
  };

  const result = await AIService.generateReply({
    subject: 'Test',
    recipient: 'a@b.de',
    quotedText: 'Original',
    userText: '',
    isReply: true,
  });

  assert.equal(result.text, 'Antwort nach Auto-Korrektur');
  assert.deepEqual(postUrls, [
    'http://localhost:3001/chat/completions',
    'http://localhost:3001/api/v1/openai/chat/completions',
  ]);
});

test('generateReply: 500 vom OpenAI-Endpunkt → Fallback auf native AnythingLLM-API (Streaming)', async () => {
  reset({ baseUrl: 'http://localhost:3001/api/v1/openai', model: 'arbeit' });
  const postUrls = [];
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') postUrls.push(url);
    if (url.endsWith('/v1/workspace/arbeit/stream-chat')) {
      return sseResponse([
        JSON.stringify({ type: 'textResponseChunk', textResponse: 'Hallo ', close: false }),
        JSON.stringify({ type: 'textResponseChunk', textResponse: 'Welt', close: true }),
      ]);
    }
    // OpenAI-kompatibler Endpunkt: 500 mit leerem Body (AnythingLLM-typisch)
    return {
      ok: false,
      status: 500,
      statusText: '',
      headers: { get: () => 'application/json' },
      text: async () => '',
    };
  };

  const partials = [];
  const result = await AIService.generateReply({
    subject: 'Test',
    recipient: 'a@b.de',
    quotedText: 'Original',
    userText: '',
    isReply: true,
    onToken: (text) => partials.push(text),
  });

  assert.equal(result.text, 'Hallo Welt');
  assert.ok(partials.includes('Hallo Welt'));
  assert.deepEqual(postUrls, [
    'http://localhost:3001/api/v1/openai/chat/completions',
    'http://localhost:3001/api/v1/openai/chat/completions',
    'http://localhost:3001/api/v1/workspace/arbeit/stream-chat',
  ]);
});

test('generateReply: nativer AnythingLLM-Fallback ohne Streaming (extraParams stream:false)', async () => {
  reset({
    baseUrl: 'http://localhost:3001/api/v1/openai',
    model: 'arbeit',
    extraParams: '{"stream": false}',
  });
  const postUrls = [];
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') postUrls.push(url);
    if (url.endsWith('/v1/workspace/arbeit/stream-chat')) {
      return sseResponse([
        JSON.stringify({ type: 'textResponseChunk', textResponse: 'Aus nativer API', close: true }),
      ]);
    }
    if (url.endsWith('/v1/workspace/arbeit/chat')) {
      return jsonResponse({
        id: 'x',
        type: 'textResponse',
        textResponse: 'Aus nativer API',
        close: true,
        error: null,
      });
    }
    return {
      ok: false,
      status: 500,
      statusText: '',
      headers: { get: () => 'application/json' },
      text: async () => '',
    };
  };

  const result = await AIService.generateReply({
    subject: 'Test',
    recipient: 'a@b.de',
    quotedText: 'Original',
    userText: '',
    isReply: true,
    onToken: (text) => {},
  });

  assert.equal(result.text, 'Aus nativer API');
  assert.equal(postUrls[0], 'http://localhost:3001/api/v1/openai/chat/completions');
  assert.ok(
    postUrls[1].includes('/v1/workspace/arbeit/'),
    'zweiter Request muss an die native Workspace-API gehen'
  );
});

test('runPeriodicHealthCheck: Modell wird nach erfolglosem Failover wiederhergestellt', async () => {
  reset({
    ...BASE_CONFIG,
    model: 'haupt-modell',
    healthCheckEnabled: true,
    failoverEnabled: true,
    failoverModels: 'fb-1, fb-2',
  });
  global.fetch = async () => {
    throw new Error('backend down');
  };

  const result = await AIService.runPeriodicHealthCheck();
  assert.equal(result.ok, false);
  assert.equal(result.failoverFailed, true);
  assert.equal(configStore['ai-reply-drafts.model'], 'haupt-modell');
});

test('checkForUpdates: findet neue stabile Version, ignoriert Prerelease auf stable-Kanal', async () => {
  reset({ ...BASE_CONFIG, autoUpdateEnabled: true, autoUpdateChannel: 'stable' });
  global.fetch = async () =>
    jsonResponse([
      {
        tag_name: 'v99.0.0-prerelease',
        prerelease: true,
        draft: false,
        assets: [],
        body: '',
        html_url: '',
        published_at: '',
      },
      {
        tag_name: 'v99.0.0',
        prerelease: false,
        draft: false,
        assets: [{ name: 'ai-reply-drafts.zip', browser_download_url: 'http://example/zip' }],
        body: 'Release Notes',
        html_url: 'http://example/release',
        published_at: '2026-01-01T00:00:00Z',
      },
    ]);

  const result = await AIService.checkForUpdates(true);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.version, '99.0.0', 'Prerelease muss auf stable-Kanal übersprungen werden');
  assert.equal(result.downloadUrl, 'http://example/zip');
});

test('pendingUpdateVersion: räumt veraltete Update-Hinweise auf', () => {
  // Hinweis auf eine bereits installierte (oder ältere) Version → weg damit
  reset({ autoUpdateAvailableVersion: '0.0.1', autoUpdateReleaseNotes: 'alt' });
  assert.equal(AIService.pendingUpdateVersion(), '');
  assert.equal(configStore['ai-reply-drafts.autoUpdateAvailableVersion'], '');
  assert.equal(configStore['ai-reply-drafts.autoUpdateReleaseNotes'], '');

  // Hinweis auf eine echte neuere Version bleibt bestehen
  reset({ autoUpdateAvailableVersion: '99.0.0' });
  assert.equal(AIService.pendingUpdateVersion(), '99.0.0');
  assert.equal(configStore['ai-reply-drafts.autoUpdateAvailableVersion'], '99.0.0');
});

test('checkForUpdates: aktuelle Version → kein Update', async () => {
  reset({ ...BASE_CONFIG, autoUpdateEnabled: true, autoUpdateChannel: 'stable' });
  global.fetch = async () =>
    jsonResponse([
      { tag_name: 'v0.0.1', prerelease: false, draft: false, assets: [], body: '', html_url: '', published_at: '' },
    ]);

  const result = await AIService.checkForUpdates(true);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.reason, 'up-to-date');
});

test('parsedExtraParams via generateReply: ungültiges JSON wird klar gemeldet', async () => {
  reset({ ...BASE_CONFIG, extraParams: '{kaputt' });
  await assert.rejects(
    () =>
      AIService.generateReply({
        subject: 'Test',
        recipient: 'a@b.de',
        quotedText: 'x',
        userText: '',
        isReply: true,
      }),
    /kein gültiges JSON/
  );
});
