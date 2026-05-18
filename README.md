# WhatsApp Mirror

A two-device WhatsApp mirroring system. The **slave** silently receives messages on a linked device. The **master** forwards them to a WhatsApp group you control.

---

## Architecture

```
┌─────────────┐     SQLite DB      ┌──────────────┐
│  Slave Bot  │ ──────────────── ► │  Master Bot  │
│  (stealth)  │     /data/         │  (forwarder) │
└─────────────┘                    └──────────────┘
       │                                  │
       └──────────── Dashboard ───────────┘
                   (port 3000)
```

- **Slave** — Linked as an innocuous device (e.g. "iPhone 15"). Captures all messages and writes them to a shared SQLite database. No bot signature.
- **Master** — Reads the database every 2 seconds and forwards unsent messages to your designated WhatsApp group. Listens for `!commands` from that group.
- **Dashboard** — Web UI at port 3000 for pairing both devices (QR or phone number), managing settings, filters, and viewing logs.

---

## Quick Start (Local)

### 1. Clone and install

```bash
git clone <your-repo>
cd whatsapp-mirror
cp .env.example .env
npm run install:all
```

### 2. Configure `.env`

```
DB_PATH=./data/mirror.db
SLAVE_AUTH_DIR=./data/slave-auth
MASTER_AUTH_DIR=./data/master-auth
TZ=Africa/Accra
```

### 3. Run

```bash
npm start
```

Open `http://localhost:3000`

### 4. Pair devices

1. Go to **Slave Device** → click **Pair Device**
2. Choose QR or Phone Number method
3. Open WhatsApp on the slave phone → Linked Devices → scan or enter code
4. Repeat for **Master Device** with the master phone number
5. Set the **Target Group** JID on the Overview page

**Finding the group JID:** In the master group, forward any message to yourself from that group. The JID is visible when you inspect the message on WhatsApp Web — it ends in `@g.us`.

---

## Deploy on Railway (Recommended — has persistent disk)

### Why Railway?

Railway gives you a **persistent volume** (`/data`) that survives restarts. Your Baileys auth files stay intact. Render's free tier doesn't have this.

### Steps

1. Create a [Railway](https://railway.app) account
2. New Project → Deploy from GitHub repo
3. Add a **Volume** in Railway dashboard → mount at `/data`
4. Set environment variables (copy from `.env.example`)
5. Railway will auto-deploy using `railway.toml`

### Environment variables to set in Railway:

| Key | Value |
|-----|-------|
| `DB_PATH` | `/data/mirror.db` |
| `SLAVE_AUTH_DIR` | `/data/slave-auth` |
| `MASTER_AUTH_DIR` | `/data/master-auth` |
| `DASHBOARD_PORT` | `3000` |
| `SLAVE_PORT` | `3001` |
| `MASTER_PORT` | `3002` |
| `TZ` | `Africa/Accra` |
| `POLL_INTERVAL` | `2000` |

Railway exposes port 3000 by default — your dashboard will be at the auto-generated Railway URL.

---

## Render (Alternative — Always On required)

If using Render:
- Use the **paid plan** (Always On) so it doesn't spin down
- Auth files won't survive monthly restarts without a persistent disk add-on
- You'll need to re-pair after each restart

To minimize re-pairing on Render: use the **phone number pairing** method instead of QR — it's faster to redo.

---

## Master Group Commands

Send these from the **master number** inside the **target group**:

| Command | Description |
|---------|-------------|
| `!mirror on` / `!mirror off` | Toggle forwarding on/off |
| `!filter add <phone>` | Mute a contact (no more messages from them) |
| `!filter remove <phone>` | Unmute a contact |
| `!filter list` | List all filtered contacts |
| `!settings` | View all current settings |
| `!set <key> <value>` | Change any setting |
| `!contacts` | List known contacts from slave |
| `!status` | Check connection status of both bots |
| `!help` | Show command menu |

### Setting keys

| Key | Values | Description |
|-----|--------|-------------|
| `forwarder_enabled` | `true` / `false` | Master enable/disable |
| `include_groups` | `true` / `false` | Forward group messages |
| `include_self_messages` | `true` / `false` | Include messages sent by slave |
| `include_reactions` | `true` / `false` | Mirror reactions |
| `quiet_hours_enabled` | `true` / `false` | Enable quiet hours |
| `quiet_hours_start` | `HH:MM` | e.g. `23:00` |
| `quiet_hours_end` | `HH:MM` | e.g. `07:00` |
| `message_prefix_format` | `full` / `compact` | Message display format |

---

## Message Format

**Full (default):**
```
👤 *John Doe*  ·  _10:35 AM_
Hey, are you coming tonight?
```

**Compact:**
```
[10:35 AM] John Doe: Hey, are you coming tonight?
```

Self-messages:
```
📤 *You (slave)*  ·  _10:36 AM_
Yes, I'll be there at 8
```

---

## Project Structure

```
whatsapp-mirror/
├── slave/          Slave bot (stealth, Baileys)
├── master/         Master bot (forwarder + commands)
├── shared/         Shared DB + utilities
├── dashboard/      Web UI + Express server
│   └── public/     HTML dashboard
├── scripts/        Process manager
├── data/           Runtime data (gitignored)
│   ├── mirror.db
│   ├── slave-auth/
│   └── master-auth/
├── .env.example
├── railway.toml
└── README.md
```

---

## Security Notes

- The dashboard has no authentication by default. Add HTTP basic auth or an IP allowlist via a reverse proxy (nginx, Cloudflare Access) before exposing publicly.
- The slave bot leaves zero bot signatures in its connection metadata.
- Auth files in `/data` contain session credentials — keep them private.
