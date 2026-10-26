export function getIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
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
  constructor({ role, partnerSocketId, onMessage, onStateChange, onSignal, onError }) {
    this.role = role;
    this.partnerSocketId = partnerSocketId;
    this.onMessage = onMessage;
    this.onStateChange = onStateChange;
    this.onSignal = onSignal;
    this.onError = onError;
    this.peerConnection = null;
    this.dataChannel = null;
    this.candidateQueue = [];
    this.messageQueue = Promise.resolve();
    this.closed = false;
  }

  emitSignal(signal) {
    if (!this.onSignal) return;
    this.onSignal({
      targetSocketId: this.partnerSocketId,
      signal
    });
  }

  async start() {
    activeSession = this;
    console.log('[WebRTC] Role assigned:', this.role, 'Partner socket:', this.partnerSocketId);
    this.peerConnection = new RTCPeerConnection({ iceServers: getIceServers() });

    // Trickle ICE: emit candidates immediately the millisecond they are generated
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[WebRTC] Generated local ICE candidate, emitting over signaling');
        const candidatePayload = event.candidate.toJSON
          ? event.candidate.toJSON()
          : {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex
            };
        this.emitSignal(candidatePayload);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log('[WebRTC] Connection State:', state);
      if (state === 'connected') {
        if (this.dataChannel?.readyState === 'open') {
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
          this.onStateChange?.('data-channel-open');
        }
      } else if (['failed', 'disconnected'].includes(state)) {
        this.onStateChange?.(state);
        this.onError?.(new Error(`WebRTC ICE connection ${state}.`));
      }
    };

    // Receiver side: attach incoming DataChannel
    this.peerConnection.ondatachannel = (event) => {
      console.log('[WebRTC] ondatachannel received on receiver!');
      this.setupDataChannel(event.channel);
    };

    // Initiator side: create DataChannel FIRST so it is included in the SDP offer
    if (this.role === 'initiator') {
      console.log('[WebRTC] Creating DataChannel before creating offer...');
      const channel = this.peerConnection.createDataChannel('fileTransfer', {
        ordered: true
      });
      this.setupDataChannel(channel);

      console.log('[WebRTC] Creating & sending offer...');
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      this.emitSignal({
        type: 'offer',
        sdp: offer
      });
    }
  }

  setupDataChannel(channel) {
    if (!channel) return;
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 2 * 1024 * 1024;

    const onConnected = () => {
      console.log('[WebRTC] ⚡ DataChannel OPENED!');
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

  async handleSignal(type, data) {
    if (!this.peerConnection) {
      await this.start();
    }

    let signalType;
    let signalPayload;

    if (typeof type === 'object' && type !== null && data === undefined) {
      signalPayload = type;
      signalType = type.type || (type.candidate ? 'ice-candidate' : 'signal');
    } else {
      signalPayload = data !== undefined ? data : type;
      signalType = (typeof type === 'string' ? type : null) || signalPayload?.type || (signalPayload?.candidate ? 'ice-candidate' : 'signal');
    }

    if (signalType === 'offer') {
      console.log('[WebRTC] Received offer, creating & sending answer...');
      const sessionDesc = signalPayload?.sdp?.type
        ? signalPayload.sdp
        : (typeof signalPayload?.sdp === 'string'
            ? { type: 'offer', sdp: signalPayload.sdp }
            : (signalPayload?.type ? signalPayload : { type: 'offer', sdp: signalPayload }));
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sessionDesc));
      await this.processCandidateQueue();
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      this.emitSignal({
        type: 'answer',
        sdp: answer.sdp || answer
      });
      return;
    }

    if (signalType === 'answer') {
      console.log('[WebRTC] Received answer, setting remote description...');
      const sessionDesc = signalPayload?.sdp?.type
        ? signalPayload.sdp
        : (typeof signalPayload?.sdp === 'string'
            ? { type: 'answer', sdp: signalPayload.sdp }
            : (signalPayload?.type ? signalPayload : { type: 'answer', sdp: signalPayload }));
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sessionDesc));
      await this.processCandidateQueue();
      return;
    }

    if (signalType === 'ice-candidate' || signalType === 'candidate' || signalPayload?.candidate) {
      console.log('[WebRTC] Received remote ICE candidate from signaling');
      const candidate = signalPayload?.candidate !== undefined && typeof signalPayload.candidate === 'object'
        ? signalPayload.candidate
        : signalPayload;
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
