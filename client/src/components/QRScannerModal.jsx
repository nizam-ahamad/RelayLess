import React, { useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

export default function QRScannerModal({ isOpen = true, onClose, onScanSuccess, onResult }) {
  const scannerRef = useRef(null);
  const isStoppingRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;

    isStoppingRef.current = false;
    const html5QrCode = new Html5Qrcode("reader");
    scannerRef.current = html5QrCode;

    const config = { fps: 10, qrbox: { width: 250, height: 250 } };

    html5QrCode.start(
      { facingMode: "environment" },
      config,
      async (decodedText) => {
        if (isStoppingRef.current) return;
        isStoppingRef.current = true;

        // Safely extract 6-character alphanumeric PIN
        const match = decodedText.match(/(?:pin=|^)([A-Z0-9]{6})/i);
        const pin = match ? match[1].toUpperCase() : decodedText.trim().toUpperCase();

        try {
          if (html5QrCode.isScanning) {
            await html5QrCode.stop();
          }
          html5QrCode.clear();
        } catch (err) {
          // Suppress harmless stop warnings on unmount
        } finally {
          scannerRef.current = null;
        }

        if (onClose) {
          onClose();
        }
        if (onScanSuccess) {
          onScanSuccess(pin);
        } else if (onResult) {
          onResult(pin);
        }
      },
      () => {} // Ignore scan frame misses
    ).catch((err) => {
      console.warn('[Scanner] Camera start error:', err);
    });

    return () => {
      if (scannerRef.current && !isStoppingRef.current) {
        isStoppingRef.current = true;
        try {
          if (scannerRef.current.isScanning) {
            scannerRef.current.stop().catch(() => {}).finally(() => {
              try { scannerRef.current?.clear(); } catch(e) {}
              scannerRef.current = null;
            });
          }
        } catch (e) {
          scannerRef.current = null;
        }
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        backdropFilter: 'blur(4px)',
        padding: '1rem'
      }}
    >
      <div
        className="relative w-full max-w-sm rounded-2xl bg-slate-900 p-6 border border-slate-800 text-center modal-card"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '384px',
          borderRadius: '16px',
          backgroundColor: '#0f172a',
          padding: '1.5rem',
          border: '1px solid #1e293b',
          textAlign: 'center'
        }}
      >
        <h3
          className="text-lg font-semibold text-white mb-2"
          style={{ fontSize: '1.125rem', fontWeight: 600, color: '#fff', marginBottom: '0.5rem' }}
        >
          Scan QR Code
        </h3>
        <p
          className="text-xs text-slate-400 mb-4"
          style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '1rem' }}
        >
          Point your camera at the other screen
        </p>
        
        <div
          id="reader"
          className="w-full overflow-hidden rounded-xl bg-black min-h-[260px]"
          style={{ width: '100%', overflow: 'hidden', borderRadius: '12px', backgroundColor: '#000', minHeight: '260px' }}
        ></div>

        <button
          onClick={onClose}
          className="mt-4 w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-medium text-slate-300 transition-colors button button-secondary"
          style={{
            marginTop: '1rem',
            width: '100%',
            padding: '0.625rem 0',
            borderRadius: '12px',
            backgroundColor: '#1e293b',
            color: '#cbd5e1',
            fontSize: '0.875rem',
            fontWeight: 500,
            border: 'none',
            cursor: 'pointer'
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
