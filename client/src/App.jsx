import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCodeDisplay from './components/QRCodeDisplay.jsx';
import QRScannerModal from './components/QRScannerModal.jsx';
import PinInput from './components/PinInput.jsx';
import ConfirmationModal from './components/ConfirmationModal.jsx';
import IncomingFileModal from './components/IncomingFileModal.jsx';
import FileDropZone from './components/FileDropZone.jsx';
import TransferProgress from './components/TransferProgress.jsx';
import { connectSocket, disconnectSocket, emitSocket, onSocketEvent } from './services/socket.js';
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
  const sessionRef = useRef(null);
  const transferAbortRef = useRef(null);
  const receiverRef = useRef(null);
  const incomingTransferRef = useRef(null);
  const currentPairingIdRef = useRef(null);
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

  const sendSignal = useCallback((type, data) => {
    const pairingId = currentPairingIdRef.current;
    if (pairingId) {
      emitSocket('webrtc_signal', { pairingId, type, data });
    }
  }, []);

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

  const startWebRtc = useCallback(async ({ role, pairingId }) => {
    sessionRef.current?.close();
    const session = new WebRtcSession({
      role,
      onMessage: handleChannelMessage,
      onSignal: sendSignal,
      onStateChange: (state) => {
        if (state === 'data-channel-open') {
          setConnectionState('connected');
          emitSocket('webrtc_ready', { pairingId });
          showNotice('success', `Direct encrypted bridge established with ${selectedPeer?.deviceName || 'device'}.`);
        } else if (state === 'data-channel-closed') {
          setConnectionState((current) => current === 'connected' ? 'ready' : current);
        } else if (state === 'failed' || state === 'disconnected') {
          setConnectionState('failed');
          showNotice('error', 'WebRTC connection dropped. Could not traverse network firewalls.');
        }
      },
      onError: (error) => {
        setConnectionState('failed');
        showNotice('error', error.message || 'WebRTC connection failed.');
      }
    });
    sessionRef.current = session;
    await session.start();
  }, [handleChannelMessage, selectedPeer?.deviceName, sendSignal, showNotice]);

  const handlePairingConfirmed = useCallback(async (payload) => {
    currentPairingIdRef.current = payload.pairingId;
    setPrompt(null);
    setWaitingForAcceptance(false);
    setSelectedPeer(payload);
    setConnectionState('negotiating');
    showNotice('info', 'Establishing encrypted peer-to-peer tunnel...');
    await startWebRtc({
      role: payload.initiator ? 'initiator' : 'receiver',
      pairingId: payload.pairingId
    });
  }, [startWebRtc, showNotice]);

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
        setConnectionState('ready');
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
      onSocketEvent('webrtc_signal', async (payload) => {
        try {
          await sessionRef.current?.handleSignal(payload.type, payload.data);
        } catch (error) {
          showNotice('error', error.message || 'Could not complete the WebRTC handshake.');
        }
      }),
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
      showNotice('error', 'Connect to another device before choosing files.');
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

  const cancelTransfer = () => {
    transferAbortRef.current?.abort();
    transferAbortRef.current = null;
    setTransfer(null);
  };

  const rotateProgress = Math.max(0, Math.min(100, (pinSeconds / 120) * 100));
  const isConnected = connectionState === 'connected';
  const isBusy = ['requesting', 'pairing', 'connecting-peer', 'negotiating'].includes(connectionState);

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
              : connectionState === 'negotiating'
                ? 'Negotiating WebRTC…'
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

        {connectionState === 'negotiating' && (
          <section className="panel negotiating-card">
            <div className="spinner" />
            <div className="section-kicker">03 / Establishing tunnel</div>
            <h2>Establishing encrypted peer-to-peer tunnel…</h2>
            <p className="muted">Negotiating direct P2P bridge with <strong>{selectedPeer?.deviceName || 'the other device'}</strong> via STUN/TURN relays.</p>
            <button className="button button-secondary" type="button" onClick={() => {
              emitSocket('pairing_cancel', { pairingId: currentPairingIdRef.current });
              closeSession('Connection cancelled.');
            }}>Cancel</button>
          </section>
        )}

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

        {!isConnected && connectionState !== 'negotiating' && connectionState !== 'failed' && (
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
