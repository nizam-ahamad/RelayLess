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

const DEFAULT_DEVICE_NAME = 'My device';

export default function App() {
  const [peer, setPeer] = useState(null);
  const [connectionState, setConnectionState] = useState('connecting');
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem('p2p-device-name') || DEFAULT_DEVICE_NAME);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState(false);
  const [pinSeconds, setPinSeconds] = useState(120);
  const [prompt, setPrompt] = useState(null);
  const [waitingForAcceptance, setWaitingForAcceptance] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [transfer, setTransfer] = useState(null);
  const [incomingTransfer, setIncomingTransfer] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selectedPeer, setSelectedPeer] = useState(null);
  const [partnerSocketId, setPartnerSocketId] = useState(null);
  const [webrtcRole, setWebrtcRole] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const sessionRef = useRef(null);
  const transferAbortRef = useRef(null);
  const receiverRef = useRef(null);
  const incomingTransferRef = useRef(null);
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

  const handleChannelMessage = useCallback(async (data) => {
    if (typeof data === 'string') {
      let packet;
      try {
        packet = JSON.parse(data);
      } catch {
        return;
      }

      if (packet.type === 'METADATA') {
        packet.fileName = sanitizeFileName(packet.fileName);
        const receiver = await new Promise((resolve) => {
          const pending = { metadata: packet, resolve };
          incomingTransferRef.current = pending;
          setIncomingTransfer(packet);
        });
        if (!receiver) {
          try {
            sessionRef.current?.send(JSON.stringify({ type: 'CANCEL', transferId: packet.transferId }));
          } catch {
            // The peer may have disconnected while the save prompt was open.
          }
        }
        return;
      }

      if (packet.type === 'COMPLETE' && receiverRef.current) {
        await receiverRef.current.complete();
        receiverRef.current = null;
        return;
      }

      if (packet.type === 'CANCEL') {
        await receiverRef.current?.cancel?.();
        receiverRef.current = null;
        setTransfer(null);
        showNotice('info', 'The other device cancelled the transfer.');
      }
      return;
    }

    if (receiverRef.current) {
      try {
        await receiverRef.current.write(data);
      } catch (error) {
        showNotice('error', error.message || 'The file could not be written to disk.');
      }
    }
  }, [showNotice]);

  const startWebRtc = useCallback(async ({ role, pairingId, partnerSocketId }) => {
    sessionRef.current?.close();
    console.log(`[WebRTC] Starting WebRtcSession. Role: ${role}, Pairing: ${pairingId}`);
    const session = new WebRtcSession({
      role,
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
        showNotice('success', `Direct encrypted bridge established with ${selectedPeer?.deviceName || selectedPeer?.partnerName || 'device'}.`);

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
          showNotice('success', `Direct encrypted bridge established with ${selectedPeer?.deviceName || selectedPeer?.partnerName || 'device'}.`);

          if (pendingFilesRef.current) {
            const queuedFiles = pendingFilesRef.current;
            pendingFilesRef.current = null;
            console.log('[WebRTC] Data channel ready, auto-starting queued file transfer...');
            handleFilesRef.current?.(queuedFiles);
          }
        } else if (state === 'data-channel-closed') {
          console.log('[WebRTC] DataChannel closed');
          setConnectionState((current) => current === 'connected' ? 'ready' : current);
        } else if (state === 'failed' || state === 'disconnected') {
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          console.warn(`[WebRTC] Connection ${state}`);
          setConnectionState('failed');
          showNotice('error', 'WebRTC connection dropped. Could not traverse network firewalls.');
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
  }, [handleChannelMessage, selectedPeer?.deviceName, selectedPeer?.partnerName, sendSignal, showNotice]);

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
        partnerSocketId: targetSocketId
      });
    } catch (error) {
      console.error('[Signaling] Fatal error in handlePairingConfirmed:', error);
      showNotice('error', `Failed to start connection: ${error.message}`);
      setConnectionState('failed');
    }
  }, [closeSession, startWebRtc, showNotice]);

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
        showNotice('error', 'Signaling server disconnected. Retrying automatically…');
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
      onSocketEvent('pairing_prompt', (nextPrompt) => {
        currentPairingIdRef.current = nextPrompt.pairingId;
        setPrompt(nextPrompt);
        setWaitingForAcceptance(false);
        setConnectionState('pairing');
      }),
      onSocketEvent('pairing_acknowledged', (payload) => {
        showNotice('info', `The ${payload.approvedByRole === 'requester' ? 'requesting' : 'receiving'} device approved. Confirm on your screen to continue.`);
      }),
      onSocketEvent('pairing_confirmed', handlePairingConfirmed),
      onSocketEvent('webrtc_signal', handleIncomingSignal),
      onSocketEvent('signal', handleIncomingSignal),
      onSocketEvent('connection_ready', (payload) => {
        setSelectedPeer(payload);
        setConnectionState('connected');
        showNotice('success', `Connected directly to ${payload.deviceName}.`);
      }),
      onSocketEvent('pairing_error', (error) => {
        setPrompt(null);
        setWaitingForAcceptance(false);
        setConnectionState('ready');
        showNotice('error', error.message || 'Unable to start pairing.');
      }),
      onSocketEvent('pairing_rejected', (payload) => closeSession(payload.message)),
      onSocketEvent('pairing_cancelled', (payload) => closeSession(payload.message)),
      onSocketEvent('peer_disconnected', () => closeSession('The other device disconnected.'))
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
  }, [closeSession, handlePairingConfirmed, pairPeerId, showNotice]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPinSeconds((current) => current > 0 ? current - 1 : 0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleConnect = useCallback((value = pinInput) => {
    const normalized = value.trim().toUpperCase();
    if (normalized.length !== 6) {
      return;
    }
    const myPin = peer?.pin ? peer.pin.trim().toUpperCase() : null;
    if (myPin && normalized === myPin) {
      setPinError(true);
      setPinInput('');
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
  }, [deviceName, peer?.pin, pinInput, showNotice]);

  const handleScanResult = useCallback((decoded) => {
    try {
      const url = new URL(decoded);
      const targetPeerId = url.searchParams.get('pair');
      if (targetPeerId) {
        if (peer?.peerId && targetPeerId === peer.peerId) {
          showNotice('error', 'You cannot connect to your own device. Please enter the PIN shown on the other screen.');
          setScannerOpen(false);
          return;
        }
        emitSocket('request_pairing', { targetPeerId, deviceName });
        setConnectionState('requesting');
        setScannerOpen(false);
        return;
      }
    } catch {
      // The QR may contain a raw peer ID; accept that as a convenience.
      if (decoded) {
        if (peer?.peerId && decoded === peer.peerId) {
          showNotice('error', 'You cannot connect to your own device. Please enter the PIN shown on the other screen.');
          setScannerOpen(false);
          return;
        }
        emitSocket('request_pairing', { targetPeerId: decoded, deviceName });
        setConnectionState('requesting');
        setScannerOpen(false);
      }
    }
  }, [deviceName, peer?.peerId, showNotice]);

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

    for (const file of files) {
      const abortController = new AbortController();
      transferAbortRef.current = abortController;
      setTransfer({
        fileName: file.name,
        fileSize: file.size,
        bytesTransferred: 0,
        percent: 0,
        direction: 'sending',
        status: 'Sending'
      });

      try {
        await sendFile({
          file,
          dataChannel: channel,
          signal: abortController.signal,
          onProgress: (progress) => setTransfer((current) => ({
            ...(current || {}),
            fileName: file.name,
            fileSize: file.size,
            bytesTransferred: progress.bytesSent,
            percent: progress.percent,
            speed: progress.speed,
            direction: 'sending',
            status: 'Sending'
          })),
          onComplete: () => setTransfer((current) => ({
            ...(current || {}),
            bytesTransferred: file.size,
            percent: 100,
            direction: 'sending',
            status: 'Complete'
          }))
        });
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
