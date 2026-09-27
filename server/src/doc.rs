//! The document model: a flat map of node id -> property bag.
//!
//! Every edit is expressed as an [`Op`]. The server applies ops in the order it
//! receives them, which makes it the single source of truth: the last write to
//! a `(node, property)` pair that reaches the server wins. Clients generate node
//! ids themselves (session id + counter + random suffix), so creates never collide.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub type Props = Map<String, Value>;

pub const MAX_NODES: usize = 5_000;
pub const MAX_ID_LEN: usize = 64;
pub const MAX_PROPS_PER_NODE: usize = 48;
pub const MAX_KEY_LEN: usize = 32;
pub const MAX_OPS_PER_BATCH: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum Op {
    /// Insert a node (or overwrite it, which makes replay after reconnect idempotent).
    Create { id: String, props: Props },
    /// Merge properties into an existing node. A `null` value removes the key.
    /// Sets against a missing node are ignored: delete wins over concurrent edits.
    Set { id: String, props: Props },
    /// Remove a node.
    Del { id: String },
}

impl Op {
    pub fn id(&self) -> &str {
        match self {
            Op::Create { id, .. } | Op::Set { id, .. } | Op::Del { id } => id,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Doc {
    pub nodes: BTreeMap<String, Props>,
}

#[derive(Debug, PartialEq)]
pub enum OpError {
    TooManyOps,
    BadId,
    TooManyProps,
    BadKey,
    DocFull,
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            OpError::TooManyOps => "too many ops in one batch",
            OpError::BadId => "node id is empty or too long",
            OpError::TooManyProps => "node has too many properties",
            OpError::BadKey => "property key is empty or too long",
            OpError::DocFull => "document has reached its node limit",
        };
        f.write_str(msg)
    }
}

fn check_props(props: &Props) -> Result<(), OpError> {
    if props.len() > MAX_PROPS_PER_NODE {
        return Err(OpError::TooManyProps);
    }
    if props.keys().any(|k| k.is_empty() || k.len() > MAX_KEY_LEN) {
        return Err(OpError::BadKey);
    }
    Ok(())
}

impl Doc {
    pub fn from_json(s: &str) -> serde_json::Result<Self> {
        serde_json::from_str(s)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("doc serializes")
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Validate a whole batch before touching the document, so a batch is
    /// applied atomically or not at all.
    pub fn validate(&self, ops: &[Op]) -> Result<(), OpError> {
        if ops.len() > MAX_OPS_PER_BATCH {
            return Err(OpError::TooManyOps);
        }
        let mut creates = 0usize;
        for op in ops {
            let id = op.id();
            if id.is_empty() || id.len() > MAX_ID_LEN {
                return Err(OpError::BadId);
            }
            match op {
                Op::Create { id, props } => {
                    check_props(props)?;
                    if !self.nodes.contains_key(id) {
                        creates += 1;
                    }
                }
                Op::Set { props, .. } => check_props(props)?,
                Op::Del { .. } => {}
            }
        }
        if self.nodes.len() + creates > MAX_NODES {
            return Err(OpError::DocFull);
        }
        Ok(())
    }

    /// Apply a validated batch. Returns true if anything changed.
    pub fn apply(&mut self, ops: &[Op]) -> bool {
        let mut changed = false;
        for op in ops {
            match op {
                Op::Create { id, props } => {
                    let props: Props = props
                        .iter()
                        .filter(|(_, v)| !v.is_null())
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    self.nodes.insert(id.clone(), props);
                    changed = true;
                }
                Op::Set { id, props } => {
                    let Some(node) = self.nodes.get_mut(id) else {
                        continue;
                    };
                    for (k, v) in props {
                        if v.is_null() {
                            changed |= node.remove(k).is_some();
                        } else if node.get(k) != Some(v) {
                            if node.len() >= MAX_PROPS_PER_NODE && !node.contains_key(k) {
                                continue;
                            }
                            node.insert(k.clone(), v.clone());
                            changed = true;
                        }
                    }
                }
                Op::Del { id } => changed |= self.nodes.remove(id).is_some(),
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn props(v: Value) -> Props {
        v.as_object().unwrap().clone()
    }

    fn create(id: &str, v: Value) -> Op {
        Op::Create {
            id: id.into(),
            props: props(v),
        }
    }

    fn set(id: &str, v: Value) -> Op {
        Op::Set {
            id: id.into(),
            props: props(v),
        }
    }

    #[test]
    fn ops_round_trip_through_json() {
        let op: Op = serde_json::from_value(json!({"k":"set","id":"a","props":{"x":1}})).unwrap();
        assert_eq!(op, set("a", json!({"x":1})));
        let back = serde_json::to_value(Op::Del { id: "a".into() }).unwrap();
        assert_eq!(back, json!({"k":"del","id":"a"}));
    }

    #[test]
    fn set_merges_and_null_removes() {
        let mut d = Doc::default();
        d.apply(&[create("a", json!({"x":1,"fill":"#fff"}))]);
        assert!(d.apply(&[set("a", json!({"x":5,"fill":null}))]));
        assert_eq!(d.nodes["a"], props(json!({"x":5})));
    }

    #[test]
    fn last_writer_wins_per_property() {
        let mut d = Doc::default();
        d.apply(&[create("a", json!({"x":0,"y":0}))]);
        // Two clients edit different properties of the same node: both survive.
        d.apply(&[set("a", json!({"x":10}))]);
        d.apply(&[set("a", json!({"y":20}))]);
        // Two clients edit the same property: server order decides.
        d.apply(&[set("a", json!({"x":30}))]);
        assert_eq!(d.nodes["a"], props(json!({"x":30,"y":20})));
    }

    #[test]
    fn delete_wins_over_later_set() {
        let mut d = Doc::default();
        d.apply(&[create("a", json!({"x":0}))]);
        d.apply(&[Op::Del { id: "a".into() }]);
        assert!(!d.apply(&[set("a", json!({"x":1}))]));
        assert!(d.is_empty());
    }

    #[test]
    fn create_is_idempotent_for_replay() {
        let mut d = Doc::default();
        let op = create("a", json!({"x":1,"gone":null}));
        d.apply(std::slice::from_ref(&op));
        d.apply(&[op]);
        assert_eq!(d.len(), 1);
        assert_eq!(d.nodes["a"], props(json!({"x":1})));
    }

    #[test]
    fn no_op_set_reports_unchanged() {
        let mut d = Doc::default();
        d.apply(&[create("a", json!({"x":1}))]);
        assert!(!d.apply(&[set("a", json!({"x":1}))]));
    }

    #[test]
    fn validation_rejects_bad_batches() {
        let d = Doc::default();
        assert_eq!(d.validate(&[create("", json!({}))]), Err(OpError::BadId));
        assert_eq!(
            d.validate(&[create(&"x".repeat(65), json!({}))]),
            Err(OpError::BadId)
        );
        assert_eq!(d.validate(&[set("a", json!({"":1}))]), Err(OpError::BadKey));
        let many: Map<String, Value> = (0..49).map(|i| (format!("k{i}"), json!(i))).collect();
        assert_eq!(
            d.validate(&[Op::Create {
                id: "a".into(),
                props: many
            }]),
            Err(OpError::TooManyProps)
        );
        let ops: Vec<Op> = (0..=MAX_OPS_PER_BATCH)
            .map(|i| Op::Del { id: i.to_string() })
            .collect();
        assert_eq!(d.validate(&ops), Err(OpError::TooManyOps));
    }

    #[test]
    fn validation_enforces_node_limit() {
        let mut d = Doc::default();
        let fill: Vec<Op> = (0..MAX_NODES)
            .map(|i| create(&format!("n{i}"), json!({})))
            .collect();
        for chunk in fill.chunks(MAX_OPS_PER_BATCH) {
            d.validate(chunk).unwrap();
            d.apply(chunk);
        }
        assert_eq!(
            d.validate(&[create("extra", json!({}))]),
            Err(OpError::DocFull)
        );
        // Overwriting an existing node is still allowed at the limit.
        assert!(d.validate(&[create("n0", json!({"x":1}))]).is_ok());
    }

    #[test]
    fn doc_serializes_as_plain_map() {
        let mut d = Doc::default();
        d.apply(&[create("a", json!({"x":1}))]);
        assert_eq!(d.to_json(), r#"{"a":{"x":1}}"#);
        assert_eq!(Doc::from_json(&d.to_json()).unwrap(), d);
    }
}
