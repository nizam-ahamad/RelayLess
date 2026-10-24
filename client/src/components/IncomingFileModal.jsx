import { formatBytes } from '../utils/format.js';

export default function IncomingFileModal({ transfer, onAccept, onReject }) {
  if (!transfer) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="incoming-file-title">
        <div className="modal-eyebrow">Incoming file</div>
        <h2 id="incoming-file-title">Save this transfer?</h2>
        <div className="incoming-file-name">{transfer.fileName}</div>
        <p className="muted">{formatBytes(transfer.fileSize)} · {transfer.fileType || 'application/octet-stream'}</p>
        <p className="muted small">Choose a destination on your device. Chunks will stream there directly without being assembled in memory.</p>
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={onReject}>Decline</button>
          <button className="button button-primary" type="button" onClick={onAccept}>Choose save location</button>
        </div>
      </section>
    </div>
  );
}
