use crate::*;
use rand::rngs::OsRng;
use reqwest;
use rsa::{pkcs8::ToPublicKey, PaddingScheme, RsaPrivateKey, RsaPublicKey};
use serde_json::json;

pub struct SwitchboardSecret {
    pub value: String,
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
        // The quote is generated with the public encryption key so that the server can validate
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
            .await;
        let response = response
            .map_err(handle_reqwest_err)?
            .error_for_status()
            .map_err(handle_reqwest_err)?;
        // Our encrypted response is encoded as a base64 string.
        let encoded: String = response.json().await.map_err(handle_reqwest_err)?;
        let encrypted = match base64::decode(encoded) {
            Ok(value) => value,
            Err(err) => {
                let error_msg = format!("Base64DecodeError: {:#?}", err);
                println!("{}", error_msg);
                return Err(SbError::CustomMessage(error_msg));
            }
        };
        let decrypted = match priv_key.decrypt(PaddingScheme::PKCS1v15Encrypt, &encrypted) {
            Ok(value) => value,
            Err(err) => {
                let error_msg = format!("DecryptError: {:#?}", err);
                println!("{}", error_msg);
                return Err(SbError::CustomMessage(error_msg));
            }
        };
        // Encode the decrypted data as a UTF8 string and return.
        match String::from_utf8(decrypted) {
            Ok(value) => Ok(Self { value }),
            Err(err) => {
                let error_msg = format!("FromUtf8Error: {:#?}", err);
                println!("{}", error_msg);
                return Err(SbError::CustomMessage(error_msg));
            }
        }
    }
}
