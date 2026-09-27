//! HTTP routes and the WebSocket session loop.

use crate::protocol::ClientMsg;
use crate::room::{Hub, Joined};
use crate::store::DocRow;
use crate::thumbnail;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

pub type AppState = Arc<Hub>;

pub const MAX_WS_MESSAGE: usize = 2 * 1024 * 1024;
const MAX_NAME_LEN: usize = 40;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/stats", get(stats))
        .route("/api/docs", get(list_docs).post(create_doc))
        .route(
            "/api/docs/{id}",
            get(get_doc).patch(rename_doc).delete(delete_doc),
        )
        .route("/api/docs/{id}/thumbnail.svg", get(thumbnail_svg))
        .route("/ws/{id}", get(ws_upgrade))
}

pub enum ApiError {
    NotFound,
    BadRequest(&'static str),
    Internal(String),
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "Document not found".to_string()),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.to_string()),
            ApiError::Internal(m) => {
                tracing::error!("internal error: {m}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

async fn db<T: Send + 'static>(
    hub: &Hub,
    f: impl FnOnce(crate::store::Store) -> rusqlite::Result<T> + Send + 'static,
) -> ApiResult<T> {
    let store = hub.store.clone();
    Ok(tokio::task::spawn_blocking(move || f(store))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))??)
}

pub fn new_id() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::thread_rng();
    (0..10)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

fn clean_name(raw: &str, fallback: &str) -> String {
    let name: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_LEN)
        .collect();
    if name.is_empty() {
        fallback.to_string()
    } else {
        name
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Editor {
    name: String,
    color: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocSummary {
    #[serde(flatten)]
    row: DocRow,
    editors: Vec<Editor>,
}

async fn list_docs(State(hub): State<AppState>) -> ApiResult<Json<Vec<DocSummary>>> {
    let rows = db(&hub, |s| s.list()).await?;
    let live = hub.live().await;
    Ok(Json(
        rows.into_iter()
            .map(|mut row| {
                let editors = match live.get(&row.id) {
                    Some(l) => {
                        row.node_count = l.node_count;
                        l.editors
                            .iter()
                            .map(|(n, c)| Editor {
                                name: n.clone(),
                                color: c.clone(),
                            })
                            .collect()
                    }
                    None => vec![],
                };
                DocSummary { row, editors }
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
struct NameBody {
    name: Option<String>,
}

async fn create_doc(
    State(hub): State<AppState>,
    body: axum::body::Bytes,
) -> ApiResult<(StatusCode, Json<DocRow>)> {
    // The body is optional: an empty POST creates an "Untitled" file.
    let requested = if body.is_empty() {
        None
    } else {
        serde_json::from_slice::<NameBody>(&body)
            .map_err(|_| ApiError::BadRequest("Body must be JSON like {\"name\": \"...\"}"))?
            .name
    };
    let name = clean_name(requested.as_deref().unwrap_or(""), "Untitled");
    let id = new_id();
    let row = db(&hub, move |s| s.create(&id, &name, "{}", 0)).await?;
    Ok((StatusCode::CREATED, Json(row)))
}

async fn get_doc(State(hub): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<DocRow>> {
    db(&hub, move |s| s.get(&id))
        .await?
        .map(Json)
        .ok_or(ApiError::NotFound)
}

async fn rename_doc(
    State(hub): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<NameBody>,
) -> ApiResult<Json<DocRow>> {
    let name = clean_name(body.name.as_deref().unwrap_or(""), "");
    if name.is_empty() {
        return Err(ApiError::BadRequest("Name can't be empty"));
    }
    let (id2, name2) = (id.clone(), name.clone());
    let row = db(&hub, move |s| s.rename(&id2, &name2))
        .await?
        .ok_or(ApiError::NotFound)?;
    hub.rename(&id, name).await;
    Ok(Json(row))
}

async fn delete_doc(State(hub): State<AppState>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    hub.close(&id).await;
    if db(&hub, move |s| s.delete(&id)).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

async fn thumbnail_svg(State(hub): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let doc = match hub.live_room(&id).await {
        Some(room) => room.snapshot_nodes(),
        None => {
            let (_, json) = db(&hub, move |s| s.load(&id))
                .await?
                .ok_or(ApiError::NotFound)?;
            crate::doc::Doc::from_json(&json).unwrap_or_default()
        }
    };
    Ok((
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        thumbnail::render(&doc.nodes),
    )
        .into_response())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsBody {
    rooms: usize,
    peers: usize,
    connections_total: u64,
    batches: u64,
    ops_applied: u64,
    messages_out: u64,
    evictions: u64,
    uptime_secs: u64,
}

async fn stats(State(hub): State<AppState>) -> Json<StatsBody> {
    let (rooms, peers) = hub.peer_count().await;
    let s = &hub.stats;
    Json(StatsBody {
        rooms,
        peers,
        connections_total: s.connections.load(Ordering::Relaxed),
        batches: s.batches.load(Ordering::Relaxed),
        ops_applied: s.ops_applied.load(Ordering::Relaxed),
        messages_out: s.messages_out.load(Ordering::Relaxed),
        evictions: s.evictions.load(Ordering::Relaxed),
        uptime_secs: hub.started.elapsed().as_secs(),
    })
}

#[derive(Deserialize)]
struct WsQuery {
    name: Option<String>,
}

async fn ws_upgrade(
    State(hub): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    let id2 = id.clone();
    if db(&hub, move |s| s.get(&id2)).await?.is_none() {
        return Err(ApiError::NotFound);
    }
    let name = clean_name(q.name.as_deref().unwrap_or(""), "Guest");
    Ok(ws
        .max_message_size(MAX_WS_MESSAGE)
        .on_upgrade(move |socket| session(socket, hub, id, name)))
}

async fn session(socket: WebSocket, hub: AppState, doc_id: String, name: String) {
    let Joined { room, sid, mut rx } = match hub.join(&doc_id, name).await {
        Ok(Some(j)) => j,
        Ok(None) => return, // deleted between the upgrade check and now
        Err(e) => {
            tracing::error!(doc_id, "join failed: {e}");
            return;
        }
    };
    tracing::info!(doc_id, sid, "peer joined");
    let (mut sink, mut stream) = socket.split();

    // Writer: drain this peer's FIFO queue onto the socket, with keepalive pings.
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(Duration::from_secs(20));
        ping.tick().await;
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Some(text) => if sink.send(Message::Text(text)).await.is_err() { break },
                    None => break, // evicted or document deleted
                },
                _ = ping.tick() => if sink.send(Message::Ping(Default::default())).await.is_err() { break },
            }
        }
        let _ = sink.close().await;
    });

    // Reader: decode and apply. The room does the ordering work.
    let mut writer = writer;
    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientMsg>(text.as_str()) {
                    Ok(msg) => room.handle(sid, msg),
                    Err(e) => tracing::debug!(sid, "bad client message: {e}"),
                },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            _ = &mut writer => break,
        }
    }
    writer.abort();
    hub.leave(&room, sid).await;
    tracing::info!(doc_id, sid, "peer left");
}
