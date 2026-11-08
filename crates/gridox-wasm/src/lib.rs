//! What the web worker calls. Thin on purpose: JSON in and out over the libraries' APIs.

mod session;

pub use session::{ClassCount, FileOutcome, Session, Summary};

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// A [`Session`], as JavaScript holds it.
#[wasm_bindgen(js_name = Session)]
#[derive(Default)]
pub struct JsSession(Session);

#[wasm_bindgen(js_class = Session)]
impl JsSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[wasm_bindgen(js_name = addFile)]
    pub fn add_file(&mut self, name: &str, text: &str) {
        self.0.add_file(name, text);
    }

    /// The session's [`Summary`], as JSON.
    pub fn summary(&self) -> Result<String, JsError> {
        Ok(serde_json::to_string(&self.0.summary())?)
    }
}
