import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCodeDisplay from './components/QRCodeDisplay.jsx';
import QRScannerModal from './components/QRScannerModal.jsx';
import PinInput from './components/PinInput.jsx';
import ConfirmationModal from './components/ConfirmationModal.jsx';
import IncomingFileModal from './components/IncomingFileModal.jsx';
import FileDropZone from './components/FileDropZone.jsx';
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

export function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '0 B/s';
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
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
  const role = webrtcRole;
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  const [step, setStep] = useState('idle');
  const [waitingForAcceptance, setWaitingForAcceptance] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [transfer, setTransfer] = useState(null);
  const [transferStatus, setTransferStatus] = useState('idle'); // 'idle' | 'transferring' | 'completed'
  const [transferSpeed, setTransferSpeed] = useState('0 B/s');
  const lastSpeedCalcTimeRef = useRef(0);
  const bytesSinceLastCalcRef = useRef(0);
  const [files, setFiles] = useState([]);
  const [transferProgress, setTransferProgress] = useState(0);

  const activeFile = useMemo(() => {
    if (transfer) {
      return {
        name: transfer.fileName || transfer.name || 'File',
        size: transfer.fileSize ?? transfer.size ?? 0
      };
    }
    if (files && files.length > 0) {
      return {
        name: files[0].name,
        size: files[0].size
      };
    }
    return null;
  }, [transfer, files]);
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
  const currentVersionRef = useRef(null);
  const isTransferringRef = useRef(false);

  // Keep isTransferringRef synced with active file transfer state
  useEffect(() => {
    isTransferringRef.current = (step === 'transfer' || transferStatus === 'transferring');
  }, [step, transferStatus]);

  useEffect(() => {
    const checkForNewVersion = async () => {
      // Never interrupt an active file transfer
      if (isTransferringRef.current) return;

      try {
        const res = await fetch(`/api/version?_t=${Date.now()}`, {
          cache: 'no-store'
        });
        if (!res.ok) return;

        const data = await res.json();
        if (!data?.version) return;

        if (!currentVersionRef.current) {
          // Record initial version on boot
          currentVersionRef.current = data.version;
        } else if (currentVersionRef.current !== data.version) {
          console.log('[App 🔄] New code deployment detected! Syncing tab...');
          // Force clean reload bypassing cache
          window.location.reload();
        }
      } catch (err) {
        // Ignore background network blips
      }
    };

    // 1. Initial check
    checkForNewVersion();

    // 2. Poll every 30 seconds when tab is open
    const intervalId = setInterval(checkForNewVersion, 30000);

    // 3. Check immediately when user switches back to the tab or unlocks phone
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkForNewVersion();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', checkForNewVersion);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', checkForNewVersion);
    };
  }, []);

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
      const activePairingId = currentPairingIdRef.current;
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
    };
  }, []);

  const pairingUrl = useMemo(() => {
    if (!peer?.peerId) {
      return '';
    }
    const url = new URL(window.location.href);
    url.search = `?pair=${encodeURIComponent(peer.peerId)}${peer?.pin ? `&pin=${encodeURIComponent(peer.pin)}` : ''}`;
    url.hash = '';
    return url.toString();
  }, [peer?.peerId, peer?.pin]);

  const showNotice = useCallback((type, message) => {
    setNotice({ type, message });
    window.setTimeout(() => setNotice((current) => (current?.message === message ? null : current)), 5500);
  }, []);

  const showNotification = useCallback((message, type = 'info') => {
    showNotice(type, message);
  }, [showNotice]);

  const closeSession = useCallback((message) => {
    setTransferSpeed('0 B/s');
    lastSpeedCalcTimeRef.current = 0;
    bytesSinceLastCalcRef.current = 0;
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
    setTransferStatus('idle');
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
    setTransferSpeed('0 B/s');
    lastSpeedCalcTimeRef.current = 0;
    bytesSinceLastCalcRef.current = 0;
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
      setTransferStatus('completed');
      setTransfer((current) => ({
        ...(current || {}),
        fileName,
        fileSize: totalBytes,
        bytesTransferred: totalBytes,
        percent: 100,
        direction: 'receiving',
        status: 'Complete'
      }));

      showNotification(`✓ ${fileName || 'File'} received successfully!`, "success");
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

          setTransferStatus('transferring');
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
          setTransferSpeed('0 B/s');
          lastSpeedCalcTimeRef.current = 0;
          bytesSinceLastCalcRef.current = 0;
          saveIncomingFile();
        } else if (msg.type === 'CANCEL') {
          setTransferSpeed('0 B/s');
          lastSpeedCalcTimeRef.current = 0;
          bytesSinceLastCalcRef.current = 0;
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
          setTransferStatus('idle');
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
      bytesSinceLastCalcRef.current += buffer.byteLength;

      const now = performance.now();
      if (now - lastSpeedCalcTimeRef.current >= 300) { // Update every 300ms
        const elapsedSec = (now - lastSpeedCalcTimeRef.current) / 1000;
        const currentSpeed = bytesSinceLastCalcRef.current / elapsedSec;
        setTransferSpeed(formatSpeed(currentSpeed));
        lastSpeedCalcTimeRef.current = now;
        bytesSinceLastCalcRef.current = 0;
      }

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
        setTransferSpeed('0 B/s');
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
          console.warn('[WebRTC] Connection watchdog timed out after 60 seconds');
          closeSession('Connection timed out. Could not establish P2P bridge with other device.');
        }
      }, 60000);

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

  const sendFile = async (file) => {
    const dataChannel = sessionRef.current?.getDataChannel?.() || sessionRef.current?.dataChannel;
    if (!dataChannel || dataChannel.readyState !== 'open') {
      showNotification("P2P bridge is not open.", "warning");
      return;
    }

    const abortController = new AbortController();
    transferAbortRef.current = abortController;
    const transferId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // 1. Send file metadata header
    const header = JSON.stringify({
      type: 'file-header',
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream',
      transferId
    });
    dataChannel.send(header);

    // 2. High-speed streaming parameters
    const CHUNK_SIZE = 64 * 1024; // 64 KB
    const MAX_BUFFER = 2 * 1024 * 1024; // 2 MB backpressure ceiling
    const BLOCK_SIZE = 1024 * 1024; // Read 1 MB from disk at a time to reduce I/O overhead

    let offset = 0;
    let sentBytes = 0;
    let lastCalcTime = performance.now();
    let bytesSinceLastCalc = 0;

    setTransferStatus('transferring');
    setTransfer({
      fileName: file.name,
      fileSize: file.size,
      bytesTransferred: 0,
      percent: 0,
      direction: 'sending',
      status: 'Sending'
    });

    try {
      while (offset < file.size) {
        if (abortController.signal.aborted) {
          setTransferSpeed('0 B/s');
          dataChannel.send(JSON.stringify({ type: 'CANCEL', transferId }));
          throw new DOMException('The transfer was cancelled.', 'AbortError');
        }

        // Read a 1 MB block from disk into memory
        const blockEnd = Math.min(offset + BLOCK_SIZE, file.size);
        const blockSlice = file.slice(offset, blockEnd);
        const blockBuffer = await blockSlice.arrayBuffer();

        // Stream the 1 MB block in 64 KB slices
        let blockOffset = 0;
        while (blockOffset < blockBuffer.byteLength) {
          if (abortController.signal.aborted) {
            setTransferSpeed('0 B/s');
            dataChannel.send(JSON.stringify({ type: 'CANCEL', transferId }));
            throw new DOMException('The transfer was cancelled.', 'AbortError');
          }

          // Wait only if DataChannel buffer exceeds 2 MB
          if (dataChannel.bufferedAmount > MAX_BUFFER) {
            await new Promise((resolve) => {
              const listener = () => {
                dataChannel.removeEventListener('bufferedamountlow', listener);
                resolve();
              };
              dataChannel.addEventListener('bufferedamountlow', listener);
            });
          }

          const sliceEnd = Math.min(blockOffset + CHUNK_SIZE, blockBuffer.byteLength);
          const chunk = blockBuffer.slice(blockOffset, sliceEnd);
          dataChannel.send(chunk);

          blockOffset += chunk.byteLength;
          sentBytes += chunk.byteLength;
          bytesSinceLastCalc += chunk.byteLength;

          // Update progress and speed calculation every 300ms
          const now = performance.now();
          if (now - lastCalcTime >= 300 || sentBytes === file.size) {
            const elapsedSec = (now - lastCalcTime) / 1000;
            const currentSpeed = bytesSinceLastCalc / elapsedSec;
            setTransferSpeed(formatSpeed(currentSpeed));
            lastCalcTime = now;
            bytesSinceLastCalc = 0;

            const progress = file.size === 0 ? 100 : Math.min(100, Math.round((sentBytes / file.size) * 100));
            setTransferProgress(progress);
            setTransfer((current) => ({
              ...(current || {}),
              fileName: file.name,
              fileSize: file.size,
              bytesTransferred: sentBytes,
              percent: progress,
              speed: currentSpeed,
              direction: 'sending',
              status: sentBytes === file.size ? 'Complete' : 'Sending'
            }));
          }
        }

        offset = blockEnd;
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
      setTransferProgress(100);
      setTransferSpeed('0 B/s');
      setTransferStatus('completed');
      setTransfer((current) => ({
        ...(current || {}),
        bytesTransferred: file.size,
        percent: 100,
        direction: 'sending',
        status: 'Complete'
      }));
      console.log('[Transfer 🚀] Completed sending:', file.name);
      showNotification(`✓ ${file.name || 'File'} sent successfully!`, "success");
    } catch (err) {
      setTransferSpeed('0 B/s');
      setTransferStatus('idle');
      if (err.name !== 'AbortError') {
        console.error('[Transfer ❌] Send failed:', err);
        showNotification("Transfer interrupted.", "error");
      } else {
        showNotice('info', 'File transfer was cancelled.');
      }
    } finally {
      transferAbortRef.current = null;
    }
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

    for (const file of selected) {
      await sendFile(file);
    }
  };

  handleFilesRef.current = handleFiles;

  const cancelTransfer = () => {
    setTransferSpeed('0 B/s');
    transferAbortRef.current?.abort();
    transferAbortRef.current = null;
    setTransfer(null);
    setFiles([]);
    setTransferProgress(0);
    setTransferStatus('idle');
  };

  const rotateProgress = Math.max(0, Math.min(100, (pinSeconds / 120) * 100));
  const isConnected = connectionState === 'connected';
  const isBusy = ['requesting', 'pairing', 'connecting-peer', 'connecting'].includes(connectionState);

  return (
    <div className="app-shell bg-[#131314]">
      <header className="topbar bg-[#131314]/90 border-b border-[#282a2c]">
        <div className="brand-lockup">
          <div className="brand-mark"><span /><span /></div>
          <div>
            <div className="brand-name text-[#e3e3e3]">relayless</div>
            <div className="brand-tagline text-[#75777a]">private device-to-device sharing</div>
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
        <div className="max-w-6xl mx-auto px-4 pt-4 pb-2 text-center md:text-left">
          <div className="text-[10px] tracking-widest text-[#a8c7fa] font-bold mb-1 uppercase font-mono">
            NO UPLOAD. NO STORAGE. NO MIDDLEMAN.
          </div>
          <h1 className="text-3xl md:text-4xl lg:text-5xl font-black text-[#e3e3e3] tracking-tight leading-tight mb-2">
            Move the big stuff without the detour.
          </h1>
          <p className="text-xs md:text-sm text-[#9aa0a6] mb-3 max-w-2xl leading-relaxed">
            Relayless builds a private encrypted bridge between your browsers. Your files travel directly from one device to the other.
          </p>
          <div className="flex flex-wrap items-center justify-center md:justify-start gap-4 text-[11px] text-[#9aa0a6] mb-2">
            <span className="bg-[#1e1f20] border border-[#333537] text-[#c4c7c5] px-2.5 py-0.5 rounded-full"><i className="text-[#a8c7fa] not-italic mr-1.5 font-bold">↔</i> Peer-to-peer WebRTC</span>
            <span className="bg-[#1e1f20] border border-[#333537] text-[#c4c7c5] px-2.5 py-0.5 rounded-full"><i className="text-[#a8c7fa] not-italic mr-1.5 font-bold">◌</i> Streamed, not buffered</span>
            <span className="bg-[#1e1f20] border border-[#333537] text-[#c4c7c5] px-2.5 py-0.5 rounded-full"><i className="text-[#a8c7fa] not-italic mr-1.5 font-bold">▣</i> Up to 30 GB+</span>
          </div>
        </div>

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
          <div className="max-w-6xl mx-auto px-4 pb-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
              {/* Card #1: Show your door */}
              <div className="bg-[#1e1f20] border border-[#333537] rounded-2xl p-5 md:p-6 flex flex-col justify-between shadow-xl">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[11px] font-mono text-[#a8c7fa] font-semibold tracking-wider">01 / YOUR DEVICE</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-medium">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> LIVE
                    </span>
                  </div>
                  <h2 className="text-xl font-bold text-[#e3e3e3] mb-4">Show your door</h2>

                  {/* QR & Details Row */}
                  <div className="flex flex-col sm:flex-row items-center gap-4">
                    <div className="bg-white p-2.5 rounded-xl shadow-inner shrink-0">
                      {/* Set QR display size to a clean ~160px-180px */}
                      <div className="w-[160px] h-[160px] flex items-center justify-center">
                        <QRCodeDisplay value={pairingUrl} />
                      </div>
                    </div>

                    <div className="flex-1 w-full space-y-3">
                      <div>
                        <label className="text-[10px] font-mono text-[#9aa0a6] uppercase">Device Nickname</label>
                        <input
                          type="text"
                          value={deviceName}
                          maxLength={80}
                          onChange={(e) => setDeviceName(e.target.value)}
                          placeholder="My device"
                          className="w-full mt-1 px-3 py-1.5 rounded-lg bg-[#131314] border border-[#3c4043] text-sm text-[#e3e3e3] placeholder-[#75777a] focus:outline-none focus:border-[#a8c7fa]"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-mono text-[#9aa0a6] uppercase">Your PIN</label>
                        <div className="text-2xl font-mono font-black text-[#fdd663] tracking-wider">
                          {peer?.pin || '------'}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="ring" style={{ '--progress': `${rotateProgress}%` }}><span>{pinSeconds}s</span></div>
                          <span className="text-[10px] text-[#75777a]">Refreshes every 2 minutes</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <p className="text-[10px] text-[#75777a] mt-4">This PIN is temporary and only used to introduce devices.</p>
              </div>

              {/* Card #2: Open a door */}
              <div className="bg-[#1e1f20] border border-[#333537] rounded-2xl p-5 md:p-6 flex flex-col justify-between shadow-xl">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[11px] font-mono text-[#a8c7fa] font-semibold tracking-wider">02 / OTHER DEVICE</span>
                    <span className="text-[11px] font-mono text-[#75777a]">02</span>
                  </div>
                  <h2 className="text-xl font-bold text-[#e3e3e3] mb-1">Open a door</h2>
                  <p className="text-xs text-[#9aa0a6] mb-4">
                    Enter the six-character PIN shown on the other device, or scan its QR code.
                  </p>

                  {/* PIN Input & Connect Button */}
                  <div className="space-y-3">
                    <div>
                      <label className="text-[10px] font-mono text-[#9aa0a6] uppercase">Enter Pairing PIN</label>
                      <div className="flex gap-2 mt-1">
                        <input
                          type="text"
                          maxLength={6}
                          value={pinInput}
                          onChange={(e) => {
                            setPinError(false);
                            setPinInput(e.target.value.toUpperCase());
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleJoinWithPin(pinInput);
                            }
                          }}
                          placeholder="ABC123"
                          disabled={isBusy}
                          className="flex-1 px-3 py-2 rounded-xl bg-[#131314] border border-[#3c4043] text-lg font-mono tracking-widest text-[#e3e3e3] placeholder-[#75777a] uppercase focus:outline-none focus:border-[#a8c7fa]"
                        />
                        <button
                          type="button"
                          onClick={() => handleJoinWithPin(pinInput)}
                          disabled={isBusy || !pinInput.trim()}
                          className="px-5 py-2 rounded-xl bg-[#e3e3e3] hover:bg-white text-[#131314] font-bold text-sm transition-colors"
                        >
                          Connect
                        </button>
                      </div>
                      {pinError && <div className="error-text mt-1 text-xs text-[#f28b82]">{pinError}</div>}
                    </div>

                    <div className="relative flex items-center justify-center my-3">
                      <div className="border-t border-[#333537] w-full"></div>
                      <span className="bg-[#1e1f20] px-2 text-[10px] text-[#75777a] uppercase font-mono absolute">or</span>
                    </div>

                    {/* Camera Scanner Button */}
                    <button
                      type="button"
                      onClick={() => setScannerOpen(true)}
                      disabled={isBusy}
                      className="w-full py-2.5 px-4 rounded-xl bg-[#282a2c] hover:bg-[#333537] border border-[#3c4043] text-[#e3e3e3] flex items-center justify-between text-xs font-medium transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-[#a8c7fa]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                        </svg>
                        <span>Scan QR code</span>
                      </div>
                      <span className="text-[#75777a] text-[10px]">Instant connect →</span>
                    </button>
                  </div>
                </div>

                <p className="text-[10px] text-[#75777a] mt-4">You will both confirm a matching code before anything connects.</p>
              </div>
            </div>
          </div>
        )}

        {step === 'transfer' && connectionState !== 'failed' && (
          <section className="connected-view bg-[#1e1f20] border border-[#333537]">
            <div className="connected-header">
              <div>
                <div className="section-kicker text-emerald-400">
                  {isChannelReady ? 'Secure bridge established' : 'Direct Link Negotiation'}
                </div>
                <h2 className="text-[#e3e3e3]">
                  {isChannelReady
                    ? 'Ready to move files'
                    : 'Establishing encrypted peer-to-peer bridge...'}
                </h2>
                <p className="muted text-[#9aa0a6]">
                  {isChannelReady
                    ? `Connected directly to ${selectedPeer?.deviceName || selectedPeer?.partnerName || 'the other device'}. The signaling server is no longer involved in your transfer.`
                    : 'Establishing encrypted peer-to-peer bridge...'}
                </p>
                {!isChannelReady && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', marginTop: '12px', padding: '8px 16px', borderRadius: '999px', background: 'rgba(168, 199, 250, 0.08)', border: '1px solid rgba(168, 199, 250, 0.25)' }}>
                    <div className="pulse-dot" style={{ margin: 0 }} />
                    <span style={{ fontSize: '12px', color: '#a8c7fa', fontFamily: 'DM Mono, monospace' }}>
                      Establishing encrypted peer-to-peer bridge...
                    </span>
                  </div>
                )}
              </div>
              <button className="button button-secondary bg-[#282a2c] hover:bg-[#333537] border-[#3c4043] text-[#c4c7c5] hover:text-[#e3e3e3]" type="button" onClick={() => {
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
            {/* Active / Completed File Card */}
            {activeFile && (
              <div
                className={`mt-6 w-full rounded-2xl border p-5 transition-all duration-500 ${
                  transferProgress === 100
                    ? 'bg-[#1e1f20] border-[#81c995]/40 shadow-xl shadow-emerald-500/10'
                    : 'bg-[#1e1f20] border-[#333537]'
                }`}
              >
                {/* File Info Row */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3.5 min-w-0">
                    {/* Animated Icon: Spinner/Arrow while transferring, Glowing Checkmark when completed */}
                    <div
                      className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors duration-500 ${
                        transferProgress === 100
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-cyan-500/10 text-[#a8c7fa] border border-[#a8c7fa]/20'
                      }`}
                    >
                      {transferProgress === 100 ? (
                        <svg className="w-6 h-6 animate-in zoom-in-75 duration-300 text-[#81c995]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5 animate-pulse text-[#a8c7fa]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                        </svg>
                      )}
                    </div>

                    {/* Filename & Meta */}
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-[#e3e3e3] truncate max-w-[280px] sm:max-w-md">
                        {activeFile.name}
                      </h4>
                      <p className="text-xs text-[#9aa0a6] mt-0.5">
                        {formatBytes(activeFile.size)} ·{' '}
                        <span className={transferProgress === 100 ? 'text-[#81c995] font-medium' : 'text-[#9aa0a6]'}>
                          {transferProgress === 100
                            ? (transfer?.direction === 'sending' || role === 'initiator'
                                ? 'Successfully delivered to peer'
                                : 'Safely downloaded to your device')
                            : (transfer?.direction === 'sending' || role === 'initiator'
                                ? 'Sending...'
                                : 'Receiving...')}
                        </span>
                      </p>
                    </div>
                  </div>

                  {/* Percentage Pill */}
                  <div className="text-right shrink-0">
                    <span
                      className={`text-base font-mono font-bold tracking-tight ${
                        transferProgress === 100 ? 'text-[#81c995]' : 'text-[#c4c7c5]'
                      }`}
                    >
                      {transferProgress}%
                    </span>
                  </div>
                </div>

                {/* Progress Track */}
                <div className="relative w-full h-2 rounded-full bg-[#131314] mt-4 overflow-hidden border border-[#333537]">
                  <div
                    className={`h-full transition-all duration-300 ease-out rounded-full ${
                      transferProgress === 100
                        ? 'bg-[#81c995] shadow-md shadow-emerald-500/50'
                        : 'bg-[#a8c7fa]'
                    }`}
                    style={{ width: `${transferProgress}%` }}
                  />
                </div>

                {/* Status Footer */}
                <div className="flex items-center justify-between text-[11px] text-[#75777a] font-mono mt-3">
                  <span>{transferProgress === 100 ? '0 B/s' : transferSpeed}</span>

                  <div className="flex items-center gap-3">
                    {transferProgress < 100 && transfer?.direction === 'sending' && (
                      <button
                        type="button"
                        onClick={cancelTransfer}
                        className="text-xs text-[#f28b82] hover:text-rose-300 transition-colors"
                      >
                        Cancel
                      </button>
                    )}
                    {transferProgress === 100 ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-[#81c995] border border-emerald-500/20 font-sans font-medium text-xs">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#81c995] animate-pulse"></span>
                        Complete
                      </span>
                    ) : (
                      <span className="capitalize text-[#9aa0a6]">
                        {transfer?.direction === 'sending' || role === 'initiator' ? 'Sending' : 'Receiving'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div className="transfer-footnote text-[#75777a]"><span>▣</span> Your browser writes incoming chunks straight to disk. Large files never need to fit in memory.</div>
          </section>
        )}

        <footer className="page-footer">
          <span>Built for the heavy lift.</span>
          <span><i /> End-to-end encrypted by WebRTC</span>
          <span>relayless / 2026</span>
        </footer>
      </main>

      {/* Global Confirmation Modal: Rendered for BOTH Host and Joiner */}
      <ConfirmationModal
        isOpen={showConfirmationModal}
        code={verificationCode}
        verificationCode={verificationCode}
        peerNickname={peerNickname}
        onConfirm={() => {
          const activePairingId = pairingId || currentPairingIdRef.current;
          socket.emit('confirm_pairing', { pairingId: activePairingId });
          emitSocket('confirm_pairing', { pairingId: activePairingId });
        }}
        onClose={() => {
          setShowConfirmationModal(false);
          const activePairingId = pairingId || currentPairingIdRef.current;
          socket.emit('reject_pairing', { pairingId: activePairingId });
          emitSocket('reject_pairing', { pairingId: activePairingId });
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
          onResult={(scannedPin) => {
            setScannerOpen(false);
            console.log('[Scanner 🎯] Auto-connecting with PIN/result:', scannedPin);
            handleJoinWithPin(scannedPin);
          }}
          onScanSuccess={(scannedPin) => {
            setScannerOpen(false);
            console.log('[Scanner 🎯] Auto-connecting with PIN:', scannedPin);
            handleJoinWithPin(scannedPin);
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </div>
  );
}
