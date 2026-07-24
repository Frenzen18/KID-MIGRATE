import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 14, padding: 24, textAlign: 'center', fontFamily: "'Inter',sans-serif"
      }}>
        <i className="fa-solid fa-triangle-exclamation" style={{ fontSize: 40, color: '#F59E0B' }} />
        <div style={{ fontSize: 18, fontWeight: 700, color: '#0F172A' }}>Something went wrong</div>
        <div style={{ fontSize: 13.5, color: '#64748B', maxWidth: 420 }}>
          This page hit an unexpected error. Your data is safe — reloading usually fixes it.
        </div>
        <button
          className="btn-primary"
          style={{ padding: '10px 20px' }}
          onClick={() => { this.setState({ error: null }); window.location.reload(); }}
        >
          Reload page
        </button>
      </div>
    );
  }
}
