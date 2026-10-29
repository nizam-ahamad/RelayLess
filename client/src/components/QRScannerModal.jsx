import React, { useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

// Safely parse 6-character alphanumeric PIN from raw string or URL
export function extractPin(text) {
  if (!text) return '';
  const trimmed = text.trim();
  // Check if it's a URL with query param ?pin=XXXXXX or #pin=XXXXXX
  const urlMatch = trimmed.match(/[?&#]pin=([A-Za-z0-9]{6})/i);
  if (urlMatch) return urlMatch[1].toUpperCase();

  // Check for any standalone 6-character alphanumeric token
  const tokenMatch = trimmed.match(/\b([A-Za-z0-9]{6})\b/);
  if (tokenMatch) return tokenMatch[1].toUpperCase();

  return trimmed.slice(0, 6).toUpperCase();
}

export default function QRScannerModal({ isOpen, onClose, onScanSuccess, onResult }) {
  const scannerRef = useRef(null);
  const isStoppingRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;

    isStoppingRef.current = false;
    const scannerId = "qr-reader-box";
    const html5QrCode = new Html5Qrcode(scannerId);
    scannerRef.current = html5QrCode;

    const stopHardwareCamera = async () => {
      // 1. Manually stop all active video stream tracks at browser media level
      const videoElem = document.querySelector(`#${scannerId} video`);
      if (videoElem && videoElem.srcObject) {
        const stream = videoElem.srcObject;
        stream.getTracks().forEach(track => {
          track.stop();
          track.enabled = false;
        });
        videoElem.srcObject = null;
      }

      // 2. Safely stop the library scanner without throwing DOMException
      if (html5QrCode.isScanning) {
        try {
          await html5QrCode.stop();
        } catch (e) {
          // Ignore harmless stop warnings
        }
      }
      try {
        html5QrCode.clear();
      } catch (e) {}
      scannerRef.current = null;
    };

    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async (decodedText) => {
        if (isStoppingRef.current) return;
        isStoppingRef.current = true;

        const pin = extractPin(decodedText);
        await stopHardwareCamera();
        onClose();
        if (onScanSuccess) {
          onScanSuccess(pin || decodedText);
        } else if (onResult) {
          onResult(pin || decodedText);
        }
      },
      () => {} // Ignore continuous scan misses
    ).catch((err) => {
      console.warn('[Scanner] Camera start error:', err);
    });

    return () => {
      if (!isStoppingRef.current) {
        isStoppingRef.current = true;
        stopHardwareCamera();
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
        className="relative w-full max-w-sm rounded-2xl bg-slate-900 p-6 border border-slate-800 text-center shadow-2xl modal-card"
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
          className="text-lg font-semibold text-white mb-1"
          style={{ fontSize: '1.125rem', fontWeight: 600, color: '#fff', marginBottom: '0.25rem' }}
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
          id="qr-reader-box"
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
