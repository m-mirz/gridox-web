//! A security analysis of the loaded model, by gridoxide: its base case and each contingency of
//! the loaded CO data solved, currents held against their limits, and a SAR of what is found.
//!
//! The page runs it a batch of contingencies at a time, for its progress and so the worker can
//! answer in between. Each batch is gridoxide's `run` on the contingencies of that batch, and the
//! batches merge into what one `run` on them all gives (see [`merge`]).

use std::collections::{BTreeMap, HashMap};

use cimmodel::CimDataset;
use cimmodel::base::FieldValue;
use cimview::mrid_of;
use gridoxide::security_analysis::{
    Contingency, LimitKind, SarHeader, SecurityAnalysis, SecurityOptions, Violation,
    read_contingencies, run,
};
use serde_json::{Value, json};

use super::Session;
use super::power_flow::Options;

/// An analysis under way or done.
pub(super) struct Analysis {
    options: Options,
    contingencies: Vec<Contingency>,
    /// The objects defining each contingency, by its mRID: itself and its elements.
    defining: HashMap<String, Vec<String>>,
    /// The CO datasets' headers, which a SAR requires.
    headers: Vec<String>,
    next: usize,
    done: Option<SecurityAnalysis>,
}

/// `more`, the analysis of the contingencies after those of `into`, merged in: the base case is
/// the same in each, so it is kept once.
fn merge(into: &mut SecurityAnalysis, more: SecurityAnalysis) {
    into.violations.extend(
        more.violations
            .into_iter()
            .filter(|v| v.contingency.is_some()),
    );
    into.violations.sort_by(|a, b| {
        (a.contingency.as_deref(), &a.terminal, &a.limit.mrid).cmp(&(
            b.contingency.as_deref(),
            &b.terminal,
            &b.limit.mrid,
        ))
    });
    into.solved += more.solved;
    into.stalled.extend(more.stalled);
    into.stalled.sort();
    into.absent.extend(more.absent);
    into.past_limits.extend(
        more.past_limits
            .into_iter()
            .filter(|p| p.contingency.is_some()),
    );
}

/// At one terminal: the contingencies taking it past a limit, the worst of them and by how much,
/// and the base case's worst.
type AtTerminal<'a> = (usize, f64, Option<&'a str>, Option<f64>);

fn round(x: f64, digits: i32) -> f64 {
    let k = 10f64.powi(digits);
    (x * k).round() / k + 0.0
}

fn kind(kind: LimitKind) -> &'static str {
    match kind {
        LimitKind::Patl => "PATL",
        LimitKind::Tatl => "TATL",
        LimitKind::Other => "other",
    }
}

impl Session {
    /// The headers of the CO files loaded: the `Dataset`s conforming to the Contingency profile.
    fn contingency_headers(&self) -> Vec<String> {
        let mut found: Vec<String> = self
            .dataset
            .by_type
            .get("nc:Dataset")
            .into_iter()
            .flatten()
            .filter(|id| {
                self.dataset.entries.get(*id).is_some_and(|e| {
                    let profiles: Vec<&str> = match e.fields().get("conformsTo") {
                        Some(FieldValue::Text(v) | FieldValue::Resource(v)) => vec![v.as_str()],
                        Some(FieldValue::TextList(vs) | FieldValue::ResourceList(vs)) => {
                            vs.iter().map(String::as_str).collect()
                        }
                        None => Vec::new(),
                    };
                    profiles.iter().any(|p| p.contains("/Contingency/"))
                })
            })
            .cloned()
            .collect();
        found.sort();
        found
    }

    /// Readies an analysis of every contingency loaded. Its `total`, or why there is none.
    pub fn analysis_start(&mut self, options: Options) -> Value {
        self.analysis = None;
        let contingencies = match read_contingencies(&self.dataset) {
            Ok(found) => found,
            Err(error) => return json!({ "error": error, "total": 0 }),
        };
        if contingencies.is_empty() {
            return json!({ "error": "no contingencies are loaded: load a CO file", "total": 0 });
        }
        let mut defining: HashMap<String, Vec<String>> = contingencies
            .iter()
            .map(|c| (c.mrid.clone(), vec![c.mrid.clone()]))
            .collect();
        for id in self
            .dataset
            .by_type
            .get("nc:ContingencyEquipment")
            .into_iter()
            .flatten()
        {
            let of = self.dataset.entries[id].get_ref("ContingencyElement.Contingency");
            if let Some(list) = of.and_then(|c| defining.get_mut(mrid_of(c))) {
                list.push(id.clone());
            }
        }
        let total = contingencies.len();
        self.analysis = Some(Analysis {
            options,
            contingencies,
            defining,
            headers: self.contingency_headers(),
            next: 0,
            done: None,
        });
        json!({ "error": null, "total": total })
    }

    /// Analyses the next `count` contingencies. How many are done, of how many; an error if the
    /// base case does not converge, which ends the analysis.
    pub fn analysis_step(&mut self, count: usize) -> Value {
        let Some(analysis) = self.analysis.as_mut() else {
            return json!({ "error": "no analysis was started" });
        };
        let end = (analysis.next + count.max(1)).min(analysis.contingencies.len());
        // This batch's contingencies, as a CO dataset of their own.
        let mut batch = CimDataset::default();
        let ids = analysis.contingencies[analysis.next..end]
            .iter()
            .flat_map(|c| analysis.defining[&c.mrid].iter())
            .chain(&analysis.headers);
        for id in ids {
            if let Some(element) = self.dataset.entries.get(id) {
                batch
                    .by_type
                    .entry(element.type_name().to_string())
                    .or_default()
                    .push(id.clone());
                batch.entries.insert(id.clone(), element.clone());
            }
        }
        let security = SecurityOptions {
            sharing: analysis.options.sharing,
            enforce_q_limits: analysis.options.q_limits,
            ..Default::default()
        };
        match run(&mut self.dataset, &batch, &security) {
            Ok(found) => match analysis.done.as_mut() {
                Some(done) => merge(done, found),
                None => analysis.done = Some(found),
            },
            Err(error) => {
                let total = analysis.contingencies.len();
                self.analysis = None;
                return json!({ "error": error, "done": 0, "total": total });
            }
        }
        analysis.next = end;
        json!({ "error": null, "done": end, "total": analysis.contingencies.len() })
    }

    fn finished(&self) -> Option<(&Analysis, &SecurityAnalysis)> {
        let analysis = self.analysis.as_ref()?;
        let done = analysis.done.as_ref()?;
        (analysis.next == analysis.contingencies.len()).then_some((analysis, done))
    }

    /// The equipment of a terminal, linked.
    fn equipment_of(&self, terminal: &str) -> Option<(&str, Value)> {
        let equipment = self
            .dataset
            .entries
            .get(terminal)?
            .get_ref("Terminal.ConductingEquipment")
            .map(mrid_of)?;
        Some((equipment, self.linked(equipment)))
    }

    fn violation(&self, v: &Violation) -> Value {
        json!({
            "contingency": v.contingency.as_deref().map(|c| self.linked(c)),
            "terminal": v.terminal,
            "equipment": self.equipment_of(&v.terminal).map(|(_, e)| e),
            "limit": self.linked(&v.limit.mrid), "kind": kind(v.limit.kind),
            "amps": round(v.flow.amps, 1), "limitAmps": v.limit.amps, "percent": round(v.percent(), 2),
        })
    }

    /// The finished analysis: what it solved and did not, and its violations by contingency and by
    /// element. `null` until every contingency is done.
    pub fn analysis_result(&mut self) -> Value {
        let Some((analysis, done)) = self.finished() else {
            return Value::Null;
        };
        // By contingency.
        let mut by_contingency: HashMap<&str, (usize, f64)> = HashMap::new();
        // By terminal: contingencies violating, the worst and where, the base case's worst.
        let mut by_terminal: BTreeMap<&str, AtTerminal> = BTreeMap::new();
        for v in &done.violations {
            let entry = by_terminal
                .entry(&v.terminal)
                .or_insert((0, 0.0, None, None));
            match v.contingency.as_deref() {
                None => entry.3 = Some(entry.3.map_or(v.percent(), |b: f64| b.max(v.percent()))),
                Some(c) => {
                    let found = by_contingency.entry(c).or_insert((0, 0.0));
                    found.0 += 1;
                    found.1 = found.1.max(v.percent());
                    entry.0 += 1;
                    if v.percent() > entry.1 {
                        (entry.1, entry.2) = (v.percent(), Some(c));
                    }
                }
            }
        }
        let stalled: Vec<&str> = done.stalled.iter().map(String::as_str).collect();
        let absent: Vec<&str> = done.absent.iter().map(String::as_str).collect();
        let mut contingencies: Vec<(f64, Value, Vec<String>)> = analysis
            .contingencies
            .iter()
            .map(|c| {
                let outcome = if stalled.contains(&c.mrid.as_str()) {
                    "stalled"
                } else if absent.contains(&c.mrid.as_str()) {
                    "absent"
                } else {
                    "solved"
                };
                let (count, worst) = by_contingency
                    .get(c.mrid.as_str())
                    .copied()
                    .unwrap_or((0, 0.0));
                let mut cell = self.linked(&c.mrid);
                cell["equipment"] = json!(
                    c.equipment
                        .iter()
                        .map(|e| self.linked(e))
                        .collect::<Vec<_>>()
                );
                cell["outcome"] = json!(outcome);
                cell["violations"] = json!(count);
                cell["worst"] = json!((count > 0).then(|| round(worst, 2)));
                (worst, cell, c.equipment.clone())
            })
            .collect();
        contingencies.sort_by(|a, b| {
            let rank = |v: &Value| match v["outcome"].as_str() {
                Some("stalled") => 0,
                Some("solved") => 1,
                _ => 2,
            };
            (rank(&a.1), b.0, a.1["id"].as_str())
                .partial_cmp(&(rank(&b.1), a.0, b.1["id"].as_str()))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut elements: Vec<(f64, Value, Option<String>)> = by_terminal
            .into_iter()
            .map(|(terminal, (count, worst, at, base))| {
                let equipment = self.equipment_of(terminal);
                (
                    worst.max(base.unwrap_or(0.0)),
                    json!({
                        "terminal": terminal,
                        "equipment": equipment.as_ref().map(|(_, e)| e.clone()),
                        "contingencies": count,
                        "worst": (count > 0).then(|| round(worst, 2)),
                        "worstContingency": at.map(|c| self.linked(c)),
                        "base": base.map(|b| round(b, 2)),
                    }),
                    equipment.map(|(e, _)| e.to_string()),
                )
            })
            .collect();
        elements.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let base = done
            .violations
            .iter()
            .filter(|v| v.contingency.is_none())
            .count();
        let summary = json!({
            "options": { "sharing": analysis.options.sharing.name(), "qLimits": analysis.options.q_limits },
            "scenarioTime": done.scenario_time,
            "total": analysis.contingencies.len(),
            "solved": done.solved,
            "stalled": done.stalled.iter().map(|c| self.linked(c)).collect::<Vec<_>>(),
            "absent": done.absent.iter().map(|c| self.linked(c)).collect::<Vec<_>>(),
            "baseViolations": base,
            "violations": done.violations.len() - base,
            "pastLimits": done.past_limits.iter().map(|p| json!({
                "contingency": p.contingency.as_deref().map(|c| self.linked(c)),
                "machine": self.linked(&p.machine), "mw": round(p.mw, 2), "limit": p.limit,
            })).collect::<Vec<_>>(),
            "requires": done.requires,
        });
        let mut summary = summary;
        summary["contingencies"] = Value::Array(
            contingencies
                .into_iter()
                .map(|(_, mut cell, equipment)| {
                    let ids: Vec<&str> = equipment.iter().map(String::as_str).collect();
                    cell["grid"] = json!(self.on_grid(&ids));
                    cell
                })
                .collect(),
        );
        summary["elements"] = Value::Array(
            elements
                .into_iter()
                .map(|(_, mut cell, equipment)| {
                    let ids: Vec<&str> = equipment.iter().map(String::as_str).collect();
                    cell["grid"] = json!(self.on_grid(&ids));
                    cell
                })
                .collect(),
        );
        summary
    }

    /// The violations after `contingency` (the base case's with `None`), or at `terminal`.
    pub fn analysis_violations(&self, contingency: Option<&str>, terminal: Option<&str>) -> Value {
        let Some((_, done)) = self.finished() else {
            return json!([]);
        };
        let found = done.violations.iter().filter(|v| match terminal {
            Some(t) => v.terminal == t,
            None => v.contingency.as_deref() == contingency,
        });
        let mut rows: Vec<&Violation> = found.collect();
        rows.sort_by(|a, b| {
            b.percent()
                .partial_cmp(&a.percent())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Value::Array(rows.into_iter().map(|v| self.violation(v)).collect())
    }

    /// What a SAR's header could say, from the loaded CO files: their publisher and rights holder.
    pub fn sar_defaults(&self) -> Value {
        let Some((analysis, done)) = self.finished() else {
            return Value::Null;
        };
        let field = |key: &str| {
            analysis.headers.iter().find_map(|h| {
                let e = self.dataset.entries.get(h)?;
                e.get_str(key)
                    .or_else(|| e.get_ref(key))
                    .map(str::to_string)
            })
        };
        let day = done
            .scenario_time
            .get(..10)
            .unwrap_or_default()
            .replace('-', "");
        json!({
            "title": format!("{day}_SAR"),
            "description": format!(
                "Security analysis by gridoxide in gridox, the imbalance taken by {}, reactive limits {}.",
                match analysis.options.sharing.name() { "capability" => "the machines by capability", "equal" => "every generator alike", _ => "the angle reference" },
                if analysis.options.q_limits { "held" } else { "not held" },
            ),
            "publisher": field("publisher"),
            "isVersionOf": null,
            "rightsHolder": field("rightsHolder"),
        })
    }

    /// The finished analysis as a SAR dataset.
    pub fn sar(&self, header: &SarHeader) -> Result<String, String> {
        let (_, done) = self.finished().ok_or("the analysis has not finished")?;
        done.to_sar(header).map_err(|e| e.to_string())
    }

    /// The results of a SAR loaded with the model: each with what it is about, whether that is in
    /// the model, and, once an analysis has finished, its own value for the same contingency,
    /// terminal and limit.
    pub fn sar_results(&self) -> Value {
        let ours: HashMap<(Option<&str>, &str, &str), f64> = self
            .finished()
            .map(|(_, done)| {
                done.violations
                    .iter()
                    .map(|v| {
                        (
                            (
                                v.contingency.as_deref(),
                                v.terminal.as_str(),
                                v.limit.mrid.as_str(),
                            ),
                            v.percent(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let analysed = self.finished().is_some();
        let mut rows = Vec::new();
        for class in [
            "nc:BaseCasePowerFlowResult",
            "nc:ContingencyPowerFlowResult",
        ] {
            for id in self.dataset.by_type.get(class).into_iter().flatten() {
                let e = &self.dataset.entries[id];
                let reference = |key: &str| e.get_ref(key).map(mrid_of);
                let contingency = reference("ContingencyPowerFlowResult.Contingency");
                let terminal = reference("PowerFlowResult.ACDCTerminal");
                let limit = reference("PowerFlowResult.OperationalLimit");
                let ours = match (terminal, limit) {
                    (Some(t), Some(l)) => ours.get(&(contingency, t, l)).map(|p| round(*p, 2)),
                    _ => None,
                };
                rows.push(json!({
                    "id": id,
                    "contingency": contingency.map(|c| self.linked(c)),
                    "terminal": terminal.map(|t| self.linked(t)),
                    "equipment": terminal.and_then(|t| self.equipment_of(t)).map(|(_, e)| e),
                    "limit": limit.map(|l| self.linked(l)),
                    "isViolation": e.get_str("PowerFlowResult.isViolation"),
                    "value": e.get_str("PowerFlowResult.value"),
                    "valueA": e.get_str("PowerFlowResult.valueA"),
                    "atTime": e.get_str("PowerFlowResult.atTime"),
                    "ours": ours,
                    "analysed": analysed,
                }));
            }
        }
        Value::Array(rows)
    }
}
