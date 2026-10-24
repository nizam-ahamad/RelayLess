import { formatBytes, formatDuration } from '../utils/format.js';

export default function TransferProgress({ transfer, onCancel }) {
  if (!transfer) {
    return null;
  }

  const percent = Math.min(100, Math.max(0, transfer.percent ?? 0));
  const speed = transfer.speed ?? 0;
  const remainingBytes = Math.max(0, (transfer.fileSize ?? 0) - (transfer.bytesTransferred ?? 0));
  const eta = speed > 0 ? remainingBytes / speed : 0;

  return (
    <section className="transfer-card">
      <div className="transfer-topline">
        <div>
          <div className="file-name">{transfer.fileName}</div>
          <div className="muted small">{formatBytes(transfer.fileSize)} · {transfer.direction}</div>
        </div>
        <strong>{Math.round(percent)}%</strong>
      </div>
      <div className="progress-track" aria-label={`${Math.round(percent)} percent complete`}>
        <div className="progress-value" style={{ width: `${percent}%` }} />
      </div>
      <div className="transfer-stats">
        <span>{formatBytes(speed)}/s</span>
        <span>{eta > 0 ? `${formatDuration(eta)} remaining` : transfer.status}</span>
        {onCancel && <button className="text-button danger-text" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </section>
  );
}
