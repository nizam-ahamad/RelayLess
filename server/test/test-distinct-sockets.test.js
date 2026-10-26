import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { registerSignalingHandlers } from '../src/handlers/signalingHandler.js';
import { PeerManager } from '../src/managers/peerManager.js';
import { PinManager } from '../src/managers/pinManager.js';
import { PairingRateLimiter } from '../src/managers/rateLimiter.js';

test('Guarantees distinct partner sockets and bidirectional webrtc signal relay', async () => {
  const pinManager = new PinManager({ ttlMs: 60_000 });
  const peerManager = new PeerManager({ pinManager });
  const rateLimiter = new PairingRateLimiter();

  const httpServer = createServer();
  const ioServer = new SocketIOServer(httpServer, {
    cors: { origin: '*' }
  });

  registerSignalingHandlers(ioServer, peerManager, rateLimiter);

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const serverUrl = `http://localhost:${port}`;

  const socketA = ioClient(serverUrl, { transports: ['websocket'] });
  const socketB = ioClient(serverUrl, { transports: ['websocket'] });

  try {
    // 1. Wait for both peers to be ready
    const [peerA, peerB] = await Promise.all([
      new Promise((resolve) => socketA.once('peer_ready', resolve)),
      new Promise((resolve) => socketB.once('peer_ready', resolve))
    ]);

    assert.ok(peerA.pin);
    assert.ok(peerB.pin);
    assert.notEqual(socketA.id, socketB.id, 'Socket A and Socket B must have distinct socket IDs');

    // 2. Socket A requests pairing with Socket B's PIN
    const promptPromiseA = new Promise((resolve) => socketA.once('pairing_prompt', resolve));
    const promptPromiseB = new Promise((resolve) => socketB.once('pairing_prompt', resolve));

    socketA.emit('request_pairing', { pin: peerB.pin, deviceName: 'Device A' });

    const [promptA, promptB] = await Promise.all([promptPromiseA, promptPromiseB]);
    assert.equal(promptA.pairingId, promptB.pairingId);

    // 3. Both accept pairing
    const confirmedPromiseA = new Promise((resolve) => socketA.once('pairing_confirmed', resolve));
    const confirmedPromiseB = new Promise((resolve) => socketB.once('pairing_confirmed', resolve));

    socketA.emit('pairing_response', { pairingId: promptA.pairingId, accepted: true });
    socketB.emit('pairing_response', { pairingId: promptB.pairingId, accepted: true });

    const [confirmedA, confirmedB] = await Promise.all([confirmedPromiseA, confirmedPromiseB]);

    // 4. Assert distinct partnerSocketId
    assert.equal(confirmedA.role, 'initiator');
    assert.equal(confirmedB.role, 'receiver');

    assert.equal(confirmedA.partnerSocketId, socketB.id, 'Socket A partnerSocketId must match Socket B id');
    assert.equal(confirmedB.partnerSocketId, socketA.id, 'Socket B partnerSocketId must match Socket A id');
    assert.notEqual(confirmedA.partnerSocketId, socketA.id, 'Socket A partnerSocketId must not be its own socket ID');
    assert.notEqual(confirmedB.partnerSocketId, socketB.id, 'Socket B partnerSocketId must not be its own socket ID');

    // 5. Emit offer from Socket A and verify Socket B receives it
    const signalReceivedByB = new Promise((resolve) => {
      socketB.once('webrtc_signal', resolve);
    });

    socketA.emit('webrtc_signal', {
      targetSocketId: confirmedA.partnerSocketId,
      signal: { type: 'offer', sdp: 'v=0\r\no=alice 123 2 IN IP4 127.0.0.1' }
    });

    const receivedOffer = await signalReceivedByB;
    assert.equal(receivedOffer.senderSocketId, socketA.id);
    assert.equal(receivedOffer.signal?.type || receivedOffer.type, 'offer');

    // 6. Emit answer from Socket B and verify Socket A receives it
    const signalReceivedByA = new Promise((resolve) => {
      socketA.once('webrtc_signal', resolve);
    });

    socketB.emit('webrtc_signal', {
      targetSocketId: confirmedB.partnerSocketId,
      signal: { type: 'answer', sdp: 'v=0\r\no=bob 456 2 IN IP4 127.0.0.1' }
    });

    const receivedAnswer = await signalReceivedByA;
    assert.equal(receivedAnswer.senderSocketId, socketB.id);
    assert.equal(receivedAnswer.signal?.type || receivedAnswer.type, 'answer');

    // 7. Assert self-loop signaling is blocked
    let selfLoopReceived = false;
    socketA.once('webrtc_signal', () => {
      selfLoopReceived = true;
    });

    socketA.emit('webrtc_signal', {
      targetSocketId: socketA.id,
      signal: { type: 'self-test' }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(selfLoopReceived, false, 'Self-targeted signaling should be dropped by the server');
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await new Promise((resolve) => ioServer.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
