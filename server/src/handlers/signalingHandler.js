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

    const handlePairingRequest = (payload = {}, acknowledgement) => {
      const { targetPeerId, pin, deviceName } = payload;
      if (deviceName) {
        peerManager.setDeviceName(socket.id, deviceName);
      }

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
        const initiatorPeer = peerManager.getPeerBySocketId ? peerManager.getPeerBySocketId(socket.id) : peerManager.getBySocketId(socket.id);
        const targetPeer = targetPeerId
          ? (peerManager.getPeerByPeerId ? peerManager.getPeerByPeerId(targetPeerId) : peerManager.getByPeerId(targetPeerId))
          : (pin ? (peerManager.getPeerByPin ? peerManager.getPeerByPin(pin) : peerManager.getByPin(pin)) : null);

        if (!targetPeer) {
          rateLimiter.recordFailure(...rateLimitKeys);
          const response = {
            code: 'TARGET_NOT_FOUND',
            message: 'No device was found for that PIN or QR link.'
          };
          socket.emit('pairing_error', response);
          acknowledgement?.({ ok: false, ...response });
          return;
        }

        if (initiatorPeer && (targetPeer.socketId === initiatorPeer.socketId || targetPeer.peerId === initiatorPeer.peerId)) {
          rateLimiter.recordFailure(...rateLimitKeys);
          const response = {
            code: 'SELF_PAIRING',
            message: 'Cannot pair with your own device'
          };
          socket.emit('pairing_error', response);
          acknowledgement?.({ ok: false, ...response });
          return;
        }

        const pairing = peerManager.createPairing(initiatorPeer, targetPeer);
        rateLimiter.recordSuccess(...rateLimitKeys);

        const participants = peerManager.getPairingPeers(pairing.pairingId);
        const requesterPeer = participants.requester;
        const targetPeerObj = participants.target;
        const formattedCode = String(pairing.confirmationCode ?? pairing.verificationCode ?? '00').padStart(2, '0');
        const pId = pairing.pairingId || pairing.id;

        const sessionPayload = {
          pairingId: pId,
          id: pId,
          verificationCode: formattedCode,
          confirmationCode: formattedCode,
          code: formattedCode
        };

        console.log(`[Signaling 🔑] Session matched ${pId} with verification code: ${formattedCode}`);

        // Notify host (targetPeerObj is host)
        io.to(targetPeerObj.socketId).emit('session_matched', {
          ...sessionPayload,
          role: 'initiator',
          otherDeviceName: requesterPeer.deviceName
        });

        // Notify joiner (requesterPeer is joiner / socket)
        socket.emit('session_matched', {
          ...sessionPayload,
          role: 'receiver',
          otherDeviceName: targetPeerObj.deviceName
        });
        if (requesterPeer.socketId !== socket.id) {
          io.to(requesterPeer.socketId).emit('session_matched', {
            ...sessionPayload,
            role: 'receiver',
            otherDeviceName: targetPeerObj.deviceName
          });
        }

        const prompt = {
          pairingId: pId,
          confirmationCode: formattedCode,
          verificationCode: formattedCode,
          code: formattedCode,
          expiresIn: 120,
          requester: pairingParticipant(requesterPeer, targetPeerObj),
          target: pairingParticipant(targetPeerObj, requesterPeer)
        };

        io.to(requesterPeer.socketId).emit('pairing_prompt', {
          ...prompt,
          role: 'requester',
          otherDeviceName: targetPeerObj.deviceName
        });
        io.to(targetPeerObj.socketId).emit('pairing_prompt', {
          ...prompt,
          role: 'target',
          otherDeviceName: requesterPeer.deviceName
        });
        acknowledgement?.({ ok: true, pairingId: pId, code: formattedCode, verificationCode: formattedCode });
      } catch (error) {
        rateLimiter.recordFailure(...rateLimitKeys);
        const response = {
          code: error.code ?? 'PAIRING_FAILED',
          message: error.message
        };
        socket.emit('pairing_error', response);
        acknowledgement?.({ ok: false, ...response });
      }
    };

    socket.on('request_pairing', handlePairingRequest);
    socket.on('join_session', handlePairingRequest);

    const handlePairingResponse = (payload = {}) => {
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

        const pairing = result.pairing;
        const requester = participants.requester;
        const target = participants.target;
        const initiatorSocketId = pairing.initiatorSocketId || pairing.requesterSocketId;
        const targetSocketId = pairing.targetSocketId;

        const getSocket = (socketId) => {
          if (!socketId) return null;
          if (io.sockets?.sockets?.get) {
            return io.sockets.sockets.get(socketId);
          }
          if (io.sockets?.get) {
            return io.sockets.get(socketId);
          }
          return null;
        };

        const initiatorSocket = getSocket(initiatorSocketId);
        const targetSocket = getSocket(targetSocketId);

        if (initiatorSocket && targetSocket) {
          initiatorSocket.data = initiatorSocket.data || {};
          targetSocket.data = targetSocket.data || {};
          initiatorSocket.data.partnerSocketId = targetSocket.id;
          targetSocket.data.partnerSocketId = initiatorSocket.id;
          initiatorSocket.data.pairingId = pairing.id || pairing.pairingId;
          targetSocket.data.pairingId = pairing.id || pairing.pairingId;
        }

        const pId = pairing.id || pairing.pairingId;
        const roomName = `room_${pId}`;
        const formattedCode = String(pairing.confirmationCode ?? pairing.verificationCode ?? '00').padStart(2, '0');
        console.log(`[Signaling] Pairing confirmed: initiator=${initiatorSocketId} <-> target=${targetSocketId}`);

        const transferPayloadHost = {
          roomId: roomName,
          pairingId: pId,
          id: pId,
          role: 'initiator',
          initiator: true,
          initiatorId: initiatorSocketId,
          hostSocketId: initiatorSocketId,
          partnerSocketId: targetSocketId,
          partnerName: target.deviceName || pairing.targetDeviceName,
          deviceName: target.deviceName || pairing.targetDeviceName,
          peerId: target.peerId,
          confirmationCode: formattedCode,
          verificationCode: formattedCode,
          code: formattedCode,
          initiatorSocketId,
          targetSocketId
        };

        const transferPayloadJoiner = {
          roomId: roomName,
          pairingId: pId,
          id: pId,
          role: 'receiver',
          initiator: false,
          initiatorId: initiatorSocketId,
          hostSocketId: initiatorSocketId,
          partnerSocketId: initiatorSocketId,
          partnerName: requester.deviceName || pairing.initiatorDeviceName,
          deviceName: requester.deviceName || pairing.initiatorDeviceName,
          peerId: requester.peerId,
          confirmationCode: formattedCode,
          verificationCode: formattedCode,
          code: formattedCode,
          initiatorSocketId,
          targetSocketId
        };

        // Emit start_transfer_session to both sockets
        io.to(initiatorSocketId).emit('start_transfer_session', transferPayloadHost);
        io.to(targetSocketId).emit('start_transfer_session', transferPayloadJoiner);

        // Also broadcast start_transfer_session to session room/id
        io.to(pId).emit('start_transfer_session', {
          pairingId: pId,
          initiatorId: initiatorSocketId
        });

        // Also emit pairing_confirmed for backwards compatibility
        io.to(initiatorSocketId).emit('pairing_confirmed', {
          ...transferPayloadHost,
          confirmationState: result.confirmationState
        });

        io.to(targetSocketId).emit('pairing_confirmed', {
          ...transferPayloadJoiner,
          confirmationState: result.confirmationState
        });
      } catch (error) {
        socket.emit('pairing_error', {
          code: error.code ?? 'PAIRING_RESPONSE_FAILED',
          message: error.message
        });
      }
    };

    socket.on('pairing_response', handlePairingResponse);
    socket.on('confirm_pairing', (payload = {}) => {
      handlePairingResponse({ ...payload, accepted: true });
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

      const getSocket = (socketId) => {
        if (!socketId) return null;
        if (io.sockets?.sockets?.get) {
          return io.sockets.sockets.get(socketId);
        }
        if (io.sockets?.get) {
          return io.sockets.get(socketId);
        }
        return null;
      };

      const initiatorSocket = getSocket(pairing.initiatorSocketId || pairing.requesterSocketId);
      const targetSocket = getSocket(pairing.targetSocketId);
      if (initiatorSocket?.data) initiatorSocket.data.partnerSocketId = null;
      if (targetSocket?.data) targetSocket.data.partnerSocketId = null;

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

    socket.on('webrtc_signal', ({ signal, pairingId } = {}) => {
      let partnerId = socket.data?.partnerSocketId;

      if (!partnerId) {
        const targetPairingId = pairingId || socket.data?.pairingId;
        const pairing = (targetPairingId ? peerManager.getPairing(targetPairingId) : null) || peerManager.getPairingForSocket(socket.id);
        if (pairing) {
          const initiatorId = pairing.initiatorSocketId || pairing.requesterSocketId;
          partnerId = socket.id === initiatorId ? pairing.targetSocketId : initiatorId;
          if (socket.data) {
            socket.data.partnerSocketId = partnerId;
            socket.data.pairingId = pairing.id || pairing.pairingId;
          }
        }
      }

      console.log(`[Signaling Server] Inbound signal '${signal?.type || 'candidate'}' from ${socket.id} -> target: ${partnerId}`);

      if (!partnerId) {
        console.warn(`[Signaling Server ⚠️] Dropped signal from ${socket.id}: No partnerSocketId bound.`);
        return;
      }

      io.to(partnerId).emit('webrtc_signal', { signal });
      console.log(`[Signaling Server ✅] Relayed '${signal?.type || 'candidate'}' to ${partnerId}`);
    });

    socket.on('signal', (payload = {}) => {
      const signal = payload.signal !== undefined ? payload.signal : (payload.data !== undefined ? payload.data : payload);
      let partnerId = socket.data?.partnerSocketId;

      if (!partnerId) {
        const targetPairingId = payload.pairingId || socket.data?.pairingId;
        const pairing = (targetPairingId ? peerManager.getPairing(targetPairingId) : null) || peerManager.getPairingForSocket(socket.id);
        if (pairing) {
          const initiatorId = pairing.initiatorSocketId || pairing.requesterSocketId;
          partnerId = socket.id === initiatorId ? pairing.targetSocketId : initiatorId;
          if (socket.data) {
            socket.data.partnerSocketId = partnerId;
            socket.data.pairingId = pairing.id || pairing.pairingId;
          }
        }
      }

      if (partnerId && partnerId !== socket.id) {
        io.to(partnerId).emit('webrtc_signal', { signal });
        io.to(partnerId).emit('signal', { signal });
      }
    });

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
