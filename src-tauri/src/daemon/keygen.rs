//! Keygen — Mnemonic generation, BLAKE3 NodeID derivation, keystore encryption
//!
//! SCALAR-PROTOCOL §3.1: NodeID = BLAKE3(b"scalar_nodeid" || mnemonic || genesis_hash)
//! SCALAR-TECHNICAL §10.5: Keystore KDF = Argon2id(passphrase, salt, 64 MB, 3 iter)
//! SCALAR-PROTOCOL §11.1: Wallet KDF = Argon2id(mnemonic, prefix||genesis, 64 MB, 3 iter)
//!
//! Argon2id dipertahankan HANYA untuk:
//!   - Passphrase KDF (proteksi keystore di disk)
//!   - Wallet seed derivation (§11.1)
//!
//! NodeID derivation menggunakan BLAKE3 (< 1 ms, deterministik, semua node sama).

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

// ── Mnemonic constants — SCALAR-PROTOCOL §3.1 ────────────────────────────────
pub const MNEMONIC_WORD_COUNT: usize = 24;
pub const MNEMONIC_FREE_WORDS: usize = 23; // kata ke-2 sampai ke-24
pub const MNEMONIC_FIRST_WORD: &str = "scalar";

// ── Domain separators — SCALAR-PROTOCOL §2.3 (OSSIFIED) ──────────────────────
/// b"scalar_nodeid" — NodeID BLAKE3 domain separator. OSSIFIED.
const NODE_ID_DOMAIN: &[u8] = b"scalar_nodeid";
/// b"scalar_wallet_kdf" — Wallet seed derivation salt prefix. OSSIFIED.
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

// ── Mnemonic ──────────────────────────────────────────────────────────────────

/// Generate a 24-word Scalar mnemonic: "scalar" + 23 random BIP-39 words.
/// Uses OsRng (CSPRNG) for 253-bit effective entropy (23 × 11 bits).
/// SCALAR-PROTOCOL §3.1.
pub fn generate_mnemonic() -> Vec<String> {
    let wordlist = Language::English.word_list();
    let mut rng = rand::rngs::OsRng;
    let mut words = vec![MNEMONIC_FIRST_WORD.to_string()];
    for _ in 0..MNEMONIC_FREE_WORDS {
        let mut buf = [0u8; 4];
        rng.fill_bytes(&mut buf);
        let idx = (u32::from_le_bytes(buf) as usize) % wordlist.len();
        words.push(wordlist[idx].to_string());
    }
    words
}

/// Validate mnemonic:
///   - Must be 24 words (SCALAR-PROTOCOL §3.1)
///   - First word must be "scalar"
///   - Words 2-24 must be in BIP-39 English wordlist
pub fn validate_mnemonic(words: &[String]) -> bool {
    if words.len() != MNEMONIC_WORD_COUNT {
        return false;
    }
    if words[0] != MNEMONIC_FIRST_WORD {
        return false;
    }
    let wordset: std::collections::HashSet<&str> =
        Language::English.word_list().iter().copied().collect();
    // First word "scalar" is not in BIP-39 — only validate words 2-24
    words[1..].iter().all(|w| wordset.contains(w.as_str()))
}

// ── NodeID Derivation — BLAKE3 — SCALAR-PROTOCOL §3.1 ────────────────────────

/// Derive NodeID from mnemonic string and genesis_hash using BLAKE3.
///
/// SCALAR-PROTOCOL §3.1, SCALAR-TECHNICAL §10.5:
///   node_id_full = BLAKE3(b"scalar_nodeid" || mnemonic || genesis_hash)
///
/// Domain separator b"scalar_nodeid" is OSSIFIED — SCALAR-PROTOCOL §2.3.
/// Identical derivation for all nodes. No tier distinction.
/// Derivation time: < 1 ms.
pub fn derive_node_id(mnemonic: &str, genesis_hash: &[u8; 32]) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(NODE_ID_DOMAIN);
    hasher.update(mnemonic.as_bytes());
    hasher.update(genesis_hash);
    hasher.finalize().into()
}

// ── NodeKey Derivation — Argon2id + BLAKE3 chain — SCALAR-PROTOCOL §11.1 ─────

/// Derive NodeKey from mnemonic + genesis_hash via wallet key chain.
///
/// SCALAR-PROTOCOL §11.1 (OSSIFIED):
///   seed       = Argon2id(mnemonic, b"scalar_wallet_kdf"||genesis_hash, 64MB, 3, 1) → 64B
///   MasterKey  = BLAKE3(seed || b"scalar_master")
///   AccountKey = BLAKE3(MasterKey || b"account" || 0_le64)
///   NodeKey    = BLAKE3(AccountKey || b"node")
pub fn derive_node_key(mnemonic: &[String], genesis_hash: &[u8; 32]) -> Result<[u8; 32], String> {
    let mnemonic_str = mnemonic.join(" ");

    let mut wallet_salt = Vec::with_capacity(WALLET_KDF_PREFIX.len() + 32);
    wallet_salt.extend_from_slice(WALLET_KDF_PREFIX);
    wallet_salt.extend_from_slice(genesis_hash);

    let params = Params::new(
        WALLET_MEMORY_KIB,
        WALLET_TIME,
        WALLET_PARALLELISM,
        Some(WALLET_OUTPUT_LEN),
    )
    .map_err(|e| format!("Argon2 wallet params error: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut seed = [0u8; WALLET_OUTPUT_LEN];
    argon2
        .hash_password_into(mnemonic_str.as_bytes(), &wallet_salt, &mut seed)
        .map_err(|e| format!("Wallet seed derivation failed: {}", e))?;

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

    // Zero seed from memory
    seed.iter_mut().for_each(|b| *b = 0);

    Ok(node_key)
}

// ── All Keys Derivation (single Argon2id pass) ───────────────────────────────────

/// All keys derived from mnemonic in a single Argon2id pass.
pub struct AllKeys {
    pub node_key: [u8; 32],
    pub spend_key: [u8; 32],
    pub view_key: [u8; 32],
}

/// Derive NodeKey, SpendKey, and ViewKey from mnemonic + genesis_hash.
/// Single Argon2id call (64MB, ~30 seconds). SCALAR-PROTOCOL §11.1.
pub fn derive_all_keys(mnemonic: &[String], genesis_hash: &[u8; 32]) -> Result<AllKeys, String> {
    let mnemonic_str = mnemonic.join(" ");

    let mut wallet_salt = Vec::with_capacity(WALLET_KDF_PREFIX.len() + 32);
    wallet_salt.extend_from_slice(WALLET_KDF_PREFIX);
    wallet_salt.extend_from_slice(genesis_hash);

    let params = Params::new(
        WALLET_MEMORY_KIB,
        WALLET_TIME,
        WALLET_PARALLELISM,
        Some(WALLET_OUTPUT_LEN),
    )
    .map_err(|e| format!("Argon2 wallet params error: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut seed = [0u8; WALLET_OUTPUT_LEN];
    argon2
        .hash_password_into(mnemonic_str.as_bytes(), &wallet_salt, &mut seed)
        .map_err(|e| format!("Wallet seed derivation failed: {}", e))?;

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
    let spend_key: [u8; 32] = {
        let mut h = blake3::Hasher::new();
        h.update(&account_key);
        h.update(b"spend");
        *h.finalize().as_bytes()
    };
    let view_key: [u8; 32] = {
        let mut h = blake3::Hasher::new();
        h.update(&account_key);
        h.update(b"view");
        *h.finalize().as_bytes()
    };

    // Zero seed from memory
    seed.iter_mut().for_each(|b| *b = 0);

    Ok(AllKeys {
        node_key,
        spend_key,
        view_key,
    })
}

// ── Passphrase KDF ──────────────────────────────────────────────────────────────

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
        return Err(format!(
            "Unsupported keystore version: {:#04x}",
            keystore[0]
        ));
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
    std::fs::read(&path).map_err(|e| format!("Cannot read keystore from {:?}: {}", path, e))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_GENESIS: [u8; 32] = [0x42u8; 32];
    const TEST_MNEMONIC_24: &str = "scalar abandon ability able about above absent \
        absorb abstract absurd abuse access accident account accuse achieve acid \
        acoustic acquire across act action actor actual";

    #[test]
    fn test_generate_mnemonic_format() {
        let words = generate_mnemonic();
        assert_eq!(words.len(), MNEMONIC_WORD_COUNT, "Must be 24 words");
        assert_eq!(words[0], MNEMONIC_FIRST_WORD);
        assert!(validate_mnemonic(&words));
    }

    #[test]
    fn test_mnemonic_word_count_is_24() {
        assert_eq!(MNEMONIC_WORD_COUNT, 24);
        assert_eq!(MNEMONIC_FREE_WORDS, 23);
    }

    #[test]
    fn test_validate_rejects_12_words() {
        // 12 kata tidak valid. SCALAR-PROTOCOL §3.1.
        let words: Vec<String> = (0..12).map(|_| "abandon".to_string()).collect();
        assert!(!validate_mnemonic(&words));
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
    fn test_derive_all_keys_deterministic() {
        let mnemonic: Vec<String> = TEST_MNEMONIC_24
            .split_whitespace()
            .map(String::from)
            .collect();
        let k1 = derive_all_keys(&mnemonic, &TEST_GENESIS).unwrap();
        let k2 = derive_all_keys(&mnemonic, &TEST_GENESIS).unwrap();
        assert_eq!(k1.node_key, k2.node_key);
        assert_eq!(k1.spend_key, k2.spend_key);
        assert_eq!(k1.view_key, k2.view_key);
        assert_ne!(
            k1.node_key, k1.spend_key,
            "NodeKey must differ from SpendKey"
        );
        assert_ne!(
            k1.spend_key, k1.view_key,
            "SpendKey must differ from ViewKey"
        );
    }

    #[test]
    fn test_derive_node_id_deterministic() {
        // Same inputs → same output. SCALAR-PROTOCOL §3.1.
        let id1 = derive_node_id(TEST_MNEMONIC_24, &TEST_GENESIS);
        let id2 = derive_node_id(TEST_MNEMONIC_24, &TEST_GENESIS);
        assert_eq!(id1, id2, "NodeID must be deterministic");
    }

    #[test]
    fn test_derive_node_id_not_zero() {
        let id = derive_node_id(TEST_MNEMONIC_24, &TEST_GENESIS);
        assert_ne!(id, [0u8; 32], "NodeID must not be zero");
    }

    #[test]
    fn test_derive_node_id_domain_separator_ossified() {
        // OSSIFIED — SCALAR-PROTOCOL §2.3.
        assert_eq!(NODE_ID_DOMAIN, b"scalar_nodeid");
    }

    #[test]
    fn test_derive_node_id_different_genesis() {
        let id1 = derive_node_id(TEST_MNEMONIC_24, &[0x01u8; 32]);
        let id2 = derive_node_id(TEST_MNEMONIC_24, &[0x02u8; 32]);
        assert_ne!(id1, id2, "Different genesis → different NodeID");
    }

    #[test]
    fn test_keystore_size() {
        assert_eq!(
            KEYSTORE_SIZE, 121,
            "Keystore must be 121 bytes per SCALAR-TECHNICAL §10.5"
        );
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
}
