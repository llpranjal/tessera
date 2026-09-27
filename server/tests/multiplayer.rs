//! End-to-end tests: a real server on a random port, real WebSocket clients.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tessera_server::{app, Hub, Store};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Server {
    addr: SocketAddr,
    hub: Arc<Hub>,
}

async fn start() -> Server {
    let hub = Arc::new(Hub::new(Store::in_memory().unwrap()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app(hub.clone(), None);
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Server { addr, hub }
}

async fn http(hub: &Arc<Hub>, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(body.map(|b| Body::from(b.to_string())).unwrap_or_default())
        .unwrap();
    let res = app(hub.clone(), None).oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let v = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
    (status, v)
}

async fn connect(s: &Server, doc: &str, name: &str) -> Ws {
    let url = format!("ws://{}/ws/{doc}?name={name}", s.addr);
    tokio_tungstenite::connect_async(url).await.unwrap().0
}

async fn recv(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(3), ws.next())
            .await
            .expect("timed out waiting for a message")
            .expect("stream ended")
            .unwrap();
        match msg {
            Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
            Message::Close(_) => return json!({"t": "__closed"}),
            _ => continue,
        }
    }
}

async fn recv_until(ws: &mut Ws, t: &str) -> Value {
    loop {
        let m = recv(ws).await;
        if m["t"] == t {
            return m;
        }
    }
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

#[tokio::test]
async fn rest_crud_and_thumbnail() {
    let s = start().await;
    let (st, doc) = http(
        &s.hub,
        "POST",
        "/api/docs",
        Some(json!({"name": "  Roadmap  "})),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);
    assert_eq!(doc["name"], "Roadmap");
    let id = doc["id"].as_str().unwrap().to_string();

    let (st, list) = http(&s.hub, "GET", "/api/docs", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["editors"], json!([]));

    let (st, _) = http(
        &s.hub,
        "PATCH",
        &format!("/api/docs/{id}"),
        Some(json!({"name": ""})),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, renamed) = http(
        &s.hub,
        "PATCH",
        &format!("/api/docs/{id}"),
        Some(json!({"name": "Q3"})),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(renamed["name"], "Q3");

    let (st, svg) = http(
        &s.hub,
        "GET",
        &format!("/api/docs/{id}/thumbnail.svg"),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(svg.as_str().unwrap().starts_with("<svg"));

    let (st, _) = http(&s.hub, "DELETE", &format!("/api/docs/{id}"), None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (st, _) = http(&s.hub, "GET", &format!("/api/docs/{id}"), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unknown_doc_refuses_websocket() {
    let s = start().await;
    let url = format!("ws://{}/ws/nope", s.addr);
    assert!(tokio_tungstenite::connect_async(url).await.is_err());
}

#[tokio::test]
async fn two_peers_sync_edits_presence_and_persist() {
    let s = start().await;
    let (_, doc) = http(&s.hub, "POST", "/api/docs", None).await;
    let id = doc["id"].as_str().unwrap().to_string();

    let mut a = connect(&s, &id, "Ada").await;
    let wa = recv(&mut a).await;
    assert_eq!(wa["t"], "welcome");
    assert_eq!(wa["you"]["name"], "Ada");

    let mut b = connect(&s, &id, "Bo").await;
    let wb = recv(&mut b).await;
    assert_eq!(wb["peers"][0]["name"], "Ada");
    assert_eq!(recv(&mut a).await["t"], "join");

    // Live editors show up in the file list.
    let (_, list) = http(&s.hub, "GET", "/api/docs", None).await;
    assert_eq!(list[0]["editors"].as_array().unwrap().len(), 2);

    // A creates a node: A gets an ack, B gets the ops.
    send(&mut a, json!({"t":"ops","seq":1,"ops":[{"k":"create","id":"n1","props":{"type":"rect","x":0,"fill":"#2B3BEA"}}]})).await;
    assert_eq!(recv(&mut a).await, json!({"t":"ack","seq":1,"version":1}));
    let got = recv(&mut b).await;
    assert_eq!(got["t"], "ops");
    assert_eq!(got["ops"][0]["id"], "n1");

    // Presence is relayed to the other peer.
    send(
        &mut b,
        json!({"t":"presence","cursor":[10.0,20.0],"selection":["n1"]}),
    )
    .await;
    let p = recv(&mut a).await;
    assert_eq!(p["cursor"], json!([10.0, 20.0]));
    assert_eq!(p["selection"], json!(["n1"]));

    // Both hammer the same property. Every message a peer sees carries a
    // strictly increasing version, and the final value is whichever write the
    // server applied last.
    for i in 0..25 {
        send(
            &mut a,
            json!({"t":"ops","seq":100+i,"ops":[{"k":"set","id":"n1","props":{"x":i}}]}),
        )
        .await;
        send(
            &mut b,
            json!({"t":"ops","seq":200+i,"ops":[{"k":"set","id":"n1","props":{"x":1000+i}}]}),
        )
        .await;
    }
    let mut last = (0u64, Value::Null);
    let mut acks = 0;
    let mut seen = 1u64;
    while acks < 25 {
        let m = recv(&mut a).await;
        let v = m["version"].as_u64().unwrap();
        assert!(v > seen, "versions must increase: {v} after {seen}");
        seen = v;
        match m["t"].as_str().unwrap() {
            "ack" => {
                acks += 1;
                if v > last.0 {
                    last = (v, json!(m["seq"].as_u64().unwrap() - 100));
                }
            }
            "ops" => {
                if v > last.0 {
                    last = (v, m["ops"][0]["props"]["x"].clone());
                }
            }
            other => panic!("unexpected {other}"),
        }
    }
    // Drain any of B's writes that landed after A's final ack.
    while let Ok(Some(Ok(Message::Text(t)))) =
        tokio::time::timeout(Duration::from_millis(200), a.next()).await
    {
        let m: Value = serde_json::from_str(t.as_str()).unwrap();
        last = (
            m["version"].as_u64().unwrap(),
            m["ops"][0]["props"]["x"].clone(),
        );
    }
    let room = s.hub.live_room(&id).await.unwrap();
    assert_eq!(room.snapshot_nodes().nodes["n1"]["x"], last.1);

    // Invalid batch: rejected, followed by an authoritative snapshot.
    send(
        &mut a,
        json!({"t":"ops","seq":999,"ops":[{"k":"create","id":"","props":{}}]}),
    )
    .await;
    assert_eq!(recv_until(&mut a, "reject").await["seq"], 999);
    let snap = recv(&mut a).await;
    assert_eq!(snap["t"], "snapshot");
    assert!(snap["nodes"]["n1"].is_object());

    // Last peer out flushes to SQLite and unloads the room.
    a.close(None).await.unwrap();
    assert_eq!(recv_until(&mut b, "leave").await["t"], "leave");
    b.close(None).await.unwrap();
    for _ in 0..50 {
        if s.hub.live_room(&id).await.is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(s.hub.live_room(&id).await.is_none());
    let (_, json) = s.hub.store.load(&id).unwrap().unwrap();
    let saved: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(saved["n1"]["x"], last.1);

    // A new session sees the persisted document.
    let mut c = connect(&s, &id, "Cy").await;
    assert_eq!(recv(&mut c).await["nodes"]["n1"]["fill"], "#2B3BEA");
}

#[tokio::test]
async fn deleting_a_doc_kicks_connected_peers() {
    let s = start().await;
    let (_, doc) = http(&s.hub, "POST", "/api/docs", None).await;
    let id = doc["id"].as_str().unwrap().to_string();
    let mut a = connect(&s, &id, "Ada").await;
    recv(&mut a).await;

    let (st, _) = http(&s.hub, "DELETE", &format!("/api/docs/{id}"), None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    assert_eq!(recv(&mut a).await, json!({"t": "deleted"}));
    assert_eq!(recv(&mut a).await["t"], "__closed");
}

#[tokio::test]
async fn rename_is_broadcast_to_open_sessions() {
    let s = start().await;
    let (_, doc) = http(&s.hub, "POST", "/api/docs", None).await;
    let id = doc["id"].as_str().unwrap().to_string();
    let mut a = connect(&s, &id, "Ada").await;
    recv(&mut a).await;
    http(
        &s.hub,
        "PATCH",
        &format!("/api/docs/{id}"),
        Some(json!({"name": "Launch"})),
    )
    .await;
    assert_eq!(recv(&mut a).await, json!({"t": "meta", "name": "Launch"}));
}
