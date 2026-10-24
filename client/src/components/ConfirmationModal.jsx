export default function ConfirmationModal({ prompt, onAccept, onReject, hasAccepted, isOpen = true }) {
  if (!prompt || !isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
        <div className="modal-eyebrow">Mutual confirmation</div>
        <h2 id="pairing-title">Connect {prompt.otherDeviceName}?</h2>
        <p className="muted">Compare this code on both screens before allowing the connection.</p>
        <div className="confirmation-code" aria-label={`Confirmation code ${prompt.confirmationCode}`}>
          {prompt.confirmationCode}
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
