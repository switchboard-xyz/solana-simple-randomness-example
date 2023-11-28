use crate::*;
use kv_log_macro::error;
use rand::rngs::OsRng;
use reqwest;
use rsa::{pkcs8::ToPublicKey, PaddingScheme, RsaPrivateKey, RsaPublicKey};
use serde_json::json;

pub struct ContainerSecret {
    pub value: String,
}

fn handle_reqwest_err(e: reqwest::Error) -> SbError {
    let status = e.status().unwrap_or(reqwest::StatusCode::default());
    error!(
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

impl ContainerSecret {
    pub async fn fetch(user_pubkey: &str, secret_name: &str) -> Result<Self, SbError> {
        // Generate quote for the current enclave
        let mut os_rng = OsRng::default();
        let priv_key = RsaPrivateKey::new(&mut os_rng, 2048).map_err(|_| SbError::KeyParseError)?;
        let pub_key = RsaPublicKey::from(&priv_key)
            .to_public_key_der()
            .map_err(|_| SbError::KeyParseError)?;
        let pub_key: &[u8] = pub_key.as_ref();
        let secrets_quote = Gramine::generate_quote(pub_key).map_err(|_| SbError::SgxError)?;

        // Request the secret
        let payload = json!({
            "quote": &secrets_quote,
            "user_pubkey": user_pubkey,
            "secret_name": secret_name,
        });
        let response = reqwest::Client::new()
            .get("https://api.secrets.switchboard.xyz/")
            .json(&payload)
            .send()
            .await
            .map_err(handle_reqwest_err)?
            .error_for_status()
            .map_err(handle_reqwest_err)?;
        // Get the response json as a string
        let value = response.json().await.map_err(handle_reqwest_err)?;
        Ok(Self { value })
    }
}
