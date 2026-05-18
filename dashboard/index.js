// dashboard/index.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');

const db = require('../shared/db');

const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT || '3000');

const SLAVE_URL = `http://localhost:${process.env.SLAVE_PORT || 3001}`;
const MASTER_URL = `http://localhost:${process.env.MASTER_PORT || 3002}`;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Proxy helper ─────────────────────────────────────────────────────────────

function proxyRequest(targetUrl, req, res) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        res.status(proxyRes.statusCode).json(JSON.parse(data || '{}'));
        resolve();
      });
    });

    proxyReq.on('error', (e) => {
      res.status(502).json({ error: 'Bot offline', details: e.message });
      resolve();
    });

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      proxyReq.write(JSON.stringify(req.body));
    }

    proxyReq.end();
  });
}

// ─── Status endpoint ──────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const statuses = db.getSessionStatus();
  const statusMap = Object.fromEntries(statuses.map(s => [s.bot, s]));

  // Also ping each bot
  const ping = (url) => new Promise((resolve) => {
    const req = http.get(`${url}/status`, { timeout: 3000 }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });

  const [slaveStatus, masterStatus] = await Promise.all([
    ping(SLAVE_URL),
    ping(MASTER_URL),
  ]);

  res.json({
    slave: { ...statusMap.slave, live: slaveStatus },
    master: { ...statusMap.master, live: masterStatus },
    settings: db.getAllSettings(),
  });
});

// ─── QR code as image ─────────────────────────────────────────────────────────

app.get('/api/:bot/qr-image', async (req, res) => {
  const bot = req.params.bot;
  const baseUrl = bot === 'slave' ? SLAVE_URL : MASTER_URL;

  const qrData = await new Promise((resolve) => {
    http.get(`${baseUrl}/qr`, { timeout: 5000 }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    }).on('error', () => resolve({}));
  });

  if (!qrData.qr) {
    res.status(404).json({ error: 'No QR available' });
    return;
  }

  try {
    const png = await QRCode.toBuffer(qrData.qr, {
      type: 'png',
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.end(png);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Proxy routes ──────────────────────────────────────────────────────────────

// Slave
app.all('/api/slave/*', (req, res) => {
  const subPath = req.path.replace('/api/slave', '');
  proxyRequest(`${SLAVE_URL}${subPath}`, req, res);
});

// Master
app.all('/api/master/*', (req, res) => {
  const subPath = req.path.replace('/api/master', '');
  proxyRequest(`${MASTER_URL}${subPath}`, req, res);
});

// ─── Direct DB API ────────────────────────────────────────────────────────────

app.get('/api/messages', (req, res) => {
  const limit = parseInt(req.query.limit || '50');
  res.json(db.getRecentMessages(limit));
});

app.get('/api/filters', (req, res) => {
  res.json(db.getFilters());
});

app.post('/api/filters', (req, res) => {
  const { action, jid, reason } = req.body;
  if (action === 'add') db.addFilter(jid, reason || '');
  else if (action === 'remove') db.removeFilter(jid);
  res.json({ ok: true });
});

app.get('/api/conversations', (req, res) => {
  // Get last 500 messages so we have enough history for all chats
  const msgs = db.getRecentMessages(500);
  // Return them oldest-first so chat UI can build timeline correctly
  res.json(msgs.reverse());
});

app.get('/api/contacts', (req, res) => {
  res.json(db.getContacts());
});

app.get('/api/settings', (req, res) => {
  res.json(db.getAllSettings());
});

app.post('/api/settings', (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    db.setSetting(k, String(v));
  }
  res.json({ ok: true });
});

// Serve dashboard for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[DASHBOARD] Running on http://localhost:${PORT}`);
});
