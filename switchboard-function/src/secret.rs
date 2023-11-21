use crate::*;
use rand::rngs::OsRng;
use reqwest;
use rsa::{ pkcs8::ToPublicKey, PaddingScheme, RsaPrivateKey, RsaPublicKey };
use serde_json::json;

pub struct ContainerSecret {
    pub value: String,
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
        let payload =
            json!({
            "quote": &secrets_quote,
            "user_pubkey": user_pubkey,
            "secret_name": secret_name,
        });
        let res = reqwest::Client
            ::new()
            .get("https://api.secrets.switchboard.xyz/")
            .json(&payload)
            .send().await
            .map_err(|_| SbError::NetworkError)?;

        return Err(
            SbError::CustomMessage("Need to parse out value from http response.".to_string())
        );
    }
}
