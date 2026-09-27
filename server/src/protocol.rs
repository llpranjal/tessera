//! Wire protocol. Mirrored by hand in `web/src/sync/protocol.ts`.

use crate::doc::{Op, Props};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Cursor = Option<[f64; 2]>;

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientMsg {
    /// A batch of edits. `seq` is chosen by the client and echoed back in `ack`.
    Ops { seq: u64, ops: Vec<Op> },
    /// Ephemeral state; broadcast, never persisted.
    Presence {
        cursor: Cursor,
        #[serde(default)]
        selection: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerInfo {
    pub sid: u32,
    pub name: String,
    pub color: String,
    pub cursor: Cursor,
    pub selection: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ServerMsg<'a> {
    Welcome {
        you: &'a PeerInfo,
        doc: DocMeta<'a>,
        version: u64,
        nodes: &'a BTreeMap<String, Props>,
        peers: Vec<&'a PeerInfo>,
    },
    Ops {
        from: u32,
        version: u64,
        ops: &'a [Op],
    },
    Ack {
        seq: u64,
        version: u64,
    },
    /// The batch `seq` was refused. A `snapshot` always follows.
    Reject {
        seq: u64,
        message: String,
    },
    Snapshot {
        version: u64,
        nodes: &'a BTreeMap<String, Props>,
    },
    Presence {
        sid: u32,
        cursor: Cursor,
        selection: &'a [String],
    },
    Join {
        peer: &'a PeerInfo,
    },
    Leave {
        sid: u32,
    },
    Meta {
        name: &'a str,
    },
    Deleted,
}

#[derive(Debug, Serialize)]
pub struct DocMeta<'a> {
    pub id: &'a str,
    pub name: &'a str,
}

impl ServerMsg<'_> {
    pub fn encode(&self) -> String {
        serde_json::to_string(self).expect("server messages serialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_client_messages() {
        let m: ClientMsg = serde_json::from_value(json!({
            "t": "ops", "seq": 3, "ops": [{"k": "del", "id": "a"}]
        }))
        .unwrap();
        assert!(matches!(m, ClientMsg::Ops { seq: 3, ref ops } if ops.len() == 1));

        let m: ClientMsg =
            serde_json::from_value(json!({"t": "presence", "cursor": null})).unwrap();
        assert!(
            matches!(m, ClientMsg::Presence { cursor: None, ref selection } if selection.is_empty())
        );
    }

    #[test]
    fn encodes_server_messages_with_tag() {
        let v: serde_json::Value =
            serde_json::from_str(&ServerMsg::Ack { seq: 1, version: 9 }.encode()).unwrap();
        assert_eq!(v, json!({"t": "ack", "seq": 1, "version": 9}));
        let v: serde_json::Value = serde_json::from_str(&ServerMsg::Deleted.encode()).unwrap();
        assert_eq!(v, json!({"t": "deleted"}));
    }
}
