/* global AppEnv */

const { React } = require('mailspring-exports');
const AIService = require('./ai-service');

const e = React.createElement;

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
    key: 'extraParams',
    label: 'Zusätzliche Request-Parameter (JSON)',
    type: 'textarea',
    placeholder: '{"temperature": 0.7, "files": [{"type": "collection", "id": "…"}]}',
    help:
      'Wird in den Request-Body gemischt — z.B. für Open-WebUI-Wissensdatenbanken (files) ' +
      'oder Sampling-Parameter. Leer lassen, wenn nicht benötigt.',
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
    this.state = state;
    this._mounted = false;
  }

  componentDidMount() {
    this._mounted = true;
    if (AIService.getConfig('baseUrl').trim()) {
      this._loadModels();
    }
  }

  componentWillUnmount() {
    this._mounted = false;
  }

  _onChange(key, value) {
    this.setState({ [key]: value });
    AIService.setConfig(key, value);
  }

  _loadModels = () => {
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
            onClick: this._loadModels,
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

  _renderField(field) {
    const shared = {
      value: this.state[field.key],
      placeholder: field.placeholder,
      onChange: (event) => this._onChange(field.key, event.target.value),
    };
    const input =
      field.type === 'textarea'
        ? e('textarea', Object.assign({ rows: field.rows || 5 }, shared))
        : e('input', Object.assign({ type: field.type }, shared));

    return e(
      'div',
      { className: 'ai-pref-field', key: field.key },
      e('label', {}, field.label),
      input,
      field.help ? e('div', { className: 'ai-pref-help' }, field.help) : null
    );
  }

  render() {
    return e(
      'div',
      { className: 'ai-reply-drafts-preferences' },
      e('h2', {}, 'AI Reply Drafts'),
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
