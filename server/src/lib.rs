pub mod api;
pub mod doc;
pub mod protocol;
pub mod room;
pub mod seed;
pub mod store;
pub mod thumbnail;

use axum::Router;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tower_http::services::{ServeDir, ServeFile};

pub use room::Hub;
pub use store::Store;

/// Build the application. If `static_dir` exists it is served as a SPA.
pub fn app(hub: Arc<Hub>, static_dir: Option<&Path>) -> Router {
    let mut router = api::routes().with_state(hub);
    if let Some(dir) = static_dir.filter(|d| d.join("index.html").exists()) {
        let spa = ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")));
        router = router.fallback_service(spa);
    }
    router
}

/// Create the welcome document if the database is empty.
pub fn seed_if_empty(store: &Store) -> rusqlite::Result<()> {
    if store.count()? == 0 {
        let doc = seed::welcome();
        store.create(
            &api::new_id(),
            "Welcome to Tessera",
            &doc.to_json(),
            doc.len(),
        )?;
    }
    Ok(())
}

/// Periodically persist dirty rooms.
pub fn spawn_flusher(hub: Arc<Hub>, every: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        loop {
            tick.tick().await;
            hub.flush_all().await;
        }
    })
}
