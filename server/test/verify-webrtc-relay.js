import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { registerSignalingHandlers } from '../src/handlers/signalingHandler.js';
import { PeerManager } from '../src/managers/peerManager.js';
import { PinManager } from '../src/managers/pinManager.js';
import { PairingRateLimiter } from '../src/managers/rateLimiter.js';

async function runVerification() {
  console.log('[Verification] Starting automated WebRTC signal relay verification...');

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

  console.log(`[Verification] Test server listening on ${serverUrl}`);

  const socket1 = ioClient(serverUrl, { transports: ['websocket'] });
  const socket2 = ioClient(serverUrl, { transports: ['websocket'] });

  try {
    // 1. Wait for both peers to be ready
    const [peer1, peer2] = await Promise.all([
      new Promise((resolve) => socket1.once('peer_ready', resolve)),
      new Promise((resolve) => socket2.once('peer_ready', resolve))
    ]);

    assert.ok(peer1.pin, 'Socket 1 must have received a valid PIN');
    assert.ok(peer2.pin, 'Socket 2 must have received a valid PIN');
    assert.notEqual(socket1.id, socket2.id, 'Socket 1 and Socket 2 must have distinct socket IDs');

    console.log(`[Verification] Peers ready: Socket 1 (${socket1.id}) PIN: ${peer1.pin}, Socket 2 (${socket2.id}) PIN: ${peer2.pin}`);

    // 2. Socket 1 initiates pairing with Socket 2's PIN
    const promptPromise1 = new Promise((resolve) => socket1.once('pairing_prompt', resolve));
    const promptPromise2 = new Promise((resolve) => socket2.once('pairing_prompt', resolve));

    socket1.emit('request_pairing', { pin: peer2.pin, deviceName: 'Device 1' });

    const [prompt1, prompt2] = await Promise.all([promptPromise1, promptPromise2]);
    assert.equal(prompt1.pairingId, prompt2.pairingId, 'Pairing prompts must share the same pairingId');

    // 3. Both accept pairing
    const confirmedPromise1 = new Promise((resolve) => socket1.once('pairing_confirmed', resolve));
    const confirmedPromise2 = new Promise((resolve) => socket2.once('pairing_confirmed', resolve));

    socket1.emit('pairing_response', { pairingId: prompt1.pairingId, accepted: true });
    socket2.emit('pairing_response', { pairingId: prompt2.pairingId, accepted: true });

    const [confirmed1, confirmed2] = await Promise.all([confirmedPromise1, confirmedPromise2]);
    const pairingId = confirmed1.pairingId;

    assert.equal(confirmed1.role, 'initiator', 'Socket 1 must be initiator');
    assert.equal(confirmed2.role, 'receiver', 'Socket 2 must be receiver');
    assert.equal(confirmed1.partnerSocketId, socket2.id, 'Socket 1 partnerSocketId must match Socket 2 ID');
    assert.equal(confirmed2.partnerSocketId, socket1.id, 'Socket 2 partnerSocketId must match Socket 1 ID');

    console.log(`[Verification] Pairing confirmed! pairingId: ${pairingId}`);

    // 4. Socket 1 emits mock offer via 'webrtc_signal'
    console.log('[Verification] Socket 1 emitting offer signal...');
    const offerReceivedPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Socket 2 to receive offer (1.5s)')), 1500);
      socket2.once('webrtc_signal', (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    socket1.emit('webrtc_signal', {
      pairingId,
      signal: { type: 'offer', sdp: 'test-sdp' }
    });

    const receivedOffer = await offerReceivedPromise;
    assert.deepEqual(
      receivedOffer.signal,
      { type: 'offer', sdp: 'test-sdp' },
      'Socket 2 must receive the exact offer signal payload'
    );
    console.log('[Verification] Socket 2 successfully received offer!');

    // 5. Socket 2 emits mock answer via 'webrtc_signal'
    console.log('[Verification] Socket 2 emitting answer signal...');
    const answerReceivedPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Socket 1 to receive answer (1.5s)')), 1500);
      socket1.once('webrtc_signal', (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    socket2.emit('webrtc_signal', {
      pairingId,
      signal: { type: 'answer', sdp: 'test-answer' }
    });

    const receivedAnswer = await answerReceivedPromise;
    assert.deepEqual(
      receivedAnswer.signal,
      { type: 'answer', sdp: 'test-answer' },
      'Socket 1 must receive the exact answer signal payload'
    );
    console.log('[Verification] Socket 1 successfully received answer!');

    // 6. Test ICE candidate relay
    console.log('[Verification] Testing ICE candidate relay...');
    const candidateReceivedPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Socket 2 to receive candidate (1.5s)')), 1500);
      socket2.once('webrtc_signal', (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    socket1.emit('webrtc_signal', {
      pairingId,
      signal: { type: 'candidate', candidate: { candidate: 'candidate:1 1 UDP 12345 127.0.0.1 5000 typ host' } }
    });

    const receivedCandidate = await candidateReceivedPromise;
    assert.deepEqual(
      receivedCandidate.signal.candidate,
      { candidate: 'candidate:1 1 UDP 12345 127.0.0.1 5000 typ host' },
      'Socket 2 must receive the exact candidate payload'
    );
    console.log('[Verification] Socket 2 successfully received candidate!');

    console.log('[Verification] ALL WebRTC signal relay verification checks PASSED!');
  } finally {
    socket1.disconnect();
    socket2.disconnect();
    await new Promise((resolve) => ioServer.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }
}

runVerification().catch((err) => {
  console.error('[Verification] FAILED with error:', err);
  process.exit(1);
});
