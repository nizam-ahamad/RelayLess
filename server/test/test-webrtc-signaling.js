import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { registerSignalingHandlers } from '../src/handlers/signalingHandler.js';
import { PeerManager } from '../src/managers/peerManager.js';
import { PinManager } from '../src/managers/pinManager.js';
import { PairingRateLimiter } from '../src/managers/rateLimiter.js';

test('End-to-end signaling relays offer, answer, and ICE candidates bidirectionally', async () => {
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
    assert.equal(confirmedA.role, 'initiator');
    assert.equal(confirmedB.role, 'receiver');

    // 4. Test Initiator -> Receiver Offer Relay
    const offerReceivedByB = new Promise((resolve) => {
      socketB.once('webrtc_signal', (payload) => resolve(payload));
    });

    socketA.emit('webrtc_signal', {
      pairingId: confirmedA.pairingId,
      signal: { type: 'offer', sdp: 'v=0\r\no=initiator 12345 2 IN IP4 127.0.0.1' }
    });

    const receivedOffer = await offerReceivedByB;
    assert.equal(receivedOffer.signal.type, 'offer');
    assert.equal(receivedOffer.signal.sdp, 'v=0\r\no=initiator 12345 2 IN IP4 127.0.0.1');

    // 5. Test Receiver -> Initiator Answer Relay
    const answerReceivedByA = new Promise((resolve) => {
      socketA.once('webrtc_signal', (payload) => resolve(payload));
    });

    socketB.emit('webrtc_signal', {
      pairingId: confirmedB.pairingId,
      signal: { type: 'answer', sdp: 'v=0\r\no=receiver 67890 2 IN IP4 127.0.0.1' }
    });

    const receivedAnswer = await answerReceivedByA;
    assert.equal(receivedAnswer.signal.type, 'answer');
    assert.equal(receivedAnswer.signal.sdp, 'v=0\r\no=receiver 67890 2 IN IP4 127.0.0.1');

    // 6. Test Bidirectional ICE Candidate Relay
    const candidateReceivedByB = new Promise((resolve) => {
      socketB.once('webrtc_signal', (payload) => resolve(payload));
    });

    socketA.emit('webrtc_signal', {
      pairingId: confirmedA.pairingId,
      signal: { type: 'candidate', candidate: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 } }
    });

    const receivedCandidateB = await candidateReceivedByB;
    assert.equal(receivedCandidateB.signal.type, 'candidate');
    assert.equal(receivedCandidateB.signal.candidate.candidate, 'candidate:1 1 UDP 2122260223 192.168.1.100 50000 typ host');

    const candidateReceivedByA = new Promise((resolve) => {
      socketA.once('webrtc_signal', (payload) => resolve(payload));
    });

    socketB.emit('webrtc_signal', {
      pairingId: confirmedB.pairingId,
      signal: { type: 'candidate', candidate: { candidate: 'candidate:2 1 UDP 2122260223 10.0.0.5 50001 typ host', sdpMid: '0', sdpMLineIndex: 0 } }
    });

    const receivedCandidateA = await candidateReceivedByA;
    assert.equal(receivedCandidateA.signal.type, 'candidate');
    assert.equal(receivedCandidateA.signal.candidate.candidate, 'candidate:2 1 UDP 2122260223 10.0.0.5 50001 typ host');

    console.log('✔ All end-to-end signaling relay checks succeeded');
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    ioServer.close();
    await new Promise((resolve) => httpServer.close(resolve));
    peerManager.destroy();
    pinManager.destroy();
    rateLimiter.destroy();
  }
});
