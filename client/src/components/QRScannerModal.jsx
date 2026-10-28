import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

export default function QRScannerModal({ onResult, onClose }) {
  const scannerRef = useRef(null);
  const isStoppingRef = useRef(false);
  const [error, setError] = useState('');

  const stopScanner = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch (err) {
        console.warn('[Scanner] Camera stop warning:', err);
      }
    }
  };

  const handleScanSuccess = async (decodedText) => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

    // Immediately pause/stop the scanner instance and release camera tracks
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch (err) {
        console.warn('[Scanner] Camera stop warning:', err);
      }
    }

    // Only after the camera stream is stopped, invoke the join session logic
    onResult(decodedText);
  };

  useEffect(() => {
    let mounted = true;
    const scanner = new Html5Qrcode('qr-reader');
    scannerRef.current = scanner;

    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 230, height: 230 } },
      (decodedText) => {
        if (!mounted) return;
        handleScanSuccess(decodedText);
      },
      () => {}
    ).catch((scanError) => {
      if (mounted) {
        setError(scanError?.message || 'Camera access is unavailable.');
      }
    });

    return () => {
      mounted = false;
      if (scannerRef.current && !isStoppingRef.current) {
        isStoppingRef.current = true;
        try {
          scannerRef.current.stop().catch(() => {}).then(() => {
            try { scannerRef.current?.clear(); } catch (e) {}
          });
        } catch (e) {}
      }
    };
  }, []);

  const handleClose = async () => {
    if (!isStoppingRef.current) {
      isStoppingRef.current = true;
      await stopScanner();
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card scanner-card" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
        <div className="modal-eyebrow">Camera scanner</div>
        <h2 id="scanner-title">Scan a device QR</h2>
        <div id="qr-reader" className="qr-reader" />
        {error && <p className="error-text">{error}</p>}
        <button className="button button-secondary full-width" type="button" onClick={handleClose}>Close scanner</button>
      </section>
    </div>
  );
}
