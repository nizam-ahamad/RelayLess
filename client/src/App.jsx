import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCodeDisplay from './components/QRCodeDisplay.jsx';
import QRScannerModal from './components/QRScannerModal.jsx';
import PinInput from './components/PinInput.jsx';
import ConfirmationModal from './components/ConfirmationModal.jsx';
import IncomingFileModal from './components/IncomingFileModal.jsx';
import FileDropZone from './components/FileDropZone.jsx';
import TransferProgress from './components/TransferProgress.jsx';
import { connectSocket, disconnectSocket, emitSocket, onSocketEvent, socket } from './services/socket.js';
import { WebRtcSession } from './services/webrtc.js';
import { createFileReceiver } from './services/fileReceiver.js';
import { sendFile } from './services/fileSender.js';
import { sanitizeFileName } from './utils/sanitize.js';
import { formatBytes } from './utils/format.js';

function readSliceAsArrayBuffer(slice) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsArrayBuffer(slice);
  });
}

const DEFAULT_DEVICE_NAME = 'My device';

export default function App() {
  const [peer, setPeer] = useState(null);
  const [connectionState, setConnectionState] = useState('connecting');
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem('p2p-device-name') || DEFAULT_DEVICE_NAME);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState(false);
  const [pinSeconds, setPinSeconds] = useState(120);
  const [prompt, setPrompt] = useState(null);
  const [verificationCode, setVerificationCode] = useState(null);
  const [step, setStep] = useState(null);
  const [waitingForAcceptance, setWaitingForAcceptance] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [transfer, setTransfer] = useState(null);
  const [incomingTransfer, setIncomingTransfer] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selectedPeer, setSelectedPeer] = useState(null);
  const [partnerSocketId, setPartnerSocketId] = useState(null);
  const [webrtcRole, setWebrtcRole] = useState(null);
  const [roomId, setRoomId] = useState(null);

  const displayCode = verificationCode ? String(verificationCode).padStart(2, '0') : '--';
  const sessionRef = useRef(null);
  const transferAbortRef = useRef(null);
  const receiverRef = useRef(null);
  const incomingTransferRef = useRef(null);
  const incomingFileRef = useRef({
    metadata: null,
    totalExpectedBytes: 0,
    receivedBytes: 0,
    chunks: [],
    saved: false
  });
  const currentPairingIdRef = useRef(null);
  const roomIdRef = useRef(null);
  const connectionTimeoutRef = useRef(null);
  const pendingSignalsRef = useRef([]);
  const partnerSocketIdRef = useRef(null);
  const webrtcRoleRef = useRef(null);
  const pendingFilesRef = useRef(null);
  const handleFilesRef = useRef(null);
  const pairPeerId = useMemo(() => new URLSearchParams(window.location.search).get('pair'), []);
  const autoPairRequestedRef = useRef(false);

  const pairingUrl = useMemo(() => {
    if (!peer?.peerId) {
      return '';
    }
    const url = new URL(window.location.href);
    url.search = `?pair=${encodeURIComponent(peer.peerId)}`;
    url.hash = '';
    return url.toString();
  }, [peer?.peerId]);

  const showNotice = useCallback((type, message) => {
    setNotice({ type, message });
    window.setTimeout(() => setNotice((current) => (current?.message === message ? null : current)), 5500);
  }, []);

  const closeSession = useCallback((message) => {
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    pendingSignalsRef.current = [];
    pendingFilesRef.current = null;
    partnerSocketIdRef.current = null;
    webrtcRoleRef.current = null;
    roomIdRef.current = null;
    setPartnerSocketId(null);
    setWebrtcRole(null);
    setRoomId(null);
    incomingTransferRef.current?.resolve(null);
    incomingTransferRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    receiverRef.current?.cancel?.().catch?.(() => {});
    receiverRef.current = null;
    transferAbortRef.current?.abort();
    transferAbortRef.current = null;
    currentPairingIdRef.current = null;
    setSelectedPeer(null);
    setTransfer(null);
    setIncomingTransfer(null);
    setPrompt(null);
    setVerificationCode(null);
    setStep(null);
    setWaitingForAcceptance(false);
    setConnectionState('ready');
    if (message) {
      showNotice('info', message);
    }
  }, [showNotice]);

  const receiverCallbacks = useCallback(() => ({
    onProgress: (progress) => setTransfer((current) => ({
      ...(current || {}),
      ...progress,
      bytesTransferred: progress.bytesReceived,
      percent: progress.percent,
      direction: 'receiving',
      status: 'Receiving'
    })),
    onComplete: (completed) => {
      setTransfer((current) => ({
        ...(current || {}),
        ...completed,
        bytesTransferred: completed.bytesReceived,
        percent: 100,
        direction: 'receiving',
        status: 'Complete'
      }));
      showNotice('success', `${completed.fileName} was saved to your device.`);
    },
    onError: (error) => {
      showNotice('error', error.message || 'Could not prepare a destination file.');
      setTransfer(null);
    }
  }), [showNotice]);

  const acceptIncomingTransfer = useCallback(async () => {
    const pending = incomingTransferRef.current;
    if (!pending) {
      return;
    }

    try {
      const receiver = await createFileReceiver(pending.metadata, receiverCallbacks());
      receiverRef.current = receiver;
      setTransfer({
        transferId: pending.metadata.transferId,
        fileName: pending.metadata.fileName,
        fileSize: pending.metadata.fileSize,
        bytesTransferred: 0,
        percent: 0,
        direction: 'receiving',
        status: 'Ready to receive'
      });
      setIncomingTransfer(null);
      incomingTransferRef.current = null;
      pending.resolve(receiver);
    } catch {
      setIncomingTransfer(null);
      incomingTransferRef.current = null;
      pending.resolve(null);
    }
  }, [receiverCallbacks]);

  const rejectIncomingTransfer = useCallback(() => {
    const pending = incomingTransferRef.current;
    if (!pending) {
      return;
    }
    setIncomingTransfer(null);
    incomingTransferRef.current = null;
    pending.resolve(null);
  }, []);

  const sendSignal = useCallback(({ pairingId, signal }) => {
    const id = pairingId || currentPairingIdRef.current;
    const signalType = signal?.type || (signal?.candidate ? 'candidate' : 'signal');
    console.log(`[WebRTC] Emitting 'webrtc_signal' for pairing ${id}:`, signalType);

    emitSocket('webrtc_signal', {
      pairingId: id,
      signal
    });
  }, []);

  const handleIncomingSignal = useCallback(async ({ signal } = {}) => {
    if (!signal) return;
    const signalType = signal?.type || (signal?.candidate ? 'candidate' : 'signal');
    console.log(`[WebRTC] ⚡ Received 'webrtc_signal':`, signalType);

    if (!sessionRef.current) {
      console.log(`[WebRTC] Session not ready yet. Buffering signal: ${signalType}`);
      pendingSignalsRef.current.push(signal);
      return;
    }

    try {
      await sessionRef.current.handleSignal(signal);
    } catch (error) {
      console.error('[WebRTC] Signal handling error:', error);
      showNotice('error', error.message || 'Could not complete the WebRTC handshake.');
    }
  }, [showNotice]);

  const saveIncomingFile = useCallback(() => {
    const incoming = incomingFileRef.current;
    if (!incoming || !incoming.metadata || incoming.saved) {
      return;
    }
    incoming.saved = true;

    const fileName = incoming.metadata.fileName || 'download';
    const fileType = incoming.metadata.fileType || 'application/octet-stream';
    const totalBytes = incoming.receivedBytes;

    console.log(`[Transfer] Complete! Assembling ${incoming.chunks.length} chunks (${totalBytes} bytes) for ${fileName}`);

    try {
      const blob = new Blob(incoming.chunks, { type: fileType });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
      }, 10000);

      setTransfer((current) => ({
        ...(current || {}),
        fileName,
        fileSize: totalBytes,
        bytesTransferred: totalBytes,
        percent: 100,
        direction: 'receiving',
        status: 'Complete'
      }));

      showNotice('success', `${fileName} (${formatBytes(totalBytes)}) downloaded successfully.`);
    } catch (err) {
      console.error('[Transfer] Failed to assemble or download file:', err);
      showNotice('error', `Failed to save ${fileName}: ${err.message}`);
    }
  }, [showNotice]);

  const handleChannelMessage = useCallback(async (data) => {
    // 1. Distinguish between metadata messages (JSON strings) and actual binary chunks (ArrayBuffer)
    if (typeof data === 'string') {
      let packet;
      try {
        packet = JSON.parse(data);
      } catch {
        return;
      }

      if (packet.type === 'METADATA') {
        const fileName = sanitizeFileName(packet.fileName || packet.name || 'received-file');
        const totalExpectedBytes = Number(packet.fileSize ?? packet.size ?? 0);
        const fileType = packet.fileType || 'application/octet-stream';

        console.log('[Transfer] Received METADATA:', fileName, totalExpectedBytes, 'bytes');

        incomingFileRef.current = {
          metadata: { ...packet, fileName, fileSize: totalExpectedBytes, fileType },
          totalExpectedBytes,
          receivedBytes: 0,
          chunks: [],
          saved: false
        };

        setTransfer({
          fileName,
          fileSize: totalExpectedBytes,
          bytesTransferred: 0,
          percent: 0,
          direction: 'receiving',
          status: 'Receiving'
        });

        // If file is 0 bytes, complete immediately
        if (totalExpectedBytes === 0) {
          saveIncomingFile();
        }
        return;
      }

      if (packet.type === 'eof' || packet.type === 'COMPLETE') {
        console.log(`[Transfer] Received ${packet.type} message from sender`);
        saveIncomingFile();
        return;
      }

      if (packet.type === 'CANCEL') {
        incomingFileRef.current = {
          metadata: null,
          totalExpectedBytes: 0,
          receivedBytes: 0,
          chunks: [],
          saved: false
        };
        setTransfer(null);
        showNotice('info', 'The other device cancelled the transfer.');
        return;
      }
      return;
    }

    // 2. Binary chunk reception (ArrayBuffer or binary chunk)
    let chunkBuffer;
    if (data instanceof ArrayBuffer) {
      chunkBuffer = data;
    } else if (ArrayBuffer.isView(data)) {
      chunkBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else if (data instanceof Blob) {
      chunkBuffer = await data.arrayBuffer();
    } else {
      console.warn('[Transfer] Unexpected binary chunk type:', data);
      return;
    }

    const incoming = incomingFileRef.current;
    if (!incoming || !incoming.metadata) {
      console.warn('[Transfer] Received binary chunk before metadata');
      return;
    }

    incoming.chunks.push(chunkBuffer);
    incoming.receivedBytes += chunkBuffer.byteLength;

    const receivedBytes = incoming.receivedBytes;
    const totalExpectedBytes = incoming.totalExpectedBytes;

    console.log('[Transfer] Received bytes:', receivedBytes, '/', totalExpectedBytes);

    const percent = totalExpectedBytes > 0 
      ? Math.min(100, (receivedBytes / totalExpectedBytes) * 100) 
      : 100;

    setTransfer((current) => ({
      ...(current || {}),
      fileName: incoming.metadata?.fileName || 'Incoming file',
      fileSize: totalExpectedBytes,
      bytesTransferred: receivedBytes,
      percent,
      direction: 'receiving',
      status: 'Receiving'
    }));

    // Do NOT trigger file download/save until receivedBytes >= totalSize (or an explicit { type: 'eof' } message is received).
    if (totalExpectedBytes > 0 && receivedBytes >= totalExpectedBytes) {
      saveIncomingFile();
    }
  }, [saveIncomingFile, showNotice]);

  const startWebRtc = useCallback(async ({ role, pairingId, partnerSocketId, partnerName }) => {
    sessionRef.current?.close();
    console.log(`[WebRTC] Starting WebRtcSession. Role: ${role}, Pairing: ${pairingId}`);
    const targetName = partnerName || 'device';
    const session = new WebRtcSession({
      role,
      socket,
      pairingId: pairingId || currentPairingIdRef.current,
      partnerSocketId: partnerSocketId || partnerSocketIdRef.current,
      onMessage: handleChannelMessage,
      onSignal: sendSignal,
      onConnected: () => {
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        console.log('[WebRTC] ⚡ DataChannel OPENED! Setting connectionState = connected.');
        setConnectionState('connected');
        emitSocket('webrtc_ready', { pairingId: pairingId || currentPairingIdRef.current });
        showNotice('success', `Direct encrypted bridge established with ${targetName}.`);

        if (pendingFilesRef.current) {
          const queuedFiles = pendingFilesRef.current;
          pendingFilesRef.current = null;
          console.log('[WebRTC] Data channel ready, auto-starting queued file transfer...');
          handleFilesRef.current?.(queuedFiles);
        }
      },
      onStateChange: (state) => {
        console.log(`[WebRTC] onStateChange: ${state}`);
        if (state === 'data-channel-open') {
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          console.log('[WebRTC] ⚡ DataChannel OPENED! Setting connectionState = connected.');
          setConnectionState('connected');
          emitSocket('webrtc_ready', { pairingId: pairingId || currentPairingIdRef.current });
          showNotice('success', `Direct encrypted bridge established with ${targetName}.`);

          if (pendingFilesRef.current) {
            const queuedFiles = pendingFilesRef.current;
            pendingFilesRef.current = null;
            console.log('[WebRTC] Data channel ready, auto-starting queued file transfer...');
            handleFilesRef.current?.(queuedFiles);
          }
        } else if (state === 'data-channel-closed') {
          console.log('[WebRTC] DataChannel closed');
          setConnectionState((current) => current === 'connected' ? 'ready' : current);
        } else if (state === 'failed') {
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          console.warn('[WebRTC] Connection failed');
          setConnectionState('failed');
          showNotice('error', 'WebRTC connection dropped. Could not traverse network firewalls.');
        } else if (state === 'disconnected') {
          console.log('[WebRTC] Connection state is disconnected (transient, waiting to re-establish)');
        }
      },
      onError: (error) => {
        console.error('[WebRTC] Session error:', error);
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        setConnectionState('failed');
        showNotice('error', error.message || 'WebRTC connection failed.');
      }
    });
    sessionRef.current = session;
    await session.start();

    if (pendingSignalsRef.current.length > 0) {
      console.log(`[WebRTC] Draining ${pendingSignalsRef.current.length} buffered early signaling packets`);
      while (pendingSignalsRef.current.length > 0) {
        const item = pendingSignalsRef.current.shift();
        try {
          await session.handleSignal(item);
        } catch (err) {
          console.error('[WebRTC] Error handling early buffered signal:', err);
        }
      }
    }
  }, [handleChannelMessage, sendSignal, showNotice]);

  const handlePairingConfirmed = useCallback(async (payload) => {
    console.log('[Signaling] ⚡ Received pairing_confirmed event:', payload);
    try {
      const pairingId = payload.pairingId || payload.id;
      const role = payload.role || (payload.initiator ? 'initiator' : 'receiver');
      const targetSocketId = payload.partnerSocketId || (role === 'initiator' ? payload.targetSocketId : payload.initiatorSocketId) || payload.otherSocketId;

      const partnerName = payload.partnerName || payload.deviceName || 'device';

      console.log(`[Signaling] Confirmed pairing ${pairingId}. Role: ${role}, Partner: ${partnerName}`);

      currentPairingIdRef.current = pairingId;
      partnerSocketIdRef.current = targetSocketId;
      setPartnerSocketId(targetSocketId);
      webrtcRoleRef.current = role;
      setWebrtcRole(role);

      setPrompt(null);
      setVerificationCode(null);
      setStep('connected');
      setWaitingForAcceptance(false);
      setSelectedPeer({
        ...payload,
        pairingId,
        targetSocketId: partnerSocketIdRef.current,
        partnerSocketId: targetSocketId,
        role,
        deviceName: partnerName,
        partnerName
      });

      // Synchronize: set connecting (NOT connected) until dataChannel.onopen fires
      setConnectionState('connecting');
      showNotice('info', `Connecting to ${partnerName}...`);

      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      connectionTimeoutRef.current = setTimeout(() => {
        const channel = sessionRef.current?.dataChannel;
        if (!channel || channel.readyState !== 'open') {
          console.warn('[WebRTC] Connection watchdog timed out after 25 seconds');
          closeSession('Connection timed out. Could not establish P2P bridge with other device.');
        }
      }, 25000);

      await startWebRtc({
        role,
        pairingId,
        partnerSocketId: targetSocketId,
        partnerName
      });
    } catch (error) {
      console.error('[Signaling] Fatal error in handlePairingConfirmed:', error);
      showNotice('error', `Failed to start connection: ${error.message}`);
      setConnectionState('failed');
    }
  }, [closeSession, startWebRtc, showNotice]);

  const handlePairingConfirmedRef = useRef(handlePairingConfirmed);
  handlePairingConfirmedRef.current = handlePairingConfirmed;

  const handleIncomingSignalRef = useRef(handleIncomingSignal);
  handleIncomingSignalRef.current = handleIncomingSignal;

  const closeSessionRef = useRef(closeSession);
  closeSessionRef.current = closeSession;

  const showNoticeRef = useRef(showNotice);
  showNoticeRef.current = showNotice;

  useEffect(() => {
    localStorage.setItem('p2p-device-name', deviceName);
    setPeer((current) => current ? { ...current, deviceName } : current);
    emitSocket('set_device_name', { deviceName });
  }, [deviceName]);

  useEffect(() => {
    if (!pairPeerId || !peer?.peerId || peer.peerId === pairPeerId || autoPairRequestedRef.current) {
      return;
    }
    autoPairRequestedRef.current = true;
    emitSocket('request_pairing', { targetPeerId: pairPeerId, deviceName });
    setConnectionState('requesting');
  }, [deviceName, pairPeerId, peer?.peerId]);

  useEffect(() => {
    const socket = connectSocket();
    if (socket.connected) {
      setConnectionState((current) => current === 'connecting' ? 'ready' : current);
    }
    const cleanups = [
      onSocketEvent('connect', () => setConnectionState((current) => current === 'connecting' ? 'ready' : current)),
      onSocketEvent('disconnect', () => {
        setConnectionState('offline');
        showNoticeRef.current('error', 'Signaling server disconnected. Retrying automatically…');
      }),
      onSocketEvent('connect_error', () => setConnectionState('offline')),
      onSocketEvent('peer_ready', (nextPeer) => {
        setPeer(nextPeer);
        setPinSeconds(nextPeer.expiresIn ?? 120);
        setConnectionState((current) => (current === 'connecting' && !currentPairingIdRef.current) || current === 'offline' ? 'ready' : current);
      }),
      onSocketEvent('update_pin', (nextPin) => {
        setPeer((current) => ({ ...(current || {}), ...nextPin }));
        setPinSeconds(nextPin.expiresIn ?? 120);
      }),
      onSocketEvent('session_matched', ({ verificationCode: vCode, confirmationCode: cCode, ...payload } = {}) => {
        const code = vCode ?? cCode;
        setVerificationCode(code);
        setStep('verify');
        setPrompt({ ...payload, verificationCode: code, confirmationCode: code });
        setWaitingForAcceptance(false);
        setConnectionState('pairing');
      }),
      onSocketEvent('paired', ({ verificationCode: vCode, confirmationCode: cCode, ...payload } = {}) => {
        const code = vCode ?? cCode;
        setVerificationCode(code);
        setStep('verify');
        setPrompt({ ...payload, verificationCode: code, confirmationCode: code });
        setWaitingForAcceptance(false);
        setConnectionState('pairing');
      }),
      onSocketEvent('pairing_prompt', (nextPrompt) => {
        currentPairingIdRef.current = nextPrompt.pairingId;
        const code = nextPrompt.verificationCode ?? nextPrompt.confirmationCode;
        setVerificationCode(code);
        setStep('verify');
        setPrompt(nextPrompt);
        setWaitingForAcceptance(false);
        setConnectionState('pairing');
      }),
      onSocketEvent('pairing_acknowledged', (payload) => {
        showNoticeRef.current('info', `The ${payload.approvedByRole === 'requester' ? 'requesting' : 'receiving'} device approved. Confirm on your screen to continue.`);
      }),
      onSocketEvent('pairing_confirmed', (payload) => handlePairingConfirmedRef.current(payload)),
      onSocketEvent('webrtc_signal', (payload) => handleIncomingSignalRef.current(payload)),
      onSocketEvent('signal', (payload) => handleIncomingSignalRef.current(payload)),
      onSocketEvent('connection_ready', (payload) => {
        setSelectedPeer(payload);
        setConnectionState('connected');
        showNoticeRef.current('success', `Connected directly to ${payload.deviceName}.`);
      }),
      onSocketEvent('pairing_error', (error) => {
        setPrompt(null);
        setWaitingForAcceptance(false);
        setConnectionState('ready');
        showNoticeRef.current('error', error.message || 'Unable to start pairing.');
      }),
      onSocketEvent('pairing_rejected', (payload) => closeSessionRef.current(payload.message)),
      onSocketEvent('pairing_cancelled', (payload) => closeSessionRef.current(payload.message)),
      onSocketEvent('peer_disconnected', () => closeSessionRef.current('The other device disconnected.'))
    ];

    if (pairPeerId) {
      setSelectedPeer({ peerId: pairPeerId });
    }

    return () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      cleanups.forEach((cleanup) => cleanup());
      sessionRef.current?.close();
    };
  }, [pairPeerId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPinSeconds((current) => current > 0 ? current - 1 : 0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleJoinSession = useCallback((scannedInput) => {
    if (!scannedInput) return;
    const text = String(scannedInput).trim();
    let scannedPin = null;
    let scannedTargetPeerId = null;

    try {
      const url = new URL(text);
      scannedPin = url.searchParams.get('pin');
      scannedTargetPeerId = url.searchParams.get('pair') || url.searchParams.get('peerId') || url.searchParams.get('targetPeerId');
    } catch {
      const normalized = text.toUpperCase();
      if (normalized.length === 6 && /^[A-Z0-9]{6}$/.test(normalized)) {
        scannedPin = normalized;
      } else {
        scannedTargetPeerId = text;
      }
    }

    if (scannedPin) {
      const normalized = scannedPin.trim().toUpperCase();
      const myPin = peer?.pin ? peer.pin.trim().toUpperCase() : null;
      if (myPin && normalized === myPin) {
        showNotice('error', 'You cannot connect to your own device. Please enter the PIN shown on the other screen.');
        return;
      }
      setPinError(false);
      emitSocket('request_pairing', {
        pin: normalized,
        deviceName
      });
      setConnectionState('requesting');
      setPinInput('');
      return;
    }

    if (scannedTargetPeerId) {
      if (peer?.peerId && scannedTargetPeerId === peer.peerId) {
        showNotice('error', 'You cannot connect to your own device. Please enter the PIN shown on the other screen.');
        return;
      }
      emitSocket('request_pairing', {
        targetPeerId: scannedTargetPeerId,
        deviceName
      });
      setConnectionState('requesting');
    }
  }, [deviceName, peer?.peerId, peer?.pin, showNotice]);

  const handleConnect = useCallback((value = pinInput) => {
    handleJoinSession(value);
  }, [handleJoinSession, pinInput]);

  const handleScanResult = useCallback((decoded) => {
    setScannerOpen(false);
    handleJoinSession(decoded);
  }, [handleJoinSession]);

  const respondToPrompt = (accepted) => {
    if (!prompt) {
      return;
    }
    emitSocket('pairing_response', {
      pairingId: prompt.pairingId,
      accepted
    });
    if (!accepted) {
      setPrompt(null);
      setVerificationCode(null);
      setStep(null);
      setConnectionState('ready');
    } else {
      setWaitingForAcceptance(true);
    }
  };

  const handleFiles = async (files) => {
    const channel = sessionRef.current?.dataChannel;
    if (!channel || channel.readyState !== 'open') {
      console.log('[App] DataChannel not open yet. Queuing files for transfer once channel opens.');
      pendingFilesRef.current = files;
      showNotice('info', 'Connecting to device... transfer will start in a moment');
      return;
    }

    const CHUNK_SIZE = 64 * 1024;
    for (const file of files) {
      const abortController = new AbortController();
      transferAbortRef.current = abortController;
      const transferId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      setTransfer({
        fileName: file.name,
        fileSize: file.size,
        bytesTransferred: 0,
        percent: 0,
        direction: 'sending',
        status: 'Sending'
      });

      try {
        const metadata = {
          type: 'METADATA',
          transferId,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type || 'application/octet-stream',
          chunkSize: CHUNK_SIZE,
          totalChunks
        };

        sessionRef.current?.send(JSON.stringify(metadata));

        let offset = 0;
        let chunkIndex = 0;
        let lastReportedAt = performance.now();
        let lastReportedBytes = 0;

        while (offset < file.size) {
          if (abortController.signal.aborted) {
            sessionRef.current?.send(JSON.stringify({ type: 'CANCEL', transferId }));
            throw new DOMException('The transfer was cancelled.', 'AbortError');
          }

          // Check that sendChunk() actually transmits each binary slice and waits for backpressure
          const activeChannel = sessionRef.current?.dataChannel || channel;
          const lowThreshold = activeChannel?.bufferedAmountLowThreshold || (256 * 1024);
          while (activeChannel && activeChannel.bufferedAmount > lowThreshold) {
            await new Promise((resolve) => {
              const onLow = () => {
                activeChannel.removeEventListener('bufferedamountlow', onLow);
                resolve();
              };
              activeChannel.addEventListener('bufferedamountlow', onLow, { once: true });
              if (activeChannel.bufferedAmount <= lowThreshold) {
                activeChannel.removeEventListener('bufferedamountlow', onLow);
                resolve();
              }
            });
          }

          const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
          const chunkBuffer = await readSliceAsArrayBuffer(slice);

          if (abortController.signal.aborted) {
            sessionRef.current?.send(JSON.stringify({ type: 'CANCEL', transferId }));
            throw new DOMException('The transfer was cancelled.', 'AbortError');
          }

          console.log('[Transfer] Sending chunk:', offset, '/', file.size);
          const sent = sessionRef.current?.sendChunk(chunkBuffer);
          if (!sent && activeChannel && activeChannel.readyState === 'open') {
            activeChannel.send(chunkBuffer);
          }

          offset += chunkBuffer.byteLength;
          chunkIndex += 1;

          const now = performance.now();
          if (now - lastReportedAt >= 150 || offset === file.size) {
            const elapsedSeconds = Math.max((now - lastReportedAt) / 1000, 0.001);
            const speed = (offset - lastReportedBytes) / elapsedSeconds;
            setTransfer((current) => ({
              ...(current || {}),
              fileName: file.name,
              fileSize: file.size,
              bytesTransferred: offset,
              percent: file.size === 0 ? 100 : (offset / file.size) * 100,
              speed,
              direction: 'sending',
              status: 'Sending'
            }));
            lastReportedAt = now;
            lastReportedBytes = offset;
          }
        }

        // Send EOF and COMPLETE messages so receiver knows transfer is complete
        sessionRef.current?.send(JSON.stringify({
          type: 'eof',
          transferId,
          totalChunks,
          fileSize: file.size,
          fileName: file.name
        }));
        sessionRef.current?.send(JSON.stringify({
          type: 'COMPLETE',
          transferId,
          totalChunks,
          fileSize: file.size,
          fileName: file.name
        }));

        setTransfer((current) => ({
          ...(current || {}),
          bytesTransferred: file.size,
          percent: 100,
          direction: 'sending',
          status: 'Complete'
        }));
        showNotice('success', `${file.name} was sent directly to the other device.`);
      } catch (error) {
        if (error.name !== 'AbortError') {
          showNotice('error', error.message || `Could not send ${file.name}.`);
        }
        break;
      } finally {
        transferAbortRef.current = null;
      }
    }
  };

  handleFilesRef.current = handleFiles;

  const cancelTransfer = () => {
    transferAbortRef.current?.abort();
    transferAbortRef.current = null;
    setTransfer(null);
  };

  const rotateProgress = Math.max(0, Math.min(100, (pinSeconds / 120) * 100));
  const isConnected = connectionState === 'connected';
  const isBusy = ['requesting', 'pairing', 'connecting-peer', 'connecting'].includes(connectionState);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /><span /></div>
          <div>
            <div className="brand-name">relayless</div>
            <div className="brand-tagline">private device-to-device sharing</div>
          </div>
        </div>
        <div className={`status-pill status-${connectionState}`}>
          <span className="status-dot" />
          {connectionState === 'offline'
            ? 'Reconnecting'
            : connectionState === 'connected'
              ? 'Direct link active'
              : connectionState === 'connecting'
                ? 'Connecting to device…'
                : connectionState === 'failed'
                  ? 'Connection failed'
                  : 'Signaling ready'}
        </div>
      </header>

      <main className="main-content">
        <section className="hero-copy">
          <div className="eyebrow">No upload. No storage. No middleman.</div>
          <h1>Move the big stuff<br /><em>without the detour.</em></h1>
          <p>Relayless builds a private encrypted bridge between your browsers. Your files travel directly from one device to the other.</p>
          <div className="hero-notes">
            <span><i>↔</i> Peer-to-peer WebRTC</span>
            <span><i>◌</i> Streamed, not buffered</span>
            <span><i>▣</i> Up to 30 GB+</span>
          </div>
        </section>

        {notice && <div className={`notice notice-${notice.type}`} role="status">{notice.message}</div>}

        {connectionState === 'failed' && (
          <section className="panel failed-card">
            <div className="failed-icon">✕</div>
            <div className="section-kicker">Connection interrupted</div>
            <h2>WebRTC Connection Failed</h2>
            <p className="muted">Direct peer-to-peer bridge could not be established with <strong>{selectedPeer?.deviceName || 'the other device'}</strong>. This can occur with strict firewalls or mobile carrier NAT.</p>
            <button className="button button-primary" type="button" onClick={() => {
              if (currentPairingIdRef.current) {
                emitSocket('pairing_cancel', { pairingId: currentPairingIdRef.current });
              }
              closeSession();
              setConnectionState('ready');
            }}>Reconnect</button>
          </section>
        )}

        {connectionState === 'connecting' && (
          <section className="panel connecting-card">
            <div className="connecting-spinner">
              <div className="spinner-orbit" />
            </div>
            <div className="section-kicker">Encrypted peer tunnel</div>
            <h2>Connecting to {selectedPeer?.deviceName || selectedPeer?.partnerName || 'device'}...</h2>
            <p className="muted">Negotiating direct bridge. Encrypted peer-to-peer data channel will stream directly between devices without relay servers.</p>
            <div className="connecting-status-pill">
              <span className="pulse-dot" />
              <span>Role: {webrtcRole === 'initiator' ? 'Initiator (Sending offer)' : 'Receiver (Awaiting offer)'}</span>
            </div>
            <button
              className="button button-secondary"
              type="button"
              style={{ marginTop: '24px' }}
              onClick={() => {
                if (currentPairingIdRef.current) {
                  emitSocket('pairing_cancel', { pairingId: currentPairingIdRef.current });
                }
                closeSession('Connection cancelled.');
              }}
            >
              Cancel
            </button>
          </section>
        )}

        {!isConnected && connectionState !== 'failed' && connectionState !== 'connecting' && (
          <section className="pairing-grid">
            <article className="panel my-device-panel">
              <div className="panel-heading">
                <div>
                  <div className="section-kicker">01 / Your device</div>
                  <h2>Show your door</h2>
                </div>
                <span className="live-label"><span className="status-dot" />Live</span>
              </div>
              <div className="my-device-layout">
                <div className="qr-column">
                  <QRCodeDisplay value={pairingUrl} />
                  <span className="scan-caption">Scan to connect</span>
                </div>
                <div className="pin-column">
                  <label htmlFor="device-name">Device nickname</label>
                  <input
                    id="device-name"
                    className="text-input"
                    value={deviceName}
                    maxLength={80}
                    onChange={(event) => setDeviceName(event.target.value)}
                  />
                  <div className="pin-label">Your PIN</div>
                  <div className="pin-display">{peer?.pin || '------'}</div>
                  <div className="pin-expiry">
                    <div className="ring" style={{ '--progress': `${rotateProgress}%` }}><span>{pinSeconds}s</span></div>
                    <span>Refreshes every<br />2 minutes</span>
                  </div>
                </div>
              </div>
              <div className="privacy-note"><span>✦</span> This PIN is temporary and only used to introduce devices.</div>
            </article>

            <article className="panel connect-panel">
              <div className="panel-heading">
                <div>
                  <div className="section-kicker">02 / Other device</div>
                  <h2>Open a door</h2>
                </div>
                <span className="step-number">02</span>
              </div>
              <p className="panel-intro">Enter the six-character PIN shown on the other device, or scan its QR code.</p>
              <PinInput
                value={pinInput}
                onChange={(val) => {
                  setPinError(false);
                  setPinInput(val);
                }}
                onSubmit={() => handleConnect()}
                disabled={isBusy}
                hasError={pinError}
              />
              <div className="or-divider"><span>or</span></div>
              <button className="scan-button" type="button" onClick={() => setScannerOpen(true)} disabled={isBusy}>
                <span className="scan-button-icon">⌁</span>
                <span><strong>Scan QR code</strong><small>Use your camera to connect instantly</small></span>
                <span className="arrow">→</span>
              </button>
              <div className="connection-hint"><span className="lock-icon">⌑</span> You will both confirm a matching code before anything connects.</div>
            </article>
          </section>
        )}

        {isConnected && (
          <section className="connected-view">
            <div className="connected-header">
              <div>
                <div className="section-kicker">Secure bridge established</div>
                <h2>Ready to move files</h2>
                <p className="muted">Connected directly to <strong>{selectedPeer?.deviceName || 'the other device'}</strong>. The signaling server is no longer involved in your transfer.</p>
              </div>
              <button className="button button-secondary" type="button" onClick={() => {
                emitSocket('pairing_cancel', { pairingId: currentPairingIdRef.current });
                closeSession('Connection closed.');
              }}>Disconnect</button>
            </div>
            <FileDropZone onFiles={handleFiles} disabled={Boolean(transfer && transfer.status === 'Sending')} />
            <TransferProgress transfer={transfer} onCancel={transfer?.status === 'Sending' ? cancelTransfer : undefined} />
            <div className="transfer-footnote"><span>▣</span> Your browser writes incoming chunks straight to disk. Large files never need to fit in memory.</div>
          </section>
        )}

        <footer className="page-footer">
          <span>Built for the heavy lift.</span>
          <span><i /> End-to-end encrypted by WebRTC</span>
          <span>relayless / 2026</span>
        </footer>
      </main>

      <ConfirmationModal
        prompt={prompt}
        verificationCode={verificationCode}
        displayCode={displayCode}
        hasAccepted={waitingForAcceptance}
        onAccept={() => respondToPrompt(true)}
        onReject={() => respondToPrompt(false)}
      />
      <IncomingFileModal
        transfer={incomingTransfer}
        onAccept={acceptIncomingTransfer}
        onReject={rejectIncomingTransfer}
      />
      {scannerOpen && <QRScannerModal onResult={handleScanResult} onClose={() => setScannerOpen(false)} />}
    </div>
  );
}
