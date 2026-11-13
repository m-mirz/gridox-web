//! What the web worker calls. Thin on purpose: JSON in and out over the libraries' APIs.

mod session;

pub use session::{Checks, ClassCount, FileOutcome, PowerFlowOptions, Session, Summary};

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
    #[wasm_bindgen(js_name = children)]
    pub fn children(&mut self, key: Option<String>, only_findings: bool) -> String {
        self.0.children(key.as_deref(), only_findings).to_string()
    }

    pub fn search(&mut self, query: &str) -> String {
        self.0.search(query).to_string()
    }

    pub fn path(&mut self, id: &str, only_findings: bool) -> String {
        self.0.path(id, only_findings).to_string()
    }

    pub fn object(&mut self, id: &str) -> String {
        self.0.object(id).to_string()
    }

    #[wasm_bindgen(js_name = checkFile)]
    pub fn check_file(&mut self, name: &str, text: &str) -> Result<(), JsError> {
        self.0.check_file(name, text).map_err(|e| JsError::new(&e))
    }

    pub fn validate(&mut self, common: bool, quality: bool) -> String {
        self.0.validate(Checks { common, quality }).to_string()
    }

    pub fn findings(&self) -> String {
        self.0.findings().to_string()
    }

    pub fn contingencies(&mut self) -> String {
        self.0.contingencies().to_string()
    }

    #[wasm_bindgen(js_name = remedialActions)]
    pub fn remedial_actions(&mut self) -> String {
        self.0.remedial_actions().to_string()
    }

    #[wasm_bindgen(js_name = assessedElements)]
    pub fn assessed_elements(&mut self) -> String {
        self.0.assessed_elements().to_string()
    }

    /// A power flow, the imbalance taken by `sharing` (`reference`, `capability` or `equal`), with
    /// reactive limits held if `q_limits`.
    #[wasm_bindgen(js_name = powerFlow)]
    pub fn power_flow(&mut self, sharing: &str, q_limits: bool) -> Result<String, JsError> {
        let sharing = sharing.parse().map_err(|e: String| JsError::new(&e))?;
        let options = PowerFlowOptions { sharing, q_limits };
        Ok(self.0.power_flow(options).to_string())
    }

    /// Readies a security analysis of the contingencies loaded; see [`Session::analysis_start`].
    #[wasm_bindgen(js_name = analysisStart)]
    pub fn analysis_start(&mut self, sharing: &str, q_limits: bool) -> Result<String, JsError> {
        let sharing = sharing.parse().map_err(|e: String| JsError::new(&e))?;
        Ok(self
            .0
            .analysis_start(PowerFlowOptions { sharing, q_limits })
            .to_string())
    }

    #[wasm_bindgen(js_name = analysisStep)]
    pub fn analysis_step(&mut self, count: usize) -> String {
        self.0.analysis_step(count).to_string()
    }

    #[wasm_bindgen(js_name = editState)]
    pub fn edit_state(&self) -> String {
        self.0.edit_state().to_string()
    }

    #[wasm_bindgen(js_name = fileText)]
    pub fn file_text(&self, name: &str) -> Option<String> {
        self.0.file_text(name).map(str::to_string)
    }

    #[wasm_bindgen(js_name = editUndo)]
    pub fn edit_undo(&mut self) -> String {
        self.0.edit_undo().to_string()
    }

    #[wasm_bindgen(js_name = editRename)]
    pub fn edit_rename(&mut self, old: &str, new: &str) -> String {
        self.0.edit_rename(old, new).to_string()
    }

    #[wasm_bindgen(js_name = editDeletePreview)]
    pub fn edit_delete_preview(&mut self, id: &str, contained: bool) -> String {
        self.0.edit_delete_preview(id, contained).to_string()
    }

    #[wasm_bindgen(js_name = editDelete)]
    pub fn edit_delete(&mut self, id: &str, contained: bool) -> String {
        self.0.edit_delete(id, contained).to_string()
    }

    #[wasm_bindgen(js_name = editAddable)]
    pub fn edit_addable(&mut self, parent: &str) -> String {
        self.0.edit_addable(parent).to_string()
    }

    /// An object added; `random` gives its identifier, 16 bytes a draw.
    #[wasm_bindgen(js_name = editAdd)]
    pub fn edit_add(
        &mut self,
        parent: &str,
        class: &str,
        name: Option<String>,
        random: &[u8],
    ) -> String {
        self.0
            .edit_add(parent, class, name.as_deref(), random)
            .to_string()
    }

    #[wasm_bindgen(js_name = editSet)]
    pub fn edit_set(&mut self, id: &str, key: &str, value: &str) -> String {
        self.0.edit_set(id, key, value).to_string()
    }

    #[wasm_bindgen(js_name = editRemove)]
    pub fn edit_remove(&mut self, id: &str, key: &str) -> String {
        self.0.edit_remove(id, key).to_string()
    }

    #[wasm_bindgen(js_name = editForm)]
    pub fn edit_form(&mut self, id: &str) -> String {
        self.0.edit_form(id).to_string()
    }

    #[wasm_bindgen(js_name = editCandidates)]
    pub fn edit_candidates(&mut self, id: &str, key: &str) -> String {
        self.0.edit_candidates(id, key).to_string()
    }

    #[wasm_bindgen(js_name = editFixes)]
    pub fn edit_fixes(&mut self, id: &str) -> String {
        self.0.edit_fixes(id).to_string()
    }

    /// Edits from [`JsSession::edit_fixes`], as JSON, at the revision they were offered for.
    #[wasm_bindgen(js_name = editApply)]
    pub fn edit_apply(&mut self, revision: f64, edits: &str) -> Result<String, JsError> {
        let edits: serde_json::Value = serde_json::from_str(edits)?;
        Ok(self.0.edit_apply(revision as u64, &edits).to_string())
    }

    /// RA_UC4's counter-proposal to schedule `refused`, in a new file; `random` gives the
    /// identifiers, 16 bytes a draw.
    #[wasm_bindgen(js_name = editCounterProposal)]
    pub fn edit_counter_proposal(
        &mut self,
        refused: &str,
        responding: Option<String>,
        random: &[u8],
    ) -> String {
        self.0
            .edit_counter_proposal(refused, responding.as_deref(), random)
            .to_string()
    }

    #[wasm_bindgen(js_name = editResponders)]
    pub fn edit_responders(&self) -> String {
        self.0.edit_responders().to_string()
    }

    #[wasm_bindgen(js_name = analysisRange)]
    pub fn analysis_range(&mut self, from: usize, to: usize) -> String {
        self.0.analysis_range(from, to).to_string()
    }

    /// The contingencies `from..to` analysed for another worker: `{ error, part }`.
    #[wasm_bindgen(js_name = analysisPart)]
    pub fn analysis_part(&mut self, from: usize, to: usize) -> String {
        self.0.analysis_part(from, to).to_string()
    }

    /// A part from [`JsSession::analysis_part`] of another worker, as JSON, merged in.
    #[wasm_bindgen(js_name = analysisAbsorb)]
    pub fn analysis_absorb(&mut self, part: &str) -> Result<String, JsError> {
        let part: serde_json::Value = serde_json::from_str(part)?;
        Ok(self.0.analysis_absorb(&part).to_string())
    }

    #[wasm_bindgen(js_name = analysisResult)]
    pub fn analysis_result(&mut self) -> String {
        self.0.analysis_result().to_string()
    }

    #[wasm_bindgen(js_name = analysisViolations)]
    pub fn analysis_violations(
        &self,
        contingency: Option<String>,
        terminal: Option<String>,
    ) -> String {
        self.0
            .analysis_violations(contingency.as_deref(), terminal.as_deref())
            .to_string()
    }

    #[wasm_bindgen(js_name = sarDefaults)]
    pub fn sar_defaults(&self) -> String {
        self.0.sar_defaults().to_string()
    }

    /// The finished analysis as a SAR, its header given as JSON: `title`, `description`,
    /// `publisher`, `isVersionOf`, `rightsHolder`, `generatedAt`.
    pub fn sar(&self, header: &str) -> Result<String, JsError> {
        let h: serde_json::Value = serde_json::from_str(header)?;
        let text = |key: &str| h[key].as_str().unwrap_or_default().to_string();
        let header = gridoxide::security_analysis::SarHeader {
            title: text("title"),
            description: text("description"),
            publisher: text("publisher"),
            is_version_of: text("isVersionOf"),
            rights_holder: text("rightsHolder"),
            generated_at: text("generatedAt"),
        };
        self.0.sar(&header).map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(js_name = sarResults)]
    pub fn sar_results(&self) -> String {
        self.0.sar_results().to_string()
    }

    pub fn schedules(&mut self) -> String {
        self.0.schedules().to_string()
    }

    pub fn datasets(&self) -> String {
        self.0.datasets().to_string()
    }

    #[wasm_bindgen(js_name = findingsOf)]
    pub fn findings_of(&self, rule: &str) -> String {
        self.0.findings_of(rule).to_string()
    }
}
