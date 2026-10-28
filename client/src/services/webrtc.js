// client/src/services/webrtc.js
import { socket as defaultSocket } from './socket.js';

let pc = null;
let dataChannel = null;
let candidateQueue = [];
let isSettingRemote = false;

let cachedIceServers = null;

export async function getIceServers() {
  if (cachedIceServers) return cachedIceServers;
  try {
    const baseUrl = import.meta.env?.VITE_SERVER_URL || '';
    const res = await fetch(`${baseUrl}/api/webrtc-config`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        cachedIceServers = data.iceServers;
        return cachedIceServers;
      }
    }
  } catch (err) {
    console.warn('[WebRTC ⚠️] Failed to load backend ICE servers, falling back to STUN:', err);
  }
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
}

export const CHUNK_SIZE = 16384; // 16 KB - Safe across all mobile cellular/TURN links
export const MAX_BUFFER_AMOUNT = 65536; // 64 KB max backpressure ceiling

export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

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

export async function initWebRTCSession({ role, socket = defaultSocket, pairingId, onConnected, onMessage, onError }) {
  cleanupWebRTC();

  const iceServers = await getIceServers();

  pc = new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 2
  });

  function setupDataChannel(channel) {
    if (!channel) return;
    channel.binaryType = 'arraybuffer';
    dataChannel = channel;
    channel.bufferedAmountLowThreshold = 32768; // 32 KB threshold

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
    };

    dataChannel.onclose = () => {
      console.log('[WebRTC] DataChannel closed');
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

  // Tolerant ICE connection monitoring (do NOT fail on temporary 'disconnected')
  pc.oniceconnectionstatechange = () => {
    console.log('[WebRTC 📡] ICE Connection State:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') {
      console.error('[WebRTC ❌] ICE connection permanently failed');
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
      setupDataChannel(event.channel);
    };
  }

  // Initiator sets up DataChannel and creates offer
  if (role === 'initiator') {
    console.log('[WebRTC 🛠️] Initiator creating DataChannel');
    const channel = pc.createDataChannel('fileTransfer', { ordered: true });
    channel.binaryType = 'arraybuffer';
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
