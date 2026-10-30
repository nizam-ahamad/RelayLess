import React, { useState, useEffect } from 'react';

export default function ConfirmationModal({ isOpen, onClose, onConfirm, code, verificationCode, rawCode, peerNickname }) {
  const [isWaitingPeer, setIsWaitingPeer] = useState(false);

  useEffect(() => {
    if (isOpen) setIsWaitingPeer(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const activeCode = code || verificationCode || rawCode;
  const codeStr = activeCode ? String(activeCode).padStart(2, '0') : '--';

  const handleAllow = () => {
    setIsWaitingPeer(true);
    onConfirm();
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(4px)',
        padding: '1rem'
      }}
    >
      <div
        className="relative w-full max-w-sm rounded-2xl bg-[#1e1f20] p-6 border border-[#333537] text-center shadow-2xl"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '384px',
          borderRadius: '16px',
          backgroundColor: '#1e1f20',
          padding: '1.5rem',
          border: '1px solid #333537',
          textAlign: 'center',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
        }}
      >
        <span
          className="text-[11px] font-bold uppercase tracking-wider text-[#a8c7fa] modal-eyebrow"
          style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#a8c7fa' }}
        >
          Mutual Confirmation
        </span>
        <h3
          className="text-xl font-bold text-[#e3e3e3] mt-1 mb-2"
          style={{ fontSize: '1.25rem', fontWeight: 700, color: '#e3e3e3', marginTop: '0.25rem', marginBottom: '0.5rem' }}
        >
          Connect {peerNickname || 'device'}?
        </h3>
        <p
          className="text-xs text-[#9aa0a6] mb-6 muted"
          style={{ fontSize: '0.75rem', color: '#9aa0a6', marginBottom: '1.5rem' }}
        >
          Compare this code on both screens before allowing the connection.
        </p>
        
        <div
          className="flex justify-center items-center gap-3 my-4"
          style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', margin: '1rem 0' }}
        >
          <div
            className="w-14 h-16 rounded-xl bg-[#131314] border border-[#3c4043] flex items-center justify-center text-3xl font-mono font-bold text-[#a8c7fa]"
            style={{
              width: '3.5rem',
              height: '4rem',
              borderRadius: '12px',
              backgroundColor: '#131314',
              border: '1px solid #3c4043',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.875rem',
              fontFamily: 'monospace',
              fontWeight: 700,
              color: '#a8c7fa'
            }}
          >
            {codeStr[0]}
          </div>
          <div
            className="w-14 h-16 rounded-xl bg-[#131314] border border-[#3c4043] flex items-center justify-center text-3xl font-mono font-bold text-[#a8c7fa]"
            style={{
              width: '3.5rem',
              height: '4rem',
              borderRadius: '12px',
              backgroundColor: '#131314',
              border: '1px solid #3c4043',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.875rem',
              fontFamily: 'monospace',
              fontWeight: 700,
              color: '#a8c7fa'
            }}
          >
            {codeStr[1]}
          </div>
        </div>

        <p
          className="text-[11px] text-[#9aa0a6] mb-6 muted small"
          style={{ fontSize: '11px', color: '#9aa0a6', marginBottom: '1.5rem' }}
        >
          {isWaitingPeer ? "Waiting for the other device to accept..." : "Both people must accept to begin the encrypted WebRTC handshake."}
        </p>

        <div
          className="flex gap-3 modal-actions"
          style={{ display: 'flex', gap: '0.75rem' }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={isWaitingPeer}
            className="flex-1 py-3 rounded-xl bg-[#282a2c] hover:bg-[#333537] text-sm font-semibold text-[#c4c7c5] transition-colors disabled:opacity-50 button button-secondary"
            style={{
              flex: 1,
              padding: '0.75rem 0',
              borderRadius: '12px',
              backgroundColor: '#282a2c',
              color: '#c4c7c5',
              fontSize: '0.875rem',
              fontWeight: 600,
              border: 'none',
              cursor: isWaitingPeer ? 'not-allowed' : 'pointer',
              opacity: isWaitingPeer ? 0.5 : 1
            }}
          >
            Reject
          </button>
          <button
            type="button"
            onClick={handleAllow}
            disabled={isWaitingPeer}
            className="flex-1 py-3 rounded-xl bg-[#a8c7fa] hover:bg-[#c2e7ff] text-sm font-semibold text-[#041e49] transition-colors shadow-lg disabled:opacity-75 flex items-center justify-center gap-2 button button-primary"
            style={{
              flex: 1,
              padding: '0.75rem 0',
              borderRadius: '12px',
              backgroundColor: '#a8c7fa',
              color: '#041e49',
              fontSize: '0.875rem',
              fontWeight: 600,
              border: 'none',
              cursor: isWaitingPeer ? 'not-allowed' : 'pointer',
              opacity: isWaitingPeer ? 0.8 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem'
            }}
          >
            {isWaitingPeer ? (
              <>
                <svg
                  className="animate-spin h-4 w-4 text-[#041e49]"
                  style={{ width: '1rem', height: '1rem', animation: 'spin 1s linear infinite' }}
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25"></circle>
                  <path className="opacity-75" fill="currentColor" opacity="0.75" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                <span>Waiting...</span>
              </>
            ) : (
              "Allow connection"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
