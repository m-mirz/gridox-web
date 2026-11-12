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
    history: Vec<Vec<(String, String)>>,
    /// Counts the changes, so that an edit offered for one state is not applied to another.
    revision: u64,
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
                before.push((name.clone(), text.clone()));
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

    /// A file's text as it is now.
    pub fn file_text(&self, name: &str) -> Option<&str> {
        self.texts
            .files
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, t)| t.as_str())
    }

    /// The last edit undone.
    pub fn edit_undo(&mut self) -> Value {
        let Some(before) = self.texts.history.pop() else {
            return Self::error("nothing to undo");
        };
        let mut changed = Vec::new();
        for (name, text) in before {
            if let Some((_, now)) = self.texts.files.iter_mut().find(|(n, _)| *n == name) {
                *now = text;
                changed.push(name);
            }
        }
        self.reload();
        json!({ "error": null, "changed": changed, "revision": self.texts.revision })
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
        let mut draws = random
            .chunks_exact(16)
            .map(|c| <[u8; 16]>::try_from(c).expect("16"));
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
