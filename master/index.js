// master/index.js
// Reads shared DB, forwards messages to master group, applies reactions,
// and listens for commands from the master group.
// Uses file-based Baileys auth + MySQL session backup (via session-sync)
// so the session survives Render sleeps and restarts.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');

const { backupSession, restoreSession, clearSession } = require('../shared/session-sync');

const pino = require('pino');
const path = require('path');
const fs   = require('fs');
const http = require('http');

const db = require('../shared/db');
const { formatMessage, isQuietHours } = require('../shared/format');
console.log('forwarder_enabled:', db.getSetting('forwarder_enabled'));
console.log('master_jid:', db.getSetting('master_jid'));
console.log('pending:', db.getPendingMessages());

// ─── Config ───────────────────────────────────────────────────────────────────

const SESSION_DIR   = path.join(__dirname, 'master_session');
const PORT          = parseInt(process.env.MASTER_PORT || '3002');
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '2000');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// ─── State ────────────────────────────────────────────────────────────────────

let sock        = null;
let isConnected = false;
let currentQr   = null;
let pairingCode = null;
let pollTimer   = null;

const { EventEmitter } = require('events');
const masterEvents = new EventEmitter();

// ─── Connect ──────────────────────────────────────────────────────────────────

async function connect(usePairingCode = false, phoneNumber = null) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  console.log('[MASTER] Connecting... registered:', state.creds.registered);

  sock = makeWASocket({
    version,
    logger,
    auth:                state,
    browser:             ['Chrome (Linux)', '', ''],
    markOnlineOnConnect: true,
    connectTimeoutMs:    60_000,
    keepAliveIntervalMs: 25_000,
  });

  if (usePairingCode && phoneNumber && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ''));
        pairingCode = code;
        masterEvents.emit('pairing-code', code);
        console.log(`[MASTER] Pairing code: ${code}`);
      } catch (e) {
        console.error('[MASTER] Pairing code error:', e.message);
      }
    }, 2000);
  }

  // Save to file AND back up entire session folder to MySQL on every creds change
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await backupSession('master', SESSION_DIR);
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairingCode) {
      currentQr = qr;
      masterEvents.emit('qr', qr);
    }

    if (connection === 'open') {
      isConnected = true;
      currentQr   = null;
      pairingCode = null;
      const phone = sock.user?.id?.split(':')[0] || null;
      db.setSessionStatus('master', true, phone);
      masterEvents.emit('connected', phone);
      console.log('[MASTER] ✓ Connected as', phone);
      // Back up immediately on connect
      await backupSession('master', SESSION_DIR);
        const masterJid = db.getSetting('master_jid');
      if (masterJid) {
        try {
          await sock.groupMetadata(masterJid);
          console.log('[MASTER] ✓ Group metadata fetched');
        } catch (e) {
          console.error('[MASTER] ⚠ Could not fetch group metadata:', e.message);
          console.error('[MASTER] Make sure this account is a member of the group:', masterJid);
        }
      }
      startPoller();
    }

    if (connection === 'close') {
      isConnected = false;
      db.setSessionStatus('master', false);
      masterEvents.emit('disconnected');
      stopPoller();
      const code            = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[MASTER] Disconnected. Code:', code, '| Reconnect:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => connect(usePairingCode, phoneNumber), 5000);
      } else {
        await clearSession('master', SESSION_DIR);
        console.log('[MASTER] Auth cleared. Re-pair via dashboard.');
      }
    }
  });

  // Listen for commands from master group
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
    const masterJid = db.getSetting('master_jid');
    if (msg.key.remoteJid !== masterJid) continue;      await handleCommand(msg);
    }
  });

  return sock;
}

// ─── Forward poll loop ────────────────────────────────────────────────────────

function startPoller() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!isConnected) return;
    await forwardPendingMessages();
    await applyPendingReactions();
  }, POLL_INTERVAL);
}

function stopPoller() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

const MEDIA_SEND_MAP = {
  image:           'image',
  video:           'video',
  audio:           'audio',
  ptt:             'audio',
  document:        'document',
  sticker:         'sticker',
  view_once_image: 'image',
  view_once_video: 'video',
};

async function forwardPendingMessages() {
  const enabled = db.getSetting('forwarder_enabled');
  if (enabled !== 'true') return;

const masterJid = '120363408579936307@g.us';

  if (db.getSetting('quiet_hours_enabled') === 'true') {
    const start = db.getSetting('quiet_hours_start') || '23:00';
    const end   = db.getSetting('quiet_hours_end')   || '07:00';
    if (isQuietHours(start, end)) return;
  }

  const pending = db.getPendingMessages();
  const format  = db.getSetting('message_prefix_format') || 'full';

  for (const msg of pending) {
    try {
      const headerText = formatMessage(msg, format);
      let sent;

      const mediaType = MEDIA_SEND_MAP[msg.type];

      if (mediaType && msg.media_path && fs.existsSync(msg.media_path)) {
        await sock.sendMessage(masterJid, { text: headerText });

        const mediaBuffer = fs.readFileSync(msg.media_path);
        const sendPayload = { [mediaType]: mediaBuffer };

        const hasRealCaption = msg.body
          && !msg.body.startsWith('📷') && !msg.body.startsWith('🎥')
          && !msg.body.startsWith('🎵') && !msg.body.startsWith('🎤')
          && !msg.body.startsWith('📄') && !msg.body.startsWith('🎨')
          && !msg.body.startsWith('🔥') && !msg.body.startsWith('👤')
          && !msg.body.startsWith('📍');
        if (hasRealCaption) sendPayload.caption = msg.body;

        if (msg.type === 'ptt')    sendPayload.ptt      = true;
        if (msg.is_view_once)      sendPayload.viewOnce  = true;
        if (msg.mime_type)         sendPayload.mimetype  = msg.mime_type;

        if (msg.type === 'document') {
          sendPayload.fileName = path.basename(msg.media_path).replace(/^[^.]+\./, '') !== msg.media_path
            ? path.basename(msg.media_path)
            : (msg.body?.replace(/^📄 \*Document:\* /, '') || path.basename(msg.media_path));
        }

        sent = await sock.sendMessage(masterJid, sendPayload);
      } else {
        sent = await sock.sendMessage(masterJid, { text: headerText });
      }

      const masterMsgId = sent?.key?.id;
      db.markForwarded(msg.id, masterMsgId || `sent_${Date.now()}`);
    } catch (e) {
      console.error('[MASTER] Forward error:', e.message);
      break;
    }
  }
}

async function applyPendingReactions() {
  if (db.getSetting('include_reactions') !== 'true') return;

const masterJid = '120363408579936307@g.us';

  const pending = db.getPendingReactions();

  for (const reaction of pending) {
    try {
      await sock.sendMessage(masterJid, {
        react: {
          text: reaction.emoji || '',
          key:  { remoteJid: masterJid, id: reaction.master_msg_id, fromMe: true },
        },
      });
      db.markReactionApplied(reaction.id);
    } catch (e) {
      console.error('[MASTER] Reaction error:', e.message);
    }
  }
}

// ─── Command parser ───────────────────────────────────────────────────────────

async function handleCommand(msg) {
  const masterJid = db.getSetting('master_jid');
  if (!masterJid) return;
  if (msg.key.remoteJid !== masterJid) return;

  const body = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text || ''
  ).trim();

  if (!body.startsWith('!')) return;

  const [cmd, ...args] = body.slice(1).split(/\s+/);
  let reply = null;

  switch (cmd.toLowerCase()) {
    case 'mirror': {
      const val = args[0]?.toLowerCase();
      if (val === 'on' || val === 'off') {
        db.setSetting('forwarder_enabled', val === 'on' ? 'true' : 'false');
        reply = `✅ Forwarder is now *${val.toUpperCase()}*`;
      } else {
        const current = db.getSetting('forwarder_enabled') === 'true' ? 'ON' : 'OFF';
        reply = `Mirror is currently *${current}*. Use \`!mirror on\` or \`!mirror off\`.`;
      }
      break;
    }
    case 'filter': {
      const sub = args[0]?.toLowerCase();
      if (sub === 'add') {
        const jid = normalizeJid(args[1]);
        if (!jid) { reply = '❌ Usage: `!filter add <phone or jid>`'; break; }
        db.addFilter(jid, args.slice(2).join(' ') || '');
        reply = `🚫 Filter added for \`${jid}\``;
      } else if (sub === 'remove' || sub === 'rm') {
        const jid = normalizeJid(args[1]);
        if (!jid) { reply = '❌ Usage: `!filter remove <phone or jid>`'; break; }
        db.removeFilter(jid);
        reply = `✅ Filter removed for \`${jid}\``;
      } else if (sub === 'list') {
        const filters = db.getFilters();
        if (!filters.length) { reply = 'No filters active.'; break; }
        reply = `*Filtered contacts (${filters.length}):*\n` +
          filters.map(f => `• ${f.name || f.jid}${f.reason ? ` — ${f.reason}` : ''}`).join('\n');
      } else {
        reply = 'Usage: `!filter add/remove/list [jid]`';
      }
      break;
    }
    case 'settings': {
      const s = db.getAllSettings();
      reply = '*Current Settings:*\n' +
        Object.entries(s).map(([k, v]) => `• ${k}: \`${v}\``).join('\n');
      break;
    }
    case 'set': {
      const key   = args[0];
      const value = args.slice(1).join(' ');
      if (!key || !value) { reply = '❌ Usage: `!set <key> <value>`'; break; }
      db.setSetting(key, value);
      reply = `✅ \`${key}\` set to \`${value}\``;
      break;
    }
    case 'contacts': {
      const contacts = db.getContacts().slice(0, 30);
      if (!contacts.length) { reply = 'No contacts yet.'; break; }
      reply = `*Known contacts (${contacts.length}):*\n` +
        contacts.map(c => `• ${c.name || c.jid}`).join('\n');
      break;
    }
    case 'status': {
      const statuses = db.getSessionStatus();
      reply = '*Bot Status:*\n' +
        statuses.map(s =>
          `• ${s.bot.toUpperCase()}: ${s.connected ? '🟢 Connected' : '🔴 Disconnected'}${s.phone ? ` (${s.phone})` : ''}`
        ).join('\n');
      break;
    }
    case 'help': {
      reply = `*Available Commands:*
• \`!mirror on/off\` — toggle message forwarding
• \`!filter add <jid> [reason]\` — filter a contact
• \`!filter remove <jid>\` — remove filter
• \`!filter list\` — list all filters
• \`!settings\` — view all settings
• \`!set <key> <value>\` — change a setting
• \`!contacts\` — list known contacts
• \`!status\` — check bot connections
• \`!help\` — this menu

_Setting keys:_ forwarder_enabled, include_groups, include_self_messages, include_reactions, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, message_prefix_format (full/compact)`;
      break;
    }
    default:
      reply = `Unknown command. Try \`!help\``;
  }

  if (reply) await sock.sendMessage(masterJid, { text: reply });
}

function normalizeJid(input) {
  if (!input) return null;
  if (input.includes('@')) return input;
  const digits = input.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

// ─── HTTP control server ──────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    if (sock) { sock.logout().catch(() => {}); sock.end(undefined); }
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/settings') {
    res.end(JSON.stringify(db.getAllSettings()));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/settings') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        for (const [k, v] of Object.entries(updates)) db.setSetting(k, v);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/filters') {
    res.end(JSON.stringify(db.getFilters()));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/filters') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { action, jid, reason } = JSON.parse(body);
        if (action === 'add')    db.addFilter(jid, reason);
        if (action === 'remove') db.removeFilter(jid);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/contacts') {
    res.end(JSON.stringify(db.getContacts()));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/messages') {
    const limit = parseInt(url.searchParams.get('limit') || '50');
    res.end(JSON.stringify(db.getRecentMessages(limit)));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, async () => {
  console.log(`[MASTER] Control server on :${PORT}`);

  // Restore session from MySQL into local folder, then connect
  const restored = await restoreSession('master', SESSION_DIR);
  if (restored) {
    console.log('[MASTER] Session restored from MySQL, reconnecting...');
    connect(false, null);
  } else {
    console.log('[MASTER] No session in MySQL. Use dashboard to pair.');
  }
});

module.exports = { masterEvents, connect };