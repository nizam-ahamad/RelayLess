import { PairingRateLimiter } from '../managers/rateLimiter.js';

function pairingParticipant(peer, otherPeer) {
  return {
    peerId: peer?.peerId ?? null,
    deviceName: peer?.deviceName ?? 'Unnamed device',
    otherPeerId: otherPeer?.peerId ?? null,
    otherDeviceName: otherPeer?.deviceName ?? 'Unnamed device'
  };
}

export function registerSignalingHandlers(io, peerManager, rateLimiter = new PairingRateLimiter()) {
  io.on('connection', (socket) => {
    const peer = peerManager.register(socket.id);
    socket.emit('peer_ready', peer);

    socket.on('set_device_name', (payload = {}) => {
      peerManager.setDeviceName(socket.id, payload.deviceName);
    });

    socket.on('request_pairing', (payload = {}, acknowledgement) => {
      const { targetPeerId, pin, deviceName } = payload;
      peerManager.setDeviceName(socket.id, deviceName);

      const clientIp = socket.handshake?.address || socket.conn?.remoteAddress;
      const rateLimitKeys = [socket.id, clientIp].filter(Boolean);

      if (rateLimiter.isRateLimited(...rateLimitKeys)) {
        const response = {
          code: 'RATE_LIMITED',
          message: 'Too many failed pairing attempts. Please wait a minute before trying again.'
        };
        socket.emit('pairing_error', response);
        acknowledgement?.({ ok: false, ...response });
        return;
      }

      try {
        const requester = peerManager.getBySocketId(socket.id);
        const target = targetPeerId
          ? peerManager.getByPeerId(targetPeerId)
          : (pin ? peerManager.getByPin(pin) : null);

        if (target && requester && (target.socketId === requester.socketId || target.peerId === requester.peerId)) {
          rateLimiter.recordFailure(...rateLimitKeys);
          const response = {
            code: 'SELF_PAIRING',
            message: 'Cannot pair with your own device'
          };
          socket.emit('pairing_error', response);
          acknowledgement?.({ ok: false, ...response });
          return;
        }

        const pairing = peerManager.createPairing(socket.id, {
          peerId: targetPeerId,
          pin
        });
        rateLimiter.recordSuccess(...rateLimitKeys);

        const participants = peerManager.getPairingPeers(pairing.pairingId);
        const requesterPeer = participants.requester;
        const targetPeer = participants.target;
        const prompt = {
          pairingId: pairing.pairingId,
          confirmationCode: pairing.confirmationCode,
          expiresIn: 120,
          requester: pairingParticipant(requesterPeer, targetPeer),
          target: pairingParticipant(targetPeer, requesterPeer)
        };

        io.to(requesterPeer.socketId).emit('pairing_prompt', {
          ...prompt,
          role: 'requester',
          otherDeviceName: targetPeer.deviceName
        });
        io.to(targetPeer.socketId).emit('pairing_prompt', {
          ...prompt,
          role: 'target',
          otherDeviceName: requesterPeer.deviceName
        });
        acknowledgement?.({ ok: true, pairingId: pairing.pairingId });
      } catch (error) {
        rateLimiter.recordFailure(...rateLimitKeys);
        const response = {
          code: error.code ?? 'PAIRING_FAILED',
          message: error.message
        };
        socket.emit('pairing_error', response);
        acknowledgement?.({ ok: false, ...response });
      }
    });

    socket.on('pairing_response', (payload = {}) => {
      try {
        const result = peerManager.respondToPairing(
          payload.pairingId,
          socket.id,
          Boolean(payload.accepted)
        );
        const participants = peerManager.getPairingPeers(payload.pairingId);

        if (result.rejected) {
          for (const participant of [participants?.requester, participants?.target]) {
            if (participant) {
              io.to(participant.socketId).emit('pairing_rejected', {
                pairingId: payload.pairingId,
                message: 'The pairing request was declined.'
              });
              const refreshed = peerManager.publicPeer(participant);
              io.to(participant.socketId).emit('update_pin', refreshed);
            }
          }
          return;
        }

        if (!result.acceptedByBoth) {
          const otherSocketId = peerManager.otherSocketId(payload.pairingId, socket.id);
          if (otherSocketId) {
            io.to(otherSocketId).emit('pairing_acknowledged', {
              pairingId: payload.pairingId,
              acceptedBy: socket.id,
              approvedByRole: result.role,
              confirmationState: result.confirmationState
            });
          }
          return;
        }

        const requester = participants.requester;
        const target = participants.target;
        io.to(requester.socketId).emit('pairing_confirmed', {
          pairingId: payload.pairingId,
          confirmationCode: result.pairing.confirmationCode,
          initiator: true,
          role: 'initiator',
          peerId: target.peerId,
          targetSocketId: target.socketId,
          otherSocketId: target.socketId,
          deviceName: target.deviceName,
          confirmationState: result.confirmationState
        });
        io.to(target.socketId).emit('pairing_confirmed', {
          pairingId: payload.pairingId,
          confirmationCode: result.pairing.confirmationCode,
          initiator: false,
          role: 'receiver',
          peerId: requester.peerId,
          targetSocketId: requester.socketId,
          otherSocketId: requester.socketId,
          deviceName: requester.deviceName,
          confirmationState: result.confirmationState
        });
      } catch (error) {
        socket.emit('pairing_error', {
          code: error.code ?? 'PAIRING_RESPONSE_FAILED',
          message: error.message
        });
      }
    });

    socket.on('pairing_cancel', (payload = {}) => {
      const pairing = peerManager.getPairing(payload.pairingId);
      if (!pairing || ![pairing.requesterSocketId, pairing.targetSocketId].includes(socket.id)) {
        return;
      }

      const closed = peerManager.closePairing(payload.pairingId);
      if (!closed) {
        return;
      }

      for (const participant of [closed.requester, closed.target]) {
        if (participant) {
          io.to(participant.socketId).emit('pairing_cancelled', {
            pairingId: payload.pairingId,
            message: 'The connection was closed.'
          });
          io.to(participant.socketId).emit('update_pin', peerManager.publicPeer(participant));
        }
      }
    });

    const handleSignalRelay = (payload = {}) => {
      let targetSocketId = payload.targetSocketId || payload.otherSocketId;
      const pairing = peerManager.getPairingForSocket(socket.id);

      if (!targetSocketId && pairing) {
        const initiatorId = pairing.initiatorSocketId || pairing.requesterSocketId;
        targetSocketId = initiatorId === socket.id
          ? pairing.targetSocketId
          : initiatorId;
      }

      if (!targetSocketId) {
        socket.emit('pairing_error', {
          code: 'SIGNALING_NOT_AVAILABLE',
          message: 'The WebRTC signaling session is no longer available.'
        });
        return;
      }

      const signal = payload.signal !== undefined ? payload.signal : (payload.data !== undefined ? payload.data : payload);
      const signalType = payload.type || signal?.type || (signal?.candidate ? 'candidate' : 'signal');
      console.log(`[Signaling] ⚡ Relaying '${signalType}' from ${socket.id} to ${targetSocketId}`);

      const envelope = {
        pairingId: pairing?.pairingId || payload.pairingId,
        senderSocketId: socket.id,
        targetSocketId,
        type: signalType,
        data: signal,
        signal
      };

      io.to(targetSocketId).emit('webrtc_signal', envelope);
      io.to(targetSocketId).emit('signal', envelope);
    };

    socket.on('webrtc_signal', handleSignalRelay);
    socket.on('signal', handleSignalRelay);

    socket.on('webrtc_ready', (payload = {}) => {
      try {
        const result = peerManager.markWebRtcReady(payload.pairingId, socket.id);
        if (!result.connected) {
          return;
        }

        const participants = peerManager.getPairingPeers(payload.pairingId);
        for (const participant of [participants.requester, participants.target]) {
          const other = participant.socketId === participants.requester.socketId
            ? participants.target
            : participants.requester;
          io.to(participant.socketId).emit('connection_ready', {
            pairingId: payload.pairingId,
            peerId: other.peerId,
            deviceName: other.deviceName
          });
        }
      } catch (error) {
        socket.emit('pairing_error', {
          code: error.code ?? 'WEBRTC_READY_FAILED',
          message: error.message
        });
      }
    });

    socket.on('disconnect', (reason) => {
      rateLimiter.resetKey(socket.id);
      const result = peerManager.unregister(socket.id);
      const other = result.pairing
        ? [result.pairing.requester, result.pairing.target].find(
            (participant) => participant && participant.socketId !== socket.id
          )
        : null;

      if (other) {
        io.to(other.socketId).emit('peer_disconnected', {
          peerId: result.peer?.peerId ?? null,
          reason
        });
        io.to(other.socketId).emit('update_pin', peerManager.publicPeer(other));
      }
    });
  });
}
