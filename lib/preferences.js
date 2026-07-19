/* global AppEnv */

const { React } = require('mailspring-exports');
const AIService = require('./ai-service');
const { version: PLUGIN_VERSION } = require('../package.json');

const e = React.createElement;

// Validation helpers
const VALIDATION_DELAY = 500; // ms debounce

function validateUrl(url) {
  if (!url.trim()) return { valid: false, message: 'Basis-URL ist erforderlich' };
  try {
    const u = new URL(url.trim());
    if (!['http:', 'https:'].includes(u.protocol)) return { valid: false, message: 'Nur http:// oder https:// erlaubt' };
    return { valid: true };
  } catch {
    return { valid: false, message: 'Ungültiges URL-Format (z.B. http://localhost:4000/v1)' };
  }
}

function validateJson(jsonStr) {
  if (!jsonStr.trim()) return { valid: true };
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed !== 'object') return { valid: false, message: 'Muss ein JSON-Objekt sein' };
    return { valid: true };
  } catch (e) {
    return { valid: false, message: `Ungültiges JSON: ${e.message}` };
  }
}

function validateModel(model, models) {
  if (!model.trim()) return { valid: false, message: 'Modell auswählen oder eingeben' };
  if (models && models.length && !models.includes(model)) {
    return { valid: false, message: 'Modell nicht in geladener Liste — Tippfehler oder manuell eingeben?' };
  }
  return { valid: true };
}

const FIELDS = [
  {
    key: 'baseUrl',
    label: 'Basis-URL',
    type: 'text',
    placeholder: 'z.B. http://localhost:4000/v1 (LiteLLM) oder http://localhost:11434/v1 (Ollama)',
    help: 'OpenAI-kompatibler Endpunkt ohne /chat/completions am Ende.',
  },
  {
    key: 'apiKey',
    label: 'API-Key',
    type: 'password',
    placeholder: 'Optional; wird als Authorization: Bearer *** gesendet',
    help: 'Kann leer bleiben, wenn das Backend keinen Key verlangt (z.B. lokale Ollama).',
  },
  {
    key: 'model',
    label: 'Modell',
    type: 'text',
    placeholder: 'Wird nach "Modelle laden" befüllt',
    help: 'Hängt deine Wissensdatenbank am Modell, wähle einfach dessen Namen. Das Laden der Liste prüft zugleich Basis-URL und API-Key.',
  },
  {
    key: 'systemPrompt',
    label: 'System-Prompt',
    type: 'textarea',
    placeholder: 'Du bist ein E-Mail-Assistent. Formuliere Antworten professionell und höflich...',
    help: 'Stil-/Inhaltsanweisungen für die generierten Antworten. Wird immer mitgesendet und übersteuert damit ggf. backend-seitig konfigurierte Prompts (z.B. den Workspace-Prompt von AnythingLLM) — so verhält sich das Plugin bei jedem Provider gleich.',
  },
  {
    key: 'replyLanguage',
    label: 'Antwortsprache erzwingen',
    type: 'select',
    options: [
      { value: '', label: 'Automatisch (wie Original-E-Mail)' },
      { value: 'Deutsch', label: 'Deutsch' },
      { value: 'English', label: 'English' },
      { value: 'Français', label: 'Français' },
      { value: 'Español', label: 'Español' },
      { value: 'Italiano', label: 'Italienisch' },
    ],
    help: 'Erzwingt die Sprache der generierten E-Mail — nützlich bei gemischtsprachigen Threads, bei denen die automatische Erkennung unzuverlässig ist.',
  },
  {
    key: 'extraParams',
    label: 'Zusätzliche Request-Parameter (JSON)',
    type: 'textarea',
    placeholder: '{"temperature": 0.7, "files": [{"type": "collection", "id": "…"}]}',
    help: 'Wird in den Request-Body gemischt — z.B. für Open-WebUI-Wissensdatenbanken (files) oder Sampling-Parameter. Leer lassen, wenn nicht benötigt.',
  },
  {
    key: 'includeAttachments',
    label: 'Anhänge als Kontext mitsenden',
    type: 'checkbox',
    help:
      'Wenn aktiviert, werden Dateiname und Typ der Anhänge als Kontext an das Modell ' +
      'gesendet (max 5 MB pro Anhang, max 3 Anhänge). Inhaltliche Auswertung übernimmt ' +
      'das Backend (z.B. über RAG / zusätzliche Request-Parameter).',
  },
  {
    key: 'shortcutKey',
    label: 'Tastenkürzel',
    type: 'text',
    placeholder: 'Strg+Umschalt+G (Standard)',
    help:
      'Tastenkürzel zum Öffnen/Generieren. Format: Strg/Umschalt/Alt + Taste. ' +
      'Beispiele: Strg+Umschalt+G, Alt+Enter, Strg+Leertaste. Leer = Standard.',
  },
  {
    key: 'healthCheckEnabled',
    label: 'Periodischer Health-Check',
    type: 'checkbox',
    help: 'Prüft alle 5 Minuten die Verbindung zum Backend. Bei Fehlschlag zeigt das Panel einen Hinweis.',
  },
  {
    key: 'failoverEnabled',
    label: 'Auto-Failover bei Verbindungsfehler',
    type: 'checkbox',
    help: 'Wenn Health-Check fehlschlägt, wird automatisch das nächste Modell aus der Fallback-Liste probiert.',
  },
  {
    key: 'failoverModels',
    label: 'Fallback-Modelle (komma-getrennt)',
    type: 'text',
    placeholder: 'gpt-4o-mini, claude-3.5-haiku, gemini-1.5-flash',
    help: 'Reihenfolge der Modelle für Auto-Failover. Werden nacheinander probiert, wenn das Hauptmodell nicht antwortet.',
  },
  {
    key: 'autoUpdateEnabled',
    label: 'Automatische Update-Prüfung',
    type: 'checkbox',
    help: 'Prüft täglich auf neue Plugin-Versionen auf GitHub.',
  },
  {
    key: 'autoUpdateChannel',
    label: 'Update-Kanal',
    type: 'select',
    options: [
      { value: 'stable', label: 'Stable (nur stabile Releases)' },
      { value: 'prerelease', label: 'Prerelease (inkl. Beta/RC)' },
    ],
    help: 'Welche Release-Art installiert werden soll.',
  },
  {
    key: 'autoUpdateCheckInterval',
    label: 'Prüfintervall (Stunden)',
    type: 'number',
    placeholder: '24',
    help: 'Wie oft (in Stunden) nach Updates gesucht wird. Minimum 1 Stunde.',
    // Gespeichert wird in Millisekunden, angezeigt in Stunden.
    toDisplay: (ms) => Math.max(1, Math.round((Number(ms) || 24 * 60 * 60 * 1000) / (60 * 60 * 1000))),
    fromInput: (hours) => Math.max(1, Number(hours) || 24) * 60 * 60 * 1000,
  },
];

class AiDraftPreferences extends React.Component {
  constructor(props) {
    super(props);
    const state = {};
    for (const f of FIELDS) state[f.key] = AIService.getConfig(f.key);
    state.autoGenerate = AIService.getConfig('autoGenerate');
    state.sendThreadContext = AIService.getConfig('sendThreadContext');
    state.model = AIService.getConfig('model');
    state.models = null; // null = noch nicht geladen
    state.modelsStatus = 'idle'; // idle | loading | done | error
    state.modelsError = null;
    state.manualModel = false;
    // Validation state
    state.validation = {
      baseUrl: { valid: true, message: '' },
      extraParams: { valid: true, message: '' },
      model: { valid: true, message: '' },
    };
    state.validationTimeouts = {};
    // Attachments config
    state.includeAttachments = AIService.getConfig('includeAttachments');
    state.shortcutKey = AIService.getConfig('shortcutKey');
    // Health check config
    state.healthCheckEnabled = AIService.getConfig('healthCheckEnabled');
    state.failoverEnabled = AIService.getConfig('failoverEnabled');
    state.failoverModels = AIService.getConfig('failoverModels');
    // Auto-Updater config
    state.autoUpdateEnabled = AIService.getConfig('autoUpdateEnabled');
    state.autoUpdateChannel = AIService.getConfig('autoUpdateChannel');
    state.autoUpdateCheckInterval = AIService.getConfig('autoUpdateCheckInterval');
    state.autoUpdateAvailableVersion = AIService.getConfig('autoUpdateAvailableVersion');
    state.autoUpdateReleaseNotes = AIService.getConfig('autoUpdateReleaseNotes');
    this.state = state;
    this._mounted = false;
    this._fileInput = null;
  }

  componentDidMount() {
    this._mounted = true;
    if (AIService.getConfig('baseUrl').trim()) {
      this._loadModels();
    }
    // Initial validation
    this._validateField('baseUrl', AIService.getConfig('baseUrl'));
    this._validateField('extraParams', AIService.getConfig('extraParams'));
    this._validateField('model', AIService.getConfig('model'));
  }

  componentWillUnmount() {
    this._mounted = false;
    // Clear any pending validation timeouts
    Object.values(this.state.validationTimeouts || {}).forEach(t => clearTimeout(t));
  }

  _onChange = (key, value) => {
    AIService.setConfig(key, value);
    this.setState({ [key]: value });
    this._validateField(key, value);
  };

  _validateField = (key, value) => {
    const existingTimeout = this.state.validationTimeouts?.[key];
    if (existingTimeout) clearTimeout(existingTimeout);

    const timeout = setTimeout(() => {
      let result = { valid: true, message: '' };
      if (key === 'baseUrl') result = validateUrl(value);
      else if (key === 'extraParams') result = validateJson(value);
      else if (key === 'model') result = validateModel(value, this.state.models);

      if (this._mounted) {
        this.setState({
          validation: { ...this.state.validation, [key]: result },
        });
      }
    }, VALIDATION_DELAY);

    this.setState({
      validationTimeouts: { ...this.state.validationTimeouts, [key]: timeout },
    });
  };

  _loadModels = async (forceRefresh = false) => {
    if (!this._mounted) return;
    this.setState({ modelsStatus: 'loading', modelsError: null });
    try {
      const models = await AIService.listModels(forceRefresh);
      if (this._mounted) {
        this.setState({ models, modelsStatus: 'done', modelsError: null, manualModel: false });
        // Re-validate model against new list
        this._validateField('model', this.state.model);
      }
    } catch (err) {
      if (this._mounted) {
        this.setState({ modelsStatus: 'error', modelsError: err.message, models: null });
      }
    }
  };

  _onModelChange = (event) => {
    const value = event.target.value;
    this.setState({ model: value, manualModel: true });
    this._validateField('model', value);
  };

  _renderModelField = () => {
    const { models, modelsStatus, modelsError, model, manualModel } = this.state;
    const validation = this.state.validation?.model;
    const showError = validation && !validation.valid;

    let input;
    if (models && models.length > 0) {
      input = e(
        'select',
        {
          value: model,
          onChange: this._onModelChange,
          style: { flex: 1, minWidth: 0 },
        },
        e('option', { value: '', disabled: !manualModel }, manualModel ? '— Modell manuell eingeben —' : '— Modell auswählen —'),
        models.map((m) => e('option', { key: m, value: m }, m))
      );
    } else {
      input = e('input', {
        type: 'text',
        value: model,
        onChange: this._onModelChange,
        placeholder: manualModel ? 'Modellname manuell eingeben' : 'Erst "Modelle laden" klicken',
        style: { flex: 1, minWidth: 0 },
      });
    }

    return e(
      'div',
      { className: 'ai-pref-field', key: 'model' },
      e('label', {}, 'Modell'),
      e(
        'div',
        { className: 'ai-pref-model-row' },
        input,
        e(
          'button',
          {
            className: 'btn',
            disabled: modelsStatus === 'loading',
            onClick: () => this._loadModels(true),
            title: modelsStatus === 'loading' ? 'Lädt...' : 'Modelle neu laden / Verbindung testen',
          },
          modelsStatus === 'loading' ? '⏳ Lädt…' : '🔄 Modelle laden'
        )
      ),
      showError ? e('div', { className: 'ai-pref-validation-error' }, validation.message) : null,
      modelsStatus === 'error' ? e('div', { className: 'ai-pref-status ai-pref-status-error' }, `Fehler: ${modelsError}`) : null,
      modelsStatus === 'done' && models && models.length > 0 ? e('div', { className: 'ai-pref-status ai-pref-status-ok' }, `${models.length} Modelle gefunden`) : null,
      e('div', { className: 'ai-pref-help' }, 'Hängt deine Wissensdatenbank am Modell, wähle einfach dessen Namen. Das Laden der Liste prüft zugleich Basis-URL und API-Key.')
    );
  };

  // Update prüfen, installieren und Reload anbieten — genutzt von beiden
  // Update-Buttons im Updater-Abschnitt.
  _runUpdate = async () => {
    const result = await AIService.checkForUpdates(true);
    if (result.updateAvailable && result.downloadUrl) {
      const dl = await AIService.downloadAndInstallUpdate(result.downloadUrl);
      if (dl.success && dl.installed) {
        this.setState({ autoUpdateAvailableVersion: '', autoUpdateReleaseNotes: '' });
        const reloadNow = window.confirm(
          `${dl.message}\n\nMailspring jetzt neu laden? (Offene Entwürfe bleiben erhalten.)`
        );
        if (reloadNow && typeof AppEnv !== 'undefined' && typeof AppEnv.reload === 'function') {
          AppEnv.reload();
        }
      } else if (dl.success) {
        alert(dl.message);
      } else {
        alert(`Download fehlgeschlagen: ${dl.error}`);
      }
    } else {
      this.setState({ autoUpdateAvailableVersion: '', autoUpdateReleaseNotes: '' });
      alert(
        result.reason === 'up-to-date'
          ? 'Bereits auf dem neuesten Stand.'
          : `Kein Update: ${result.reason}${result.error ? ' — ' + result.error : ''}`
      );
    }
  };

  _exportConfig = () => {
    // Bewusst ohne apiKey — der Export soll gefahrlos teil- und synchronisierbar sein.
    const configKeys = [
      'baseUrl',
      'model',
      'systemPrompt',
      'autoGenerate',
      'sendThreadContext',
      'extraParams',
      'replyLanguage',
      'includeAttachments',
      'shortcutKey',
      'healthCheckEnabled',
      'failoverEnabled',
      'failoverModels',
      'autoUpdateEnabled',
      'autoUpdateChannel',
      'autoUpdateCheckInterval',
    ];
    const exportObj = {};
    for (const key of configKeys) {
      exportObj[key] = AIService.getConfig(key);
    }
    exportObj._meta = {
      plugin: 'ai-reply-drafts',
      version: PLUGIN_VERSION,
      exportedAt: new Date().toISOString(),
    };
    const json = JSON.stringify(exportObj, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-reply-drafts-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  _importConfig = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        let importedCount = 0;
        for (const [key, value] of Object.entries(imported)) {
          if (key === '_meta') continue;
          if (FIELDS.some(f => f.key === key) ||
              ['autoGenerate', 'sendThreadContext'].includes(key)) {
            AIService.setConfig(key, value);
            importedCount++;
          }
        }
        // Reload state
        const newState = {};
        for (const f of FIELDS) newState[f.key] = AIService.getConfig(f.key);
        newState.autoGenerate = AIService.getConfig('autoGenerate');
        newState.sendThreadContext = AIService.getConfig('sendThreadContext');
        newState.model = AIService.getConfig('model');
        newState.includeAttachments = AIService.getConfig('includeAttachments');
        newState.shortcutKey = AIService.getConfig('shortcutKey');
        newState.healthCheckEnabled = AIService.getConfig('healthCheckEnabled');
        newState.failoverEnabled = AIService.getConfig('failoverEnabled');
        newState.failoverModels = AIService.getConfig('failoverModels');
        newState.autoUpdateEnabled = AIService.getConfig('autoUpdateEnabled');
        newState.autoUpdateChannel = AIService.getConfig('autoUpdateChannel');
        newState.autoUpdateCheckInterval = AIService.getConfig('autoUpdateCheckInterval');
        newState.autoUpdateAvailableVersion = AIService.getConfig('autoUpdateAvailableVersion');
        newState.autoUpdateReleaseNotes = AIService.getConfig('autoUpdateReleaseNotes');
        if (this._mounted) this.setState(newState);
        alert(`Konfiguration importiert — ${importedCount} Einstellungen übernommen.`);
      } catch (err) {
        alert(`Import fehlgeschlagen: ${err.message}`);
      }
      event.target.value = '';
    };
    reader.readAsText(file);
  };

  _renderField(field) {
    const value = this.state[field.key] || '';
    const validation = this.state.validation?.[field.key];
    const showError = validation && !validation.valid;

    if (field.type === 'checkbox') {
      return e(
        'div',
        { className: 'ai-pref-field ai-pref-checkbox', key: field.key },
        e('label', {}, [
          e('input', {
            key: 'cb',
            type: 'checkbox',
            checked: !!this.state[field.key],
            onChange: (event) => this._onChange(field.key, event.target.checked),
          }),
          ` ${field.label}`,
        ]),
        field.help ? e('div', { className: 'ai-pref-help' }, field.help) : null
      );
    }

    let shared = {
      value,
      onChange: (event) => this._onChange(field.key, event.target.value),
      placeholder: field.placeholder,
      title: field.help,
    };

    let input;
    if (field.type === 'textarea') {
      input = e('textarea', Object.assign({}, shared, { rows: 4 }));
    } else if (field.type === 'select') {
      input = e(
        'select',
        Object.assign({}, shared),
        field.options.map((opt) => e('option', { key: opt.value, value: opt.value }, opt.label))
      );
    } else if (field.type === 'password') {
      shared.type = 'password';
      input = e('input', Object.assign({}, shared));
    } else if (field.type === 'number') {
      shared.type = 'number';
      shared.min = field.min ?? 1;
      // Felder mit abweichender Anzeige-Einheit (z.B. Stunden statt ms).
      if (field.toDisplay) shared.value = field.toDisplay(this.state[field.key]);
      if (field.fromInput) {
        shared.onChange = (event) => this._onChange(field.key, field.fromInput(event.target.value));
      }
      input = e('input', Object.assign({}, shared));
    } else {
      input = e('input', Object.assign({ type: field.type }, shared));
    }

    return e(
      'div',
      { className: 'ai-pref-field', key: field.key },
      e('label', {}, field.label),
      e(
        'div',
        { className: 'ai-pref-input-wrapper' },
        input,
        showError ? e('div', { className: 'ai-pref-validation-error' }, validation.message) : null
      ),
      field.help ? e('div', { className: 'ai-pref-help' }, field.help) : null
    );
  }

  render() {
    return e(
      'div',
      { className: 'ai-reply-drafts-preferences' },
      e(
        'div',
        { className: 'ai-pref-header-row' },
        e(
          'h2',
          {},
          'AI Reply Drafts',
          e('span', { className: 'ai-pref-version' }, `v${PLUGIN_VERSION}`)
        ),
        e(
          'div',
          { className: 'ai-pref-export-import' },
          e(
            'button',
            {
              className: 'btn',
              onClick: () => this._exportConfig(),
              title: 'Konfiguration als JSON exportieren (ohne API-Key)',
            },
            '⬇ Exportieren'
          ),
          e(
            'input',
            {
              type: 'file',
              accept: '.json',
              style: { display: 'none' },
              ref: (el) => { this._fileInput = el; },
              onChange: (event) => this._importConfig(event),
            }
          ),
          e(
            'button',
            {
              className: 'btn',
              onClick: () => { if (this._fileInput) this._fileInput.click(); },
              title: 'Konfiguration aus JSON-Datei importieren',
            },
            '⬆ Importieren'
          )
        )
      ),
      e(
        'div',
        { className: 'ai-pref-field ai-pref-checkbox' },
        e('label', {}, [
          e('input', {
            key: 'cb',
            type: 'checkbox',
            checked: !!this.state.autoGenerate,
            onChange: (event) => this._onChange('autoGenerate', event.target.checked),
          }),
          ' Vorschlag beim Antworten automatisch generieren',
        ]),
        e(
          'div',
          { className: 'ai-pref-help' },
          'Wenn deaktiviert, erscheint stattdessen ein Button "KI-Antwort generieren" im Composer.'
        )
      ),
      e(
        'div',
        { className: 'ai-pref-field ai-pref-checkbox' },
        e('label', {}, [
          e('input', {
            key: 'cb',
            type: 'checkbox',
            checked: !!this.state.sendThreadContext,
            onChange: (event) => this._onChange('sendThreadContext', event.target.checked),
          }),
          ' Kompletten E-Mail-Verlauf als Kontext senden',
        ]),
        e(
          'div',
          { className: 'ai-pref-help' },
          'Lädt die letzten 10 Nachrichten des Threads aus der Mailspring-Datenbank und sendet ' +
            'sie chronologisch an die API (max. 15.000 Zeichen, neueste zuerst priorisiert). ' +
            'Wenn deaktiviert, wird nur der zitierte Text aus dem Entwurf gesendet.'
        )
      ),
      e(
        'div',
        { className: 'ai-pref-field ai-pref-checkbox' },
        e('label', {}, [
          e('input', {
            key: 'cb',
            type: 'checkbox',
            checked: !!this.state.includeAttachments,
            onChange: (event) => this._onChange('includeAttachments', event.target.checked),
          }),
          ' Anhänge als Kontext mitsenden',
        ]),
        e(
          'div',
          { className: 'ai-pref-help' },
          'Wenn aktiviert, werden Dateiname und Typ der Anhänge als Kontext an das Modell ' +
            'gesendet (max 5 MB pro Anhang, max 3 Anhänge). Inhaltliche Auswertung übernimmt ' +
            'das Backend (z.B. über RAG / zusätzliche Request-Parameter).'
        )
      ),
      FIELDS.filter((f) => ['baseUrl', 'apiKey'].includes(f.key)).map((f) =>
        this._renderField(f)
      ),
      this._renderModelField(),
      // includeAttachments hat oben eine eigene Checkbox, die Updater-Felder
      // stehen im eigenen Abschnitt weiter unten — hier nicht doppelt rendern.
      FIELDS.filter(
        (f) =>
          ![
            'baseUrl',
            'apiKey',
            'model',
            'includeAttachments',
            'autoUpdateEnabled',
            'autoUpdateChannel',
            'autoUpdateCheckInterval',
          ].includes(f.key)
      ).map((f) => this._renderField(f)),
      // Auto-Updater Section
      e('hr', { style: { margin: '20px 0', borderColor: 'var(--ai-draft-border)' } }),
      e('h3', { style: { marginBottom: '12px', color: 'var(--ai-draft-text)' } }, '🔄 Automatische Updates'),
      e(
        'div',
        { className: 'ai-pref-field ai-pref-checkbox' },
        e('label', {}, [
          e('input', {
            key: 'cb',
            type: 'checkbox',
            checked: !!this.state.autoUpdateEnabled,
            onChange: (event) => this._onChange('autoUpdateEnabled', event.target.checked),
          }),
          ' Automatische Update-Prüfung aktivieren',
        ]),
        e('div', { className: 'ai-pref-help' }, 'Prüft regelmäßig GitHub Releases auf neue Plugin-Versionen.')
      ),
      FIELDS.filter(f => ['autoUpdateChannel', 'autoUpdateCheckInterval'].includes(f.key)).map(f => this._renderField(f)),
      // Update-Status Anzeige
      this.state.autoUpdateAvailableVersion ? e(
        'div',
        { className: 'ai-pref-status ai-pref-status-ok', style: { marginTop: '12px', padding: '12px' } },
        e('strong', {}, `✨ Update verfügbar: v${this.state.autoUpdateAvailableVersion}`),
        e('br'),
        e('small', {}, this.state.autoUpdateReleaseNotes?.substring(0, 200) + (this.state.autoUpdateReleaseNotes?.length > 200 ? '...' : '')),
        e('br'),
        e('button', {
          className: 'btn btn-emphasis',
          style: { marginTop: '8px' },
          onClick: () => this._runUpdate(),
        }, 'Jetzt prüfen & installieren')
      ) : null,
      (!this.state.autoUpdateAvailableVersion && this.state.autoUpdateEnabled) ? e(
        'button',
        {
          className: 'btn',
          style: { marginTop: '12px' },
          onClick: () => this._runUpdate(),
        },
        'Jetzt auf Updates prüfen'
      ) : null,
    );
  }
}

AiDraftPreferences.displayName = 'AiDraftPreferences';

module.exports = AiDraftPreferences;