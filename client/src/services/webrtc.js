export function getIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];
}

export const ICE_SERVERS = getIceServers();

let activeSession = null;

export async function handleRemoteCandidate(candidate) {
  if (activeSession) {
    await activeSession.handleRemoteCandidate(candidate);
  }
}

export async function processCandidateQueue() {
  if (activeSession) {
    await activeSession.processCandidateQueue();
  }
}

export class WebRtcSession {
  constructor({ role, pairingId, partnerSocketId, onMessage, onStateChange, onSignal, onConnected, onError }) {
    this.role = role;
    this.pairingId = pairingId;
    this.partnerSocketId = partnerSocketId;
    this.onMessage = onMessage;
    this.onStateChange = onStateChange;
    this.onSignal = onSignal;
    this.onConnected = onConnected;
    this.onError = onError;
    this.peerConnection = null;
    this.dataChannel = null;
    this.candidateQueue = [];
    this.messageQueue = Promise.resolve();
    this.closed = false;
  }

  sendSignal(signal) {
    if (this.onSignal) {
      this.onSignal({
        pairingId: this.pairingId,
        signal
      });
    } else {
      emitSocket('webrtc_signal', {
        pairingId: this.pairingId,
        signal
      });
    }
  }

  emitSignal(signal) {
    this.sendSignal(signal);
  }

  async start() {
    activeSession = this;
    console.log('[WebRTC] Role assigned:', this.role, 'Pairing ID:', this.pairingId);
    this.peerConnection = new RTCPeerConnection({ iceServers: getIceServers() });

    // Trickle ICE: emit candidates immediately the millisecond they are generated
    this.peerConnection.onicecandidate = ({ candidate }) => {
      if (candidate) {
        console.log('[WebRTC 📤] Emitting candidate to server...');
        this.sendSignal({ type: 'candidate', candidate });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log('[WebRTC] Connection State:', state);
      if (state === 'connected') {
        if (this.dataChannel?.readyState === 'open') {
          this.onConnected?.();
          this.onStateChange?.('data-channel-open');
        }
      } else if (['failed', 'disconnected', 'closed'].includes(state)) {
        this.onStateChange?.(state);
        this.onError?.(new Error(`WebRTC connection ${state}.`));
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      console.log('[WebRTC] ICE Connection State:', state);
      if (state === 'connected' || state === 'completed') {
        if (this.dataChannel?.readyState === 'open') {
          this.onConnected?.();
          this.onStateChange?.('data-channel-open');
        }
      } else if (['failed', 'disconnected'].includes(state)) {
        this.onStateChange?.(state);
        this.onError?.(new Error(`WebRTC ICE connection ${state}.`));
      }
    };

    // Receiver: Set pc.ondatachannel = (event) => setupDataChannel(event.channel)
    this.peerConnection.ondatachannel = (event) => {
      console.log('[WebRTC ⚡] Receiver received remote DataChannel!');
      this.setupDataChannel(event.channel);
    };

    // Initiator: createDataChannel, createOffer, emit offer
    if (this.role === 'initiator') {
      try {
        console.log('[WebRTC 🚀] Initiator initializing DataChannel & Offer...');
        const channel = this.peerConnection.createDataChannel('fileTransfer', {
          ordered: true
        });
        this.setupDataChannel(channel);

        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);

        console.log('[WebRTC 📤] Emitting offer to server...');
        this.sendSignal({
          type: 'offer',
          sdp: offer
        });
      } catch (err) {
        console.error('[WebRTC ❌] Initiator setup failed:', err);
        this.onError?.(err);
      }
    }
  }

  setupDataChannel(channel) {
    if (!channel) return;
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 2 * 1024 * 1024;

    const onConnected = () => {
      console.log('[WebRTC] ⚡ DataChannel OPENED!');
      this.onConnected?.();
      this.onStateChange?.('data-channel-open');
    };

    if (channel.readyState === 'open') {
      onConnected();
    } else {
      channel.onopen = () => onConnected();
    }

    channel.onclose = () => {
      console.log('[WebRTC] DataChannel closed');
      this.onStateChange?.('data-channel-closed');
    };
    channel.onerror = (event) => {
      console.error('[WebRTC] DataChannel error:', event.error);
      this.onError?.(event.error ?? new Error('Data channel error.'));
    };
    channel.onmessage = (event) => {
      this.messageQueue = this.messageQueue
        .then(() => this.onMessage(event.data))
        .catch((error) => this.onError?.(error));
    };
  }

  setupDataChannelEvents(channel) {
    return this.setupDataChannel(channel);
  }

  async handleRemoteCandidate(candidate) {
    if (!candidate) return;
    const rawCandidate = (candidate.candidate && typeof candidate.candidate === 'object') ? candidate.candidate : candidate;
    if (!this.peerConnection || !this.peerConnection.remoteDescription) {
      console.log('[WebRTC] Buffering ICE candidate (remote description not ready yet)');
      this.candidateQueue.push(rawCandidate);
      return;
    }
    try {
      const iceCandidate = rawCandidate instanceof RTCIceCandidate ? rawCandidate : new RTCIceCandidate(rawCandidate);
      await this.peerConnection.addIceCandidate(iceCandidate);
      console.log('[WebRTC] Added remote ICE candidate successfully');
    } catch (err) {
      console.error('[WebRTC] Failed to add candidate:', err);
    }
  }

  async processCandidateQueue() {
    if (this.candidateQueue.length > 0) {
      console.log(`[WebRTC] Draining ${this.candidateQueue.length} buffered ICE candidates`);
    }
    while (this.candidateQueue.length > 0) {
      const candidate = this.candidateQueue.shift();
      try {
        const iceCandidate = candidate instanceof RTCIceCandidate ? candidate : new RTCIceCandidate(candidate);
        await this.peerConnection.addIceCandidate(iceCandidate);
      } catch (err) {
        console.error('[WebRTC] Failed to drain candidate:', err);
      }
    }
  }

  async handleSignal(signalOrEnvelope, maybeData) {
    if (!this.peerConnection) {
      await this.start();
    }

    let signal = signalOrEnvelope;
    if (signalOrEnvelope && typeof signalOrEnvelope === 'object' && signalOrEnvelope.signal !== undefined) {
      signal = signalOrEnvelope.signal;
    } else if (maybeData !== undefined) {
      signal = maybeData;
    }

    if (!signal) return;

    const signalType = signal.type || (signal.candidate ? 'candidate' : (signalOrEnvelope?.type ?? null));

    if (signalType === 'offer') {
      try {
        console.log('[WebRTC 📥] Receiver got offer! Creating answer...');
        const sdpData = signal.sdp || signal;
        const sessionDesc = sdpData?.type
          ? sdpData
          : (typeof sdpData === 'string'
              ? { type: 'offer', sdp: sdpData }
              : (signal?.type ? signal : { type: 'offer', sdp: sdpData }));
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sessionDesc));
        await this.processCandidateQueue();
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        console.log('[WebRTC 📤] Emitting answer to server...');
        this.sendSignal({
          type: 'answer',
          sdp: answer
        });
      } catch (err) {
        console.error('[WebRTC ❌] Receiver failed to handle offer:', err);
        this.onError?.(err);
      }
      return;
    }

    if (signalType === 'answer') {
      try {
        console.log('[WebRTC 📥] Initiator got answer! Setting remote description...');
        const sdpData = signal.sdp || signal;
        const sessionDesc = sdpData?.type
          ? sdpData
          : (typeof sdpData === 'string'
              ? { type: 'answer', sdp: sdpData }
              : (signal?.type ? signal : { type: 'answer', sdp: sdpData }));
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sessionDesc));
        await this.processCandidateQueue();
      } catch (err) {
        console.error('[WebRTC ❌] Initiator failed to handle answer:', err);
        this.onError?.(err);
      }
      return;
    }

    if (signalType === 'candidate' || signal.candidate) {
      console.log('[WebRTC] 📥 Received remote ICE candidate');
      const candidate = signal.candidate !== undefined ? signal.candidate : signal;
      await this.handleRemoteCandidate(candidate);
    }
  }

  send(data) {
    if (this.dataChannel?.readyState !== 'open') {
      throw new Error('The data channel is not open.');
    }
    this.dataChannel.send(data);
  }

  close() {
    this.closed = true;
    this.candidateQueue = [];
    this.messageQueue = Promise.resolve();
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onerror = null;
      this.dataChannel.onmessage = null;
      try {
        this.dataChannel.close();
      } catch {}
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection.ondatachannel = null;
      try {
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }
    if (activeSession === this) {
      activeSession = null;
    }
  }
}

export async function startSession(config) {
  const session = new WebRtcSession(config);
  await session.start();
  return session;
}
