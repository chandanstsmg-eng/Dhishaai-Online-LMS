import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// Catch any render error so users see a friendly message + reload, never a blank white screen.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('App error:', error, info) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(150deg,#0D2137,#17406E)', padding: 24, fontFamily: "'Inter','Segoe UI',sans-serif" }}>
          <div style={{ background: '#fff', borderRadius: 20, padding: 'clamp(24px,4vw,40px)', maxWidth: 440, width: '100%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
            <div style={{ fontSize: 44, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0D2137', marginBottom: 8 }}>Something went wrong</h2>
            <p style={{ color: '#64748B', fontSize: 14, marginBottom: 20, lineHeight: 1.6 }}>The page hit an unexpected error. Please reload — your data is safe.</p>
            <button onClick={() => window.location.reload()} style={{ background: 'linear-gradient(135deg,#E87722,#d4601a)', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 28px', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Reload App</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
