//! The model set a worker holds: what the page has loaded, decoded and merged. It stays here, and
//! the page asks for what it draws, as a whole dataset would be too much to pass across.

use std::collections::BTreeMap;

use cimmodel::CimDataset;
use cimmodel::base::FieldValue;
use cimmodel::decode::is_cim;
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

#[derive(Default)]
pub struct Session {
    dataset: CimDataset,
    files: Vec<FileOutcome>,
    /// Built when first asked for, as the layout takes seconds on a large model, and gone when a
    /// file comes in.
    views: Option<Views>,
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
            Views {
                grid: grid::build(&model),
                tree: tree::build(&model),
            }
        })
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

    /// The tree's sections for `None`, else the children of the node `key`.
    pub fn children(&mut self, key: Option<&str>) -> Value {
        self.views();
        let views = self.views.as_ref().expect("just built");
        views
            .tree
            .children_json(&Files(&self.files), &views.grid, key, false)
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

    /// The tree's keys down to the object `id`, `null` if it has none.
    pub fn path(&mut self, id: &str) -> Value {
        json!(self.views().tree.path(id, false))
    }

    /// The object `id` as written, its references resolved where the set has what they name.
    pub fn object(&mut self, id: &str) -> Value {
        self.views();
        let views = self.views.as_ref().expect("just built");
        let Some(element) = self.dataset.entries.get(id) else {
            return Value::Null;
        };
        let text = |value: &str| json!({ "text": value });
        let reference = |value: &str| {
            let target = mrid_of(value);
            match self.dataset.entries.get(target) {
                Some(found) => json!({
                    "text": found.get_str("IdentifiedObject.name").unwrap_or(target),
                    "ref": target,
                }),
                None => json!({ "text": target }),
            }
        };
        let mut fields: Vec<(&str, Vec<Value>)> = element
            .fields()
            .iter()
            .map(|(&key, value)| {
                let values = match value {
                    FieldValue::Text(value) => vec![text(value)],
                    FieldValue::TextList(values) => values.iter().map(|v| text(v)).collect(),
                    FieldValue::Resource(value) => vec![reference(value)],
                    FieldValue::ResourceList(values) => {
                        values.iter().map(|v| reference(v)).collect()
                    }
                };
                (key, values)
            })
            .collect();
        fields.sort_by_key(|field| field.0);
        json!({
            "id": id,
            "class": element.local_name(),
            "label": element.get_str("IdentifiedObject.name"),
            "fields": fields.into_iter().map(|(key, values)| json!({ "key": key, "values": values })).collect::<Vec<_>>(),
            "grid": views.grid.reveal(id),
        })
    }
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
        let sections = session.children(None);
        assert_eq!(sections[0]["label"], "Geographical");
        let keys = session.path(BREAKER);
        let keys = keys.as_array().unwrap();
        // Every key opens onto the next.
        let mut level = sections;
        for key in keys {
            let found = level.as_array().unwrap().iter().any(|e| &e["key"] == key);
            assert!(found, "{key} is not in {level}");
            level = session.children(key.as_str());
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

    #[test]
    fn a_new_file_rebuilds_the_views() {
        let mut session = Session::new();
        assert_eq!(session.grid()["nodes"].as_array().unwrap().len(), 0);
        session.add_file("grid_EQ.xml", GRID);
        assert_eq!(session.grid()["nodes"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn an_empty_session_has_nothing_to_show() {
        let summary = Session::new().summary();
        assert_eq!((summary.objects, summary.foreign), (0, 0));
        assert!(summary.classes.is_empty() && summary.files.is_empty());
    }
}
