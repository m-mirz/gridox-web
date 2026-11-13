//! Editing the loaded files as written, through cimoxide-view's edits: renaming an mRID, deleting
//! and adding objects, setting and removing a field, and the fixes for an object's findings. Each
//! edit changes the files' texts, which are decoded again into the model; the texts before it are
//! kept, to undo it.

use std::collections::{BTreeSet, HashSet};

use cimmodel::CimDataset;
use cimmodel::base::AttrKind;
use cimmodel::registry::type_registry;
use cimview::edit::{self as ed, File};
use cimview::index::{IdKind, Index};
use cimview::text::{LineIndex, TextEdit, apply};
use serde_json::{Value, json};

use super::Session;

/// The loaded files as text, and what editing them needs.
#[derive(Default)]
pub(super) struct Texts {
    /// Each loaded file, by name, in the order loaded.
    pub(super) files: Vec<(String, String)>,
    /// Each file's lines and index, built for the first edit after a change.
    built: Option<Vec<(LineIndex, Index)>>,
    /// The texts each edit replaced, the last last: a file is edited while an edit here changed it.
    /// `None`: the edit created the file.
    history: Vec<Vec<(String, Option<String>)>>,
    /// Counts the changes, so that an edit offered for one state is not applied to another.
    revision: u64,
    /// The files loaded but left out of the model, by name: their texts kept for when they come back.
    pub(super) aside: Vec<(String, String)>,
}

impl Texts {
    pub(super) fn add(&mut self, name: &str, text: &str) {
        self.files.push((name.to_string(), text.to_string()));
        self.built = None;
        self.revision += 1;
    }
}

/// Edits by file name, owned.
type Owned = Vec<(String, Vec<TextEdit>)>;

fn owned(edits: ed::Edits) -> Owned {
    edits.into_iter().map(|(n, e)| (n.to_string(), e)).collect()
}

impl Session {
    fn build_texts(&mut self) {
        if self.texts.built.is_none() {
            let built = self
                .texts
                .files
                .iter()
                .map(|(_, t)| (LineIndex::new(t), Index::build(t)))
                .collect();
            self.texts.built = Some(built);
        }
    }

    /// The files as cimoxide-view takes them. [`Session::build_texts`] first.
    fn edit_files(&self) -> Vec<File<'_>> {
        let built = self.texts.built.as_ref().expect("built");
        self.texts
            .files
            .iter()
            .zip(built)
            .map(|((name, text), (lines, index))| File {
                name,
                text,
                lines,
                index,
            })
            .collect()
    }

    /// `edits` applied: the texts changed, the model decoded again from them, what was built on
    /// it gone. The files changed, and the revision now.
    fn apply_edits(&mut self, edits: Owned) -> Value {
        let mut before = Vec::new();
        for (name, changes) in &edits {
            if let Some((_, text)) = self.texts.files.iter_mut().find(|(n, _)| n == name) {
                before.push((name.clone(), Some(text.clone())));
                *text = apply(text, changes);
            }
        }
        if before.is_empty() {
            return json!({ "error": "nothing to change", "changed": [] });
        }
        let changed: Vec<String> = before.iter().map(|(n, _)| n.clone()).collect();
        self.texts.history.push(before);
        self.reload();
        json!({ "error": null, "changed": changed, "revision": self.texts.revision })
    }

    /// The model decoded again from the texts, as loading them did.
    fn reload(&mut self) {
        let mut dataset = CimDataset::default();
        for (_, text) in &self.texts.files {
            if let Ok(found) = CimDataset::decode_str(text) {
                dataset.merge(found);
            }
        }
        self.dataset = dataset;
        self.views = None;
        self.validated = None;
        self.facts = None;
        self.analysis = None;
        self.texts.built = None;
        self.texts.revision += 1;
    }

    fn error(message: impl std::fmt::Display) -> Value {
        json!({ "error": message.to_string(), "changed": [] })
    }

    /// What the files say of editing: which are edited, how many edits can be undone, and the
    /// revision edits are offered for.
    pub fn edit_state(&self) -> Value {
        let edited: BTreeSet<&str> = self
            .texts
            .history
            .iter()
            .flatten()
            .map(|(n, _)| n.as_str())
            .collect();
        json!({
            "edited": edited,
            "undo": self.texts.history.len(),
            "revision": self.texts.revision,
        })
    }

    /// A file's text as it is now, in the model or left out of it.
    pub fn file_text(&self, name: &str) -> Option<&str> {
        self.texts
            .files
            .iter()
            .chain(&self.texts.aside)
            .find(|(n, _)| n == name)
            .map(|(_, t)| t.as_str())
    }

    /// The model made of the files loaded but `excluded`, in the order they were loaded; the others
    /// kept aside, as they are now, to come back. The undo history goes, as an edit may have
    /// changed a file now left out.
    pub fn set_excluded(&mut self, excluded: &[String]) {
        let now: Vec<&str> = self.texts.aside.iter().map(|(n, _)| n.as_str()).collect();
        let mut asked: Vec<&str> = excluded.iter().map(String::as_str).collect();
        asked.retain(|n| {
            self.texts
                .files
                .iter()
                .chain(&self.texts.aside)
                .any(|(f, _)| f == n)
        });
        let (mut a, mut b) = (now.clone(), asked.clone());
        a.sort_unstable();
        b.sort_unstable();
        if a == b {
            return;
        }
        let order: Vec<String> = self
            .files
            .iter()
            .filter_map(|f| match f {
                super::FileOutcome::Loaded { name, .. } => Some(name.clone()),
                super::FileOutcome::Skipped { .. } => None,
            })
            .collect();
        let mut all: Vec<(String, String)> = std::mem::take(&mut self.texts.files);
        all.append(&mut self.texts.aside);
        all.sort_by_key(|(n, _)| order.iter().position(|o| o == n).unwrap_or(usize::MAX));
        let (aside, files): (Vec<_>, Vec<_>) =
            all.into_iter().partition(|(n, _)| excluded.contains(n));
        self.texts.files = files;
        self.texts.aside = aside;
        self.texts.history.clear();
        self.reload();
    }

    /// The last edit undone; a file it created, gone.
    pub fn edit_undo(&mut self) -> Value {
        let Some(before) = self.texts.history.pop() else {
            return Self::error("nothing to undo");
        };
        let (mut changed, mut removed) = (Vec::new(), Vec::new());
        for (name, text) in before {
            match text {
                Some(text) => {
                    if let Some((_, now)) = self.texts.files.iter_mut().find(|(n, _)| *n == name) {
                        *now = text;
                        changed.push(name);
                    }
                }
                None => {
                    self.texts.files.retain(|(n, _)| *n != name);
                    self.files.retain(
                        |f| !matches!(f, super::FileOutcome::Loaded { name: n, .. } if *n == name),
                    );
                    removed.push(name);
                }
            }
        }
        self.reload();
        json!({ "error": null, "changed": changed, "removed": removed, "revision": self.texts.revision })
    }

    /// The objects that can answer a remedial action schedule: the system operators loaded.
    pub fn edit_responders(&self) -> Value {
        let reg = type_registry();
        let mut found: Vec<(&str, &cimmodel::Element)> = self
            .dataset
            .entries
            .iter()
            .filter(|(_, e)| {
                e.types()
                    .any(|c| reg.chain(c).iter().any(|a| a.local == "SystemOperator"))
            })
            .map(|(id, e)| (id.as_str(), e))
            .collect();
        found.sort_by_key(|(id, _)| *id);
        Value::Array(found.into_iter().map(|(id, _)| self.linked(id)).collect())
    }

    /// `edits` applied to the texts alone, for an edit of several steps; the indexes built again.
    fn stage(&mut self, edits: Owned) {
        for (name, changes) in &edits {
            if let Some((_, text)) = self.texts.files.iter_mut().find(|(n, _)| n == name) {
                *text = apply(text, changes);
            }
        }
        self.texts.built = None;
        self.build_texts();
    }

    /// RA_UC4: a counter-proposal to the remedial action schedule `refused`, in a dataset of its
    /// own, as cimoxide's `test_edits.py` builds it: a response refusing the schedule, a copy of
    /// it, its event schedules and their time points with new mRIDs (the points not active), and a
    /// dependency from the copy to the refused one. The new file takes the namespaces and the header
    /// of the file defining `refused`, under a new identifier. One edit, undone as one.
    pub fn edit_counter_proposal(
        &mut self,
        refused: &str,
        responding: Option<&str>,
        random: &[u8],
    ) -> Value {
        if self.dataset.entries.get(refused).map(|e| e.local_name())
            != Some("RemedialActionSchedule")
        {
            return Self::error(format!("`{refused}` is no RemedialActionSchedule"));
        }
        self.build_texts();
        // The RAO's proposal: of the files defining the schedule, the one where it is proposed. A
        // proposal and what was agreed of it may define it alike.
        let built = self.texts.built.as_ref().expect("built");
        let defining: Vec<usize> = (0..built.len())
            .filter(|&i| {
                built[i]
                    .1
                    .elements
                    .iter()
                    .any(|e| e.mrid == refused && e.id_kind == Some(IdKind::Id))
            })
            .collect();
        let proposed = defining.iter().copied().find(|&i| {
            built[i]
                .1
                .elements
                .iter()
                .filter(|e| e.mrid == refused)
                .any(|e| {
                    e.fields.iter().any(|f| {
                        f.key() == "RemedialActionSchedule.statusKind"
                            && f.resource
                                .as_ref()
                                .is_some_and(|(v, _)| v.ends_with(".proposed"))
                    })
                })
        });
        let Some(at) = proposed.or(defining.first().copied()) else {
            return Self::error(format!("no file defines `{refused}`"));
        };
        let like = self.texts.files[at].0.clone();
        // What the schedule holds: its event schedules, and their time points.
        let referring = |class: &str, key: &str, to: &[String]| -> Vec<String> {
            let mut found: Vec<String> = self
                .dataset
                .by_type
                .get(class)
                .into_iter()
                .flatten()
                .filter(|id| {
                    self.dataset.entries[*id]
                        .get_ref(key)
                        .is_some_and(|t| to.iter().any(|x| x == cimview::mrid_of(t)))
                })
                .cloned()
                .collect();
            found.sort();
            found
        };
        let events = referring(
            "nc:EventSchedule",
            "EventSchedule.RemedialActionSchedule",
            &[refused.to_string()],
        );
        let points = referring("nc:EventTimePoint", "EventTimePoint.EventSchedule", &events);
        let mut draws = random.as_chunks::<16>().0.iter().copied();
        let mut exhausted = false;
        let mut next = || {
            draws.next().unwrap_or_else(|| {
                exhausted = true;
                [0; 16]
            })
        };

        // The new file: the proposal's prolog and root, and its header under a new identifier.
        let text = self.file_text(&like).unwrap_or_default().to_string();
        let (lines, index) = &self.texts.built.as_ref().expect("built")[at];
        let Some(root_end) = text
            .find("<rdf:RDF")
            .and_then(|s| text[s..].find('>').map(|e| s + e + 1))
        else {
            return Self::error(format!("{like} has no rdf:RDF root"));
        };
        let header = index
            .elements
            .iter()
            .find(|e| matches!(cimview::index::local(&e.qname), "Dataset" | "FullModel"));
        let id = ed::uuid(next());
        let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let header_text = header.map_or(String::new(), |h| {
            let (s, e) = (
                lines.offset(&text, h.full.start),
                lines.offset(&text, h.full.end),
            );
            let indent = text[..s].rsplit_once('\n').map_or("", |(_, i)| i);
            let old = h.mrid.trim_start_matches("urn:uuid:");
            format!("{indent}{}{eol}", text[s..e].replace(old, &id))
        });
        let new_text = format!("{}{eol}{header_text}</rdf:RDF>{eol}", &text[..root_end]);
        let stem = like.trim_end_matches(".xml");
        let mut name = format!("{stem}_counter-proposal.xml");
        let mut n = 2;
        while self.texts.files.iter().any(|(f, _)| *f == name) {
            name = format!("{stem}_counter-proposal_{n}.xml");
            n += 1;
        }
        let before: Vec<(String, String)> = self.texts.files.clone();
        let undo = |s: &mut Self| {
            s.texts.files = before.clone();
            s.texts.built = None;
        };
        self.texts.files.push((name.clone(), new_text));
        self.texts.built = None;
        self.build_texts();

        // The copies, their points not active.
        let ids: Vec<&str> = std::iter::once(refused)
            .chain(events.iter().map(String::as_str))
            .chain(points.iter().map(String::as_str))
            .collect();
        let copied = match ed::copy(
            &self.edit_files(),
            &ids,
            Some(&like),
            Some(&name),
            &mut next,
        ) {
            Ok(c) => (owned(c.edits), c.ids),
            Err(e) => {
                undo(self);
                return Self::error(e);
            }
        };
        let (edits, renamed) = copied;
        self.stage(edits);
        let new_of = |old: &str| {
            renamed
                .iter()
                .find(|(o, _)| o == old)
                .map(|(_, n)| n.clone())
                .unwrap_or_default()
        };
        let schedule = new_of(refused);
        for point in &points {
            match ed::set_field(
                &self.edit_files(),
                &name,
                &new_of(point),
                "EventTimePoint.isActive",
                "false",
            )
            .map(owned)
            {
                Ok(e) => self.stage(e),
                Err(e) => {
                    undo(self);
                    return Self::error(e);
                }
            }
        }
        // The response, and the dependency.
        let mut response = vec![
            ("RemedialActionScheduleResponse.kind", "refused"),
            (
                "RemedialActionScheduleResponse.rejectionReasonKind",
                "madeAlternative",
            ),
            (
                "RemedialActionScheduleResponse.RemedialActionSchedule",
                refused,
            ),
        ];
        if let Some(r) = responding.filter(|r| !r.is_empty()) {
            response.push(("RemedialActionScheduleResponse.RespondingEntity", r));
        }
        let dependency = [
            (
                "RemedialActionScheduleDependency.ProposedRemedialActionSchedule",
                schedule.as_str(),
            ),
            (
                "RemedialActionScheduleDependency.ReplacedRemedialActionSchedule",
                refused,
            ),
        ];
        for (class, values) in [
            ("RemedialActionScheduleResponse", &response[..]),
            ("RemedialActionScheduleDependency", &dependency[..]),
        ] {
            match ed::create(&self.edit_files(), &name, class, values, &mut next)
                .map(|a| owned(a.edits))
            {
                Ok(e) => self.stage(e),
                Err(e) => {
                    undo(self);
                    return Self::error(e);
                }
            }
        }
        if exhausted {
            undo(self);
            return Self::error("not enough random bytes for the identifiers");
        }
        self.files.push(super::FileOutcome::Loaded {
            name: name.clone(),
            objects: ids.len() + 2,
        });
        self.texts.history.push(vec![(name.clone(), None)]);
        self.reload();
        json!({ "error": null, "changed": [name], "revision": self.texts.revision, "id": schedule })
    }

    /// Rename mRID `old` to `new` in every file.
    pub fn edit_rename(&mut self, old: &str, new: &str) -> Value {
        self.build_texts();
        match ed::rename(&self.edit_files(), old, new).map(owned) {
            Ok(edits) => self.apply_edits(edits),
            Err(e) => Self::error(e),
        }
    }

    /// The objects deleting `id` takes: it, and with `contained`, what the containment puts in it.
    fn deleting(&mut self, id: &str, contained: bool) -> Vec<String> {
        let mut ids = vec![id.to_string()];
        if contained {
            ids.extend(
                self.views()
                    .tree
                    .descendants(id)
                    .into_iter()
                    .map(str::to_string),
            );
        }
        ids
    }

    /// What deleting `id` would change: the objects, the references to them, the files.
    pub fn edit_delete_preview(&mut self, id: &str, contained: bool) -> Value {
        let ids = self.deleting(id, contained);
        self.build_texts();
        let set: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let found = ed::delete(&self.edit_files(), &set);
        json!({
            "objects": found.objects, "references": found.references,
            "files": found.edits.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
            "contained": ids.len() - 1,
        })
    }

    /// Delete `id`, and with `contained` what it contains, with every reference to them.
    pub fn edit_delete(&mut self, id: &str, contained: bool) -> Value {
        let ids = self.deleting(id, contained);
        self.build_texts();
        let set: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let edits = owned(ed::delete(&self.edit_files(), &set).edits);
        self.apply_edits(edits)
    }

    /// The classes an object can be added in `parent` as, and the field naming it there.
    pub fn edit_addable(&mut self, parent: &str) -> Value {
        self.build_texts();
        let found = ed::addable(&self.edit_files(), parent);
        Value::Array(
            found
                .into_iter()
                .map(
                    |a| json!({ "class": a.class.local, "key": a.key, "comment": a.class.comment }),
                )
                .collect(),
        )
    }

    /// An object of `class` added in `parent`, named `name`; its UUID from `random`, drawn 16
    /// bytes at a time. Its mRID under `id`.
    pub fn edit_add(
        &mut self,
        parent: &str,
        class: &str,
        name: Option<&str>,
        random: &[u8],
    ) -> Value {
        self.views();
        self.build_texts();
        let mut draws = random.as_chunks::<16>().0.iter().copied();
        let mut exhausted = false;
        let mut next = || {
            draws.next().unwrap_or_else(|| {
                exhausted = true;
                [0; 16]
            })
        };
        let tree = &self.views.as_ref().expect("built").tree;
        let added = ed::add(&self.edit_files(), tree, parent, class, name, &mut next);
        if exhausted {
            return Self::error("not enough random bytes for an identifier");
        }
        match added {
            Ok(a) => {
                let id = a.id.clone();
                let mut out = self.apply_edits(owned(a.edits));
                out["id"] = json!(id);
                out
            }
            Err(e) => Self::error(e),
        }
    }

    /// Set field `key` of `id` to `value`, wherever it is written, else where its profile goes.
    pub fn edit_set(&mut self, id: &str, key: &str, value: &str) -> Value {
        self.build_texts();
        let prefer = self.defining_file(id).unwrap_or_default();
        match ed::set_field(&self.edit_files(), &prefer, id, key, value).map(owned) {
            Ok(edits) => self.apply_edits(edits),
            Err(e) => Self::error(e),
        }
    }

    /// Remove field `key` of `id`, wherever it is written.
    pub fn edit_remove(&mut self, id: &str, key: &str) -> Value {
        self.build_texts();
        let edits = owned(ed::remove_field(&self.edit_files(), id, key));
        self.apply_edits(edits)
    }

    /// The file defining `id` (`rdf:ID`), else the first describing it. Texts built.
    fn defining_file(&self, id: &str) -> Option<String> {
        let built = self.texts.built.as_ref()?;
        let at = |kind: Option<IdKind>| {
            built.iter().position(|(_, ix)| {
                ix.elements
                    .iter()
                    .any(|e| e.mrid == id && (kind.is_none() || e.id_kind == kind))
            })
        };
        let i = at(Some(IdKind::Id)).or_else(|| at(None))?;
        Some(self.texts.files[i].0.clone())
    }

    /// How each field of `id`'s class is edited: its kind, an enumeration's values, and whether the
    /// object writes it; the fields it could write but does not, among them.
    pub fn edit_form(&mut self, id: &str) -> Value {
        let Some(element) = self.dataset.entries.get(id) else {
            return Value::Null;
        };
        let reg = type_registry();
        let class = element.class();
        let mut fields: Vec<Value> = reg
            .attrs(class)
            .filter(|a| a.used)
            .map(|a| {
                let kind = match a.kind {
                    AttrKind::Literal => "literal",
                    AttrKind::Association => "reference",
                    AttrKind::Enum => "enumeration",
                };
                let values: Vec<&str> = match a.kind {
                    AttrKind::Enum => reg
                        .family_of(class.qualified)
                        .and_then(|f| reg.schema(f))
                        .and_then(|s| s.enumeration(a.range))
                        .map_or(Vec::new(), |e| e.values.iter().map(|v| v.id).collect()),
                    _ => Vec::new(),
                };
                json!({
                    "key": a.id, "kind": kind, "range": a.range, "xsd": a.xsd, "values": values,
                    "written": element.fields().contains_key(a.id), "comment": a.comment,
                })
            })
            .collect();
        fields.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
        json!({ "id": id, "class": class.local, "fields": fields, "revision": self.texts.revision })
    }

    /// The objects field `key` of `id` can name, the likeliest first.
    pub fn edit_candidates(&mut self, id: &str, key: &str) -> Value {
        self.views();
        self.build_texts();
        let indexes: Vec<&Index> = self
            .texts
            .built
            .as_ref()
            .expect("built")
            .iter()
            .map(|(_, i)| i)
            .collect();
        let tree = &self.views.as_ref().expect("built").tree;
        let found = ed::candidates(&indexes, tree, id, key, 50);
        Value::Array(
            found
                .into_iter()
                .map(
                    |c| json!({ "id": c.id, "label": c.label, "class": c.class, "place": c.place }),
                )
                .collect(),
        )
    }

    /// The fixes for `id`: a field a finding says is missing, added (a reference to one of the
    /// likeliest objects), and a reference to nothing or to what the set lacks, named anew. Each
    /// with its edits, for [`Session::edit_apply`] at this revision.
    pub fn edit_fixes(&mut self, id: &str) -> Value {
        self.views();
        self.build_texts();
        let missing: Vec<String> = self.validated.as_ref().map_or(Vec::new(), |v| {
            let mut keys: Vec<String> = v
                .findings
                .iter()
                .filter(|(_, f)| {
                    f.object_id == id && !f.property.is_empty() && !f.property.starts_with('^')
                })
                .map(|(_, f)| f.property.clone())
                .collect();
            keys.sort();
            keys.dedup();
            keys
        });
        let prefer = self.defining_file(id).unwrap_or_default();
        let files = self.edit_files();
        let indexes: Vec<&Index> = self
            .texts
            .built
            .as_ref()
            .expect("built")
            .iter()
            .map(|(_, i)| i)
            .collect();
        let tree = &self.views.as_ref().expect("built").tree;
        let mut out = Vec::new();
        let fix = |title: String, file: &str, edit: TextEdit| json!({ "title": title, "edits": [[file, [edit]]] });
        for key in &missing {
            let Some(add) = ed::add_missing(&files, &prefer, id, key) else {
                continue;
            };
            if add.reference {
                for c in ed::candidates(&indexes, tree, id, key, 5) {
                    let place = if c.place.is_empty() {
                        String::new()
                    } else {
                        format!(" in {}", c.place)
                    };
                    out.push(fix(
                        format!("Add {key}: {} {}{place}", c.class, c.label),
                        &add.file,
                        add.naming(&c),
                    ));
                }
            } else {
                let title = if add.edit.new_text.contains("></") {
                    format!("Add {key}, empty")
                } else {
                    format!("Add {key}")
                };
                out.push(fix(title, &add.file, add.edit));
            }
        }
        for f in ed::reference_fixes(&files, tree, id, None) {
            out.push(fix(f.title, &f.file, f.edit));
        }
        json!({ "revision": self.texts.revision, "fixes": out })
    }

    /// `edits` (as [`Session::edit_fixes`] gives them: `[[file, [edit, …]], …]`), if the files
    /// are still at `revision`.
    pub fn edit_apply(&mut self, revision: u64, edits: &Value) -> Value {
        if revision != self.texts.revision {
            return Self::error("the files have changed since: ask again");
        }
        let parsed: Option<Owned> = edits.as_array().and_then(|by| {
            by.iter()
                .map(|f| {
                    let name = f[0].as_str()?.to_string();
                    let e: Vec<TextEdit> = serde_json::from_value(f[1].clone()).ok()?;
                    Some((name, e))
                })
                .collect()
        });
        match parsed {
            Some(edits) => self.apply_edits(edits),
            None => Self::error("edits could not be read"),
        }
    }
}

/// The class of the time points that enable or disable on a schedule of class `schedule`: one
/// with a reference to it (or an ancestor, the nearest preferred), an `atTime` and an `enabled`.
/// Its class and those three fields.
pub(super) fn enabling_point(
    schedule: &'static cimmodel::base::ClassDef,
) -> Option<(
    &'static cimmodel::base::ClassDef,
    &'static str,
    &'static str,
    &'static str,
)> {
    let reg = type_registry();
    let chain: Vec<&str> = reg.chain(schedule).iter().map(|c| c.local).collect();
    let schema = reg.schema(reg.family_of(schedule.qualified)?)?;
    schema
        .classes
        .iter()
        .filter(|c| c.concrete)
        .filter_map(|class| {
            let attrs: Vec<_> = reg.attrs(class).collect();
            let (depth, to) = attrs
                .iter()
                .filter(|a| a.kind == AttrKind::Association && !a.is_list)
                .filter_map(|a| Some((chain.iter().position(|c| *c == a.range)?, a.id)))
                .max()?;
            let at = attrs.iter().find(|a| a.id.ends_with(".atTime"))?.id;
            let enabled = attrs
                .iter()
                .find(|a| a.id.ends_with(".enabled") && a.xsd == "boolean")?
                .id;
            Some((depth, class, to, at, enabled))
        })
        .max_by_key(|(depth, class, ..)| (*depth, std::cmp::Reverse(class.local)))
        .map(|(_, class, to, at, enabled)| (class, to, at, enabled))
}

impl Session {
    /// The texts as they were before edits staged since `before`, recorded as one edit to undo,
    /// and the model decoded again.
    fn commit_staged(&mut self, before: Vec<(String, String)>) -> Value {
        let changed: Vec<(String, Option<String>)> = before
            .into_iter()
            .filter(|(name, text)| self.file_text(name) != Some(text.as_str()))
            .map(|(name, text)| (name, Some(text)))
            .collect();
        if changed.is_empty() {
            return Self::error("nothing to change");
        }
        let names: Vec<String> = changed.iter().map(|(n, _)| n.clone()).collect();
        self.texts.history.push(changed);
        self.reload();
        json!({ "error": null, "changed": names, "revision": self.texts.revision })
    }

    /// What the use cases' guided edits offer for `id`: for a contingency (CO_UC1), its
    /// equipment; for a schedule with enabling time points (RA_UC3, AE_UC3), its points.
    pub fn edit_guided(&self, id: &str) -> Value {
        let Some(element) = self.dataset.entries.get(id) else {
            return Value::Null;
        };
        let reg = type_registry();
        let is = |name: &str| reg.chain(element.class()).iter().any(|c| c.local == name);
        let referring = |key: &str| -> Vec<&String> {
            let mut found: Vec<&String> = self
                .dataset
                .entries
                .iter()
                .filter(|(_, e)| e.get_ref(key).is_some_and(|t| cimview::mrid_of(t) == id))
                .map(|(k, _)| k)
                .collect();
            found.sort();
            found
        };
        if is("Contingency") {
            let elements: Vec<Value> = referring("ContingencyElement.Contingency")
                .into_iter()
                .filter_map(|e| {
                    let equipment = self.dataset.entries[e].get_ref("ContingencyEquipment.Equipment")?;
                    Some(json!({ "element": self.linked(e), "equipment": self.linked(cimview::mrid_of(equipment)) }))
                })
                .collect();
            return json!({ "kind": "contingency", "elements": elements });
        }
        if let Some((class, to, at, enabled)) = enabling_point(element.class()) {
            let mut points: Vec<(String, Value)> = referring(to)
                .into_iter()
                .filter(|p| self.dataset.entries[*p].class().local == class.local)
                .map(|p| {
                    let e = &self.dataset.entries[p];
                    let time = e.get_str(at).unwrap_or_default().to_string();
                    (time.clone(), json!({ "point": self.linked(p), "at": time, "enabled": e.get_str(enabled) }))
                })
                .collect();
            points.sort_by(|a, b| a.0.cmp(&b.0));
            return json!({
                "kind": "schedule", "pointClass": class.local,
                "points": points.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
            });
        }
        Value::Null
    }

    /// CO_UC1: `equipment` added to the contingency `contingency`, as a ContingencyEquipment
    /// shaped like its first (a copy, naming `equipment`, named as it is), else a new one taking
    /// it out of service, in the file defining the contingency. One edit.
    pub fn edit_contingency_add(
        &mut self,
        contingency: &str,
        equipment: &str,
        random: &[u8],
    ) -> Value {
        let reg = type_registry();
        let Some(element) = self.dataset.entries.get(contingency) else {
            return Self::error(format!("no object `{contingency}`"));
        };
        if !reg
            .chain(element.class())
            .iter()
            .any(|c| c.local == "Contingency")
        {
            return Self::error(format!("`{contingency}` is no contingency"));
        }
        let equipment = equipment.trim().trim_start_matches('#');
        let Some(target) = self.dataset.entries.get(equipment) else {
            return Self::error(format!("the model has no object `{equipment}`"));
        };
        if !target
            .types()
            .any(|t| reg.chain(t).iter().any(|c| c.local == "Equipment"))
        {
            return Self::error(format!("`{equipment}` is no equipment"));
        }
        let name = target.get_str("IdentifiedObject.name").map(str::to_string);
        let mut elements: Vec<&String> = self
            .dataset
            .by_type
            .get("nc:ContingencyEquipment")
            .into_iter()
            .flatten()
            .filter(|e| {
                self.dataset.entries[*e]
                    .get_ref("ContingencyElement.Contingency")
                    .is_some_and(|c| cimview::mrid_of(c) == contingency)
            })
            .collect();
        elements.sort();
        if elements.iter().any(|e| {
            self.dataset.entries[*e]
                .get_ref("ContingencyEquipment.Equipment")
                .is_some_and(|q| cimview::mrid_of(q) == equipment)
        }) {
            return Self::error("the contingency has that equipment already");
        }
        let first = elements.first().map(|e| e.to_string());
        let first_named = first.as_ref().is_some_and(|f| {
            self.dataset.entries[f]
                .get_str("IdentifiedObject.name")
                .is_some()
        });
        self.build_texts();
        let mut draws = random.as_chunks::<16>().0.iter().copied();
        let mut exhausted = false;
        let mut next = || {
            draws.next().unwrap_or_else(|| {
                exhausted = true;
                [0; 16]
            })
        };
        let before = self.texts.files.clone();
        let undo = |s: &mut Self| {
            s.texts.files = before.clone();
            s.texts.built = None;
        };
        let result: Result<String, String> = (|| match &first {
            Some(first) => {
                let from = self
                    .defining_file(first)
                    .ok_or("no file defines the first element")?;
                let copied = ed::copy(&self.edit_files(), &[first], Some(&from), None, &mut next)?;
                let id = copied.ids[0].1.clone();
                self.stage(owned(copied.edits));
                let mut fields = vec![("ContingencyEquipment.Equipment", equipment.to_string())];
                if let (true, Some(name)) = (first_named, &name) {
                    fields.push(("IdentifiedObject.name", name.clone()));
                }
                for (key, value) in fields {
                    let e = ed::set_field(&self.edit_files(), &from, &id, key, &value)?;
                    self.stage(owned(e));
                }
                Ok(id)
            }
            None => {
                let into = self
                    .defining_file(contingency)
                    .ok_or("no file defines the contingency")?;
                let values = [
                    ("ContingencyElement.Contingency", contingency),
                    ("ContingencyEquipment.Equipment", equipment),
                    ("ContingencyEquipment.contingentStatus", "outOfService"),
                ];
                let added = ed::create(
                    &self.edit_files(),
                    &into,
                    "ContingencyEquipment",
                    &values,
                    &mut next,
                )?;
                let id = added.id.clone();
                self.stage(owned(added.edits));
                Ok(id)
            }
        })();
        match result {
            Ok(_) if exhausted => {
                undo(self);
                Self::error("not enough random bytes for an identifier")
            }
            Ok(id) => {
                let mut out = self.commit_staged(before.clone());
                out["id"] = json!(id);
                out
            }
            Err(e) => {
                undo(self);
                Self::error(e)
            }
        }
    }

    /// RA_UC3, AE_UC3: the schedule `schedule` enabling, or not, from `at` (`2026-01-01T10:00:00Z`):
    /// its time point at that time set so, else a new one, in the file defining the schedule.
    pub fn edit_enabling(
        &mut self,
        schedule: &str,
        at: &str,
        enabled: bool,
        random: &[u8],
    ) -> Value {
        let Some(element) = self.dataset.entries.get(schedule) else {
            return Self::error(format!("no object `{schedule}`"));
        };
        let Some((class, to, at_key, enabled_key)) = enabling_point(element.class()) else {
            return Self::error(format!(
                "{} has no enabling time points",
                element.local_name()
            ));
        };
        let at = at.trim();
        if super::seconds(at).is_none() {
            return Self::error(format!(
                "`{at}` is no time: write it as 2026-01-01T10:00:00Z"
            ));
        }
        let value = if enabled { "true" } else { "false" };
        let same_time = |t: &str| t == at || super::seconds(t) == super::seconds(at);
        let existing = self
            .dataset
            .entries
            .iter()
            .filter(|(_, e)| e.class().local == class.local)
            .filter(|(_, e)| {
                e.get_ref(to)
                    .is_some_and(|s| cimview::mrid_of(s) == schedule)
            })
            .find(|(_, e)| e.get_str(at_key).is_some_and(same_time))
            .map(|(k, _)| k.clone());
        if let Some(point) = existing {
            let mut out = self.edit_set(&point, enabled_key, value);
            out["id"] = json!(point);
            return out;
        }
        self.build_texts();
        let Some(into) = self.defining_file(schedule) else {
            return Self::error(format!("no file defines `{schedule}`"));
        };
        let mut draws = random.as_chunks::<16>().0.iter().copied();
        let mut exhausted = false;
        let mut next = || {
            draws.next().unwrap_or_else(|| {
                exhausted = true;
                [0; 16]
            })
        };
        let values = [(to, schedule), (at_key, at), (enabled_key, value)];
        let added = ed::create(&self.edit_files(), &into, class.local, &values, &mut next);
        if exhausted {
            return Self::error("not enough random bytes for an identifier");
        }
        match added {
            Ok(a) => {
                let id = a.id.clone();
                let mut out = self.apply_edits(owned(a.edits));
                out["id"] = json!(id);
                out
            }
            Err(e) => Self::error(e),
        }
    }
}
