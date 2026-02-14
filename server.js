require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');
const { nanoid, customAlphabet } = require('nanoid');

const app = express();

// Use HTTPS if local certs exist (needed for getUserMedia over LAN)
const certPath = path.join(__dirname, 'certs');
let server;
if (fs.existsSync(path.join(certPath, 'key.pem')) && fs.existsSync(path.join(certPath, 'cert.pem'))) {
  server = https.createServer({
    key: fs.readFileSync(path.join(certPath, 'key.pem')),
    cert: fs.readFileSync(path.join(certPath, 'cert.pem')),
  }, app);
  console.log('Using HTTPS (self-signed cert for LAN testing)');
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
});

const PORT = process.env.PORT || 10000;
const MAX_PARTICIPANTS = 4;

// Room ID generator — 4 digits, numeric keyboard on mobile
const generateRoomId = customAlphabet('0123456789', 4);

// In-memory room state
const rooms = new Map(); // roomId -> { participants: Set<socketId>, createdAt: Date }

// Clean up stale rooms every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.participants.size === 0 && now - room.createdAt > 3600000) {
      rooms.delete(id);
    }
  }
}, 1800000);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- REST API ---

// Create a new room
app.post('/api/rooms', (req, res) => {
  let roomId;
  let attempts = 0;
  do {
    roomId = generateRoomId();
    attempts++;
  } while (rooms.has(roomId) && attempts < 20);
  rooms.set(roomId, { participants: new Set(), createdAt: Date.now() });
  res.json({ roomId });
});

// Check room status
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({
    roomId: req.params.id,
    participants: room.participants.size,
    maxParticipants: MAX_PARTICIPANTS,
    isFull: room.participants.size >= MAX_PARTICIPANTS,
  });
});

// STUN fallback servers (multiple providers for reliability)
const STUN_FALLBACK = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Proxy TURN credentials from Metered.ca
app.get('/api/turn-credentials', async (req, res) => {
  const apiKey = process.env.METERED_API_KEY;
  const domain = process.env.METERED_DOMAIN;
  if (!apiKey || !domain) {
    return res.json(STUN_FALLBACK);
  }

  try {
    const response = await fetch(
      `https://${domain}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`
    );
    if (!response.ok) throw new Error(`Metered API error: ${response.status}`);
    const servers = await response.json();
    res.json(servers);
  } catch (err) {
    console.error('TURN credential fetch failed:', err.message);
    res.json(STUN_FALLBACK);
  }
});

// Serve room page — just 4 digits after domain, no /room/ prefix
app.get('/room/:id(\\d{4})', (req, res) => {
  res.redirect(301, `/${req.params.id}`);
});

app.get('/:id(\\d{4})', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// --- Socket.io Signaling ---

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId }) => {
    // Create room on-the-fly if it doesn't exist (for direct link sharing)
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { participants: new Set(), createdAt: Date.now() });
    }

    const room = rooms.get(roomId);

    if (room.participants.size >= MAX_PARTICIPANTS) {
      socket.emit('room-full');
      return;
    }

    // Leave previous room if any
    if (currentRoom) {
      leaveRoom(socket, currentRoom);
    }

    currentRoom = roomId;
    room.participants.add(socket.id);
    socket.join(roomId);

    // Tell the joiner who's already in the room
    const existingParticipants = [...room.participants].filter(
      (id) => id !== socket.id
    );
    socket.emit('room-joined', { participants: existingParticipants });

    // Tell existing participants about the new joiner
    socket.to(roomId).emit('participant-joined', { socketId: socket.id });

    console.log(
      `[${roomId}] ${socket.id} joined (${room.participants.size}/${MAX_PARTICIPANTS})`
    );
  });

  // Targeted signaling — relay to specific peer
  socket.on('offer', ({ target, sdp }) => {
    console.log(`[signal] offer ${socket.id} → ${target}`);
    io.to(target).emit('offer', { sender: socket.id, sdp });
  });

  socket.on('answer', ({ target, sdp }) => {
    console.log(`[signal] answer ${socket.id} → ${target}`);
    io.to(target).emit('answer', { sender: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    io.to(target).emit('ice-candidate', { sender: socket.id, candidate });
  });

  socket.on('leave-room', () => {
    if (currentRoom) {
      leaveRoom(socket, currentRoom);
      currentRoom = null;
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      leaveRoom(socket, currentRoom);
      currentRoom = null;
    }
  });

  function leaveRoom(sock, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.participants.delete(sock.id);
    sock.leave(roomId);
    sock.to(roomId).emit('participant-left', { socketId: sock.id });

    console.log(
      `[${roomId}] ${sock.id} left (${room.participants.size}/${MAX_PARTICIPANTS})`
    );

    // Clean up empty rooms after a delay
    if (room.participants.size === 0) {
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.participants.size === 0) {
          rooms.delete(roomId);
        }
      }, 300000); // 5 minutes
    }
  }
});

server.listen(PORT, async () => {
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`Alphy Chat server running on port ${PORT}`);
  console.log(`Open ${proto}://localhost:${PORT}`);

  // Check TURN configuration at startup
  const apiKey = process.env.METERED_API_KEY;
  const domain = process.env.METERED_DOMAIN;
  if (!apiKey || !domain) {
    console.warn('⚠ TURN not configured (set METERED_API_KEY + METERED_DOMAIN). Using STUN only — P2P may fail on restrictive networks.');
  } else {
    try {
      const r = await fetch(`https://${domain}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`);
      if (r.ok) {
        console.log(`✓ TURN credentials OK (${domain}.metered.live)`);
      } else {
        const body = await r.text();
        console.error(`✗ TURN credentials FAILED (${r.status}): ${body}. Check METERED_DOMAIN and METERED_API_KEY.`);
      }
    } catch (err) {
      console.error(`✗ TURN endpoint unreachable (${domain}.metered.live): ${err.message}`);
    }
  }
  if (proto === 'https') {
    const ifaces = require('os').networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`LAN: ${proto}://${addr.address}:${PORT}`);
        }
      }
    }
  }
});
