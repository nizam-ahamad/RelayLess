import assert from 'node:assert/strict';
import test from 'node:test';
import { PairingRateLimiter } from '../src/managers/rateLimiter.js';

test('PairingRateLimiter tracks failures and throttles after max attempts', () => {
  const limiter = new PairingRateLimiter({ windowMs: 10_000, maxFailedAttempts: 5 });

  const socketId = 'socket-attacker';
  const clientIp = '192.168.1.100';

  // 1 to 4 failures: not rate limited
  for (let i = 1; i <= 4; i++) {
    limiter.recordFailure(socketId, clientIp);
    assert.equal(limiter.isRateLimited(socketId, clientIp), false);
  }

  // 5th failure: hits threshold
  limiter.recordFailure(socketId, clientIp);
  assert.equal(limiter.isRateLimited(socketId, clientIp), true);

  // Rate-limited by IP alone or socket alone
  assert.equal(limiter.isRateLimited(socketId), true);
  assert.equal(limiter.isRateLimited(clientIp), true);
  assert.equal(limiter.isRateLimited('unrelated-socket', '10.0.0.1'), false);

  limiter.destroy();
});

test('PairingRateLimiter clears failures on recordSuccess and resetKey', () => {
  const limiter = new PairingRateLimiter({ windowMs: 10_000, maxFailedAttempts: 3 });
  const socketId = 'socket-user';
  const ip = '10.0.0.2';

  limiter.recordFailure(socketId, ip);
  limiter.recordFailure(socketId, ip);
  limiter.recordFailure(socketId, ip);
  assert.equal(limiter.isRateLimited(socketId, ip), true);

  // Successful pairing clears failures
  limiter.recordSuccess(socketId, ip);
  assert.equal(limiter.isRateLimited(socketId, ip), false);

  // Disconnect resets socket key
  limiter.recordFailure(socketId);
  limiter.recordFailure(socketId);
  limiter.recordFailure(socketId);
  assert.equal(limiter.isRateLimited(socketId), true);
  limiter.resetKey(socketId);
  assert.equal(limiter.isRateLimited(socketId), false);

  limiter.destroy();
});

test('PairingRateLimiter cleans up expired timestamps and handles destroy', () => {
  const limiter = new PairingRateLimiter({ windowMs: 50, maxFailedAttempts: 2 });
  limiter.recordFailure('key1');
  limiter.recordFailure('key1');
  assert.equal(limiter.isRateLimited('key1'), true);

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(limiter.isRateLimited('key1'), false);
      limiter.cleanup();
      assert.equal(limiter.failuresByKey.has('key1'), false);
      limiter.destroy();
      resolve();
    }, 70);
  });
});
