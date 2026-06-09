import React from "react"

interface Props { children: React.ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("UI crashed:", error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{padding:24,fontFamily:'monospace',color:'#FF1744',background:'#0A0A0C',height:'100vh',overflow:'auto'}}>
          <h2 style={{color:'#fff'}}>Terjadi error saat render</h2>
          <pre style={{whiteSpace:'pre-wrap',marginTop:12}}>{String(this.state.error?.stack || this.state.error)}</pre>
          <button onClick={() => this.setState({error:null})}
            style={{marginTop:16,padding:'8px 16px',cursor:'pointer'}}>Coba lagi</button>
        </div>
      )
    }
    return this.props.children
  }
}
