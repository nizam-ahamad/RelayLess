export function getIceServers() {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ICE_SERVERS) {
    try {
      const parsed = JSON.parse(import.meta.env.VITE_ICE_SERVERS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // Fall back to default STUN
    }
  }
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
  constructor({ role, onMessage, onStateChange, onSignal, onError }) {
    this.role = role;
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

  async start() {
    activeSession = this;
    this.peerConnection = new RTCPeerConnection({ iceServers: getIceServers() });

    // Trickle ICE: emit each candidate immediately the moment it is generated
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        const candidatePayload = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
        this.onSignal('ice-candidate', candidatePayload);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log('⚡ WebRTC connectionState:', state);
      if (state === 'connected') {
        this.onStateChange('connected');
      } else if (['failed', 'disconnected', 'closed'].includes(state)) {
        this.onStateChange(state);
        this.onError?.(new Error(`WebRTC connection ${state}.`));
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      console.log('⚡ WebRTC iceConnectionState:', state);
      if (state === 'connected' || state === 'completed') {
        if (this.dataChannel?.readyState === 'open') {
          this.onStateChange('data-channel-open');
        }
      } else if (['failed', 'disconnected'].includes(state)) {
        this.onStateChange(state);
        this.onError?.(new Error(`WebRTC ICE connection ${state}.`));
      }
    };

    // Receiver side: attach incoming DataChannel
    this.peerConnection.ondatachannel = (event) => {
      console.log('⚡ WebRTC ondatachannel received on receiver!');
      this.setupDataChannelEvents(event.channel);
    };

    // Initiator side: create DataChannel immediately
    if (this.role === 'initiator') {
      const channel = this.peerConnection.createDataChannel('fileTransfer', {
        ordered: true
      });
      this.setupDataChannelEvents(channel);
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      this.onSignal('offer', this.peerConnection.localDescription);
    }
  }

  setupDataChannelEvents(channel) {
    if (!channel) return;
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 2 * 1024 * 1024;

    const onConnected = () => {
      console.log('⚡ WebRTC DataChannel OPEN - Instant link ready!');
      this.onStateChange('data-channel-open');
    };

    // Fast-path: if DataChannel is already open (common on receiver side)
    if (channel.readyState === 'open') {
      onConnected();
    } else {
      channel.onopen = onConnected;
    }

    channel.onclose = () => {
      console.log('⚡ WebRTC DataChannel closed');
      this.onStateChange('data-channel-closed');
    };
    channel.onerror = (event) => this.onError?.(event.error ?? new Error('Data channel error.'));
    channel.onmessage = (event) => {
      this.messageQueue = this.messageQueue
        .then(() => this.onMessage(event.data))
        .catch((error) => this.onError?.(error));
    };
  }

  async handleRemoteCandidate(candidate) {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) {
      this.candidateQueue.push(candidate);
      return;
    }
    try {
      const iceCandidate = candidate instanceof RTCIceCandidate ? candidate : new RTCIceCandidate(candidate);
      await this.peerConnection.addIceCandidate(iceCandidate);
    } catch (err) {
      console.error('Failed to add candidate:', err);
    }
  }

  async processCandidateQueue() {
    while (this.candidateQueue.length > 0) {
      const candidate = this.candidateQueue.shift();
      try {
        const iceCandidate = candidate instanceof RTCIceCandidate ? candidate : new RTCIceCandidate(candidate);
        await this.peerConnection.addIceCandidate(iceCandidate);
      } catch (err) {
        console.error('Failed to drain candidate:', err);
      }
    }
  }

  async handleSignal(type, data) {
    if (!this.peerConnection) {
      await this.start();
    }

    if (type === 'offer') {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data));
      await this.processCandidateQueue();
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      this.onSignal('answer', this.peerConnection.localDescription);
      return;
    }

    if (type === 'answer') {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data));
      await this.processCandidateQueue();
      return;
    }

    if (type === 'ice-candidate' && data) {
      await this.handleRemoteCandidate(data);
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
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.dataChannel = null;
    this.peerConnection = null;
    if (activeSession === this) {
      activeSession = null;
    }
  }
}
