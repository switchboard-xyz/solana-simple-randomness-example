use std::collections::HashMap;

use crate::*;
use aes_gcm::{aead::Aead, Aes256Gcm, Key, KeyInit, Nonce};
use rand::rngs::OsRng;
use reqwest;
use rsa::{pkcs8::ToPublicKey, PaddingScheme, RsaPrivateKey, RsaPublicKey};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
struct EncryptedData {
    key: String,
    nonce: String,
    data: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
pub struct SwitchboardSecret {
    pub secrets: HashMap<String, String>,
}

fn handle_reqwest_err(e: reqwest::Error) -> SbError {
    let status = e.status().unwrap_or(reqwest::StatusCode::default());
    println!(
        "reqwest_error: code = {}, message = {}",
        status,
        status.canonical_reason().unwrap_or("Unknown")
    );
    SbError::CustomError {
        message: format!(
            "reqwest_error: code = {}, message = {}",
            status,
            status.canonical_reason().unwrap_or("Unknown")
        ),
        source: std::sync::Arc::new(e),
    }
}

impl SwitchboardSecret {
    pub async fn fetch(user_pubkey: &str, secret_name: &str) -> Result<Self, SbError> {
        // Generate quote for this request and pass along a public key with your request.
        let mut os_rng = OsRng::default();
        let priv_key = RsaPrivateKey::new(&mut os_rng, 2048).map_err(|_| SbError::KeyParseError)?;
        let pub_key = RsaPublicKey::from(&priv_key)
            .to_public_key_der()
            .map_err(|_| SbError::KeyParseError)?;

        // The quote is generated around the public encryption key so that the server can validate
        // that the request has not been tampered with.
        let secrets_quote =
            Gramine::generate_quote(pub_key.as_ref()).map_err(|_| SbError::SgxError)?;
        // Request the encrypted secret.
        let payload = json!({
            "user_pubkey": user_pubkey,
            "ciphersuite": "ed25519",
            "secret_name": secret_name,
            "encryption_key": pub_key.to_pem().as_str(),
            "quote": &secrets_quote,
        });
        let response = reqwest::Client::new()
            .post("https://api.secrets.switchboard.xyz/")
            .json(&payload)
            .send()
            .await
            .map_err(handle_reqwest_err)?
            .error_for_status()
            .map_err(handle_reqwest_err)?;
        let encrypted_data = response
            .json::<EncryptedData>()
            .await
            .map_err(handle_reqwest_err)?;

        // First we need to decode and decrypt the encryption key.
        let key = match base64::decode(encrypted_data.key) {
            Ok(value) => value,
            Err(err) => {
                let error_msg = format!("Base64DecodeError: {:#?}", err);
                println!("{}", error_msg);
                return Err(SbError::CustomMessage(error_msg));
            }
        };
        let key = match priv_key.decrypt(PaddingScheme::PKCS1v15Encrypt, &key) {
            Ok(value) => Key::<Aes256Gcm>::clone_from_slice(&value),
            Err(err) => {
                let error_msg = format!("DecryptKeyError: {:#?}", err);
                println!("{}", error_msg);
                return Err(SbError::CustomMessage(error_msg));
            }
        };
        // Second we need to decode the nonce value from the encrypted data.
        let nonce = match base64::decode(encrypted_data.nonce) {
            Ok(value) => Nonce::clone_from_slice(&value),
            Err(err) => {
                let error_msg = format!("Base64DecodeError: {:#?}", err);
                println!("{}", error_msg);
                return Err(SbError::CustomMessage(error_msg));
            }
        };
        // Lastly, we can use our decrypted key and nonce values to decode and decrypt the payload.
        let data = match base64::decode(encrypted_data.data) {
            Ok(value) => value,
            Err(err) => {
                let error_msg = format!("Base64DecodeError: {:#?}", err);
                println!("{}", error_msg);
                return Err(SbError::CustomMessage(error_msg));
            }
        };
        let data = match Aes256Gcm::new(&key).decrypt(&nonce, data.as_ref()) {
            Ok(value) => value,
            Err(err) => {
                let error_msg = format!("Aes256GcmError: {:#?}", err);
                println!("{}", error_msg);
                return Err(SbError::CustomMessage(error_msg));
            }
        };

        let secrets: HashMap<String, String> = serde_json::from_slice(&data)?;
        Ok(Self { secrets })
    }
}
