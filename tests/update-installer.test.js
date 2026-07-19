// Tests für den ZIP-Installer des Auto-Updaters. Der Nachbau des ZIP-Formats
// hier im Test deckt "stored" und "deflate" ab; zusätzlich wird ein echtes
// `git archive`-ZIP (das Format der GitHub-Releases, inkl. Archiv-Kommentar)
// entpackt, sofern git verfügbar ist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execSync } = require('node:child_process');

const { extractZip, installFromZipBuffer, removeDir } = require('../lib/update-installer');

// Minimaler ZIP-Builder (Local Headers + Central Directory + EOCD).
// CRCs bleiben 0 — der Installer prüft sie nicht.
function buildZip(entries, { comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name);
    const raw = Buffer.from(e.data || '');
    const method = e.method === undefined ? 8 : e.method;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFull = Buffer.concat([local, nameBuf, data]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    locals.push(localFull);
    offset += localFull.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  return Buffer.concat([...locals, centralBuf, eocd, commentBuf]);
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ai-drafts-${name}-`));
}

test('extractZip: entpackt stored- und deflate-Einträge (auch mit ZIP-Kommentar)', () => {
  const zip = buildZip(
    [
      { name: 'package.json', data: '{"name":"ai-reply-drafts"}', method: 8 },
      { name: 'lib/', data: '', method: 0 },
      { name: 'lib/main.js', data: 'module.exports = 1;', method: 0 },
    ],
    { comment: 'deadbeef' } // git archive schreibt den Commit-Hash als Kommentar
  );
  const target = tmpDir('extract');
  const files = extractZip(zip, target);
  assert.deepEqual(files.sort(), ['lib/main.js', 'package.json']);
  assert.equal(fs.readFileSync(path.join(target, 'lib/main.js'), 'utf8'), 'module.exports = 1;');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).name,
    'ai-reply-drafts'
  );
  removeDir(target);
});

test('extractZip: lehnt Path-Traversal-Einträge ab', () => {
  const zip = buildZip([{ name: '../evil.txt', data: 'x' }]);
  const target = tmpDir('traversal');
  assert.throws(() => extractZip(zip, target), /Unsicherer Pfad/);
  removeDir(target);
});

test('installFromZipBuffer: installiert nur echte Plugin-Pakete und überschreibt Dateien', () => {
  const pluginRoot = tmpDir('plugin');
  const staging = tmpDir('staging');
  fs.mkdirSync(path.join(pluginRoot, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'lib/main.js'), 'ALT');

  // Fremdes Paket → Abbruch, nichts überschrieben
  const foreign = buildZip([{ name: 'package.json', data: '{"name":"anderes-plugin"}' }]);
  assert.throws(() => installFromZipBuffer(foreign, pluginRoot, staging), /fremdes Paket/);
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'lib/main.js'), 'utf8'), 'ALT');

  // Echtes Paket → Dateien landen im Plugin-Verzeichnis
  const zip = buildZip([
    { name: 'package.json', data: '{"name":"ai-reply-drafts","version":"9.9.9"}' },
    { name: 'lib/main.js', data: 'NEU' },
    { name: 'styles/neu.less', data: '.x { color: red; }' },
  ]);
  const info = installFromZipBuffer(zip, pluginRoot, staging);
  assert.equal(info.version, '9.9.9');
  assert.equal(info.files, 3);
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'lib/main.js'), 'utf8'), 'NEU');
  assert.ok(fs.existsSync(path.join(pluginRoot, 'styles/neu.less')));
  assert.ok(!fs.existsSync(staging), 'Staging-Verzeichnis muss aufgeräumt sein');

  removeDir(pluginRoot);
});

test('extractZip: verarbeitet ein echtes git-archive-ZIP (Release-Format)', (t) => {
  let zip;
  try {
    zip = execSync('git archive --format=zip HEAD', {
      cwd: path.join(__dirname, '..'),
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    t.skip('git archive nicht verfügbar');
    return;
  }
  const target = tmpDir('git-archive');
  const files = extractZip(zip, target);
  assert.ok(files.includes('package.json'), 'package.json muss im Release-ZIP stecken');
  assert.ok(files.includes('lib/ai-service.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'ai-reply-drafts');
  // Inhalt muss exakt dem Repo-Stand entsprechen (Deflate korrekt entpackt)
  assert.equal(
    fs.readFileSync(path.join(target, 'lib/main.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'lib/main.js'), 'utf8')
  );
  removeDir(target);
});
