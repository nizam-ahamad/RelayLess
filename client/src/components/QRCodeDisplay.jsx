import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

export default function QRCodeDisplay({ value }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !value) {
      return undefined;
    }
    QRCode.toCanvas(canvasRef.current, value, {
      width: 160,
      margin: 1,
      color: {
        dark: '#0b1424',
        light: '#ffffff'
      },
      errorCorrectionLevel: 'M'
    }).catch(() => {});
    return undefined;
  }, [value]);

  return (
    <div className="qr-frame" style={{ width: '100%', height: '100%', padding: '4px', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-label="Pairing QR code">
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', borderRadius: '6px' }} />
    </div>
  );
}
