//! A power flow of the loaded model, by gridoxide, as its security analysis solves a base case:
//! each component's outcome, each node's voltage beside the one the model's SV publishes, what
//! the options did, the currents past their limits, and where the grid shows each of them.

use std::collections::{BTreeMap, HashMap};

use cimmodel::base::FieldValue;
use cimview::mrid_of;
use gridoxide::cgmes::CgmesTopologyMode;
use gridoxide::security_analysis::{
    ImbalanceSharing, LimitKind, SecurityOptions, current_limits, monitor, solve,
};
use gridoxide::solver::IslandStatus;
use serde_json::{Value, json};

use super::Session;

/// What changes a power flow's answer, and so is shown beside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
    pub sharing: ImbalanceSharing,
    pub q_limits: bool,
    /// The buses from the switches as the SSH sets them, rather than from the TP.
    pub switches: bool,
    /// When intensity schedules are read, in seconds since 1970; the scenario time if `None`.
    pub at: Option<i64>,
    /// In a security analysis, each contingency solved again with its curative actions.
    pub curative: bool,
}

impl Default for Options {
    /// As gridoxide's PF_UC1 solves ReliCapGrid: the reference takes the imbalance, reactive
    /// limits held.
    fn default() -> Self {
        Self {
            sharing: ImbalanceSharing::Reference,
            q_limits: true,
            switches: false,
            at: None,
            curative: false,
        }
    }
}

fn status(status: IslandStatus) -> &'static str {
    match status {
        IslandStatus::Converged => "converged",
        IslandStatus::MaxIterationsReached => "maxIterations",
        IslandStatus::Singular => "singular",
        IslandStatus::NoReferenceBus => "noReference",
        IslandStatus::AmbiguousReferenceBus => "ambiguousReference",
    }
}

/// Rounded for display without losing what a comparison needs.
fn round(x: f64, digits: i32) -> f64 {
    let k = 10f64.powi(digits);
    // Adding zero turns -0.0, which JSON would carry, into 0.0.
    (x * k).round() / k + 0.0
}

impl Session {
    /// The objects referring to each object through `key`: target → sources, in id order.
    fn sources_by(&self, key: &str) -> HashMap<&str, Vec<&str>> {
        let mut by: HashMap<&str, Vec<&str>> = HashMap::new();
        for (id, element) in &self.dataset.entries {
            if let Some(FieldValue::Resource(target)) = element.fields().get(key) {
                by.entry(mrid_of(target)).or_default().push(id.as_str());
            }
        }
        for list in by.values_mut() {
            list.sort_unstable();
        }
        by
    }

    /// Solves the model with `options`. An error, such as a model without the topology a power
    /// flow needs, is an answer too, under `error`.
    pub fn power_flow(&mut self, options: Options) -> Value {
        let given = json!({ "sharing": options.sharing.name(), "qLimits": options.q_limits, "switches": options.switches });
        let security = SecurityOptions {
            sharing: options.sharing,
            enforce_q_limits: options.q_limits,
            topology: if options.switches {
                CgmesTopologyMode::NodeBreakerFromEq
            } else {
                CgmesTopologyMode::BusBranchFromTp
            },
            ..Default::default()
        };
        let state = match solve(&self.dataset, &security) {
            Ok(state) => state,
            Err(error) => return json!({ "options": given, "error": error }),
        };
        self.views();
        let views = self.views.as_ref().expect("just built");
        let dataset = &self.dataset;
        let s_base_mw = security.s_base_va / 1e6;

        // Each bus's nodes, in id order, and each node's component.
        let mut nodes_of: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
        for (node, &bus) in &state.bus_of {
            nodes_of.entry(bus).or_default().push(node.as_str());
        }
        for list in nodes_of.values_mut() {
            list.sort_unstable();
        }
        let mut component_of: HashMap<usize, usize> = HashMap::new();
        for (c, island) in state.islands.iter().enumerate() {
            for &bus in &island.bus_indices {
                component_of.insert(bus, c);
            }
        }
        let solved = |bus: usize| {
            component_of
                .get(&bus)
                .is_some_and(|c| state.islands[*c].status == IslandStatus::Converged)
        };

        // The SV's voltage of each node.
        let mut published: HashMap<&str, (f64, f64)> = HashMap::new();
        for id in dataset.by_type.get("SvVoltage").into_iter().flatten() {
            let Some(sv) = dataset.entries.get(id) else {
                continue;
            };
            if let (Some(node), Some(v), Some(angle)) = (
                sv.get_ref("SvVoltage.TopologicalNode"),
                sv.get_f64("SvVoltage.v"),
                sv.get_f64("SvVoltage.angle"),
            ) {
                published.insert(mrid_of(node), (v, angle));
            }
        }

        // Where the grid shows each node: its substation, else a boundary point; through one of
        // its connectivity nodes where the grid does not know it.
        let connectivity = self.sources_by("ConnectivityNode.TopologicalNode");
        let place = |node: &str| -> Option<String> {
            let at = |id: &str| {
                let found = views.grid.reveal(id)?;
                let enter = found.get("enter").and_then(Value::as_str);
                let select = found.get("select").and_then(Value::as_str);
                enter.or(select).map(str::to_string)
            };
            at(node).or_else(|| connectivity.get(node)?.iter().find_map(|cn| at(cn)))
        };

        // Each node's voltage; per component, the angle the SV's differs by at its reference.
        let kv_of = |bus: usize| state.buses[bus].u_rated / 1e3;
        let mut offsets: HashMap<usize, f64> = HashMap::new();
        for (c, island) in state.islands.iter().enumerate() {
            let buses = island.slack_indices.iter().chain(&island.bus_indices);
            let found = buses.filter(|b| solved(**b)).find_map(|&b| {
                let node = nodes_of
                    .get(&b)?
                    .iter()
                    .find(|n| published.contains_key(*n))?;
                Some(state.buses[b].voltage_ang.to_degrees() - published[node].1)
            });
            if let Some(offset) = found {
                offsets.insert(c, offset);
            }
        }
        let mut voltages = serde_json::Map::new();
        let mut rows = Vec::new();
        let mut on_grid: BTreeMap<String, (f64, f64)> = BTreeMap::new();
        let mut differ: HashMap<usize, (f64, f64, usize)> = HashMap::new();
        for (&bus, nodes) in &nodes_of {
            let b = &state.buses[bus];
            let c = component_of.get(&bus).copied();
            let alive = solved(bus);
            let kv = kv_of(bus);
            for node in nodes {
                let element = dataset.entries.get(*node);
                let sv = published.get(node).copied();
                let mut row = json!({
                    "id": node,
                    "label": element.and_then(|e| e.get_str("IdentifiedObject.name")),
                    "component": c, "nominalKV": round(kv, 3),
                    "pu": alive.then(|| round(b.voltage_mag, 5)),
                    "kV": alive.then(|| round(b.voltage_mag * kv, 3)),
                    "deg": alive.then(|| round(b.voltage_ang.to_degrees(), 4)),
                    "sv": sv.map(|(v, a)| json!({ "kV": v, "deg": a })),
                    "at": place(node),
                });
                if alive {
                    voltages.insert(
                        node.to_string(),
                        json!({ "pu": row["pu"], "kV": row["kV"], "deg": row["deg"] }),
                    );
                    if let Some(at) = row["at"].as_str() {
                        let range = on_grid
                            .entry(at.to_string())
                            .or_insert((f64::INFINITY, f64::NEG_INFINITY));
                        *range = (range.0.min(b.voltage_mag), range.1.max(b.voltage_mag));
                    }
                    if let (Some((v, a)), Some(c)) = (sv, c)
                        && v > 0.0
                        && kv > 0.0
                    {
                        let dv = 100.0 * (b.voltage_mag * kv - v) / v;
                        let da = offsets
                            .get(&c)
                            .map_or(0.0, |o| b.voltage_ang.to_degrees() - a - o);
                        row["dvPercent"] = json!(round(dv, 3));
                        row["dDeg"] = json!(round(da, 3));
                        let worst = differ.entry(c).or_insert((0.0, 0.0, 0));
                        *worst = (worst.0.max(dv.abs()), worst.1.max(da.abs()), worst.2 + 1);
                    }
                }
                rows.push(row);
            }
        }
        // A connectivity node's voltage is its topological node's.
        for (node, cns) in &connectivity {
            if let Some(v) = voltages.get(*node).cloned() {
                for cn in cns {
                    voltages.insert(cn.to_string(), v.clone());
                }
            }
        }
        rows.sort_by(|a, b| {
            let key = |r: &Value| {
                (
                    r["label"].as_str().unwrap_or("").to_string(),
                    r["id"].as_str().unwrap_or("").to_string(),
                )
            };
            key(a).cmp(&key(b))
        });

        let nodes_cell = |bus: usize| -> Vec<Value> {
            nodes_of.get(&bus).map_or(Vec::new(), |nodes| {
                nodes.iter().map(|n| self.linked(n)).collect()
            })
        };
        let components: Vec<Value> = state
            .islands
            .iter()
            .enumerate()
            .map(|(c, island)| {
                let nodes: usize = island.bus_indices.iter().map(|b| nodes_of.get(b).map_or(0, Vec::len)).sum();
                json!({
                    "status": status(island.status),
                    "nodes": nodes,
                    "references": island.slack_indices.iter().flat_map(|b| nodes_cell(*b)).collect::<Vec<_>>(),
                    "maxMismatch": island.max_mismatch,
                    "sv": differ.get(&c).map(|(dv, da, n)| json!({
                        "dvPercent": round(*dv, 3), "dDeg": round(*da, 3), "nodes": n,
                    })),
                })
            })
            .collect();

        // Flows by equipment, with each terminal's loading against its lowest PATL.
        let limits = current_limits(dataset);
        let mut flows: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let mut terminals: Vec<&String> = state.flows.keys().collect();
        terminals.sort_unstable();
        for terminal in terminals {
            let flow = &state.flows[terminal];
            let Some(equipment) = dataset
                .entries
                .get(terminal.as_str())
                .and_then(|t| t.get_ref("Terminal.ConductingEquipment"))
            else {
                continue;
            };
            let patl = limits.get(terminal.as_str()).and_then(|l| {
                l.iter()
                    .filter(|l| l.kind == LimitKind::Patl)
                    .map(|l| l.amps)
                    .reduce(f64::min)
            });
            flows
                .entry(mrid_of(equipment).to_string())
                .or_default()
                .push(json!({
                    "terminal": terminal, "p": round(flow.p_mw, 3), "q": round(flow.q_mvar, 3),
                    "amps": round(flow.amps, 2),
                    "loading": patl.map(|l| round(100.0 * flow.amps / l, 2)),
                }));
        }
        let flows: serde_json::Map<String, Value> = flows
            .into_iter()
            .map(|(equipment, ends)| {
                let loading = ends
                    .iter()
                    .filter_map(|e| e["loading"].as_f64())
                    .reduce(f64::max);
                (equipment, json!({ "ends": ends, "loading": loading }))
            })
            .collect();

        let mut violations: Vec<Value> = monitor(&state.flows, &limits, None)
            .into_iter()
            .map(|v| {
                let equipment = dataset
                    .entries
                    .get(v.terminal.as_str())
                    .and_then(|t| t.get_ref("Terminal.ConductingEquipment"))
                    .map(|e| self.linked(mrid_of(e)));
                json!({
                    "terminal": v.terminal, "equipment": equipment,
                    "limit": self.linked(&v.limit.mrid),
                    "kind": match v.limit.kind { LimitKind::Patl => "PATL", LimitKind::Tatl => "TATL", LimitKind::Other => "other" },
                    "amps": round(v.flow.amps, 2), "limitAmps": v.limit.amps, "percent": round(v.percent(), 2),
                })
            })
            .collect();
        violations.sort_by(|a, b| {
            b["percent"]
                .as_f64()
                .partial_cmp(&a["percent"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let shared: f64 = state.shift_mw.iter().sum();
        json!({
            "options": given,
            "error": null,
            "components": components,
            "nodes": rows,
            "switched": state.q_limit_switches.iter().flat_map(|b| nodes_cell(*b)).collect::<Vec<_>>(),
            "sharedMW": (!state.shift_mw.is_empty()).then(|| round(shared, 3)),
            "pastLimits": state.past_limits.iter().map(|p| {
                let mut cell = self.linked(&p.machine);
                cell["mw"] = json!(round(p.mw, 3));
                cell["limit"] = json!(p.limit);
                cell
            }).collect::<Vec<_>>(),
            "violations": violations,
            "overlay": {
                "nodes": on_grid.into_iter().map(|(at, (lo, hi))| (at, json!({ "min": round(lo, 4), "max": round(hi, 4) }))).collect::<serde_json::Map<_, _>>(),
                "voltages": voltages,
                "flows": flows,
            },
            "sBaseMW": s_base_mw,
        })
    }

    /// The power flow with the remedial action `action` applied, from the switches: the loaded
    /// files decoded again with the switch states the action sets, as a later SSH would set them,
    /// beside the same power flow without it. The files are not changed.
    pub fn power_flow_applied(&mut self, options: Options, action: &str) -> Value {
        let options = Options {
            switches: true,
            ..options
        };
        if !self.dataset.entries.contains_key(action) {
            return json!({ "error": format!("`{action}` is no remedial action of these files") });
        }
        let edits = self.action_changes(action, options.at);
        if !edits.iter().any(|c| c.after.is_some()) {
            let why: Vec<String> = edits.iter().filter_map(|c| c.note.clone()).collect();
            return json!({ "error": if why.is_empty() { "the action changes nothing: it has no alteration with a value".to_string() } else { format!("the action changes nothing: {}", why.join("; ")) } });
        }
        let before = self.power_flow(options);
        let ssh = Self::changes_as_ssh(&edits);
        let mut applied = cimmodel::CimDataset::default();
        for (_, text) in &self.texts.files {
            if let Ok(found) = cimmodel::CimDataset::decode_str(text) {
                applied.merge(found);
            }
        }
        match cimmodel::CimDataset::decode_str(&ssh) {
            Ok(found) => applied.merge(found),
            Err(e) => return json!({ "error": e.to_string() }),
        }
        // The grid stays the one drawn: views are built on the files as loaded.
        self.views();
        let loaded = std::mem::replace(&mut self.dataset, applied);
        let mut after = self.power_flow(options);
        self.dataset = loaded;
        if !after["error"].is_null() {
            return after;
        }
        // What applying it changed: each node's voltage, and the currents past their limits.
        let pu = |flow: &Value| -> HashMap<String, f64> {
            flow["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|n| Some((n["id"].as_str()?.to_string(), n["pu"].as_f64()?)))
                .collect()
        };
        let (was, now) = (pu(&before), pu(&after));
        let mut changes: Vec<(f64, String)> = now
            .iter()
            .filter_map(|(id, v)| Some(((v - was.get(id)?).abs(), id.clone())))
            .filter(|(d, _)| *d > 1e-6)
            .collect();
        changes.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let count = |flow: &Value, status: &str| {
            flow["components"].as_array().map_or(0, |c| {
                c.iter()
                    .filter(|c| c["status"] == status)
                    .map(|c| c["nodes"].as_u64().unwrap_or(0))
                    .sum::<u64>()
            })
        };
        after["action"] = self.linked(action);
        after["actionSwitches"] = Value::Array(
            edits
                .iter()
                .filter(|c| c.property == "Switch.open" && c.after.is_some())
                .map(|c| {
                    let mut cell = self.linked(&c.target);
                    cell["open"] = json!(c.before);
                    cell["openAfter"] = json!(c.after.as_deref() == Some("true"));
                    cell
                })
                .collect(),
        );
        after["actionChanges"] = Value::Array(edits.iter().map(|c| c.to_json(self)).collect());
        after["compared"] = json!({
            "violationsBefore": before["violations"].as_array().map_or(0, Vec::len),
            "violationsAfter": after["violations"].as_array().map_or(0, Vec::len),
            "solvedBefore": count(&before, "converged"),
            "solvedAfter": count(&after, "converged"),
            "largestChange": changes.first().map(|c| round(c.0, 5)),
            "changed": changes.len(),
            "most": changes.iter().take(10).map(|(d, id)| {
                let mut cell = self.linked(id);
                cell["change"] = json!(round(*d, 5));
                cell
            }).collect::<Vec<_>>(),
        });
        after
    }
}
