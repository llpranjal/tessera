use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tessera_server::{app, seed_if_empty, spawn_flusher, Hub, Store};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let db_path = std::env::var("TESSERA_DB").unwrap_or_else(|_| "tessera.db".into());
    let static_dir =
        PathBuf::from(std::env::var("TESSERA_STATIC").unwrap_or_else(|_| "../web/dist".into()));

    let store = Store::open(&db_path)?;
    seed_if_empty(&store)?;
    let hub = Arc::new(Hub::new(store));
    spawn_flusher(hub.clone(), Duration::from_secs(2));

    let router = app(hub.clone(), Some(&static_dir)).layer(TraceLayer::new_for_http());
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("tessera listening on http://localhost:{port} (db: {db_path})");

    // WebSockets never close on their own, so rather than waiting for them we
    // stop on a signal, persist every open document, and exit. Clients reconnect
    // and replay anything unacknowledged.
    tokio::select! {
        res = axum::serve(listener, router) => res?,
        _ = shutdown_signal() => tracing::info!("shutting down"),
    }
    hub.flush_all().await;
    tracing::info!("flushed open documents, bye");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}
