import React from 'react';

export default function ConfirmationModal({ isOpen, onClose, onConfirm, code, verificationCode, rawCode, peerNickname }) {
  if (!isOpen) return null;

  const activeCode = code || verificationCode || rawCode;
  const codeStr = activeCode ? String(activeCode).padStart(2, '0') : '--';

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        backdropFilter: 'blur(4px)',
        padding: '1rem'
      }}
    >
      <div
        className="relative w-full max-w-sm rounded-2xl bg-slate-900 p-6 border border-slate-800 text-center shadow-2xl"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '384px',
          borderRadius: '16px',
          backgroundColor: '#0f172a',
          padding: '1.5rem',
          border: '1px solid #1e293b',
          textAlign: 'center',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
        }}
      >
        <span
          className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 modal-eyebrow"
          style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#34d399' }}
        >
          Mutual Confirmation
        </span>
        <h3
          className="text-xl font-bold text-white mt-1 mb-2"
          style={{ fontSize: '1.25rem', fontWeight: 700, color: '#fff', marginTop: '0.25rem', marginBottom: '0.5rem' }}
        >
          Connect {peerNickname || 'device'}?
        </h3>
        <p
          className="text-xs text-slate-400 mb-6 muted"
          style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '1.5rem' }}
        >
          Compare this code on both screens before allowing the connection.
        </p>
        
        <div
          className="flex justify-center items-center gap-3 my-4"
          style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', margin: '1rem 0' }}
        >
          <div
            className="w-14 h-16 rounded-xl bg-slate-800/80 border border-slate-700 flex items-center justify-center text-3xl font-mono font-bold text-amber-400"
            style={{
              width: '3.5rem',
              height: '4rem',
              borderRadius: '12px',
              backgroundColor: 'rgba(30, 41, 59, 0.8)',
              border: '1px solid #334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.875rem',
              fontFamily: 'monospace',
              fontWeight: 700,
              color: '#fbbf24'
            }}
          >
            {codeStr[0]}
          </div>
          <div
            className="w-14 h-16 rounded-xl bg-slate-800/80 border border-slate-700 flex items-center justify-center text-3xl font-mono font-bold text-amber-400"
            style={{
              width: '3.5rem',
              height: '4rem',
              borderRadius: '12px',
              backgroundColor: 'rgba(30, 41, 59, 0.8)',
              border: '1px solid #334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.875rem',
              fontFamily: 'monospace',
              fontWeight: 700,
              color: '#fbbf24'
            }}
          >
            {codeStr[1]}
          </div>
        </div>

        <p
          className="text-[11px] text-slate-400 mb-6 muted small"
          style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '1.5rem' }}
        >
          Both people must accept to begin the encrypted WebRTC handshake.
        </p>

        <div
          className="flex gap-3 modal-actions"
          style={{ display: 'flex', gap: '0.75rem' }}
        >
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-semibold text-slate-300 transition-colors button button-secondary"
            style={{
              flex: 1,
              padding: '0.75rem 0',
              borderRadius: '12px',
              backgroundColor: '#1e293b',
              color: '#cbd5e1',
              fontSize: '0.875rem',
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer'
            }}
          >
            Reject
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-sm font-semibold text-slate-950 transition-colors shadow-lg shadow-emerald-500/20 button button-primary"
            style={{
              flex: 1,
              padding: '0.75rem 0',
              borderRadius: '12px',
              backgroundColor: '#10b981',
              color: '#020617',
              fontSize: '0.875rem',
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer'
            }}
          >
            Allow connection
          </button>
        </div>
      </div>
    </div>
  );
}
