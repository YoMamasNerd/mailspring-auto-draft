const { DatabaseStore, Message, QuotedHTMLTransformer } = require('mailspring-exports');
const { htmlToText } = require('./text-utils');

const MAX_MESSAGES = 10;
const MAX_CHARS = 15000;

function contactList(contacts) {
  return (contacts || []).map((c) => c.toString()).join(', ');
}

function formatDate(dateVal) {
  if (dateVal instanceof Date) {
    return dateVal.toLocaleString();
  }
  if (typeof dateVal === 'number' || (typeof dateVal === 'string' && !isNaN(Number(dateVal)))) {
    const num = Number(dateVal);
    // Wenn der Zeitstempel in Sekunden vorliegt (wie oft in Mailspring/SQLite), mit 1000 multiplizieren
    const ms = num < 9999999999 ? num * 1000 : num;
    return new Date(ms).toLocaleString();
  }
  if (dateVal) {
    const parsed = new Date(dateVal);
    if (!isNaN(parsed.getTime())) {
      return parsed.toLocaleString();
    }
    return String(dateVal);
  }
  return 'unbekanntes Datum';
}

function messageToPlainText(message) {
  let html = message.body || '';
  if (!html) return '';
  // Zitate der Vorgänger entfernen — jede Nachricht steht selbst im Verlauf,
  // sonst wächst der Kontext quadratisch.
  try {
    html = QuotedHTMLTransformer.removeQuotedHTML(html, { keepIfWholeBodyIsQuote: true });
  } catch (err) {
    // im Zweifel ungekürzt weiterverwenden
  }
  return htmlToText(html);
}

// Lädt die Nachrichten des Threads chronologisch aus Mailsprings Datenbank
// und baut daraus einen kompakten Klartext-Verlauf. Neueste Nachrichten haben
// Vorrang, wenn die Limits (Anzahl/Zeichen) greifen.
async function loadThreadContext(draft) {
  if (!draft.threadId) return null;

  const messages = await DatabaseStore.findAll(Message, { threadId: draft.threadId }).include(
    Message.attributes.body
  );

  const relevant = messages
    .filter((m) => !m.draft && (m.body || '').length > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-MAX_MESSAGES);

  if (!relevant.length) return null;

  // Von der neuesten zur ältesten aufnehmen, bis das Zeichenlimit erreicht
  // ist, danach wieder chronologisch ausgeben.
  const entries = [];
  let total = 0;
  for (const m of relevant.reverse()) {
    const text = messageToPlainText(m);
    if (!text) continue;
    const date = formatDate(m.date);
    const entry =
      `Am ${date} schrieb ${contactList(m.from) || 'unbekannt'}` +
      (m.to && m.to.length ? ` an ${contactList(m.to)}` : '') +
      `:\n${text}`;
    if (entries.length > 0 && total + entry.length > MAX_CHARS) break;
    entries.push(entry);
    total += entry.length;
  }

  if (!entries.length) return null;
  return entries.reverse().join('\n\n---\n\n');
}

module.exports = { loadThreadContext, MAX_MESSAGES, MAX_CHARS };
