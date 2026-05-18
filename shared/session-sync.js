// shared/session-sync.js
// Saves and restores a Baileys session folder as a single compressed
// blob in MySQL. This lets file-based auth survive Render sleeps/restarts
// without the complexity of a per-key MySQL auth adapter.
//
// Usage:
//   await restoreSession('slave', SESSION_DIR);   // on startup, before connect()
//   await backupSession('slave', SESSION_DIR);     // after creds.update fires

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const mysql = require('mysql2/promise');

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  _pool = mysql.createPool({
    host:               process.env.DB_HOST,
    port:               parseInt(process.env.DB_PORT || '3306'),
    user:               process.env.DB_USER,
    password:           process.env.DB_PASSWORD,
    database:           process.env.DB_NAME,
    ssl:                { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit:    5,
  });
  return _pool;
}

async function ensureTable() {
  await getPool().execute(`
    CREATE TABLE IF NOT EXISTS wa_sessions (
      bot        VARCHAR(32) PRIMARY KEY,
      session    LONGBLOB NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

// Pack every file in sessionDir into a single JSON blob, then gzip it
async function packSession(sessionDir) {
  const files = fs.readdirSync(sessionDir);
  const bundle = {};
  for (const file of files) {
    const full = path.join(sessionDir, file);
    if (fs.statSync(full).isFile()) {
      bundle[file] = fs.readFileSync(full, 'utf8');
    }
  }
  const json = JSON.stringify(bundle);
  return gzip(json);
}

// Unpack a gzipped bundle back into sessionDir
async function unpackSession(blob, sessionDir) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const json = (await gunzip(blob)).toString('utf8');
  const bundle = JSON.parse(json);
  for (const [file, contents] of Object.entries(bundle)) {
    fs.writeFileSync(path.join(sessionDir, file), contents, 'utf8');
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function backupSession(bot, sessionDir) {
  if (!fs.existsSync(path.join(sessionDir, 'creds.json'))) {
    console.log(`[session-sync:${bot}] No creds.json yet, skipping backup`);
    return;
  }
  try {
    await ensureTable();
    const blob = await packSession(sessionDir);
    await getPool().execute(
      `INSERT INTO wa_sessions (bot, session) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE session = VALUES(session), updated_at = NOW()`,
      [bot, blob]
    );
    console.log(`[session-sync:${bot}] Session backed up to MySQL (${blob.length} bytes)`);
  } catch (e) {
    console.error(`[session-sync:${bot}] Backup failed:`, e.message);
  }
}

async function restoreSession(bot, sessionDir) {
  try {
    await ensureTable();
    const [rows] = await getPool().execute(
      'SELECT session FROM wa_sessions WHERE bot = ?',
      [bot]
    );
    if (!rows.length) {
      console.log(`[session-sync:${bot}] No session in MySQL, will pair fresh`);
      return false;
    }
    await unpackSession(rows[0].session, sessionDir);
    console.log(`[session-sync:${bot}] Session restored from MySQL`);
    return true;
  } catch (e) {
    console.error(`[session-sync:${bot}] Restore failed:`, e.message);
    return false;
  }
}

async function clearSession(bot, sessionDir) {
  try {
    await getPool().execute('DELETE FROM wa_sessions WHERE bot = ?', [bot]);
    console.log(`[session-sync:${bot}] Session cleared from MySQL`);
  } catch (e) {
    console.error(`[session-sync:${bot}] Clear failed:`, e.message);
  }
  if (sessionDir && fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

module.exports = { backupSession, restoreSession, clearSession, getPool };