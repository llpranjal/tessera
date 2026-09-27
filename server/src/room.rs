//! Rooms: one live, authoritative copy of each open document plus its peers.
//!
//! Ordering guarantee the client relies on: every message to a peer goes
//! through that peer's single FIFO queue, and all enqueues for a room happen
//! while holding the room lock. So if the server applies A's batch before B's,
//! every peer observes A's effects (or A's ack) before B's.

use crate::doc::{Doc, Op};
use crate::protocol::{ClientMsg, Cursor, DocMeta, PeerInfo, ServerMsg};
use crate::store::Store;
use axum::extract::ws::Utf8Bytes;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use tokio::sync::mpsc;

/// Outbound queue depth per peer. A peer that falls this far behind is
/// disconnected rather than allowed to grow server memory; it will reconnect
/// and receive a fresh snapshot.
pub const PEER_QUEUE: usize = 1024;

pub const PEER_COLORS: [&str; 8] = [
    "#2B3BEA", "#E8457A", "#12A383", "#F2A516", "#8A4DEB", "#0FA3D1", "#D23B8A", "#5C6B00",
];

#[derive(Default)]
pub struct Stats {
    pub ops_applied: AtomicU64,
    pub batches: AtomicU64,
    pub messages_out: AtomicU64,
    pub connections: AtomicU64,
    pub evictions: AtomicU64,
}

pub struct Hub {
    rooms: tokio::sync::Mutex<HashMap<String, Arc<Room>>>,
    pub store: Store,
    pub stats: Arc<Stats>,
    pub started: Instant,
}

pub struct Room {
    pub id: String,
    state: Mutex<RoomState>,
    /// Serializes snapshot+write so an older snapshot can never overwrite a newer one.
    save_lock: tokio::sync::Mutex<()>,
    stats: Arc<Stats>,
}

struct RoomState {
    name: String,
    doc: Doc,
    version: u64,
    dirty: bool,
    closed: bool,
    next_sid: u32,
    peers: BTreeMap<u32, Peer>,
}

struct Peer {
    info: PeerInfo,
    tx: mpsc::Sender<Utf8Bytes>,
}

pub struct Joined {
    pub room: Arc<Room>,
    pub sid: u32,
    pub rx: mpsc::Receiver<Utf8Bytes>,
}

#[derive(Debug, Clone)]
pub struct LiveDoc {
    pub editors: Vec<(String, String)>,
    pub node_count: usize,
}

impl Hub {
    pub fn new(store: Store) -> Self {
        Self {
            rooms: Default::default(),
            store,
            stats: Default::default(),
            started: Instant::now(),
        }
    }

    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(Store) -> rusqlite::Result<T> + Send + 'static,
    ) -> rusqlite::Result<T> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || f(store))
            .await
            .expect("store task panicked")
    }

    /// Join a document, loading it into memory if nobody has it open.
    /// Returns `None` if the document doesn't exist.
    pub async fn join(&self, doc_id: &str, name: String) -> rusqlite::Result<Option<Joined>> {
        let mut rooms = self.rooms.lock().await;
        let room = match rooms.get(doc_id) {
            Some(r) => r.clone(),
            None => {
                let id = doc_id.to_string();
                let Some((name, json)) = self.blocking(move |s| s.load(&id)).await? else {
                    return Ok(None);
                };
                let doc = Doc::from_json(&json).unwrap_or_else(|e| {
                    tracing::error!(doc_id, "corrupt snapshot, starting empty: {e}");
                    Doc::default()
                });
                let room = Arc::new(Room::new(doc_id.to_string(), name, doc, self.stats.clone()));
                rooms.insert(doc_id.to_string(), room.clone());
                room
            }
        };
        drop(rooms);
        let (sid, rx) = room.add_peer(name);
        self.stats.connections.fetch_add(1, Ordering::Relaxed);
        Ok(Some(Joined { room, sid, rx }))
    }

    /// Remove a peer. The last peer out flushes the document and unloads the room.
    pub async fn leave(&self, room: &Arc<Room>, sid: u32) {
        let mut rooms = self.rooms.lock().await;
        let empty = room.remove_peer(sid);
        if empty && rooms.get(&room.id).is_some_and(|r| Arc::ptr_eq(r, room)) {
            rooms.remove(&room.id);
        }
        drop(rooms);
        if empty {
            if let Err(e) = room.flush(&self.store).await {
                tracing::error!(doc_id = room.id, "flush on close failed: {e}");
            }
        }
    }

    /// Flush every dirty room. Called periodically.
    pub async fn flush_all(&self) {
        let rooms: Vec<_> = self.rooms.lock().await.values().cloned().collect();
        for room in rooms {
            if let Err(e) = room.flush(&self.store).await {
                tracing::error!(doc_id = room.id, "periodic flush failed: {e}");
            }
        }
    }

    pub async fn live_room(&self, doc_id: &str) -> Option<Arc<Room>> {
        self.rooms.lock().await.get(doc_id).cloned()
    }

    pub async fn live(&self) -> HashMap<String, LiveDoc> {
        let rooms = self.rooms.lock().await;
        rooms
            .iter()
            .map(|(id, r)| {
                let st = r.lock();
                let editors = st
                    .peers
                    .values()
                    .map(|p| (p.info.name.clone(), p.info.color.clone()))
                    .collect();
                (
                    id.clone(),
                    LiveDoc {
                        editors,
                        node_count: st.doc.len(),
                    },
                )
            })
            .collect()
    }

    pub async fn peer_count(&self) -> (usize, usize) {
        let rooms = self.rooms.lock().await;
        let peers = rooms.values().map(|r| r.lock().peers.len()).sum();
        (rooms.len(), peers)
    }

    pub async fn rename(&self, doc_id: &str, name: String) {
        if let Some(room) = self.live_room(doc_id).await {
            let mut st = room.lock();
            st.name = name;
            let msg: Utf8Bytes = ServerMsg::Meta { name: &st.name }.encode().into();
            room.broadcast(&mut st, None, msg);
        }
    }

    /// Kick everyone out of a deleted document.
    pub async fn close(&self, doc_id: &str) {
        let room = self.rooms.lock().await.remove(doc_id);
        if let Some(room) = room {
            let mut st = room.lock();
            st.closed = true;
            let msg: Utf8Bytes = ServerMsg::Deleted.encode().into();
            room.broadcast(&mut st, None, msg);
            // Dropping the senders ends each peer's writer task, closing the socket.
            st.peers.clear();
        }
    }
}

impl Room {
    pub fn new(id: String, name: String, doc: Doc, stats: Arc<Stats>) -> Self {
        Self {
            id,
            state: Mutex::new(RoomState {
                name,
                doc,
                version: 0,
                dirty: false,
                closed: false,
                next_sid: 1,
                peers: BTreeMap::new(),
            }),
            save_lock: Default::default(),
            stats,
        }
    }

    fn lock(&self) -> MutexGuard<'_, RoomState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn snapshot_nodes(&self) -> Doc {
        self.lock().doc.clone()
    }

    /// Enqueue to one peer. Returns false if the peer's queue is full or its
    /// socket has already gone away; either way the peer should be dropped.
    fn send(&self, peer: &Peer, msg: Utf8Bytes) -> bool {
        match peer.tx.try_send(msg) {
            Ok(()) => {
                self.stats.messages_out.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.stats.evictions.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(doc_id = self.id, sid = peer.info.sid, "evicting slow peer");
                false
            }
            // Disconnected; its session task will call `leave` shortly.
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    /// Fan a pre-serialized message out to every peer except `skip`. The JSON
    /// is encoded once; `Utf8Bytes` clones are reference-counted.
    fn broadcast(&self, st: &mut RoomState, skip: Option<u32>, msg: Utf8Bytes) {
        let mut slow = Vec::new();
        for (sid, peer) in &st.peers {
            if Some(*sid) != skip && !self.send(peer, msg.clone()) {
                slow.push(*sid);
            }
        }
        self.evict(st, slow);
    }

    fn evict(&self, st: &mut RoomState, mut sids: Vec<u32>) {
        while let Some(sid) = sids.pop() {
            if st.peers.remove(&sid).is_none() {
                continue;
            }
            let msg: Utf8Bytes = ServerMsg::Leave { sid }.encode().into();
            for (other, peer) in &st.peers {
                if !self.send(peer, msg.clone()) {
                    sids.push(*other);
                }
            }
        }
    }

    fn add_peer(&self, name: String) -> (u32, mpsc::Receiver<Utf8Bytes>) {
        let (tx, rx) = mpsc::channel(PEER_QUEUE);
        let mut st = self.lock();
        let sid = st.next_sid;
        st.next_sid += 1;
        let used: Vec<&str> = st.peers.values().map(|p| p.info.color.as_str()).collect();
        let color = PEER_COLORS
            .iter()
            .find(|c| !used.contains(c))
            .unwrap_or(&PEER_COLORS[sid as usize % PEER_COLORS.len()])
            .to_string();
        let info = PeerInfo {
            sid,
            name,
            color,
            cursor: None,
            selection: vec![],
        };

        let welcome = ServerMsg::Welcome {
            you: &info,
            doc: DocMeta {
                id: &self.id,
                name: &st.name,
            },
            version: st.version,
            nodes: &st.doc.nodes,
            peers: st.peers.values().map(|p| &p.info).collect(),
        }
        .encode();
        // Fresh channel with capacity > 0: this cannot fail.
        let _ = tx.try_send(welcome.into());

        let join: Utf8Bytes = ServerMsg::Join { peer: &info }.encode().into();
        self.broadcast(&mut st, None, join);
        st.peers.insert(sid, Peer { info, tx });
        (sid, rx)
    }

    /// Returns true if the room is now empty.
    fn remove_peer(&self, sid: u32) -> bool {
        let mut st = self.lock();
        if st.peers.remove(&sid).is_some() {
            let msg: Utf8Bytes = ServerMsg::Leave { sid }.encode().into();
            self.broadcast(&mut st, None, msg);
        }
        st.peers.is_empty()
    }

    pub fn handle(&self, sid: u32, msg: ClientMsg) {
        let mut st = self.lock();
        if st.closed || !st.peers.contains_key(&sid) {
            return;
        }
        match msg {
            ClientMsg::Ops { seq, ops } => self.apply(&mut st, sid, seq, ops),
            ClientMsg::Presence {
                cursor,
                mut selection,
            } => {
                selection.truncate(1_000);
                let cursor: Cursor = cursor.filter(|[x, y]| x.is_finite() && y.is_finite());
                let msg: Utf8Bytes = ServerMsg::Presence {
                    sid,
                    cursor,
                    selection: &selection,
                }
                .encode()
                .into();
                if let Some(p) = st.peers.get_mut(&sid) {
                    p.info.cursor = cursor;
                    p.info.selection = selection;
                }
                self.broadcast(&mut st, Some(sid), msg);
            }
        }
    }

    fn apply(&self, st: &mut RoomState, sid: u32, seq: u64, ops: Vec<Op>) {
        if let Err(e) = st.doc.validate(&ops) {
            // Refuse the whole batch, then resync the sender so its optimistic
            // state can't drift from ours.
            let reject: Utf8Bytes = ServerMsg::Reject {
                seq,
                message: e.to_string(),
            }
            .encode()
            .into();
            let snap: Utf8Bytes = ServerMsg::Snapshot {
                version: st.version,
                nodes: &st.doc.nodes,
            }
            .encode()
            .into();
            let peer = &st.peers[&sid];
            if !(self.send(peer, reject) && self.send(peer, snap)) {
                self.evict(st, vec![sid]);
            }
            return;
        }
        st.dirty |= st.doc.apply(&ops);
        st.version += 1;
        self.stats.batches.fetch_add(1, Ordering::Relaxed);
        self.stats
            .ops_applied
            .fetch_add(ops.len() as u64, Ordering::Relaxed);

        let version = st.version;
        let ack: Utf8Bytes = ServerMsg::Ack { seq, version }.encode().into();
        if !self.send(&st.peers[&sid], ack) {
            self.evict(st, vec![sid]);
        }
        let msg: Utf8Bytes = ServerMsg::Ops {
            from: sid,
            version,
            ops: &ops,
        }
        .encode()
        .into();
        self.broadcast(st, Some(sid), msg);
    }

    /// Persist the document if it changed since the last flush.
    pub async fn flush(&self, store: &Store) -> rusqlite::Result<()> {
        let _guard = self.save_lock.lock().await;
        let (json, count) = {
            let mut st = self.lock();
            if !st.dirty || st.closed {
                return Ok(());
            }
            st.dirty = false;
            (st.doc.to_json(), st.doc.len())
        };
        let store = store.clone();
        let id = self.id.clone();
        let res = tokio::task::spawn_blocking(move || store.save_nodes(&id, &json, count))
            .await
            .expect("store task panicked");
        if res.is_err() {
            // Try again on the next tick.
            self.lock().dirty = true;
        }
        res.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn room() -> Room {
        Room::new("d".into(), "Doc".into(), Doc::default(), Default::default())
    }

    fn drain(rx: &mut mpsc::Receiver<Utf8Bytes>) -> Vec<Value> {
        let mut out = vec![];
        while let Ok(m) = rx.try_recv() {
            out.push(serde_json::from_str(m.as_str()).unwrap());
        }
        out
    }

    fn ops(v: Value) -> ClientMsg {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn welcome_then_join_then_ack_and_broadcast() {
        let r = room();
        let (a, mut ra) = r.add_peer("Ada".into());
        let (b, mut rb) = r.add_peer("Bo".into());

        let a_msgs = drain(&mut ra);
        assert_eq!(a_msgs[0]["t"], "welcome");
        assert_eq!(
            a_msgs[1],
            json!({"t":"join","peer":{"sid":b,"name":"Bo","color":PEER_COLORS[1],"cursor":null,"selection":[]}})
        );
        let b_msgs = drain(&mut rb);
        assert_eq!(b_msgs[0]["peers"][0]["sid"], a);

        r.handle(
            a,
            ops(json!({"t":"ops","seq":7,"ops":[{"k":"create","id":"n","props":{"x":1}}]})),
        );
        assert_eq!(drain(&mut ra), vec![json!({"t":"ack","seq":7,"version":1})]);
        let got = drain(&mut rb);
        assert_eq!(got[0]["t"], "ops");
        assert_eq!(got[0]["from"], a);
        assert_eq!(got[0]["version"], 1);
    }

    #[test]
    fn invalid_batch_is_rejected_atomically_with_snapshot() {
        let r = room();
        let (a, mut ra) = r.add_peer("Ada".into());
        drain(&mut ra);
        r.handle(
            a,
            ops(json!({"t":"ops","seq":1,"ops":[
                {"k":"create","id":"ok","props":{}},
                {"k":"create","id":"","props":{}}
            ]})),
        );
        let msgs = drain(&mut ra);
        assert_eq!(msgs[0]["t"], "reject");
        assert_eq!(msgs[0]["seq"], 1);
        assert_eq!(msgs[1], json!({"t":"snapshot","version":0,"nodes":{}}));
        assert!(r.snapshot_nodes().is_empty());
    }

    #[test]
    fn presence_goes_to_others_only() {
        let r = room();
        let (a, mut ra) = r.add_peer("Ada".into());
        let (_b, mut rb) = r.add_peer("Bo".into());
        drain(&mut ra);
        drain(&mut rb);
        r.handle(
            a,
            ops(json!({"t":"presence","cursor":[1.5,2.0],"selection":["n"]})),
        );
        assert!(drain(&mut ra).is_empty());
        assert_eq!(
            drain(&mut rb),
            vec![json!({"t":"presence","sid":a,"cursor":[1.5,2.0],"selection":["n"]})]
        );
    }

    #[test]
    fn slow_peer_is_evicted_instead_of_buffering_forever() {
        let r = room();
        let (a, mut ra) = r.add_peer("Ada".into());
        let (_slow, _rslow) = r.add_peer("Slow".into()); // never drained
        for i in 0..(PEER_QUEUE + 5) {
            r.handle(a, ops(json!({"t":"presence","cursor":[i as f64, 0.0]})));
            drain(&mut ra);
        }
        assert_eq!(r.lock().peers.len(), 1);
        assert_eq!(r.stats.evictions.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn disconnected_peer_is_dropped_without_counting_as_slow() {
        let r = room();
        let (a, mut ra) = r.add_peer("Ada".into());
        let (_gone, rgone) = r.add_peer("Gone".into());
        drop(rgone); // socket closed, session hasn't called leave yet
        drain(&mut ra);
        r.handle(a, ops(json!({"t":"presence","cursor":[1.0, 1.0]})));
        assert_eq!(r.lock().peers.len(), 1);
        assert_eq!(r.stats.evictions.load(Ordering::Relaxed), 0);
        assert_eq!(drain(&mut ra)[0]["t"], "leave");
    }

    #[test]
    fn peers_get_distinct_colors() {
        let r = room();
        let (_, _ra) = r.add_peer("A".into());
        let (b, _rb) = r.add_peer("B".into());
        assert!(!r.remove_peer(b));
        let (_, _rc) = r.add_peer("C".into());
        let colors: Vec<String> = r
            .lock()
            .peers
            .values()
            .map(|p| p.info.color.clone())
            .collect();
        assert_eq!(colors, vec![PEER_COLORS[0], PEER_COLORS[1]]);
    }

    #[tokio::test]
    async fn flush_persists_only_when_dirty() {
        let store = Store::in_memory().unwrap();
        store.create("d", "Doc", "{}", 0).unwrap();
        let r = room();
        let (a, _ra) = r.add_peer("A".into());
        r.flush(&store).await.unwrap();
        let before = store.get("d").unwrap().unwrap().updated_at;

        r.handle(
            a,
            ops(json!({"t":"ops","seq":1,"ops":[{"k":"create","id":"n","props":{"x":1}}]})),
        );
        r.flush(&store).await.unwrap();
        let (_, nodes) = store.load("d").unwrap().unwrap();
        assert_eq!(nodes, r#"{"n":{"x":1}}"#);
        assert!(store.get("d").unwrap().unwrap().updated_at >= before);
        assert!(!r.lock().dirty);
    }
}
