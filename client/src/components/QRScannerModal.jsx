import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

export default function QRScannerModal({ onResult, onScanSuccess, onClose }) {
  const scannerRef = useRef(null);
  const isProcessingRef = useRef(false);
  const [error, setError] = useState('');

  const stopScannerHardware = async () => {
    if (scannerRef.current) {
      try {
        // Stop media stream tracks directly from DOM video elements
        const videoElem =
          document.querySelector('#qr-reader video') ||
          document.querySelector('#reader video') ||
          document.querySelector('video');
        if (videoElem && videoElem.srcObject) {
          const stream = videoElem.srcObject;
          if (typeof stream.getTracks === 'function') {
            stream.getTracks().forEach((track) => track.stop());
          }
        }
        await scannerRef.current.stop();
        await scannerRef.current.clear();
      } catch (err) {
        console.warn('[Scanner] Ignored hardware cleanup warning:', err);
      } finally {
        scannerRef.current = null;
      }
    }
  };

  const handleScan = async (decodedText) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    // 1. Direct-kill all active hardware camera tracks immediately before unmounting
    await stopScannerHardware();

    // 2. Extract the PIN cleanly (supporting raw PIN or ?pin= URLs)
    let pin = decodedText ? String(decodedText).trim() : '';
    if (pin.includes('pin=')) {
      const urlParams = new URLSearchParams(pin.split('?')[1] || '');
      pin = urlParams.get('pin') || pin;
    }

    // 3. Call onClose() and invoke onScanSuccess(pin) inside setTimeout(..., 50)
    // so React finishes closing the modal before transitioning state
    if (onClose) {
      onClose();
    }
    setTimeout(() => {
      if (typeof onScanSuccess === 'function') {
        onScanSuccess(pin);
      } else if (typeof onResult === 'function') {
        onResult(pin);
      }
    }, 50);
  };

  useEffect(() => {
    let mounted = true;
    const scanner = new Html5Qrcode('qr-reader');
    scannerRef.current = scanner;

    scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 230, height: 230 } },
        (decodedText) => {
          if (!mounted || isProcessingRef.current) return;
          handleScan(decodedText);
        },
        () => {}
      )
      .catch((scanError) => {
        if (mounted && !isProcessingRef.current) {
          setError(scanError?.message || 'Camera access is unavailable.');
        }
      });

    return () => {
      mounted = false;
      if (scannerRef.current && !isProcessingRef.current) {
        isProcessingRef.current = true;
        try {
          const videoElem =
            document.querySelector('#qr-reader video') ||
            document.querySelector('#reader video') ||
            document.querySelector('video');
          if (videoElem && videoElem.srcObject) {
            videoElem.srcObject.getTracks?.().forEach((track) => track.stop());
          }
          scannerRef.current
            .stop()
            .catch(() => {})
            .then(() => {
              try {
                scannerRef.current?.clear();
              } catch (e) {}
              scannerRef.current = null;
            });
        } catch (e) {
          scannerRef.current = null;
        }
      }
    };
  }, []);

  const handleClose = async () => {
    if (!isProcessingRef.current) {
      isProcessingRef.current = true;
      await stopScannerHardware();
    }
    if (onClose) {
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card scanner-card" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
        <div className="modal-eyebrow">Camera scanner</div>
        <h2 id="scanner-title">Scan a device QR</h2>
        <div className="qr-reader-wrapper" style={{ position: 'relative', overflow: 'hidden', minHeight: '250px' }}>
          <div id="qr-reader" className="qr-reader" />
          <div id="reader" style={{ display: 'none' }} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="button button-secondary full-width" type="button" onClick={handleClose}>
          Close scanner
        </button>
      </section>
    </div>
  );
}
