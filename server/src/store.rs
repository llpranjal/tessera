//! SQLite persistence. Documents are stored as one JSON snapshot per row; the
//! in-memory room is the live copy and is flushed here when dirty.
//!
//! rusqlite is synchronous, so async callers go through `tokio::task::spawn_blocking`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRow {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub node_count: usize,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS docs (
                 id          TEXT PRIMARY KEY,
                 name        TEXT NOT NULL,
                 nodes       TEXT NOT NULL DEFAULT '{}',
                 node_count  INTEGER NOT NULL DEFAULT 0,
                 created_at  INTEGER NOT NULL,
                 updated_at  INTEGER NOT NULL
             );",
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn list(&self) -> rusqlite::Result<Vec<DocRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, created_at, updated_at, node_count FROM docs ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_doc)?;
        rows.collect()
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<DocRow>> {
        self.conn()
            .query_row(
                "SELECT id, name, created_at, updated_at, node_count FROM docs WHERE id = ?1",
                [id],
                row_to_doc,
            )
            .optional()
    }

    /// Returns the doc's name and its node snapshot JSON.
    pub fn load(&self, id: &str) -> rusqlite::Result<Option<(String, String)>> {
        self.conn()
            .query_row("SELECT name, nodes FROM docs WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
    }

    pub fn create(
        &self,
        id: &str,
        name: &str,
        nodes_json: &str,
        node_count: usize,
    ) -> rusqlite::Result<DocRow> {
        let now = now_ms();
        self.conn().execute(
            "INSERT INTO docs (id, name, nodes, node_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, nodes_json, node_count as i64, now],
        )?;
        Ok(DocRow {
            id: id.into(),
            name: name.into(),
            created_at: now,
            updated_at: now,
            node_count,
        })
    }

    pub fn save_nodes(
        &self,
        id: &str,
        nodes_json: &str,
        node_count: usize,
    ) -> rusqlite::Result<bool> {
        let n = self.conn().execute(
            "UPDATE docs SET nodes = ?2, node_count = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, nodes_json, node_count as i64, now_ms()],
        )?;
        Ok(n > 0)
    }

    pub fn rename(&self, id: &str, name: &str) -> rusqlite::Result<Option<DocRow>> {
        let n = self.conn().execute(
            "UPDATE docs SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now_ms()],
        )?;
        if n == 0 {
            return Ok(None);
        }
        self.get(id)
    }

    pub fn delete(&self, id: &str) -> rusqlite::Result<bool> {
        Ok(self
            .conn()
            .execute("DELETE FROM docs WHERE id = ?1", [id])?
            > 0)
    }

    pub fn count(&self) -> rusqlite::Result<i64> {
        self.conn()
            .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))
    }
}

fn row_to_doc(r: &rusqlite::Row<'_>) -> rusqlite::Result<DocRow> {
    Ok(DocRow {
        id: r.get(0)?,
        name: r.get(1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        node_count: r.get::<_, i64>(4)? as usize,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crud_round_trip() {
        let s = Store::in_memory().unwrap();
        s.create("a", "First", "{}", 0).unwrap();
        s.create("b", "Second", "{}", 0).unwrap();
        assert_eq!(s.count().unwrap(), 2);

        assert!(s.save_nodes("a", r#"{"n":{"x":1}}"#, 1).unwrap());
        let (name, nodes) = s.load("a").unwrap().unwrap();
        assert_eq!(name, "First");
        assert_eq!(nodes, r#"{"n":{"x":1}}"#);
        assert_eq!(s.get("a").unwrap().unwrap().node_count, 1);

        assert_eq!(s.rename("a", "Renamed").unwrap().unwrap().name, "Renamed");
        assert!(s.rename("missing", "x").unwrap().is_none());

        assert!(s.delete("b").unwrap());
        assert!(!s.delete("b").unwrap());
        assert!(s.load("b").unwrap().is_none());
        assert_eq!(s.list().unwrap().len(), 1);
    }
}
