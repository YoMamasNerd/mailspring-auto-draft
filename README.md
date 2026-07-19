# AI Reply Drafts für Mailspring

Generiert KI-Antwortvorschläge oder neue E-Mails über eine beliebige **OpenAI-kompatible API**
(LiteLLM, Ollama, vLLM, Open WebUI, OpenAI, …) direkt in Mailspring.

## Features

| Kategorie | Features |
|---|---|
| **Kernfunktionen** | Antworten & neue E-Mails generieren, Streaming live im Panel, Betreffvorschlag bei neuen Mails |
| **Ton & Stil** | Chips für *Standard / Formell / Locker / Kurz* direkt im Panel |
| **Verfeinern** | Änderungswunsch eintippen („kürzer“, „erwähne noch …“) → gezielte Überarbeitung statt Neuwürfeln |
| **Flexibilität** | Entwurf vor Einfügen editierbar, **Ersetzen** (für Stichpunkte) oder **Anhängen** wählbar |
| **Transparenz** | Statuszeile: welcher Kontext gesendet wurde (Verlauf-Anzahl, Zitat, eigene Stichpunkte) |
| **Tastenkürzel** | `Strg/Cmd+Umschalt+G` (anpassbar in Settings) |

### 🔄 Auto-Updater
- Prüft täglich (konfigurierbar) GitHub Releases auf neue Versionen
- Button „Jetzt auf Updates prüfen“ in den Einstellungen
- Nach Download: Mailspring neu starten → ZIP manuell installieren
- Kanäle: **Stable** oder **Prerelease** (für Beta-Tester)

### 🏥 Health-Check & Auto-Failover
- Periodischer Ping (alle 5 Min, konfigurierbar) an `/models` — **keine Token-Kosten**
- Bei Verbindungsfehler: nächstes Fallback-Modell aus Liste automatisch probieren
- Status-Indikator im Panel: 🟢 verbunden / 🔴 Fehler / 🟡 prüft…

### 🌙 Dark/Light Theme Auto-Detection
- CSS Custom Properties für alle Farben
- Nutzt Mailspring-UI-Variablen als Defaults
- `@media (prefers-color-scheme: dark)` Override für echten Dark Mode

### ↶ Undo/History (3 Vorschläge)
- Letzte 3 generierten Vorschläge per ↶/↷ Buttons im Panel wiederherstellbar

### ⌨️ Anpassbare Keyboard Shortcuts
- Default: `Strg+Umschalt+G`
- In Settings frei definierbar (Format: `Strg+Umschalt+G`, `Alt+Enter`, `Strg+Leertaste` …)
- Tooltip im Panel zeigt aktuelles Kürzel (Mac: ⌘, Win/Linux: Strg)

### 💾 Export/Import Config
- JSON-Backup aller Settings (ohne API-Key)
- Import validiert gegen erlaubte Keys

### 💰 Token-Counter & Cost-Estimate
- Live-Anzeige pro Draft: `≈ 1.2k Tokens · ≈ $0.0004`
- Preise für OpenAI, Anthropic, Google, DeepSeek, kostenlose Modelle ($0) hinterlegt
- Lokale/gratis Modelle = 0

### 📎 Attachment-Kontext
- Dateiname & Typ der Composer-Anhänge werden als Kontext mitgesendet (max 5 MB/Anhang, max 3 Anhänge)
- Checkbox in Settings; inhaltliche RAG-Anbindung läuft backend-seitig (z.B. Open WebUI `files` über die zusätzlichen Request-Parameter)

### ⚡ Model Caching
- `/models`-Liste wird 1h im localStorage gecacht
- Key isoliert pro Provider+BaseURL
- Force-Refresh per „Modelle laden“-Button

### ✅ Config Validation
- Live-Validierung (500ms Debounce) bei URL/JSON/Modell
- Roter Rand + Fehlermeldung, Tooltips via `title`
- „Verbindung testen“-Button prüft kompletten Pfad (URL + Key + `/models`)

## Installation

**Variante A — über die Oberfläche:**
1. Mailspring öffnen → **Einstellungen → Plugins → Install Plugin…**
2. Diesen Ordner (`mailspring-auto-draft`) auswählen.

**Variante B — manuell:**

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

Danach Mailspring neu starten. Es ist kein Build-Schritt nötig — der Ordner kann 1:1 kopiert werden.

## Konfiguration

Unter **Einstellungen → AI Drafts**:

| Feld | Bedeutung |
|---|---|
| Basis-URL | OpenAI-kompatibler Endpunkt **ohne** `/chat/completions`, z.B. `http://localhost:4000/v1` (LiteLLM) oder `http://localhost:11434/v1` (Ollama) |
| API-Key | Optional; wird als `Authorization: Bearer ***` gesendet |
| Modell | Dropdown, wird über `GET {Basis-URL}/models` befüllt („Modelle laden / Verbindung testen“ prüft zugleich URL und API-Key). Falls dein Backend `/models` nicht anbietet, kannst du den Namen manuell eingeben |
| System-Prompt | Stil-/Inhaltsanweisungen für die generierten Antworten. Wird immer mitgesendet und übersteuert damit ggf. backend-seitig konfigurierte Prompts (z.B. den Workspace-Prompt von AnythingLLM) — so verhält sich das Plugin bei jedem Provider gleich |
| Antwortsprache | Erzwingt die Sprache der generierten E-Mail (z.B. immer Deutsch). Standard: automatisch, gleiche Sprache wie die Original-E-Mail |
| Zusätzliche Request-Parameter | JSON, das in den Request-Body gemischt wird |
| Automatisch generieren | Wenn aus, erscheint stattdessen ein Button im Composer |
| E-Mail-Verlauf senden | Lädt die letzten 10 Nachrichten des Threads aus der Mailspring-Datenbank als Kontext (max. 15.000 Zeichen, Zitate dedupliziert). Wenn aus, wird nur das Zitat aus dem Entwurf gesendet |
| **Periodischer Health-Check** | Prüft alle 5 Minuten die Verbindung zum Backend. Bei Fehlschlag zeigt das Panel einen Hinweis |
| **Auto-Failover bei Verbindungsfehler** | Wenn Health-Check fehlschlägt, wird automatisch das nächste Modell aus der Fallback-Liste probiert |
| **Fallback-Modelle (komma-getrennt)** | Reihenfolge der Modelle für Auto-Failover. Werden nacheinander probiert, wenn das Hauptmodell nicht antwortet |
| **Automatische Update-Prüfung** | Prüft täglich auf neue Plugin-Versionen auf GitHub |
| **Update-Kanal** | *Stable* (nur stabile Releases) oder *Prerelease* (inkl. Beta/RC) |
| **Prüfintervall (Stunden)** | Wie oft (in Stunden) nach Updates gesucht wird. Minimum 1 Stunde |

### Wissensdatenbank / RAG

- **Am Modell verknüpft**: nichts weiter nötig — Modell im Dropdown wählen, fertig.
- **AnythingLLM (empfohlen für Windows, ohne Docker)**: Desktop-App installieren, Workspace anlegen, Dokumente hochladen. Dann in den Plugin-Einstellungen:
  - Basis-URL: `http://localhost:3001/api/v1/openai` (unvollständige Angaben wie `http://localhost:3001` korrigiert das Plugin automatisch, sobald es 404 erhält)
  - API-Key: in AnythingLLM unter Einstellungen → Developer-API erzeugen (**Pflicht**, sonst 401/403)
  - Modell: jeder Workspace erscheint als eigenes „Modell“ im Dropdown — der Wert ist der **Workspace-Slug**; ein frei getippter Anzeigename führt zu einem 401-Fehler bei der Generierung
- **Open WebUI**: Basis-URL `http://localhost:3000/api`, API-Key unter Einstellungen → Konto. Wissen entweder an ein eigenes Modell hängen (Workspace → Modelle) oder als zusätzliche Request-Parameter:
  ```json
  {"files": [{"type": "collection", "id": "DEINE-COLLECTION-ID"}]}
  ```
- Auch Sampling-Parameter wie `{"temperature": 0.4, "max_tokens": 800}` können bei den zusätzlichen Request-Parametern gesetzt werden.

## Funktionsweise

- Registriert sich über die `Composer:Footer`-Rolle und erhält `draft` + `session`.
- Funktioniert sowohl bei Antworten (Erkennung über `draft.replyToHeaderMessageId`) als auch beim Verfassen neuer E-Mails.
- Lädt bei Antworten standardmäßig den Thread-Verlauf über Mailsprings `DatabaseStore` (Zitate werden per `QuotedHTMLTransformer` dedupliziert) und sendet ihn zusammen mit Betreff, Empfänger und evtl. schon getipptem eigenem Text (Stichpunkte, Notizen oder ein Antwort-Anfang) an `POST {Basis-URL}/chat/completions`. Stichpunkte werden dabei zu vollständigen Sätzen ausformuliert. Fallback: das Zitat aus dem Draft-Body.
- Vor jeder Generierung werden ausstehende Editor-Änderungen committet, damit auch gerade erst getippter Text sicher im gesendeten Kontext landet.
- Der Name des Absender-Kontos wird mitgesendet, damit Grußformel und Perspektive stimmen; bei „Verfeinern“ geht der bisherige Vorschlag als Assistant-Nachricht in die Folgeanfrage.
- Antworten streamen per SSE (`stream: true`) live ins Panel. Backends ohne Streaming werden automatisch erkannt (JSON-Fallback); antwortet ein Backend auf die Streaming-Anfrage mit einem Fehler oder einem unlesbaren Stream, wird automatisch einmal ohne Streaming nachgefragt. Mit `{"stream": false}` in den zusätzlichen Request-Parametern lässt sich Streaming dauerhaft abschalten.
- Beim Verfassen einer neuen E-Mail dient der bereits eingetippte Text als direkte Anweisung für die Generierung.
- Der generierte Entwurf kann direkt im Panel angepasst werden (das Vorschaufenster ist editierbar).
- Beim Einfügen hat man die Wahl, den getippten Text zu **ersetzen** (Standard für Anweisungen) oder den neuen Entwurf an den Text **anzuhängen**.
- Fügt den Vorschlag vor `<signature>` / `gmail_quote` in den Body ein.

## Hinweise

- Der API-Key liegt — wie bei allen Mailspring-Plugins — **unverschlüsselt** in Mailsprings `config.json`.
- Pro Draft wird automatisch nur einmal generiert; weitere Vorschläge über „Neu generieren“.
- Bei aktivierter Auto-Generierung startet die Generierung direkt beim Öffnen des Composers — also **bevor** eigene Stichpunkte getippt wurden. Um Stichpunkte einfließen zu lassen: erst tippen, dann „Neu generieren“ klicken (oder `Strg/Cmd+Umschalt+G`). Beginnt man während der Auto-Generierung zu tippen, wird sie automatisch abgebrochen.
- Das Panel lässt sich über seine Kopfzeile einklappen; der Zustand bleibt gespeichert.
- Timeout pro Anfrage: 90 Sekunden.
- **„Cannot POST /chat/completions“ / 404**: Die Basis-URL zeigt nicht auf den OpenAI-kompatiblen Teil des Backends. Das Plugin probiert die üblichen Pfad-Varianten (`/v1`, `/api/v1/openai`, …) automatisch durch; schlägt auch das fehl, nennt die Fehlermeldung die geprüften URLs.
- **AnythingLLM: „API-Fehler 500 … keine Details vom Backend“**: Der Fehler passiert im AnythingLLM-Server selbst (Details nur in dessen Server-Logs, z.B. `docker logs`). Das Plugin weicht in diesem Fall automatisch auf die native Workspace-Chat-API (`/api/v1/workspace/<slug>/stream-chat`) aus, die einen anderen Code-Pfad nutzt — die Generierung funktioniert dann trotzdem.
- **Auto-Update**: Nach Download des ZIPs muss Mailspring neu gestartet und das ZIP manuell über „Install Plugin“ installiert werden (Mailspring unterstützt kein Hot-Reload).

## Release-Infos

- **Aktuelles Release**: [v0.4.2](https://github.com/YoMamasNerd/mailspring-auto-draft/releases/tag/v0.4.2)
- **Changelog**: [GitHub Releases](https://github.com/YoMamasNerd/mailspring-auto-draft/releases)
- **Plugin-ZIP** enthält nur Runtime-Files (`lib/`, `styles/`, `package.json`, `LICENSE`) — Tests, `.github/`, Config-Files sind via `.gitattributes export-ignore` ausgeklammert.