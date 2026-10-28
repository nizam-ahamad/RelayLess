export default function ConfirmationModal({
  prompt,
  verificationCode,
  displayCode: propDisplayCode,
  onAccept,
  onReject,
  hasAccepted
}) {
  if (!prompt && !verificationCode && !propDisplayCode) {
    return null;
  }

  const rawCode = (verificationCode !== undefined && verificationCode !== null && verificationCode !== '')
    ? verificationCode
    : (prompt?.verificationCode ?? prompt?.confirmationCode ?? prompt?.code ?? propDisplayCode);

  // Safe defensive string conversion
  const codeStr = rawCode ? String(rawCode).padStart(2, '0') : '--';
  const otherDevice = prompt?.otherDeviceName || prompt?.deviceName || 'the other device';

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
        <div className="modal-eyebrow">Mutual confirmation</div>
        <h2 id="pairing-title">Connect {otherDevice}?</h2>
        <p className="muted">Compare this code on both screens before allowing the connection.</p>
        <div className="confirmation-code" aria-label={`Confirmation code ${codeStr}`}>
          <span className="code-digit">{codeStr[0] ?? '-'}</span>
          <span className="code-digit">{codeStr[1] ?? '-'}</span>
        </div>
        <p className="muted small">Both people must accept to begin the encrypted WebRTC handshake.</p>
        {hasAccepted ? (
          <div className="waiting-state"><span className="pulse-dot" /> Waiting for the other device…</div>
        ) : (
          <div className="modal-actions">
            <button className="button button-secondary" type="button" onClick={onReject}>Reject</button>
            <button className="button button-primary" type="button" onClick={onAccept}>Allow connection</button>
          </div>
        )}
      </section>
    </div>
  );
}
