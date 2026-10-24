import assert from 'node:assert/strict';
import test from 'node:test';
import { PinManager } from '../src/managers/pinManager.js';

test('issues six-character pins and resolves them', () => {
  const manager = new PinManager({ ttlMs: 1000 });
  const issued = manager.issue('peer-a');

  assert.match(issued.pin, /^[A-Z2-9]{6}$/);
  assert.equal(manager.resolve(issued.pin), 'peer-a');
  assert.equal(manager.resolve(issued.pin.toLowerCase()), 'peer-a');
  manager.destroy();
});

test('rotates expired pins and pauses rotation while pairing is active', () => {
  const rotated = [];
  const manager = new PinManager({ ttlMs: 10, onRotate: (pin) => rotated.push(pin) });
  const first = manager.issue('peer-a');

  manager.setPaused('peer-a', true);
  assert.equal(manager.resolve(first.pin, { now: Date.now() + 1000 }), 'peer-a');

  manager.setPaused('peer-a', false);
  const current = manager.get('peer-a');
  assert.ok(current.expiresAt > Date.now());

  manager.remove('peer-a');
  assert.equal(manager.resolve(current.pin), null);
  assert.equal(rotated.length, 0);
  manager.destroy();
});
