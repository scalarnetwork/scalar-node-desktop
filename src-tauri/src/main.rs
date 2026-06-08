#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;
use std::fs;
use std::path::PathBuf;
use sysinfo::System;
use tauri::Emitter;
use tauri::Manager;
mod gui;

use base64::Engine;
use daemon::keygen;
use daemon::ssh::SshConfig;

/// Generate a 24-word mnemonic. SCALAR-PROTOCOL §3.1.
#[tauri::command]
fn generate_mnemonic_cmd() -> Vec<String> {
    keygen::generate_mnemonic()
}

/// Encrypt keystore from mnemonic, genesis hash, and passphrase.
/// NodeID derived via BLAKE3. SCALAR-PROTOCOL §3.1, SCALAR-TECHNICAL §10.5.
#[tauri::command]
async fn encrypt_keystore_cmd(
    mnemonic: Vec<String>,
    genesis_hash: String,
    passphrase: String,
) -> Result<String, String> {
    if !keygen::validate_mnemonic(&mnemonic) {
        return Err("Invalid mnemonic".to_string());
    }

    let genesis_hash_bytes: [u8; 32] = hex::decode(&genesis_hash)
        .map_err(|e| format!("Invalid genesis hash: {}", e))?
        .try_into()
        .map_err(|_| "Genesis hash must be 32 bytes".to_string())?;

    // NodeID: BLAKE3(b"scalar_nodeid" || mnemonic || genesis_hash). SCALAR-PROTOCOL §3.1.
    let mnemonic_str = mnemonic.join(" ");
    let node_id_full = keygen::derive_node_id(&mnemonic_str, &genesis_hash_bytes);
    let node_key = keygen::derive_node_key(&mnemonic, &genesis_hash_bytes)?;

    let keystore = keygen::encrypt_keystore(&node_id_full, &node_key, &passphrase)?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&keystore))
}

/// Test SSH connection to a VPS.
#[tauri::command]
async fn test_ssh_connection(
    host: String,
    username: String,
    key_path: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let config = SshConfig::new(&host, &username, &key_path);
        Ok::<bool, String>(config.test_connection())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deploy a node to a VPS.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn deploy_node(
    app: tauri::AppHandle,
    host: String,
    username: String,
    key_path: String,
    keystore_base64: String,
    passphrase: String,
    _genesis_hash: String,
    dial_peers: Vec<String>,
) -> Result<String, String> {
    let emit = |t: &str, msg: &str| {
        app.emit("deploy_log", serde_json::json!({"t": t, "msg": msg}))
            .ok();
    };

    emit("cmd", &format!("→ Connecting to {}@{}…", username, host));
    let config = SshConfig::new(&host, &username, &key_path);

    let keystore_bytes = base64::engine::general_purpose::STANDARD
        .decode(&keystore_base64)
        .map_err(|e| format!("Failed to decode keystore: {}", e))?;

    emit("inf", "Uploading keystore to VPS…");
    config
        .upload_bytes(&keystore_bytes, "/tmp/node_keystore.bin", 0o600)
        .map_err(|e| format!("Failed to upload keystore: {}", e))?;
    emit("ok", "Keystore uploaded ✓");

    emit("inf", "Uploading passphrase…");
    config
        .upload_bytes(passphrase.as_bytes(), "/tmp/.scalar_pp_tmp", 0o600)
        .map_err(|e| format!("Failed to upload passphrase: {}", e))?;
    emit("ok", "Passphrase uploaded ✓");

    emit("cmd", "Configuring /etc/scalar on VPS…");
    let cmd_setup = "sudo mkdir -p /etc/scalar && \
        sudo mv /tmp/.scalar_pp_tmp /etc/scalar/.passphrase && \
        sudo chmod 600 /etc/scalar/.passphrase && \
        sudo mv /tmp/node_keystore.bin /etc/scalar/node_keystore.bin && \
        sudo chmod 600 /etc/scalar/node_keystore.bin";
    config
        .execute(cmd_setup)
        .map_err(|e| format!("Failed to set up keystore on VPS: {}", e))?;
    emit("ok", "Keystore configured ✓");

    let exec_start_path = format!("/home/{}/scalar-core/target/release/scalar-node", username);
    let _dial_peers_str = dial_peers.join(",");

    let deploy_script = format!(
        r#"#!/bin/bash
set -e
echo "=== SCALAR NODE DEPLOYMENT ==="
echo "[1/5] Installing system dependencies..."
sudo apt-get update -qq && sudo apt-get install -y -qq curl build-essential pkg-config libssl-dev git
if ! command -v rustc &> /dev/null; then
    echo "[2/5] Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    source "$HOME/.cargo/env"
else
    echo "[2/5] Rust already installed: $(rustc --version)"
fi
source "$HOME/.cargo/env" 2>/dev/null || true
REPO_DIR="$HOME/scalar-core"
if [ -d "$REPO_DIR" ]; then
    echo "[3/5] Updating scalar-core..."
    cd "$REPO_DIR" && git pull
else
    echo "[3/5] Cloning scalar-core..."
    git clone https://github.com/berdywandara/scalar-core.git "$REPO_DIR"
fi
echo "[4/5] Building scalar-node (release)..."
cd "$REPO_DIR" && cargo build --release -p scalar-node 2>&1
echo "[5/5] Setting up systemd service..."
sudo tee /etc/systemd/system/scalar-node.service > /dev/null << 'SERVICE_EOF'
[Unit]
Description=Scalar Network Node
After=network-online.target
Wants=network-online.target

[Service]
User={username}
WorkingDirectory=/home/{username}
ExecStart={exec_start_path} run --keystore /etc/scalar/node_keystore.bin
EnvironmentFile=-/etc/scalar/.env
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE_EOF
sudo systemctl daemon-reload
sudo systemctl enable scalar-node
sudo systemctl restart scalar-node
echo "=== DEPLOYMENT COMPLETE ==="
"#,
        username = username,
        exec_start_path = exec_start_path,
    );

    emit(
        "cmd",
        "Running deployment script — this may take 15–30 minutes…",
    );
    emit("inf", "Do not close this application.");

    let config_clone = config.clone();
    let app_clone = app.clone();

    let exit_code = tokio::task::spawn_blocking(move || {
        config_clone.execute_streaming(&deploy_script, move |line| {
            app_clone
                .emit("deploy_log", serde_json::json!({"t": "inf", "msg": line}))
                .ok();
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    if exit_code != 0 {
        let msg = format!("Deployment failed with exit code {}", exit_code);
        emit("err", &msg);
        return Err(msg);
    }

    emit("ok", "✓ Node deployed and running!");
    Ok("Deployment complete".to_string())
}

#[tauri::command]
fn get_system_ram() -> serde_json::Value {
    let mut sys = System::new();
    sys.refresh_memory();
    let total_mb = sys.total_memory() / 1024 / 1024;
    let available_mb = sys.available_memory() / 1024 / 1024;
    serde_json::json!({
        "total_mb":     total_mb,
        "available_mb": available_mb,
    })
}

// ── App data storage helpers ──────────────────────────────────────
fn app_data_path(app: &tauri::AppHandle, filename: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir error: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir error: {}", e))?;
    Ok(dir.join(filename))
}

#[tauri::command]
fn save_setting(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let path = app_data_path(&app, "settings.json")?;
    let mut settings: serde_json::Value = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    settings[key] = serde_json::Value::String(value);
    let out =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("serialize error: {}", e))?;
    fs::write(&path, out).map_err(|e| format!("write error: {}", e))
}

#[tauri::command]
fn load_setting(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let path = app_data_path(&app, "settings.json")?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
    let settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("parse error: {}", e))?;
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
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))
}

#[tauri::command]
async fn pick_ssh_key() -> Result<Option<String>, String> {
    let result = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Pilih SSH Private Key")
            .pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(result.map(|p| p.to_string_lossy().to_string()))
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
            load_servers,
            pick_ssh_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
