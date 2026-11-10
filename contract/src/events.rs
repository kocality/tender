//! NEP-297 events (C24, WD-15): `EVENT_JSON:{"standard":"tender","version":"1.0.0","event":…,
//! "data":[…]}`. `data` is always a one-element array. No ciphertexts or other large fields.
use near_sdk::env;
use near_sdk::serde_json::{Value, json};

pub const STANDARD: &str = "tender";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let line = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{line}"));
}
