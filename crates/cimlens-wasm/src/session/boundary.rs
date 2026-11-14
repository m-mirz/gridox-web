//! The boundary points, and how the IGMs meet at each: BDS_UC1, as cimoxide's harness checks it
//! (`check_bds` in `scripts/relicapgrid/test_use_cases.py`). Each boundary point's node should be
//! reached by terminals of two IGMs at least, an IGM being who made the file defining a terminal;
//! all of them should lie on one topological node of the model's topology, and that node should
//! have a voltage in its state.

use std::collections::{BTreeSet, HashMap, HashSet};

use cimview::mrid_of;
use serde_json::{Value, json};

use super::{FileOutcome, Session};

impl Session {
    /// Each boundary point with the IGMs reaching it, the topological nodes its terminals lie on and
    /// whether they have a voltage, and what of that is amiss; those with something amiss first.
    /// `null` until validation has read the files one by one, as it says which file defines what.
    pub fn boundary_points(&self) -> Value {
        let Some(facts) = &self.facts else {
            return Value::Null;
        };
        let ds = &self.dataset;
        // The equipment files, by name, with who made each: an IGM.
        let maker_of: HashMap<&str, Option<&str>> = self
            .files
            .iter()
            .filter_map(|f| match f {
                FileOutcome::Loaded {
                    name,
                    maker,
                    equipment: true,
                    ..
                } => Some((name.as_str(), maker.as_deref())),
                _ => None,
            })
            .collect();
        // The IGM whose equipment file defines an object: who made it, else the file's name.
        let igm_of = |id: &str| -> Vec<String> {
            facts
                .defined_in
                .get(id)
                .into_iter()
                .flatten()
                .filter(|&&f| maker_of.contains_key(facts.files[f as usize].name.as_str()))
                .map(|&f| {
                    let name = facts.files[f as usize].name.as_str();
                    maker_of
                        .get(name)
                        .copied()
                        .flatten()
                        .map_or(name.to_string(), str::to_string)
                })
                .collect()
        };
        let mut terminals_at: HashMap<&str, Vec<&String>> = HashMap::new();
        for t in ds.by_type.get("Terminal").into_iter().flatten() {
            if let Some(node) = ds.entries[t].get_ref("Terminal.ConnectivityNode") {
                terminals_at.entry(mrid_of(node)).or_default().push(t);
            }
        }
        let voltages: HashSet<&str> = ds
            .by_type
            .get("SvVoltage")
            .into_iter()
            .flatten()
            .filter_map(|v| {
                ds.entries[v]
                    .get_ref("SvVoltage.TopologicalNode")
                    .map(mrid_of)
            })
            .collect();
        let points = ["BoundaryPoint", "nc:BoundaryPoint"]
            .iter()
            .flat_map(|class| ds.by_type.get(*class).into_iter().flatten());
        let mut rows: Vec<(bool, String, Value)> = points
            .map(|bp| {
                let e = &ds.entries[bp];
                let label = e.get_str("IdentifiedObject.name").unwrap_or(bp).to_string();
                let node = e
                    .get_ref("CommonResponsibilityPoint.ConnectivityNode")
                    .or_else(|| e.get_ref("BoundaryPoint.ConnectivityNode"))
                    .map(mrid_of);
                let terminals: Vec<&String> = node.and_then(|n| terminals_at.get(n)).cloned().unwrap_or_default();
                let igms: BTreeSet<String> = terminals.iter().flat_map(|t| igm_of(t)).collect();
                let on_none = terminals
                    .iter()
                    .filter(|t| ds.entries[t.as_str()].get_ref("Terminal.TopologicalNode").is_none())
                    .count();
                let mut placed: BTreeSet<&str> = terminals
                    .iter()
                    .filter_map(|t| ds.entries[t.as_str()].get_ref("Terminal.TopologicalNode").map(mrid_of))
                    .collect();
                if let Some(tn) = node.and_then(|n| ds.entries.get(n)).and_then(|n| n.get_ref("ConnectivityNode.TopologicalNode")) {
                    placed.insert(mrid_of(tn));
                }
                let mut amiss = Vec::new();
                if node.is_none_or(|n| !ds.entries.contains_key(n)) {
                    amiss.push("its node is not in the files loaded".to_string());
                }
                if igms.len() < 2 {
                    let from: Vec<&str> = igms.iter().map(String::as_str).collect();
                    amiss.push(if from.is_empty() { "reached from no IGM".to_string() } else { format!("reached from {} only", from.join(", ")) });
                }
                if placed.len() != 1 || on_none > 0 {
                    amiss.push(format!(
                        "{} topological node{}, {on_none} of {} terminals on none",
                        placed.len(),
                        if placed.len() == 1 { "" } else { "s" },
                        terminals.len()
                    ));
                }
                let unsolved: Vec<&str> = placed.iter().copied().filter(|tn| !voltages.contains(tn)).collect();
                if !placed.is_empty() && !unsolved.is_empty() {
                    amiss.push("no voltage in the state".to_string());
                }
                let fine = amiss.is_empty();
                let row = json!({
                    "point": self.linked(bp),
                    "node": node.map(|n| self.linked(n)),
                    "igms": igms,
                    "terminals": terminals.len(),
                    "onNone": on_none,
                    "topological": placed.iter().map(|tn| json!({ "node": self.linked(tn), "voltage": voltages.contains(tn) })).collect::<Vec<_>>(),
                    "amiss": amiss,
                });
                (fine, label, row)
            })
            .collect();
        rows.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
        Value::Array(rows.into_iter().map(|(_, _, row)| row).collect())
    }
}
