function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function textToHtml(text) {
  return (
    text
      .split('\n')
      .map((line) => `<div>${escapeHtml(line) || '<br/>'}</div>`)
      .join('') + '<br/>'
  );
}

function htmlToText(html) {
  const withBreaks = html
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<\/(p|div|blockquote|li)>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  const el = document.createElement('div');
  el.innerHTML = withBreaks;
  return (el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { escapeHtml, textToHtml, htmlToText };
