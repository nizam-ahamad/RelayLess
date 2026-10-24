import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

export default function QRScannerModal({ onResult, onClose }) {
  const scannerRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const scanner = new Html5Qrcode('qr-reader');
    scannerRef.current = scanner;
    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 230, height: 230 } },
      (decodedText) => {
        onResult(decodedText);
        scanner.stop().catch(() => {});
      },
      () => {}
    ).catch((scanError) => {
      setError(scanError?.message || 'Camera access is unavailable.');
    });

    return () => {
      scanner.stop().catch(() => {});
      scanner.clear().catch(() => {});
    };
  }, [onResult]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card scanner-card" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
        <div className="modal-eyebrow">Camera scanner</div>
        <h2 id="scanner-title">Scan a device QR</h2>
        <div id="qr-reader" className="qr-reader" />
        {error && <p className="error-text">{error}</p>}
        <button className="button button-secondary full-width" type="button" onClick={onClose}>Close scanner</button>
      </section>
    </div>
  );
}
