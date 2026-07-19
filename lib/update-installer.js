// Installiert ein heruntergeladenes Release-ZIP direkt ins Plugin-Verzeichnis.
//
// Bewusst ohne Fremd-Dependencies: die Release-ZIPs entstehen per `git archive`
// (Kompression "stored" oder "deflate"), das deckt Nodes eingebautes
// zlib.inflateRawSync vollständig ab. Der Parser liest das Central Directory,
// damit auch ZIPs mit Data-Descriptors und Archiv-Kommentar (git schreibt den
// Commit-Hash hinein) korrekt verarbeitet werden.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocdOffset(buffer) {
  // EOCD von hinten suchen — hinter ihm darf noch ein Kommentar stehen.
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('Kein ZIP-Verzeichnis gefunden (EOCD fehlt) — Datei ist kein ZIP.');
}

function listZipEntries(buffer) {
  const eocd = findEocdOffset(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== CENTRAL_SIG) {
      throw new Error('Ungültiger Central-Directory-Eintrag im ZIP.');
    }
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    entries.push({
      name: buffer.slice(pos + 46, pos + 46 + nameLen).toString('utf8'),
      method: buffer.readUInt16LE(pos + 10),
      compressedSize: buffer.readUInt32LE(pos + 20),
      localOffset: buffer.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(buffer, entry) {
  const p = entry.localOffset;
  if (buffer.readUInt32LE(p) !== LOCAL_SIG) {
    throw new Error(`Ungültiger Local-Header für "${entry.name}".`);
  }
  // Größen aus dem Central Directory nehmen — der Local-Header kann bei
  // Data-Descriptor-ZIPs (git archive) Nullen enthalten.
  const nameLen = buffer.readUInt16LE(p + 26);
  const extraLen = buffer.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buffer.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Nicht unterstützte ZIP-Kompressionsmethode ${entry.method} ("${entry.name}").`);
}

// Verhindert Path-Traversal (../, absolute Pfade) aus dem Archiv heraus.
function safeJoin(targetDir, name) {
  const normalized = path.normalize(name).replace(/^([/\\])+/, '');
  if (path.isAbsolute(normalized) || normalized.split(/[/\\]/).includes('..')) {
    throw new Error(`Unsicherer Pfad im ZIP abgelehnt: "${name}"`);
  }
  const root = path.resolve(targetDir);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Unsicherer Pfad im ZIP abgelehnt: "${name}"`);
  }
  return resolved;
}

function extractZip(buffer, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const written = [];
  for (const entry of listZipEntries(buffer)) {
    if (entry.name.endsWith('/')) {
      fs.mkdirSync(safeJoin(targetDir, entry.name), { recursive: true });
      continue;
    }
    const dest = safeJoin(targetDir, entry.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readEntryData(buffer, entry));
    written.push(entry.name);
  }
  return written;
}

// Rekursives Löschen/Kopieren mit alten fs-APIs — Mailsprings Electron/Node
// kennt fs.rmSync/cpSync nicht zwingend.
function removeDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removeDir(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Entpackt das ZIP nach stagingDir, prüft, dass es wirklich dieses Plugin
// enthält, und kopiert es dann über pluginRoot. Wirft bei jedem Problem,
// BEVOR etwas an der Installation verändert wurde.
function installFromZipBuffer(buffer, pluginRoot, stagingDir) {
  removeDir(stagingDir);
  const files = extractZip(buffer, stagingDir);

  const pkgPath = path.join(stagingDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error('ZIP enthält keine package.json — kein gültiges Plugin-Paket.');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.name !== 'ai-reply-drafts') {
    throw new Error(`ZIP enthält ein fremdes Paket ("${pkg.name}").`);
  }

  copyDir(stagingDir, pluginRoot);
  try {
    removeDir(stagingDir);
  } catch (cleanupErr) {
    // Aufräumen darf die erfolgreiche Installation nicht gefährden.
  }
  return { files: files.length, version: pkg.version || 'unbekannt' };
}

module.exports = { extractZip, listZipEntries, installFromZipBuffer, copyDir, removeDir };
