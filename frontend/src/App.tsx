import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import './App.css'

// ── Types ────────────────────────────────────────────────────────
type SelTier   = 'A' | 'C'
type KgStep = 'idle' | 'mnemonic' | 'confirm_word' | 'passphrase' | 'genesis' | 'deriving' | 'complete'
type ConnSt = 'idle' | 'testing' | 'ok' | 'err'
type DeplSt = 'idle' | 'deploying' | 'done' | 'error'

type AppView = 'method-select' | 'keygen' | 'deploy' | 'settings'
type Method  = 'ssh' | 'local'

interface Server {
  id: string; label: string; host: string
  username: string; keyPath: string
}

interface KgState {
  step: KgStep; mnemonic: string[]; revealed: boolean
  word7: string; word7Err: string
  word14: string; word14Err: string
  word21: string; word21Err: string
  pass: string; passConfirm: string; passErr: string
  genesis: string; keystore: string; err: string
}
interface DpState {
  host: string; user: string; keyPath: string
  keystore: string; pass: string; genesis: string
  peers: string; peersOpen: boolean; selNode: string
  connSt: ConnSt; connMsg: string
  deplSt: DeplSt; logs: LogLine[]
}
interface LogLine { type: 'cmd' | 'ok' | 'err' | 'inf'; text: string }
interface RamInfo { total_mb: number; available_mb: number }

// ── Constants ────────────────────────────────────────────────────
const PEERS = [
  '132.145.39.75:17777', '132.226.130.138:17777', '145.241.205.71:17777',
  '140.238.72.52:17777', '140.238.91.78:17777',
].join('\n')

const KG_STEPS: { key: KgStep; label: string }[] = [
  { key: 'idle',         label: 'Generate'   },
  { key: 'mnemonic',     label: 'Record'     },
  { key: 'confirm_word', label: 'Confirm'    },
  { key: 'passphrase',   label: 'Passphrase' },
  { key: 'genesis',      label: 'Genesis'    },
  { key: 'deriving',     label: 'Derive'     },
  { key: 'complete',     label: 'Complete'   },
]
const KG_ORDER: KgStep[] = KG_STEPS.map(s => s.key)
const TIER_A_SECS = 5400 // 90 min conservative estimate

// ── Icons (inline SVG) ──────────────────────────────────────────────
const IKey = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7.5" cy="15.5" r="5.5"/>
    <path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>
  </svg>
)
const IEye = ({ off }: { off?: boolean }) => off ? (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>
    <line x1="2" x2="22" y1="2" y2="22"/>
  </svg>
) : (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
)
const ICheck = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
)
const ICopy = ({ done }: { done?: boolean }) => done ? <ICheck /> : (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="14" height="14" x="8" y="8" rx="2"/>
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
  </svg>
)
const IAlert = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
    <line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/>
  </svg>
)
const IFolder = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
)
const IChev = ({ open }: { open: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}>
    <polyline points="6 9 12 15 18 9"/>
  </svg>
)

// ── App ──────────────────────────────────────────────────────────
export default function App() {
  const [showPass,  setShowPass]  = useState(false)
  const [showPassC,  setShowPassC]  = useState(false)
  const [appView,    setAppView]    = useState<AppView>('method-select')
  const [method,     setMethod]     = useState<Method>('ssh')
  const [appReady,   setAppReady]   = useState(false)
  const [appVersion, setAppVersion] = useState('—')
  const [servers,    setServers]    = useState<Server[]>([])
  const [selServer,  setSelServer]  = useState<Server | null>(null)
  const [showSrvFrm, setShowSrvFrm] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [srvForm,    setSrvForm]    = useState({ label:'', host:'', username:'ubuntu', keyPath:'' })
  const [selTier,    setSelTier]   = useState<SelTier>('A')
  const [copied,    setCopied]    = useState<Record<string, boolean>>({})
  const [kg, setKg] = useState<KgState>({
    step: 'idle', mnemonic: [], revealed: false,
    word7: '', word7Err: '', word14: '', word14Err: '', word21: '', word21Err: '',
    pass: '', passConfirm: '',
    passErr: '', genesis: '', keystore: '', err: '',
  })
  const [dp, setDp] = useState<DpState>({
    host: '', user: 'ubuntu', keyPath: '', keystore: '',
    pass: '', genesis: '', peers: PEERS, peersOpen: false, selNode: '',
    connSt: 'idle', connMsg: '', deplSt: 'idle', logs: [],
  })
  const logRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [ram,     setRam]     = useState<RamInfo | null>(null)
  const [elapsed, setElapsed] = useState(0)


  // ── Deploy log streaming ──────────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | null = null
    listen<{t: string; msg: string}>('deploy_log', event => {
      const { t, msg } = event.payload
      const type = t === 'ok' ? 'ok' : t === 'err' ? 'err' : t === 'cmd' ? 'cmd' : 'inf'
      setDp(p => ({ ...p, logs: [...p.logs, { type, text: msg }] }))
    }).then(fn => { unlisten = fn })
    return () => { if (unlisten) unlisten() }
  }, [])

  useEffect(() => {
    const fetchRam = async () => {
      try { setRam(await invoke<RamInfo>('get_system_ram')) } catch (_) {}
    }
    fetchRam()
    const id = setInterval(fetchRam, 5000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (kg.step === 'deriving') {
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [kg.step])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [dp.logs])

  // ── Helpers ───────────────────────────────────────────────────

  // ── Storage helpers ───────────────────────────────────────────
  const persistServers = async (list: Server[]) => {
    setServers(list)
    try { await invoke('save_servers', { data: JSON.stringify(list) }) } catch (_) {}
  }

  const addServer = async () => {
    if (!srvForm.label.trim() || !srvForm.host.trim()) return
    const srv: Server = { id: crypto.randomUUID(), ...srvForm }
    const list = [...servers, srv]
    await persistServers(list)
    setSelServer(srv)
    setDp(p => ({ ...p, host: srv.host, user: srv.username, keyPath: srv.keyPath, connSt:'idle', connMsg:'' }))
    setSrvForm({ label:'', host:'', username:'ubuntu', keyPath:'' })
    setShowSrvFrm(false)
  }

  const pickKeyFile = async () => {
    try {
      const selected = await invoke<string | null>('pick_ssh_key')
      if (selected) setSrvForm(p => ({ ...p, keyPath: selected }))
    } catch (_) {}
  }

  const deleteServer = async (id: string) => {
    const list = servers.filter(sv => sv.id !== id)
    await persistServers(list)
    if (selServer?.id === id) {
      const next = list[0] || null
      setSelServer(next)
      if (next) setDp(p => ({ ...p, host:next.host, user:next.username, keyPath:next.keyPath, connSt:'idle', connMsg:'' }))
      else setDp(p => ({ ...p, host:'', user:'ubuntu', keyPath:'', connSt:'idle', connMsg:'' }))
    }
  }

  const selectServer = (srv: Server) => {
    setSelServer(srv)
    setDp(p => ({ ...p, host:srv.host, user:srv.username, keyPath:srv.keyPath, connSt:'idle', connMsg:'' }))
  }

  const onChooseMethod = async (m: Method) => {
    setMethod(m)
    try { await invoke('save_setting', { key:'deployment_method', value:m }) } catch (_) {}
    setAppView('keygen')
  }

  const onSwitchMethod = async (m: Method) => {
    if (m === 'local') { setShowDialog(true); return }
    setMethod(m)
    try { await invoke('save_setting', { key:'deployment_method', value:m }) } catch (_) {}
  }


  const onChangeTier = async (t: SelTier) => {
    setSelTier(t)
    try { await invoke('save_setting', { key:'tier', value:t }) } catch (_) {}
  }

  // ── Init: load saved settings ──────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const saved = await invoke<string | null>('load_setting', { key:'deployment_method' })
        if (saved === 'ssh' || saved === 'local') {
          setMethod(saved as Method)
          setAppView('keygen')
        }
        const savedTier = await invoke<string | null>('load_setting', { key:'tier' })
        if (savedTier === 'A' || savedTier === 'C') setSelTier(savedTier as SelTier)
        try {
          const { getVersion } = await import('@tauri-apps/api/app')
          setAppVersion(await getVersion())
        } catch (_) {}
        const rawSrvs = await invoke<string>('load_servers')
        const srvList: Server[] = JSON.parse(rawSrvs)
        setServers(srvList)
        if (srvList.length > 0) {
          setSelServer(srvList[0])
          setDp(p => ({ ...p, host:srvList[0].host, user:srvList[0].username, keyPath:srvList[0].keyPath }))
        }
      } catch (_) {}
      finally { setAppReady(true) }
    })()
  }, [])

  const fmtTime = (sec: number): string => {
    const h  = Math.floor(sec / 3600)
    const m  = Math.floor((sec % 3600) / 60)
    const sc = sec % 60
    const mm = String(m).padStart(2, '0')
    const ss = String(sc).padStart(2, '0')
    return h > 0 ? `${h}h ${mm}m ${ss}s` : `${mm}m ${ss}s`
  }

  const ramStatus = (r: RamInfo | null) => {
    if (!r) return null
    const gb = r.available_mb / 1024
    if (selTier === 'C') return { color:'var(--ok-t)', bg:'var(--ok-bg)', icon:'✅', label:`${gb.toFixed(1)} GB — cukup untuk Tier C` }
    if (gb >= 5) return { color:'var(--ok-t)', bg:'var(--ok-bg)', icon:'✅', label:`${gb.toFixed(1)} GB tersedia — cukup` }
    if (gb >= 4) return { color:'var(--wn-t)', bg:'var(--wn-bg)', icon:'⚠️', label:`${gb.toFixed(1)} GB — tutup aplikasi lain` }
    return       { color:'var(--er-t)', bg:'var(--er-bg)', icon:'❌', label:`${gb.toFixed(1)} GB — TIDAK CUKUP` }
  }

  const copy = (id: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(p => ({ ...p, [id]: true }))
    setTimeout(() => setCopied(p => ({ ...p, [id]: false })), 2000)
  }

  // ── Keygen handlers ───────────────────────────────────────────
  const onGenerate = async () => {
    try {
      const mnemonic: string[] = await invoke('generate_mnemonic_cmd')
      setKg(p => ({ ...p, step: 'mnemonic', mnemonic, revealed: false, err: '' }))
    } catch (e) { setKg(p => ({ ...p, err: String(e) })) }
  }
  const onCheckWords = () => {
    // Konfirmasi 3 kata: #7, #14, #21 — SCALAR-TECHNICAL §10.5
    const ok7  = kg.word7.trim().toLowerCase()  === kg.mnemonic[6]
    const ok14 = kg.word14.trim().toLowerCase() === kg.mnemonic[13]
    const ok21 = kg.word21.trim().toLowerCase() === kg.mnemonic[20]
    if (!ok7)  { setKg(p => ({ ...p, word7Err:  'Incorrect. Check your written copy.' })); return }
    if (!ok14) { setKg(p => ({ ...p, word14Err: 'Incorrect. Check your written copy.' })); return }
    if (!ok21) { setKg(p => ({ ...p, word21Err: 'Incorrect. Check your written copy.' })); return }
    setKg(p => ({ ...p, step: 'passphrase', word7Err: '', word14Err: '', word21Err: '' }))
  }
  const onNextPass = () => {
    if (kg.pass.length < 8) { setKg(p => ({ ...p, passErr: 'Minimum 8 characters.' })); return }
    if (kg.pass !== kg.passConfirm) { setKg(p => ({ ...p, passErr: 'Passphrases do not match.' })); return }
    setKg(p => ({ ...p, step: 'genesis', passErr: '' }))
  }
  const onDeriveKeys = async () => {
    setKg(p => ({ ...p, step: 'deriving', err: '' }))
    try {
      const keystore: string = await invoke('encrypt_keystore_cmd', {
        mnemonic: kg.mnemonic, passphrase: kg.pass, genesisHash: kg.genesis,
      })
      setKg(p => ({ ...p, step: 'complete', keystore }))
      setDp(p => ({ ...p, keystore, genesis: kg.genesis, pass: kg.pass }))
    } catch (e) { setKg(p => ({ ...p, step: 'genesis', err: String(e) })) }
  }

  // ── Deploy handlers ───────────────────────────────────────────
  const addLog = (type: LogLine['type'], text: string) =>
    setDp(p => ({ ...p, logs: [...p.logs, { type, text }] }))
  const onTestConn = async () => {
    setDp(p => ({ ...p, connSt: 'testing', connMsg: '' }))
    try {
      await invoke('test_ssh_connection', { host: dp.host, username: dp.user, keyPath: dp.keyPath })
      setDp(p => ({ ...p, connSt: 'ok', connMsg: 'Connection successful' }))
    } catch (e) { setDp(p => ({ ...p, connSt: 'err', connMsg: String(e) })) }
  }
  const onDeploy = async () => {
    setDp(p => ({ ...p, deplSt: 'deploying', logs: [] }))
    addLog('inf', `Deploying to ${dp.host}…`)
    try {
      await invoke('deploy_node', {
        host: dp.host, username: dp.user, keyPath: dp.keyPath,
        keystoreBase64: dp.keystore, passphrase: dp.pass, genesisHash: dp.genesis,
        dialPeers: dp.peers.split('\n').filter(Boolean),
      })
      addLog('ok', 'Node deployed and service started.')
      setDp(p => ({ ...p, deplSt: 'done' }))
    } catch (e) { addLog('err', String(e)); setDp(p => ({ ...p, deplSt: 'error' })) }
  }

  // ── Step indicator ────────────────────────────────────────────
  const curIdx = KG_ORDER.indexOf(kg.step)


  // ── Screen 0: Method Selection ────────────────────────────────

  // ── Sidebar ───────────────────────────────────────────────────
  const renderSidebar = () => (
    <nav className="sidebar">
      <div className="sidebar__logo" data-tauri-drag-region>
        <svg width="24" height="24" viewBox="0 0 24 24" className="logo-sym">
          <rect x="1"   y="3" width="3" height="18" rx=".5" fill="currentColor"/>
          <rect x="5"   y="3" width="3" height="18" rx=".5" fill="currentColor"/>
          <rect x="9.5" y="7" width="5" height="10" rx=".5" fill="currentColor"/>
          <rect x="16"  y="3" width="3" height="18" rx=".5" fill="currentColor"/>
          <rect x="20"  y="3" width="3" height="18" rx=".5" fill="currentColor"/>
        </svg>
        <span className="sidebar__logo-txt">SCALAR</span>
      </div>
      <hr className="sidebar__divider" />
      <div className="sidebar__nav">
        <button className={`nav-item${appView==='keygen'?' nav-item--active':''}`}
          onClick={() => setAppView('keygen')}>Keygen</button>
        <button className={`nav-item${appView==='deploy'?' nav-item--active':''}`}
          onClick={() => setAppView('deploy')}>Deploy</button>
      </div>
      <div className="sidebar__spacer" />
      <div className="sidebar__bottom">
        <button className={`nav-item${appView==='settings'?' nav-item--active':''}`}
          onClick={() => setAppView('settings')}>Settings</button>
      </div>
    </nav>
  )

  // ── Confirmation dialog ───────────────────────────────────────
  const renderDialog = () => (
    <div className="dialog-backdrop" onClick={() => setShowDialog(false)}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <p className="dialog__title">Beralih ke Local Mode?</p>
        <p className="dialog__body">
          Fitur ini belum tersedia dan tidak dapat digunakan saat ini.
        </p>
        <div className="dialog__footer">
          <button className="btn btn-s" onClick={() => setShowDialog(false)}>Batal</button>
          <button className="btn btn-p" onClick={() => setShowDialog(false)}>Mengerti</button>
        </div>
      </div>
    </div>
  )

  // ── Deploy Section ───────────────────────────────────────────
  const renderDeploySection = () => {
    // State A — empty
    if (servers.length === 0 && !showSrvFrm) return (
      <div className="dp-empty">
        <svg className="dp-empty__ico" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/>
          <line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>
        </svg>
        <p className="dp-empty__title">Belum ada server</p>
        <p className="dp-empty__sub">
          Tambahkan server SSH pertama kamu untuk mulai deploy node.
        </p>
        <button className="btn btn-p btn-sm" onClick={() => setShowSrvFrm(true)}>
          + Tambah Server
        </button>
      </div>
    )

    // State B — add server form
    if (showSrvFrm) return (
      <div>
        <p className="page-title-lg">Tambah Server</p>
        <div className="srv-form">
          <div className="field">
            <label className="fld-lbl">Label</label>
            <input className="inp" type="text" value={srvForm.label} placeholder="contoh: Oracle Frankfurt"
              onChange={e => setSrvForm(p => ({...p, label:e.target.value}))} autoFocus />
          </div>
          <div className="field">
            <label className="fld-lbl">IP Address / Host</label>
            <input className="inp inp-mono" type="text" value={srvForm.host} placeholder="132.145.39.75"
              onChange={e => setSrvForm(p => ({...p, host:e.target.value}))} />
          </div>
          <div className="field">
            <label className="fld-lbl">Username</label>
            <input className="inp" type="text" value={srvForm.username}
              onChange={e => setSrvForm(p => ({...p, username:e.target.value}))} />
          </div>
          <div className="field">
            <label className="fld-lbl">SSH Key Path</label>
            <div className="inp-wrap">
              <input className="inp inp-mono" type="text" value={srvForm.keyPath}
                placeholder="C:\Users\HOPEX\.ssh\scalar-node.key"
                onChange={e => setSrvForm(p => ({...p, keyPath:e.target.value}))} />
              <button className="inp-ico" type="button" title="Browse file"
                onClick={pickKeyFile}>
                <IFolder />
              </button>
            </div>
          </div>
          <div className="srv-form-footer">
            <button className="btn btn-s" onClick={() => setShowSrvFrm(false)}>Batal</button>
            <button className="btn btn-p"
              disabled={!srvForm.label.trim() || !srvForm.host.trim()}
              onClick={addServer}>
              Simpan Server
            </button>
          </div>
        </div>
      </div>
    )

    // State C — server list + deploy form
    return (
      <div className="dp-main">
        {/* Kolom kiri */}
        <div className="dp-left">

          <div className="srv-section">
            <div className="srv-sec-hdr">
              <span className="srv-sec-lbl">Server</span>
              <button className="btn btn-g btn-sm" onClick={() => setShowSrvFrm(true)}>+ Tambah</button>
            </div>
            <div className="srv-list">
              {servers.map(sv => (
                <div key={sv.id}
                  className={`server-item${selServer?.id===sv.id?' server-item--active':''}`}
                  onClick={() => selectServer(sv)}>
                  <div className="srv-info">
                    <span className="srv-label">{sv.label}</span>
                    <span className="srv-ip">{sv.host}</span>
                  </div>
                  <button className="srv-del" type="button"
                    onClick={e => { e.stopPropagation(); deleteServer(sv.id) }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="dp-form-section">
            <div className="field">
              <label className="fld-lbl">Encrypted Keystore (base64)</label>
              <textarea className="inp ta inp-mono" rows={3} value={dp.keystore}
                placeholder="Paste keystore dari tab Keygen…"
                onChange={e => setDp(p => ({...p, keystore:e.target.value}))} />
            </div>
            <div className="field">
              <label className="fld-lbl">Passphrase</label>
              <div className="inp-wrap">
                <input className="inp" type={showPass?'text':'password'} value={dp.pass}
                  placeholder="Keystore passphrase"
                  onChange={e => setDp(p => ({...p, pass:e.target.value}))} />
                <button className="inp-ico" type="button" onClick={() => setShowPass(v=>!v)}>
                  <IEye off={showPass}/>
                </button>
              </div>
            </div>
            <div className="field">
              <label className="fld-lbl">Genesis Hash</label>
              <input className="inp inp-mono" type="text" value={dp.genesis}
                placeholder="64-char hex"
                onChange={e => setDp(p => ({...p, genesis:e.target.value}))} />
            </div>
            <div>
              <div className="coll-hdr" onClick={() => setDp(p=>({...p,peersOpen:!p.peersOpen}))}>
                <span>Bootstrap Peers ({dp.peers.split('\n').filter(Boolean).length})</span>
                <IChev open={dp.peersOpen}/>
              </div>
              <div className={`coll-body${dp.peersOpen?' open':' closed'}`}>
                <textarea className="inp ta inp-mono mt2" rows={5} value={dp.peers}
                  onChange={e => setDp(p=>({...p,peers:e.target.value}))} />
              </div>
            </div>
            <div className="c-row">
              <button className="btn btn-s btn-sm"
                disabled={!selServer||dp.connSt==='testing'} onClick={onTestConn}>
                {dp.connSt==='testing'?<><span className="btn-spinner btn-spinner--dark"/>Menguji…</>:'Test Koneksi'}
              </button>
              {dp.connSt==='ok'  && <span className="c-st c-ok"><ICheck/>{dp.connMsg}</span>}
              {dp.connSt==='err' && <span className="c-st c-err">{dp.connMsg}</span>}
            </div>
            <button className="btn btn-p btn-full"
              disabled={!selServer||!dp.keystore||!dp.pass||dp.deplSt==='deploying'}
              onClick={onDeploy}>
              {dp.deplSt==='deploying'?<><span className="btn-spinner"/>Deploying…</>
               :dp.deplSt==='done'  ?'✓  Deployed'
               :dp.deplSt==='error' ?'Retry Deploy'
               :'▶  Deploy Node'}
            </button>
          </div>
        </div>

        {/* Kolom kanan — log panel */}
        <div className="dp-right">
          <div className="log-panel" style={{height:'100%'}}>
            <div className="lp-hdr">
              <span className="lp-ttl">OUTPUT</span>
              {dp.logs.length>0 && <span className="lp-cnt">{dp.logs.length} baris</span>}
            </div>
            <div className="lp-body" ref={logRef}>
              {dp.logs.length===0
                ?<div className="lp-empty"><span className="lp-empty-txt">Output deployment akan muncul di sini…</span></div>
                :dp.logs.map((l,i)=>(
                  <div key={i} className={`log-ln log-ln--${l.type}`}>
                    <span className="log-ln__pfx">
                      {l.type==='cmd'?'$':l.type==='ok'?'✓':l.type==='err'?'✗':'→'}
                    </span>
                    <span className="log-ln__txt">{l.text}</span>
                  </div>
                ))
              }
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Settings Section ─────────────────────────────────────────
  const renderSettingsSection = () => (
    <div className="settings-page">
      <p className="page-title-lg">Settings</p>

      <div className="settings-section">
        <p className="settings-sec-lbl">Metode Deployment</p>
        <label className="radio-item">
          <input type="radio" readOnly checked={method==='ssh'}
            onChange={() => onSwitchMethod('ssh')} />
          <div>
            <p className="radio-item__lbl">SSH Remote Server</p>
            <p className="radio-item__sub">Deploy node ke server via SSH</p>
          </div>
        </label>
        <label className="radio-item radio-item--off">
          <input type="radio" disabled checked={false} readOnly />
          <div>
            <p className="radio-item__lbl">
              Local Mode
              <span className="method-card__badge" style={{marginLeft:8}}>Segera Hadir</span>
            </p>
            <p className="radio-item__sub">Jalankan node langsung di komputer ini</p>
          </div>
        </label>
        <p className="settings-info">Perubahan berlaku setelah restart aplikasi.</p>
      </div>

      <hr className="settings-divider" />

      <div className="settings-section">
        <p className="settings-sec-lbl">Tier Node</p>
        <label className="radio-item" onClick={() => onChangeTier('A')}>
          <input type="radio" readOnly checked={selTier==='A'} onChange={() => onChangeTier('A')} />
          <div>
            <p className="radio-item__lbl">Tier A — Full Node</p>
            <p className="radio-item__sub">Dedicated hardware · NodeScore tinggi · NMT eligible</p>
          </div>
        </label>
        <label className="radio-item" onClick={() => onChangeTier('C')}>
          <input type="radio" readOnly checked={selTier==='C'} onChange={() => onChangeTier('C')} />
          <div>
            <p className="radio-item__lbl">Tier C — Terbatas</p>
            <p className="radio-item__sub">Mobile / low-resource · NodeScore terbatas</p>
          </div>
        </label>
        <p className="settings-info">
          Tier menentukan NodeScore dan eligibilitas jaringan — bukan derivasi Node ID.
          Node ID diturunkan dari mnemonic + genesis hash via BLAKE3.
        </p>
      </div>

      <hr className="settings-divider" />

      <div className="settings-section">
        <p className="settings-sec-lbl">Tentang</p>
        <div className="about-row">
          <span className="about-row__key">Versi Aplikasi</span>
          <span className="about-row__val">{appVersion}</span>
        </div>
        <div className="about-row">
          <span className="about-row__key">Scalar Network</span>
          <a className="about-row__link"
            href="https://scalar.network" target="_blank" rel="noreferrer">
            scalar.network
          </a>
        </div>
      </div>
    </div>
  )

  const renderMethodSelect = () => (
    <div className="ms-page">
      <div className="ms-inner">

        <div className="ms-logo">
          <svg width="24" height="24" viewBox="0 0 24 24" className="logo-sym">
            <rect x="1"   y="3" width="3" height="18" rx=".5" fill="currentColor"/>
            <rect x="5"   y="3" width="3" height="18" rx=".5" fill="currentColor"/>
            <rect x="9.5" y="7" width="5" height="10" rx=".5" fill="currentColor"/>
            <rect x="16"  y="3" width="3" height="18" rx=".5" fill="currentColor"/>
            <rect x="20"  y="3" width="3" height="18" rx=".5" fill="currentColor"/>
          </svg>
          <span className="sidebar__logo-txt">SCALAR NETWORK</span>
        </div>

        <div className="ms-heading">
          <h1 className="ms-title">Pilih cara menjalankan node</h1>
          <p className="ms-sub">
            Pilih metode yang sesuai dengan setup kamu.
            Kamu bisa mengubah ini kapan saja dari menu Settings.
          </p>
        </div>

        <div className="ms-cards">
          <div
            className={`method-card${selTier === 'A' ? ' method-card--selected' : ''}`}
            onClick={() => setSelTier('A' as any)}>
            <p className="method-card__title">SSH Remote Server</p>
            <p className="method-card__desc">
              Generate key di perangkat ini, lalu deploy
              node ke server atau VPS milikmu via SSH.
            </p>
          </div>
          <div className="method-card method-card--disabled">
            <span className="method-card__badge">Segera Hadir</span>
            <p className="method-card__title">Local Mode</p>
            <p className="method-card__desc">
              Jalankan node langsung di komputer ini
              tanpa memerlukan server eksternal.
            </p>
          </div>
        </div>

        <div className="ms-footer">
          <button className="btn btn-p"
            onClick={() => onChooseMethod('ssh')}>
            Lanjut →
          </button>
        </div>

      </div>
    </div>
  )


  const renderSteps = () => (
    <div className="step-ind">
      {KG_STEPS.map((s, i) => {
        const done   = i < curIdx
        const active = i === curIdx
        const cc = done ? 'step-cir--d' : active ? 'step-cir--a' : 'step-cir--p'
        const lc = done ? 'step-lbl--d' : active ? 'step-lbl--a' : ''
        return (
          <div key={s.key} className="step-item">
            <div className="step-node">
              <div className={`step-cir ${cc}`}>{done ? '✓' : i + 1}</div>
              <span className={`step-lbl ${lc}`}>{s.label}</span>
            </div>
            {i < KG_STEPS.length - 1 && <div className={`step-con${done ? ' step-con--d' : ''}`} />}
          </div>
        )
      })}
    </div>
  )

  // ── Keygen steps ──────────────────────────────────────────────
  const renderKg = () => { switch (kg.step) {
    case 'idle': return (
      <div className="card kg-card kg-gen">
        <div className="kg-ico"><IKey /></div>
        <h2 className="kg-h">Generate Node Keys</h2>
        <p className="kg-sub">Create a 24-word mnemonic (253-bit entropy). Store in cold storage before proceeding.</p>
        <div className="warn-box" style={{ maxWidth: 400, textAlign: 'left' }}>
          ⚠ Your mnemonic is the <strong>only recovery path</strong>. Write it down first.
        </div>
        <div className="info-panel" style={{ width:'100%', maxWidth:400, textAlign:'left' }}>
          <div className="info-panel__item">
            <span className="info-panel__term">Node ID</span>
            <span className="info-panel__desc">Identitas unik node kamu di jaringan Scalar, dibuat dari 24 kata kunci + genesis hash via BLAKE3.</span>
          </div>
          <div className="info-panel__item">
            <span className="info-panel__term">Keystore</span>
            <span className="info-panel__desc">File terenkripsi 121 bytes yang menyimpan Node ID. Dikirim ke server via SSH untuk menjalankan node.</span>
          </div>
          <div className="info-panel__item">
            <span className="info-panel__term">NodeID</span>
            <span className="info-panel__desc">Diturunkan via BLAKE3 (&lt;1 ms). Keystore wallet via Argon2id 64 MB (~30 detik).</span>
          </div>
        </div>
        {kg.err && <div className="err-box" style={{ maxWidth: 400 }}>{kg.err}</div>}
        {(() => { const rs = ramStatus(ram); return rs ? (
          <div style={{ maxWidth:400, padding:'8px 12px', borderRadius:'var(--r-md)',
            border:'1px solid', fontSize:'var(--xs)', color:rs.color, background:rs.bg }}>
            {rs.icon} RAM: {rs.label}
          </div>
        ) : null })()} 
        <button className="btn btn-p" style={{ minWidth: 240 }} onClick={onGenerate}>Generate Mnemonic</button>
      </div>
    )
    case 'mnemonic': return (
      <div className="card kg-card">
        <div className="mn-warn">
          <IAlert />
          <span className="mn-warn-txt">Write all 24 words in order. Store offline. Do not photograph.</span>
        </div>
        <div className="mn-hdr">
          <span className="mn-hdr-t">MNEMONIC — 24 WORDS</span>
          <button className="btn btn-g btn-sm" onClick={() => setKg(p => ({ ...p, revealed: !p.revealed }))}>
            <IEye off={kg.revealed} />{kg.revealed ? 'Hide' : 'Reveal'}
          </button>
        </div>
        <div className="mn-grid">
          {kg.mnemonic.map((w, i) => (
            <div key={i} className={`mn-word${i === 0 ? ' mn-word-f' : ''}`}>
              <span className="mn-num">{i + 1}</span>
              <span className={`mn-txt${kg.revealed ? '' : ' mn-txt-b'}`}>{w}</span>
            </div>
          ))}
        </div>
        <div className="mn-foot">
          <button className="btn btn-p" disabled={!kg.revealed}
            onClick={() => setKg(p => ({ ...p, step: 'confirm_word' }))}>
            I've Written It Down →
          </button>
        </div>
      </div>
    )
    case 'confirm_word': return (
      <div className="card kg-card cf-step">
        <p style={{ fontSize: 'var(--lg)', fontWeight: 'var(--fw6)', color: 'var(--t1)', margin: 0 }}>
          Verify your mnemonic
        </p>
        <p style={{ fontSize: 'var(--base)', color: 'var(--t2)', margin: 0 }}>
          Enter words <span className="cf-hint">#7</span>, <span className="cf-hint">#14</span>, and <span className="cf-hint">#21</span> to confirm they were recorded correctly.
        </p>
        <div className="fstk" style={{ width: '100%', maxWidth: 280, textAlign: 'left' }}>
          <div className="field">
            <label className="fld-lbl">Word #7</label>
            <input className={`inp${kg.word7Err ? ' inp-err' : ''}`} type="text"
              value={kg.word7} autoFocus placeholder="type word here…"
              onChange={e => setKg(p => ({ ...p, word7: e.target.value, word7Err: '' }))} />
            {kg.word7Err && <span className="fld-err">{kg.word7Err}</span>}
          </div>
          <div className="field">
            <label className="fld-lbl">Word #14</label>
            <input className={`inp${kg.word14Err ? ' inp-err' : ''}`} type="text"
              value={kg.word14} placeholder="type word here…"
              onChange={e => setKg(p => ({ ...p, word14: e.target.value, word14Err: '' }))} />
            {kg.word14Err && <span className="fld-err">{kg.word14Err}</span>}
          </div>
          <div className="field">
            <label className="fld-lbl">Word #21</label>
            <input className={`inp${kg.word21Err ? ' inp-err' : ''}`} type="text"
              value={kg.word21} placeholder="type word here…"
              onChange={e => setKg(p => ({ ...p, word21: e.target.value, word21Err: '' }))}
              onKeyDown={e => e.key === 'Enter' && onCheckWords()} />
            {kg.word21Err && <span className="fld-err">{kg.word21Err}</span>}
          </div>
        </div>
        <button className="btn btn-p"
          disabled={!kg.word7.trim() || !kg.word14.trim() || !kg.word21.trim()}
          onClick={onCheckWords}>Confirm →</button>
      </div>
    )
    case 'passphrase': return (
      <div className="card kg-card">
        <div className="card-sec-hdr">KEYSTORE PASSPHRASE</div>
        <p className="mb4" style={{ fontSize: 'var(--base)', color: 'var(--t2)' }}>
          Encrypts your keystore. Required every time the node starts.
        </p>
        <div className="fstk mb5">
          <div className="field">
            <label className="fld-lbl">Passphrase</label>
            <div className="inp-wrap">
              <input className="inp" type={showPass ? 'text' : 'password'} value={kg.pass}
                placeholder="min. 8 characters"
                onChange={e => setKg(p => ({ ...p, pass: e.target.value, passErr: '' }))} />
              <button className="inp-ico" type="button" onClick={() => setShowPass(v => !v)}>
                <IEye off={showPass} />
              </button>
            </div>
          </div>
          <div className="field">
            <label className="fld-lbl">Confirm Passphrase</label>
            <div className="inp-wrap">
              <input className={`inp${kg.passErr ? ' inp-err' : ''}`}
                type={showPassC ? 'text' : 'password'} value={kg.passConfirm}
                placeholder="repeat passphrase"
                onChange={e => setKg(p => ({ ...p, passConfirm: e.target.value, passErr: '' }))}
                onKeyDown={e => e.key === 'Enter' && onNextPass()} />
              <button className="inp-ico" type="button" onClick={() => setShowPassC(v => !v)}>
                <IEye off={showPassC} />
              </button>
            </div>
            {kg.passErr && <span className="fld-err">{kg.passErr}</span>}
          </div>
        </div>
        <button className="btn btn-p btn-full" disabled={!kg.pass || !kg.passConfirm} onClick={onNextPass}>
          Set Passphrase →
        </button>
      </div>
    )
    case 'genesis': return (
      <div className="card kg-card">
        <div className="card-sec-hdr">GENESIS HASH</div>
        <p className="mb4" style={{ fontSize: 'var(--base)', color: 'var(--t2)' }}>
          Binds your NodeID to this network.
        </p>
        <div className="field mb5">
          <label className="fld-lbl">Genesis Hash <span style={{ fontWeight: 400 }}>(64 hex chars)</span></label>
          <input className="inp inp-mono" type="text" value={kg.genesis}
            placeholder="a69bef803747742c…" maxLength={64}
            onChange={e => setKg(p => ({ ...p, genesis: e.target.value.toLowerCase().trim(), err: '' }))} />
          <span className="fld-hint">{kg.genesis.length}/64</span>
        </div>
        {kg.err && <div className="err-box mb4">{kg.err}</div>}
        <button className="btn btn-p btn-full" disabled={kg.genesis.length !== 64} onClick={onDeriveKeys}>
          Derive Keys →
        </button>
      </div>
    )
    case 'deriving': return (
      <div className="card kg-card drv-step">
        <div className="drv-bars">{[1, 2, 3, 4, 5].map(n => <div key={n} className="drv-bar" />)}</div>
        <p className="drv-lbl">Deriving keys…</p>
        <p className="drv-sub">NodeID via BLAKE3 + NodeKey via Argon2id 64 MB (~30 detik)</p>
        {ram && <p style={{ fontSize:'var(--xs)', color:'var(--t3)', margin:0 }}>
          RAM: <span style={{ fontFamily:'var(--mono)', color:'var(--t2)' }}>{(ram.available_mb/1024).toFixed(1)} GB tersedia</span>
        </p>}
        <div className="warn-box" style={{ maxWidth:400, fontSize:'var(--xs)' }}>
          ⚠ Jangan tutup aplikasi ini.
        </div>
      </div>
    )
    case 'complete': return (
      <div className="card kg-card">
        <div className="ok-banner"><ICheck /><span className="ok-banner-txt">Keygen complete — keystore encrypted</span></div>
        <div className="kd-row">
          <span className="kd-lbl">Encrypted Keystore (base64 · 121 bytes)</span>
          <div className="kd-val-wrap">
            <span className="kd-val">{kg.keystore}</span>
            <button className={`btn-cp${copied['ks'] ? ' cp-ok' : ''}`}
              onClick={() => copy('ks', kg.keystore)}>
              <ICopy done={copied['ks']} />
            </button>
          </div>
        </div>
        <div className="cmp-actions">
          <button className="btn btn-s" onClick={() => setKg(p => ({
            ...p, step: 'idle', mnemonic: [], keystore: '',
            genesis: '', pass: '', passConfirm: '', err: '',
            word7: '', word7Err: '', word14: '', word14Err: '', word21: '', word21Err: '',
          }))}>Start Over</button>
          <button className="btn btn-p" onClick={() => setAppView('deploy')}>Go to Deploy →</button>
        </div>
      </div>
    )
    default: return null
  }}

  // ── Render ────────────────────────────────────────────────────
  if (!appReady) return null
  if (appView === 'method-select') return renderMethodSelect()

  return (
    <div className="app-shell">
      {renderSidebar()}
      <div className="content-area">
        {appView === 'keygen' && (
          <div className="kg-wrap">
            {renderSteps()}
            {renderKg()}
          </div>
        )}
        {appView === 'deploy'   && renderDeploySection()}
        {appView === 'settings' && renderSettingsSection()}
      </div>
      {showDialog && renderDialog()}
    </div>
  )
}
