export function getIceServers() {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ICE_SERVERS) {
    try {
      const parsed = JSON.parse(import.meta.env.VITE_ICE_SERVERS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // Fall back to default STUN + TURN servers if environment variable is not valid JSON
    }
  }
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // Free open TURN relay for symmetric NAT traversal
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
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
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.onSignal('ice-candidate', event.candidate);
      }
    };
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      this.onStateChange(state);
      if (['failed', 'disconnected', 'closed'].includes(state)) {
        this.onError?.(new Error(`WebRTC connection ${state}.`));
      }
    };
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      if (['failed', 'disconnected'].includes(state)) {
        this.onStateChange(state);
        this.onError?.(new Error(`WebRTC ICE connection ${state}.`));
      }
    };
    this.peerConnection.ondatachannel = (event) => {
      this.#attachDataChannel(event.channel);
    };

    if (this.role === 'initiator') {
      const channel = this.peerConnection.createDataChannel('fileTransfer', {
        ordered: true
      });
      this.#attachDataChannel(channel);
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      this.onSignal('offer', this.peerConnection.localDescription);
    }
  }

  async handleRemoteCandidate(candidate) {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) {
      this.candidateQueue.push(candidate);
      return;
    }
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Failed to add candidate:', err);
    }
  }

  async processCandidateQueue() {
    while (this.candidateQueue.length > 0) {
      const candidate = this.candidateQueue.shift();
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
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

  #attachDataChannel(channel) {
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 2 * 1024 * 1024;
    channel.onopen = () => this.onStateChange('data-channel-open');
    channel.onclose = () => this.onStateChange('data-channel-closed');
    channel.onerror = (event) => this.onError?.(event.error ?? new Error('Data channel error.'));
    channel.onmessage = (event) => {
      this.messageQueue = this.messageQueue
        .then(() => this.onMessage(event.data))
        .catch((error) => this.onError?.(error));
    };
  }
}
