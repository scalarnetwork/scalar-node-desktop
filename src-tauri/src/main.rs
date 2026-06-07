#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;
use sysinfo::System;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;
mod gui;

use daemon::keygen;
use daemon::ssh::SshConfig;
use base64::Engine;

/// Generate a 12-word mnemonic.
#[tauri::command]
fn generate_mnemonic_cmd() -> Vec<String> {
    keygen::generate_mnemonic()
}

/// Encrypt keystore from mnemonic, genesis hash, and passphrase.
#[tauri::command]
async fn encrypt_keystore_cmd(
    mnemonic: Vec<String>,
    genesis_hash: String,
    passphrase: String,
    use_tier_c: Option<bool>,
) -> Result<String, String> {
    if !keygen::validate_mnemonic(&mnemonic) {
        return Err("Invalid mnemonic".to_string());
    }

    let genesis_hash_bytes: [u8; 32] = hex::decode(&genesis_hash)
        .map_err(|e| format!("Invalid genesis hash: {}", e))?
        .try_into()
        .map_err(|_| "Genesis hash must be 32 bytes".to_string())?;

    let tier = if use_tier_c.unwrap_or(false) { &keygen::TIER_C } else { &keygen::TIER_A };
    let node_id_full = keygen::derive_node_id_full(&mnemonic, &genesis_hash_bytes, tier)?;
    let node_key = keygen::derive_node_key(&mnemonic, &genesis_hash_bytes)?;

    let keystore = keygen::encrypt_keystore(&node_id_full, &node_key, &passphrase)?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&keystore))
}

/// Test SSH connection to a VPS.
#[tauri::command]
async fn test_ssh_connection(host: String, username: String, key_path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let config = SshConfig::new(&host, &username, &key_path);
        Ok::<bool, String>(config.test_connection())
    }).await.map_err(|e| e.to_string())?
}

/// Deploy a node to a VPS.
#[tauri::command]
async fn deploy_node(
    host: String,
    username: String,
    key_path: String,
    keystore_base64: String,
    passphrase: String,
    _genesis_hash: String, // embedded in keystore; VPS reads genesis_hash.txt
    dial_peers: Vec<String>,
) -> Result<String, String> {
    let config = SshConfig::new(&host, &username, &key_path);
    
    let keystore_bytes = base64::engine::general_purpose::STANDARD.decode(&keystore_base64)
        .map_err(|e| format!("Failed to decode keystore: {}", e))?;
    
    config.upload_bytes(&keystore_bytes, "/tmp/node_keystore.bin", 0o600)
        .map_err(|e| format!("Failed to upload keystore: {}", e))?;

    // Upload passphrase directly via SCP — never expose passphrase in shell commands
    config.upload_bytes(passphrase.as_bytes(), "/tmp/.scalar_pp_tmp", 0o600)
        .map_err(|e| format!("Failed to upload passphrase: {}", e))?;

    let cmd_setup = "sudo mkdir -p /etc/scalar &&         sudo mv /tmp/.scalar_pp_tmp /etc/scalar/.passphrase &&         sudo chmod 600 /etc/scalar/.passphrase &&         sudo mv /tmp/node_keystore.bin /etc/scalar/node_keystore.bin &&         sudo chmod 600 /etc/scalar/node_keystore.bin";
    config.execute(cmd_setup)
        .map_err(|e| format!("Failed to set up keystore on VPS: {}", e))?;

    let exec_start_path = format!("/home/{}/scalar-core/target/release/scalar-node", username);
    let deploy_script = format!(
        r#"#!/bin/bash
set -e
echo "=== SCALAR NODE DEPLOYMENT ==="

echo "[1/5] Installing system dependencies..."
sudo apt-get update -qq && sudo apt-get install -y -qq curl build-essential pkg-config libssl-dev 2>&1 | tail -5

if ! command -v rustc &> /dev/null; then
    echo "[2/5] Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
else
    echo "[2/5] Rust already installed: $(rustc --version)"
fi

REPO_DIR="$HOME/scalar-core"
if [ -d "$REPO_DIR" ]; then
    echo "[3/5] Recloning scalar-core (ensuring clean state)..."
    rm -rf "$REPO_DIR"
fi
if [ ! -d "$REPO_DIR" ]; then
    echo "[3/5] Cloning scalar-core..."
    git clone https://github.com/berdywandara/scalar-core.git "$REPO_DIR"
fi

echo "[4/5] Building scalar-node (release)..."
cd "$REPO_DIR" && cargo build --release -p scalar-node

echo "[5/5] Setting up systemd service..."
sudo tee /etc/systemd/system/scalar-node.service > /dev/null << 'SERVICE_EOF'
[Unit]
Description=Scalar Network Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={username}
WorkingDirectory=/home/{username}/scalar-core
ExecStart={exec_start} run --keystore=/etc/scalar/node_keystore.bin --passphrase-file=/etc/scalar/.passphrase --port=7777 --p2p-port=17777 {dial_args}
Restart=always
RestartSec=15s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=scalar-node

[Install]
WantedBy=multi-user.target
SERVICE_EOF

sudo systemctl daemon-reload
sudo systemctl enable scalar-node
sudo systemctl start scalar-node

echo "✅ Node deployed successfully!"
"#,
        username = username,
        exec_start = exec_start_path,
        dial_args = dial_peers.iter().map(|p| format!("--dial={}", p)).collect::<Vec<_>>().join(" ")
    );

    let remote_script_path = "/tmp/deploy_node.sh";
    config.upload_bytes(deploy_script.as_bytes(), remote_script_path, 0o700)
        .map_err(|e| format!("Failed to upload deploy script: {}", e))?;

    let result = config.execute(&format!("bash {}", remote_script_path))
        .map_err(|e| format!("Deployment script failed: {}", e))?;

    if result.exit_code != 0 {
        return Err(format!("Deployment failed with exit code {}: {}", result.exit_code, result.stderr));
    }

    Ok(format!("Node deployed successfully to {}! Check status with: sudo systemctl status scalar-node", host))
}

#[tauri::command]
fn get_system_ram() -> serde_json::Value {
    let mut sys = System::new();
    sys.refresh_memory();
    let total_mb     = sys.total_memory()     / 1024 / 1024;
    let available_mb = sys.available_memory() / 1024 / 1024;
    serde_json::json!({
        "total_mb":     total_mb,
        "available_mb": available_mb,
    })
}


// ── App data storage helpers ──────────────────────────────────────
fn app_data_path(app: &tauri::AppHandle, filename: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir()
        .map_err(|e| format!("app_data_dir error: {}", e))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("create_dir error: {}", e))?;
    Ok(dir.join(filename))
}

#[tauri::command]
fn save_setting(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let path = app_data_path(&app, "settings.json")?;
    let mut settings: serde_json::Value = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("read error: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    settings[key] = serde_json::Value::String(value);
    let out = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("serialize error: {}", e))?;
    fs::write(&path, out).map_err(|e| format!("write error: {}", e))
}

#[tauri::command]
fn load_setting(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let path = app_data_path(&app, "settings.json")?;
    if !path.exists() { return Ok(None); }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("read error: {}", e))?;
    let settings: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("parse error: {}", e))?;
    Ok(settings[&key].as_str().map(|s| s.to_string()))
}

#[tauri::command]
fn save_servers(app: tauri::AppHandle, data: String) -> Result<(), String> {
    let path = app_data_path(&app, "servers.json")?;
    fs::write(&path, data).map_err(|e| format!("write error: {}", e))
}

#[tauri::command]
fn load_servers(app: tauri::AppHandle) -> Result<String, String> {
    let path = app_data_path(&app, "servers.json")?;
    if !path.exists() { return Ok("[]".to_string()); }
    fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))
}


fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            generate_mnemonic_cmd,
            encrypt_keystore_cmd,
            test_ssh_connection,
            deploy_node,
            get_system_ram,
            save_setting,
            load_setting,
            save_servers,
            load_servers
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
