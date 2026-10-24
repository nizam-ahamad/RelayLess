# Relayless P2P File Sharing

Relayless is a dark-mode-first progressive web app for direct browser-to-browser file sharing. The Node server is a signaling and pairing broker only: it never receives, stores, or forwards file bytes.

## Architecture

- **Client:** React + Vite, Socket.IO client, native `RTCPeerConnection` and ordered `RTCDataChannel`.
- **Server:** Express + Socket.IO, in-memory peer/PIN/pairing state with automatic PIN rotation.
- **Large files:** Files are sliced into 64 KiB chunks. The sender stops reading when the data channel exceeds 8 MiB of queued data and resumes on `bufferedamountlow`. Receivers use `showSaveFilePicker()` and write each chunk immediately to a `FileSystemWritableFileStream`.
- **Privacy:** The server handles only WebSocket signaling, pairing, heartbeats, and short-lived session metadata. It does not implement an upload endpoint.

## Requirements

- Node.js 20 or newer.
- A modern browser with WebRTC. Chrome and Edge provide the best experience for multi-gigabyte receiving because they support the File System Access API.
- HTTPS in production for camera access, service workers, and reliable browser APIs. `localhost` is treated as secure for local development.

## Run locally

```bash
npm install
npm run dev
```

- Open the Vite client at `http://localhost:5173`.
- The signaling server listens on `http://localhost:3001`.
- The root `npm run dev` starts both processes. `npm test` runs the server unit tests.

## Production

Build the client and start the server from the repository root:

```bash
npm install
npm run build
npm start
```

When `client/dist` exists, the server serves the built PWA and keeps Socket.IO on the same origin. Set `PORT` when the host provides one. `CLIENT_ORIGIN` can be a comma-separated list of allowed origins; it defaults to permissive CORS for simple local and static-host deployments.

`PIN_TTL_MS` is optional and defaults to `120000` (two minutes). It is useful for controlled QA sessions without changing the production default.

The included `render.yaml` uses the `/ping` endpoint for health checks. An external uptime monitor can request `/ping` every 10–14 minutes if a free container needs a keep-alive.

## Pairing flow

1. Each browser receives a UUID peer ID and rotating six-character PIN.
2. A user enters the other PIN or scans its `?pair=<peerId>` QR link.
3. Both devices see the same two-digit confirmation code and must allow the request.
4. The requester creates the WebRTC offer; the receiver creates the answer. SDP and ICE candidates are relayed through Socket.IO only.
5. Once the ordered data channel is open, files stream directly between the devices.

## Browser fallback

Browsers without `showSaveFilePicker()` use a locally hosted StreamSaver service-worker pipe so chunks continue streaming to the browser's download destination instead of being assembled into a Blob. The app still shows a clear warning for files over 2 GiB because browser download managers and service-worker support vary; use Chrome or Edge for the most reliable very-large-file experience.

## Deployment note

The provided free-tier deployment is suitable for signaling but is not a TURN server. WebRTC usually connects directly through STUN; restrictive corporate or symmetric NAT networks may need a TURN service added to `ICE_SERVERS` in `client/src/services/webrtc.js`.
