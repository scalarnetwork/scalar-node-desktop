//! SSH connection and remote deployment module.
//!
//! Supports:
//! - Key-based authentication (per-node dedicated keys)
//! - Command execution with output capture
//! - File upload via SCP
//! - Real-time output streaming

#![allow(dead_code)] // API surface — used by frontend commands

use ssh2::Session;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;

/// SSH connection configuration for a node.
#[derive(Debug, Clone)]
pub struct SshConfig {
    /// Remote host IP or hostname
    pub host: String,
    /// SSH port (default: 22)
    pub port: u16,
    /// SSH username (usually "ubuntu")
    pub username: String,
    /// Path to private key file (e.g., ~/.ssh/scalar-node-1.key)
    pub private_key_path: String,
}

/// Result of a remote command execution.
#[derive(Debug)]
pub struct CommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl SshConfig {
    /// Create new SSH config for a node.
    pub fn new(host: &str, username: &str, private_key_path: &str) -> Self {
        Self {
            host: host.to_string(),
            port: 22,
            username: username.to_string(),
            private_key_path: private_key_path.to_string(),
        }
    }

    /// Connect to the remote host and return an authenticated session.
    pub fn connect(&self) -> Result<Session, String> {
        let addr = format!("{}:{}", self.host, self.port);
        let tcp = TcpStream::connect(&addr)
            .map_err(|e| format!("TCP connection to {} failed: {}", addr, e))?;
        tcp.set_read_timeout(Some(std::time::Duration::from_secs(30)))
            .map_err(|e| format!("Failed to set timeout: {}", e))?;

        let mut session =
            Session::new().map_err(|e| format!("Failed to create SSH session: {}", e))?;
        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|e| format!("SSH handshake failed: {}", e))?;

        // Authenticate with private key
        session
            .userauth_pubkey_file(
                &self.username,
                None,
                Path::new(&self.private_key_path),
                None,
            )
            .map_err(|e| {
                format!(
                    "SSH authentication failed for {}@{}. Key: {}. Error: {}",
                    self.username, self.host, self.private_key_path, e
                )
            })?;

        if !session.authenticated() {
            return Err(format!(
                "SSH authentication failed for {}@{}",
                self.username, self.host
            ));
        }

        Ok(session)
    }

    /// Execute a command on the remote host and return the result.
    pub fn execute(&self, command: &str) -> Result<CommandResult, String> {
        let session = self.connect()?;
        let mut channel = session
            .channel_session()
            .map_err(|e| format!("Failed to open channel: {}", e))?;

        channel
            .exec(command)
            .map_err(|e| format!("Failed to execute '{}': {}", command, e))?;

        let mut stdout = String::new();
        channel
            .read_to_string(&mut stdout)
            .map_err(|e| format!("Failed to read stdout: {}", e))?;

        let mut stderr = String::new();
        channel
            .stderr()
            .read_to_string(&mut stderr)
            .map_err(|e| format!("Failed to read stderr: {}", e))?;

        channel
            .wait_close()
            .map_err(|e| format!("Failed to close channel: {}", e))?;

        let exit_code = channel
            .exit_status()
            .map_err(|e| format!("Failed to get exit status: {}", e))?;

        Ok(CommandResult {
            exit_code,
            stdout,
            stderr,
        })
    }

    /// Upload a local file to the remote host via SCP.
    pub fn upload_file(
        &self,
        local_path: &Path,
        remote_path: &str,
        mode: i32,
    ) -> Result<(), String> {
        let session = self.connect()?;

        let file_content = std::fs::read(local_path)
            .map_err(|e| format!("Failed to read local file {:?}: {}", local_path, e))?;
        let file_size = file_content.len() as u64;

        let mut channel = session
            .scp_send(Path::new(remote_path), mode, file_size, None)
            .map_err(|e| format!("Failed to open SCP channel: {}", e))?;

        channel
            .write_all(&file_content)
            .map_err(|e| format!("Failed to write file via SCP: {}", e))?;

        channel
            .send_eof()
            .map_err(|e| format!("Failed to send EOF: {}", e))?;
        channel
            .wait_eof()
            .map_err(|e| format!("Failed to wait EOF: {}", e))?;
        channel
            .wait_close()
            .map_err(|e| format!("Failed to close SCP channel: {}", e))?;

        Ok(())
    }

    /// Upload bytes directly to the remote host via SCP.
    pub fn upload_bytes(&self, data: &[u8], remote_path: &str, mode: i32) -> Result<(), String> {
        let session = self.connect()?;
        let file_size = data.len() as u64;
        let mut channel = session
            .scp_send(Path::new(remote_path), mode, file_size, None)
            .map_err(|e| format!("Failed to open SCP channel: {}", e))?;
        channel
            .write_all(data)
            .map_err(|e| format!("Failed to write data via SCP: {}", e))?;
        channel
            .send_eof()
            .map_err(|e| format!("Failed to send EOF: {}", e))?;
        channel
            .wait_eof()
            .map_err(|e| format!("Failed to wait EOF: {}", e))?;
        channel
            .wait_close()
            .map_err(|e| format!("Failed to close SCP channel: {}", e))?;
        Ok(())
    }

    /// Test connectivity — returns true if SSH connection succeeds.
    pub fn test_connection(&self) -> bool {
        self.connect().is_ok()
    }

    /// Execute a command and stream output line-by-line via callback.
    pub fn execute_streaming<F>(&self, command: &str, mut on_line: F) -> Result<i32, String>
    where
        F: FnMut(String),
    {
        use std::io::ErrorKind;
        let session = self.connect()?;
        let mut channel = session
            .channel_session()
            .map_err(|e| format!("Channel error: {}", e))?;
        channel
            .exec(&format!("{} 2>&1", command))
            .map_err(|e| format!("Exec error: {}", e))?;

        let mut remainder = String::new();
        let mut buf = [0u8; 4096];
        loop {
            match channel.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    remainder.push_str(&chunk);
                    while let Some(pos) = remainder.find('\n') {
                        let line = remainder[..pos].trim_end_matches('\r').to_string();
                        if !line.is_empty() {
                            on_line(line);
                        }
                        remainder = remainder[pos + 1..].to_string();
                    }
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(80));
                }
                Err(_) => break,
            }
        }
        if !remainder.trim().is_empty() {
            on_line(remainder.trim().to_string());
        }
        channel.wait_close().ok();
        Ok(channel.exit_status().unwrap_or(-1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_config_creation() {
        let config = SshConfig::new("132.145.39.75", "ubuntu", "~/.ssh/scalar-node-1.key");
        assert_eq!(config.host, "132.145.39.75");
        assert_eq!(config.username, "ubuntu");
        assert_eq!(config.port, 22);
        assert_eq!(config.private_key_path, "~/.ssh/scalar-node-1.key");
    }

    #[test]
    fn test_connection_failure_bad_host() {
        let config = SshConfig::new("0.0.0.0", "ubuntu", "/nonexistent/key");
        assert!(!config.test_connection());
    }
}
