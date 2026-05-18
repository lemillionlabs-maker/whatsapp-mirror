// slave/index.js
// Connects to WhatsApp as a linked device, captures all messages including
// media (images, videos, audio, documents, view-once), saves to shared SQLite
// DB and MySQL session backup for Render persistence.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  isJidBroadcast,
  isJidGroup,
  jidNormalizedUser,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const { backupSession, restoreSession, clearSession } = require('../shared/session-sync');
const db = require('../shared/db');
const { extractBody, getMessageType } = require('../shared/format');

const mysql  = require('mysql2/promise');
const pino   = require('pino');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const SESSION_DIR = path.join(__dirname, 'slave_session');
const MEDIA_DIR   = process.env.MEDIA_DIR || path.join(__dirname, '../data/media');
const PORT        = parseInt(process.env.SLAVE_PORT || '3001');
const logger      = pino({ level: 'silent' });

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ─── MySQL pool (for slave_messages mirror table) ─────────────────────────────

const pool = mysql.createPool({
  host:               process.env.DB_HOST,
  port:               parseInt(process.env.DB_PORT || '3306'),
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  ssl:                { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit:    5,
});

async function ensureTable() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS slave_messages (
      id           VARCHAR(64) PRIMARY KEY,
      jid          VARCHAR(128) NOT NULL,
      sender_jid   VARCHAR(128),
      sender_name  VARCHAR(255),
      body         TEXT,
      type         VARCHAR(32) DEFAULT 'text',
      timestamp    BIGINT NOT NULL,
      is_from_me   TINYINT DEFAULT 0,
      forwarded    TINYINT DEFAULT 0,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[SLAVE] slave_messages table ready');
}

// Mirror to MySQL (lightweight log) + save full record to SQLite via shared db
async function persistMessage(record) {
  // 1. SQLite via shared db (master reads from here)
  db.saveMessage(record);

  // 2. MySQL mirror log
  try {
    await pool.execute(
      `INSERT INTO slave_messages (id, jid, sender_jid, sender_name, body, type, timestamp, is_from_me)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE body = VALUES(body)`,
      [record.id, record.jid, record.senderJid, record.senderName,
       record.body, record.type, record.timestamp, record.isFromMe ? 1 : 0]
    );
  } catch (e) {
    console.error('[SLAVE] MySQL mirror error:', e.message);
  }

  console.log(`[SLAVE] ✓ Saved: [${record.type}] ${record.senderName || record.senderJid}: ${(record.body || '').slice(0, 80)}`);
}

// ─── Media download ───────────────────────────────────────────────────────────

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker', 'view_once_image', 'view_once_video']);

const MEDIA_EXT = {
  image:            'jpg',
  video:            'mp4',
  audio:            'mp3',
  ptt:              'ogg',
  document:         'bin',
  sticker:          'webp',
  view_once_image:  'jpg',
  view_once_video:  'mp4',
};

function getMimeType(message, msgType) {
  const m = message;
  if (m.imageMessage)    return m.imageMessage.mimetype    || 'image/jpeg';
  if (m.videoMessage)    return m.videoMessage.mimetype    || 'video/mp4';
  if (m.audioMessage)    return m.audioMessage.mimetype    || 'audio/ogg';
  if (m.documentMessage) return m.documentMessage.mimetype || 'application/octet-stream';
  if (m.stickerMessage)  return m.stickerMessage.mimetype  || 'image/webp';
  const inner = (m.viewOnceMessageV2 || m.viewOnceMessage)?.message;
  if (inner?.imageMessage) return inner.imageMessage.mimetype || 'image/jpeg';
  if (inner?.videoMessage) return inner.videoMessage.mimetype || 'video/mp4';
  return 'application/octet-stream';
}

function getDocumentExt(message) {
  const doc = message.documentMessage;
  if (!doc) return 'bin';
  if (doc.fileName) {
    const parts = doc.fileName.split('.');
    if (parts.length > 1) return parts.pop();
  }
  const mime = doc.mimetype || '';
  const mimeExt = mime.split('/')[1]?.split(';')[0];
  return mimeExt || 'bin';
}

async function downloadMedia(sock, msg, msgType) {
  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    if (!buffer || !buffer.length) return null;

    const ext      = msgType === 'document' ? getDocumentExt(msg.message) : (MEDIA_EXT[msgType] || 'bin');
    const fileName = `${msg.key.id}.${ext}`;
    const filePath = path.join(MEDIA_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    console.log(`[SLAVE] 📥 Media saved: ${fileName} (${buffer.length} bytes)`);
    return filePath;
  } catch (e) {
    console.error(`[SLAVE] Media download failed (${msgType}):`, e.message);
    return null;
  }
}

// ─── Message cache for getMessage retries ─────────────────────────────────────

const msgCache  = new Map();
const CACHE_MAX = 500;

function cacheMessage(msg) {
  if (msgCache.size >= CACHE_MAX) msgCache.delete(msgCache.keys().next().value);
  msgCache.set(msg.key.id, msg.message);
}

// ─── State ────────────────────────────────────────────────────────────────────

let sock        = null;
let isConnected = false;
let currentQr   = null;
let pairingCode = null;

// ─── Connect ──────────────────────────────────────────────────────────────────

async function connect(usePairingCode = false, phoneNumber = null) {
  console.log('[SLAVE] Connecting...');
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  console.log('[SLAVE] Creds registered:', state.creds.registered);

  sock = makeWASocket({
    version,
    logger,
    auth:                state,
    browser:             ['Chrome (Linux)', '', ''],
    markOnlineOnConnect: true,
    syncFullHistory:     false,
    connectTimeoutMs:    60_000,
    keepAliveIntervalMs: 20_000,
    getMessage: async (key) => msgCache.get(key.id) ?? undefined,
  });

  if (usePairingCode && phoneNumber && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ''));
        pairingCode = code;
        console.log(`[SLAVE] Pairing code: ${code}`);
      } catch (e) {
        console.error('[SLAVE] Pairing code error:', e.message);
      }
    }, 2000);
  }

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await backupSession('slave', SESSION_DIR);
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) { currentQr = qr; console.log('[SLAVE] QR ready'); }

    if (connection === 'open') {
      isConnected = true;
      currentQr   = null;
      pairingCode = null;
      db.setSessionStatus('slave', true, sock.user?.id?.split(':')[0]);
      console.log('[SLAVE] ✓ Connected as', sock.user?.id?.split(':')[0]);
      await backupSession('slave', SESSION_DIR);
    }

    if (connection === 'close') {
      isConnected = false;
      db.setSessionStatus('slave', false);
      const code            = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[SLAVE] Disconnected. Code:', code, '| Reconnect:', shouldReconnect);

      if (shouldReconnect) {
        setTimeout(() => connect(usePairingCode, phoneNumber), 5000);
      } else {
        await clearSession('slave', SESSION_DIR);
        console.log('[SLAVE] Auth cleared. Re-pair via dashboard.');
      }
    }
  });

  // ── Contacts ─────────────────────────────────────────────────────────────────
  sock.ev.on('contacts.update', (updates) => {
    for (const c of updates) {
      if (c.id) db.upsertContact(c.id, c.name || c.notify, c.notify);
    }
  });

  // ── Messages ──────────────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[SLAVE] messages.upsert — type=${type}, count=${messages.length}`);

    for (const msg of messages) {
      try {
        if (!msg.message)                             continue;
        if (isJidBroadcast(msg.key.remoteJid))        continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        if (msg.message.protocolMessage)              continue;
        if (msg.message.senderKeyDistributionMessage) continue;

        cacheMessage(msg);

        const jid       = msg.key.remoteJid;
        const isGroup   = isJidGroup(jid);
        const senderJid = isGroup
          ? jidNormalizedUser(msg.key.participant || jid)
          : jidNormalizedUser(jid);
        const isFromMe   = !!msg.key.fromMe;
        const senderName = msg.pushName || senderJid.split('@')[0];

        // Use shared helpers for consistent body/type extraction
        const msgType    = getMessageType(msg.message);
        const body       = extractBody(msg.message) || '[unknown]';
        const mimeType   = getMimeType(msg.message, msgType);
        const isViewOnce = msgType === 'view_once_image' || msgType === 'view_once_video';

        const timestamp = typeof msg.messageTimestamp === 'object'
          ? msg.messageTimestamp.low
          : (msg.messageTimestamp || Math.floor(Date.now() / 1000));

        // Skip reactions — handled separately
        if (msgType === 'reaction') {
          const reaction = msg.message.reactionMessage;
          if (reaction?.key?.id) {
            db.saveReaction({
              id:         `${reaction.key.id}_${senderJid}`,
              messageId:  reaction.key.id,
              reactorJid: senderJid,
              emoji:      reaction.text || '',
              timestamp,
            });
          }
          continue;
        }

        console.log(`[SLAVE] MSG from=${senderName} type=${msgType} body="${body.slice(0, 100)}"`);

        // Download media if applicable
        let mediaPath = null;
        if (MEDIA_TYPES.has(msgType)) {
          mediaPath = await downloadMedia(sock, msg, msgType);
        }

        // Upsert contact
        if (senderName && senderJid) {
          db.upsertContact(senderJid, senderName, null);
        }

        // Filter check
        if (db.isFiltered(senderJid) || db.isFiltered(jid)) {
          console.log(`[SLAVE] Filtered: ${senderJid}`);
          continue;
        }

        await persistMessage({
          id:         msg.key.id,
          jid,
          senderJid,
          senderName,
          body,
          type:       msgType,
          timestamp,
          isFromMe,
          mediaPath,
          mimeType:   mediaPath ? mimeType : null,
          isViewOnce,
          rawJson:    JSON.stringify(msg.message),
        });

      } catch (e) {
        console.error('[SLAVE] Message handling error:', e.message, e.stack);
      }
    }
  });

  return sock;
}

// ─── HTTP control server ──────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/status') {
    res.end(JSON.stringify({ isConnected, phone: sock?.user?.id?.split(':')[0] || null }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/qr') {
    res.end(JSON.stringify({ qr: currentQr }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/pairing-code') {
    res.end(JSON.stringify({ code: pairingCode }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/connect') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { method, phone } = JSON.parse(body || '{}');
        connect(method === 'pairing', phone);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/disconnect') {
    if (sock) sock.logout().catch(() => {});
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, async () => {
  console.log(`[SLAVE] Control server on :${PORT}`);
  await ensureTable();

  const restored = await restoreSession('slave', SESSION_DIR);
  if (restored) {
    console.log('[SLAVE] Session restored from MySQL, reconnecting...');
    connect(false, null);
  } else {
    console.log('[SLAVE] No session in MySQL. Use dashboard to pair.');
  }
});

module.exports = { connect };