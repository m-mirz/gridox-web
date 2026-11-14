//! What applying a remedial action changes: for each of its alterations, the property of the
//! object it acts on, and the value it gives it. The value is the alteration's intensity schedule
//! at the model's scenario time where the files carry one ("the value provided by the schedule
//! replaces the value of the attribute"), else its range; either is absolute, incremental or an
//! incremental percentage (`ValueOffsetKind`).

use cimmodel::base::{AttrKind, FieldValue};
use cimmodel::registry::type_registry;
use cimview::mrid_of;
use serde_json::{Value, json};

use super::{Session, seconds};

/// One property an alteration changes.
#[derive(Clone, Debug)]
pub(super) struct Change {
    pub alteration: String,
    pub target: String,
    /// The target's class and the property, as an SSH writes them.
    pub class: &'static str,
    pub class_ns: &'static str,
    pub property: String,
    pub property_ns: &'static str,
    pub before: Option<String>,
    /// `None` where the value could not be worked out; `note` says why.
    pub after: Option<String>,
    /// `schedule` or `range`.
    pub source: &'static str,
    pub note: Option<String>,
}

impl Change {
    pub(super) fn to_json(&self, session: &Session) -> Value {
        json!({
            "alteration": session.linked(&self.alteration),
            "target": session.linked(&self.target),
            "property": self.property, "before": self.before, "after": self.after,
            "source": self.source, "note": self.note,
        })
    }
}

/// The text a property is written with: `true`/`false`, an integer, else a number.
fn written(xsd: &str, value: f64) -> String {
    match xsd {
        "boolean" => (value != 0.0).to_string(),
        "integer" | "int" | "long" | "short" => format!("{}", value.round() as i64),
        _ => {
            let text = format!("{value}");
            if text.contains('.') || text.contains('e') {
                text
            } else {
                format!("{text}.0")
            }
        }
    }
}

impl Session {
    /// The model's scenario time: its SV header's, else any header's.
    pub(super) fn scenario_time(&self) -> Option<i64> {
        let headers = self
            .dataset
            .by_type
            .get("FullModel")
            .into_iter()
            .flatten()
            .filter_map(|id| self.dataset.entries.get(id));
        let mut found: Vec<(bool, &str)> = headers
            .filter_map(|h| {
                let time = h.get_str("Model.scenarioTime")?;
                let state = match h.fields().get("Model.profile") {
                    Some(FieldValue::Text(p) | FieldValue::Resource(p)) => {
                        p.contains("StateVariables")
                    }
                    Some(FieldValue::TextList(ps) | FieldValue::ResourceList(ps)) => {
                        ps.iter().any(|p| p.contains("StateVariables"))
                    }
                    None => false,
                };
                Some((!state, time))
            })
            .collect();
        found.sort();
        found.first().and_then(|(_, t)| seconds(t))
    }

    /// The scenario time, and every time a point of an intensity schedule is at: the times
    /// schedules can be read at.
    pub fn schedule_times(&self) -> Value {
        let mut times: Vec<i64> = Vec::new();
        for schedule in self
            .dataset
            .by_type
            .get("nc:GridStateIntensitySchedule")
            .into_iter()
            .flatten()
        {
            for point in self.naming("GenericValueTimePoint.GenericValueSchedule", schedule) {
                if let Some(t) = self
                    .dataset
                    .entries
                    .get(point)
                    .and_then(|p| p.get_str("GenericValueTimePoint.atTime"))
                    .and_then(seconds)
                {
                    times.push(t);
                }
            }
        }
        times.sort_unstable();
        times.dedup();
        json!({
            "scenario": self.scenario_time().map(super::iso),
            "points": times.into_iter().map(super::iso).collect::<Vec<_>>(),
        })
    }

    /// The objects whose field `key` names `id`, in id order.
    fn naming(&self, key: &str, id: &str) -> Vec<&str> {
        let mut found: Vec<&str> = self
            .dataset
            .entries
            .iter()
            .filter(|(_, e)| e.get_ref(key).is_some_and(|t| mrid_of(t) == id))
            .map(|(k, _)| k.as_str())
            .collect();
        found.sort_unstable();
        found
    }

    /// The value an intensity schedule gives at time `t`, by its interpolation: a time point at
    /// `t`; `previous`, the last before; `next`, the first after.
    fn intensity_at(&self, schedule: &str, t: i64) -> Option<f64> {
        let element = self.dataset.entries.get(schedule)?;
        let kind = Self::text(element, "BaseTimeSeries.interpolationKind");
        let mut points: Vec<(i64, f64)> = self
            .naming("GenericValueTimePoint.GenericValueSchedule", schedule)
            .into_iter()
            .filter_map(|p| {
                let p = self.dataset.entries.get(p)?;
                Some((
                    seconds(p.get_str("GenericValueTimePoint.atTime")?)?,
                    p.get_f64("GenericValueTimePoint.value")?,
                ))
            })
            .collect();
        points.sort_by_key(|p| p.0);
        if let Some(p) = points.iter().find(|p| p.0 == t) {
            return Some(p.1);
        }
        match kind.as_deref() {
            Some("previous") => points.iter().rev().find(|p| p.0 < t).map(|p| p.1),
            Some("next") => points.iter().find(|p| p.0 > t).map(|p| p.1),
            _ => None,
        }
    }

    /// What applying the remedial action `action` changes, alteration by alteration.
    /// With `at`, schedules are read then rather than at the scenario time.
    pub(super) fn action_changes(&self, action: &str, at: Option<i64>) -> Vec<Change> {
        let reg = type_registry();
        let time = at.or_else(|| self.scenario_time());
        let mut out = Vec::new();
        for alteration_id in self.naming(
            "GridStateAlteration.GridStateAlterationRemedialAction",
            action,
        ) {
            let Some(alteration) = self.dataset.entries.get(alteration_id) else {
                continue;
            };
            // What it acts on: its one reference of its own class.
            let mut own: Vec<(&str, &str)> = alteration
                .fields()
                .iter()
                .filter(|(k, _)| {
                    !k.starts_with("GridStateAlteration.") && !k.starts_with("IdentifiedObject.")
                })
                .filter_map(|(&k, v)| match v {
                    FieldValue::Resource(v) => Some((k, mrid_of(v))),
                    _ => None,
                })
                .collect();
            own.sort_unstable();
            let Some(target_id) = own.first().map(|(_, t)| *t) else {
                continue;
            };
            let ranges: Vec<&cimmodel::Element> = self
                .naming("RangeConstraint.GridStateAlteration", alteration_id)
                .into_iter()
                .filter_map(|r| self.dataset.entries.get(r))
                .collect();
            let property =
                Self::text(alteration, "GridStateAlteration.PropertyReference").or_else(|| {
                    ranges
                        .iter()
                        .find_map(|r| Self::text(r, "StaticPropertyRange.PropertyReference"))
                });
            let Some(property) = property else { continue };
            let target = self.dataset.entries.get(target_id);
            let attr = target.and_then(|t| t.types().find_map(|c| reg.attr(c, &property)));
            let mut change = Change {
                alteration: alteration_id.to_string(),
                target: target_id.to_string(),
                class: target.map_or("", |t| t.local_name()),
                class_ns: target.map_or("", |t| t.class().ns),
                property: property.clone(),
                property_ns: attr.map_or("", |a| a.ns),
                before: target
                    .and_then(|t| t.get_str(&property))
                    .map(str::to_string),
                after: None,
                source: "range",
                note: None,
            };
            if target.is_none() {
                change.note = Some("the object it acts on is not in these files".into());
                out.push(change);
                continue;
            }
            let Some(attr) = attr.filter(|a| a.kind == AttrKind::Literal) else {
                change.note = Some(format!("{property} is no value of the object's class"));
                out.push(change);
                continue;
            };
            // The value: its schedules' at the scenario time, else its range's.
            let schedules = self.naming(
                "GridStateIntensitySchedule.GridStateAlteration",
                alteration_id,
            );
            let (value, kind) = if !schedules.is_empty() {
                change.source = "schedule";
                let Some(t) = time else {
                    change.note = Some(
                        "intensity schedules, but no scenario time in the files' headers".into(),
                    );
                    out.push(change);
                    continue;
                };
                let found: Vec<(f64, Option<String>)> = schedules
                    .iter()
                    .filter_map(|s| {
                        let v = self.intensity_at(s, t)?;
                        Some((
                            v,
                            self.dataset.entries.get(*s).and_then(|e| {
                                Self::text(e, "GridStateIntensitySchedule.valueKind")
                            }),
                        ))
                    })
                    .collect();
                match found.first() {
                    None => {
                        change.note = Some(
                            "no time point of its intensity schedules applies at the scenario time"
                                .into(),
                        );
                        out.push(change);
                        continue;
                    }
                    Some(first) if found.iter().any(|f| f != first) => {
                        change.note = Some(format!(
                            "{} intensity schedules give different values at the scenario time",
                            found.len()
                        ));
                        out.push(change);
                        continue;
                    }
                    Some((v, k)) => (*v, k.clone()),
                }
            } else {
                // The last range with a value.
                let found = ranges.iter().rev().find_map(|r| {
                    Some((
                        r.get_f64("RangeConstraint.normalValue")?,
                        Self::text(r, "RangeConstraint.valueKind"),
                    ))
                });
                match found {
                    Some(f) => f,
                    None => {
                        change.note = Some(
                            "neither a range nor an intensity schedule gives it a value".into(),
                        );
                        out.push(change);
                        continue;
                    }
                }
            };
            let before = change.before.as_deref().and_then(|b| match b {
                "true" => Some(1.0),
                "false" => Some(0.0),
                other => other.parse::<f64>().ok(),
            });
            let after = match (kind.as_deref().unwrap_or("absolute"), before) {
                ("absolute", _) => Some(value),
                ("incremental", Some(b)) => Some(b + value),
                ("incrementalPercentage", Some(b)) => Some(b * (1.0 + value / 100.0)),
                (k, None) => {
                    change.note = Some(format!(
                        "an {k} value, and the object writes no {property} to offset"
                    ));
                    None
                }
                (k, _) => {
                    change.note = Some(format!("a value of kind {k}, which this does not apply"));
                    None
                }
            };
            if after.is_some() && after == before {
                change.note = Some("the value the object already has: no change".into());
            }
            change.after = after.map(|a| written(attr.xsd, a));
            out.push(change);
        }
        out
    }

    /// The changes as an SSH of their own, to be merged after the files: those with a value. Its
    /// namespaces are bound on the root, as the files bind theirs.
    pub(super) fn changes_as_ssh(changes: &[Change]) -> String {
        let mut spaces: Vec<&str> = Vec::new();
        let mut prefix = |ns: &'static str| -> String {
            let at = spaces.iter().position(|n| *n == ns).unwrap_or_else(|| {
                spaces.push(ns);
                spaces.len() - 1
            });
            format!("n{at}")
        };
        let mut body = String::new();
        for c in changes {
            if let Some(after) = &c.after {
                let (cp, pp) = (prefix(c.class_ns), prefix(c.property_ns));
                body.push_str(&format!(
                    r##"<{cp}:{class} rdf:about="#{target}"><{pp}:{prop}>{after}</{pp}:{prop}></{cp}:{class}>"##,
                    class = c.class, target = c.target, prop = c.property,
                ));
            }
        }
        let bindings: String = spaces
            .iter()
            .enumerate()
            .map(|(i, ns)| format!(r#" xmlns:n{i}="{ns}""#))
            .collect();
        format!(
            r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"{bindings}>{body}</rdf:RDF>"#
        )
    }
}
