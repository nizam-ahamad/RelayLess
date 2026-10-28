import React from 'react';

export class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[App Crash Caught]:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="min-h-screen flex items-center justify-center bg-slate-950 p-6 text-center text-white"
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#020617',
            padding: '1.5rem',
            textAlign: 'center',
            color: '#ffffff'
          }}
        >
          <div
            className="max-w-md p-6 rounded-2xl bg-slate-900 border border-slate-800"
            style={{
              maxWidth: '28rem',
              width: '100%',
              padding: '1.5rem',
              borderRadius: '1rem',
              backgroundColor: '#0f172a',
              border: '1px solid #1e293b'
            }}
          >
            <h2
              className="text-xl font-bold mb-2 text-rose-400"
              style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                marginBottom: '0.5rem',
                color: '#fb7185'
              }}
            >
              Something went wrong
            </h2>
            <p
              className="text-xs text-slate-400 mb-4 font-mono"
              style={{
                fontSize: '0.75rem',
                color: '#94a3b8',
                marginBottom: '1rem',
                fontFamily: 'monospace'
              }}
            >
              {this.state.error?.message || 'Unexpected error'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2 rounded-xl bg-emerald-500 font-semibold text-slate-950 hover:bg-emerald-400"
              style={{
                padding: '0.5rem 1.5rem',
                borderRadius: '0.75rem',
                backgroundColor: '#10b981',
                fontWeight: 600,
                color: '#020617',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
