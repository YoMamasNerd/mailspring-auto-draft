# AI Reply Drafts für Mailspring

Generiert automatisch KI-Antwortvorschläge über eine beliebige **OpenAI-kompatible API**
(LiteLLM, Ollama, vLLM, Open WebUI, OpenAI, …), sobald du in Mailspring auf eine E-Mail
antwortest. Der Vorschlag erscheint unterhalb des Composers mit den Aktionen
**Einfügen / Neu generieren / Verwerfen**. Beim Einfügen landet der Text oberhalb von
Signatur und zitiertem Original.

## Installation

Variante A — über die Oberfläche:

1. Mailspring öffnen → **Einstellungen → Plugins → Install Plugin…**
2. Diesen Ordner (`mailspring-auto-draft`) auswählen.

Variante B — manuell:

```bash
# Linux
cp -r . ~/.config/Mailspring/packages/ai-reply-drafts
```

```powershell
# Windows (PowerShell)
Copy-Item -Recurse . "$env:APPDATA\Mailspring\packages\ai-reply-drafts"
```

Der Ordner `packages` muss ggf. vorher angelegt werden. Danach Mailspring neu starten.
Es ist kein Build-Schritt nötig — der Ordner kann 1:1 kopiert werden.

## Konfiguration

Unter **Einstellungen → AI Drafts**:

| Feld | Bedeutung |
|---|---|
| Basis-URL | OpenAI-kompatibler Endpunkt **ohne** `/chat/completions`, z.B. `http://localhost:4000/v1` (LiteLLM) oder `http://localhost:11434/v1` (Ollama) |
| API-Key | Optional; wird als `Authorization: Bearer …` gesendet |
| Modell | Dropdown, wird über `GET {Basis-URL}/models` befüllt („Modelle laden / Verbindung testen“ prüft zugleich URL und API-Key). Falls dein Backend `/models` nicht anbietet, kannst du den Namen manuell eingeben |
| System-Prompt | Stil-/Inhaltsanweisungen für die generierten Antworten. Wird immer mitgesendet und übersteuert damit ggf. backend-seitig konfigurierte Prompts (z.B. den Workspace-Prompt von AnythingLLM) — so verhält sich das Plugin bei jedem Provider gleich |
| Zusätzliche Request-Parameter | JSON, das in den Request-Body gemischt wird |
| Automatisch generieren | Wenn aus, erscheint stattdessen ein Button im Composer |
| E-Mail-Verlauf senden | Lädt die letzten 10 Nachrichten des Threads aus der Mailspring-Datenbank als Kontext (max. 15.000 Zeichen, Zitate dedupliziert). Wenn aus, wird nur das Zitat aus dem Entwurf gesendet |

### Wissensdatenbank / RAG

- **Am Modell verknüpft**: nichts weiter nötig — Modell im Dropdown wählen, fertig.
- **AnythingLLM (empfohlen für Windows, ohne Docker)**: Desktop-App installieren,
  Workspace anlegen, Dokumente hochladen. Dann in den Plugin-Einstellungen:
  - Basis-URL: `http://localhost:3001/api/v1/openai`
  - API-Key: in AnythingLLM unter Einstellungen → Developer-API erzeugen
  - Modell: jeder Workspace erscheint als eigenes „Modell“ im Dropdown
- **Open WebUI**: Basis-URL `http://localhost:3000/api`, API-Key unter
  Einstellungen → Konto. Wissen entweder an ein eigenes Modell hängen
  (Workspace → Modelle) oder als zusätzliche Request-Parameter:

  ```json
  {"files": [{"type": "collection", "id": "DEINE-COLLECTION-ID"}]}
  ```

- Auch Sampling-Parameter wie `{"temperature": 0.4, "max_tokens": 800}` können bei den
  zusätzlichen Request-Parametern gesetzt werden.

## Funktionsweise

- Registriert sich über die `Composer:Footer`-Rolle und erhält `draft` + `session`.
- Erkennt Antworten über `draft.replyToHeaderMessageId`.
- Lädt standardmäßig den Thread-Verlauf über Mailsprings `DatabaseStore` (Zitate werden
  per `QuotedHTMLTransformer` dedupliziert) und sendet ihn zusammen mit Betreff,
  Empfänger und einem evtl. schon getippten Antwort-Anfang an
  `POST {Basis-URL}/chat/completions`. Fallback: das Zitat aus dem Draft-Body.
- Fügt den Vorschlag mit derselben Logik wie Mailsprings internes Templates-Plugin vor
  `<signature>` / `gmail_quote` in den Body ein.

## Hinweise

- Der API-Key liegt — wie bei allen Mailspring-Plugins — **unverschlüsselt** in
  Mailsprings `config.json`.
- Pro Draft wird automatisch nur einmal generiert; weitere Vorschläge über
  „Neu generieren“.
- Timeout pro Anfrage: 90 Sekunden.
