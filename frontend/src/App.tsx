import { useState, useEffect, useRef, useCallback } from "react"
import React from "react";
import { invoke }  from "@tauri-apps/api/core"
import { listen }  from "@tauri-apps/api/event"
import { open }    from "@tauri-apps/plugin-shell"
import "./App.css"

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════
type AppView  = 'keygen' | 'deploy' | 'manage' | 'info' | 'settings'
type KgStep   = 'idle' | 'mnemonic' | 'confirm' | 'passphrase' | 'genesis' | 'deriving' | 'complete'
type NodeStatus = 'idle' | 'active' | 'inactive' | 'failed' | 'unknown'
type LogType  = 'cmd' | 'ok' | 'err' | 'inf'

interface Server  { id: string; label: string; host: string; username: string; keyPath: string }
interface LogLine { type: LogType; text: string }
interface Toast   { id: number; type: 'success'|'error'|'warning'|'default'; text: string }
interface RamInfo { total_mb: number; available_mb: number }

interface KeygenResult {
  keystore_b64: string
  node_id_hex:  string
  wallet_address: string
}

interface KgState {
  step:      KgStep
  mnemonic:  string[]
  revealed:  boolean
  word7:     string; word7Err:  string
  word14:    string; word14Err: string
  word21:    string; word21Err: string
  pass:      string; passConfirm: string; passErr: string
  genesis:   string
  result:    KeygenResult | null
  err:       string
}

interface DpState {
  keystore: string; pass: string; genesis: string; peers: string
  peersOpen: boolean; connSt: 'idle'|'testing'|'ok'|'err'; connMsg: string
  deplSt: 'idle'|'deploying'|'done'|'error'; logs: LogLine[]
}

interface MgState {
  status:      NodeStatus
  statusLoading: boolean
  action:      'idle'|'starting'|'stopping'|'resetting'|'fetching_logs'
  mgLogs:      LogLine[]
  logs:        string
  logsVisible: boolean
  err:         string
}

// ═══════════════════════════════════════════════════════════════
// ICONS (Heroicons outline style)
// ═══════════════════════════════════════════════════════════════
const IKey = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/>
  </svg>
)
const IServer = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/>
    <line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>
  </svg>
)
const IGrid = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/>
    <rect width="7" height="7" x="3" y="14" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/>
  </svg>
)
const IInfo = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
  </svg>
)
const IGear = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
)
const IEye = ({ off }: { off?: boolean }) => off ? (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
    <line x1="1" x2="23" y1="1" y2="23"/>
  </svg>
) : (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
  </svg>
)
const IFolder = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
)
const IChev = ({ open }: { open: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(180deg)' : 'none', transition: '200ms' }}>
    <polyline points="6 9 12 15 18 9"/>
  </svg>
)
const ICheck = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
)
const ICopy = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
  </svg>
)
const ITrash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
  </svg>
)
const IEdit = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
)
const ILink = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/>
  </svg>
)
const IPower = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" x2="12" y1="2" y2="12"/>
  </svg>
)
const ILogoMark = () => (
  <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
    <rect width="32" height="32" rx="6" fill="white" fillOpacity="0.08"/>
    <path d="M8 11h10l-4 5h6" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="22" cy="21" r="3" stroke="white" strokeWidth="2"/>
  </svg>
)

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════
function calcEntropy(pass: string): number {
  if (!pass) return 0
  let pool = 0
  if (/[a-z]/.test(pass)) pool += 26
  if (/[A-Z]/.test(pass)) pool += 26
  if (/[0-9]/.test(pass))  pool += 10
  if (/[^a-zA-Z0-9]/.test(pass)) pool += 32
  return pool > 0 ? Math.log2(pool) * pass.length : 0
}
function entropyLevel(e: number): 'weak'|'fair'|'good'|'strong' {
  if (e < 28) return 'weak'
  if (e < 45) return 'fair'
  if (e < 60) return 'good'
  return 'strong'
}
function entropyPct(e: number): number { return Math.min((e / 80) * 100, 100) }
const ENTROPY_LABELS = { weak:'Lemah', fair:'Cukup', good:'Kuat', strong:'Sangat Kuat' }

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text) } catch(_) {}
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const copy = useCallback((text: string) => {
    copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }, [])
  return [copied, copy]
}

// ═══════════════════════════════════════════════════════════════
// APP COMPONENT
// ═══════════════════════════════════════════════════════════════
export default function App() {
  // ── Global state ──────────────────────────────────────────────
  const [appView,    setAppView]    = useState<AppView>('keygen')
  const [expertMode, setExpertMode] = useState(false)
  const [appVersion, setAppVersion] = useState('v1.0.0')
  const [toasts,     setToasts]     = useState<Toast[]>([])
  const [modal,      setModal]      = useState<{title:string;body:string;onConfirm:()=>void}|null>(null)
  const toastId = useRef(0)

  // ── Server state ──────────────────────────────────────────────
  const [servers,    setServers]    = useState<Server[]>([])
  const [selServer,  setSelServer]  = useState<Server | null>(null)
  const [showAddSrv, setShowAddSrv] = useState(false)
  const [editSvId,   setEditSvId]   = useState<string|null>(null)
  const [srvForm,    setSrvForm]    = useState({ label:'', host:'', username:'ubuntu', keyPath:'' })
  const [editForm,   setEditForm]   = useState({ label:'', host:'', username:'ubuntu', keyPath:'' })

  // ── Keygen state ──────────────────────────────────────────────
  const [kg, setKg] = useState<KgState>({
    step:'idle', mnemonic:[], revealed:false,
    word7:'', word7Err:'', word14:'', word14Err:'', word21:'', word21Err:'',
    pass:'', passConfirm:'', passErr:'',
    genesis:'', result:null, err:''
  })
  const [showPass, setShowPass] = useState(false)
  const [ram, setRam] = useState<RamInfo|null>(null)

  // ── Deploy state ──────────────────────────────────────────────
  const [dp, setDp] = useState<DpState>({
    keystore:'', pass:'', genesis:'', peers:'', peersOpen:false,
    connSt:'idle', connMsg:'', deplSt:'idle', logs:[]
  })
  const [showDpPass, setShowDpPass] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  // ── Manage state ──────────────────────────────────────────────
  const [mg, setMg] = useState<MgState>({
    status:'idle', statusLoading:false, action:'idle',
    mgLogs:[], logs:'', logsVisible:false, err:''
  })
  const mgLogRef = useRef<HTMLDivElement>(null)

  // ── Info state ────────────────────────────────────────────────
  const [infoTopic, setInfoTopic] = useState(0)

  // ── Init ──────────────────────────────────────────────────────
  useEffect(() => {
    invoke<string>('app_version').then(v => setAppVersion(v)).catch(() => {})
    invoke<Server[]>('load_servers').then(s => { setServers(s||[]); if(s?.length) setSelServer(s[0]) }).catch(()=>{})
    invoke<RamInfo>('get_system_ram').then(r => setRam(r)).catch(()=>{})
    const id = setInterval(() => invoke<RamInfo>('get_system_ram').then(r => setRam(r)).catch(()=>{}), 10000)
    return () => clearInterval(id)
  }, [])

  // ── Event listeners ───────────────────────────────────────────
  useEffect(() => {
    let u1: (()=>void)|null = null, u2: (()=>void)|null = null
    listen<{t:string;msg:string}>('deploy_log', ev => {
      const {t,msg} = ev.payload
      const type = t==='ok'?'ok':t==='err'?'err':t==='cmd'?'cmd':'inf'
      setDp(p => ({...p, logs:[...p.logs,{type,text:msg}]}))
    }).then(fn => { u1=fn })
    listen<{t:string;msg:string}>('manage_log', ev => {
      const {t,msg} = ev.payload
      const type = t==='ok'?'ok':t==='err'?'err':t==='cmd'?'cmd':'inf'
      setMg(p => ({...p, mgLogs:[...p.mgLogs,{type,text:msg}]}))
    }).then(fn => { u2=fn })
    return () => { u1?.(); u2?.() }
  }, [])

  useEffect(() => { if(logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [dp.logs])
  useEffect(() => { if(mgLogRef.current) mgLogRef.current.scrollTop = mgLogRef.current.scrollHeight }, [mg.mgLogs])

  // ── Toast ─────────────────────────────────────────────────────
  const toast = useCallback((type: Toast['type'], text: string) => {
    const id = ++toastId.current
    setToasts(p => [...p, {id, type, text}])
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4000)
  }, [])

  // ── Server management ─────────────────────────────────────────
  const persistServers = async (list: Server[]) => {
    await invoke('save_servers', { servers: list })
    setServers(list)
  }
  const selectServer = (sv: Server) => {
    setSelServer(sv)
    setDp(p => ({...p, connSt:'idle', connMsg:''}))
  }
  const addServer = async () => {
    if (!srvForm.label.trim() || !srvForm.host.trim()) return
    const srv: Server = { id: crypto.randomUUID(), ...srvForm }
    const list = [...servers, srv]
    await persistServers(list)
    setSelServer(srv)
    setSrvForm({ label:'', host:'', username:'ubuntu', keyPath:'' })
    setShowAddSrv(false)
    toast('success', `Server "${srv.label}" ditambahkan`)
  }
  const updateServer = async () => {
    if (!editSvId) return
    const list = servers.map(sv => sv.id === editSvId ? {...sv, ...editForm} : sv)
    await persistServers(list)
    if (selServer?.id === editSvId) setSelServer({...selServer!, ...editForm})
    setEditSvId(null)
    toast('success', 'Server diperbarui')
  }
  const deleteServer = async (id: string) => {
    const list = servers.filter(sv => sv.id !== id)
    await persistServers(list)
    if (selServer?.id === id) {
      const next = list[0] || null
      setSelServer(next)
    }
  }
  const pickKeyFile = async () => {
    try {
      const sel = await invoke<string|null>('pick_ssh_key')
      if (sel) setSrvForm(p => ({...p, keyPath: sel}))
    } catch(_) {}
  }
  const pickEditKeyFile = async () => {
    try {
      const sel = await invoke<string|null>('pick_ssh_key')
      if (sel) setEditForm(p => ({...p, keyPath: sel}))
    } catch(_) {}
  }

  // ── Keygen handlers ───────────────────────────────────────────
  const onGenerateMnemonic = async () => {
    const words = await invoke<string[]>('generate_mnemonic_cmd')
    setKg(p => ({...p, step:'mnemonic', mnemonic:words, revealed:false}))
  }
  const onConfirmWords = () => {
    const ok7  = kg.word7.trim().toLowerCase()  === kg.mnemonic[6]
    const ok14 = kg.word14.trim().toLowerCase() === kg.mnemonic[13]
    const ok21 = kg.word21.trim().toLowerCase() === kg.mnemonic[20]
    if (!ok7)  { setKg(p => ({...p, word7Err:'Kata tidak cocok. Periksa catatan kamu.'})); return }
    if (!ok14) { setKg(p => ({...p, word14Err:'Kata tidak cocok. Periksa catatan kamu.'})); return }
    if (!ok21) { setKg(p => ({...p, word21Err:'Kata tidak cocok. Periksa catatan kamu.'})); return }
    setKg(p => ({...p, step:'passphrase', word7Err:'', word14Err:'', word21Err:''}))
  }
  const onNextPass = () => {
    if (kg.pass.length < 8) { setKg(p => ({...p, passErr:'Minimum 8 karakter.'})); return }
    if (kg.pass !== kg.passConfirm) { setKg(p => ({...p, passErr:'Passphrase tidak cocok.'})); return }
    setKg(p => ({...p, step:'genesis', passErr:''}))
  }
  const onDeriveKeys = async () => {
    setKg(p => ({...p, step:'deriving', err:''}))
    try {
      const result = await invoke<KeygenResult>('encrypt_keystore_cmd', {
        mnemonic: kg.mnemonic, passphrase: kg.pass, genesisHash: kg.genesis,
      })
      setKg(p => ({...p, step:'complete', result}))
      // Pre-fill Deploy keystore
      setDp(p => ({...p, keystore: result.keystore_b64, genesis: kg.genesis}))
      toast('success', 'Node identity berhasil dibuat')
    } catch(e) {
      setKg(p => ({...p, step:'genesis', err: String(e)}))
      toast('error', 'Derivasi gagal: ' + String(e))
    }
  }
  const resetKeygen = () => {
    setKg({
      step:'idle', mnemonic:[], revealed:false,
      word7:'', word7Err:'', word14:'', word14Err:'', word21:'', word21Err:'',
      pass:'', passConfirm:'', passErr:'', genesis:'', result:null, err:''
    })
    setShowPass(false)
  }

  // ── Deploy handlers ───────────────────────────────────────────
  const onTestConn = async () => {
    if (!selServer) return
    setDp(p => ({...p, connSt:'testing', connMsg:''}))
    try {
      const ok = await invoke<boolean>('test_ssh_connection', {
        host: selServer.host, username: selServer.username, keyPath: selServer.keyPath
      })
      setDp(p => ({...p, connSt: ok?'ok':'err', connMsg: ok?'Koneksi berhasil':'Koneksi gagal'}))
    } catch(e) {
      setDp(p => ({...p, connSt:'err', connMsg: String(e)}))
    }
  }
  const onDeploy = async () => {
    if (!selServer) return
    setDp(p => ({...p, deplSt:'deploying', logs:[]}))
    try {
      await invoke('deploy_node', {
        host: selServer.host, username: selServer.username, keyPath: selServer.keyPath,
        keystoreBase64: dp.keystore, passphrase: dp.pass,
        genesisHash: dp.genesis,
        dialPeers: dp.peers.split('\n').filter(Boolean),
        app: undefined
      })
      setDp(p => ({...p, deplSt:'done'}))
      toast('success', `Node berhasil di-deploy ke ${selServer.label}`)
    } catch(e) {
      setDp(p => ({...p, deplSt:'error'}))
      toast('error', 'Deploy gagal: ' + String(e))
    }
  }

  // ── Manage handlers ───────────────────────────────────────────
  const onGetStatus = async () => {
    if (!selServer) return
    setMg(p => ({...p, statusLoading:true, err:''}))
    try {
      const status = await invoke<string>('get_node_status', {
        host: selServer.host, username: selServer.username, keyPath: selServer.keyPath
      })
      setMg(p => ({...p, status: status.trim() as NodeStatus, statusLoading:false}))
    } catch(e) {
      setMg(p => ({...p, status:'unknown', statusLoading:false, err:String(e)}))
    }
  }
  const onStartNode = async () => {
    if (!selServer) return
    setMg(p => ({...p, action:'starting', err:''}))
    try {
      const status = await invoke<string>('start_node', {
        host: selServer.host, username: selServer.username, keyPath: selServer.keyPath
      })
      setMg(p => ({...p, action:'idle', status: status.trim() as NodeStatus}))
      toast('success', 'Node started')
    } catch(e) { setMg(p => ({...p, action:'idle', err:String(e)})); toast('error', String(e)) }
  }
  const onStopNode = async () => {
    if (!selServer) return
    setMg(p => ({...p, action:'stopping', err:''}))
    try {
      const status = await invoke<string>('stop_node', {
        host: selServer.host, username: selServer.username, keyPath: selServer.keyPath
      })
      setMg(p => ({...p, action:'idle', status: status.trim() as NodeStatus}))
      toast('success', 'Node stopped')
    } catch(e) { setMg(p => ({...p, action:'idle', err:String(e)})); toast('error', String(e)) }
  }
  const onGetLogs = async () => {
    if (!selServer) return
    setMg(p => ({...p, action:'fetching_logs', logs:'', logsVisible:true, err:''}))
    try {
      const logs = await invoke<string>('get_node_logs', {
        host: selServer.host, username: selServer.username, keyPath: selServer.keyPath
      })
      setMg(p => ({...p, action:'idle', logs}))
    } catch(e) { setMg(p => ({...p, action:'idle', err:String(e)})) }
  }
  const onResetVps = async () => {
    if (!selServer) return
    setMg(p => ({...p, action:'resetting', mgLogs:[], err:''}))
    try {
      await invoke('reset_vps', {
        host: selServer.host, username: selServer.username, keyPath: selServer.keyPath
      })
      setMg(p => ({...p, action:'idle'}))
      toast('success', 'VPS reset selesai')
    } catch(e) { setMg(p => ({...p, action:'idle', err:String(e)})); toast('error', 'Reset gagal: '+String(e)) }
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER: SIDEBAR
  // ═══════════════════════════════════════════════════════════════
  const renderSidebar = () => (
    <aside className="sidebar">
      <div className="sidebar__logo">
        <ILogoMark />
        <div className="sidebar__logo-text">
          <span className="sidebar__logo-name">SCALAR</span>
          <span className="sidebar__logo-sub">NODE APP</span>
        </div>
      </div>
      <hr className="sidebar__divider"/>

      <div className="sidebar__nav">
        <div className="sidebar__nav-label">Main</div>
        {([
          ['keygen',   'Keygen',   <IKey/>],
          ['deploy',   'Deploy',   <IServer/>],
          ['manage',   'Manage',   <IGrid/>],
          ['info',     'Info',     <IInfo/>],
        ] as [AppView, string, React.ReactElement][]).map(([view, label, icon]) => (
          <button key={view}
            className={`nav-item${appView===view?' nav-item--active':''}`}
            onClick={() => setAppView(view)}>
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="sidebar__spacer"/>

      <div className="sidebar__bottom">
        <hr className="sidebar__divider"/>
        <button className={`nav-item${appView==='settings'?' nav-item--active':''}`}
          onClick={() => setAppView('settings')}>
          <IGear/><span>Settings</span>
        </button>
        <div className="sidebar__version">{appVersion}</div>
        <button className="sidebar__link" onClick={() => open('https://scalar.network')}>
          <ILink/><span>scalar.network</span>
        </button>
        <button className="sidebar__link sidebar__close"
          onClick={() => setModal({
            title:'Tutup Aplikasi',
            body:'Semua proses akan dihentikan. Gunakan ini sebelum menginstall versi baru.',
            onConfirm: () => invoke('quit_app').catch(()=>{})
          })}>
          <IPower/><span>Tutup Aplikasi</span>
        </button>
      </div>
    </aside>
  )

  // ═══════════════════════════════════════════════════════════════
  // RENDER: HEADER
  // ═══════════════════════════════════════════════════════════════
  const headerTitles: Record<AppView, string> = {
    keygen:'Create Node Identity', deploy:'Deploy Node to VPS',
    manage:'Manage Nodes', info:'Node Operator Guide', settings:'Settings'
  }
  const renderHeader = () => (
    <header className="app-header">
      <span className="app-header__title">{headerTitles[appView]}</span>
      <div className="expert-toggle" onClick={() => setExpertMode(v => !v)}>
        <span className={`expert-toggle__label${expertMode?' expert-toggle__label--on':''}`}>
          EXPERT MODE
        </span>
        <button className={`expert-toggle__track${expertMode?' expert-toggle__track--on':''}`}>
          <div className={`expert-toggle__thumb${expertMode?' expert-toggle__thumb--on':''}`}/>
        </button>
        <span className="expert-toggle__label" style={{color: expertMode?'#FFFFFF':'#52525B'}}>
          {expertMode ? 'ON' : 'OFF'}
        </span>
      </div>
    </header>
  )

  // ═══════════════════════════════════════════════════════════════
  // RENDER: KEYGEN TAB
  // ═══════════════════════════════════════════════════════════════
  const STEPS: KgStep[] = ['idle','mnemonic','confirm','passphrase','genesis','deriving','complete']
  const stepIdx = STEPS.indexOf(kg.step)

  const renderStepProgress = () => (
    <div className="step-progress">
      {[1,2,3,4,5,6,7].map((n, i) => (
        <>
          <div key={`pill-${n}`} className={`step-pill ${
            i < stepIdx ? 'step-pill--done' :
            i === stepIdx ? 'step-pill--active' : 'step-pill--pending'
          }`}>{i < stepIdx ? <ICheck/> : n}</div>
          {i < 6 && <div key={`line-${n}`} className={`step-line${i < stepIdx?' step-line--done':''}`}/>}
        </>
      ))}
    </div>
  )

  const EntropyBar = ({ pass }: { pass: string }) => {
    const e = calcEntropy(pass)
    const lvl = entropyLevel(e)
    const pct = entropyPct(e)
    return (
      <div className="entropy-bar">
        <div className="entropy-track">
          <div className={`entropy-fill entropy-fill--${lvl}`} style={{width:`${pct}%`}}/>
        </div>
        {pass && <span className={`entropy-label entropy-label--${lvl} t-caption`}>
          {ENTROPY_LABELS[lvl]} — ~{Math.round(e)} bit entropy
          {lvl === 'weak' && ' ⚠ Sangat mudah ditebak'}
        </span>}
      </div>
    )
  }

  const renderKg = () => {
    switch(kg.step) {

      case 'idle': return (
        <div className="kg-wrap">
          <div>
            <h1 className="t-display mb-3">Create Node Identity</h1>
            <p className="t-sub">Mnemonic kamu adalah kunci utama node dan wallet. Simpan offline sebelum melanjutkan.</p>
          </div>
          <div className="card card--warn">
            <div className="row gap-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{color:'#FFD600',flexShrink:0}}>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <p className="t-sub">Aplikasi ini <strong style={{color:'#FFD600'}}>TIDAK PERNAH</strong> menyimpan mnemonic kamu. Catat 24 kata di kertas fisik.</p>
            </div>
          </div>
          <div className="col gap-4 mt-4">
            <button className="btn btn-primary btn-lg" onClick={onGenerateMnemonic}>
              Generate Mnemonic Baru
            </button>
            <button className="btn btn-ghost" onClick={() => setKg(p=>({...p,step:'mnemonic',mnemonic:[]}))} style={{opacity:0.7}}>
              Restore dari Cold Storage
            </button>
          </div>
        </div>
      )

      case 'mnemonic': return (
        <div className="kg-wrap">
          {renderStepProgress()}
          <div>
            <h2 className="t-section mb-3" style={{fontSize:20}}>
              {kg.mnemonic.length > 0 ? 'MNEMONIC — 24 WORDS' : 'Masukkan Mnemonic'}
            </h2>
            {kg.mnemonic.length > 0 ? (
              <>
                <div className="card card--warn mb-3">
                  <p style={{fontSize:12,color:'#FFD600'}}>
                    Tulis semua 24 kata secara berurutan. Simpan offline. Jangan difoto.
                  </p>
                </div>
                <div className="mn-grid">
                  {kg.mnemonic.map((w, i) => (
                    <div key={i} className="mn-word">
                      <span className="mn-num">{i+1}</span>
                      <span className={`mn-txt${kg.revealed?'':' mn-txt--blur'}`}>{w}</span>
                    </div>
                  ))}
                </div>
                <div className="row gap-2 mt-4">
                  <button className="btn btn-ghost btn-sm" onClick={() => setKg(p=>({...p,revealed:!p.revealed}))}>
                    <IEye off={kg.revealed}/> {kg.revealed?'Sembunyikan':'Tampilkan'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => copyText(kg.mnemonic.join(' '))}>
                    <ICopy/> Salin
                  </button>
                </div>
                <div className="mt-5">
                  <button className="btn btn-primary btn-full"
                    disabled={!kg.revealed}
                    onClick={() => setKg(p=>({...p,step:'confirm'}))}>
                    Saya Sudah Catat — Lanjutkan →
                  </button>
                  {!kg.revealed && <p className="t-caption mt-2" style={{textAlign:'center',color:'#71717A'}}>
                    Tampilkan mnemonic terlebih dahulu sebelum melanjutkan
                  </p>}
                </div>
              </>
            ) : (
              /* Restore flow */
              <div className="col gap-4">
                <p className="t-sub">Masukkan 24 kata mnemonic kamu (pisahkan dengan spasi atau enter):</p>
                <textarea className="inp ta inp-mono" rows={6}
                  placeholder="scalar abandon ability able about above absent absorb..."
                  onChange={e => {
                    const words = e.target.value.trim().split(/\s+/).filter(Boolean)
                    if (words.length > 0) setKg(p => ({...p, mnemonic: words}))
                  }}/>
                <button className="btn btn-primary btn-full"
                  disabled={kg.mnemonic.length !== 24}
                  onClick={() => setKg(p=>({...p,step:'confirm'}))}>
                  Lanjutkan dengan Mnemonic Ini →
                </button>
                {kg.mnemonic.length > 0 && kg.mnemonic.length !== 24 &&
                  <p className="fld-err">Mnemonic harus tepat 24 kata (saat ini {kg.mnemonic.length})</p>
                }
              </div>
            )}
          </div>
        </div>
      )

      case 'confirm': return (
        <div className="kg-wrap">
          {renderStepProgress()}
          <div>
            <h2 className="t-section mb-3" style={{fontSize:20}}>Verifikasi Mnemonic</h2>
            <p className="t-sub mb-4">Masukkan kata ke-<strong style={{color:'#fff'}}>7</strong>, <strong style={{color:'#fff'}}>14</strong>, dan <strong style={{color:'#fff'}}>21</strong> untuk konfirmasi pencatatan kamu.</p>
            <div className="col gap-4" style={{maxWidth:360}}>
              {([
                {n:7,  k:'word7'  as const, err:'word7Err'  as const},
                {n:14, k:'word14' as const, err:'word14Err' as const},
                {n:21, k:'word21' as const, err:'word21Err' as const},
              ]).map(({n,k,err}) => (
                <div key={n} className="field">
                  <label className="fld-lbl">Kata ke-{n}</label>
                  <input className={`inp inp-mono${kg[err]?' inp-err':''}`} type="text"
                    value={kg[k]} placeholder="ketik kata di sini..."
                    autoFocus={n===7}
                    onChange={e => setKg(p => ({...p, [k]:e.target.value, [err]:''}))}
                    onKeyDown={e => e.key==='Enter' && n===21 && onConfirmWords()}/>
                  {kg[err] && <span className="fld-err">{kg[err]}</span>}
                </div>
              ))}
              <button className="btn btn-primary btn-full mt-2"
                disabled={!kg.word7.trim()||!kg.word14.trim()||!kg.word21.trim()}
                onClick={onConfirmWords}>
                Konfirmasi →
              </button>
            </div>
          </div>
        </div>
      )

      case 'passphrase': return (
        <div className="kg-wrap">
          {renderStepProgress()}
          <div>
            <h2 className="t-section mb-3" style={{fontSize:20}}>Set Passphrase</h2>
            <p className="t-sub mb-4">Passphrase melindungi keystore. Minimum 8 karakter. Tidak dapat dipulihkan — simpan bersama mnemonic.</p>
            <div className="col gap-4" style={{maxWidth:360}}>
              <div className="field">
                <label className="fld-lbl">Passphrase</label>
                <div className="inp-wrap">
                  <input className="inp" type={showPass?'text':'password'} value={kg.pass}
                    placeholder="Buat passphrase kuat..."
                    onChange={e => setKg(p => ({...p, pass:e.target.value, passErr:''}))}
                    autoFocus/>
                  <button className="inp-ico" onClick={() => setShowPass(v=>!v)}><IEye off={showPass}/></button>
                </div>
                <EntropyBar pass={kg.pass}/>
              </div>
              <div className="field">
                <label className="fld-lbl">Konfirmasi Passphrase</label>
                <input className={`inp${kg.passErr?' inp-err':''}`} type={showPass?'text':'password'}
                  value={kg.passConfirm} placeholder="Ulangi passphrase..."
                  onChange={e => setKg(p => ({...p, passConfirm:e.target.value, passErr:''}))}
                  onKeyDown={e => e.key==='Enter' && onNextPass()}/>
                {kg.passErr && <span className="fld-err">{kg.passErr}</span>}
              </div>
              <button className="btn btn-primary btn-full mt-2"
                disabled={kg.pass.length < 8}
                onClick={onNextPass}>
                Lanjutkan →
              </button>
            </div>
          </div>
        </div>
      )

      case 'genesis': return (
        <div className="kg-wrap">
          {renderStepProgress()}
          <div>
            <h2 className="t-section mb-3" style={{fontSize:20}}>Input Genesis Hash</h2>
            <p className="t-sub mb-4">Genesis hash mengikat Node ID ke jaringan spesifik. Testnet dan mainnet memiliki hash yang berbeda.</p>
            <div className="col gap-4" style={{maxWidth:480}}>
              <div className="field">
                <label className="fld-lbl">Genesis Hash (64 hex chars)</label>
                <input className={`inp inp-mono${kg.genesis.length>0&&kg.genesis.length!==64?' inp-err':''}`}
                  type="text" value={kg.genesis} placeholder="0000...0000 (64 karakter hexadecimal)"
                  onChange={e => setKg(p => ({...p, genesis: e.target.value.toLowerCase()}))}
                  autoFocus/>
                {kg.genesis.length > 0 && kg.genesis.length !== 64 &&
                  <span className="fld-err">Harus tepat 64 karakter ({kg.genesis.length}/64)</span>
                }
                <span className="fld-hint">
                  Dapatkan genesis hash di <button className="sidebar__link" style={{display:'inline',height:'auto',padding:0,fontSize:'inherit'}}
                    onClick={() => open('https://scalar.network/genesis')}>scalar.network/genesis</button>
                </span>
              </div>
              {kg.err && <div className="banner banner--error"><span className="banner__text">{kg.err}</span></div>}
              <button className="btn btn-primary btn-full"
                disabled={kg.genesis.length !== 64}
                onClick={onDeriveKeys}>
                Derive Keys &amp; Create Keystore →
              </button>
            </div>
          </div>
        </div>
      )

      case 'deriving': return (
        <div className="kg-wrap" style={{alignItems:'center',textAlign:'center'}}>
          {renderStepProgress()}
          <div style={{padding:'var(--s8) 0'}}>
            <div style={{width:64,height:64,margin:'0 auto var(--s5)',position:'relative'}}>
              <div style={{position:'absolute',inset:0,border:'2px solid #FFFFFF20',borderRadius:'50%'}}/>
              <div style={{position:'absolute',inset:0,border:'2px solid transparent',borderTopColor:'#FFFFFF',borderRadius:'50%',animation:'spin 1s linear infinite'}}/>
            </div>
            <h2 className="t-section mb-3" style={{fontSize:20}}>Deriving Keys...</h2>
            <p className="t-sub mb-5">NodeID via BLAKE3 + NodeKey via Argon2id 64 MB (~30 detik)</p>
            {ram && (
              <p style={{fontSize:12,color:'#52525B',fontFamily:'var(--mono)'}}>
                RAM tersedia: {(ram.available_mb/1024).toFixed(1)} GB
              </p>
            )}
            <div className="callout callout--warn mt-4" style={{textAlign:'left',maxWidth:400,margin:'var(--s5) auto 0'}}>
              ⚠ Jangan tutup aplikasi ini selama proses berlangsung.
            </div>
          </div>
        </div>
      )

      case 'complete': {
        const r = kg.result!
        return (
          <div className="kg-wrap">
            {renderStepProgress()}
            <div className="banner banner--success">
              <ICheck/>
              <span className="banner__text">Node identity berhasil dibuat dan siap untuk deployment.</span>
            </div>
            <div className="col gap-4">
              <ResultCard
                title="Encrypted Keystore"
                sub="Deploy ini ke VPS kamu melalui tab Deploy"
                value={r.keystore_b64}
                readonly={false}/>
              <ResultCard
                title="Node ID"
                sub="Daftarkan ID ini ke jaringan Scalar"
                value={r.node_id_hex}
                readonly={false}/>
              <ResultCard
                title="Wallet Address"
                sub="Reward node akan dikirim ke alamat ini"
                value={r.wallet_address}
                readonly={true}
                notice="READ-ONLY — Gunakan Scalar Wallet App untuk mengelola koin"/>
            </div>
            <hr className="divider"/>
            <div>
              <h3 className="t-section mb-3">What's next?</h3>
              <p className="t-sub mb-4">Pergi ke tab Deploy untuk menginstall node ini ke VPS kamu.</p>
              <div className="row gap-3">
                <button className="btn btn-primary btn-lg flex-1"
                  onClick={() => { setAppView('deploy') }}>
                  Open Deploy Tab →
                </button>
                <button className="btn btn-ghost"
                  onClick={() => setModal({
                    title:'Reset Keygen?',
                    body:'Ini akan menghapus semua hasil keygen saat ini.',
                    onConfirm: resetKeygen
                  })}>
                  Mulai Baru
                </button>
              </div>
            </div>
          </div>
        )
      }

      default: return null
    }
  }

  const ResultCard = ({ title, sub, value, readonly, notice }:
    { title:string; sub:string; value:string; readonly:boolean; notice?:string }) => {
    const [copied, copy] = useCopy()
    return (
      <div className="result-card">
        <div className="result-card__header">
          <div>
            <div className="result-card__title">{title}</div>
            <div className="result-card__sub">{sub}</div>
          </div>
          <div className="row gap-2">
            {readonly && <span className="readonly-badge">READ-ONLY</span>}
            <button className={`copy-btn${copied?' copy-btn--ok':''}`} onClick={() => copy(value)}>
              {copied ? <><ICheck/> Disalin</> : <><ICopy/> Salin</>}
            </button>
          </div>
        </div>
        <div className={`result-card__value${readonly?' result-card__value--readonly':''}`}>
          {value.length > 80 ? value.substring(0,80)+'...' : value}
        </div>
        {notice && <p style={{fontSize:11,color:'#71717A',marginTop:'var(--s1)'}}>{notice}</p>}
      </div>
    )
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER: SERVER LIST (shared)
  // ═══════════════════════════════════════════════════════════════
  const renderServerCard = (sv: Server, onSelect: (sv:Server)=>void, activeId?: string) => (
    <div key={sv.id} className={`server-card${activeId===sv.id?' server-card--active':''}`}>
      {editSvId === sv.id ? (
        <div className="server-card__edit-panel">
          <div className="col gap-4">
            <div className="field">
              <label className="fld-lbl">Label</label>
              <input className="inp" type="text" value={editForm.label} autoFocus
                onChange={e => setEditForm(p=>({...p,label:e.target.value}))}/>
            </div>
            <div className="field">
              <label className="fld-lbl">IP / Host</label>
              <input className="inp inp-mono" type="text" value={editForm.host}
                onChange={e => setEditForm(p=>({...p,host:e.target.value}))}/>
            </div>
            <div className="field">
              <label className="fld-lbl">Username</label>
              <input className="inp" type="text" value={editForm.username}
                onChange={e => setEditForm(p=>({...p,username:e.target.value}))}/>
            </div>
            <div className="field">
              <label className="fld-lbl">SSH Key Path</label>
              <div className="inp-wrap">
                <input className="inp inp-mono" type="text" value={editForm.keyPath}
                  onChange={e => setEditForm(p=>({...p,keyPath:e.target.value}))}/>
                <button className="inp-ico" onClick={pickEditKeyFile}><IFolder/></button>
              </div>
            </div>
            <div className="server-card__edit-footer">
              <button className="btn btn-ghost btn-sm" onClick={() => setEditSvId(null)}>Batal</button>
              <button className="btn btn-primary btn-sm"
                disabled={!editForm.label.trim()||!editForm.host.trim()}
                onClick={updateServer}>Simpan</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="server-card__body" onClick={() => onSelect(sv)}>
          <div className="server-card__info">
            <span className="server-card__name">{sv.label}</span>
            <span className="server-card__host">{sv.host}</span>
            <span className="server-card__user">{sv.username}@{sv.host}</span>
          </div>
          <div className="server-card__actions">
            <button className="icon-btn" title="Edit"
              onClick={e => { e.stopPropagation(); setEditForm({label:sv.label,host:sv.host,username:sv.username,keyPath:sv.keyPath}); setEditSvId(sv.id) }}>
              <IEdit/>
            </button>
            <button className="icon-btn icon-btn--danger" title="Hapus"
              onClick={e => { e.stopPropagation(); setModal({
                title:'Hapus Server?',
                body:`Server "${sv.label}" akan dihapus dari daftar. Aksi ini tidak dapat dibatalkan.`,
                onConfirm: () => deleteServer(sv.id)
              }) }}>
              <ITrash/>
            </button>
          </div>
        </div>
      )}
    </div>
  )

  const renderAddServerForm = (onClose: ()=>void) => (
    <div className="add-server-form">
      <h3 className="t-section">Tambah Server</h3>
      <div className="field">
        <label className="fld-lbl">Label</label>
        <input className="inp" type="text" value={srvForm.label} placeholder="scalar-node-1" autoFocus
          onChange={e => setSrvForm(p=>({...p,label:e.target.value}))}/>
      </div>
      <div className="field">
        <label className="fld-lbl">IP Address / Host</label>
        <input className="inp inp-mono" type="text" value={srvForm.host} placeholder="132.145.39.75"
          onChange={e => setSrvForm(p=>({...p,host:e.target.value}))}/>
      </div>
      <div className="field">
        <label className="fld-lbl">Username</label>
        <input className="inp" type="text" value={srvForm.username}
          onChange={e => setSrvForm(p=>({...p,username:e.target.value}))}/>
      </div>
      <div className="field">
        <label className="fld-lbl">SSH Key Path</label>
        <div className="inp-wrap">
          <input className="inp inp-mono" type="text" value={srvForm.keyPath}
            placeholder="C:\Users\HOPEX\.ssh\scalar-node.key"
            onChange={e => setSrvForm(p=>({...p,keyPath:e.target.value}))}/>
          <button className="inp-ico" onClick={pickKeyFile}><IFolder/></button>
        </div>
      </div>
      <div className="add-server-form__footer">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Batal</button>
        <button className="btn btn-primary btn-sm"
          disabled={!srvForm.label.trim()||!srvForm.host.trim()}
          onClick={addServer}>Simpan Server</button>
      </div>
    </div>
  )

  // ═══════════════════════════════════════════════════════════════
  // RENDER: DEPLOY TAB
  // ═══════════════════════════════════════════════════════════════
  const renderDeploy = () => {
    if (showAddSrv) return (
      <div style={{maxWidth:520}}>
        <h1 className="t-display mb-5">Deploy Node to VPS</h1>
        {renderAddServerForm(() => setShowAddSrv(false))}
      </div>
    )
    return (
      <div>
        <h1 className="t-display mb-2">Deploy Node to VPS</h1>
        <p className="t-sub mb-5">Configure your server and deploy the scalar-node binary.</p>
        <div className="deploy-layout">
          {/* Left: Server Management */}
          <div className="deploy-left">
            <div className="section-heading">
              <span className="section-title">VPS Servers</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAddSrv(true)}>
                + Add Server
              </button>
            </div>
            {servers.length === 0 ? (
              <div className="empty-state" style={{minHeight:200}}>
                <IServer/><div className="empty-state__title">No servers configured</div>
                <div className="empty-state__sub">Add a VPS server to get started</div>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowAddSrv(true)}>+ Add Your First Server</button>
              </div>
            ) : (
              <div className="col gap-2">
                {servers.map(sv => renderServerCard(sv, selectServer, selServer?.id))}
              </div>
            )}
          </div>

          {/* Right: Deploy Config */}
          <div className="deploy-right">
            <div className="log-panel" style={{flex:'none',marginBottom:'var(--s4)'}}>
              <div style={{padding:'var(--s5)',display:'flex',flexDirection:'column',gap:'var(--s4)'}}>
                <div className="deploy-form">
                  <div className="field">
                    <label className="fld-lbl">Encrypted Keystore (base64)</label>
                    <textarea className="inp ta inp-mono" rows={3} value={dp.keystore}
                      placeholder="Paste keystore dari tab Keygen atau dari file..."
                      onChange={e => setDp(p=>({...p,keystore:e.target.value}))}/>
                  </div>
                  <div className="field">
                    <label className="fld-lbl">Passphrase</label>
                    <div className="inp-wrap">
                      <input className="inp" type={showDpPass?'text':'password'} value={dp.pass}
                        placeholder="Keystore passphrase"
                        onChange={e => setDp(p=>({...p,pass:e.target.value}))}/>
                      <button className="inp-ico" onClick={() => setShowDpPass(v=>!v)}><IEye off={showDpPass}/></button>
                    </div>
                  </div>
                  <div className="field">
                    <label className="fld-lbl">Genesis Hash</label>
                    <input className="inp inp-mono" type="text" value={dp.genesis} placeholder="64-char hex"
                      onChange={e => setDp(p=>({...p,genesis:e.target.value}))}/>
                  </div>
                  <div>
                    <div className="coll-hdr" onClick={() => setDp(p=>({...p,peersOpen:!p.peersOpen}))}>
                      <span>Bootstrap Peers ({dp.peers.split('\n').filter(Boolean).length})</span>
                      <IChev open={dp.peersOpen}/>
                    </div>
                    <div className={`coll-body${dp.peersOpen?' open':' closed'}`}>
                      <textarea className="inp ta inp-mono" rows={4} value={dp.peers}
                        placeholder="132.145.39.75:17777&#10;140.238.72.52:17777"
                        onChange={e => setDp(p=>({...p,peers:e.target.value}))}/>
                    </div>
                  </div>

                  <div className="row gap-2">
                    <button className="btn btn-ghost btn-sm"
                      disabled={!selServer||dp.connSt==='testing'} onClick={onTestConn}>
                      {dp.connSt==='testing'?<><div className="btn-spinner"/>Testing...</>:'Test Koneksi'}
                    </button>
                    {dp.connSt==='ok' && <span style={{fontSize:12,color:'#00E676',display:'flex',alignItems:'center',gap:4}}><ICheck/>{dp.connMsg}</span>}
                    {dp.connSt==='err' && <span style={{fontSize:12,color:'#FF1744'}}>{dp.connMsg}</span>}
                  </div>

                  <button className="btn btn-primary btn-full btn-lg"
                    disabled={!selServer||!dp.keystore||!dp.pass||dp.deplSt==='deploying'}
                    onClick={onDeploy}>
                    {dp.deplSt==='deploying' ? <><div className="btn-spinner"/>Deploying...</>
                     : dp.deplSt==='done'    ? <><ICheck/> Deployed</>
                     : dp.deplSt==='error'   ? 'Retry Deploy'
                     : '▶  Deploy Node'}
                  </button>
                </div>
              </div>
            </div>

            {/* Log panel */}
            <div className="log-panel" style={{minHeight:200}}>
              <div className="log-panel__header">
                <span className="log-panel__title">Deployment Log</span>
                {dp.logs.length > 0 && <span className="log-panel__count">{dp.logs.length} lines</span>}
              </div>
              <div className="log-panel__body" ref={logRef}>
                {dp.logs.length === 0
                  ? <div className="log-panel__empty">Log output akan muncul di sini...</div>
                  : dp.logs.map((l,i) => (
                    <div key={i} className={`log-line log-line--${l.type}`}>
                      <span className="log-line__pfx">{l.type==='cmd'?'$':l.type==='ok'?'✓':l.type==='err'?'✗':'›'}</span>
                      <span className="log-line__txt">{l.text}</span>
                    </div>
                  ))
                }
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER: MANAGE TAB
  // ═══════════════════════════════════════════════════════════════
  const isActing = mg.action !== 'idle'

  const statusChipClass = (s: NodeStatus) => {
    if (s==='active') return 'chip-active'
    if (s==='inactive') return 'chip-warning'
    if (s==='failed') return 'chip-error'
    return 'chip-unknown'
  }

  const renderManage = () => {
    if (showAddSrv) return (
      <div style={{maxWidth:520}}>
        <h1 className="t-display mb-5">Manage Nodes</h1>
        {renderAddServerForm(() => setShowAddSrv(false))}
      </div>
    )
    return (
      <div>
        <h1 className="t-display mb-5">Manage Nodes</h1>
        <div className="manage-layout">
          {/* Left: Server list */}
          <div className="manage-left">
            <div className="section-heading">
              <span className="section-title">Your Nodes ({servers.length})</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAddSrv(true)}>+ Add</button>
            </div>
            {servers.length === 0 ? (
              <div className="empty-state" style={{minHeight:160}}>
                <IGrid/><div className="empty-state__title">No servers configured</div>
                <div className="empty-state__sub">Add a server to start managing nodes</div>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowAddSrv(true)}>+ Add Server</button>
              </div>
            ) : (
              <div className="col gap-2">
                {servers.map(sv => renderServerCard(sv, (sv) => {
                  selectServer(sv)
                  setMg(p => ({...p, status:'idle', logs:'', logsVisible:false, err:''}))
                }, selServer?.id))}
              </div>
            )}
          </div>

          {/* Right: Control + monitoring */}
          <div className="manage-right">
            {!selServer ? (
              <div className="empty-state">
                <div className="empty-state__icon"><IGrid /></div>
                <div className="empty-state__title">Select a server</div>
                <div className="empty-state__sub">Choose a server from the list to view node status</div>
              </div>
            ) : (
              <>
                {/* Status + controls */}
                <div className="card">
                  <div className="row gap-4 mb-4" style={{justifyContent:'space-between'}}>
                    <div>
                      {mg.status !== 'idle' && (
                        <span className={`status-chip ${statusChipClass(mg.status)}`}>
                          <span className="status-chip__dot"/>
                          {mg.status.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <button className="btn btn-ghost btn-sm" disabled={mg.statusLoading||isActing} onClick={onGetStatus}>
                      {mg.statusLoading ? <><div className="btn-spinner"/>Checking...</> : 'Refresh Status'}
                    </button>
                  </div>
                  <div className="node-controls">
                    <button className="btn btn-ghost flex-1" disabled={isActing} onClick={onStartNode}>
                      {mg.action==='starting'?<><div className="btn-spinner"/>Starting...</>:'▶ Start Node'}
                    </button>
                    <button className="btn btn-ghost flex-1" disabled={isActing} onClick={onStopNode}>
                      {mg.action==='stopping'?<><div className="btn-spinner"/>Stopping...</>:'■ Stop Node'}
                    </button>
                    <button className="btn btn-ghost flex-1" disabled={isActing} onClick={onGetLogs}>
                      {mg.action==='fetching_logs'?<><div className="btn-spinner"/>Fetching...</>:'View Logs'}
                    </button>
                  </div>
                  <div style={{borderTop:'1px solid var(--bdr-subtle)',marginTop:'var(--s4)',paddingTop:'var(--s4)'}}>
                    <p style={{fontSize:11,color:'#52525B',marginBottom:'var(--s3)'}}>
                      Reset menghapus instalasi lama dan rebuild dari awal (~5-10 menit). Deploy ulang keystore setelahnya.
                    </p>
                    <button className="btn btn-danger btn-full" disabled={isActing}
                      onClick={() => setModal({
                        title:'Reset & Rebuild VPS?',
                        body:`Ini akan menghentikan service, menghapus scalar-core, dan rebuild dari source untuk "${selServer.label}". Proses ~5-10 menit.`,
                        onConfirm: onResetVps
                      })}>
                      {mg.action==='resetting'?<><div className="btn-spinner"/>Resetting VPS...</>:'Reset & Rebuild VPS'}
                    </button>
                  </div>
                  {mg.err && <div className="banner banner--error mt-4"><span className="banner__text">{mg.err}</span></div>}
                </div>

                {/* Default Layer: Radar + Summary */}
                {!expertMode && (
                  <>
                    <div className="radar-container">
                      <svg className="radar-svg" width="280" height="280" viewBox="0 0 280 280">
                        <circle cx="140" cy="140" r="50"  fill="none" stroke="#27272A" strokeWidth="1"/>
                        <circle cx="140" cy="140" r="90"  fill="none" stroke="#27272A" strokeWidth="1"/>
                        <circle cx="140" cy="140" r="128" fill="none" stroke="#27272A" strokeWidth="1"/>
                        <line x1="12"  y1="140" x2="268" y2="140" stroke="#27272A" strokeWidth="1"/>
                        <line x1="140" y1="12"  x2="140" y2="268" stroke="#27272A" strokeWidth="1"/>
                        <line x1="140" y1="12" x2="268" y2="140" stroke="#27272A" strokeWidth="0.5" transform="rotate(45,140,140)"/>
                        <line x1="140" y1="12" x2="268" y2="140" stroke="#27272A" strokeWidth="0.5" transform="rotate(-45,140,140)"/>
                        {/* Sweep */}
                        <path d="M140 140 L140 12" stroke="#FFFFFF08" strokeWidth="2" className="radar-sweep-line" style={{transformOrigin:'140px 140px',animation:'spin 4s linear infinite'}}/>
                        {/* Center */}
                        <circle cx="140" cy="140" r="6" fill="#FFFFFF" className="radar-center-dot"/>
                        {/* Peers */}
                        <circle cx="175" cy="82"  r="4" fill="#FFFFFF" className="radar-peer-1"/>
                        <circle cx="97"  cy="108" r="4" fill="#FFFFFF" className="radar-peer-2"/>
                        <circle cx="194" cy="158" r="4" fill="#FFFFFF" className="radar-peer-3"/>
                        <circle cx="118" cy="192" r="4" fill="#FFFFFF" className="radar-peer-4"/>
                        <circle cx="208" cy="100" r="3" fill="#A1A1AA" opacity="0.5" className="radar-peer-1"/>
                        <circle cx="75"  cy="165" r="3" fill="#A1A1AA" opacity="0.5" className="radar-peer-3"/>
                      </svg>
                      <p style={{fontSize:11,color:'#52525B',fontFamily:'var(--mono)'}}>P2P Network Visualization</p>
                    </div>
                    <div className="summary-card">
                      <div className="summary-row">
                        <span className="summary-row__label">Status</span>
                        <span className="summary-row__value" style={{color: mg.status==='active'?'#00E676': mg.status==='inactive'?'#FFD600':'#A1A1AA'}}>
                          {mg.status === 'active' ? 'Securely Connected' : mg.status === 'inactive' ? 'Offline' : mg.status === 'idle' ? '—' : mg.status.charAt(0).toUpperCase()+mg.status.slice(1)}
                        </span>
                      </div>
                      <div className="summary-row">
                        <span className="summary-row__label">Uptime</span>
                        <span className="summary-row__value">—</span>
                      </div>
                      <div className="summary-row">
                        <span className="summary-row__label">Node Score</span>
                        <span className="summary-row__value">—</span>
                      </div>
                    </div>
                  </>
                )}

                {/* Expert Layer */}
                {expertMode && (
                  <>
                    <div className="topology-container">
                      <div className="topology-header">P2P Topology Map</div>
                      <svg width="100%" height="280" viewBox="0 0 600 280" style={{background:'#111114'}}>
                        {/* Connections */}
                        <line x1="300" y1="140" x2="160" y2="70"  stroke="#3F3F46" strokeWidth="1" strokeDasharray="4,2"/>
                        <line x1="300" y1="140" x2="440" y2="70"  stroke="#3F3F46" strokeWidth="1" strokeDasharray="4,2"/>
                        <line x1="300" y1="140" x2="120" y2="180" stroke="#3F3F46" strokeWidth="1" strokeDasharray="4,2"/>
                        <line x1="300" y1="140" x2="480" y2="180" stroke="#3F3F46" strokeWidth="1" strokeDasharray="4,2"/>
                        <line x1="300" y1="140" x2="300" y2="230" stroke="#3F3F46" strokeWidth="1" strokeDasharray="4,2"/>
                        {/* Self node */}
                        <circle cx="300" cy="140" r="12" fill="#FFFFFF"/>
                        <text x="300" y="165" textAnchor="middle" fontSize="10" fill="#A1A1AA" fontFamily="JetBrains Mono, monospace">SELF</text>
                        {/* Peers */}
                        {[
                          [160,70,'a3f2..'], [440,70,'7c89..'], [120,180,'2b45..'],
                          [480,180,'9e12..'], [300,230,'5f67..']
                        ].map(([x,y,id]) => (
                          <g key={String(id)}>
                            <circle cx={Number(x)} cy={Number(y)} r="7" fill="#3F3F46" stroke="#52525B" strokeWidth="1"/>
                            <text x={Number(x)} y={Number(y)+18} textAnchor="middle" fontSize="9" fill="#52525B" fontFamily="JetBrains Mono, monospace">{String(id)}</text>
                          </g>
                        ))}
                      </svg>
                    </div>

                    <div className="metrics-grid">
                      {[
                        {label:'LATENCY (PING)', value:'24 ms', sub:'avg last 60s'},
                        {label:'PACKET LOSS',    value:'0.02%', sub:'last epoch'},
                        {label:'THROUGHPUT ↑',   value:'1.2 MB/s', sub:'outbound'},
                        {label:'THROUGHPUT ↓',   value:'0.8 MB/s', sub:'inbound'},
                        {label:'INBOUND PEERS',  value:'14', sub:'connected'},
                        {label:'OUTBOUND PEERS', value:'8',  sub:'established'},
                        {label:'ROUTING TABLE',  value:'128', sub:'entries'},
                        {label:'EPOCH',          value:'—', sub:'current'},
                      ].map(({label,value,sub}) => (
                        <div key={label} className="metric-cell">
                          <span className="metric-cell__label">{label}</span>
                          <span className="metric-cell__value">{value}</span>
                          <span className="metric-cell__sub">{sub}</span>
                        </div>
                      ))}
                    </div>

                    <div className={`console-panel${expertMode?' console-panel--open':' console-panel--closed'}`}>
                      <div className="console-header">LIVE CONSOLE LOG</div>
                      <div className="console-body">
                        {mg.mgLogs.length === 0 && mg.logs === '' ? (
                          <span className="t-console">No log data. Run an action to see output.</span>
                        ) : mg.mgLogs.map((l,i) => (
                          <div key={i} className={`log-line log-line--${l.type}`}>
                            <span className="log-line__pfx">{l.type==='ok'?'✓':l.type==='err'?'✗':'›'}</span>
                            <span className="log-line__txt">{l.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {/* Logs viewer */}
                {mg.logsVisible && (
                  <div className="log-panel">
                    <div className="log-panel__header">
                      <span className="log-panel__title">NODE LOGS (last 100 lines)</span>
                      <button className="btn btn-ghost btn-sm" onClick={() => setMg(p=>({...p,logsVisible:false}))}>Tutup</button>
                    </div>
                    <div className="log-panel__body" style={{maxHeight:300}}>
                      {mg.action==='fetching_logs'
                        ? <div className="log-panel__empty"><div className="btn-spinner"/>Loading...</div>
                        : <pre style={{fontFamily:'var(--mono)',fontSize:11,color:'#71717A',whiteSpace:'pre-wrap',wordBreak:'break-all',lineHeight:1.8}}>
                            {mg.logs || 'No logs available.'}
                          </pre>
                      }
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER: INFO TAB
  // ═══════════════════════════════════════════════════════════════
  const INFO_TOPICS = [
    { title:'Mnemonic',        icon:'🔑' },
    { title:'Node ID',         icon:'🆔' },
    { title:'Keystore',        icon:'🔒' },
    { title:'Passphrase',      icon:'🔐' },
    { title:'Genesis Hash',    icon:'#️⃣' },
    { title:'NodeScore',       icon:'📊' },
    { title:'Complete Flow',   icon:'🗺️' },
  ]
  const INFO_CONTENT: Record<number, { icon: string; title: string; body: React.ReactElement }> = {
    0: { icon:'🔑', title:'Mnemonic', body: (
      <div className="info-content__body">
        <p>Mnemonic adalah 24 kata yang berfungsi sebagai kunci utama node dan wallet kamu. Kata pertama selalu <span className="info-mono">scalar</span>, diikuti 23 kata BIP-39 acak (253-bit entropy).</p>
        <div className="info-content__callout">
          Simpan offline — jangan difoto atau disimpan secara digital. Tanpa mnemonic, Node ID dan wallet tidak dapat dibuat ulang.
        </div>
        <p>Mnemonic ini <strong>tidak pernah disimpan</strong> oleh aplikasi. Ini hanya ada di memori selama proses keygen, lalu hilang setelah aplikasi ditutup.</p>
        <p>Entropi 253-bit memberikan perlindungan 126.5-bit terhadap komputer kuantum (melebihi threshold 128-bit).</p>
      </div>
    )},
    1: { icon:'🆔', title:'Node ID', body: (
      <div className="info-content__body">
        <p>Node ID adalah identitas unik node kamu di jaringan Scalar, direpresentasikan sebagai string hex 64 karakter.</p>
        <div className="info-content__callout">
          Derivasi: <span className="info-mono">BLAKE3(b"scalar_nodeid" || mnemonic || genesis_hash)</span> — instan, kurang dari 1 ms.
        </div>
        <p>Properti kunci: input yang sama selalu menghasilkan Node ID yang sama (deterministik). Tidak bisa dibalik ke mnemonic (one-way function).</p>
        <p>Satu mnemonic menghasilkan satu Node ID. Untuk menjalankan beberapa node, kamu memerlukan beberapa mnemonic yang berbeda.</p>
      </div>
    )},
    2: { icon:'🔒', title:'Keystore', body: (
      <div className="info-content__body">
        <p>Keystore adalah file 121 bytes terenkripsi yang menyimpan Node ID dan Node Key kamu. File ini yang dikirim ke VPS untuk menjalankan node.</p>
        <div className="info-content__callout">
          Aman dikirim via SSH — tanpa passphrase yang benar, file ini tidak dapat dibuka. Node Key di dalamnya tidak sama dengan SpendKey (koin tetap aman jika VPS dikompromis).
        </div>
        <p>Format: <span className="info-mono">version(1) + kdf_salt(16) + nonce(24) + ciphertext(80)</span> = 121 bytes total. Enkripsi menggunakan Argon2id 64MB + XChaCha20-Poly1305.</p>
      </div>
    )},
    3: { icon:'🔐', title:'Passphrase', body: (
      <div className="info-content__body">
        <p>Passphrase melindungi keystore di disk. Diperlukan setiap kali node dijalankan untuk membuka keystore. Minimum 8 karakter.</p>
        <div className="info-content__callout callout--warn">
          Passphrase tidak dapat dipulihkan — simpan bersama mnemonic di tempat aman. Jika lupa, kamu harus membuat keystore baru dari mnemonic yang sama.
        </div>
        <p>Kekuatan passphrase sangat penting. Tanggal lahir (contoh: 01011990) memiliki entropi ~13 bit dan dapat ditebak dalam hitungan menit meski dilindungi Argon2id. Gunakan passphrase random minimal 12 karakter.</p>
      </div>
    )},
    4: { icon:'#️⃣', title:'Genesis Hash', body: (
      <div className="info-content__body">
        <p>Genesis hash adalah 64-karakter hex dari blok genesis jaringan Scalar. Hash ini mengikat Node ID kamu ke jaringan yang spesifik.</p>
        <div className="info-content__callout">
          Testnet dan mainnet memiliki genesis hash yang berbeda. Menggunakan genesis hash yang salah akan menghasilkan Node ID yang berbeda, dan node tidak akan bisa bergabung ke jaringan.
        </div>
        <p>Dapatkan genesis hash resmi di <strong>scalar.network/genesis</strong>. Jangan gunakan nilai yang tidak terverifikasi.</p>
      </div>
    )},
    5: { icon:'📊', title:'NodeScore', body: (
      <div className="info-content__body">
        <p>NodeScore adalah skor performa node (0–1.000.000) yang ditentukan oleh tiga faktor: uptime, alignment root, dan longevity.</p>
        <div className="info-content__callout">
          Node dengan NodeScore di atas 800.000 eligible untuk peran agregator jaringan dan memiliki Governance Power penuh (cap 1.000.000). Node di bawah threshold dibatasi Governance Power hingga 200.000.
        </div>
        <p>NodeScore meningkat seiring waktu node berjalan dengan konsisten. Restarting atau downtime yang sering akan menurunkan skor secara signifikan melalui komponen longevity.</p>
      </div>
    )},
    6: { icon:'🗺️', title:'Complete Usage Flow', body: (
      <div className="info-content__body">
        <p>Tiga langkah utama untuk menjalankan node Scalar:</p>
        <div className="flow-diagram">
          <div className="flow-step">
            <div className="flow-step__num">1</div>
            <div className="flow-step__label">KEYGEN</div>
          </div>
          <span className="flow-arrow">→</span>
          <div className="flow-step">
            <div className="flow-step__num">2</div>
            <div className="flow-step__label">DEPLOY</div>
          </div>
          <span className="flow-arrow">→</span>
          <div className="flow-step">
            <div className="flow-step__num">3</div>
            <div className="flow-step__label">MANAGE</div>
          </div>
        </div>
        <p><strong>1. Keygen</strong> — Generate mnemonic 24 kata, konfirmasi 3 titik, set passphrase, masukkan genesis hash. Keystore terenkripsi dan wallet address siap.</p>
        <p><strong>2. Deploy</strong> — Pilih server VPS, paste keystore, masukkan passphrase dan genesis hash, lalu deploy. Scalar node berjalan sebagai systemd service.</p>
        <p><strong>3. Manage</strong> — Pantau status node, lihat log, start/stop, atau reset VPS jika diperlukan sebelum deploy ulang.</p>
        <div className="info-content__callout">
          Mnemonic tidak pernah meninggalkan perangkat kamu. Hanya keystore (121 bytes terenkripsi) yang dikirim ke VPS via SSH.
        </div>
      </div>
    )},
  }

  const renderInfo = () => (
    <div>
      <h1 className="t-display mb-2">Node Operator Guide</h1>
      <p className="t-sub mb-6">Essential concepts for running a Scalar node.</p>
      <div className="info-layout">
        <nav className="info-nav">
          {INFO_TOPICS.map((t, i) => (
            <button key={i} className={`info-nav__item${infoTopic===i?' info-nav__item--active':''}`}
              onClick={() => setInfoTopic(i)}>
              {t.title}
            </button>
          ))}
        </nav>
        <div className="info-content">
          <div className="info-content__icon" style={{fontSize:48}}>{INFO_CONTENT[infoTopic]?.icon}</div>
          <h2 className="info-content__title">{INFO_CONTENT[infoTopic]?.title}</h2>
          <hr className="divider"/>
          {INFO_CONTENT[infoTopic]?.body}
        </div>
      </div>
    </div>
  )

  // ═══════════════════════════════════════════════════════════════
  // RENDER: SETTINGS TAB
  // ═══════════════════════════════════════════════════════════════
  const renderSettings = () => (
    <div>
      <h1 className="t-display mb-6">Settings</h1>
      <div className="settings-layout">
        <div className="settings-card">
          <div className="settings-card__header">
            <IGear/><span className="settings-card__title">Deployment Configuration</span>
          </div>
          <div className="settings-card__body">
            <div className="settings-row">
              <div className="settings-row__info">
                <span className="settings-row__label">SSH Deployment Mode</span>
                <span className="settings-row__sub">Local SSH key used for server access</span>
              </div>
              <select className="inp" style={{width:160}}>
                <option>Local SSH</option>
              </select>
            </div>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card__header">
            <IInfo/><span className="settings-card__title">About</span>
          </div>
          <div className="settings-card__body">
            <div className="settings-row">
              <div className="settings-row__info">
                <span className="settings-row__label" style={{color:'#A1A1AA',fontSize:12}}>Version</span>
              </div>
              <span style={{fontFamily:'var(--mono)',fontSize:12,color:'#FFFFFF'}}>{appVersion}</span>
            </div>
            <div className="settings-row">
              <div className="settings-row__info">
                <span className="settings-row__label" style={{color:'#A1A1AA',fontSize:12}}>Official Website</span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => open('https://scalar.network')}>
                scalar.network <ILink/>
              </button>
            </div>
            <div className="settings-row">
              <div className="settings-row__info">
                <span className="settings-row__label" style={{color:'#A1A1AA',fontSize:12}}>Changelog</span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => open('https://github.com/scalarnetwork/scalar-node-desktop/releases')}>
                View Changelog <ILink/>
              </button>
            </div>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card__header">
            <IPower/><span className="settings-card__title">Application Control</span>
          </div>
          <div className="settings-card__body">
            <div className="settings-row" style={{alignItems:'flex-start',flexDirection:'column',gap:'var(--s3)'}}>
              <p style={{fontSize:12,color:'#71717A'}}>
                Gunakan ini sebelum menginstall versi baru. Semua proses akan dihentikan.
              </p>
              <button className="btn btn-danger" onClick={() => setModal({
                title:'Tutup Aplikasi?',
                body:'Semua proses akan dihentikan. Pastikan tidak ada operasi deploy atau reset yang sedang berjalan.',
                onConfirm: () => invoke('quit_app').catch(()=>{})
              })}>
                <IPower/> Tutup Aplikasi
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  // ═══════════════════════════════════════════════════════════════
  // RENDER: TOASTS + MODAL
  // ═══════════════════════════════════════════════════════════════
  const renderToasts = () => (
    <div className="toast-stack">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          <span className="toast__dot"/>
          <span style={{fontSize:13,flex:1}}>{t.text}</span>
        </div>
      ))}
    </div>
  )

  const renderModal = () => !modal ? null : (
    <div className="modal-backdrop" onClick={() => setModal(null)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3 className="modal__title">{modal.title}</h3>
        <p className="modal__body">{modal.body}</p>
        <div className="modal__footer">
          <button className="btn btn-ghost" onClick={() => setModal(null)}>Batal</button>
          <button className="btn btn-danger" onClick={() => { modal.onConfirm(); setModal(null) }}>Konfirmasi</button>
        </div>
      </div>
    </div>
  )

  // ═══════════════════════════════════════════════════════════════
  // MAIN RENDER
  // ═══════════════════════════════════════════════════════════════
  return (
    <div className="app-root">
      {renderSidebar()}
      <div className="app-body">
        {renderHeader()}
        <main className="content-area">
          {appView === 'keygen'   && renderKg()}
          {appView === 'deploy'   && renderDeploy()}
          {appView === 'manage'   && renderManage()}
          {appView === 'info'     && renderInfo()}
          {appView === 'settings' && renderSettings()}
        </main>
      </div>
      {renderToasts()}
      {renderModal()}
    </div>
  )
}