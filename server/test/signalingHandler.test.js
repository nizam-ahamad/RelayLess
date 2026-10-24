import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSignalingHandlers } from '../src/handlers/signalingHandler.js';
import { PeerManager } from '../src/managers/peerManager.js';
import { PinManager } from '../src/managers/pinManager.js';

class FakeSocket {
  constructor(id) {
    this.id = id;
    this.handlers = new Map();
    this.events = [];
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  emit(event, payload, acknowledgement) {
    this.events.push({ event, payload });
    if (acknowledgement) {
      acknowledgement(payload);
    }
  }

  receive(event, payload, acknowledgement) {
    return this.handlers.get(event)?.(payload, acknowledgement);
  }

  latest(event) {
    return [...this.events].reverse().find((entry) => entry.event === event)?.payload;
  }

  all(event) {
    return this.events.filter((entry) => entry.event === event).map((entry) => entry.payload);
  }
}

class FakeIo {
  constructor() {
    this.connectionHandler = null;
    this.sockets = new Map();
  }

  on(event, handler) {
    if (event === 'connection') {
      this.connectionHandler = handler;
    }
  }

  connect(socket) {
    this.sockets.set(socket.id, socket);
    this.connectionHandler(socket);
  }

  to(socketId) {
    return {
      emit: (event, payload) => this.sockets.get(socketId)?.emit(event, payload)
    };
  }
}

test('emits pairing_confirmed to both peers with deterministic WebRTC roles', () => {
  const pinManager = new PinManager({ ttlMs: 1000 });
  const peerManager = new PeerManager({ pinManager });
  const io = new FakeIo();
  registerSignalingHandlers(io, peerManager);

  const requesterSocket = new FakeSocket('socket-a');
  const targetSocket = new FakeSocket('socket-b');
  io.connect(requesterSocket);
  io.connect(targetSocket);

  const requester = requesterSocket.latest('peer_ready');
  const target = targetSocket.latest('peer_ready');
  targetSocket.receive('set_device_name', { deviceName: 'Receiver' });

  requesterSocket.receive('request_pairing', {
    pin: target.pin,
    deviceName: 'Sender'
  });

  const requesterPrompt = requesterSocket.latest('pairing_prompt');
  const targetPrompt = targetSocket.latest('pairing_prompt');
  assert.equal(requesterPrompt.pairingId, targetPrompt.pairingId);
  assert.equal(requesterPrompt.confirmationCode, targetPrompt.confirmationCode);

  requesterSocket.receive('pairing_response', {
    pairingId: requesterPrompt.pairingId,
    accepted: true
  });
  assert.equal(requesterSocket.all('pairing_confirmed').length, 0);
  assert.equal(targetSocket.all('pairing_acknowledged').length, 1);

  targetSocket.receive('pairing_response', {
    pairingId: targetPrompt.pairingId,
    accepted: true
  });

  const requesterConfirmation = requesterSocket.latest('pairing_confirmed');
  const targetConfirmation = targetSocket.latest('pairing_confirmed');
  assert.equal(requesterConfirmation.initiator, true);
  assert.equal(requesterConfirmation.role, 'initiator');
  assert.equal(targetConfirmation.initiator, false);
  assert.equal(targetConfirmation.role, 'receiver');
  assert.deepEqual(requesterConfirmation.confirmationState, {
    requester: true,
    target: true
  });
  assert.deepEqual(targetConfirmation.confirmationState, {
    requester: true,
    target: true
  });
  assert.equal(requesterConfirmation.peerId, target.peerId);
  assert.equal(targetConfirmation.peerId, requester.peerId);

  peerManager.destroy();
  pinManager.destroy();
});

test('rejects self-pairing attempt and emits pairing_error', () => {
  const pinManager = new PinManager({ ttlMs: 1000 });
  const peerManager = new PeerManager({ pinManager });
  const io = new FakeIo();
  registerSignalingHandlers(io, peerManager);

  const socket = new FakeSocket('socket-self');
  io.connect(socket);

  const peer = socket.latest('peer_ready');

  // Attempt pairing with own PIN
  let ackResult = null;
  socket.receive('request_pairing', {
    pin: peer.pin,
    deviceName: 'Self'
  }, (res) => { ackResult = res; });

  const error = socket.latest('pairing_error');
  assert.equal(error?.message, 'Cannot pair with your own device');
  assert.equal(ackResult?.ok, false);
  assert.equal(ackResult?.message, 'Cannot pair with your own device');
  assert.equal(socket.all('pairing_prompt').length, 0);

  // Attempt pairing with own peerId
  socket.receive('request_pairing', {
    targetPeerId: peer.peerId,
    deviceName: 'Self'
  });
  const error2 = socket.latest('pairing_error');
  assert.equal(error2?.message, 'Cannot pair with your own device');
  assert.equal(socket.all('pairing_prompt').length, 0);

  peerManager.destroy();
  pinManager.destroy();
});

test('throttles rapid failed request_pairing attempts and emits RATE_LIMITED', () => {
  const pinManager = new PinManager({ ttlMs: 1000 });
  const peerManager = new PeerManager({ pinManager });
  const io = new FakeIo();
  registerSignalingHandlers(io, peerManager);

  const attackerSocket = new FakeSocket('socket-attacker');
  io.connect(attackerSocket);

  // Send 5 invalid PIN pairing requests
  for (let i = 0; i < 5; i++) {
    attackerSocket.receive('request_pairing', {
      pin: '000000',
      deviceName: 'Attacker'
    });
  }

  const error5 = attackerSocket.latest('pairing_error');
  assert.equal(error5?.code, 'TARGET_NOT_FOUND');

  // 6th attempt within the rate limit window must be blocked with RATE_LIMITED
  let ackResult = null;
  attackerSocket.receive('request_pairing', {
    pin: '000000',
    deviceName: 'Attacker'
  }, (res) => { ackResult = res; });

  const error6 = attackerSocket.latest('pairing_error');
  assert.equal(error6?.code, 'RATE_LIMITED');
  assert.equal(ackResult?.code, 'RATE_LIMITED');

  peerManager.destroy();
  pinManager.destroy();
});

test('prevents unauthorized third-party socket from cancelling another pairing', () => {
  const pinManager = new PinManager({ ttlMs: 1000 });
  const peerManager = new PeerManager({ pinManager });
  const io = new FakeIo();
  registerSignalingHandlers(io, peerManager);

  const socketA = new FakeSocket('socket-a');
  const socketB = new FakeSocket('socket-b');
  const socketC = new FakeSocket('socket-attacker');
  io.connect(socketA);
  io.connect(socketB);
  io.connect(socketC);

  const peerB = socketB.latest('peer_ready');
  socketA.receive('request_pairing', { pin: peerB.pin, deviceName: 'A' });

  const promptA = socketA.latest('pairing_prompt');
  assert.ok(promptA?.pairingId);

  // Attacker socket C attempts to cancel A and B's pairing
  socketC.receive('pairing_cancel', { pairingId: promptA.pairingId });

  // Pairing must still be active
  assert.ok(peerManager.getPairing(promptA.pairingId));
  assert.equal(socketA.all('pairing_cancelled').length, 0);
  assert.equal(socketB.all('pairing_cancelled').length, 0);

  // Authorized participant A cancels
  socketA.receive('pairing_cancel', { pairingId: promptA.pairingId });
  assert.equal(peerManager.getPairing(promptA.pairingId), null);
  assert.equal(socketA.all('pairing_cancelled').length, 1);
  assert.equal(socketB.all('pairing_cancelled').length, 1);

  peerManager.destroy();
  pinManager.destroy();
});

