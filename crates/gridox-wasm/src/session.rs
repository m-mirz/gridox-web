//! The model set a worker holds: what the page has loaded, decoded and merged. It stays here, and
//! the page asks for what it draws, as a whole dataset would be too much to pass across.

use std::collections::BTreeMap;

use cimmodel::CimDataset;
use cimmodel::base::{AttrKind, FieldValue};
use cimmodel::decode::is_cim;
use cimmodel::registry::type_registry;
use cimvalidation::Violation;
use cimview::grid::{self, Grid, Model};
use cimview::tree::{self, Tree};
use cimview::{Locations, mrid_of};
use serde::Serialize;
use serde_json::{Value, json};

/// What became of one file given to [`Session::add_file`].
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum FileOutcome {
    Loaded { name: String, objects: usize },
    Skipped { name: String, reason: String },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ClassCount {
    pub class: String,
    pub objects: usize,
}

/// What the page shows of a session.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Summary {
    pub files: Vec<FileOutcome>,
    /// Objects of the classes the CGMES and NC tables know.
    pub objects: usize,
    /// Objects of classes they do not, such as reference data's SKOS and DCAT.
    pub foreign: usize,
    /// By class, most objects first.
    pub classes: Vec<ClassCount>,
}

/// How many search hits the page lists.
const SEARCH_LIMIT: usize = 100;

/// How many of the objects referring to one the page lists.
const REFERRERS_LIMIT: usize = 500;

/// How many of one rule's findings the page lists.
const FINDINGS_LIMIT: usize = 500;

/// Severities, worst first, as the shapes write them.
const SEVERITIES: [&str; 3] = ["sh:Violation", "sh:Warning", "sh:Info"];

/// The checks beyond each profile's own, as `cimcli validate --common --quality` adds them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Checks {
    pub common: bool,
    pub quality: bool,
}

/// The loaded files as validated, and what was found.
struct Validated {
    checks: Checks,
    /// Each finding, with the file it was found in when it is that file's alone.
    findings: Vec<(Option<usize>, Violation)>,
    files: Vec<String>,
}

#[derive(Default)]
pub struct Session {
    dataset: CimDataset,
    files: Vec<FileOutcome>,
    /// Built when first asked for, as the layout takes seconds on a large model, and gone when a
    /// file comes in.
    views: Option<Views>,
    /// The files given to [`Session::check_file`] since the last validation, one by one, as
    /// validation reads each file's header for its profiles.
    checking: Vec<(String, CimDataset)>,
    /// Gone when a file comes in, as it no longer says what the model holds.
    validated: Option<Validated>,
}

struct Views {
    grid: Grid,
    tree: Tree,
}

/// A page has no documents to place an object in, only the files' names.
struct Files<'a>(&'a [FileOutcome]);

impl Locations for Files<'_> {
    fn location(&self, _id: &str) -> Value {
        Value::Null
    }

    fn files(&self) -> Vec<Value> {
        let loaded = self.0.iter().filter_map(|file| match file {
            FileOutcome::Loaded { name, .. } => Some(json!(name)),
            FileOutcome::Skipped { .. } => None,
        });
        loaded.collect()
    }
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decodes `text` and merges it in. A file that cannot be used is recorded as skipped rather
    /// than failing the others given with it.
    pub fn add_file(&mut self, name: &str, text: &str) {
        let loaded = self
            .files
            .iter()
            .any(|f| matches!(f, FileOutcome::Loaded { name: n, .. } if n == name));
        let outcome = if loaded {
            skipped(name, "a file of this name is already loaded")
        } else if !is_cim(text) {
            skipped(name, "not a CGMES or NC file")
        } else {
            match CimDataset::decode_str(text) {
                Ok(dataset) => {
                    let objects = dataset.entries.len();
                    self.dataset.merge(dataset);
                    self.views = None;
                    self.validated = None;
                    FileOutcome::Loaded {
                        name: name.to_string(),
                        objects,
                    }
                }
                Err(error) => skipped(name, &error.to_string()),
            }
        };
        self.files.push(outcome);
    }

    /// Records that a file could not be given to [`Session::add_file`], such as one unreadable.
    pub fn skip_file(&mut self, name: &str, reason: &str) {
        self.files.push(skipped(name, reason));
    }

    pub fn summary(&self) -> Summary {
        let mut counts = BTreeMap::new();
        for (class, objects) in &self.dataset.by_type {
            if !objects.is_empty() {
                counts.insert(class.clone(), objects.len());
            }
        }
        let mut classes: Vec<ClassCount> = counts
            .into_iter()
            .map(|(class, objects)| ClassCount { class, objects })
            .collect();
        classes.sort_by(|a, b| {
            b.objects
                .cmp(&a.objects)
                .then_with(|| a.class.cmp(&b.class))
        });
        Summary {
            files: self.files.clone(),
            objects: self.dataset.entries.len(),
            foreign: self.dataset.foreign.len(),
            classes,
        }
    }

    fn views(&mut self) -> &Views {
        self.views.get_or_insert_with(|| {
            // cimlsp gives these the files one by one. The merged dataset answers the same on
            // MicroGrid, SmallGrid and RealGrid, without holding every object twice.
            let model = Model::new(std::slice::from_ref(&self.dataset));
            let mut views = Views {
                grid: grid::build(&model),
                tree: tree::build(&model),
            };
            if let Some(validated) = &self.validated {
                views.grid.add_findings(&validated.findings);
                views.tree.add_findings(&validated.findings);
            }
            views
        })
    }

    /// Takes a loaded file for the next [`Session::validate`]. Validation reads the files one by one,
    /// and the session keeps only their merge, so the page hands them over again.
    pub fn check_file(&mut self, name: &str, text: &str) -> Result<(), String> {
        let dataset = CimDataset::decode_str(text).map_err(|error| error.to_string())?;
        self.checking.push((name.to_string(), dataset));
        Ok(())
    }

    /// Validates the files given to [`Session::check_file`], as `cimcli validate` would with
    /// `checks`, and puts the findings on the views. Returns [`Session::findings`].
    pub fn validate(&mut self, checks: Checks) -> Value {
        let (files, datasets): (Vec<String>, Vec<CimDataset>) =
            std::mem::take(&mut self.checking).into_iter().unzip();
        let cfg = cimvalidation::combined_config(
            &datasets,
            None,
            None,
            checks.common,
            checks.quality,
            Vec::new(),
        );
        let findings = if datasets.is_empty() {
            Vec::new()
        } else {
            cimvalidation::validate_files_traced(datasets, &cfg)
        };
        self.validated = Some(Validated {
            checks,
            findings,
            files,
        });
        // Findings only add up on views: new ones take new views. The layout comes out the same.
        self.views = None;
        self.findings()
    }

    /// What validation found: counts by severity, and each rule's, worst first; `null` before any.
    pub fn findings(&self) -> Value {
        let Some(validated) = &self.validated else {
            return Value::Null;
        };
        let mut counts = [0usize; 3];
        let mut rules: BTreeMap<&str, (usize, &Violation)> = BTreeMap::new();
        for (_, v) in &validated.findings {
            counts[severity_rank(&v.severity)] += 1;
            rules.entry(v.rule_id.as_str()).or_insert((0, v)).0 += 1;
        }
        let mut rules: Vec<_> = rules.into_iter().collect();
        rules.sort_by_key(|(rule, (count, v))| {
            (severity_rank(&v.severity), std::cmp::Reverse(*count), *rule)
        });
        let rules = rules.into_iter().map(|(rule, (count, v))| {
            json!({
                "rule": rule, "name": v.name, "severity": severity_name(&v.severity),
                "description": v.description, "count": count,
            })
        });
        json!({
            "common": validated.checks.common, "quality": validated.checks.quality,
            "files": validated.files,
            "violation": counts[0], "warning": counts[1], "info": counts[2],
            "rules": rules.collect::<Vec<_>>(),
        })
    }

    /// The findings of rule `rule`, each with its object; the first [`FINDINGS_LIMIT`] of them.
    pub fn findings_of(&self, rule: &str) -> Value {
        let Some(validated) = &self.validated else {
            return Value::Array(Vec::new());
        };
        let found = validated
            .findings
            .iter()
            .filter(|(_, v)| v.rule_id == rule)
            .take(FINDINGS_LIMIT);
        let found = found.map(|(file, v)| {
            let label = self
                .dataset
                .entries
                .get(&v.object_id)
                .and_then(|e| e.get_str("IdentifiedObject.name"));
            json!({
                "object": v.object_id, "label": label, "class": v.class, "property": v.property,
                "message": v.message, "file": file.map(|f| &validated.files[f]),
            })
        });
        Value::Array(found.collect())
    }

    /// The grid at substation level, laid out.
    pub fn grid(&mut self) -> Value {
        self.views();
        let views = self.views.as_ref().expect("just built");
        views.grid.json(&Files(&self.files))
    }

    /// What the substation `id` holds, `null` if there is none.
    pub fn inside(&mut self, id: &str) -> Value {
        self.views();
        let views = self.views.as_ref().expect("just built");
        views
            .grid
            .inside_json(&Files(&self.files), id)
            .unwrap_or(Value::Null)
    }

    /// The tree's sections for `None`, else the children of the node `key`; only what holds
    /// findings with `only_findings`.
    pub fn children(&mut self, key: Option<&str>, only_findings: bool) -> Value {
        self.views();
        let views = self.views.as_ref().expect("just built");
        views
            .tree
            .children_json(&Files(&self.files), &views.grid, key, only_findings)
            .unwrap_or(Value::Null)
    }

    /// The objects whose name or mRID holds `query`, each with the grid view's place for it.
    pub fn search(&mut self, query: &str) -> Value {
        let views = self.views();
        let hits = views.tree.search(query, SEARCH_LIMIT).into_iter();
        let hits = hits.map(|(id, label, class)| {
            json!({
                "id": id, "label": label, "class": class,
                "place": views.tree.containers(id).join(" › "),
            })
        });
        Value::Array(hits.collect())
    }

    /// The tree's keys down to the object `id`, `null` if it has none, or none holding findings
    /// with `only_findings`.
    pub fn path(&mut self, id: &str, only_findings: bool) -> Value {
        json!(self.views().tree.path(id, only_findings))
    }

    /// The object `id` as written, its references resolved where the set has what they name, with
    /// what the class tables say of it and what refers to it. An object the files only refer to
    /// is `missing`, with its referrers; one nothing names is `null`.
    pub fn object(&mut self, id: &str) -> Value {
        self.views();
        let views = self.views.as_ref().expect("just built");
        let referrers = self.referrers(id);
        let Some(element) = self.dataset.entries.get(id) else {
            if referrers.0 == 0 {
                return Value::Null;
            }
            return json!({
                "id": id, "missing": true, "class": null, "types": [], "label": null, "comment": "",
                "defined": false, "fields": [], "grid": views.grid.reveal(id),
                "findings": self.findings_on(id), "referrers": referrers.1,
            });
        };
        let text = |value: &str| json!({ "text": value });
        // An enumeration's value is written as a reference is, to a vocabulary's IRI: no object.
        let reference = |value: &str, enumeration: bool| {
            let target = mrid_of(value);
            match self.dataset.entries.get(target) {
                Some(found) => json!({
                    "text": found.get_str("IdentifiedObject.name").unwrap_or(target),
                    "ref": target,
                }),
                None if enumeration => json!({ "text": target }),
                None => json!({ "text": target, "ref": target, "missing": true }),
            }
        };
        let registry = type_registry();
        let mut fields: Vec<(&str, Value)> = element
            .fields()
            .iter()
            .map(|(&key, value)| {
                // Declared by any of its types: an object merged from several files may have more than one.
                let declared = element.types().find_map(|class| registry.attr(class, key));
                let enumeration = declared.is_some_and(|a| matches!(a.kind, AttrKind::Enum));
                let values: Vec<Value> = match value {
                    FieldValue::Text(value) => vec![text(value)],
                    FieldValue::TextList(values) => values.iter().map(|v| text(v)).collect(),
                    FieldValue::Resource(value) => vec![reference(value, enumeration)],
                    FieldValue::ResourceList(values) => {
                        values.iter().map(|v| reference(v, enumeration)).collect()
                    }
                };
                let field = json!({
                    "key": key, "values": values, "declared": declared.is_some(),
                    "comment": declared.map_or("", |a| a.comment),
                });
                (key, field)
            })
            .collect();
        fields.sort_by_key(|field| field.0);
        let types: Vec<&str> = element.types().map(|class| class.local).collect();
        json!({
            "id": id,
            "class": element.local_name(),
            "types": if types.len() > 1 { types } else { Vec::new() },
            "label": element.get_str("IdentifiedObject.name"),
            "comment": element.class().comment,
            "defined": element.defined(),
            "fields": fields.into_iter().map(|(_, field)| field).collect::<Vec<_>>(),
            "grid": views.grid.reveal(id),
            "findings": self.findings_on(id),
            "referrers": referrers.1,
        })
    }

    /// The objects whose fields refer to `id`, by field, each list by name; how many there are, and
    /// the first [`REFERRERS_LIMIT`] of them. Asked for when shown, so it costs no memory.
    fn referrers(&self, id: &str) -> (usize, Value) {
        let mut by_key: BTreeMap<&str, Vec<(&str, &cimmodel::Element)>> = BTreeMap::new();
        for (source, element) in &self.dataset.entries {
            for (&key, value) in element.fields() {
                let names = match value {
                    FieldValue::Resource(value) => mrid_of(value) == id,
                    FieldValue::ResourceList(values) => values.iter().any(|v| mrid_of(v) == id),
                    FieldValue::Text(_) | FieldValue::TextList(_) => false,
                };
                if names {
                    by_key
                        .entry(key)
                        .or_default()
                        .push((source.as_str(), element));
                }
            }
        }
        let total = by_key.values().map(Vec::len).sum();
        let mut room = REFERRERS_LIMIT;
        let label =
            |e: &cimmodel::Element| e.get_str("IdentifiedObject.name").map(str::to_lowercase);
        let groups = by_key.into_iter().map(|(key, mut objects)| {
            objects.sort_by(|a, b| (label(a.1), a.0).cmp(&(label(b.1), b.0)));
            let count = objects.len();
            let listed = objects.into_iter().take(room).map(|(source, element)| {
                json!({
                    "id": source, "class": element.local_name(),
                    "label": element.get_str("IdentifiedObject.name"),
                })
            });
            let listed: Vec<Value> = listed.collect();
            room -= listed.len();
            json!({ "key": key, "count": count, "objects": listed })
        });
        let groups: Vec<Value> = groups.collect();
        (total, json!({ "total": total, "by": groups }))
    }
}

impl Session {
    /// What validation found on the object `id`.
    fn findings_on(&self, id: &str) -> Vec<Value> {
        let Some(validated) = &self.validated else {
            return Vec::new();
        };
        let found = validated.findings.iter().filter(|(_, v)| v.object_id == id);
        let found = found.map(|(_, v)| {
            json!({
                "rule": v.rule_id, "name": v.name, "severity": severity_name(&v.severity),
                "property": v.property, "message": v.message,
            })
        });
        found.collect()
    }
}

/// Where a severity goes in [`SEVERITIES`]; what is neither a violation nor a warning counts as
/// information, as cimoxide-view counts it.
fn severity_rank(severity: &str) -> usize {
    SEVERITIES.iter().position(|s| *s == severity).unwrap_or(2)
}

fn severity_name(severity: &str) -> &'static str {
    ["violation", "warning", "info"][severity_rank(severity)]
}

fn skipped(name: &str, reason: &str) -> FileOutcome {
    FileOutcome::Skipped {
        name: name.to_string(),
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EQ: &str = include_str!("../../../web/tests/fixtures/small_EQ.xml");
    const SSH: &str = include_str!("../../../web/tests/fixtures/small_SSH.xml");
    const GRID: &str = include_str!("../../../web/tests/fixtures/grid_EQ.xml");
    const ANVIL: &str = "_00000000-0000-4000-8000-000000000a01";
    const BREAKER: &str = "_00000000-0000-4000-8000-000000000a30";

    fn grid_session() -> Session {
        let mut session = Session::new();
        session.add_file("grid_EQ.xml", GRID);
        session
    }

    #[test]
    fn a_file_is_decoded_and_counted_by_class() {
        let mut session = Session::new();
        session.add_file("small_EQ.xml", EQ);
        let summary = session.summary();
        assert_eq!(summary.objects, 4);
        assert_eq!(
            summary.files,
            [FileOutcome::Loaded {
                name: "small_EQ.xml".to_string(),
                objects: 4
            }]
        );
        let lines = summary.classes.iter().find(|c| c.class == "ACLineSegment");
        assert_eq!(lines.map(|c| c.objects), Some(2));
    }

    #[test]
    fn files_of_one_model_merge_by_object() {
        let mut session = Session::new();
        session.add_file("small_EQ.xml", EQ);
        session.add_file("small_SSH.xml", SSH);
        // The SSH describes objects the EQ defines, and adds none.
        assert_eq!(session.summary().objects, 4);
    }

    #[test]
    fn what_is_not_a_model_is_skipped_and_the_rest_stays() {
        let mut session = Session::new();
        session.add_file("small_EQ.xml", EQ);
        session.add_file("notes.txt", "not xml at all");
        let summary = session.summary();
        assert_eq!(summary.objects, 4);
        assert!(
            matches!(&summary.files[1], FileOutcome::Skipped { name, .. } if name == "notes.txt")
        );
    }

    #[test]
    fn a_file_that_could_not_be_read_is_reported_and_the_rest_stays() {
        let mut session = Session::new();
        session.add_file("small_EQ.xml", EQ);
        session.skip_file("folder", "it could not be read");
        let summary = session.summary();
        assert_eq!(summary.objects, 4);
        assert!(matches!(
            &summary.files[1],
            FileOutcome::Skipped { name, reason } if name == "folder" && reason == "it could not be read"
        ));
    }

    #[test]
    fn a_file_of_a_name_already_loaded_is_skipped() {
        let mut session = Session::new();
        session.add_file("small_EQ.xml", EQ);
        session.add_file("small_EQ.xml", EQ);
        assert!(matches!(
            &session.summary().files[1],
            FileOutcome::Skipped { .. }
        ));
    }

    #[test]
    fn the_grid_has_the_substations_and_the_line_between_them() {
        let grid = grid_session().grid();
        let labels: Vec<_> = grid["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| &n["label"])
            .collect();
        assert_eq!(labels, ["Anvil", "Birch"]);
        assert_eq!(grid["edges"][0]["label"], "Anvil-Birch");
        assert_eq!(grid["files"], json!(["grid_EQ.xml"]));
        assert!(grid["nodes"][0]["location"].is_null());
        assert_eq!(grid["auto"]["nodes"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn a_substation_holds_its_equipment() {
        let inside = grid_session().inside(ANVIL);
        let labels: Vec<_> = inside["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["label"].as_str().unwrap())
            .collect();
        assert!(labels.contains(&"Breaker A"), "{labels:?}");
        assert!(grid_session().inside("nothing").is_null());
    }

    #[test]
    fn the_tree_is_asked_a_level_at_a_time_and_finds_its_way_to_an_object() {
        let mut session = grid_session();
        let sections = session.children(None, false);
        assert_eq!(sections[0]["label"], "Geographical");
        let keys = session.path(BREAKER, false);
        let keys = keys.as_array().unwrap();
        // Every key opens onto the next.
        let mut level = sections;
        for key in keys {
            let found = level.as_array().unwrap().iter().any(|e| &e["key"] == key);
            assert!(found, "{key} is not in {level}");
            level = session.children(key.as_str(), false);
        }
    }

    #[test]
    fn search_finds_by_name() {
        let hits = grid_session().search("breaker a");
        assert_eq!(hits[0]["id"], BREAKER);
        assert_eq!(hits[0]["class"], "Breaker");
    }

    #[test]
    fn an_object_shows_its_fields_and_where_its_references_lead() {
        let object = grid_session().object(BREAKER);
        assert_eq!(object["class"], "Breaker");
        assert_eq!(object["label"], "Breaker A");
        let field = |key: &str| {
            let fields = object["fields"].as_array().unwrap();
            fields.iter().find(|f| f["key"] == key).unwrap()["values"][0].clone()
        };
        assert_eq!(field("IdentifiedObject.name")["text"], "Breaker A");
        let container = field("Equipment.EquipmentContainer");
        assert_eq!(container["text"], "Anvil 110");
        assert!(container["ref"].is_string());
        assert_eq!(object["grid"]["enter"], ANVIL);
        assert!(grid_session().object("nothing").is_null());
    }

    const VOLTAGE_LEVEL: &str = "_00000000-0000-4000-8000-000000000a11";

    #[test]
    fn an_object_says_what_refers_to_it_by_field() {
        let object = grid_session().object(VOLTAGE_LEVEL);
        let referrers = &object["referrers"];
        assert_eq!(referrers["total"], 3);
        let keys: Vec<_> = referrers["by"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["key"].as_str().unwrap())
            .collect();
        assert_eq!(
            keys,
            [
                "ConnectivityNode.ConnectivityNodeContainer",
                "Equipment.EquipmentContainer"
            ]
        );
        let nodes: Vec<_> = referrers["by"][0]["objects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["label"].as_str().unwrap())
            .collect();
        assert_eq!(nodes, ["Anvil bus", "Anvil line end"]);
        assert_eq!(referrers["by"][1]["objects"][0]["id"], BREAKER);
    }

    #[test]
    fn an_object_says_what_the_class_tables_say_of_its_fields() {
        let mut session = Session::new();
        let breaker = GRID.replace(
            "<cim:Switch.normalOpen>false</cim:Switch.normalOpen>",
            "<cim:Switch.normalOpen>false</cim:Switch.normalOpen>\n    <cim:Switch.colour>red</cim:Switch.colour>",
        );
        session.add_file("grid_EQ.xml", &breaker);
        let object = session.object(BREAKER);
        assert_eq!(object["defined"], true);
        assert!(!object["comment"].as_str().unwrap().is_empty());
        let field = |key: &str| {
            object["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["key"] == key)
                .unwrap()
                .clone()
        };
        assert_eq!(field("Switch.normalOpen")["declared"], true);
        assert!(
            !field("Switch.normalOpen")["comment"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        assert_eq!(field("Switch.colour")["declared"], false);
        let mut session = Session::new();
        let terminal = GRID.replacen(
            "<cim:Terminal.ConductingEquipment",
            "<cim:Terminal.phases rdf:resource=\"http://iec.ch/TC57/CIM100#PhaseCode.ABC\"/>\n    <cim:Terminal.ConductingEquipment",
            1,
        );
        session.add_file("grid_EQ.xml", &terminal);
        let object = session.object("_00000000-0000-4000-8000-000000000a40");
        let phases = object["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == "Terminal.phases")
            .unwrap();
        // An enumeration's value is no object to go to.
        assert_eq!(phases["values"][0], json!({ "text": "PhaseCode.ABC" }));
    }

    #[test]
    fn an_object_only_referred_to_is_missing_and_says_who_refers_to_it() {
        let mut session = Session::new();
        let elsewhere = GRID.replace(
            r##"<cim:VoltageLevel.BaseVoltage rdf:resource="#_00000000-0000-4000-8000-000000000b00"/>"##,
            r##"<cim:VoltageLevel.BaseVoltage rdf:resource="#_boundary"/>"##,
        );
        assert_ne!(elsewhere, GRID);
        session.add_file("grid_EQ.xml", &elsewhere);
        let object = session.object("_boundary");
        assert_eq!(object["missing"], true);
        assert_eq!(
            object["referrers"]["by"][0]["key"],
            "VoltageLevel.BaseVoltage"
        );
        let level = session.object(VOLTAGE_LEVEL);
        let fields = level["fields"].as_array().unwrap();
        let base = fields
            .iter()
            .find(|f| f["key"] == "VoltageLevel.BaseVoltage")
            .unwrap();
        assert_eq!(
            base["values"][0],
            json!({ "text": "_boundary", "ref": "_boundary", "missing": true })
        );
        assert!(session.object("_nobody").is_null());
    }

    #[test]
    fn a_new_file_rebuilds_the_views() {
        let mut session = Session::new();
        assert_eq!(session.grid()["nodes"].as_array().unwrap().len(), 0);
        session.add_file("grid_EQ.xml", GRID);
        assert_eq!(session.grid()["nodes"].as_array().unwrap().len(), 2);
    }

    fn validated(session: &mut Session, checks: Checks) -> Value {
        session.check_file("grid_EQ.xml", GRID).unwrap();
        session.validate(checks)
    }

    /// What cimvalidation finds on its own, as (object, rule, property).
    fn direct(checks: Checks) -> Vec<(String, String, String)> {
        let datasets = vec![CimDataset::decode_str(GRID).unwrap()];
        let cfg = cimvalidation::combined_config(
            &datasets,
            None,
            None,
            checks.common,
            checks.quality,
            Vec::new(),
        );
        let mut found: Vec<_> = cimvalidation::validate_files(datasets, &cfg)
            .into_iter()
            .map(|v| (v.object_id, v.rule_id, v.property))
            .collect();
        found.sort();
        found
    }

    #[test]
    fn validation_finds_what_cimvalidation_finds() {
        for checks in [
            Checks::default(),
            Checks {
                common: true,
                quality: true,
            },
        ] {
            let mut session = grid_session();
            let summary = validated(&mut session, checks);
            let expected = direct(checks);
            assert!(!expected.is_empty(), "the fixture should break some rules");
            let mut found = Vec::new();
            for rule in summary["rules"].as_array().unwrap() {
                let rule = rule["rule"].as_str().unwrap();
                for f in session.findings_of(rule).as_array().unwrap() {
                    let s = |k: &str| f[k].as_str().unwrap().to_string();
                    found.push((s("object"), rule.to_string(), s("property")));
                }
            }
            found.sort();
            assert_eq!(found, expected);
            let total: u64 = ["violation", "warning", "info"]
                .iter()
                .map(|k| summary[k].as_u64().unwrap())
                .sum();
            assert_eq!(total as usize, expected.len());
            assert_eq!(summary["files"], json!(["grid_EQ.xml"]));
        }
    }

    #[test]
    fn findings_are_counted_on_the_views_and_shown_on_their_object() {
        let mut session = grid_session();
        assert!(session.findings().is_null());
        let summary = validated(&mut session, Checks::default());
        let total = |f: &Value| {
            ["violation", "warning", "info"]
                .iter()
                .map(|k| f[k].as_u64().unwrap())
                .sum::<u64>()
        };
        let sections: u64 = session
            .children(None, false)
            .as_array()
            .unwrap()
            .iter()
            .map(|s| total(&s["findings"]))
            .sum();
        assert!(sections > 0);
        let rule = summary["rules"][0]["rule"].as_str().unwrap().to_string();
        let first = session.findings_of(&rule)[0].clone();
        let object = session.object(first["object"].as_str().unwrap());
        let on = object["findings"].as_array().unwrap();
        assert!(on.iter().any(|f| f["rule"] == rule.as_str()), "{object}");
    }

    #[test]
    fn a_new_file_takes_the_findings_away() {
        let mut session = grid_session();
        validated(&mut session, Checks::default());
        session.add_file("small_EQ.xml", EQ);
        assert!(session.findings().is_null());
        assert!(
            session.object(BREAKER)["findings"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn an_empty_session_has_nothing_to_show() {
        let summary = Session::new().summary();
        assert_eq!((summary.objects, summary.foreign), (0, 0));
        assert!(summary.classes.is_empty() && summary.files.is_empty());
    }
}
