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

import { PairingRateLimiter } from './managers/rateLimiter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const clientDist = join(projectRoot, 'client', 'dist');
const port = Number(process.env.PORT ?? 3001);
const pinTtlMs = Number(process.env.PIN_TTL_MS ?? 120_000);
const isProduction = process.env.NODE_ENV === 'production';

// Parse configured origins from environment (comma-delimited)
const configuredOrigins = String(process.env.CLIENT_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// Development defaults
const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];

const allowedOrigins = new Set(
  isProduction
    ? configuredOrigins
    : [...devOrigins, ...configuredOrigins]
);

const isOriginAllowed = (origin) => {
  // Allow requests with no origin (curl, same-origin navigations, health checks)
  if (!origin) {
    return true;
  }

  const normalized = origin.trim().replace(/\/+$/, '');
  if (allowedOrigins.has(normalized)) {
    return true;
  }

  // Support Render automatic service URL if present
  if (process.env.RENDER_EXTERNAL_URL) {
    try {
      const renderHost = new URL(process.env.RENDER_EXTERNAL_URL).host;
      if (new URL(normalized).host === renderHost) {
        return true;
      }
    } catch {}
  }

  // In development, allow any localhost/127.0.0.1 port
  if (!isProduction) {
    if (normalized.startsWith('http://localhost:') || normalized.startsWith('http://127.0.0.1:')) {
      return true;
    }
  }

  return false;
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
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
const rateLimiter = new PairingRateLimiter({
  windowMs: 60_000,
  maxFailedAttempts: 5
});

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

registerSignalingHandlers(io, peerManager, rateLimiter);

const shutdown = () => {
  io.close();
  peerManager.destroy();
  pinManager.destroy();
  rateLimiter.destroy();
  httpServer.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`P2P signaling server listening on port ${port}`);
});
