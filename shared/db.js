// shared/db.js — SQLite database shared between slave and master
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/mirror.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    -- Messages forwarded from slave
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      jid         TEXT NOT NULL,
      sender_jid  TEXT NOT NULL,
      sender_name TEXT,
      body        TEXT,
      type        TEXT DEFAULT 'text',
      timestamp   INTEGER NOT NULL,
      is_from_me  INTEGER DEFAULT 0,
      forwarded   INTEGER DEFAULT 0,
      master_msg_id TEXT,
      media_path  TEXT,
      mime_type   TEXT,
      is_view_once INTEGER DEFAULT 0,
      raw_json    TEXT
    );

    -- Reactions seen on slave
    CREATE TABLE IF NOT EXISTS reactions (
      id            TEXT PRIMARY KEY,
      message_id    TEXT NOT NULL,
      reactor_jid   TEXT NOT NULL,
      emoji         TEXT,
      timestamp     INTEGER NOT NULL,
      applied        INTEGER DEFAULT 0
    );

    -- Contacts saved on slave (populated when messages arrive)
    CREATE TABLE IF NOT EXISTS contacts (
      jid           TEXT PRIMARY KEY,
      name          TEXT,
      notify        TEXT,
      updated_at    INTEGER
    );

    -- Filter list — contacts whose messages are suppressed
    CREATE TABLE IF NOT EXISTS filters (
      jid           TEXT PRIMARY KEY,
      reason        TEXT,
      added_at      INTEGER DEFAULT (strftime('%s','now'))
    );

    -- Settings key-value store
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Session status for dashboard
    CREATE TABLE IF NOT EXISTS session_status (
      bot       TEXT PRIMARY KEY,
      connected INTEGER DEFAULT 0,
      phone     TEXT,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    -- Default settings
    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('forwarder_enabled', 'true'),
      ('master_jid', ''),
      ('slave_device_name', 'iPhone 15'),
      ('include_self_messages', 'true'),
      ('include_groups', 'true'),
      ('include_reactions', 'true'),
      ('quiet_hours_enabled', 'false'),
      ('quiet_hours_start', '23:00'),
      ('quiet_hours_end', '07:00'),
      ('message_prefix_format', 'full');

    INSERT OR IGNORE INTO session_status (bot, connected) VALUES ('slave', 0), ('master', 0);
  `);

  // Migrations — safe to run on existing DBs
  const cols = db.prepare("PRAGMA table_info(messages)").all().map(r => r.name);
  if (!cols.includes('media_path'))   db.exec("ALTER TABLE messages ADD COLUMN media_path TEXT");
  if (!cols.includes('mime_type'))    db.exec("ALTER TABLE messages ADD COLUMN mime_type TEXT");
  if (!cols.includes('is_view_once')) db.exec("ALTER TABLE messages ADD COLUMN is_view_once INTEGER DEFAULT 0");
}

// ─── Settings helpers ────────────────────────────────────────────────────────

function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ─── Filter helpers ──────────────────────────────────────────────────────────

function isFiltered(jid) {
  const db = getDb();
  return !!db.prepare('SELECT 1 FROM filters WHERE jid = ?').get(jid);
}

function addFilter(jid, reason = '') {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO filters (jid, reason) VALUES (?, ?)').run(jid, reason);
}

function removeFilter(jid) {
  const db = getDb();
  db.prepare('DELETE FROM filters WHERE jid = ?').run(jid);
}

function getFilters() {
  const db = getDb();
  return db.prepare('SELECT f.jid, f.reason, f.added_at, c.name FROM filters f LEFT JOIN contacts c ON f.jid = c.jid').all();
}

// ─── Message helpers ─────────────────────────────────────────────────────────

function saveMessage(msg) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, jid, sender_jid, sender_name, body, type, timestamp, is_from_me, media_path, mime_type, is_view_once, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id, msg.jid, msg.senderJid, msg.senderName, msg.body, msg.type,
    msg.timestamp, msg.isFromMe ? 1 : 0,
    msg.mediaPath || null, msg.mimeType || null, msg.isViewOnce ? 1 : 0,
    msg.rawJson || null
  );
}

function updateMediaPath(id, mediaPath, mimeType) {
  const db = getDb();
  db.prepare('UPDATE messages SET media_path = ?, mime_type = ? WHERE id = ?').run(mediaPath, mimeType, id);
}

function markForwarded(id, masterMsgId) {
  const db = getDb();
  db.prepare('UPDATE messages SET forwarded = 1, master_msg_id = ? WHERE id = ?').run(masterMsgId, id);
}

function getPendingMessages() {
  const db = getDb();
  return db.prepare('SELECT * FROM messages WHERE forwarded = 0 ORDER BY timestamp ASC LIMIT 50').all();
}

function getMessageByMasterMsgId(masterMsgId) {
  const db = getDb();
  return db.prepare('SELECT * FROM messages WHERE master_msg_id = ?').get(masterMsgId);
}

function getMessageById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

// ─── Reaction helpers ────────────────────────────────────────────────────────

function saveReaction(reaction) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO reactions (id, message_id, reactor_jid, emoji, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(reaction.id, reaction.messageId, reaction.reactorJid, reaction.emoji, reaction.timestamp);
}

function getPendingReactions() {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, m.master_msg_id FROM reactions r
    JOIN messages m ON r.message_id = m.id
    WHERE r.applied = 0 AND m.master_msg_id IS NOT NULL
    ORDER BY r.timestamp ASC LIMIT 50
  `).all();
}

function markReactionApplied(id) {
  const db = getDb();
  db.prepare('UPDATE reactions SET applied = 1 WHERE id = ?').run(id);
}

// ─── Contact helpers ─────────────────────────────────────────────────────────

function upsertContact(jid, name, notify) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO contacts (jid, name, notify, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
  `).run(jid, name || null, notify || null);
}

function getContact(jid) {
  const db = getDb();
  return db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid);
}

function getContacts() {
  const db = getDb();
  return db.prepare('SELECT * FROM contacts ORDER BY name').all();
}

// ─── Session status ──────────────────────────────────────────────────────────

function setSessionStatus(bot, connected, phone = null) {
  const db = getDb();
  db.prepare(`
    UPDATE session_status SET connected = ?, phone = ?, updated_at = strftime('%s','now') WHERE bot = ?
  `).run(connected ? 1 : 0, phone, bot);
}

function getSessionStatus() {
  const db = getDb();
  return db.prepare('SELECT * FROM session_status').all();
}

// ─── Recent messages for dashboard ──────────────────────────────────────────

function getRecentMessages(limit = 50) {
  const db = getDb();
  return db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?').all(limit);
}

module.exports = {
  getDb,
  getSetting, setSetting, getAllSettings,
  isFiltered, addFilter, removeFilter, getFilters,
  saveMessage, updateMediaPath, markForwarded, getPendingMessages, getMessageByMasterMsgId, getMessageById,
  saveReaction, getPendingReactions, markReactionApplied,
  upsertContact, getContact, getContacts,
  setSessionStatus, getSessionStatus,
  getRecentMessages,
};