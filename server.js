const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// Ensure data directory exists
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Database ───
const db = new Database(path.join(DATA_DIR, 'scores.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_name TEXT NOT NULL,
    partner_name TEXT,
    mode TEXT NOT NULL CHECK(mode IN ('solo','coop')),
    result TEXT NOT NULL CHECK(result IN ('win','loss')),
    score INTEGER NOT NULL,
    max_combo INTEGER NOT NULL DEFAULT 0,
    time_ms INTEGER NOT NULL,
    hull_percent INTEGER NOT NULL DEFAULT 0,
    ip_hash TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scores_ranking ON scores(result, score DESC, time_ms ASC);
  CREATE INDEX IF NOT EXISTS idx_scores_mode ON scores(mode);
`);

const insertScore = db.prepare(`
  INSERT INTO scores (player_name, partner_name, mode, result, score, max_combo, time_ms, hull_percent, ip_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ─── Express ───
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit tracking (ip -> last submission timestamp)
const rateLimits = new Map();

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip + 'void-defender-salt').digest('hex').slice(0, 16);
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

// POST /api/scores
app.post('/api/scores', (req, res) => {
  const ip = getClientIP(req);
  const now = Date.now();

  // Rate limit: 1 per 10 seconds per IP
  const lastSubmit = rateLimits.get(ip);
  if (lastSubmit && now - lastSubmit < 10000) {
    return res.status(429).json({ error: 'Too many submissions. Wait 10 seconds.' });
  }

  const { playerName, partnerName, mode, result, score, maxCombo, timeMs, hullPercent } = req.body;

  // Validation
  if (!playerName || typeof playerName !== 'string' || playerName.trim().length < 1 || playerName.trim().length > 20) {
    return res.status(400).json({ error: 'playerName must be 1-20 characters.' });
  }
  if (!/^[a-zA-Z0-9 _\-]+$/.test(playerName.trim())) {
    return res.status(400).json({ error: 'playerName must be alphanumeric (spaces, hyphens, underscores allowed).' });
  }
  if (partnerName != null && (typeof partnerName !== 'string' || partnerName.trim().length > 20)) {
    return res.status(400).json({ error: 'partnerName must be 1-20 characters if provided.' });
  }
  if (!['solo', 'coop'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "solo" or "coop".' });
  }
  if (!['win', 'loss'].includes(result)) {
    return res.status(400).json({ error: 'result must be "win" or "loss".' });
  }
  if (typeof score !== 'number' || score < 0 || score > 80) {
    return res.status(400).json({ error: 'score must be 0-80.' });
  }
  if (typeof maxCombo !== 'number' || maxCombo < 0) {
    return res.status(400).json({ error: 'maxCombo must be >= 0.' });
  }
  if (typeof timeMs !== 'number' || timeMs <= 0) {
    return res.status(400).json({ error: 'timeMs must be > 0.' });
  }
  if (typeof hullPercent !== 'number' || hullPercent < 0 || hullPercent > 100) {
    return res.status(400).json({ error: 'hullPercent must be 0-100.' });
  }

  rateLimits.set(ip, now);

  const ipHash = hashIP(ip);
  const cleanName = playerName.trim();
  const cleanPartner = partnerName ? partnerName.trim() : null;

  const info = insertScore.run(cleanName, cleanPartner, mode, result, score, maxCombo, Math.round(timeMs), Math.round(hullPercent), ipHash);

  // Calculate rank (among same mode wins, or all if loss)
  let rank = null;
  if (result === 'win') {
    const rankRow = db.prepare(`
      SELECT COUNT(*) + 1 AS rank FROM scores
      WHERE result = 'win' AND (score > ? OR (score = ? AND time_ms < ?))
    `).get(score, score, Math.round(timeMs));
    rank = rankRow.rank;
  }

  res.json({ id: info.lastInsertRowid, rank });
});

// GET /api/scores
app.get('/api/scores', (req, res) => {
  let { mode, sort, limit } = req.query;

  limit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
  sort = sort || 'score';

  let orderBy;
  if (sort === 'time') orderBy = 'time_ms ASC, score DESC';
  else if (sort === 'combo') orderBy = 'max_combo DESC, score DESC';
  else orderBy = 'score DESC, time_ms ASC, max_combo DESC';

  let where = 'WHERE 1=1';
  const params = [];

  if (mode === 'solo' || mode === 'coop') {
    where += ' AND mode = ?';
    params.push(mode);
  }

  const rows = db.prepare(`
    SELECT id, player_name, partner_name, mode, result, score, max_combo, time_ms, hull_percent, created_at
    FROM scores ${where}
    ORDER BY result = 'win' DESC, ${orderBy}
    LIMIT ?
  `).all(...params, limit);

  // Add rank numbers
  let winRank = 0;
  const results = rows.map(row => {
    if (row.result === 'win') winRank++;
    return {
      ...row,
      rank: row.result === 'win' ? winRank : null
    };
  });

  res.json(results);
});

// ─── HTTP + WebSocket Server ───
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Rooms: Map<roomId, { host: ws, guest: ws|null, createdAt: number }>
const rooms = new Map();

// Clean up expired rooms every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 5 * 60 * 1000) {
      if (room.host?.readyState === 1) room.host.send(JSON.stringify({ type: 'error', message: 'Room expired.' }));
      if (room.guest?.readyState === 1) room.guest.send(JSON.stringify({ type: 'error', message: 'Room expired.' }));
      rooms.delete(id);
    }
  }
}, 60000);

wss.on('connection', (ws) => {
  let myRoomId = null;
  let myRole = null; // 'host' or 'guest'

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      const roomId = nanoid(6);
      rooms.set(roomId, { host: ws, guest: null, createdAt: Date.now() });
      myRoomId = roomId;
      myRole = 'host';
      ws.send(JSON.stringify({ type: 'created', roomId }));
    }

    else if (msg.type === 'join') {
      const roomId = (msg.roomId || '').trim();
      const room = rooms.get(roomId);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found.' }));
        return;
      }
      if (room.guest) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full.' }));
        return;
      }
      room.guest = ws;
      myRoomId = roomId;
      myRole = 'guest';
      // Notify both that they're paired
      if (room.host?.readyState === 1) room.host.send(JSON.stringify({ type: 'paired' }));
      ws.send(JSON.stringify({ type: 'paired' }));
    }

    else if (msg.type === 'signal') {
      if (!myRoomId) return;
      const room = rooms.get(myRoomId);
      if (!room) return;
      const peer = myRole === 'host' ? room.guest : room.host;
      if (peer?.readyState === 1) {
        peer.send(JSON.stringify({ type: 'signal', data: msg.data }));
      }
    }

    else if (msg.type === 'ready') {
      if (!myRoomId) return;
      const room = rooms.get(myRoomId);
      if (!room) return;
      if (myRole === 'host') room.hostReady = true;
      else room.guestReady = true;
      if (room.hostReady && room.guestReady) {
        rooms.delete(myRoomId);
      }
    }
  });

  ws.on('close', () => {
    if (!myRoomId) return;
    const room = rooms.get(myRoomId);
    if (!room) return;
    // If the peer hasn't joined yet, just delete the room
    if (myRole === 'host' && !room.guest) {
      rooms.delete(myRoomId);
    } else if (myRole === 'guest' && !room.hostReady) {
      // Notify host that guest disconnected
      if (room.host?.readyState === 1) {
        room.host.send(JSON.stringify({ type: 'error', message: 'Peer disconnected.' }));
      }
      room.guest = null;
    } else if (myRole === 'host' && !room.guestReady) {
      if (room.guest?.readyState === 1) {
        room.guest.send(JSON.stringify({ type: 'error', message: 'Peer disconnected.' }));
      }
      rooms.delete(myRoomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Void Defender server running on http://localhost:${PORT}`);
});
