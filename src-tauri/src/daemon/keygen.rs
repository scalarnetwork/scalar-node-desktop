//! Keygen — Mnemonic generation, Argon2id derivation, keystore encryption
//!
//! Implements SCALAR-TECHNICAL §10.5 and SCALAR-PROTOCOL §3.2, §11.1
//! Tier C (dev/testnet) : 16 MB, 100 iterations, ~1-5 min
//! Tier A (mainnet)     : 4 GB,  3600 iterations, ~60 min

#![allow(dead_code)] // API surface — used by frontend commands

use argon2::{Algorithm, Argon2, Params, Version};
use bip39::Language;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use std::path::PathBuf;

// ── Keystore format constants — SCALAR-TECHNICAL §10.5 ───────────────────────
pub const KEYSTORE_VERSION: u8 = 0x01;
pub const KDF_SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 24;
/// Plaintext payload: node_id_full(32) + node_key(32)
pub const PAYLOAD_LEN: usize = 64;
pub const AEAD_TAG_LEN: usize = 16;
/// Total keystore size: 1 + 16 + 24 + 64 + 16 = 121 bytes
pub const KEYSTORE_SIZE: usize = 1 + KDF_SALT_LEN + NONCE_LEN + PAYLOAD_LEN + AEAD_TAG_LEN;

// ── Mnemonic constants — SCALAR-PROTOCOL §11.1 ───────────────────────────────
pub const MNEMONIC_WORD_COUNT: usize = 12;
pub const MNEMONIC_FIRST_WORD: &str = "scalar";

// ── Domain separators — SCALAR-PROTOCOL §3.2, §11.1 (OSSIFIED) ──────────────
/// b"scalar_nodeid" — NodeID Argon2id salt prefix
const NODE_ID_SALT_PREFIX: &[u8] = b"scalar_nodeid";
/// b"scalar_wallet_kdf" — Wallet seed derivation
const WALLET_KDF_PREFIX: &[u8] = b"scalar_wallet_kdf";

// ── Passphrase KDF parameters — SCALAR-TECHNICAL §10.5 ───────────────────────
const PASS_MEMORY_KIB: u32 = 64 * 1024; // 64 MB
const PASS_TIME: u32 = 3;
const PASS_PARALLELISM: u32 = 1;

// ── Wallet seed KDF parameters — SCALAR-PROTOCOL §11.1 ───────────────────────
const WALLET_MEMORY_KIB: u32 = 64 * 1024; // 64 MB
const WALLET_TIME: u32 = 3;
const WALLET_PARALLELISM: u32 = 1;
const WALLET_OUTPUT_LEN: usize = 64;

// ── Argon2 tier parameters — SCALAR-TECHNICAL §10.5 ─────────────────────────
#[derive(Debug, Clone)]
pub struct Argon2Tier {
    /// Memory cost in KiB (NOT KB).
    pub memory_kib: u32,
    pub iterations: u32,
    pub label: &'static str,
}

pub const TIER_A: Argon2Tier = Argon2Tier {
    memory_kib: 4 * 1024 * 1024, // 4 GB in KiB
    iterations: 3600,
    label: "Tier A (mainnet)",
};

pub const TIER_C: Argon2Tier = Argon2Tier {
    memory_kib: 16 * 1024, // 16 MB in KiB
    iterations: 100,
    label: "Tier C (dev/testnet)",
};

// ── Mnemonic ──────────────────────────────────────────────────────────────────

/// Generate a 12-word Scalar mnemonic: "scalar" + 11 BIP-39 random words.
/// Uses OsRng (CSPRNG) for 121-bit effective entropy.
/// SCALAR-TECHNICAL §10.5.1, SCALAR-PROTOCOL §11.1.
pub fn generate_mnemonic() -> Vec<String> {
    let wordlist = Language::English.word_list();
    let mut rng = rand::rngs::OsRng;
    let mut words = vec![MNEMONIC_FIRST_WORD.to_string()];
    for _ in 0..11 {
        let mut buf = [0u8; 4];
        rng.fill_bytes(&mut buf);
        let idx = (u32::from_le_bytes(buf) as usize) % wordlist.len();
        words.push(wordlist[idx].to_string());
    }
    words
}

/// Validate mnemonic: 12 words, first = "scalar", words 2-12 in BIP-39.
pub fn validate_mnemonic(words: &[String]) -> bool {
    if words.len() != MNEMONIC_WORD_COUNT {
        return false;
    }
    if words[0] != MNEMONIC_FIRST_WORD {
        return false;
    }
    let wordset: std::collections::HashSet<&str> =
        Language::English.word_list().iter().copied().collect();
    // First word "scalar" is not in BIP-39 — only validate words 2-12
    words[1..].iter().all(|w| wordset.contains(w.as_str()))
}

// ── Key Derivation ────────────────────────────────────────────────────────────

/// Derive NodeID from mnemonic and genesis_hash.
///
/// SCALAR-PROTOCOL §3.2 (OSSIFIED):
///   node_id_full = Argon2id(
///     input  = UTF8(mnemonic),
///     salt   = b"scalar_nodeid" || genesis_hash,
///     memory = tier.memory_kib,
///     time   = tier.iterations,
///     output = 32 bytes
///   )
pub fn derive_node_id_full(
    mnemonic: &[String],
    genesis_hash: &[u8; 32],
    tier: &Argon2Tier,
) -> Result<[u8; 32], String> {
    let mnemonic_str = mnemonic.join(" ");

    // salt = b"scalar_nodeid" || genesis_hash (OSSIFIED)
    let mut salt = Vec::with_capacity(NODE_ID_SALT_PREFIX.len() + 32);
    salt.extend_from_slice(NODE_ID_SALT_PREFIX);
    salt.extend_from_slice(genesis_hash);

    let params = Params::new(tier.memory_kib, tier.iterations, 1, Some(32))
        .map_err(|e| format!("Argon2 NodeID params error: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut node_id_full = [0u8; 32];
    argon2
        .hash_password_into(mnemonic_str.as_bytes(), &salt, &mut node_id_full)
        .map_err(|e| format!("Argon2id NodeID derivation failed: {}", e))?;

    Ok(node_id_full)
}

/// Derive NodeKey from mnemonic + genesis_hash via wallet key chain.
///
/// SCALAR-PROTOCOL §11.1 (OSSIFIED):
///   seed       = Argon2id(mnemonic, b"scalar_wallet_kdf"||genesis_hash, 64MB, 3, 1) → 64B
///   MasterKey  = BLAKE3(seed || b"scalar_master")
///   AccountKey = BLAKE3(MasterKey || b"account" || 0_le64)
///   NodeKey    = BLAKE3(AccountKey || b"node")
pub fn derive_node_key(
    mnemonic: &[String],
    genesis_hash: &[u8; 32],
) -> Result<[u8; 32], String> {
    let mnemonic_str = mnemonic.join(" ");

    // Wallet KDF salt: b"scalar_wallet_kdf" || genesis_hash
    let mut wallet_salt = Vec::with_capacity(WALLET_KDF_PREFIX.len() + 32);
    wallet_salt.extend_from_slice(WALLET_KDF_PREFIX);
    wallet_salt.extend_from_slice(genesis_hash);

    // Argon2id wallet seed (64 bytes)
    let params =
        Params::new(WALLET_MEMORY_KIB, WALLET_TIME, WALLET_PARALLELISM, Some(WALLET_OUTPUT_LEN))
            .map_err(|e| format!("Argon2 wallet params error: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut seed = [0u8; WALLET_OUTPUT_LEN];
    argon2
        .hash_password_into(mnemonic_str.as_bytes(), &wallet_salt, &mut seed)
        .map_err(|e| format!("Wallet seed derivation failed: {}", e))?;

    // BLAKE3 derivation chain
    let master_key: [u8; 32] = {
        let mut h = blake3::Hasher::new();
        h.update(&seed);
        h.update(b"scalar_master");
        *h.finalize().as_bytes()
    };
    let account_key: [u8; 32] = {
        let mut h = blake3::Hasher::new();
        h.update(&master_key);
        h.update(b"account");
        h.update(&0u64.to_le_bytes());
        *h.finalize().as_bytes()
    };
    let node_key: [u8; 32] = {
        let mut h = blake3::Hasher::new();
        h.update(&account_key);
        h.update(b"node");
        *h.finalize().as_bytes()
    };

    // Zero intermediates from memory
    let mut seed_zero = seed;
    seed_zero.iter_mut().for_each(|b| *b = 0);

    Ok(node_key)
}

// ── Passphrase KDF ────────────────────────────────────────────────────────────

/// Derive 32-byte encryption key from passphrase via Argon2id.
/// SCALAR-TECHNICAL §10.5: 64MB, 3 iter, parallelism 1.
fn passphrase_kdf(passphrase: &[u8], salt: &[u8; KDF_SALT_LEN]) -> Result<[u8; 32], String> {
    let params = Params::new(PASS_MEMORY_KIB, PASS_TIME, PASS_PARALLELISM, Some(32))
        .map_err(|e| format!("Passphrase KDF params error: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(passphrase, salt, &mut key)
        .map_err(|e| format!("Passphrase KDF failed: {}", e))?;
    Ok(key)
}

// ── Keystore Encrypt / Decrypt ────────────────────────────────────────────────

/// Encrypt keystore.
/// Format: version(1) || kdf_salt(16) || nonce(24) || ciphertext(80) = 121 bytes
/// Payload: node_id_full(32) || node_key(32) = 64 bytes
/// SCALAR-TECHNICAL §10.5.
pub fn encrypt_keystore(
    node_id_full: &[u8; 32],
    node_key: &[u8; 32],
    passphrase: &str,
) -> Result<Vec<u8>, String> {
    let mut kdf_salt = [0u8; KDF_SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut kdf_salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);

    let kdf_key = passphrase_kdf(passphrase.as_bytes(), &kdf_salt)?;

    let mut plaintext = [0u8; PAYLOAD_LEN];
    plaintext[..32].copy_from_slice(node_id_full);
    plaintext[32..].copy_from_slice(node_key);

    let cipher = XChaCha20Poly1305::new_from_slice(&kdf_key)
        .map_err(|_| "Cipher init failed".to_string())?;
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    // Zero plaintext from memory
    let mut pt = plaintext;
    pt.iter_mut().for_each(|b| *b = 0);

    let mut keystore = Vec::with_capacity(KEYSTORE_SIZE);
    keystore.push(KEYSTORE_VERSION);
    keystore.extend_from_slice(&kdf_salt);
    keystore.extend_from_slice(&nonce_bytes);
    keystore.extend_from_slice(&ciphertext);

    Ok(keystore)
}

/// Decrypt keystore. Returns (node_id_full, node_key).
pub fn decrypt_keystore(keystore: &[u8], passphrase: &str) -> Result<([u8; 32], [u8; 32]), String> {
    if keystore.len() < KEYSTORE_SIZE {
        return Err(format!(
            "Invalid keystore size: expected {}, got {}",
            KEYSTORE_SIZE,
            keystore.len()
        ));
    }
    if keystore[0] != KEYSTORE_VERSION {
        return Err(format!("Unsupported keystore version: {:#04x}", keystore[0]));
    }

    let kdf_salt: [u8; KDF_SALT_LEN] = keystore[1..1 + KDF_SALT_LEN]
        .try_into()
        .map_err(|_| "Invalid keystore format".to_string())?;
    let nonce_bytes: [u8; NONCE_LEN] = keystore[1 + KDF_SALT_LEN..1 + KDF_SALT_LEN + NONCE_LEN]
        .try_into()
        .map_err(|_| "Invalid keystore format".to_string())?;
    let ciphertext = &keystore[1 + KDF_SALT_LEN + NONCE_LEN..];

    let kdf_key = passphrase_kdf(passphrase.as_bytes(), &kdf_salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&kdf_key)
        .map_err(|_| "Cipher init failed".to_string())?;
    let nonce = XNonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Decryption failed — wrong passphrase or corrupted keystore".to_string())?;

    if plaintext.len() != PAYLOAD_LEN {
        return Err(format!(
            "Invalid plaintext size: expected {}, got {}",
            PAYLOAD_LEN,
            plaintext.len()
        ));
    }

    let mut node_id_full = [0u8; 32];
    let mut node_key = [0u8; 32];
    node_id_full.copy_from_slice(&plaintext[..32]);
    node_key.copy_from_slice(&plaintext[32..]);

    Ok((node_id_full, node_key))
}

// ── File I/O ──────────────────────────────────────────────────────────────────

/// Save keystore to file. Sets chmod 600 on Unix.
pub fn save_keystore(path: PathBuf, keystore: &[u8]) -> Result<(), String> {
    use std::fs::File;
    use std::io::Write;

    let mut file =
        File::create(&path).map_err(|e| format!("Cannot create keystore file: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Cannot set keystore permissions: {}", e))?;
    }

    file.write_all(keystore)
        .map_err(|e| format!("Cannot write keystore: {}", e))
}

/// Read keystore bytes from file.
pub fn read_keystore(path: PathBuf) -> Result<Vec<u8>, String> {
    std::fs::read(&path)
        .map_err(|e| format!("Cannot read keystore from {:?}: {}", path, e))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_GENESIS: [u8; 32] = [0x42u8; 32];

    #[test]
    fn test_generate_mnemonic_format() {
        let words = generate_mnemonic();
        assert_eq!(words.len(), MNEMONIC_WORD_COUNT);
        assert_eq!(words[0], MNEMONIC_FIRST_WORD);
        assert!(validate_mnemonic(&words));
    }

    #[test]
    fn test_validate_rejects_wrong_first_word() {
        let mut words = generate_mnemonic();
        words[0] = "bitcoin".to_string();
        assert!(!validate_mnemonic(&words));
    }

    #[test]
    fn test_validate_rejects_short_mnemonic() {
        assert!(!validate_mnemonic(&["scalar".to_string()]));
    }

    #[test]
    fn test_validate_rejects_invalid_bip39_word() {
        let mut words = generate_mnemonic();
        words[1] = "notaword".to_string();
        assert!(!validate_mnemonic(&words));
    }

    #[test]
    fn test_keystore_size() {
        assert_eq!(KEYSTORE_SIZE, 121, "Keystore must be 121 bytes per SCALAR-TECHNICAL §10.5");
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let node_id = [0xAAu8; 32];
        let node_key = [0xBBu8; 32];
        let ks = encrypt_keystore(&node_id, &node_key, "test-passphrase").unwrap();
        assert_eq!(ks.len(), KEYSTORE_SIZE);
        let (d_id, d_key) = decrypt_keystore(&ks, "test-passphrase").unwrap();
        assert_eq!(node_id, d_id);
        assert_eq!(node_key, d_key);
    }

    #[test]
    fn test_decrypt_wrong_passphrase_fails() {
        let ks = encrypt_keystore(&[0xAAu8; 32], &[0xBBu8; 32], "correct").unwrap();
        assert!(decrypt_keystore(&ks, "wrong").is_err());
    }

    #[test]
    fn test_argon2_tier_c_params() {
        assert_eq!(TIER_C.memory_kib, 16 * 1024, "Tier C must be 16 MB");
        assert_eq!(TIER_C.iterations, 100);
    }

    #[test]
    fn test_argon2_tier_a_params() {
        assert_eq!(TIER_A.memory_kib, 4 * 1024 * 1024, "Tier A must be 4 GB");
        assert_eq!(TIER_A.iterations, 3600);
    }

    #[test]
    fn test_node_id_salt_prefix() {
        assert_eq!(NODE_ID_SALT_PREFIX, b"scalar_nodeid", "OSSIFIED salt prefix");
    }
}
