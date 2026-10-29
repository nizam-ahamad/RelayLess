import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCodeDisplay from './components/QRCodeDisplay.jsx';
import QRScannerModal from './components/QRScannerModal.jsx';
import PinInput from './components/PinInput.jsx';
import ConfirmationModal from './components/ConfirmationModal.jsx';
import IncomingFileModal from './components/IncomingFileModal.jsx';
import FileDropZone from './components/FileDropZone.jsx';
import TransferProgress from './components/TransferProgress.jsx';
import { connectSocket, disconnectSocket, emitSocket, onSocketEvent, socket } from './services/socket.js';
import { WebRtcSession, cleanupWebRTC } from './services/webrtc.js';
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
  const [connectionState, setConnectionState] = useState('disconnected');
  const [deviceName, setDeviceName] = useState(DEFAULT_DEVICE_NAME);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState(false);
  const [pinSeconds, setPinSeconds] = useState(120);
  const [prompt, setPrompt] = useState(null);
  const [pairingId, setPairingId] = useState(null);
  const [verificationCode, setVerificationCode] = useState(null);
  const [webrtcRole, setWebrtcRole] = useState(null);
  const setRole = setWebrtcRole;
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  const [step, setStep] = useState('idle');
  const [waitingForAcceptance, setWaitingForAcceptance] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [transfer, setTransfer] = useState(null);
  const [files, setFiles] = useState([]);
  const [transferProgress, setTransferProgress] = useState(0);
  const [incomingTransfer, setIncomingTransfer] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selectedPeer, setSelectedPeer] = useState(null);
  const [partnerSocketId, setPartnerSocketId] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [isChannelReady, setIsChannelReady] = useState(false);
  const isChannelOpen = isChannelReady;
  const setIsChannelOpen = setIsChannelReady;
  const isDataChannelReady = isChannelReady;
  const setIsDataChannelReady = setIsChannelReady;

  const displayCode = verificationCode ? String(verificationCode).padStart(2, '0') : '--';
  const peerNickname = selectedPeer?.deviceName || selectedPeer?.partnerName || prompt?.otherDeviceName || prompt?.deviceName || 'device';
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

  useEffect(() => {
    // Purge any stored session keys on fresh boot
    ['pairingId', 'relayless_session', 'webrtc_role', 'pin', 'p2p-device-name'].forEach((k) => {
      try {
        localStorage.removeItem(k);
        sessionStorage.removeItem(k);
      } catch {}
    });

    // Strip URL query parameters (e.g. ?pin=...) without triggering a reload
    if (window.location.search || window.location.hash) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      const activePairingId = pairingId || currentPairingIdRef.current;
      if (activePairingId) {
        emitSocket('cancel_session', { pairingId: activePairingId });
        emitSocket('pairing_cancel', { pairingId: activePairingId });
      }
      try {
        sessionRef.current?.close();
      } catch {}
      cleanupWebRTC();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      handleBeforeUnload();
    };
  }, [pairingId]);

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

  const showNotification = useCallback((message, type = 'info') => {
    showNotice(type, message);
  }, [showNotice]);

  const closeSession = useCallback((message) => {
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    setIsChannelOpen(false);
    setIsDataChannelReady(false);
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
    setPairingId(null);
    setSelectedPeer(null);
    setTransfer(null);
    setFiles([]);
    setTransferProgress(0);
    setIncomingTransfer(null);
    setShowConfirmationModal(false);
    setPrompt(null);
    setVerificationCode(null);
    setWebrtcRole(null);
    setStep('idle');
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

    const fileName = incoming.metadata.name || incoming.metadata.fileName || 'downloaded-file';
    const mimeType = incoming.metadata.mimeType || incoming.metadata.fileType || 'application/octet-stream';
    const totalBytes = incoming.receivedBytes;

    console.log(`[Transfer] Complete! Assembling ${incoming.chunks.length} chunks (${totalBytes} bytes) for ${fileName}`);

    try {
      const blob = new Blob(incoming.chunks, { type: mimeType });
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 10000);

      setTransferProgress(100);
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
    // 1. Handle text control signals
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'file-header' || msg.type === 'METADATA') {
          const fileName = sanitizeFileName(msg.name || msg.fileName || 'downloaded-file');
          const size = Number(msg.size ?? msg.fileSize ?? 0);
          const mimeType = msg.mimeType || msg.fileType || 'application/octet-stream';

          console.log('[Transfer] Received header:', fileName, size, 'bytes');

          incomingFileRef.current = {
            metadata: { ...msg, name: fileName, fileName, size, fileSize: size, mimeType },
            totalExpectedBytes: size,
            receivedBytes: 0,
            chunks: [],
            saved: false
          };

          setTransferProgress(0);
          setTransfer({
            fileName,
            fileSize: size,
            bytesTransferred: 0,
            percent: 0,
            direction: 'receiving',
            status: 'Receiving'
          });

          if (size === 0) {
            saveIncomingFile();
          }
        } else if (msg.type === 'file-eof' || msg.type === 'eof' || msg.type === 'COMPLETE') {
          console.log(`[Transfer] Received ${msg.type} signal, completing file download`);
          saveIncomingFile();
        } else if (msg.type === 'CANCEL') {
          incomingFileRef.current = {
            metadata: null,
            totalExpectedBytes: 0,
            receivedBytes: 0,
            chunks: [],
            saved: false
          };
          setTransfer(null);
          setFiles([]);
          setTransferProgress(0);
          showNotice('info', 'The other device cancelled the transfer.');
        }
      } catch (err) {
        console.warn('[Transfer] Control message parse error:', err);
      }
      return;
    }

    // 2. Handle binary chunk (convert Blob if necessary for mobile Chrome)
    let buffer = data;
    if (buffer instanceof Blob) {
      buffer = await buffer.arrayBuffer();
    } else if (buffer && typeof buffer.arrayBuffer === 'function') {
      buffer = await buffer.arrayBuffer();
    } else if (ArrayBuffer.isView(buffer)) {
      buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }

    if (buffer && buffer.byteLength) {
      const incoming = incomingFileRef.current;
      if (!incoming || !incoming.metadata) {
        console.warn('[Transfer] Received binary chunk before metadata');
        return;
      }

      incoming.chunks.push(buffer);
      incoming.receivedBytes += buffer.byteLength;

      const receivedBytes = incoming.receivedBytes;
      const totalExpectedBytes = incoming.totalExpectedBytes;

      if (totalExpectedBytes > 0) {
        const progress = Math.min(100, Math.round((receivedBytes / totalExpectedBytes) * 100));
        setTransferProgress(progress);
        setTransfer((current) => ({
          ...(current || {}),
          fileName: incoming.metadata.name || incoming.metadata.fileName || 'Incoming file',
          fileSize: totalExpectedBytes,
          bytesTransferred: receivedBytes,
          percent: progress,
          direction: 'receiving',
          status: 'Receiving'
        }));
      }

      if (totalExpectedBytes > 0 && receivedBytes >= totalExpectedBytes) {
        saveIncomingFile();
      }
    }
  }, [saveIncomingFile, showNotice]);

  const handleDataChannelMessage = handleChannelMessage;

  const startWebRtc = useCallback(async ({ role, pairingId, partnerSocketId, partnerName }) => {
    sessionRef.current?.close();
    console.log(`[WebRTC] Starting WebRtcSession. Role: ${role}, Pairing: ${pairingId}`);
    const targetName = partnerName || 'device';
    const session = new WebRtcSession({
      role,
      socket,
      pairingId: pairingId || currentPairingIdRef.current,
      partnerSocketId: partnerSocketId || partnerSocketIdRef.current,
      onMessage: handleDataChannelMessage,
      onSignal: sendSignal,
      onConnected: () => {
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        console.log('[WebRTC] ⚡ DataChannel OPENED! Setting isChannelReady = true.');
        setIsChannelReady(true);
        setIsChannelOpen(true);
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
          console.log('[WebRTC] ⚡ DataChannel OPENED! Setting isChannelReady = true.');
          setIsChannelReady(true);
          setIsChannelOpen(true);
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
          setIsChannelOpen(false);
          setConnectionState((current) => current === 'connected' ? 'ready' : current);
        } else if (state === 'failed') {
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          console.warn('[WebRTC] Connection failed');
          setIsChannelOpen(false);
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
        setIsChannelOpen(false);
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
    console.log('[Signaling] ⚡ Received pairing_confirmed / start_transfer_session event:', payload);
    try {
      const pairingId = payload.pairingId || payload.id;
      if (sessionRef.current && currentPairingIdRef.current === pairingId && connectionState === 'connecting') {
        console.log('[Signaling] WebRTC session already initializing for:', pairingId);
        return;
      }
      const role = payload.role || (payload.initiator ? 'initiator' : 'receiver');
      const targetSocketId = payload.partnerSocketId || (role === 'initiator' ? payload.targetSocketId : payload.initiatorSocketId) || payload.otherSocketId;

      const partnerName = payload.partnerName || payload.deviceName || 'device';

      console.log(`[Signaling] Confirmed pairing ${pairingId}. Role: ${role}, Partner: ${partnerName}`);

      currentPairingIdRef.current = pairingId;
      setPairingId(pairingId);
      partnerSocketIdRef.current = targetSocketId;
      setPartnerSocketId(targetSocketId);
      webrtcRoleRef.current = role;
      setWebrtcRole(role);

      setShowConfirmationModal(false);
      setPrompt(null);
      setVerificationCode(null);
      setStep('transfer');
      setIsChannelOpen(false);
      setIsDataChannelReady(false);
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
      setConnectionState((current) => current === 'connecting' || current === 'disconnected' ? 'ready' : current);
    }
    const cleanups = [
      onSocketEvent('connect', () => setConnectionState((current) => current === 'connecting' || current === 'disconnected' ? 'ready' : current)),
      onSocketEvent('disconnect', () => {
        setConnectionState('offline');
        showNoticeRef.current('error', 'Signaling server disconnected. Retrying automatically…');
      }),
      onSocketEvent('connect_error', () => setConnectionState('offline')),
      onSocketEvent('peer_ready', (nextPeer) => {
        setPeer(nextPeer);
        setPinSeconds(nextPeer.expiresIn ?? 120);
        setConnectionState((current) => (current === 'connecting' || current === 'disconnected') && !currentPairingIdRef.current || current === 'offline' ? 'ready' : current);
      }),
      onSocketEvent('update_pin', (nextPin) => {
        setPeer((current) => ({ ...(current || {}), ...nextPin }));
        setPinSeconds(nextPin.expiresIn ?? 120);
      }),
      onSocketEvent('session_matched', (data = {}) => {
        const code = data.verificationCode || data.code;
        console.log('[Socket 🔑] Session matched with code:', code);

        setVerificationCode(code);
        setPairingId(data.pairingId);
        setRole(data.role); // 'initiator' (host) or 'receiver' (joiner)
        if (data.role) {
          webrtcRoleRef.current = data.role;
        }
        currentPairingIdRef.current = data.pairingId;

        // Force both host and joiner into the verification step
        setStep('verify');
        setPrompt({ ...data, pairingId: data.pairingId, role: data.role, verificationCode: code, code });
        setShowConfirmationModal(true);
        setWaitingForAcceptance(false);
        setConnectionState('pairing');
      }),
      onSocketEvent('start_transfer_session', (payload) => handlePairingConfirmedRef.current(payload)),
      onSocketEvent('paired', (data = {}) => {
        const rawCode = data.verificationCode || data.code || data.confirmationCode;
        const code = rawCode ? String(rawCode).padStart(2, '0') : '--';
        const pId = data.pairingId || data.id;
        currentPairingIdRef.current = pId;
        setPairingId(pId);
        setVerificationCode(code);
        setStep('verify');
        setPrompt({ ...data, pairingId: pId, verificationCode: code, code });
        setShowConfirmationModal(true);
        setWaitingForAcceptance(false);
        setConnectionState('pairing');
      }),
      onSocketEvent('pairing_prompt', (nextPrompt) => {
        const pId = nextPrompt.pairingId || nextPrompt.id;
        currentPairingIdRef.current = pId;
        setPairingId(nextPrompt.pairingId);
        const rawCode = nextPrompt.verificationCode ?? nextPrompt.confirmationCode ?? nextPrompt.code;
        const code = rawCode ? String(rawCode).padStart(2, '0') : '--';
        setVerificationCode(code);
        if (nextPrompt.role) {
          const role = nextPrompt.role === 'target' ? 'initiator' : (nextPrompt.role === 'requester' ? 'receiver' : nextPrompt.role);
          setWebrtcRole(role);
          webrtcRoleRef.current = role;
        }
        setStep('verify');
        setPrompt({ ...nextPrompt, pairingId: pId, verificationCode: code, code });
        setShowConfirmationModal(true);
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
      emitSocket('join_session', { pin: normalized, deviceName });
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
      emitSocket('join_session', { targetPeerId: scannedTargetPeerId, deviceName });
      emitSocket('request_pairing', {
        targetPeerId: scannedTargetPeerId,
        deviceName
      });
      setConnectionState('requesting');
    }
  }, [deviceName, peer?.peerId, peer?.pin, showNotice]);

  const handleJoinWithPin = useCallback((pinOrInput) => {
    if (!pinOrInput) return;
    let pin = String(pinOrInput).trim();
    if (pin.includes('pin=')) {
      const urlParams = new URLSearchParams(pin.split('?')[1] || '');
      pin = urlParams.get('pin') || pin;
    }
    handleJoinSession(pin);
  }, [handleJoinSession]);

  const handleConnect = useCallback((value = pinInput) => {
    handleJoinWithPin(value);
  }, [handleJoinWithPin, pinInput]);

  const handleScanResult = useCallback((decoded) => {
    setScannerOpen(false);
    handleJoinWithPin(decoded);
  }, [handleJoinWithPin]);

  const handleAllowConnection = useCallback(() => {
    const activePairingId = pairingId || currentPairingIdRef.current || prompt?.pairingId;
    console.log('[Confirmation] Allowing connection for pairing:', activePairingId);
    if (!activePairingId) return;
    socket.emit('confirm_pairing', { pairingId: activePairingId });
    emitSocket('confirm_pairing', { pairingId: activePairingId });
    emitSocket('pairing_response', { pairingId: activePairingId, accepted: true });
    setWaitingForAcceptance(true);
  }, [pairingId, prompt]);

  const handleRejectConnection = useCallback(() => {
    const activePairingId = pairingId || currentPairingIdRef.current || prompt?.pairingId;
    console.log('[Confirmation] Rejecting connection for pairing:', activePairingId);
    if (activePairingId) {
      emitSocket('pairing_response', { pairingId: activePairingId, accepted: false });
      emitSocket('pairing_cancel', { pairingId: activePairingId });
    }
    setShowConfirmationModal(false);
    setWaitingForAcceptance(false);
    currentPairingIdRef.current = null;
    setPairingId(null);
    setPrompt(null);
    setVerificationCode(null);
    setStep('idle');
    setConnectionState('ready');
  }, [pairingId, prompt]);

  const respondToPrompt = (accepted) => {
    if (accepted) {
      handleAllowConnection();
    } else {
      handleRejectConnection();
    }
  };

  const handleFileSelect = (e) => {
    const selected = Array.from(e.target?.files || (Array.isArray(e) ? e : []));
    if (selected.length === 0) return;

    if (!isChannelReady) {
      showNotification("P2P bridge is still connecting. Please wait a moment...", "warning");
      return;
    }

    handleFiles(selected);
  };

  const handleFiles = async (files) => {
    const selected = Array.from(files || []);
    if (selected.length === 0) return;

    if (!isChannelReady) {
      showNotification("P2P bridge is still connecting. Please wait a moment...", "warning");
      return;
    }

    const dataChannel = sessionRef.current?.getDataChannel?.() || sessionRef.current?.dataChannel;
    if (!dataChannel || dataChannel.readyState !== 'open') {
      showNotification("Please wait, establishing encrypted P2P link...", "warning");
      return;
    }

    setFiles(Array.from(files || []));
    setTransferProgress(0);

    const CHUNK_SIZE = 16384; // 16 KB - Safe across all mobile cellular/TURN links
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
        // 1. Send file metadata header
        const header = JSON.stringify({
          type: 'file-header',
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          // Backwards compatibility fields
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type || 'application/octet-stream',
          transferId,
          totalChunks,
          chunkSize: CHUNK_SIZE
        });
        dataChannel.send(header);

        // 2. Stream binary slices with 16KB chunks
        let offset = 0;
        let lastReportedAt = performance.now();
        let lastReportedBytes = 0;

        while (offset < file.size) {
          if (abortController.signal.aborted) {
            dataChannel.send(JSON.stringify({ type: 'CANCEL', transferId }));
            throw new DOMException('The transfer was cancelled.', 'AbortError');
          }

          // Check backpressure ceiling (64 KB)
          if (dataChannel.bufferedAmount > 65536) {
            await new Promise((resolve) => {
              dataChannel.onbufferedamountlow = () => {
                dataChannel.onbufferedamountlow = null;
                resolve();
              };
            });
          }

          const slice = file.slice(offset, offset + CHUNK_SIZE);
          const buffer = await slice.arrayBuffer();

          if (abortController.signal.aborted) {
            dataChannel.send(JSON.stringify({ type: 'CANCEL', transferId }));
            throw new DOMException('The transfer was cancelled.', 'AbortError');
          }

          dataChannel.send(buffer);
          offset += buffer.byteLength;

          const progress = file.size === 0 ? 100 : Math.min(100, Math.round((offset / file.size) * 100));
          setTransferProgress(progress);

          const now = performance.now();
          if (now - lastReportedAt >= 150 || offset === file.size) {
            const elapsedSeconds = Math.max((now - lastReportedAt) / 1000, 0.001);
            const speed = (offset - lastReportedBytes) / elapsedSeconds;
            setTransfer((current) => ({
              ...(current || {}),
              fileName: file.name,
              fileSize: file.size,
              bytesTransferred: offset,
              percent: progress,
              speed,
              direction: 'sending',
              status: offset === file.size ? 'Complete' : 'Sending'
            }));
            lastReportedAt = now;
            lastReportedBytes = offset;
          }
        }

        // 3. Send EOF signal
        dataChannel.send(JSON.stringify({
          type: 'file-eof',
          name: file.name,
          fileName: file.name,
          size: file.size,
          fileSize: file.size,
          transferId
        }));
        console.log('[Transfer] File transmission complete:', file.name);

        setTransferProgress(100);
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
          console.error('[Transfer] Failed to send file:', error);
          showNotice('error', error.message || `Could not send ${file.name}.`);
        } else {
          showNotice('info', 'File transfer was cancelled.');
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
    setFiles([]);
    setTransferProgress(0);
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
            : isDataChannelReady
              ? 'Direct link active'
              : connectionState === 'connected' || connectionState === 'connecting'
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

        {step !== 'transfer' && connectionState === 'connecting' && (
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

        {step !== 'transfer' && connectionState !== 'failed' && connectionState !== 'connecting' && (
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

        {step === 'transfer' && connectionState !== 'failed' && (
          <section className="connected-view">
            <div className="connected-header">
              <div>
                <div className="section-kicker">
                  {isChannelReady ? 'Secure bridge established' : 'Direct Link Negotiation'}
                </div>
                <h2>
                  {isChannelReady
                    ? 'Ready to move files'
                    : 'Establishing encrypted peer-to-peer bridge...'}
                </h2>
                <p className="muted">
                  {isChannelReady
                    ? `Connected directly to ${selectedPeer?.deviceName || selectedPeer?.partnerName || 'the other device'}. The signaling server is no longer involved in your transfer.`
                    : 'Establishing encrypted peer-to-peer bridge...'}
                </p>
                {!isChannelReady && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', marginTop: '12px', padding: '8px 16px', borderRadius: '999px', background: 'rgba(85, 214, 190, 0.08)', border: '1px solid rgba(85, 214, 190, 0.25)' }}>
                    <div className="pulse-dot" style={{ margin: 0 }} />
                    <span style={{ fontSize: '12px', color: 'var(--mint)', fontFamily: 'DM Mono, monospace' }}>
                      Establishing encrypted peer-to-peer bridge...
                    </span>
                  </div>
                )}
              </div>
              <button className="button button-secondary" type="button" onClick={() => {
                if (currentPairingIdRef.current) {
                  emitSocket('pairing_cancel', { pairingId: currentPairingIdRef.current });
                }
                closeSession('Connection closed.');
              }}>Disconnect</button>
            </div>
            <FileDropZone
              onFiles={handleFiles}
              disabled={!isChannelReady || Boolean(transfer && transfer.status === 'Sending')}
            />
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
        isOpen={showConfirmationModal}
        code={verificationCode}
        peerNickname={peerNickname}
        onClose={() => {
          setShowConfirmationModal(false);
          const activePairingId = pairingId || currentPairingIdRef.current;
          socket.emit('reject_pairing', { pairingId: activePairingId });
          emitSocket('reject_pairing', { pairingId: activePairingId });
        }}
        onConfirm={() => {
          setShowConfirmationModal(false);
          const activePairingId = pairingId || currentPairingIdRef.current;
          socket.emit('confirm_pairing', { pairingId: activePairingId });
          emitSocket('confirm_pairing', { pairingId: activePairingId });
        }}
      />
      <IncomingFileModal
        transfer={incomingTransfer}
        onAccept={acceptIncomingTransfer}
        onReject={rejectIncomingTransfer}
      />
      {scannerOpen && (
        <QRScannerModal
          isOpen={scannerOpen}
          onResult={handleScanResult}
          onScanSuccess={handleScanResult}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </div>
  );
}
