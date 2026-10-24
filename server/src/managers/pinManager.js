import { randomInt } from 'node:crypto';

export const DEFAULT_PIN_TTL_MS = 120_000;
export const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizePin(pin) {
  return String(pin ?? '').trim().toUpperCase();
}

export class PinManager {
  constructor({ ttlMs = DEFAULT_PIN_TTL_MS, onRotate = () => {} } = {}) {
    this.ttlMs = ttlMs;
    this.onRotate = onRotate;
    this.entriesByPeerId = new Map();
    this.peerIdByPin = new Map();
  }

  issue(peerId, { now = Date.now() } = {}) {
    this.remove(peerId);

    const record = {
      peerId,
      pin: this.#createUniquePin(),
      expiresAt: now + this.ttlMs,
      paused: false,
      timer: null
    };

    this.entriesByPeerId.set(peerId, record);
    this.peerIdByPin.set(record.pin, peerId);
    this.#schedule(record);
    return this.#view(record, now);
  }

  get(peerId) {
    const record = this.entriesByPeerId.get(peerId);
    return record ? this.#view(record) : null;
  }

  resolve(pin, { now = Date.now() } = {}) {
    const normalized = normalizePin(pin);
    const peerId = this.peerIdByPin.get(normalized);
    if (!peerId) {
      return null;
    }

    const record = this.entriesByPeerId.get(peerId);
    if (!record) {
      this.peerIdByPin.delete(normalized);
      return null;
    }

    if (!record.paused && record.expiresAt <= now) {
      this.#expire(record);
      return null;
    }

    return peerId;
  }

  setPaused(peerId, paused) {
    const record = this.entriesByPeerId.get(peerId);
    if (!record) {
      return null;
    }

    record.paused = Boolean(paused);
    if (record.paused) {
      this.#clearTimer(record);
    } else {
      record.expiresAt = Date.now() + this.ttlMs;
      this.#schedule(record);
    }

    return this.#view(record);
  }

  remove(peerId) {
    const record = this.entriesByPeerId.get(peerId);
    if (!record) {
      return;
    }

    this.#clearTimer(record);
    this.entriesByPeerId.delete(peerId);
    this.peerIdByPin.delete(record.pin);
  }

  destroy() {
    for (const record of this.entriesByPeerId.values()) {
      this.#clearTimer(record);
    }
    this.entriesByPeerId.clear();
    this.peerIdByPin.clear();
  }

  #rotate(peerId) {
    const existing = this.entriesByPeerId.get(peerId);
    if (!existing) {
      return null;
    }

    if (existing.paused) {
      return this.#view(existing);
    }

    this.#clearTimer(existing);
    this.peerIdByPin.delete(existing.pin);

    const next = {
      peerId,
      pin: this.#createUniquePin(),
      expiresAt: Date.now() + this.ttlMs,
      paused: false,
      timer: null
    };

    this.entriesByPeerId.set(peerId, next);
    this.peerIdByPin.set(next.pin, peerId);
    this.#schedule(next);

    const view = this.#view(next);
    this.onRotate(view);
    return view;
  }

  #expire(record) {
    if (this.entriesByPeerId.get(record.peerId) !== record) {
      return;
    }
    this.#rotate(record.peerId);
  }

  #schedule(record) {
    this.#clearTimer(record);
    if (record.paused) {
      return;
    }

    const delay = Math.max(0, record.expiresAt - Date.now());
    record.timer = setTimeout(() => this.#expire(record), delay);
    record.timer.unref?.();
  }

  #clearTimer(record) {
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
  }

  #createUniquePin() {
    for (;;) {
      let pin = '';
      for (let index = 0; index < 6; index += 1) {
        pin += PIN_ALPHABET[randomInt(0, PIN_ALPHABET.length)];
      }
      if (!this.peerIdByPin.has(pin)) {
        return pin;
      }
    }
  }

  #view(record, now = Date.now()) {
    return {
      peerId: record.peerId,
      pin: record.pin,
      expiresAt: record.expiresAt,
      expiresIn: Math.max(0, Math.ceil((record.expiresAt - now) / 1000)),
      paused: record.paused
    };
  }
}
