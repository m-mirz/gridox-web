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

    #[wasm_bindgen(js_name = skipFile)]
    pub fn skip_file(&mut self, name: &str, reason: &str) {
        self.0.skip_file(name, reason);
    }

    /// The session's [`Summary`], as JSON.
    pub fn summary(&self) -> Result<String, JsError> {
        Ok(serde_json::to_string(&self.0.summary())?)
    }

    pub fn grid(&mut self) -> String {
        self.0.grid().to_string()
    }

    pub fn inside(&mut self, id: &str) -> String {
        self.0.inside(id).to_string()
    }

    /// The tree's sections without a `key`, else that node's children.
    pub fn children(&mut self, key: Option<String>) -> String {
        self.0.children(key.as_deref()).to_string()
    }

    pub fn search(&mut self, query: &str) -> String {
        self.0.search(query).to_string()
    }

    pub fn path(&mut self, id: &str) -> String {
        self.0.path(id).to_string()
    }

    pub fn object(&mut self, id: &str) -> String {
        self.0.object(id).to_string()
    }
}
