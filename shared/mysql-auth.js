// shared/mysql-auth.js — Baileys auth state backed by MySQL (Aiven)
// Drop-in replacement for useMultiFileAuthState.
// Stores creds + signal keys in a single `wa_auth` table.

const mysql = require('mysql2/promise');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

// ─── Connection pool (shared across both bots) ────────────────────────────────

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  _pool = mysql.createPool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }, // required for Aiven
    waitForConnections: true,
    connectionLimit: 10, // increased: slave + master both use this pool
    queueLimit: 0,
  });
  return _pool;
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

async function readRow(bot, keyId) {
  const [rows] = await getPool().execute(
    'SELECT data FROM wa_auth WHERE bot = ? AND key_id = ?',
    [bot, keyId]
  );
  if (!rows.length) return null;
  try {
    return JSON.parse(rows[0].data, BufferJSON.reviver);
  } catch {
    return null;
  }
}

// Batched read: fetch multiple key_ids in a single query
async function readRows(bot, keyIds) {
  if (!keyIds.length) return {};
  const placeholders = keyIds.map(() => '?').join(',');
  const [rows] = await getPool().execute(
    `SELECT key_id, data FROM wa_auth WHERE bot = ? AND key_id IN (${placeholders})`,
    [bot, ...keyIds]
  );
  const result = {};
  for (const row of rows) {
    try {
      result[row.key_id] = JSON.parse(row.data, BufferJSON.reviver);
    } catch {
      // skip malformed rows
    }
  }
  return result;
}

async function writeRow(bot, keyId, value) {
  const data = JSON.stringify(value, BufferJSON.replacer);
  await getPool().execute(
    `INSERT INTO wa_auth (bot, key_id, data)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [bot, keyId, data]
  );
}

async function deleteRow(bot, keyId) {
  await getPool().execute(
    'DELETE FROM wa_auth WHERE bot = ? AND key_id = ?',
    [bot, keyId]
  );
}

// ─── Proto encode/decode helpers ──────────────────────────────────────────────
// Keys are stored as plain base64 strings (via BufferJSON) so they survive
// JSON round-trips correctly. On read, we get a Buffer back from BufferJSON.reviver
// and pass it directly to proto.X.decode().

function encodeKey(type, val) {
  if (type === 'pre-key') {
    return Buffer.from(proto.PreKey.encode(val).finish());
  } else if (type === 'session') {
    return Buffer.from(proto.SessionRecord.encode(val).finish());
  } else if (type === 'sender-key') {
    return Buffer.from(proto.SenderKeyRecord.encode(val).finish());
  } else if (type === 'app-state-sync-key') {
    return Buffer.from(proto.AppStateSyncKeyData.encode(val).finish());
  }
  // sender-key-memory, app-state-sync-version — plain JSON, no encoding
  return val;
}

function decodeKey(type, raw) {
  // BufferJSON.reviver restores Buffers correctly; raw is already a Buffer for
  // binary types. For plain-JSON types it's already the right object.
  try {
    if (type === 'pre-key') {
      return proto.PreKey.decode(raw);
    } else if (type === 'session') {
      return proto.SessionRecord.decode(raw);
    } else if (type === 'sender-key') {
      return proto.SenderKeyRecord.decode(raw);
    } else if (type === 'app-state-sync-key') {
      return proto.AppStateSyncKeyData.decode(raw);
    }
  } catch (e) {
    console.warn(`[mysql-auth] decode failed for type=${type}:`, e.message);
    return undefined;
  }
  // plain-JSON types
  return raw;
}

// ─── Auth state adapter ───────────────────────────────────────────────────────

async function useMySQLAuthState(bot) {
  let creds = await readRow(bot, 'creds');
  if (!creds) creds = initAuthCreds();

  const keys = {
    // FIX: single batched DB query instead of N parallel queries
    async get(type, ids) {
      const keyIds = ids.map((id) => `key:${type}:${id}`);
      const rows = await readRows(bot, keyIds);

      const result = {};
      for (const id of ids) {
        const keyId = `key:${type}:${id}`;
        const raw = rows[keyId];
        if (raw == null) continue;
        const decoded = decodeKey(type, raw);
        if (decoded !== undefined) result[id] = decoded;
      }
      return result;
    },

    async set(data) {
      const ops = [];
      for (const [type, typeData] of Object.entries(data)) {
        for (const [id, val] of Object.entries(typeData)) {
          const keyId = `key:${type}:${id}`;
          if (val != null) {
            // encodeKey returns a Buffer for binary types, or plain value for JSON types.
            // writeRow serialises via BufferJSON.replacer which handles Buffers as base64.
            ops.push(writeRow(bot, keyId, encodeKey(type, val)));
          } else {
            ops.push(deleteRow(bot, keyId));
          }
        }
      }
      await Promise.all(ops);
    },
  };

  // saveCreds: Baileys emits the full updated creds as the event argument to
  // 'creds.update'. We must merge it into our live creds object before writing,
  // otherwise reconnects after Render sleep start with stale/incomplete creds.
  const saveCreds = async (update) => {
    if (update && typeof update === 'object') {
      Object.assign(creds, update);
    }
    try {
      await writeRow(bot, 'creds', creds);
      console.log(`[mysql-auth:${bot}] creds saved — registered=${creds.registered}`);
    } catch (e) {
      console.error(`[mysql-auth:${bot}] creds save FAILED:`, e.message);
    }
  };

  return { state: { creds, keys }, saveCreds };
}

module.exports = { useMySQLAuthState, getPool };