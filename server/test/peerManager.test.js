import assert from 'node:assert/strict';
import test from 'node:test';
import { PeerManager } from '../src/managers/peerManager.js';
import { PinManager } from '../src/managers/pinManager.js';

test('creates a mutual pairing and only completes after both accept', () => {
  const pinManager = new PinManager({ ttlMs: 1000 });
  const manager = new PeerManager({ pinManager });
  const first = manager.register('socket-a');
  const second = manager.register('socket-b');

  const pairing = manager.createPairing('socket-a', { pin: second.pin });
  assert.equal(pairing.status, 'prompted');
  assert.deepEqual(pairing.confirmationState, { requester: false, target: false });
  assert.equal(manager.getBySocketId('socket-a').pairingId, pairing.pairingId);
  assert.equal(manager.getBySocketId('socket-b').pairingId, pairing.pairingId);

  const firstResponse = manager.respondToPairing(pairing.pairingId, 'socket-a', true);
  assert.equal(firstResponse.acceptedByBoth, false);
  assert.equal(firstResponse.role, 'requester');
  assert.deepEqual(firstResponse.confirmationState, { requester: true, target: false });
  const secondResponse = manager.respondToPairing(pairing.pairingId, 'socket-b', true);
  assert.equal(secondResponse.acceptedByBoth, true);
  assert.equal(secondResponse.role, 'target');
  assert.deepEqual(secondResponse.confirmationState, { requester: true, target: true });
  assert.equal(pairing.status, 'confirmed');

  const duplicateResponse = manager.respondToPairing(pairing.pairingId, 'socket-b', true);
  assert.equal(duplicateResponse.acceptedByBoth, true);
  assert.deepEqual(duplicateResponse.confirmationState, { requester: true, target: true });

  const readyA = manager.markWebRtcReady(pairing.pairingId, 'socket-a');
  assert.equal(readyA.connected, false);
  const readyB = manager.markWebRtcReady(pairing.pairingId, 'socket-b');
  assert.equal(readyB.connected, true);

  manager.unregister('socket-a');
  assert.equal(manager.getByPeerId(first.peerId), null);
  assert.equal(manager.getByPeerId(second.peerId).pairingId, null);
  pinManager.destroy();
});
