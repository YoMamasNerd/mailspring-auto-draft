# AI Reply Drafts für Mailspring

Generiert KI-Antwortvorschläge oder neue E-Mails über eine beliebige **OpenAI-kompatible API**
(LiteLLM, Ollama, vLLM, Open WebUI, OpenAI, …) direkt in Mailspring.

- **Antworten**: Der Entwurf wird automatisch (optional) oder per Klick generiert und greift auf den vorherigen Verlauf (oder das Zitat) zurück. Eigene Stichpunkte oder Notizen im Antwortfeld werden als inhaltliche Vorgabe verwendet und zu vollständigen Sätzen ausformuliert.
- **Neue E-Mails**: Gib im Composer einfach ein paar Anweisungen oder Stichpunkte ein (z. B. „Schreibe Einladung zu ...“) und klicke auf **✨ KI-Entwurf generieren**, um die vollständige E-Mail schreiben zu lassen. Ist der Betreff noch leer, wird ein Betreffvorschlag mitgeneriert und beim Einfügen übernommen.
- **Streaming**: Der Vorschlag erscheint live Wort für Wort im Panel — kein langes Warten auf die komplette Antwort, Abbrechen jederzeit möglich.
- **Ton-Schnellwahl**: Chips für *Standard / Formell / Locker / Kurz* direkt im Panel, ohne den System-Prompt anzufassen.
- **Verfeinern**: Änderungswunsch eintippen („kürzer“, „erwähne noch …“) — der vorhandene Vorschlag wird gezielt überarbeitet statt neu gewürfelt.
- **Editierbar & Flexibel**: Der Entwurf kann vor dem Einfügen direkt im Composer-Panel bearbeitet werden. Existierender Text kann beim Einfügen wahlweise **ersetzt** (z. B. zum Ersetzen von Stichpunkten) oder der Entwurf **angehängt** werden.
- **Transparenz**: Eine Statuszeile zeigt, welcher Kontext tatsächlich gesendet wurde (Verlauf mit Nachrichtenzahl, Zitat, eigene Stichpunkte).
- **Tastenkürzel**: `Strg/Cmd+Umschalt+G` im Composer startet die Generierung.

## Installation

Variante A — über die Oberfläche:

1. Mailspring öffnen → **Einstellungen → Plugins → Install Plugin…**
2. Diesen Ordner (`mailspring-auto-draft`) auswählen.

Variante B — manuell:

Für Linux:
```bash
mkdir -p ~/.config/Mailspring/packages/ai-reply-drafts
cp -r * ~/.config/Mailspring/packages/ai-reply-drafts/
```

Für macOS:
```bash
mkdir -p ~/Library/Application\ Support/Mailspring/packages/ai-reply-drafts
cp -r * ~/Library/Application\ Support/Mailspring/packages/ai-reply-drafts/
```

Für Windows (PowerShell):
```powershell
mkdir -Force "$env:APPDATA\Mailspring\packages\ai-reply-drafts"
Copy-Item -Recurse -Force * "$env:APPDATA\Mailspring\packages\ai-reply-drafts"
```

Danach Mailspring neu starten.
Es ist kein Build-Schritt nötig — der Ordner kann 1:1 kopiert werden.

## Konfiguration

Unter **Einstellungen → AI Drafts**:

| Feld | Bedeutung |
|---|---|
| Basis-URL | OpenAI-kompatibler Endpunkt **ohne** `/chat/completions`, z.B. `http://localhost:4000/v1` (LiteLLM) oder `http://localhost:11434/v1` (Ollama) |
| API-Key | Optional; wird als `Authorization: Bearer …` gesendet |
| Modell | Dropdown, wird über `GET {Basis-URL}/models` befüllt („Modelle laden / Verbindung testen“ prüft zugleich URL und API-Key). Falls dein Backend `/models` nicht anbietet, kannst du den Namen manuell eingeben |
| System-Prompt | Stil-/Inhaltsanweisungen für die generierten Antworten. Wird immer mitgesendet und übersteuert damit ggf. backend-seitig konfigurierte Prompts (z.B. den Workspace-Prompt von AnythingLLM) — so verhält sich das Plugin bei jedem Provider gleich |
| Antwortsprache | Erzwingt die Sprache der generierten E-Mail (z.B. immer Deutsch). Standard: automatisch, gleiche Sprache wie die Original-E-Mail |
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
- Funktioniert sowohl bei Antworten (Erkennung über `draft.replyToHeaderMessageId`) als auch beim Verfassen neuer E-Mails.
- Lädt bei Antworten standardmäßig den Thread-Verlauf über Mailsprings `DatabaseStore` (Zitate werden
  per `QuotedHTMLTransformer` dedupliziert) und sendet ihn zusammen mit Betreff,
  Empfänger und evtl. schon getipptem eigenem Text (Stichpunkte, Notizen oder ein
  Antwort-Anfang) an `POST {Basis-URL}/chat/completions`. Stichpunkte werden dabei zu
  vollständigen Sätzen ausformuliert. Fallback: das Zitat aus dem Draft-Body.
- Vor jeder Generierung werden ausstehende Editor-Änderungen committet, damit auch
  gerade erst getippter Text sicher im gesendeten Kontext landet.
- Der Name des Absender-Kontos wird mitgesendet, damit Grußformel und Perspektive
  stimmen; bei „Verfeinern“ geht der bisherige Vorschlag als Assistant-Nachricht in
  die Folgeanfrage.
- Antworten streamen per SSE (`stream: true`) live ins Panel. Backends ohne
  Streaming werden automatisch erkannt (JSON-Fallback); mit `{"stream": false}` in
  den zusätzlichen Request-Parametern lässt sich Streaming gezielt abschalten.
- Beim Verfassen einer neuen E-Mail dient der bereits eingetippte Text als direkte Anweisung für die Generierung.
- Der generierte Entwurf kann direkt im Panel angepasst werden (das Vorschaufenster ist editierbar).
- Beim Einfügen hat man die Wahl, den getippten Text zu **ersetzen** (Standard für Anweisungen) oder den neuen Entwurf an den Text **anzuhängen**.
- Fügt den Vorschlag vor `<signature>` / `gmail_quote` in den Body ein.

## Hinweise

- Der API-Key liegt — wie bei allen Mailspring-Plugins — **unverschlüsselt** in
  Mailsprings `config.json`.
- Pro Draft wird automatisch nur einmal generiert; weitere Vorschläge über
  „Neu generieren“.
- Bei aktivierter Auto-Generierung startet die Generierung direkt beim Öffnen des
  Composers — also **bevor** eigene Stichpunkte getippt wurden. Um Stichpunkte
  einfließen zu lassen: erst tippen, dann „Neu generieren“ klicken (oder
  `Strg/Cmd+Umschalt+G`). Beginnt man während der Auto-Generierung zu tippen,
  wird sie automatisch abgebrochen.
- Das Panel lässt sich über seine Kopfzeile einklappen; der Zustand bleibt
  gespeichert.
- Timeout pro Anfrage: 90 Sekunden.
