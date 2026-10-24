import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

export default function QRCodeDisplay({ value }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !value) {
      return undefined;
    }
    QRCode.toCanvas(canvasRef.current, value, {
      width: 220,
      margin: 2,
      color: {
        dark: '#0b1424',
        light: '#ffffff'
      },
      errorCorrectionLevel: 'M'
    }).catch(() => {});
    return undefined;
  }, [value]);

  return (
    <div className="qr-frame" aria-label="Pairing QR code">
      <canvas ref={canvasRef} />
    </div>
  );
}
