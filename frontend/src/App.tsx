import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'

type Screen = 'keygen' | 'deploy'
type KeygenStep = 'idle' | 'mnemonic' | 'confirm_word' | 'passphrase' | 'genesis' | 'deriving' | 'complete'

interface KeygenState {
  step: KeygenStep; mnemonic: string[]; revealed: boolean
  word4Input: string; word4Error: string
  passphrase: string; ppConfirm: string; ppError: string
  genesisHash: string; keystoreB64: string; error: string
}

interface DeployState {
  host: string; username: string; keyPath: string
  keystoreB64: string; passphrase: string
  genesisHash: string; dialPeers: string
  status: 'idle'|'connecting'|'deploying'|'done'|'error'; output: string
}

const PEERS = [
  '/ip4/132.145.39.75/tcp/17777','/ip4/132.226.130.138/tcp/17777',
  '/ip4/145.241.205.71/tcp/17777','/ip4/140.238.72.52/tcp/17777',
  '/ip4/140.238.91.78/tcp/17777',
].join('\n')

const KG0: KeygenState = {
  step:'idle', mnemonic:[], revealed:false,
  word4Input:'', word4Error:'',
  passphrase:'', ppConfirm:'', ppError:'',
  genesisHash:'', keystoreB64:'', error:'',
}

const STEPS: {key:KeygenStep, label:string}[] = [
  {key:'idle',label:'Generate'},{key:'mnemonic',label:'Record'},
  {key:'confirm_word',label:'Confirm'},{key:'passphrase',label:'Passphrase'},
  {key:'genesis',label:'Genesis'},{key:'deriving',label:'Derive'},
]

const NODES = [
  {name:'node-1',ip:'132.145.39.75',key:'scalar-node-1.key.key'},
  {name:'node-2',ip:'132.226.130.138',key:'scalar-node-2.key.key'},
  {name:'node-3',ip:'145.241.205.71',key:'scalar-node-3.key.key'},
  {name:'node-4',ip:'140.238.72.52',key:'scalar-node-4.key.key'},
  {name:'node-5',ip:'140.238.91.78',key:'scalar-node-5.key.key'},
]

export default function App() {
  const [screen, setScreen] = useState<Screen>('keygen')
  const [kg, setKg] = useState<KeygenState>(KG0)
  const [dp, setDp] = useState<DeployState>({
    host:'', username:'ubuntu', keyPath:'',
    keystoreB64:'', passphrase:'', genesisHash:'',
    dialPeers:PEERS, status:'idle', output:'',
  })

  async function onGenerate() {
    try {
      const words = await invoke<string[]>('generate_mnemonic_cmd')
      setKg(p => ({...p, step:'mnemonic', mnemonic:words, revealed:false, error:''}))
    } catch(e) { setKg(p => ({...p, error:String(e)})) }
  }

  function onCheckWord4() {
    if (kg.word4Input.trim().toLowerCase() === kg.mnemonic[3].toLowerCase())
      setKg(p => ({...p, step:'passphrase', word4Error:''}))
    else
      setKg(p => ({...p, word4Error:`Incorrect — expected "${kg.mnemonic[3]}"`}))
  }

  function onCheckPP() {
    if (kg.passphrase.length < 8) { setKg(p=>({...p,ppError:'Minimum 8 characters'})); return }
    if (kg.passphrase !== kg.ppConfirm) { setKg(p=>({...p,ppError:'Passphrases do not match'})); return }
    setKg(p=>({...p, step:'genesis', ppError:''}))
  }

  async function onDerive() {
    if (kg.genesisHash.length !== 64) { setKg(p=>({...p,error:'Genesis hash must be 64 hex chars'})); return }
    setKg(p=>({...p, step:'deriving', error:''}))
    try {
      const b64 = await invoke<string>('encrypt_keystore_cmd', {
        mnemonic:kg.mnemonic, genesisHash:kg.genesisHash, passphrase:kg.passphrase,
      })
      setKg(p=>({...p, step:'complete', keystoreB64:b64}))
    } catch(e) { setKg(p=>({...p, step:'genesis', error:String(e)})) }
  }

  async function onTestSSH() {
    setDp(p=>({...p, status:'connecting', output:'Testing SSH connection...'}))
    try {
      const ok = await invoke<boolean>('test_ssh_connection', {host:dp.host, username:dp.username, keyPath:dp.keyPath})
      setDp(p=>({...p, status:ok?'idle':'error', output:ok?'✅ Connection successful':`❌ Connection failed`}))
    } catch(e) { setDp(p=>({...p, status:'error', output:`❌ ${e}`})) }
  }

  async function onDeploy() {
    setDp(p=>({...p, status:'deploying', output:'[1/5] Starting deployment...\nThis takes 10–20 min (Rust compilation).'}))
    try {
      const result = await invoke<string>('deploy_node', {
        host:dp.host, username:dp.username, keyPath:dp.keyPath,
        keystoreBase64:dp.keystoreB64, passphrase:dp.passphrase,
        genesisHash:dp.genesisHash||'0'.repeat(64),
        dialPeers:dp.dialPeers.split('\n').map(s=>s.trim()).filter(Boolean),
      })
      setDp(p=>({...p, status:'done', output:result}))
    } catch(e) { setDp(p=>({...p, status:'error', output:`❌ Deployment failed:\n${e}`})) }
  }

  const si = STEPS.findIndex(s=>s.key===kg.step)
  const done = kg.step==='complete'

  return (
    <div className="app">
      <header className="hdr">
        <div className="brand">
          <span className="brand-diamond">◆</span>
          <span className="brand-name">SCALAR NODE</span>
          <span className="brand-tag">v0.1 · Tier C Testnet</span>
        </div>
        <nav className="tabs">
          <button className={`tab${screen==='keygen'?' tab-on':''}`} onClick={()=>setScreen('keygen')}>KEYGEN</button>
          <button className={`tab${screen==='deploy'?' tab-on':''}`} onClick={()=>setScreen('deploy')}>DEPLOY</button>
        </nav>
      </header>

      <main className="main">
        {screen==='keygen' && (
          <div className="page">
            <div className="pg-title">
              <h1>Node Keygen</h1>
              <p>Generate cryptographic node identity · <code>SCALAR-TECHNICAL §10.5</code></p>
            </div>

            <div className="steps">
              {STEPS.map((s,i) => {
                const d = done||i<si, a = i===si
                return (
                  <div key={s.key} className={`step${a?' step-a':''}${d?' step-d':''}`}>
                    <span className="sn">{d?'✓':i+1}</span>
                    <span className="sl">{s.label}</span>
                    {i<STEPS.length-1 && <span className="sep">›</span>}
                  </div>
                )
              })}
            </div>

            {kg.step==='idle' && (
              <div className="card">
                <div className="cb cb-c">
                  <p className="dim">Generate a 12-word mnemonic (CSPRNG · 121-bit entropy)</p>
                  <div className="warn-box">⚠ Mnemonic is the only recovery path. Prepare cold storage first.</div>
                  <button className="btn-p" onClick={onGenerate}>Generate Mnemonic</button>
                </div>
              </div>
            )}

            {kg.step==='mnemonic' && (
              <div className="card">
                <div className="ch">
                  <span>MNEMONIC — 12 WORDS</span>
                  <button className="btn-g btn-sm" onClick={()=>setKg(p=>({...p,revealed:!p.revealed}))}>
                    {kg.revealed?'🙈 Hide':'👁 Reveal'}
                  </button>
                </div>
                <div className={`mnem-grid${kg.revealed?'':' blurred'}`}>
                  {kg.mnemonic.map((w,i)=>(
                    <div key={i} className={`mw${i===0?' mw-first':''}`}>
                      <span className="mn">{i+1}</span>
                      <span className="mt">{w}</span>
                    </div>
                  ))}
                </div>
                <div className="cf">
                  <span className="dim sm">Write all 12 words in order. Store offline.</span>
                  <button className="btn-p" onClick={()=>setKg(p=>({...p,step:'confirm_word'}))} disabled={!kg.revealed}>
                    I've Written It Down →
                  </button>
                </div>
              </div>
            )}

            {kg.step==='confirm_word' && (
              <div className="card">
                <div className="ch">CONFIRM MNEMONIC</div>
                <div className="cb">
                  <p className="dim mb">Enter <strong>word #4</strong> to confirm you've recorded the mnemonic.</p>
                  <div className="field">
                    <label>Word #4</label>
                    <input className="inp" type="text" value={kg.word4Input} autoFocus
                      onChange={e=>setKg(p=>({...p,word4Input:e.target.value}))}
                      onKeyDown={e=>e.key==='Enter'&&onCheckWord4()}
                      placeholder="enter word..." />
                    {kg.word4Error&&<span className="ferr">{kg.word4Error}</span>}
                  </div>
                  <button className="btn-p" onClick={onCheckWord4}>Confirm →</button>
                </div>
              </div>
            )}

            {kg.step==='passphrase' && (
              <div className="card">
                <div className="ch">KEYSTORE PASSPHRASE</div>
                <div className="cb">
                  <p className="dim mb">Encrypts your keystore file. Min 8 characters. Must match at deploy time.</p>
                  <div className="field">
                    <label>Passphrase</label>
                    <input className="inp" type="password" value={kg.passphrase} autoFocus
                      onChange={e=>setKg(p=>({...p,passphrase:e.target.value}))} placeholder="••••••••" />
                  </div>
                  <div className="field">
                    <label>Confirm Passphrase</label>
                    <input className="inp" type="password" value={kg.ppConfirm}
                      onChange={e=>setKg(p=>({...p,ppConfirm:e.target.value}))}
                      onKeyDown={e=>e.key==='Enter'&&onCheckPP()} placeholder="••••••••" />
                    {kg.ppError&&<span className="ferr">{kg.ppError}</span>}
                  </div>
                  <button className="btn-p" onClick={onCheckPP}>Next →</button>
                </div>
              </div>
            )}

            {kg.step==='genesis' && (
              <div className="card">
                <div className="ch">GENESIS HASH</div>
                <div className="cb">
                  <p className="dim mb">Binds your NodeID to this network. 64 hex chars (32 bytes).</p>
                  <div className="field">
                    <label>Genesis Hash</label>
                    <input className="inp mono" type="text" value={kg.genesisHash}
                      onChange={e=>setKg(p=>({...p,genesisHash:e.target.value.toLowerCase().trim()}))}
                      placeholder="a69bef803747742c..." maxLength={64} />
                    <span className="fhint">{kg.genesisHash.length}/64</span>
                  </div>
                  {kg.error&&<div className="err-box mb">{kg.error}</div>}
                  <button className="btn-p" onClick={onDerive} disabled={kg.genesisHash.length!==64}>
                    Derive Keys →
                  </button>
                </div>
              </div>
            )}

            {kg.step==='deriving' && (
              <div className="card">
                <div className="cb cb-c">
                  <div className="spinner" />
                  <p className="accent">Deriving keys via Argon2id…</p>
                  <p className="dim sm">Tier C: 16 MB · 100 iterations · ~1–5 minutes</p>
                </div>
              </div>
            )}

            {kg.step==='complete' && (
              <div className="card">
                <div className="ch"><span className="ok">✅ KEYGEN COMPLETE</span></div>
                <div className="cb">
                  <div className="field">
                    <label>Encrypted Keystore (base64 · 121 bytes)</label>
                    <div className="code-box">
                      <code>{kg.keystoreB64}</code>
                      <button className="btn-copy" onClick={()=>navigator.clipboard.writeText(kg.keystoreB64)}>Copy</button>
                    </div>
                  </div>
                  <p className="dim sm mb">Compatible with <code>scalar-node run --keystore</code> on VPS.</p>
                  <div className="btn-row">
                    <button className="btn-p" onClick={()=>{
                      setDp(p=>({...p,keystoreB64:kg.keystoreB64,passphrase:kg.passphrase,genesisHash:kg.genesisHash}))
                      setScreen('deploy')
                    }}>→ Deploy This Node</button>
                    <button className="btn-g" onClick={()=>setKg(KG0)}>New Keygen</button>
                  </div>
                </div>
              </div>
            )}

            {kg.error&&kg.step!=='genesis'&&<div className="err-box">{kg.error}</div>}
          </div>
        )}

        {screen==='deploy' && (
          <div className="page">
            <div className="pg-title">
              <h1>Deploy Node</h1>
              <p>SSH into a VPS and deploy <code>scalar-node</code> automatically</p>
            </div>
            <div className="dp-grid">
              <div className="dp-left">
                <div className="card">
                  <div className="ch">VPS CONNECTION</div>
                  <div className="cb">
                    <div className="field-row">
                      <div className="field fg">
                        <label>IP Address</label>
                        <input className="inp mono" type="text" value={dp.host}
                          onChange={e=>setDp(p=>({...p,host:e.target.value}))} placeholder="132.145.39.75" />
                      </div>
                      <div className="field f120">
                        <label>Username</label>
                        <input className="inp mono" type="text" value={dp.username}
                          onChange={e=>setDp(p=>({...p,username:e.target.value}))} />
                      </div>
                    </div>
                    <div className="field">
                      <label>SSH Key Path</label>
                      <input className="inp mono" type="text" value={dp.keyPath}
                        onChange={e=>setDp(p=>({...p,keyPath:e.target.value}))}
                        placeholder="C:\Users\HOPEX\.ssh\scalar-node-3.key.key" />
                    </div>
                    <button className="btn-s btn-sm" onClick={onTestSSH} disabled={dp.status==='connecting'}>
                      {dp.status==='connecting'?'Testing…':'Test Connection'}
                    </button>
                  </div>
                </div>

                <div className="card">
                  <div className="ch">KEYSTORE & CREDENTIALS</div>
                  <div className="cb">
                    <div className="field">
                      <label>Encrypted Keystore (base64)</label>
                      <textarea className="inp mono ta" value={dp.keystoreB64} rows={3}
                        onChange={e=>setDp(p=>({...p,keystoreB64:e.target.value}))}
                        placeholder="Paste from Keygen tab…" />
                    </div>
                    <div className="field">
                      <label>Passphrase</label>
                      <input className="inp" type="password" value={dp.passphrase}
                        onChange={e=>setDp(p=>({...p,passphrase:e.target.value}))} placeholder="••••••••" />
                    </div>
                    <div className="field">
                      <label>Genesis Hash</label>
                      <input className="inp mono" type="text" value={dp.genesisHash} maxLength={64}
                        onChange={e=>setDp(p=>({...p,genesisHash:e.target.value}))}
                        placeholder="a69bef803747742c…" />
                    </div>
                    <div className="field">
                      <label>Bootstrap Peers (one per line)</label>
                      <textarea className="inp mono ta" value={dp.dialPeers} rows={5}
                        onChange={e=>setDp(p=>({...p,dialPeers:e.target.value}))} />
                    </div>
                  </div>
                </div>

                <button className="btn-p btn-deploy" onClick={onDeploy}
                  disabled={dp.status==='deploying'||!dp.host||!dp.keystoreB64||!dp.passphrase}>
                  {dp.status==='deploying'?'⟳  Deploying…':'▶  Deploy Node'}
                </button>
              </div>

              <div className="dp-right">
                <div className="card card-term">
                  <div className="ch">OUTPUT</div>
                  <div className="term">
                    {dp.output
                      ? <pre className={`tt${dp.status==='error'?' tt-err':dp.status==='done'?' tt-ok':''}`}>{dp.output}</pre>
                      : <p className="term-ph">Deployment output will appear here…</p>
                    }
                  </div>
                </div>

                <div className="card">
                  <div className="ch">ORACLE VPS — QUICK SELECT</div>
                  <div className="cb">
                    {NODES.map(n=>(
                      <div key={n.name} className="nrow" onClick={()=>
                        setDp(p=>({...p, host:n.ip, keyPath:`C:\\Users\\HOPEX\\.ssh\\${n.key}`}))
                      }>
                        <span className="nname">{n.name}</span>
                        <span className="nip">{n.ip}</span>
                        <span className="nsel">Select →</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
