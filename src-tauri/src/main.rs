#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;
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
fn encrypt_keystore_cmd(
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

    let node_id_full = keygen::derive_node_id_full(&mnemonic, &genesis_hash_bytes, &keygen::TIER_C)?;
    let node_key_seed = keygen::generate_node_key_seed();

    let keystore = keygen::encrypt_keystore(&node_id_full, &node_key_seed, &passphrase)?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&keystore))
}

/// Test SSH connection to a VPS.
#[tauri::command]
fn test_ssh_connection(host: String, username: String, key_path: String) -> Result<bool, String> {
    let config = SshConfig::new(&host, &username, &key_path);
    Ok(config.test_connection())
}

/// Deploy a node to a VPS.
#[tauri::command]
fn deploy_node(
    host: String,
    username: String,
    key_path: String,
    keystore_base64: String,
    passphrase: String,
    genesis_hash: String,
    dial_peers: Vec<String>,
) -> Result<String, String> {
    let config = SshConfig::new(&host, &username, &key_path);
    
    let keystore_bytes = base64::engine::general_purpose::STANDARD.decode(&keystore_base64)
        .map_err(|e| format!("Failed to decode keystore: {}", e))?;
    
    config.upload_bytes(&keystore_bytes, "/tmp/node_keystore.bin", 0o600)
        .map_err(|e| format!("Failed to upload keystore: {}", e))?;

    let passphrase_escaped = passphrase.replace('\'', "'\\''");
    let cmd_create_passphrase = format!(
        "sudo mkdir -p /etc/scalar && echo '{}' | sudo tee /etc/scalar/.passphrase > /dev/null && sudo chmod 600 /etc/scalar/.passphrase && sudo mv /tmp/node_keystore.bin /etc/scalar/node_keystore.bin && sudo chmod 600 /etc/scalar/node_keystore.bin",
        passphrase_escaped
    );
    config.execute(&cmd_create_passphrase)
        .map_err(|e| format!("Failed to set up keystore on VPS: {}", e))?;

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
    echo "[3/5] Updating scalar-core..."
    cd "$REPO_DIR" && git pull
else
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
        exec_start = "$HOME/scalar-core/target/release/scalar-node",
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            generate_mnemonic_cmd,
            encrypt_keystore_cmd,
            test_ssh_connection,
            deploy_node,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
