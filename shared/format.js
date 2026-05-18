// shared/format.js — Message formatting utilities

/**
 * Format a message for forwarding to the master group.
 * Format: *Name* · 10:35 AM\nmessage body
 */
function formatMessage(msg, format = 'full') {
  const time = formatTime(msg.timestamp);
  const name = msg.sender_name || msg.sender_jid?.split('@')[0] || 'Unknown';
  const body = msg.body || '[media/unsupported]';

  if (format === 'compact') {
    return `[${time}] *${name}:* ${body}`;
  }

  // full (default)
  const prefix = msg.is_from_me ? '📤 *You (slave)*' : `👤 *${name}*`;
  return `${prefix}  ·  _${time}_\n${body}`;
}

/**
 * Format a timestamp (unix seconds) to readable time
 */
function formatTime(timestamp) {
  const d = new Date(timestamp * 1000);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: process.env.TZ || 'Africa/Accra',
  });
}

/**
 * Format a timestamp to date + time
 */
function formatDateTime(timestamp) {
  const d = new Date(timestamp * 1000);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: process.env.TZ || 'Africa/Accra',
  });
}

/**
 * Extract text body from a Baileys message.
 * Returns caption for media, or a descriptive label for non-text types.
 */
function extractBody(message) {
  if (!message) return null;

  // View-once (image or video) — grab caption if any, flag in label
  const viewOnceV2 = message.viewOnceMessageV2?.message || message.viewOnceMessage?.message;
  if (viewOnceV2) {
    const caption = viewOnceV2.imageMessage?.caption || viewOnceV2.videoMessage?.caption || '';
    const kind = viewOnceV2.videoMessage ? 'video' : 'image';
    return caption ? `🔥 *View once ${kind}:* ${caption}` : `🔥 *View once ${kind}*`;
  }

  // Plain text
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;

  // Media with optional captions
  if (message.imageMessage)    return message.imageMessage.caption    || '📷 *Image*';
  if (message.videoMessage)    return message.videoMessage.caption    || '🎥 *Video*';
  if (message.audioMessage)    return message.audioMessage.ptt        ? '🎤 *Voice note*' : '🎵 *Audio*';
  if (message.documentMessage) {
    const fn = message.documentMessage.fileName || 'file';
    return `📄 *Document:* ${fn}`;
  }
  if (message.stickerMessage)  return '🎨 *Sticker*';
  if (message.contactMessage)  return `👤 *Contact:* ${message.contactMessage.displayName || ''}`;
  if (message.locationMessage) {
    const { degreesLatitude: lat, degreesLongitude: lng, name } = message.locationMessage;
    return name ? `📍 *Location:* ${name}` : `📍 *Location:* ${lat?.toFixed(5)}, ${lng?.toFixed(5)}`;
  }
  if (message.liveLocationMessage) return '📍 *Live Location*';
  if (message.pollCreationMessage) return `📊 *Poll:* ${message.pollCreationMessage.name || ''}`;
  if (message.buttonsResponseMessage) return message.buttonsResponseMessage.selectedButtonId;
  if (message.listResponseMessage)    return message.listResponseMessage.singleSelectReply?.selectedRowId;
  if (message.templateButtonReplyMessage) return message.templateButtonReplyMessage.selectedId;

  return null;
}

/**
 * Determine message type
 */
function getMessageType(message) {
  if (!message) return 'unknown';
  if (message.viewOnceMessageV2 || message.viewOnceMessage) {
    const inner = (message.viewOnceMessageV2 || message.viewOnceMessage).message;
    return inner?.videoMessage ? 'view_once_video' : 'view_once_image';
  }
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage)    return 'image';
  if (message.videoMessage)    return 'video';
  if (message.audioMessage)    return message.audioMessage.ptt ? 'ptt' : 'audio';
  if (message.documentMessage) return 'document';
  if (message.stickerMessage)  return 'sticker';
  if (message.reactionMessage) return 'reaction';
  if (message.contactMessage)  return 'contact';
  if (message.locationMessage || message.liveLocationMessage) return 'location';
  if (message.pollCreationMessage) return 'poll';
  return 'other';
}

/**
 * Is current time in quiet hours?
 */
function isQuietHours(startStr, endStr) {
  const now = new Date();
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const current = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;

  if (start <= end) return current >= start && current < end;
  // Overnight range (e.g., 23:00 – 07:00)
  return current >= start || current < end;
}

module.exports = { formatMessage, formatTime, formatDateTime, extractBody, getMessageType, isQuietHours };