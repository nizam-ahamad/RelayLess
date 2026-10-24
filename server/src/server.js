import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { registerSignalingHandlers } from './handlers/signalingHandler.js';
import { PeerManager } from './managers/peerManager.js';
import { PinManager } from './managers/pinManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const clientDist = join(projectRoot, 'client', 'dist');
const port = Number(process.env.PORT ?? 3001);
const pinTtlMs = Number(process.env.PIN_TTL_MS ?? 120_000);
const defaultOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const configuredOrigins = String(process.env.CLIENT_ORIGIN ?? '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = Array.from(new Set([...defaultOrigins, ...configuredOrigins.filter((o) => o !== '*')]));

const corsOptions = {
  origin: configuredOrigins.includes('*') ? true : allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST']
};

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: corsOptions,
  pingInterval: 25_000,
  pingTimeout: 60_000,
  maxHttpBufferSize: 1_000_000
});

const pinManager = new PinManager({
  ttlMs: Number.isFinite(pinTtlMs) && pinTtlMs > 0 ? pinTtlMs : 120_000
});
const peerManager = new PeerManager({ pinManager });

pinManager.onRotate = (pin) => {
  const peer = peerManager.getByPeerId(pin.peerId);
  if (peer && !peer.pairingId) {
    io.to(peer.socketId).emit('update_pin', pin);
  }
};

app.disable('x-powered-by');
app.use(cors(corsOptions));
app.use(express.json({ limit: '64kb' }));

app.get('/ping', (_request, response) => {
  response.status(200).json({
    ok: true,
    service: 'p2p-fileshare-signaling',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (_request, response) => {
  response.status(200).json({ ok: true });
});

if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: 'index.html' }));
  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/socket.io')) {
      next();
      return;
    }
    response.sendFile(join(clientDist, 'index.html'));
  });
}

registerSignalingHandlers(io, peerManager);

const shutdown = () => {
  io.close();
  peerManager.destroy();
  pinManager.destroy();
  httpServer.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`P2P signaling server listening on port ${port}`);
});
