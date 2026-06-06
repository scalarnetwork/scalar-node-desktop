import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'
import logoMark from './assets/Logo4.png'

// ── Types ────────────────────────────────────────────────────────
type Tab    = 'keygen' | 'deploy'
type KgStep = 'idle' | 'mnemonic' | 'confirm_word' | 'passphrase' | 'genesis' | 'deriving' | 'complete'
type ConnSt = 'idle' | 'testing' | 'ok' | 'err'
type DeplSt = 'idle' | 'deploying' | 'done' | 'error'

interface KgState {
  step: KgStep; mnemonic: string[]; revealed: boolean
  word4: string; word4Err: string
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

// ── Constants ────────────────────────────────────────────────────
const PEERS = [
  '132.145.39.75:17777', '132.226.130.138:17777', '145.241.205.71:17777',
  '140.238.72.52:17777', '140.238.91.78:17777',
].join('\n')

const NODES = [
  { name: 'scalar-node-1', ip: '132.145.39.75',  key: 'scalar-node-1.key.key' },
  { name: 'scalar-node-2', ip: '132.226.130.138', key: 'scalar-node-2.key.key' },
  { name: 'scalar-node-3', ip: '145.241.205.71',  key: 'scalar-node-3.key.key' },
  { name: 'scalar-node-4', ip: '140.238.72.52',   key: 'scalar-node-4.key.key' },
  { name: 'scalar-node-5', ip: '140.238.91.78',   key: 'scalar-node-5.key.key' },
]

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

// ── Icons (inline SVG) ──────────────────────────────────────────────
const IKey = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7.5" cy="15.5" r="5.5"/>
    <path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>
  </svg>
)
const ISrv = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="20" height="8" x="2" y="2" rx="2"/>
    <rect width="20" height="8" x="2" y="14" rx="2"/>
    <line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>
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
  const [tab,       setTab]       = useState<Tab>('keygen')
  const [showPass,  setShowPass]  = useState(false)
  const [showPassC, setShowPassC] = useState(false)
  const [copied,    setCopied]    = useState<Record<string, boolean>>({})
  const [kg, setKg] = useState<KgState>({
    step: 'idle', mnemonic: [], revealed: false,
    word4: '', word4Err: '', pass: '', passConfirm: '',
    passErr: '', genesis: '', keystore: '', err: '',
  })
  const [dp, setDp] = useState<DpState>({
    host: '', user: 'ubuntu', keyPath: '', keystore: '',
    pass: '', genesis: '', peers: PEERS, peersOpen: false, selNode: '',
    connSt: 'idle', connMsg: '', deplSt: 'idle', logs: [],
  })
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [dp.logs])

  // ── Helpers ───────────────────────────────────────────────────
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
  const onCheckWord4 = () => {
    if (kg.word4.trim().toLowerCase() === kg.mnemonic[3])
      setKg(p => ({ ...p, step: 'passphrase', word4Err: '' }))
    else
      setKg(p => ({ ...p, word4Err: 'Incorrect. Check your written copy and try again.' }))
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
        keystore: dp.keystore, passphrase: dp.pass, genesisHash: dp.genesis,
        bootstrapPeers: dp.peers.split('\n').filter(Boolean),
      })
      addLog('ok', 'Node deployed and service started.')
      setDp(p => ({ ...p, deplSt: 'done' }))
    } catch (e) { addLog('err', String(e)); setDp(p => ({ ...p, deplSt: 'error' })) }
  }

  // ── Step indicator ────────────────────────────────────────────
  const curIdx = KG_ORDER.indexOf(kg.step)
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
        <p className="kg-sub">Create a 12-word mnemonic (121-bit entropy). Store in cold storage before proceeding.</p>
        <div className="warn-box" style={{ maxWidth: 400, textAlign: 'left' }}>
          ⚠ Your mnemonic is the <strong>only recovery path</strong>. Write it down first.
        </div>
        {kg.err && <div className="err-box" style={{ maxWidth: 400 }}>{kg.err}</div>}
        <button className="btn btn-p" style={{ minWidth: 240 }} onClick={onGenerate}>Generate Mnemonic</button>
      </div>
    )
    case 'mnemonic': return (
      <div className="card kg-card">
        <div className="mn-warn">
          <IAlert />
          <span className="mn-warn-txt">Write all 12 words in order. Store offline. Do not photograph.</span>
        </div>
        <div className="mn-hdr">
          <span className="mn-hdr-t">MNEMONIC — 12 WORDS</span>
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
          Enter <span className="cf-hint">word #4</span> to confirm it was recorded correctly.
        </p>
        <div className="field" style={{ width: '100%', maxWidth: 280, textAlign: 'left' }}>
          <label className="fld-lbl">Word #4</label>
          <input className={`inp${kg.word4Err ? ' inp-err' : ''}`} type="text"
            value={kg.word4} autoFocus placeholder="type word here…"
            onChange={e => setKg(p => ({ ...p, word4: e.target.value, word4Err: '' }))}
            onKeyDown={e => e.key === 'Enter' && onCheckWord4()} />
          {kg.word4Err && <span className="fld-err">{kg.word4Err}</span>}
        </div>
        <button className="btn btn-p" disabled={!kg.word4.trim()} onClick={onCheckWord4}>Confirm →</button>
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
        <p className="drv-lbl">Deriving keys via Argon2id…</p>
        <p className="drv-sub">Tier C: 16 MB · 100 iterations · ~1–5 minutes</p>
        <div className="prg-track"><div className="prg-fill" /></div>
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
          }))}>Start Over</button>
          <button className="btn btn-p" onClick={() => setTab('deploy')}>Go to Deploy →</button>
        </div>
      </div>
    )
    default: return null
  }}

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="app-root">
      <header className="hdr" data-tauri-drag-region>
        <div className="hdr__logo"><img src={logoMark} alt="Scalar Network" style={{height:28,width:"auto",mixBlendMode:"multiply"}} /></div>
        <nav className="hdr__nav">
          <button className={`ntab${tab === 'keygen' ? ' on' : ''}`} onClick={() => setTab('keygen')}><IKey />Keygen</button>
          <button className={`ntab${tab === 'deploy' ? ' on' : ''}`} onClick={() => setTab('deploy')}><ISrv />Deploy</button>
        </nav>
        <div className="hdr__meta"><span className="net-badge"><span className="net-badge__dot" />Testnet</span></div>
      </header>

      <main className="main"><div className="wrap">

        {tab === 'keygen' && (
          <div className="kg-wrap">{renderSteps()}{renderKg()}</div>
        )}

        {tab === 'deploy' && (
          <div className="dp-layout">
            <div className="dp-form">

              <div className="card">
                <div className="card-sec-hdr">CONNECTION</div>
                <div className="fstk mb2">
                  <div className="f-row">
                    <div className="field">
                      <label className="fld-lbl">VPS IP Address</label>
                      <input className="inp inp-mono" type="text" value={dp.host} placeholder="132.145.39.75"
                        onChange={e => setDp(p => ({ ...p, host: e.target.value, connSt: 'idle', connMsg: '' }))} />
                    </div>
                    <div className="field">
                      <label className="fld-lbl">Username</label>
                      <input className="inp" type="text" value={dp.user}
                        onChange={e => setDp(p => ({ ...p, user: e.target.value }))} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="fld-lbl">SSH Key Path</label>
                    <div className="inp-wrap">
                      <input className="inp inp-mono" type="text" value={dp.keyPath}
                        placeholder="C:\Users\HOPEX\.ssh\scalar-node-1.key.key"
                        onChange={e => setDp(p => ({ ...p, keyPath: e.target.value }))} />
                      <span className="inp-ico" style={{ pointerEvents: 'none' }}><IFolder /></span>
                    </div>
                  </div>
                </div>
                <div className="c-row">
                  <button className="btn btn-s btn-sm"
                    disabled={!dp.host || dp.connSt === 'testing'} onClick={onTestConn}>
                    {dp.connSt === 'testing'
                      ? <><span className="btn-spinner btn-spinner--dark" />Testing…</>
                      : 'Test Connection'}
                  </button>
                  {dp.connSt === 'ok'  && <span className="c-st c-ok"><ICheck />{dp.connMsg}</span>}
                  {dp.connSt === 'err' && <span className="c-st c-err">{dp.connMsg}</span>}
                </div>
              </div>

              <div className="card">
                <div className="card-sec-hdr">CREDENTIALS</div>
                <div className="fstk">
                  <div className="field">
                    <label className="fld-lbl">Encrypted Keystore (base64)</label>
                    <textarea className="inp ta inp-mono" rows={3} value={dp.keystore}
                      placeholder="Paste keystore from Keygen tab…"
                      onChange={e => setDp(p => ({ ...p, keystore: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="fld-lbl">Passphrase</label>
                    <div className="inp-wrap">
                      <input className="inp" type={showPass ? 'text' : 'password'} value={dp.pass}
                        placeholder="Keystore passphrase"
                        onChange={e => setDp(p => ({ ...p, pass: e.target.value }))} />
                      <button className="inp-ico" type="button" onClick={() => setShowPass(v => !v)}>
                        <IEye off={showPass} />
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label className="fld-lbl">Genesis Hash</label>
                    <input className="inp inp-mono" type="text" value={dp.genesis} placeholder="64-char hex"
                      onChange={e => setDp(p => ({ ...p, genesis: e.target.value }))} />
                  </div>
                </div>
                <div className="coll-hdr" onClick={() => setDp(p => ({ ...p, peersOpen: !p.peersOpen }))}>
                  <span>Bootstrap Peers ({dp.peers.split('\n').filter(Boolean).length})</span>
                  <IChev open={dp.peersOpen} />
                </div>
                <div className={`coll-body${dp.peersOpen ? ' open' : ' closed'}`}>
                  <textarea className="inp ta inp-mono mt2" rows={5} value={dp.peers}
                    onChange={e => setDp(p => ({ ...p, peers: e.target.value }))} />
                </div>
              </div>

              <button className="btn btn-p btn-full"
                disabled={!dp.host || !dp.keystore || !dp.pass || dp.deplSt === 'deploying'}
                onClick={onDeploy}>
                {dp.deplSt === 'deploying' ? <><span className="btn-spinner" />Deploying…</>
                  : dp.deplSt === 'done'   ? '✓  Deployed'
                  : dp.deplSt === 'error'  ? 'Retry Deploy'
                  : '▶  Deploy Node'}
              </button>
            </div>

            <div className="dp-aside">
              <div className="card" style={{ padding: 'var(--s4) var(--s5)' }}>
                <div className="card-sec-hdr">ORACLE VPS — QUICK SELECT</div>
                <div className="qs-list">
                  {NODES.map(n => (
                    <div key={n.name} className={`nr${dp.selNode === n.name ? ' sel' : ''}`}
                      onClick={() => setDp(p => ({
                        ...p, selNode: n.name, host: n.ip,
                        keyPath: `C:\\Users\\HOPEX\\.ssh\\${n.key}`,
                        connSt: 'idle', connMsg: '',
                      }))}>
                      <div className="nr-info">
                        <span className="nr-name">{n.name}</span>
                        <span className="nr-ip">{n.ip}</span>
                      </div>
                      <span style={{ fontSize: 'var(--xs)', color: 'var(--tp)' }}>Select →</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="log-panel">
                <div className="lp-hdr">
                  <span className="lp-ttl">OUTPUT</span>
                  {dp.logs.length > 0 && <span className="lp-cnt">{dp.logs.length} lines</span>}
                </div>
                <div className="lp-body" ref={logRef}>
                  {dp.logs.length === 0
                    ? <div className="lp-empty"><span className="lp-empty-txt">Deployment output will appear here…</span></div>
                    : dp.logs.map((l, i) => (
                      <div key={i} className={`log-ln log-ln--${l.type}`}>
                        <span className="log-ln__pfx">
                          {l.type === 'cmd' ? '$' : l.type === 'ok' ? '✓' : l.type === 'err' ? '✗' : '→'}
                        </span>
                        <span className="log-ln__txt">{l.text}</span>
                      </div>
                    ))
                  }
                </div>
              </div>
            </div>
          </div>
        )}

      </div></main>
    </div>
  )
}
