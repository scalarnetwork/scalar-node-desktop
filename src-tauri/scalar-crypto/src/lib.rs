// Scalar Crypto Library - placeholder
// Modul-modul akan dilengkapi setelah file asli diunggah

pub mod blake3;

// Modul yang akan datang
// pub mod keygen;
// pub mod keystore;
// pub mod constants;

// Re-export fungsi utama
pub use crate::blake3::hash;
pub use crate::blake3::keyed_hash;
pub use crate::blake3::HASH_SIZE;
