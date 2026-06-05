//! Keygen — Mnemonic generation, Argon2id derivation, keystore encryption
//!
//! Implements SCALAR-TECHNICAL §10.5
//! Tier C (development): 16 MB, 100 iterations, ~1-5 min
//! Tier A (production): 4 GB, 3600 iterations, ~60 min

use argon2::Argon2;
use bip39::Language;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use std::path::PathBuf;

pub const KEYSTORE_VERSION: u8 = 0x01;
pub const KEYSTORE_SIZE: usize = 105;
pub const PLAINTEXT_SIZE: usize = 48;
pub const MNEMONIC_WORD_COUNT: usize = 12;
pub const MNEMONIC_FIRST_WORD: &str = "scalar";

#[derive(Debug, Clone)]
pub struct Argon2Tier {
    pub memory_kb: u32,
    pub iterations: u32,
    pub label: &'static str,
}

pub const TIER_A: Argon2Tier = Argon2Tier {
    memory_kb: 4_194_304,
    iterations: 3600,
    label: "Tier A (mainnet)",
};

pub const TIER_C: Argon2Tier = Argon2Tier {
    memory_kb: 16_384,
    iterations: 100,
    label: "Tier C (development)",
};

pub fn generate_mnemonic() -> Vec<String> {
    let mut words = vec![MNEMONIC_FIRST_WORD.to_string()];
    let wordlist = Language::English.word_list();
    let word_count = wordlist.len() as u32;
    for _ in 0..11 {
        let idx = rand::random::<u32>() % word_count;
        words.push(wordlist[idx as usize].to_string());
    }
    words
}

pub fn validate_mnemonic(words: &[String]) -> bool {
    if words.len() != MNEMONIC_WORD_COUNT { return false; }
    if words[0] != MNEMONIC_FIRST_WORD { return false; }
    let wordlist = Language::English.word_list();
    words.iter().all(|w| wordlist.iter().any(|&word| word == w.as_str()))
}

pub fn derive_node_id_full(
    mnemonic: &[String],
    genesis_hash: &[u8; 32],
    tier: &Argon2Tier,
) -> Result<[u8; 32], String> {
    let mnemonic_str = mnemonic.join(" ");
    let seed = blake3::hash(mnemonic_str.as_bytes());
    let mut node_id_full = [0u8; 32];
    let params = argon2::ParamsBuilder::new()
        .m_cost(tier.memory_kb / 1024)
        .t_cost(tier.iterations)
        .p_cost(1)
        .output_len(32)
        .build()
        .map_err(|e| format!("Argon2 params error: {}", e))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon2
        .hash_password_into(seed.as_bytes(), genesis_hash, &mut node_id_full)
        .map_err(|e| format!("Argon2id failed: {}", e))?;
    Ok(node_id_full)
}

pub fn generate_node_key_seed() -> [u8; 16] {
    let mut seed = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut seed);
    seed
}

pub fn encrypt_keystore(
    node_id_full: &[u8; 32],
    node_key_seed: &[u8; 16],
    passphrase: &str,
) -> Result<Vec<u8>, String> {
    let mut plaintext = Vec::with_capacity(PLAINTEXT_SIZE);
    plaintext.extend_from_slice(node_id_full);
    plaintext.extend_from_slice(node_key_seed);
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let mut kdf_key = [0u8; 32];
    let argon2_kdf = Argon2::default();
    argon2_kdf
        .hash_password_into(passphrase.as_bytes(), &salt, &mut kdf_key)
        .map_err(|e| format!("Passphrase KDF failed: {}", e))?;
    let key = chacha20poly1305::Key::from_slice(&kdf_key);
    let cipher = XChaCha20Poly1305::new(key);
    let mut xnonce_bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut xnonce_bytes);
    let xnonce = XNonce::from_slice(&xnonce_bytes);
    let ciphertext = cipher
        .encrypt(xnonce, plaintext.as_slice())
        .map_err(|e| format!("Encryption failed: {}", e))?;
    let mut keystore = Vec::with_capacity(KEYSTORE_SIZE);
    keystore.push(KEYSTORE_VERSION);
    keystore.extend_from_slice(&salt);
    keystore.extend_from_slice(&xnonce_bytes);
    keystore.extend_from_slice(&ciphertext);
    Ok(keystore)
}

pub fn decrypt_keystore(keystore: &[u8], passphrase: &str) -> Result<([u8; 32], [u8; 16]), String> {
    if keystore.len() != KEYSTORE_SIZE {
        return Err(format!("Invalid keystore size: expected {}, got {}", KEYSTORE_SIZE, keystore.len()));
    }
    let version = keystore[0];
    if version != KEYSTORE_VERSION {
        return Err(format!("Unsupported keystore version: {}", version));
    }
    let salt = &keystore[1..17];
    let xnonce_bytes = &keystore[17..41];
    let ciphertext = &keystore[41..105];
    let mut kdf_key = [0u8; 32];
    let argon2_kdf = Argon2::default();
    argon2_kdf
        .hash_password_into(passphrase.as_bytes(), salt, &mut kdf_key)
        .map_err(|e| format!("Passphrase KDF failed: {}", e))?;
    let key = chacha20poly1305::Key::from_slice(&kdf_key);
    let cipher = XChaCha20Poly1305::new(key);
    let xnonce = XNonce::from_slice(xnonce_bytes);
    let plaintext = cipher
        .decrypt(xnonce, ciphertext)
        .map_err(|_| "Decryption failed: wrong passphrase or corrupted keystore".to_string())?;
    if plaintext.len() != PLAINTEXT_SIZE {
        return Err(format!("Invalid plaintext size: expected {}, got {}", PLAINTEXT_SIZE, plaintext.len()));
    }
    let mut node_id_full = [0u8; 32];
    let mut node_key_seed = [0u8; 16];
    node_id_full.copy_from_slice(&plaintext[0..32]);
    node_key_seed.copy_from_slice(&plaintext[32..48]);
    Ok((node_id_full, node_key_seed))
}

/// Save keystore to file. On Unix, sets restrictive permissions (chmod 600).
pub fn save_keystore(path: PathBuf, keystore: &[u8]) -> Result<(), String> {
    use std::fs::File;
    use std::io::Write;

    let mut file = File::create(&path)
        .map_err(|e| format!("Cannot create keystore: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o600);
        file.set_permissions(permissions)
            .map_err(|e| format!("Cannot set permissions: {}", e))?;
    }

    file.write_all(keystore)
        .map_err(|e| format!("Cannot write keystore: {}", e))?;

    Ok(())
}

pub fn read_keystore(path: PathBuf) -> Result<Vec<u8>, String> {
    std::fs::read(&path)
        .map_err(|e| format!("Cannot read keystore from {:?}: {}", path, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_mnemonic() {
        let words = generate_mnemonic();
        assert_eq!(words.len(), MNEMONIC_WORD_COUNT);
        assert_eq!(words[0], MNEMONIC_FIRST_WORD);
        assert!(validate_mnemonic(&words));
    }

    #[test]
    fn test_validate_mnemonic_rejects_invalid() {
        assert!(!validate_mnemonic(&vec!["scalar".to_string()]));
    }

    #[test]
    fn test_encrypt_decrypt_keystore() {
        let id = [0xAAu8; 32];
        let seed = [0xBBu8; 16];
        let ks = encrypt_keystore(&id, &seed, "test").unwrap();
        assert_eq!(ks.len(), KEYSTORE_SIZE);
        let (d_id, d_seed) = decrypt_keystore(&ks, "test").unwrap();
        assert_eq!(id, d_id);
        assert_eq!(seed, d_seed);
    }

    #[test]
    fn test_decrypt_wrong_passphrase() {
        let ks = encrypt_keystore(&[0xAAu8; 32], &[0xBBu8; 16], "correct").unwrap();
        assert!(decrypt_keystore(&ks, "wrong").is_err());
    }
}
