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

test('alle lib-Module laden ohne Fehler', () => {
  resetConfig();
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
  resetConfig({ ...BASE_CONFIG, includeAttachments: true });
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
  resetConfig(BASE_CONFIG);
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
  resetConfig(BASE_CONFIG);
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
  resetConfig(BASE_CONFIG);
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
  resetConfig(BASE_CONFIG);
  global.fetch = async () => jsonResponse({ data: [] });
  await assert.rejects(() => AIService.listModels(true), /keine Modelle/);
});

test('runPeriodicHealthCheck: Modell wird nach erfolglosem Failover wiederhergestellt', async () => {
  resetConfig({
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
  resetConfig({ ...BASE_CONFIG, autoUpdateEnabled: true, autoUpdateChannel: 'stable' });
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

test('checkForUpdates: aktuelle Version → kein Update', async () => {
  resetConfig({ ...BASE_CONFIG, autoUpdateEnabled: true, autoUpdateChannel: 'stable' });
  global.fetch = async () =>
    jsonResponse([
      { tag_name: 'v0.0.1', prerelease: false, draft: false, assets: [], body: '', html_url: '', published_at: '' },
    ]);

  const result = await AIService.checkForUpdates(true);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.reason, 'up-to-date');
});

test('parsedExtraParams via generateReply: ungültiges JSON wird klar gemeldet', async () => {
  resetConfig({ ...BASE_CONFIG, extraParams: '{kaputt' });
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
