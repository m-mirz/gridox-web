//! The model set a worker holds: what the page has loaded, decoded and merged. It stays here, and
//! the page asks for what it draws, as a whole dataset would be too much to pass across.

use std::collections::BTreeMap;

use cimmodel::CimDataset;
use cimmodel::decode::is_cim;
use serde::Serialize;

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

#[derive(Default)]
pub struct Session {
    dataset: CimDataset,
    files: Vec<FileOutcome>,
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
    fn an_empty_session_has_nothing_to_show() {
        let summary = Session::new().summary();
        assert_eq!((summary.objects, summary.foreign), (0, 0));
        assert!(summary.classes.is_empty() && summary.files.is_empty());
    }
}
