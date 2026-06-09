import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// ── Global error overlay (membantu debug WebView2 di Windows) ──
function showFatal(msg: string) {
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;inset:0;z-index:99999;padding:24px;background:#0A0A0C;' +
    'color:#FF1744;font-family:monospace;font-size:13px;white-space:pre-wrap;overflow:auto'
  el.textContent = 'FATAL ERROR:\n\n' + msg
  document.body.appendChild(el)
}
window.addEventListener('error', e => {
  showFatal((e.error?.stack) || e.message || String(e))
})
window.addEventListener('unhandledrejection', e => {
  showFatal('Unhandled promise rejection:\n' + String(e.reason?.stack || e.reason))
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
