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

mod power_flow;
mod security;

pub use power_flow::Options as PowerFlowOptions;

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

/// How many objects defined twice, or typed with unrelated classes, the page lists.
const DATASET_LIMIT: usize = 500;

/// The classes of a dataset's header: CGMES's `md:FullModel` and `md:DifferenceModel`, NC's
/// `dcat:Dataset`.
const HEADERS: [&str; 3] = ["FullModel", "DifferenceModel", "Dataset"];

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

/// What only the files one by one say, gathered while validation reads them again.
#[derive(Default)]
struct Facts {
    files: Vec<FileFacts>,
    /// Each object defined (`rdf:ID`, or NC's `rdf:about`), by the files that define it.
    defined_in: BTreeMap<String, Vec<u16>>,
}

struct FileFacts {
    name: String,
    /// Its header's identifier, if it has one.
    header: Option<String>,
    /// Objects of the CGMES and NC tables, and of classes outside them.
    objects: usize,
    foreign: usize,
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
    /// Gathered from the files given to [`Session::check_file`], and kept from one validation to
    /// the next.
    gathering: Facts,
    facts: Option<Facts>,
    /// A security analysis under way or done; gone when a file comes in.
    analysis: Option<security::Analysis>,
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
                    self.facts = None;
                    self.analysis = None;
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
        let index = self.gathering.files.len() as u16;
        let mut header = None;
        for (id, element) in dataset.entries.iter().chain(&dataset.foreign) {
            if HEADERS.contains(&element.local_name()) && header.is_none() {
                header = Some(id.clone());
            }
            if element.defined() {
                self.gathering
                    .defined_in
                    .entry(id.clone())
                    .or_default()
                    .push(index);
            }
        }
        self.gathering.files.push(FileFacts {
            name: name.to_string(),
            header,
            objects: dataset.entries.len(),
            foreign: dataset.foreign.len(),
        });
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
        self.facts = Some(std::mem::take(&mut self.gathering));
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
        let foreign = self.dataset.foreign.get(id);
        let Some(element) = self.dataset.entries.get(id).or(foreign) else {
            if referrers.0 == 0 {
                return Value::Null;
            }
            return json!({
                "id": id, "missing": true, "class": null, "types": [], "label": null, "comment": "",
                "defined": false, "fields": [], "grid": views.grid.reveal(id),
                "findings": self.findings_on(id), "referrers": referrers.1, "definedIn": [],
            });
        };
        let text = |value: &str| json!({ "text": value });
        // An enumeration's value is written as a reference is, to a vocabulary's IRI: no object.
        let reference =
            |key, value: &str, enumeration: bool| self.reference(element, key, value, enumeration);
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
                    FieldValue::Resource(value) => vec![reference(key, value, enumeration)],
                    FieldValue::ResourceList(values) => values
                        .iter()
                        .map(|v| reference(key, v, enumeration))
                        .collect(),
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
            "foreign": foreign.is_some(),
            "definedIn": self.defined_in(id),
        })
    }

    /// What a reference names: the object's identifier for a reference within the documents
    /// (`#_x`, cut to what follows the `#`), else the whole IRI, which the decoder cut too and
    /// remembers the namespace of for each class and field.
    fn target<'a>(
        &self,
        element: &cimmodel::Element,
        key: &'static str,
        value: &'a str,
    ) -> std::borrow::Cow<'a, str> {
        let form = self.dataset.field_forms.get(&(element.type_name(), key));
        match form.and_then(|form| form.resource_ns) {
            Some(ns) => std::borrow::Cow::Owned(format!("{ns}{value}")),
            None => std::borrow::Cow::Borrowed(mrid_of(value)),
        }
    }

    /// A reference as a page shows it: to a CIM object, or to reference data, with its name; to
    /// what the set lacks as `missing`. An enumeration's value is written as a reference is, to a
    /// vocabulary's IRI, and leads nowhere.
    fn reference(
        &self,
        element: &cimmodel::Element,
        key: &'static str,
        value: &str,
        enumeration: bool,
    ) -> Value {
        let target = self.target(element, key, value);
        if let Some(found) = self.dataset.entries.get(target.as_ref()) {
            let label = found.get_str("IdentifiedObject.name").unwrap_or(&target);
            return json!({ "text": label, "ref": target });
        }
        if let Some(found) = self.dataset.foreign.get(target.as_ref()) {
            let label = found
                .get_str("prefLabel")
                .or_else(|| found.get_str("title"))
                .unwrap_or(&target);
            return json!({ "text": label, "ref": target });
        }
        if enumeration {
            json!({ "text": mrid_of(value) })
        } else {
            json!({ "text": target, "ref": target, "missing": true })
        }
    }

    /// The files that define `id`, once validation has read them one by one.
    fn defined_in(&self, id: &str) -> Vec<&str> {
        let Some(facts) = &self.facts else {
            return Vec::new();
        };
        let files = facts.defined_in.get(id).map_or(&[][..], Vec::as_slice);
        files
            .iter()
            .map(|&f| facts.files[f as usize].name.as_str())
            .collect()
    }

    /// The datasets loaded: each file's header, with where its references lead; the objects more
    /// than one file defines; and those typed with unrelated classes. `null` until validation has
    /// read the files one by one.
    pub fn datasets(&self) -> Value {
        let Some(facts) = &self.facts else {
            return Value::Null;
        };
        let label = |id: &str| {
            let element = self.dataset.entries.get(id)?;
            element.get_str("IdentifiedObject.name")
        };
        let class = |id: &str| {
            let element = self
                .dataset
                .entries
                .get(id)
                .or_else(|| self.dataset.foreign.get(id))?;
            Some(element.local_name())
        };
        let files = facts.files.iter().map(|file| {
            let header = file.header.as_deref().and_then(|id| {
                let element = self.dataset.entries.get(id).or_else(|| self.dataset.foreign.get(id))?;
                let mut refs: Vec<(&str, Vec<Value>)> = Vec::new();
                let mut profiles: Vec<&str> = Vec::new();
                for (&key, value) in element.fields() {
                    let values: Vec<&str> = match value {
                        FieldValue::Text(v) | FieldValue::Resource(v) => vec![v.as_str()],
                        FieldValue::TextList(vs) | FieldValue::ResourceList(vs) => {
                            vs.iter().map(String::as_str).collect()
                        }
                    };
                    if key.ends_with("profile") || key == "conformsTo" {
                        profiles.extend(values);
                    } else if matches!(value, FieldValue::Resource(_) | FieldValue::ResourceList(_)) {
                        refs.push((key, values.iter().map(|v| self.reference(element, key, v, false)).collect()));
                    }
                }
                refs.sort_by_key(|r| r.0);
                profiles.sort_unstable();
                Some(json!({
                    "id": id, "class": element.local_name(), "profiles": profiles,
                    "refs": refs.into_iter().map(|(key, values)| json!({ "key": key, "values": values })).collect::<Vec<_>>(),
                }))
            });
            json!({ "name": file.name, "objects": file.objects, "foreign": file.foreign, "header": header })
        });
        let twice: Vec<(&String, &Vec<u16>)> = facts
            .defined_in
            .iter()
            .filter(|(_, files)| files.len() > 1)
            .collect();
        let twice_listed = twice.iter().take(DATASET_LIMIT).map(|(id, files)| {
            let names: Vec<&str> = files
                .iter()
                .map(|&f| facts.files[f as usize].name.as_str())
                .collect();
            json!({ "id": id, "label": label(id), "class": class(id), "files": names })
        });
        let conflicts = self.dataset.type_conflicts();
        let conflicts_listed = conflicts
            .iter()
            .take(DATASET_LIMIT)
            .map(|(id, types)| json!({ "id": id, "label": label(id), "types": types }));
        json!({
            "files": files.collect::<Vec<_>>(),
            "twice": { "count": twice.len(), "objects": twice_listed.collect::<Vec<_>>() },
            "conflicts": { "count": conflicts.len(), "objects": conflicts_listed.collect::<Vec<_>>() },
        })
    }

    /// The objects whose fields refer to `id`, by field, each list by name; how many there are, and
    /// the first [`REFERRERS_LIMIT`] of them. Asked for when shown, so it costs no memory.
    fn referrers(&self, id: &str) -> (usize, Value) {
        let mut by_key: BTreeMap<&str, Vec<(&str, &cimmodel::Element)>> = BTreeMap::new();
        // A CIM object is named by what follows the last `#`; reference data by its whole IRI.
        for (source, element) in self.dataset.entries.iter().chain(&self.dataset.foreign) {
            for (&key, value) in element.fields() {
                let names_it = |value: &str| self.target(element, key, value) == id;
                let names = match value {
                    FieldValue::Resource(value) => names_it(value),
                    FieldValue::ResourceList(values) => values.iter().any(|v| names_it(v)),
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

/// Network Code tables: contingencies and assessed elements, each row with the objects it links to
/// and where the grid shows its equipment.
impl Session {
    /// The objects of class `local`, in either family (`nc:` prefixed or not), in the order read.
    fn of_type<'a>(
        &'a self,
        local: &'a str,
    ) -> impl Iterator<Item = (&'a str, &'a cimmodel::Element)> + 'a {
        let lists = self.dataset.by_type.iter().filter(move |(key, _)| {
            key.as_str() == local || key.rsplit_once(':').is_some_and(|(_, name)| name == local)
        });
        let mut ids: Vec<&String> = lists.flat_map(|(_, ids)| ids).collect();
        ids.sort_unstable();
        ids.into_iter()
            .filter_map(|id| Some((id.as_str(), self.dataset.entries.get(id)?)))
    }

    /// An object linked to, as a table cell: its name and class; `missing` if the set lacks it.
    fn linked(&self, id: &str) -> Value {
        match self.dataset.entries.get(id) {
            Some(e) => {
                json!({ "id": id, "label": e.get_str("IdentifiedObject.name"), "class": e.local_name() })
            }
            None => json!({ "id": id, "label": null, "class": null, "missing": true }),
        }
    }

    /// The field `key` of `element` as text, an enumeration's value without its type
    /// (`ElementCombinationConstraintKind.excluded` → `excluded`).
    fn text(element: &cimmodel::Element, key: &str) -> Option<String> {
        let value = mrid_of(element.get_str(key).or_else(|| element.get_ref(key))?);
        let short = value.split_once("Kind.").map_or(value, |(_, v)| v);
        Some(short.to_string())
    }

    /// Where the grid shows each of `equipment` that it shows.
    fn on_grid(&mut self, equipment: &[&str]) -> Vec<Value> {
        let views = self.views();
        equipment
            .iter()
            .filter_map(|id| views.grid.reveal(id))
            .collect()
    }

    /// The contingencies, each with its equipment and the assessed elements combined with it.
    pub fn contingencies(&mut self) -> Value {
        let mut equipment: BTreeMap<&str, Vec<(&str, Option<String>)>> = BTreeMap::new();
        for (_, element) in self.of_type("ContingencyEquipment") {
            if let (Some(c), Some(e)) = (
                element.get_ref("ContingencyElement.Contingency"),
                element.get_ref("ContingencyEquipment.Equipment"),
            ) {
                equipment.entry(mrid_of(c)).or_default().push((
                    mrid_of(e),
                    Self::text(element, "ContingencyEquipment.contingentStatus"),
                ));
            }
        }
        let mut assessed: BTreeMap<&str, Vec<(&str, Option<String>)>> = BTreeMap::new();
        for (_, element) in self.of_type("AssessedElementWithContingency") {
            if let (Some(c), Some(a)) = (
                element.get_ref("AssessedElementWithContingency.Contingency"),
                element.get_ref("AssessedElementWithContingency.AssessedElement"),
            ) {
                assessed.entry(mrid_of(c)).or_default().push((
                    mrid_of(a),
                    Self::text(
                        element,
                        "AssessedElementWithContingency.combinationConstraintKind",
                    ),
                ));
            }
        }
        let mut rows: Vec<(String, Value, Vec<String>)> = Vec::new();
        for class in [
            "OrdinaryContingency",
            "ExceptionalContingency",
            "OutOfRangeContingency",
        ] {
            for (id, element) in self.of_type(class) {
                let named = equipment.get(id).map_or(&[][..], Vec::as_slice);
                let row = json!({
                    "id": id, "label": element.get_str("IdentifiedObject.name"), "class": class,
                    "mustStudy": Self::text(element, "Contingency.normalMustStudy"),
                    "equipment": named.iter().map(|(e, status)| {
                        let mut cell = self.linked(e);
                        cell["status"] = json!(status);
                        cell
                    }).collect::<Vec<_>>(),
                    "assessed": assessed.get(id).map_or(&[][..], Vec::as_slice).iter().map(|(a, kind)| {
                        let mut cell = self.linked(a);
                        cell["kind"] = json!(kind);
                        cell
                    }).collect::<Vec<_>>(),
                });
                rows.push((
                    id.to_string(),
                    row,
                    named.iter().map(|(e, _)| e.to_string()).collect(),
                ));
            }
        }
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|(_, mut row, equipment)| {
                let ids: Vec<&str> = equipment.iter().map(String::as_str).collect();
                row["grid"] = json!(self.on_grid(&ids));
                row
            })
            .collect();
        Value::Array(rows)
    }

    /// What an assessed element assesses: its equipment, else that of its operational limit,
    /// through the limit's set (its equipment, else its terminal's).
    fn assessed_equipment<'a>(&'a self, element: &'a cimmodel::Element) -> Option<&'a str> {
        if let Some(e) = element.get_ref("AssessedElement.ConductingEquipment") {
            return Some(mrid_of(e));
        }
        let limit = self.dataset.entries.get(mrid_of(
            element.get_ref("AssessedElement.OperationalLimit")?,
        ))?;
        let set = self.dataset.entries.get(mrid_of(
            limit.get_ref("OperationalLimit.OperationalLimitSet")?,
        ))?;
        if let Some(e) = set.get_ref("OperationalLimitSet.Equipment") {
            return Some(mrid_of(e));
        }
        let terminal = self
            .dataset
            .entries
            .get(mrid_of(set.get_ref("OperationalLimitSet.Terminal")?))?;
        terminal
            .get_ref("Terminal.ConductingEquipment")
            .map(mrid_of)
    }

    /// The assessed elements: whether they are in the base case and secured or scanned for a
    /// region, why excluded, what they assess, their schedules, and the contingencies and remedial
    /// actions combined with them.
    pub fn assessed_elements(&mut self) -> Value {
        let mut combined: BTreeMap<&str, (Vec<Value>, Vec<Value>)> = BTreeMap::new();
        for (key, which) in [
            ("AssessedElementWithContingency", "Contingency"),
            ("AssessedElementWithRemedialAction", "RemedialAction"),
        ] {
            for (_, element) in self.of_type(key) {
                let (Some(a), Some(other)) = (
                    element.get_ref(&format!("{key}.AssessedElement")),
                    element.get_ref(&format!("{key}.{which}")),
                ) else {
                    continue;
                };
                let mut cell = self.linked(mrid_of(other));
                cell["kind"] = json!(Self::text(
                    element,
                    &format!("{key}.combinationConstraintKind")
                ));
                let entry = combined.entry(mrid_of(a)).or_default();
                if which == "Contingency" {
                    entry.0.push(cell)
                } else {
                    entry.1.push(cell)
                }
            }
        }
        let mut schedules: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (id, element) in self.of_type("AssessedElementSchedule") {
            if let Some(a) = element.get_ref("AssessedElementSchedule.AssessedElement") {
                schedules.entry(mrid_of(a)).or_default().push(id);
            }
        }
        let region = |element: &cimmodel::Element, key: &str| {
            element.get_ref(key).map(|r| self.linked(mrid_of(r)))
        };
        let mut rows = Vec::new();
        for (id, element) in self.of_type("AssessedElement") {
            let assesses = self.assessed_equipment(element);
            let (contingencies, actions) = combined.remove(id).unwrap_or_default();
            rows.push((json!({
                "id": id, "label": element.get_str("IdentifiedObject.name"),
                "inBaseCase": Self::text(element, "AssessedElement.inBaseCase"),
                "normalEnabled": Self::text(element, "AssessedElement.normalEnabled"),
                "securedFor": region(element, "AssessedElement.SecuredForRegion"),
                "scannedFor": region(element, "AssessedElement.ScannedForRegion"),
                "exclusionReason": Self::text(element, "AssessedElement.exclusionReason"),
                "combinableWithContingency": Self::text(element, "AssessedElement.isCombinableWithContingency"),
                "combinableWithRemedialAction": Self::text(element, "AssessedElement.isCombinableWithRemedialAction"),
                "assesses": assesses.map(|e| self.linked(e)),
                "limit": element.get_ref("AssessedElement.OperationalLimit").map(|l| self.linked(mrid_of(l))),
                "schedules": schedules.get(id).map_or(&[][..], Vec::as_slice).iter().map(|s| self.linked(s)).collect::<Vec<_>>(),
                "contingencies": contingencies, "remedialActions": actions,
            }), assesses.map(str::to_string)));
        }
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|(mut row, assesses)| {
                let ids: Vec<&str> = assesses.iter().map(String::as_str).collect();
                row["grid"] = json!(self.on_grid(&ids));
                row
            })
            .collect();
        Value::Array(rows)
    }
}

/// Remedial actions: what each changes, on what, with which dependencies, and the switch states
/// that applying it gives.
impl Session {
    /// Which objects refer to which through each of `keys`: target → (source, key).
    fn referrers_by<'a>(
        &'a self,
        keys: &[&str],
    ) -> BTreeMap<&'a str, Vec<(&'a str, &'static str)>> {
        let mut by: BTreeMap<&str, Vec<(&str, &'static str)>> = BTreeMap::new();
        for (source, element) in &self.dataset.entries {
            for (&key, value) in element.fields() {
                if !keys.contains(&key) {
                    continue;
                }
                let targets: Vec<&str> = match value {
                    FieldValue::Resource(v) => vec![mrid_of(v)],
                    FieldValue::ResourceList(vs) => vs.iter().map(|v| mrid_of(v)).collect(),
                    FieldValue::Text(_) | FieldValue::TextList(_) => continue,
                };
                for target in targets {
                    by.entry(target).or_default().push((source.as_str(), key));
                }
            }
        }
        for list in by.values_mut() {
            list.sort_unstable();
        }
        by
    }

    /// Where the grid shows `id`, else the first thing within two references of it that it shows:
    /// a tap changer's transformer, a regulating control's equipment, at worst a container.
    fn place_on_grid(&mut self, id: &str) -> Option<Value> {
        self.views();
        let views = self.views.as_ref().expect("just built");
        let mut level = vec![id.to_string()];
        for _ in 0..3 {
            let mut next = Vec::new();
            for at in &level {
                if let Some(found) = views.grid.reveal(at) {
                    return Some(found);
                }
                let Some(element) = self.dataset.entries.get(at) else {
                    continue;
                };
                let mut keys: Vec<_> = element.fields().iter().collect();
                keys.sort_by_key(|(k, _)| **k);
                for (_, value) in keys {
                    match value {
                        FieldValue::Resource(v) => next.push(mrid_of(v).to_string()),
                        FieldValue::ResourceList(vs) => {
                            next.extend(vs.iter().map(|v| mrid_of(v).to_string()))
                        }
                        _ => {}
                    }
                }
            }
            level = next;
        }
        None
    }

    /// The remedial actions: their kind and availability; each alteration with what it targets
    /// and the values its ranges set; their dependencies and the actions sharing a group with
    /// them; and, applied, the switch states their topology actions give, as cimoxide's harness
    /// reads them: open where the range on `Switch.open` gives an absolute value other than 0.
    pub fn remedial_actions(&mut self) -> Value {
        let links = self.referrers_by(&[
            "GridStateAlteration.GridStateAlterationRemedialAction",
            "RangeConstraint.GridStateAlteration",
            "RemedialActionDependency.RemedialAction",
            "RemedialActionDependency.DependingRemedialActionGroup",
        ]);
        let of = |target: &str, key: &str| -> Vec<&str> {
            links.get(target).map_or(Vec::new(), |list| {
                list.iter()
                    .filter(|(_, k)| *k == key)
                    .map(|(s, _)| *s)
                    .collect()
            })
        };
        let mut classes: Vec<&str> = self
            .dataset
            .by_type
            .keys()
            .map(|k| k.rsplit_once(':').map_or(k.as_str(), |(_, n)| n))
            .filter(|n| n.ends_with("RemedialAction") && !n.contains("With"))
            .collect();
        classes.sort_unstable();
        classes.dedup();
        let mut rows = Vec::new();
        let mut targets_of_rows = Vec::new();
        for class in classes {
            for (id, element) in self.of_type(class) {
                let mut alterations = Vec::new();
                let mut applied = Vec::new();
                let mut targets = Vec::new();
                for alteration_id in of(id, "GridStateAlteration.GridStateAlterationRemedialAction")
                {
                    let Some(alteration) = self.dataset.entries.get(alteration_id) else {
                        continue;
                    };
                    // What it acts on: its one reference of its own class.
                    let mut own: Vec<(&str, &str)> = alteration
                        .fields()
                        .iter()
                        .filter(|(k, _)| {
                            !k.starts_with("GridStateAlteration.")
                                && !k.starts_with("IdentifiedObject.")
                        })
                        .filter_map(|(&k, v)| match v {
                            FieldValue::Resource(v) => Some((k, mrid_of(v))),
                            _ => None,
                        })
                        .collect();
                    own.sort_unstable();
                    let target = own.first().map(|(_, t)| *t);
                    targets.extend(target.map(str::to_string));
                    let ranges: Vec<&cimmodel::Element> =
                        of(alteration_id, "RangeConstraint.GridStateAlteration")
                            .into_iter()
                            .filter_map(|r| self.dataset.entries.get(r))
                            .collect();
                    let values: Vec<Value> = ranges
                        .iter()
                        .map(|r| {
                            json!({
                                "property": Self::text(r, "StaticPropertyRange.PropertyReference"),
                                "valueKind": Self::text(r, "RangeConstraint.valueKind"),
                                "direction": Self::text(r, "RangeConstraint.direction"),
                                "value": r.get_str("RangeConstraint.normalValue"),
                            })
                        })
                        .collect();
                    if alteration.local_name() == "TopologyAction"
                        && let Some(switch) =
                            alteration.get_ref("TopologyAction.Switch").map(mrid_of)
                    {
                        let absolute: Vec<f64> = ranges
                            .iter()
                            .filter(|r| {
                                Self::text(r, "StaticPropertyRange.PropertyReference").as_deref()
                                    == Some("Switch.open")
                            })
                            .filter(|r| {
                                Self::text(r, "RangeConstraint.valueKind").as_deref()
                                    == Some("absolute")
                            })
                            .filter_map(|r| r.get_f64("RangeConstraint.normalValue"))
                            .collect();
                        let after = absolute.last().map(|v| *v != 0.0);
                        let now = self
                            .dataset
                            .entries
                            .get(switch)
                            .and_then(|s| s.get_str("Switch.open"));
                        let mut cell = self.linked(switch);
                        cell["open"] = json!(now);
                        cell["openAfter"] = json!(after);
                        cell["changes"] = json!(match (now, after) {
                            (Some(now), Some(after)) => Some((now == "true") != after),
                            _ => None,
                        });
                        applied.push(cell);
                    }
                    alterations.push(json!({
                        "id": alteration_id, "class": alteration.local_name(),
                        "label": alteration.get_str("IdentifiedObject.name"),
                        "target": target.map(|t| self.linked(t)),
                        "enabled": Self::text(alteration, "GridStateAlteration.normalEnabled"),
                        "values": values,
                    }));
                }
                let dependencies: Vec<Value> = of(id, "RemedialActionDependency.RemedialAction")
                    .into_iter()
                    .filter_map(|d| Some((d, self.dataset.entries.get(d)?)))
                    .map(|(d, dependency)| {
                        let group = dependency.get_ref("RemedialActionDependency.DependingRemedialActionGroup").map(mrid_of);
                        let others: Vec<Value> = group
                            .map(|g| of(g, "RemedialActionDependency.DependingRemedialActionGroup"))
                            .unwrap_or_default()
                            .into_iter()
                            .filter(|other| *other != d)
                            .filter_map(|other| self.dataset.entries.get(other)?.get_ref("RemedialActionDependency.RemedialAction"))
                            .map(|ra| self.linked(mrid_of(ra)))
                            .collect();
                        json!({
                            "id": d, "kind": Self::text(dependency, "RemedialActionDependency.kind"),
                            "group": group.map(|g| self.linked(g)), "with": others,
                        })
                    })
                    .collect();
                rows.push(json!({
                    "id": id, "label": element.get_str("IdentifiedObject.name"), "class": class,
                    "kind": Self::text(element, "RemedialAction.kind"),
                    "available": Self::text(element, "RemedialAction.normalAvailable"),
                    "alterations": alterations, "dependencies": dependencies, "applied": applied,
                }));
                targets_of_rows.push(targets);
            }
        }
        let rows = rows
            .into_iter()
            .zip(targets_of_rows)
            .map(|(mut row, targets)| {
                let places: Vec<Value> = targets
                    .iter()
                    .filter_map(|t| self.place_on_grid(t))
                    .collect();
                row["grid"] = json!(places);
                row
            })
            .collect();
        Value::Array(rows)
    }
}

/// Time points by schedule: (time in seconds, if readable; id; point), in time order.
type Points<'a> = BTreeMap<&'a str, Vec<(Option<i64>, &'a str, &'a cimmodel::Element)>>;

/// A schedule's yes/no values by time, and its interpolation.
type Flags = (Vec<(i64, bool)>, Option<String>);

/// Schedules: their time points, what they are about, and the exclusive remedial actions they
/// activate at the same time.
impl Session {
    /// A field's declaration, by any of the element's types.
    fn declared(
        element: &cimmodel::Element,
        key: &str,
    ) -> Option<&'static cimmodel::base::AttrDef> {
        let registry = type_registry();
        element.types().find_map(|class| registry.attr(class, key))
    }

    /// The objects `element` refers to, as (field, target), by field: associations, and references
    /// no class table declares; not an enumeration's value.
    fn associations(element: &cimmodel::Element) -> Vec<(&'static str, &str)> {
        let mut found: Vec<(&'static str, &str)> = element
            .fields()
            .iter()
            .filter(|(key, _)| {
                !Self::declared(element, key).is_some_and(|a| matches!(a.kind, AttrKind::Enum))
            })
            .flat_map(|(&key, value)| {
                let targets: Vec<&str> = match value {
                    FieldValue::Resource(v) => vec![mrid_of(v)],
                    FieldValue::ResourceList(vs) => vs.iter().map(|v| mrid_of(v)).collect(),
                    FieldValue::Text(_) | FieldValue::TextList(_) => Vec::new(),
                };
                targets.into_iter().map(move |t| (key, t))
            })
            .collect();
        found.sort_unstable();
        found
    }

    /// What `element` writes of its own, by field: values and enumerations, without its name and
    /// mRID, and without `skip`. `time` marks a date and time.
    fn values(element: &cimmodel::Element, skip: &[&str]) -> Vec<Value> {
        let mut found: Vec<(&str, Value)> = element
            .fields()
            .iter()
            .filter(|(key, _)| !key.starts_with("IdentifiedObject.") && !skip.contains(key))
            .filter_map(|(&key, value)| {
                let declared = Self::declared(element, key);
                let text = match (value, declared.map(|a| &a.kind)) {
                    (FieldValue::Text(_), _) => element.get_str(key)?,
                    (FieldValue::Resource(_), Some(AttrKind::Enum)) => element.get_ref(key)?,
                    _ => return None,
                };
                let short = key.rsplit_once('.').map_or(key, |(_, k)| k);
                let value = mrid_of(text);
                // An enumeration's value without its type: `Currency.EUR` → `EUR`.
                let value = match declared.map(|a| &a.kind) {
                    Some(AttrKind::Enum) => value.rsplit_once('.').map_or(value, |(_, v)| v),
                    _ => value,
                };
                let time = declared.is_some_and(|a| a.xsd == "dateTime");
                Some((key, json!({ "key": short, "value": value, "time": time })))
            })
            .collect();
        found.sort_by_key(|(key, _)| *key);
        found.into_iter().map(|(_, v)| v).collect()
    }

    /// The schedules, in groups of those that refer to one another (an event schedule and the
    /// remedial action schedule it times, an availability schedule and its planned events): what
    /// each group is about, and each schedule's interpolation, values and time points, in time
    /// order. Then each group of remedial actions depending exclusively on one another, with the
    /// times at which more than one of them is active: by the event schedules of their remedial
    /// action schedules, at each of those schedules' time points, a value holding between points
    /// as the schedule's interpolation says (`previous`, `next`; else only at its points).
    pub fn schedules(&mut self) -> Value {
        // Time points by schedule.
        let mut points: Points = BTreeMap::new();
        let mut point_classes: Vec<&str> = self
            .dataset
            .by_type
            .keys()
            .map(|k| k.rsplit_once(':').map_or(k.as_str(), |(_, n)| n))
            .filter(|k| k.ends_with("TimePoint"))
            .collect();
        point_classes.sort_unstable();
        point_classes.dedup();
        for local in point_classes {
            for (id, element) in self.of_type(local) {
                let Some((_, schedule)) = Self::associations(element).into_iter().next() else {
                    continue;
                };
                let at = Self::at_time(element).and_then(seconds);
                points.entry(schedule).or_default().push((at, id, element));
            }
        }
        for list in points.values_mut() {
            list.sort_by(|a, b| (a.0.is_none(), a.0, a.1).cmp(&(b.0.is_none(), b.0, b.1)));
        }
        // The schedules: what the time points name, and every object of a schedule class.
        let mut schedules: Vec<&str> = points.keys().copied().collect();
        schedules.extend(
            self.dataset
                .entries
                .iter()
                .filter(|(_, e)| e.types().any(|c| c.local.ends_with("Schedule")))
                .map(|(id, _)| id.as_str()),
        );
        schedules.sort_unstable();
        schedules.dedup();
        let index: BTreeMap<&str, usize> =
            schedules.iter().enumerate().map(|(i, s)| (*s, i)).collect();
        // Linked into groups by the references between them.
        let mut parent: Vec<usize> = (0..schedules.len()).collect();
        fn root(parent: &mut [usize], mut i: usize) -> usize {
            while parent[i] != i {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            i
        }
        for (i, id) in schedules.iter().enumerate() {
            let Some(element) = self.dataset.entries.get(*id) else {
                continue;
            };
            for (_, target) in Self::associations(element) {
                if let Some(&j) = index.get(target) {
                    let (a, b) = (root(&mut parent, i), root(&mut parent, j));
                    parent[a.max(b)] = a.min(b);
                }
            }
        }
        let mut groups: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
        for (i, id) in schedules.iter().enumerate() {
            groups.entry(root(&mut parent, i)).or_default().push(id);
        }
        // What refers to a schedule, but is neither a schedule nor a time point.
        let mut referred: BTreeMap<&str, Vec<(&'static str, &str)>> = BTreeMap::new();
        for (source, element) in &self.dataset.entries {
            if index.contains_key(source.as_str())
                || element.types().any(|c| c.local.ends_with("TimePoint"))
            {
                continue;
            }
            for (key, target) in Self::associations(element) {
                if let Some((&schedule, _)) = index.get_key_value(target) {
                    referred
                        .entry(schedule)
                        .or_default()
                        .push((key, source.as_str()));
                }
            }
        }
        let mut group_of: BTreeMap<&str, usize> = BTreeMap::new();
        let mut rows: Vec<(Option<i64>, Value, Vec<String>)> = Vec::new();
        for (n, members) in groups.values().enumerate() {
            let mut about: Vec<(&str, &str)> = Vec::new();
            let mut by: Vec<(&str, &str)> = Vec::new();
            let mut times: Vec<i64> = Vec::new();
            let shown: Vec<Value> = members
                .iter()
                .map(|id| {
                    group_of.insert(id, n);
                    let element = self.dataset.entries.get(*id);
                    let mut links = Vec::new();
                    for (key, target) in element.map(Self::associations).unwrap_or_default() {
                        let short = key.rsplit_once('.').map_or(key, |(_, k)| k);
                        if index.contains_key(target) {
                            let mut cell = self.linked(target);
                            cell["kind"] = json!(short);
                            links.push(cell);
                        } else if !about.iter().any(|(_, t)| *t == target) {
                            about.push((short, target));
                        }
                    }
                    for (key, source) in referred.get(*id).map_or(&[][..], Vec::as_slice) {
                        if !by.iter().any(|(_, s)| s == source) {
                            by.push((key, source));
                        }
                    }
                    let values = element.map_or(Vec::new(), |e| {
                        Self::values(e, &["BaseTimeSeries.interpolationKind"])
                    });
                    times.extend(
                        values
                            .iter()
                            .filter(|v| v["time"] == true)
                            .filter_map(|v| seconds(v["value"].as_str()?)),
                    );
                    let own = points.get(*id).map_or(&[][..], Vec::as_slice);
                    times.extend(own.iter().filter_map(|p| p.0));
                    let mut cell = self.linked(id);
                    cell["interpolation"] = json!(element.and_then(|e| Self::text(e, "BaseTimeSeries.interpolationKind")));
                    cell["values"] = json!(values);
                    cell["links"] = json!(links);
                    cell["points"] = own
                        .iter()
                        .map(|(_, p, point)| {
                            json!({
                                "id": p, "atTime": Self::at_time(point),
                                "values": Self::values(point, &[]).into_iter().filter(|v| v["key"] != "atTime").collect::<Vec<_>>(),
                            })
                        })
                        .collect();
                    cell
                })
                .collect();
            let first = times.iter().min().copied();
            let row = json!({
                "id": members[0],
                "schedules": shown,
                "about": about.iter().map(|(key, t)| {
                    let mut cell = self.linked(t);
                    cell["kind"] = json!(key);
                    cell
                }).collect::<Vec<_>>(),
                "referredBy": by.iter().map(|(key, s)| {
                    let mut cell = self.linked(s);
                    cell["kind"] = json!(key);
                    cell
                }).collect::<Vec<_>>(),
            });
            let places = about
                .iter()
                .chain(&by)
                .map(|(_, t)| t.to_string())
                .collect();
            rows.push((first, row, places));
        }
        // Groups with times first, in time order.
        rows.sort_by(|a, b| {
            (a.0.is_none(), a.0, a.1["id"].as_str()).cmp(&(b.0.is_none(), b.0, b.1["id"].as_str()))
        });
        let together = self.active_together(&points, &groups, &group_of);
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|(_, mut row, about)| {
                let places: Vec<Value> =
                    about.iter().filter_map(|t| self.place_on_grid(t)).collect();
                row["grid"] = json!(places);
                row
            })
            .collect();
        json!({ "groups": rows, "exclusive": together })
    }

    /// A time point's `atTime`, whatever its class.
    fn at_time(point: &cimmodel::Element) -> Option<&str> {
        let key = point.fields().keys().find(|k| k.ends_with(".atTime"))?;
        point.get_str(key)
    }

    /// The remedial actions that depend exclusively on one another, by group, with the times at
    /// which more than one of them is active. See [`Session::schedules`].
    fn active_together(
        &self,
        points: &Points,
        groups: &BTreeMap<usize, Vec<&str>>,
        group_of: &BTreeMap<&str, usize>,
    ) -> Vec<Value> {
        let groups: Vec<&Vec<&str>> = groups.values().collect();
        let links = self.referrers_by(&[
            "RemedialActionDependency.DependingRemedialActionGroup",
            "RemedialActionSchedule.RemedialAction",
        ]);
        let of = |target: &str, key: &str| -> Vec<&str> {
            links.get(target).map_or(Vec::new(), |list| {
                list.iter()
                    .filter(|(_, k)| *k == key)
                    .map(|(s, _)| *s)
                    .collect()
            })
        };
        // Each schedule's points as (time, active), and its interpolation.
        let series = |schedule: &str| -> Flags {
            let list = points.get(schedule).map_or(&[][..], Vec::as_slice);
            let flags = list
                .iter()
                .filter_map(|(at, _, point)| {
                    let active = Self::values(point, &[])
                        .iter()
                        .find_map(|v| match v["value"].as_str()? {
                            "true" => Some(true),
                            "false" => Some(false),
                            _ => None,
                        })?;
                    Some(((*at)?, active))
                })
                .collect();
            let kind = self
                .dataset
                .entries
                .get(schedule)
                .and_then(|e| Self::text(e, "BaseTimeSeries.interpolationKind"));
            (flags, kind)
        };
        let active_at = |(flags, kind): &Flags, t: i64| -> bool {
            if let Some((_, a)) = flags.iter().rev().find(|(at, _)| *at == t) {
                return *a;
            }
            match kind.as_deref() {
                Some("previous") => flags
                    .iter()
                    .rev()
                    .find(|(at, _)| *at < t)
                    .is_some_and(|(_, a)| *a),
                Some("next") => flags
                    .iter()
                    .find(|(at, _)| *at > t)
                    .is_some_and(|(_, a)| *a),
                _ => false,
            }
        };
        let mut found = Vec::new();
        let mut group_ids: Vec<&str> = self
            .of_type("RemedialActionDependency")
            .filter_map(|(_, d)| d.get_ref("RemedialActionDependency.DependingRemedialActionGroup"))
            .map(mrid_of)
            .collect();
        group_ids.sort_unstable();
        group_ids.dedup();
        for group in group_ids {
            let mut actions: Vec<&str> = of(
                group,
                "RemedialActionDependency.DependingRemedialActionGroup",
            )
            .into_iter()
            .filter_map(|d| self.dataset.entries.get(d))
            .filter(|d| {
                Self::text(d, "RemedialActionDependency.kind").as_deref() == Some("exclusive")
            })
            .filter_map(|d| {
                d.get_ref("RemedialActionDependency.RemedialAction")
                    .map(mrid_of)
            })
            .collect();
            actions.sort_unstable();
            actions.dedup();
            if actions.len() < 2 {
                continue;
            }
            // Each action's activation: the time series of its remedial action schedules' groups.
            let mut timed: Vec<(&str, Vec<Flags>, Vec<&str>)> = Vec::new();
            for action in &actions {
                let mut members: Vec<&str> = of(action, "RemedialActionSchedule.RemedialAction")
                    .into_iter()
                    .filter_map(|s| group_of.get(s))
                    .flat_map(|&g| groups[g].iter().copied())
                    .collect();
                members.sort_unstable();
                members.dedup();
                let all: Vec<_> = members
                    .iter()
                    .map(|s| series(s))
                    .filter(|s| !s.0.is_empty())
                    .collect();
                let schedules = members
                    .iter()
                    .copied()
                    .filter(|s| points.contains_key(s))
                    .collect();
                timed.push((action, all, schedules));
            }
            if timed.iter().all(|(_, s, _)| s.is_empty()) {
                continue;
            }
            let mut candidates: Vec<i64> = timed
                .iter()
                .flat_map(|(_, all, _)| {
                    all.iter()
                        .flat_map(|(flags, _)| flags.iter().map(|(t, _)| *t))
                })
                .collect();
            candidates.sort_unstable();
            candidates.dedup();
            let times: Vec<Value> = candidates
                .into_iter()
                .filter_map(|t| {
                    let on: Vec<&str> = timed
                        .iter()
                        .filter(|(_, all, _)| all.iter().any(|s| active_at(s, t)))
                        .map(|(a, _, _)| *a)
                        .collect();
                    (on.len() > 1).then(|| json!({ "at": iso(t), "actions": on }))
                })
                .collect();
            found.push(json!({
                "group": self.linked(group),
                "actions": timed.iter().map(|(a, _, schedules)| {
                    let mut cell = self.linked(a);
                    cell["schedules"] = json!(schedules);
                    cell
                }).collect::<Vec<_>>(),
                "together": times,
            }));
        }
        found
    }
}

/// An `xsd:dateTime` as seconds since 1970, UTC: `2024-11-20T02:30:00Z`, with or without seconds'
/// fractions (dropped) and an offset (`+01:00`; none is taken as UTC).
fn seconds(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, time) = text.split_once('T')?;
    let mut d = date.splitn(3, '-');
    let (y, m, day): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    let (clock, offset) = match time.find(['Z', '+', '-']) {
        Some(at) => (&time[..at], &time[at..]),
        None => (time, ""),
    };
    let mut c = clock.splitn(3, ':');
    let (h, min): (i64, i64) = (c.next()?.parse().ok()?, c.next()?.parse().ok()?);
    let s: i64 = c
        .next()
        .map_or(Some(0), |s| s.split('.').next()?.parse().ok())?;
    let shift = match offset {
        "" | "Z" => 0,
        _ => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let (oh, om) = offset[1..].split_once(':')?;
            sign * (oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60)
        }
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + min * 60 + s - shift)
}

/// Seconds since 1970 as `2024-11-20T02:30:00Z`.
fn iso(t: i64) -> String {
    let (days, rest) = (t.div_euclid(86_400), t.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
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

    /// A second dataset: it depends on the grid's and on one not loaded, defines the breaker
    /// again, and names a concept of reference data.
    const SECOND: &str = include_str!("../../../web/tests/fixtures/second_EQ.xml");

    fn two_datasets() -> Session {
        let mut session = Session::new();
        session.add_file("grid_EQ.xml", GRID);
        session.add_file("second_EQ.xml", SECOND);
        session.check_file("grid_EQ.xml", GRID).unwrap();
        session.check_file("second_EQ.xml", SECOND).unwrap();
        session.validate(Checks::default());
        session
    }

    #[test]
    fn datasets_wait_for_the_files_to_be_read_one_by_one() {
        let mut session = Session::new();
        session.add_file("grid_EQ.xml", GRID);
        assert!(session.datasets().is_null());
        assert!(two_datasets().datasets().is_object());
    }

    #[test]
    fn each_dataset_shows_its_header_and_where_its_references_lead() {
        let datasets = two_datasets().datasets();
        let files = datasets["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        let header = &files[1]["header"];
        assert_eq!(
            header["id"],
            "urn:uuid:00000000-0000-4000-8000-000000000f02"
        );
        assert_eq!(
            header["profiles"],
            json!(["http://iec.ch/TC57/ns/CIM/CoreEquipment-EU/3.0"])
        );
        let on = &header["refs"][0];
        assert_eq!(on["key"], "Model.DependentOn");
        let values = on["values"].as_array().unwrap();
        assert_eq!(
            values[0]["ref"],
            "urn:uuid:00000000-0000-4000-8000-000000000f01"
        );
        assert!(values[0].get("missing").is_none(), "{values:?}");
        assert_eq!(values[1]["missing"], true);
        assert_eq!(files[1]["foreign"], 1);
    }

    #[test]
    fn an_object_two_datasets_define_is_listed_and_says_where() {
        let mut session = two_datasets();
        let twice = &session.datasets()["twice"];
        assert_eq!(twice["count"], 1);
        assert_eq!(twice["objects"][0]["id"], BREAKER);
        assert_eq!(
            twice["objects"][0]["files"],
            json!(["grid_EQ.xml", "second_EQ.xml"])
        );
        assert_eq!(
            session.object(BREAKER)["definedIn"],
            json!(["grid_EQ.xml", "second_EQ.xml"])
        );
    }

    #[test]
    fn reference_data_has_a_page_and_references_reach_it() {
        let mut session = two_datasets();
        let breaker = session.object(BREAKER);
        let fields = breaker["fields"].as_array().unwrap();
        let concept = fields
            .iter()
            .find(|f| f["key"] == "Switch.concept")
            .unwrap();
        assert_eq!(
            concept["values"][0],
            json!({ "text": "A concept", "ref": "https://example.org/concepts#c" })
        );
        let page = session.object("https://example.org/concepts#c");
        assert_eq!(page["foreign"], true);
        assert_eq!(page["class"], "Concept");
        assert_eq!(page["referrers"]["by"][0]["objects"][0]["id"], BREAKER);
    }

    const NC: &str = include_str!("../../../web/tests/fixtures/nc_CO_AE.xml");
    const LINE: &str = "_00000000-0000-4000-8000-000000000a32";

    fn with_nc() -> Session {
        let mut session = grid_session();
        session.add_file("nc_CO_AE.xml", NC);
        session
    }

    #[test]
    fn a_contingency_lists_its_equipment_where_the_grid_shows_it() {
        let rows = with_nc().contingencies();
        let row = &rows[0];
        assert_eq!(row["label"], "Loss of Anvil-Birch");
        assert_eq!(row["class"], "OrdinaryContingency");
        assert_eq!(row["mustStudy"], "true");
        assert_eq!(row["equipment"][0]["id"], LINE);
        assert_eq!(row["equipment"][0]["label"], "Anvil-Birch");
        assert_eq!(row["equipment"][0]["status"], "outOfService");
        assert_eq!(row["assessed"][0]["label"], "Flow on Anvil-Birch");
        assert_eq!(row["assessed"][0]["kind"], "excluded");
        assert_eq!(row["grid"][0]["select"], format!("e:{LINE}"));
    }

    #[test]
    fn an_assessed_element_says_how_it_is_assessed_and_with_what() {
        let rows = with_nc().assessed_elements();
        let rows = rows.as_array().unwrap();
        let flow = rows
            .iter()
            .find(|r| r["label"] == "Flow on Anvil-Birch")
            .unwrap();
        assert_eq!(flow["inBaseCase"], "true");
        assert_eq!(
            flow["securedFor"],
            json!({ "id": "_region", "label": null, "class": null, "missing": true })
        );
        assert_eq!(flow["assesses"]["label"], "Anvil-Birch");
        assert_eq!(flow["contingencies"][0]["kind"], "excluded");
        assert_eq!(flow["grid"][0]["select"], format!("e:{LINE}"));
        let scanned = rows
            .iter()
            .find(|r| r["label"] == "Breaker A scanned")
            .unwrap();
        assert!(scanned["securedFor"].is_null());
        assert_eq!(
            scanned["exclusionReason"],
            "nonNativeCapacityCalculationRegion"
        );
        assert_eq!(scanned["grid"][0]["enter"], ANVIL);
    }

    const RA: &str = include_str!("../../../web/tests/fixtures/nc_RA.xml");

    fn with_ra() -> Session {
        let mut session = grid_session();
        session.add_file("nc_RA.xml", RA);
        session
    }

    #[test]
    fn the_remedial_action_fixture_decodes_as_declared() {
        let mut session = with_ra();
        for id in ["d01", "d02", "d03", "d20", "d21"] {
            let object = session.object(&format!("_00000000-0000-4000-8000-000000000{id}"));
            assert_eq!(object["foreign"], false, "{id}");
            let undeclared: Vec<_> = object["fields"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|f| f["declared"] == false)
                .collect();
            assert!(undeclared.is_empty(), "{id}: {undeclared:?}");
        }
    }

    #[test]
    fn a_remedial_action_says_what_it_changes_and_what_applying_it_gives() {
        let rows = with_ra().remedial_actions();
        let rows = rows.as_array().unwrap();
        let open = rows
            .iter()
            .find(|r| r["label"] == "Open Breaker A")
            .unwrap();
        assert_eq!(open["kind"], "preventive");
        let alteration = &open["alterations"][0];
        assert_eq!(alteration["class"], "TopologyAction");
        assert_eq!(alteration["target"]["id"], BREAKER);
        assert_eq!(alteration["enabled"], "true");
        assert_eq!(
            alteration["values"][0],
            json!({ "property": "Switch.open", "valueKind": "absolute", "direction": "none", "value": "1.0" })
        );
        let applied = &open["applied"][0];
        assert_eq!(
            (
                applied["open"].clone(),
                applied["openAfter"].clone(),
                applied["changes"].clone()
            ),
            (json!("false"), json!(true), json!(true))
        );
        assert_eq!(open["grid"][0]["enter"], ANVIL);
        // As RA_UC1's: an absolute value of 0 leaves a closed switch closed.
        let closed = rows
            .iter()
            .find(|r| r["label"] == "Keep Breaker A closed")
            .unwrap();
        assert_eq!(closed["applied"][0]["openAfter"], false);
        assert_eq!(closed["applied"][0]["changes"], false);
    }

    #[test]
    fn a_remedial_action_says_which_actions_share_its_group() {
        let rows = with_ra().remedial_actions();
        let open = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["label"] == "Open Breaker A")
            .unwrap()
            .clone();
        let dependency = &open["dependencies"][0];
        assert_eq!(dependency["kind"], "exclusive");
        assert_eq!(dependency["group"]["label"], "Breaker A either way");
        assert_eq!(dependency["with"][0]["label"], "Keep Breaker A closed");
    }

    const STATE: &str = include_str!("../../../web/tests/fixtures/grid_state.xml");
    const SV: &str = include_str!("../../../web/tests/fixtures/grid_SV.xml");

    fn solvable() -> Session {
        let mut session = Session::new();
        session.add_file("grid_EQ.xml", GRID);
        session.add_file("grid_state.xml", STATE);
        session.add_file("grid_SV.xml", SV);
        session
    }

    #[test]
    fn a_power_flow_says_what_it_solved_and_how_far_from_the_sv() {
        let flow = solvable().power_flow(PowerFlowOptions::default());
        assert_eq!(flow["error"], Value::Null);
        assert_eq!(
            flow["options"],
            json!({ "sharing": "reference", "qLimits": true })
        );
        let component = &flow["components"][0];
        assert_eq!(component["status"], "converged");
        assert_eq!(component["nodes"], 2);
        assert_eq!(component["references"][0]["label"], "Anvil 110");
        let birch = flow["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["label"] == "Birch 110")
            .unwrap();
        assert_eq!(birch["sv"], json!({ "kV": 100.0, "deg": -2.0 }));
        assert!((birch["kV"].as_f64().unwrap() - 110.555).abs() < 0.01);
        assert!((birch["dvPercent"].as_f64().unwrap() - 10.555).abs() < 0.01);
        assert_eq!(birch["at"], "_00000000-0000-4000-8000-000000000a02");
        assert_eq!(component["sv"]["dvPercent"], birch["dvPercent"]);
    }

    #[test]
    fn a_power_flow_puts_voltages_and_loadings_where_the_grid_draws_them() {
        let flow = solvable().power_flow(PowerFlowOptions::default());
        let overlay = &flow["overlay"];
        assert_eq!(
            overlay["nodes"]["_00000000-0000-4000-8000-000000000a02"]["min"],
            1.005
        );
        // A connectivity node has its topological node's voltage.
        assert_eq!(
            overlay["voltages"]["_00000000-0000-4000-8000-000000000a23"],
            overlay["voltages"]["_00000000-0000-4000-8000-000000000601"]
        );
        let line = &overlay["flows"][LINE];
        assert!((line["loading"].as_f64().unwrap() - 133.14).abs() < 0.1);
        assert_eq!(line["ends"][1]["p"], -50.0);
        let violation = &flow["violations"][0];
        assert_eq!(violation["equipment"]["label"], "Anvil-Birch");
        assert_eq!(violation["kind"], "PATL");
        assert_eq!(violation["limitAmps"], 200.0);
    }

    #[test]
    fn a_node_with_no_angle_reference_is_counted_and_not_solved() {
        let mut session = solvable();
        session.add_file(
            "lone.xml",
            r##"<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <cim:TopologicalNode rdf:ID="_00000000-0000-4000-8000-000000000631">
    <cim:IdentifiedObject.name>Lone</cim:IdentifiedObject.name>
    <cim:TopologicalNode.BaseVoltage rdf:resource="#_00000000-0000-4000-8000-000000000b00"/>
  </cim:TopologicalNode>
</rdf:RDF>"##,
        );
        let flow = session.power_flow(PowerFlowOptions::default());
        let statuses: Vec<&str> = flow["components"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["status"].as_str().unwrap())
            .collect();
        assert!(statuses.contains(&"converged"), "{statuses:?}");
        assert!(statuses.contains(&"noReference"), "{statuses:?}");
        let lone = flow["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["label"] == "Lone")
            .unwrap();
        assert_eq!(lone["pu"], Value::Null);
    }

    #[test]
    fn a_model_without_its_state_says_why_nothing_was_solved() {
        let mut session = Session::new();
        session.add_file("grid_EQ.xml", GRID);
        let flow = session.power_flow(PowerFlowOptions::default());
        assert!(
            flow["error"].as_str().is_some_and(|e| !e.is_empty()),
            "{flow}"
        );
    }

    const MORE: &str = include_str!("../../../web/tests/fixtures/nc_CO_more.xml");

    /// The small grid with its state and four contingencies, its analysis run `batch` at a time.
    fn analysed(batch: usize) -> Session {
        let mut session = solvable();
        session.add_file("nc_CO_AE.xml", NC);
        session.add_file("nc_CO_more.xml", MORE);
        assert_eq!(
            session.analysis_start(PowerFlowOptions::default()),
            json!({ "error": null, "total": 4 })
        );
        loop {
            let step = session.analysis_step(batch);
            assert_eq!(step["error"], Value::Null);
            if step["done"] == step["total"] {
                return session;
            }
        }
    }

    fn header() -> gridoxide::security_analysis::SarHeader {
        gridoxide::security_analysis::SarHeader {
            title: "t".into(),
            description: "d".into(),
            publisher: "https://example.org/p".into(),
            is_version_of: "https://example.org/m".into(),
            rights_holder: "r".into(),
            generated_at: "2026-11-12T00:00:00Z".into(),
        }
    }

    #[test]
    fn an_analysis_in_batches_is_the_analysis_in_one() {
        let mut whole = analysed(10);
        for batch in [1, 3] {
            let mut parts = analysed(batch);
            assert_eq!(parts.analysis_result(), whole.analysis_result(), "{batch}");
            assert_eq!(parts.sar(&header()), whole.sar(&header()), "{batch}");
        }
    }

    #[test]
    fn an_analysis_says_what_each_contingency_gives() {
        let result = analysed(2).analysis_result();
        assert_eq!(result["total"], 4);
        assert_eq!(result["solved"], 3);
        assert_eq!(result["absent"][0]["label"], "Loss of Unit X");
        assert_eq!(result["baseViolations"], 1);
        assert_eq!(result["violations"], 1);
        let rows = result["contingencies"].as_array().unwrap();
        let nothing = rows.iter().find(|c| c["label"] == "Nothing lost").unwrap();
        assert_eq!(nothing["outcome"], "solved");
        assert_eq!(nothing["violations"], 1);
        assert!((nothing["worst"].as_f64().unwrap() - 133.14).abs() < 0.1);
        let load = rows
            .iter()
            .find(|c| c["label"] == "Loss of Load B")
            .unwrap();
        assert_eq!(load["violations"], 0);
        assert_eq!(load["equipment"][0]["label"], "Load B");
        // The worst first.
        assert_eq!(rows[0]["label"], "Nothing lost");
        let line = &result["elements"][0];
        assert_eq!(line["equipment"]["label"], "Anvil-Birch");
        assert_eq!(line["contingencies"], 1);
        assert_eq!(line["worstContingency"]["label"], "Nothing lost");
        assert!(line["base"].as_f64().is_some());
        assert_eq!(
            result["requires"],
            json!([
                "urn:uuid:00000000-0000-4000-8000-000000000f03",
                "urn:uuid:00000000-0000-4000-8000-000000000f07"
            ])
        );
    }

    #[test]
    fn an_analysis_lists_the_violations_of_a_contingency_or_an_element() {
        let session = analysed(4);
        let base = session.analysis_violations(None, None);
        assert_eq!(base.as_array().unwrap().len(), 1);
        assert_eq!(base[0]["contingency"], Value::Null);
        assert_eq!(base[0]["limit"]["label"], "Anvil-Birch PATL");
        let nothing =
            session.analysis_violations(Some("_00000000-0000-4000-8000-000000000701"), None);
        assert_eq!(nothing[0]["equipment"]["label"], "Anvil-Birch");
        let at = session.analysis_violations(None, Some("_00000000-0000-4000-8000-000000000a44"));
        assert_eq!(at.as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_sar_is_written_once_the_analysis_is_done_and_its_header_offered() {
        let mut session = analysed(4);
        let defaults = session.sar_defaults();
        assert_eq!(
            defaults["publisher"],
            "https://energy.referencedata.eu/test/party/South"
        );
        assert_eq!(defaults["rightsHolder"], "South TSO");
        let sar = session.sar(&header()).unwrap();
        assert!(sar.contains("SecurityAnalysisResult"), "{sar}");
        assert!(sar.contains("urn:uuid:00000000-0000-4000-8000-000000000f07"));
        // Its results, read back with the model, are the analysis's own.
        session.add_file("sar.xml", &sar);
        let results = session.sar_results();
        let rows = results.as_array().unwrap();
        assert!(!rows.is_empty());
        assert!(
            rows.iter().all(|r| r["terminal"]["missing"].is_null()),
            "{results}"
        );
    }

    #[test]
    fn a_new_file_ends_the_analysis_and_without_contingencies_there_is_none() {
        let mut session = analysed(4);
        session.add_file("lone.xml", r##"<?xml version="1.0"?><rdf:RDF xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><cim:Breaker rdf:ID="_00000000-0000-4000-8000-000000000632"/></rdf:RDF>"##);
        assert_eq!(session.analysis_result(), Value::Null);
        let mut bare = solvable();
        assert!(
            bare.analysis_start(PowerFlowOptions::default())["error"]
                .as_str()
                .is_some()
        );
    }

    const RAS: &str = include_str!("../../../web/tests/fixtures/nc_RAS.xml");

    /// With the contingencies too, as the page's tests load them: no identifier may clash.
    fn with_ras() -> Session {
        let mut session = with_ra();
        session.add_file("nc_CO_AE.xml", NC);
        session.add_file("nc_RAS.xml", RAS);
        session
    }

    fn e(id: &str) -> String {
        format!("_00000000-0000-4000-8000-000000000{id}")
    }

    #[test]
    fn the_schedule_fixture_decodes_as_declared() {
        let mut session = with_ras();
        for id in [
            "501", "502", "503", "512", "513", "521", "522", "531", "532", "533",
        ] {
            let object = session.object(&e(id));
            assert_eq!(object["foreign"], false, "{id}");
            let undeclared: Vec<_> = object["fields"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|f| f["declared"] == false)
                .collect();
            assert!(undeclared.is_empty(), "{id}: {undeclared:?}");
        }
    }

    #[test]
    fn schedules_that_refer_to_one_another_are_a_group_with_their_points_in_time_order() {
        let schedules = with_ras().schedules();
        let groups = schedules["groups"].as_array().unwrap();
        let open = groups
            .iter()
            .find(|g| {
                g["about"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|a| a["label"] == "Open Breaker A")
            })
            .unwrap();
        let ids: Vec<&str> = open["schedules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, [e("501"), e("502")]);
        assert_eq!(open["about"][0]["kind"], "RemedialAction");
        let event = &open["schedules"][1];
        assert_eq!(event["interpolation"], "none");
        assert_eq!(event["links"][0]["id"], e("501"));
        assert_eq!(
            open["schedules"][0]["values"],
            json!([{ "key": "statusKind", "value": "proposed", "time": false }])
        );
        let times: Vec<&str> = event["points"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["atTime"].as_str().unwrap())
            .collect();
        assert_eq!(times, ["2024-11-20T10:00:00Z", "2024-11-20T12:00:00Z"]);
        assert_eq!(
            event["points"][0]["values"],
            json!([{ "key": "isActive", "value": "true", "time": false }])
        );
        // In time order, a schedule's own dates included: the cancellation on the 19th, then
        // Open's group from 10:00, Keep closed's from 11:00 UTC; the shift key's from 11:30.
        let order: Vec<&str> = groups.iter().map(|g| g["id"].as_str().unwrap()).collect();
        assert_eq!(order, [e("522"), e("501"), e("511"), e("531")]);
    }

    #[test]
    fn a_cancelled_schedule_without_points_says_when_it_was_cancelled() {
        let schedules = with_ras().schedules();
        let groups = schedules["groups"].as_array().unwrap();
        let cancelled = groups.iter().find(|g| g["id"] == e("522")).unwrap();
        let schedule = &cancelled["schedules"][0];
        assert_eq!(schedule["points"], json!([]));
        assert_eq!(
            schedule["values"],
            json!([
                { "key": "cancelledDateTime", "value": "2024-11-19T08:34:00Z", "time": true },
                { "key": "causeKind", "value": "maintenance", "time": false },
            ])
        );
        assert_eq!(cancelled["about"][0]["label"], "Make Breaker A available");
    }

    #[test]
    fn a_schedule_says_what_refers_to_it() {
        let schedules = with_ras().schedules();
        let groups = schedules["groups"].as_array().unwrap();
        let key = groups.iter().find(|g| g["id"] == e("531")).unwrap();
        assert_eq!(key["referredBy"][0]["label"], "Distribution 1");
        assert_eq!(
            key["referredBy"][0]["kind"],
            "PowerShiftKeyDistribution.PowerShiftKeySchedule"
        );
        assert_eq!(
            key["schedules"][0]["points"][0]["values"],
            json!([{ "key": "participationFactor", "value": "0.5", "time": false }])
        );
    }

    #[test]
    fn exclusive_actions_active_together_are_found_by_their_interpolation() {
        let schedules = with_ras().schedules();
        let exclusive = &schedules["exclusive"][0];
        assert_eq!(exclusive["group"]["label"], "Breaker A either way");
        // The schedules giving its activation: those with time points.
        assert_eq!(exclusive["actions"][0]["schedules"], json!([e("502")]));
        // Keep closed is active from 11:00 UTC on (previous, written as 12:00+01:00), Open at its
        // points only (none): only at 12:00 are both.
        assert_eq!(
            exclusive["together"],
            json!([{ "at": "2024-11-20T12:00:00Z", "actions": [e("d01"), e("d11")] }])
        );
    }

    #[test]
    fn date_times_read_with_their_offset() {
        assert_eq!(seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            seconds("2024-11-20T12:00:00+01:00"),
            seconds("2024-11-20T11:00:00Z")
        );
        assert_eq!(
            seconds("2024-02-29T23:59:59.5-00:30"),
            seconds("2024-03-01T00:29:59Z")
        );
        assert_eq!(seconds("2024-11-20"), None);
        assert_eq!(
            iso(seconds("2024-02-29T13:05:09Z").unwrap()),
            "2024-02-29T13:05:09Z"
        );
    }

    #[test]
    fn a_model_without_network_codes_has_empty_tables() {
        let mut session = grid_session();
        assert_eq!(session.contingencies(), json!([]));
        assert_eq!(session.assessed_elements(), json!([]));
        assert_eq!(session.remedial_actions(), json!([]));
        assert_eq!(
            session.schedules(),
            json!({ "groups": [], "exclusive": [] })
        );
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
