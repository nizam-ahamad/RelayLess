export default function ConfirmationModal({
  isOpen,
  show,
  onClose,
  onConfirm,
  onAccept,
  onReject,
  code,
  verificationCode,
  rawCode,
  displayCode: propDisplayCode,
  prompt,
  hasAccepted
}) {
  // Check if modal should be closed
  if (isOpen === false || show === false) {
    return null;
  }

  const activeCode =
    code ||
    verificationCode ||
    rawCode ||
    propDisplayCode ||
    prompt?.verificationCode ||
    prompt?.confirmationCode ||
    prompt?.code;

  if (isOpen === undefined && show === undefined && !activeCode && !prompt) {
    return null;
  }

  // Safe defensive string conversion
  const codeStr = activeCode ? String(activeCode).padStart(2, '0') : '--';
  const otherDevice = prompt?.otherDeviceName || prompt?.deviceName || 'the other device';
  const handleConfirm = onConfirm || onAccept;
  const handleReject = onReject || onClose;

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
          <div className="waiting-state">
            <span className="pulse-dot" /> Waiting for the other device…
          </div>
        ) : (
          <div className="modal-actions">
            <button className="button button-secondary" type="button" onClick={handleReject}>
              Reject
            </button>
            <button className="button button-primary" type="button" onClick={handleConfirm}>
              Allow connection
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
