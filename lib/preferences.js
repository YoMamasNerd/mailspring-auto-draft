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
    placeholder: 'optional, wird als Bearer-Token gesendet',
    help: 'Achtung: wird wie bei allen Mailspring-Plugins unverschlüsselt in der config.json gespeichert.',
  },
  {
    key: 'systemPrompt',
    label: 'System-Prompt',
    type: 'textarea',
    rows: 16,
    placeholder: '',
    help:
      'Anweisungen für Stil und Inhalt der generierten Antworten. Hinweis: Ist an dein ' +
      'Backend eine Wissensdatenbank (RAG) angebunden, speist es deren Inhalte automatisch ' +
      'in jede Anfrage ein — du musst hier nicht darauf verweisen. Sinnvoll ist aber eine ' +
      'Regel, wie damit umzugehen ist, z.B.: „Preise, Termine und Abläufe entnimmst du ' +
      'ausschließlich den bereitgestellten Kontextinformationen; erfinde keine Daten.“',
  },
  {
    key: 'replyLanguage',
    label: 'Antwortsprache',
    type: 'select',
    options: [
      { value: '', label: 'Automatisch (Sprache der Original-E-Mail)' },
      { value: 'Deutsch', label: 'Deutsch' },
      { value: 'Englisch', label: 'Englisch' },
      { value: 'Französisch', label: 'Französisch' },
      { value: 'Spanisch', label: 'Spanisch' },
      { value: 'Italienisch', label: 'Italienisch' },
    ],
    help:
      'Erzwingt die Sprache der generierten E-Mail — nützlich bei gemischtsprachigen ' +
      'Threads, bei denen die automatische Erkennung unzuverlässig ist.',
  },
  {
    key: 'extraParams',
    label: 'Zusätzliche Request-Parameter (JSON)',
    type: 'textarea',
    placeholder: '{"temperature": 0.7, "files": [{"type": "collection", "id": "…"}]}',
    help:
      'Wird in den Request-Body gemischt — z.B. für Open-WebUI-Wissensdatenbanken (files) ' +
      'oder Sampling-Parameter. Leer lassen, wenn nicht benötigt.',
  },
  {
    key: 'includeAttachments',
    label: 'Anhänge als Kontext mitsenden (PDF-Text, Bilder)',
    type: 'checkbox',
    help:
      'Wenn aktiviert, werden PDF-Text (via pdf.js) und Bilder (Base64) aus dem Entwurf ' +
      'an das Modell gesendet. Benötigt multimodales Modell (z.B. GPT-4o, Claude, LLaVA). ' +
      'Max 5 MB pro Anhang, max 3 Anhänge.',
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
    this.state = state;
    this._mounted = false;
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

  _onChange(key, value) {
    this.setState({ [key]: value });
    AIService.setConfig(key, value);
    // Debounced validation
    this._debouncedValidate(key, value);
  }

  _debouncedValidate(key, value) {
    const timeouts = { ...this.state.validationTimeouts };
    if (timeouts[key]) clearTimeout(timeouts[key]);
    timeouts[key] = setTimeout(() => {
      this._validateField(key, value);
      // Clean up timeout reference
      const newTimeouts = { ...timeouts };
      delete newTimeouts[key];
      this.setState({ validationTimeouts: newTimeouts });
    }, VALIDATION_DELAY);
    this.setState({ validationTimeouts: timeouts });
  }

  _validateField(key, value) {
    let result = { valid: true, message: '' };
    if (key === 'baseUrl') result = validateUrl(value);
    else if (key === 'extraParams') result = validateJson(value);
    else if (key === 'model') result = validateModel(value, this.state.models);
    this.setState(prev => ({
      validation: { ...prev.validation, [key]: result }
    }));
  }

  _loadModels = (forceRefresh = false) => {
    if (forceRefresh) {
      AIService.invalidateModelCache();
    }
    this.setState({ modelsStatus: 'loading', modelsError: null });
    AIService.listModels()
      .then((models) => {
        if (!this._mounted) return;
        this.setState({ models, modelsStatus: 'done', manualModel: false });
      })
      .catch((err) => {
        if (!this._mounted) return;
        this.setState({ models: null, modelsStatus: 'error', modelsError: err.message });
      });
  };

  _renderModelField() {
    const { model, models, modelsStatus, modelsError, manualModel } = this.state;

    let input;
    if (models && !manualModel) {
      const options = models.includes(model) || !model ? models : [model].concat(models);
      input = e(
        'select',
        {
          value: model || '',
          onChange: (event) => {
            if (event.target.value === '__manual__') {
              this.setState({ manualModel: true });
            } else {
              this._onChange('model', event.target.value);
            }
          },
        },
        !model ? e('option', { key: '', value: '' }, '— Modell wählen —') : null,
        options.map((id) => e('option', { key: id, value: id }, id)),
        e('option', { key: '__manual__', value: '__manual__' }, 'Anderes Modell (manuell eingeben)…')
      );
    } else {
      input = e('input', {
        type: 'text',
        value: model,
        placeholder: 'z.B. gpt-4o, llama3.1, mein-rag-modell',
        onChange: (event) => this._onChange('model', event.target.value),
      });
    }

    let status = null;
    if (modelsStatus === 'loading') {
      status = e('div', { className: 'ai-pref-status' }, 'Modelle werden geladen…');
    } else if (modelsStatus === 'done') {
      status = e(
        'div',
        { className: 'ai-pref-status ai-pref-status-ok' },
        `✓ Verbindung OK — ${models.length} Modelle gefunden`
      );
    } else if (modelsStatus === 'error') {
      status = e('div', { className: 'ai-pref-status ai-pref-status-error' }, `✗ ${modelsError}`);
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
          },
          'Modelle laden / Verbindung testen'
        )
      ),
      status,
      e(
        'div',
        { className: 'ai-pref-help' },
        'Hängt deine Wissensdatenbank am Modell, wähle einfach dessen Namen. ' +
          'Das Laden der Liste prüft zugleich Basis-URL und API-Key.'
      )
    );
  }

  _exportConfig = () => {
    const exportableKeys = FIELDS.map(f => f.key).concat([
      'autoGenerate', 'sendThreadContext', 'includeAttachments'
    ]);
    const config = {};
    for (const key of exportableKeys) {
      const value = AIService.getConfig(key);
      // API-Key niemals exportieren
      if (key === 'apiKey') continue;
      config[key] = value;
    }
    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-reply-drafts-config-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  _importConfig = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const config = JSON.parse(e.target.result);
        // Validieren: nur bekannte Keys akzeptieren
        const allowedKeys = FIELDS.map(f => f.key).concat([
          'autoGenerate', 'sendThreadContext', 'includeAttachments'
        ]);
        let imported = 0;
        for (const [key, value] of Object.entries(config)) {
          if (allowedKeys.includes(key)) {
            AIService.setConfig(key, value);
            this.setState({ [key]: value });
            imported++;
          }
        }
        // Validation neu triggern
        this._validateField('baseUrl', config.baseUrl || '');
        this._validateField('extraParams', config.extraParams || '');
        this._validateField('model', config.model || '');
        // File input zurücksetzen
        if (this._fileInput) this._fileInput.value = '';
        alert(`Import erfolgreich: ${imported} Einstellungen übernommen.`);
      } catch (err) {
        alert(`Import fehlgeschlagen: ${err.message}`);
        if (this._fileInput) this._fileInput.value = '';
      }
    };
    reader.readAsText(file);
  };

  _renderField(field) {
    const shared = {
      value: this.state[field.key],
      placeholder: field.placeholder,
      onChange: (event) => this._onChange(field.key, event.target.value),
    };
    let input;
    if (field.type === 'textarea') {
      input = e('textarea', Object.assign({ rows: field.rows || 5 }, shared));
    } else if (field.type === 'select') {
      input = e(
        'select',
        shared,
        field.options.map((opt) => e('option', { key: opt.value, value: opt.value }, opt.label))
      );
    } else {
      input = e('input', Object.assign({ type: field.type }, shared));
    }

    // Validation message
    const validation = this.state.validation?.[field.key];
    const showError = validation && !validation.valid;

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
          'Wenn deaktiviert, erscheint stattdessen ein Button „KI-Antwort generieren“ im Composer.'
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
          ' Anhänge als Kontext mitsenden (PDF-Text, Bilder)',
        ]),
        e(
          'div',
          { className: 'ai-pref-help' },
          'Wenn aktiviert, werden PDF-Text (via pdf.js) und Bilder (Base64) aus dem Entwurf ' +
            'an das Modell gesendet. Benötigt multimodales Modell (z.B. GPT-4o, Claude, LLaVA). ' +
            'Max 5 MB pro Anhang, max 3 Anhänge.'
        )
      ),
      FIELDS.filter((f) => ['baseUrl', 'apiKey'].includes(f.key)).map((f) =>
        this._renderField(f)
      ),
      this._renderModelField(),
      FIELDS.filter((f) => !['baseUrl', 'apiKey'].includes(f.key)).map((f) =>
        this._renderField(f)
      )
    );
  }
}

AiDraftPreferences.displayName = 'AiDraftPreferences';

module.exports = AiDraftPreferences;