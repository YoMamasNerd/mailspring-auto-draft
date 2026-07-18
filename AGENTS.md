# AGENTS.md — AI Reply Drafts for Mailspring

> **Cross-tool instruction file** for AI coding agents (Codex, Cursor, Claude Code, Copilot, Aider, etc.).
> Place at repo root. Agents read the nearest AGENTS.md to the file being edited.

---

## Project Overview

**AI Reply Drafts** — Mailspring plugin that generates AI email drafts via any OpenAI-compatible API (Ollama, LiteLLM, Open WebUI, AnythingLLM, vLLM, OpenAI, Anthropic, Google, …).

- **Primary language**: JavaScript (ES2020, runs in Mailspring's Electron renderer)
- **Framework**: Mailspring Plugin API v1 (React-based components via `mailspring-exports`)
- **Package name**: `ai-reply-drafts` (in `package.json`)
- **Entry point**: `lib/main.js` → registers `AiDraftPanel` (Composer:Footer) + `AiDraftPreferences` (Settings tab)
- **No build step** — source files load directly; copy folder 1:1 to Mailspring packages dir
- **Target**: Mailspring ≥1.11 (Mac/Win/Linux)

---

## Architecture & Key Files

```
mailspring-auto-draft/
├── lib/
│   ├── main.js              # Plugin entry: ComponentRegistry + PreferencesUIStore
│   ├── ai-draft-panel.js    # Composer panel (React): generate/stream/refine/insert/undo
│   ├── ai-service.js        # Core logic: API calls, streaming, caching, health-check, failover, updater
│   ├── preferences.js       # Settings UI (React): validation, export/import, model loading, updater UI
│   ├── thread-context.js    # Loads thread history from Mailspring DatabaseStore
│   ├── text-utils.js        # HTML↔text, quote stripping, signature detection
│   └── ...
├── styles/
│   └── ai-reply-drafts.less # CSS Custom Properties + Dark/Light auto-detect
├── package.json             # name, version, main, windowTypes, engines
├── .gitattributes           # export-ignore for tests/.github/*.md → clean Release ZIP
└── .github/workflows/release.yml  # Tag push → git archive → GitHub Release asset
```

**Data flow (reply generation):**
1. `AiDraftPanel._generate()` → commits editor changes → loads thread context (last 10 msgs, 15k chars)
2. Builds prompt (system + thread + quoted text + user notes + sender name)
3. `AIService.generateReply()` → `POST /chat/completions` (SSE streaming)
4. Tokens stream into panel textarea live; on done → `status: 'done'`, suggestion + usage
5. User edits → **Ersetzen** (replace user text) or **Anhängen** (append before signature)
6. Undo/History: last 3 suggestions stored, ↶/↷ buttons restore

---

## Commands (copy-pasteable)

### Development
```bash
# No build needed — edit files directly
# Test by copying to Mailspring packages dir:
# Linux:   cp -r . ~/.config/Mailspring/packages/ai-reply-drafts/
# macOS:   cp -r . ~/Library/Application\ Support/Mailspring/packages/ai-reply-drafts/
# Win PS:  Copy-Item -Recurse -Force * "$env:APPDATA\Mailspring\packages\ai-reply-drafts\"
# Then restart Mailspring (or Developer → Reload)
```

### Release
```bash
# Bump version in package.json, then:
git tag v0.4.1 && git push origin v0.4.1
# → GitHub Actions builds clean ZIP (respects .gitattributes) → creates Release asset
```

### Lint / Syntax check
```bash
node --check lib/*.js          # Quick syntax check
# No formal linter configured (Mailspring doesn't ship one)
```

---

## Code Style Rules (only non-defaults)

| Rule | Detail |
|---|---|
| **Quotes** | Single `'` (except JSON in code) |
| **Indentation** | 2 spaces |
| **Semicolons** | Required |
| **Variables** | `const` by default, `let` if reassigned |
| **Functions** | `function name() {}` for top-level, arrow for callbacks |
| **Async** | `async/await` preferred; `Promise` chains only for streaming |
| **Globals** | `/* global AppEnv */` at top of files using Mailspring globals |
| **React** | `const e = React.createElement` pattern (no JSX) |
| **Exports** | `module.exports = …` (CommonJS) |
| **Error messages** | German user-facing, English dev logs |
| **Comments** | German for user-facing logic, English for internals |

---

## Testing Instructions

**No automated test suite exists.** Manual verification checklist:

| Scenario | How to test |
|---|---|
| **Settings load** | Open Settings → AI Drafts → fields populated from config |
| **Model loading** | Enter Base URL + Key → click "Modelle laden / Verbindung testen" → dropdown fills |
| **Auto-generate reply** | Open reply composer → panel appears → suggestion streams in |
| **Manual generate** | Click "✨ KI-Antwort generieren" → streams |
| **Streaming fallback** | Set `{"stream": false}` in extraParams → still works |
| **Undo/Redo** | Generate → refine → ↶ → suggestion restored → ↷ → back |
| **Shortcut** | `Strg+Umschalt+G` in composer → generates |
| **Tone chips** | Click Formell/Locker/Kurz → regenerates with tone |
| **Refine** | Type "kürzer" in refine input → click Überarbeiten → targeted rewrite |
| **Attachment RAG** | Enable checkbox → attach PDF/image → generate → prompt contains "Anhänge der E-Mail (N als Kontext genutzt)" with filenames |
| **Health check** | Enable Health-Check → wait 5 min or click "Jetzt prüfen" → 🟢/🔴 indicator |
| **Failover** | Enable Failover + add fallbacks → kill backend → auto-switches model |
| **Export/Import** | Export → edit JSON → Import → settings restored |
| **Auto-Updater** | Settings → "Jetzt auf Updates prüfen" → downloads ZIP → shows path |
| **Theme** | Toggle OS dark/light mode → panel adapts via CSS vars |

---

## Security Considerations

- **API Key storage**: Plaintext in Mailspring `config.json` (same as all plugins) — warn users in README
- **Secrets in code**: Never commit API keys; `.gitignore` covers local config
- **User data**: Thread context & drafts sent to configured backend only
- **Attachments**: Only filename + MIME type go into the prompt (Mailspring keeps no file content in memory); max 5 MB × 3, filtered by MIME (`image/*`, `pdf`, `text/*`, `application/json`, `xml`). Content-level RAG runs backend-side (e.g. via `extraParams.files`)
- **No telemetry** — no external calls except configured backend + GitHub Releases API (updater)
- **Files to never touch**: `.github/`, `tests/` (not in repo), `.gitattributes`, `package-lock.json` (not committed)

---

## Commit & PR Guidelines

| Aspect | Rule |
|---|---|
| **Branch naming** | `feat/<short-desc>`, `fix/<short-desc>`, `docs/<short-desc>` |
| **Commit format** | `type(scope): subject` — types: `feat`, `fix`, `docs`, `chore`, `refactor`, `style` |
| **Examples** | `feat(updater): add prerelease channel selector`<br>`fix(streaming): handle empty chunk in SSE parser` |
| **PR title** | Same as commit subject (squash-merge) |
| **Merge** | Squash & merge to `main`; delete branch |
| **Version bump** | Only in `package.json` via commit `chore: bump version to x.y.z` + tag |
| **Release notes** | Auto-generated from commits via `generate_release_notes: true` |

---

## Architectural Boundaries (Do Not Cross)

| Boundary | Rule |
|---|---|
| **No build tools** | Never add Webpack, Vite, Babel, TypeScript — Mailspring loads raw JS |
| **No Node APIs in renderer** | `fs`, `path`, `os` only in `ai-service.js` (runs in main via `AppEnv` bridge) |
| **Settings schema** | All config keys must be in `DEFAULTS` (ai-service.js) AND `FIELDS` (preferences.js) |
| **State isolation** | Each composer = new `AiDraftPanel` instance; no shared mutable state |
| **Mailspring APIs** | Use only `mailspring-exports`: `ComponentRegistry`, `PreferencesUIStore`, `Actions`, `DatabaseStore`, `DraftEditingSession` |
| **CSS** | Only `--ai-draft-*` custom properties + Mailspring UI vars (`@background-secondary`, etc.) |
| **Streaming** | Must handle: SSE chunks, JSON fallback, auto-retry without stream, AbortController cleanup |

---

## Common Pitfalls (from PR history)

| Pitfall | Symptom | Fix |
|---|---|---|
| `AppEnv.config.get` returns `undefined` | Setting not persisted | Always provide `DEFAULTS[key]` fallback in `getConfig()` |
| Streaming never resolves | Panel stuck on "Generiere…" | Ensure `onToken` called at least once; fallback to non-streaming after error |
| Model dropdown empty | "Modelle laden" shows 0 | Backend must return `/models` with `data[]` or `models[]` array |
| Health-check spams | 10s timeout fires repeatedly | Respect `healthCheckInterval` (default 5 min); guard with `healthCheckEnabled` |
| Failover loops | Switches model endlessly | Only try each fallback **once** per health-check cycle |
| Theme flashes | White panel in dark mode | CSS vars must have `@media (prefers-color-scheme: dark)` override |
| Undo loses suggestion | ↶ does nothing | Push to `suggestionHistory` **before** generating new one |
| Shortcut not working | `Strg+Shift+G` ignored | Parser must handle `Strg`/`Control`/`Meta` + `Umschalt`/`Shift` + key |
| Release ZIP bloated | 500 KB+ with tests | `.gitattributes export-ignore` for `.github/`, `tests/`, `*.md` (except LICENSE) |

---

## Mailspring-Specific Gotchas

- **No hot-reload** — after file changes: *Developer → Reload* or restart Mailspring
- **Composer session** — `session.listen(cb)` fires on every keystroke; debounce if needed
- **Draft body** — HTML; insertion markers: `<signature`, `gmail_quote`, `blockquote`, etc.
- **Thread context** — `loadThreadContext(draft)` returns `{ text, messageCount }` (deduplicated)
- **Preferences tab** — `PreferencesUIStore.TabItem` with `componentClassFn: () => AiDraftPreferences`
- **Window types** — `package.json` needs `"composer": true` for panel to appear
- **Console** — *View → Developer → Toggle Developer Tools* for `console.log` / errors

---

## Agent Quick Reference

| Task | Where to look / edit |
|---|---|
| Add new setting | `DEFAULTS` + `getConfig/setConfig` in `ai-service.js` + `FIELDS` in `preferences.js` |
| Change API request shape | `AIService.generateReply()` → `requestOnce()` in `ai-service.js` |
| Modify panel UI | `AiDraftPanel._renderBody()` / `_renderContextInfo()` in `ai-draft-panel.js` |
| Add streaming format | `AIService.requestOnce()` → `onToken` handling in `ai-service.js` |
| Adjust health-check interval | `DEFAULTS.healthCheckInterval` + `preferences.js` field |
| Change failover logic | `AIService.runPeriodicHealthCheck()` in `ai-service.js` |
| Update theme colors | `--ai-draft-*` vars in `styles/ai-reply-drafts.less` |
| Bump version for release | `package.json` + `git tag vX.Y.Z` |

---

## Version & Changelog

- **Current**: `0.4.0` (see `package.json`)
- **Release tags**: `v*` → GitHub Actions builds clean ZIP → Release asset
- **Changelog**: Auto-generated from commit subjects (Conventional Commits)

---

*This file follows the [AGENTS.md spec](https://www.morphllm.com/agents-md-guide) — plain Markdown, no required fields, read by 30+ coding agents.*