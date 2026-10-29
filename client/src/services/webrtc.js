// client/src/services/webrtc.js
import { socket as defaultSocket } from './socket.js';

let pc = null;
let dataChannel = null;
let candidateQueue = [];
let isSettingRemote = false;

export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  {
    urls: 'turn:global.relay.metered.ca:80',
    username: '3dc1c2b18b0177646c75916f',
    credential: 'Rbg/S3hU0+KhOoEq'
  },
  {
    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
    username: '3dc1c2b18b0177646c75916f',
    credential: 'Rbg/S3hU0+KhOoEq'
  },
  {
    urls: 'turn:global.relay.metered.ca:443',
    username: '3dc1c2b18b0177646c75916f',
    credential: 'Rbg/S3hU0+KhOoEq'
  },
  {
    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
    username: '3dc1c2b18b0177646c75916f',
    credential: 'Rbg/S3hU0+KhOoEq'
  }
];

export const STATIC_ICE_SERVERS = ICE_SERVERS;

export function getIceServers() {
  return ICE_SERVERS;
}

// Universal 64 KB chunk size: safe across all modern mobile browsers and cellular/TURN relays
export const CHUNK_SIZE = 64 * 1024; // 65,536 bytes (64 KB)

// High-throughput backpressure limits (2 MB ceiling, 512 KB threshold)
export const MAX_BUFFER_CEILING = 2 * 1024 * 1024; // 2 MB
export const MAX_BUFFER_AMOUNT = MAX_BUFFER_CEILING;
export const BUFFER_LOW_THRESHOLD = 512 * 1024; // 512 KB

export function cleanupWebRTC() {
  if (dataChannel) {
    dataChannel.onopen = null;
    dataChannel.onmessage = null;
    dataChannel.onerror = null;
    dataChannel.onclose = null;
    try { dataChannel.close(); } catch (e) {}
    dataChannel = null;
  }
  if (pc) {
    pc.onicecandidate = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.ondatachannel = null;
    try { pc.close(); } catch (e) {}
    pc = null;
  }
  candidateQueue = [];
  isSettingRemote = false;
}

export async function initWebRTCSession({ role, socket = defaultSocket, pairingId, onConnected, onMessage, onError, onClose }) {
  cleanupWebRTC();

  pc = new RTCPeerConnection({
    iceServers: getIceServers(),
    iceCandidatePoolSize: 2
  });

  function setupDataChannel(channel) {
    if (!channel) return;
    channel.binaryType = 'arraybuffer';
    dataChannel = channel;
    // Set threshold to 512 KB so we wake up before the buffer completely drains
    channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

    if (dataChannel.readyState === 'open') {
      dataChannel.binaryType = 'arraybuffer';
      console.log('[WebRTC ⚡] DataChannel already open');
      onConnected?.();
    } else {
      dataChannel.onopen = () => {
        dataChannel.binaryType = 'arraybuffer';
        console.log('[WebRTC 🎉] DataChannel opened successfully');
        onConnected?.();
      };
    }

    dataChannel.onmessage = (event) => {
      if (onMessage) onMessage(event.data);
    };

    dataChannel.onerror = (err) => {
      console.error('[WebRTC ❌] DataChannel error:', err);
      onError?.(err);
    };

    dataChannel.onclose = () => {
      console.log('[WebRTC] DataChannel closed');
      onClose?.();
    };
  }

  // Handle local ICE candidates and emit to peer
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && candidate.candidate) {
      socket.emit('webrtc_signal', {
        pairingId,
        signal: { type: 'candidate', candidate }
      });
    }
  };

  // Do not prematurely abort on transient states
  pc.oniceconnectionstatechange = () => {
    console.log('[WebRTC 📡] ICE State:', pc.iceConnectionState);
    // Only trigger error on fatal failure, never on 'disconnected'
    if (pc.iceConnectionState === 'failed') {
      console.error('[WebRTC ❌] ICE connection failed completely');
      if (onError) onError(new Error('WebRTC failed to establish network route.'));
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[WebRTC 🔗] Peer Connection State:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      console.log('[WebRTC 🚀] Peer-to-peer link connected!');
    } else if (pc.connectionState === 'failed') {
      if (onError) onError(new Error('Direct WebRTC connection failed.'));
    }
  };

  // Receiver waits for incoming remote DataChannel
  if (role === 'receiver') {
    pc.ondatachannel = (event) => {
      console.log('[WebRTC 📥] Received remote DataChannel');
      event.channel.binaryType = 'arraybuffer';
      event.channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
      setupDataChannel(event.channel);
    };
  }

  // Initiator sets up DataChannel and creates offer
  if (role === 'initiator') {
    console.log('[WebRTC 🛠️] Initiator creating DataChannel');
    const channel = pc.createDataChannel('fileTransfer', { ordered: true });
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
    setupDataChannel(channel);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log('[WebRTC 📤] Emitting offer');
      socket.emit('webrtc_signal', {
        pairingId,
        signal: { type: 'offer', sdp: offer }
      });
    } catch (err) {
      console.error('[WebRTC ❌] Failed to create offer:', err);
      if (onError) onError(err);
    }
  }

  return {
    async handleSignal(signalOrEnvelope) {
      if (!pc) return;
      const signal = (signalOrEnvelope && signalOrEnvelope.signal) ? signalOrEnvelope.signal : signalOrEnvelope;
      if (!signal) return;

      try {
        if (signal.type === 'offer') {
          console.log('[WebRTC 📥] Handling incoming offer');
          isSettingRemote = true;
          const sessionDesc = signal.sdp?.type ? signal.sdp : (typeof signal.sdp === 'string' ? { type: 'offer', sdp: signal.sdp } : (signal.type ? signal : { type: 'offer', sdp: signal.sdp }));
          await pc.setRemoteDescription(new RTCSessionDescription(sessionDesc));
          isSettingRemote = false;

          // Flush queued candidates
          while (candidateQueue.length > 0) {
            const cand = candidateQueue.shift();
            try {
              await pc.addIceCandidate(cand instanceof RTCIceCandidate ? cand : new RTCIceCandidate(cand));
            } catch (candErr) {
              console.warn('[WebRTC ⚠️] Error adding queued ICE candidate:', candErr);
            }
          }

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          console.log('[WebRTC 📤] Emitting answer');
          socket.emit('webrtc_signal', {
            pairingId,
            signal: { type: 'answer', sdp: answer }
          });
        } 
        else if (signal.type === 'answer') {
          console.log('[WebRTC 📥] Handling incoming answer');
          isSettingRemote = true;
          const sessionDesc = signal.sdp?.type ? signal.sdp : (typeof signal.sdp === 'string' ? { type: 'answer', sdp: signal.sdp } : (signal.type ? signal : { type: 'answer', sdp: signal.sdp }));
          await pc.setRemoteDescription(new RTCSessionDescription(sessionDesc));
          isSettingRemote = false;

          while (candidateQueue.length > 0) {
            const cand = candidateQueue.shift();
            try {
              await pc.addIceCandidate(cand instanceof RTCIceCandidate ? cand : new RTCIceCandidate(cand));
            } catch (candErr) {
              console.warn('[WebRTC ⚠️] Error adding queued ICE candidate:', candErr);
            }
          }
        } 
        else if (signal.type === 'candidate' && signal.candidate) {
          const rawCand = signal.candidate;
          if (pc.remoteDescription && pc.remoteDescription.type && !isSettingRemote) {
            try {
              await pc.addIceCandidate(rawCand instanceof RTCIceCandidate ? rawCand : new RTCIceCandidate(rawCand));
            } catch (candErr) {
              console.warn('[WebRTC ⚠️] Error adding ICE candidate:', candErr);
            }
          } else {
            candidateQueue.push(rawCand);
          }
        }
      } catch (err) {
        console.error('[WebRTC ❌] Signal handling error:', err);
      }
    },

    sendChunk(chunk) {
      if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(chunk);
        return true;
      }
      return false;
    },

    getDataChannel() {
      return dataChannel;
    }
  };
}

export class WebRtcSession {
  constructor({ role, socket = defaultSocket, pairingId, onConnected, onMessage, onError, onStateChange, onSignal }) {
    this.role = role;
    this.socket = socket;
    this.pairingId = pairingId;
    this.onConnected = onConnected;
    this.onMessage = onMessage;
    this.onError = onError;
    this.onStateChange = onStateChange;
    this.onSignal = onSignal;
    this.session = null;
  }

  get dataChannel() {
    return dataChannel;
  }

  getDataChannel() {
    return dataChannel;
  }

  async start() {
    const socketProxy = this.socket || {
      emit: (event, payload) => {
        if (event === 'webrtc_signal') {
          if (this.onSignal) {
            this.onSignal(payload);
          } else {
            defaultSocket.emit(event, payload);
          }
        }
      }
    };

    this.session = await initWebRTCSession({
      role: this.role,
      socket: socketProxy,
      pairingId: this.pairingId,
      onConnected: () => {
        this.onConnected?.();
        this.onStateChange?.('data-channel-open');
      },
      onMessage: this.onMessage,
      onError: (err) => {
        this.onError?.(err);
        this.onStateChange?.('failed');
      },
      onClose: () => {
        this.onStateChange?.('data-channel-closed');
      }
    });
    return this.session;
  }

  async handleSignal(signal) {
    if (this.session) {
      await this.session.handleSignal(signal);
    }
  }

  send(data) {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(data);
      return true;
    }
    throw new Error('The data channel is not open.');
  }

  sendChunk(chunk) {
    return this.session ? this.session.sendChunk(chunk) : false;
  }

  close() {
    cleanupWebRTC();
  }
}

export async function startSession(config) {
  const session = new WebRtcSession(config);
  await session.start();
  return session;
}
