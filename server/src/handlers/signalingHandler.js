function pairingParticipant(peer, otherPeer) {
  return {
    peerId: peer?.peerId ?? null,
    deviceName: peer?.deviceName ?? 'Unnamed device',
    otherPeerId: otherPeer?.peerId ?? null,
    otherDeviceName: otherPeer?.deviceName ?? 'Unnamed device'
  };
}

export function registerSignalingHandlers(io, peerManager) {
  io.on('connection', (socket) => {
    const peer = peerManager.register(socket.id);
    socket.emit('peer_ready', peer);

    socket.on('set_device_name', (payload = {}) => {
      peerManager.setDeviceName(socket.id, payload.deviceName);
    });

    socket.on('request_pairing', (payload = {}, acknowledgement) => {
      const { targetPeerId, pin, deviceName } = payload;
      peerManager.setDeviceName(socket.id, deviceName);

      try {
        const pairing = peerManager.createPairing(socket.id, {
          peerId: targetPeerId,
          pin
        });
        const participants = peerManager.getPairingPeers(pairing.pairingId);
        const requester = participants.requester;
        const target = participants.target;
        const prompt = {
          pairingId: pairing.pairingId,
          confirmationCode: pairing.confirmationCode,
          expiresIn: 120,
          requester: pairingParticipant(requester, target),
          target: pairingParticipant(target, requester)
        };

        io.to(requester.socketId).emit('pairing_prompt', {
          ...prompt,
          role: 'requester',
          otherDeviceName: target.deviceName
        });
        io.to(target.socketId).emit('pairing_prompt', {
          ...prompt,
          role: 'target',
          otherDeviceName: requester.deviceName
        });
        acknowledgement?.({ ok: true, pairingId: pairing.pairingId });
      } catch (error) {
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
          deviceName: target.deviceName,
          confirmationState: result.confirmationState
        });
        io.to(target.socketId).emit('pairing_confirmed', {
          pairingId: payload.pairingId,
          confirmationCode: result.pairing.confirmationCode,
          initiator: false,
          role: 'receiver',
          peerId: requester.peerId,
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

    socket.on('webrtc_signal', (payload = {}) => {
      const otherSocketId = peerManager.otherSocketId(payload.pairingId, socket.id);
      if (!otherSocketId) {
        socket.emit('pairing_error', {
          code: 'SIGNALING_NOT_AVAILABLE',
          message: 'The WebRTC signaling session is no longer available.'
        });
        return;
      }

      io.to(otherSocketId).emit('webrtc_signal', {
        pairingId: payload.pairingId,
        type: payload.type,
        data: payload.data
      });
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
