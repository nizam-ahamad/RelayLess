import { randomInt, randomUUID } from 'node:crypto';

export class PeerManager {
  constructor({ pinManager }) {
    this.pinManager = pinManager;
    this.peersBySocketId = new Map();
    this.peersByPeerId = new Map();
    this.pairings = new Map();
  }

  register(socketId) {
    const peerId = randomUUID();
    const pin = this.pinManager.issue(peerId);
    const peer = {
      socketId,
      peerId,
      deviceName: 'Unnamed device',
      pairingId: null,
      registeredAt: Date.now()
    };

    this.peersBySocketId.set(socketId, peer);
    this.peersByPeerId.set(peerId, peer);
    return this.publicPeer(peer);
  }

  getBySocketId(socketId) {
    return this.peersBySocketId.get(socketId) ?? null;
  }

  getByPeerId(peerId) {
    return this.peersByPeerId.get(peerId) ?? null;
  }

  getByPin(pin) {
    const peerId = this.pinManager.resolve(pin);
    return peerId ? this.getByPeerId(peerId) : null;
  }

  getPeerBySocketId(socketId) {
    return this.getBySocketId(socketId);
  }

  getPeerByPeerId(peerId) {
    return this.getByPeerId(peerId);
  }

  getPeerByPin(pin) {
    return this.getByPin(pin);
  }

  setDeviceName(socketId, deviceName) {
    const peer = this.getBySocketId(socketId);
    if (!peer) {
      return null;
    }

    const normalized = String(deviceName ?? '').trim().slice(0, 80);
    if (normalized) {
      peer.deviceName = normalized;
    }
    return peer;
  }

  publicPeer(peer) {
    if (!peer) {
      return null;
    }
    const pin = this.pinManager.get(peer.peerId);
    return {
      peerId: peer.peerId,
      pin: pin?.pin ?? null,
      expiresAt: pin?.expiresAt ?? null,
      expiresIn: pin?.expiresIn ?? 0,
      deviceName: peer.deviceName,
      pairingId: peer.pairingId
    };
  }

  createPairing(initiatorParam, targetParam) {
    let requester;
    let target;

    if (typeof initiatorParam === 'string') {
      requester = this.getBySocketId(initiatorParam);
      const opts = targetParam || {};
      target = opts.peerId ? this.getByPeerId(opts.peerId) : (opts.pin ? this.getByPin(opts.pin) : null);
    } else {
      const initSocketId = initiatorParam?.socketId || initiatorParam?.id;
      requester = initSocketId ? this.getBySocketId(initSocketId) : initiatorParam;
      const targetSocketId = targetParam?.socketId || targetParam?.id;
      target = targetSocketId ? this.getBySocketId(targetSocketId) : targetParam;
    }

    if (!requester) {
      throw this.#error('REQUESTER_NOT_FOUND', 'Your signaling session is no longer active.');
    }
    if (requester.pairingId) {
      throw this.#error('ALREADY_PAIRING', 'This device is already pairing.');
    }
    if (!target) {
      throw this.#error('TARGET_NOT_FOUND', 'No device was found for that PIN or QR link.');
    }

    const initiatorSocketId = requester.socketId || requester.id;
    const targetSocketId = target.socketId || target.id;

    if (!initiatorSocketId || !targetSocketId || initiatorSocketId === targetSocketId || (target.peerId && requester.peerId && target.peerId === requester.peerId)) {
      throw this.#error('SELF_PAIRING', 'Cannot pair with your own device');
    }

    if (target.pairingId) {
      throw this.#error('TARGET_BUSY', 'That device is already pairing with someone else.');
    }

    const pairingId = randomUUID();
    const pairing = {
      id: pairingId,
      pairingId,
      confirmationCode: String(randomInt(0, 100)).padStart(2, '0'),
      requesterSocketId: initiatorSocketId,
      initiatorSocketId,
      targetSocketId,
      initiatorPeerId: requester.peerId || requester.id,
      targetPeerId: target.peerId || target.id,
      initiatorDeviceName: requester.deviceName || 'Initiator',
      targetDeviceName: target.deviceName || 'Receiver',
      createdAt: Date.now(),
      confirmationState: {
        requester: false,
        target: false
      },
      acceptedBy: new Set(),
      readyBy: new Set(),
      status: 'prompted'
    };

    requester.pairingId = pairing.pairingId;
    target.pairingId = pairing.pairingId;
    if (this.pinManager) {
      this.pinManager.setPaused(requester.peerId, true);
      this.pinManager.setPaused(target.peerId, true);
    }
    this.pairings.set(pairing.pairingId, pairing);
    this.pairings.set(pairing.id, pairing);
    return pairing;
  }

  getPairing(pairingId) {
    return this.pairings.get(pairingId) ?? null;
  }

  getPairingForSocket(socketId) {
    const peer = this.getBySocketId(socketId);
    if (peer?.pairingId) {
      return this.getPairing(peer.pairingId);
    }
    for (const pairing of this.pairings.values()) {
      if (pairing.requesterSocketId === socketId || pairing.targetSocketId === socketId) {
        return pairing;
      }
    }
    return null;
  }

  getPairingPeers(pairingId) {
    const pairing = this.getPairing(pairingId);
    if (!pairing) {
      return null;
    }
    return {
      pairing,
      requester: this.getBySocketId(pairing.requesterSocketId),
      target: this.getBySocketId(pairing.targetSocketId)
    };
  }

  respondToPairing(pairingId, socketId, accepted) {
    const pairing = this.getPairing(pairingId);
    if (!pairing) {
      throw this.#error('PAIRING_NOT_FOUND', 'That pairing request is no longer active.');
    }
    if (![pairing.requesterSocketId, pairing.targetSocketId].includes(socketId)) {
      throw this.#error('PAIRING_FORBIDDEN', 'You are not part of this pairing request.');
    }

    if (!accepted) {
      pairing.status = 'rejected';
      return {
        pairing,
        rejected: true,
        closed: this.closePairing(pairingId)
      };
    }

    const role = pairing.requesterSocketId === socketId ? 'requester' : 'target';
    pairing.confirmationState[role] = true;
    pairing.acceptedBy.add(socketId);
    const acceptedByBoth = pairing.confirmationState.requester && pairing.confirmationState.target;
    if (!acceptedByBoth) {
      return {
        pairing,
        acceptedByBoth: false,
        role,
        confirmationState: { ...pairing.confirmationState },
        acceptedBy: [...pairing.acceptedBy]
      };
    }

    pairing.status = 'confirmed';
    return {
      pairing,
      acceptedByBoth: true,
      role,
      confirmationState: { ...pairing.confirmationState },
      acceptedBy: [...pairing.acceptedBy]
    };
  }

  markWebRtcReady(pairingId, socketId) {
    const pairing = this.getPairing(pairingId);
    if (!pairing || ![pairing.requesterSocketId, pairing.targetSocketId].includes(socketId)) {
      throw this.#error('PAIRING_NOT_FOUND', 'That pairing is no longer active.');
    }

    pairing.readyBy.add(socketId);
    if (pairing.readyBy.size === 2) {
      pairing.status = 'connected';
    }
    return {
      pairing,
      connected: pairing.readyBy.size === 2
    };
  }

  otherSocketId(pairingId, socketId) {
    const pairing = this.getPairing(pairingId);
    if (!pairing) {
      return null;
    }
    if (pairing.requesterSocketId === socketId) {
      return pairing.targetSocketId;
    }
    if (pairing.targetSocketId === socketId) {
      return pairing.requesterSocketId;
    }
    return null;
  }

  closePairing(pairingId) {
    const pairing = this.pairings.get(pairingId);
    if (!pairing) {
      return null;
    }

    const requester = this.getBySocketId(pairing.requesterSocketId);
    const target = this.getBySocketId(pairing.targetSocketId);
    for (const peer of [requester, target]) {
      if (peer?.pairingId === pairingId) {
        peer.pairingId = null;
        this.pinManager.setPaused(peer.peerId, false);
      }
    }

    this.pairings.delete(pairingId);
    return {
      ...pairing,
      requester,
      target
    };
  }

  unregister(socketId) {
    const peer = this.getBySocketId(socketId);
    let pairing = null;
    if (peer?.pairingId) {
      pairing = this.closePairing(peer.pairingId);
    } else {
      for (const [id, p] of this.pairings.entries()) {
        if (p.requesterSocketId === socketId || p.targetSocketId === socketId) {
          pairing = this.closePairing(id);
          break;
        }
      }
    }

    this.peersBySocketId.delete(socketId);
    if (peer?.peerId) {
      this.peersByPeerId.delete(peer.peerId);
      this.pinManager.remove(peer.peerId);
    }
    return { peer, pairing };
  }

  destroy() {
    for (const pairingId of this.pairings.keys()) {
      this.closePairing(pairingId);
    }
    this.peersBySocketId.clear();
    this.peersByPeerId.clear();
  }

  #error(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
}
